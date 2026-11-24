// ReclaimScalper — a pullback-reclaim scalper for the pump.fun replay.
//
// Idea (fresh design, written for this sprint): most pump.fun coins spike, dump,
// then either die or reclaim. Chasing the first spike loses money on this tape
// (the dev window punishes naive momentum), and sniping the first seconds bleeds
// too. So this bot never buys a launch and never buys a fresh high. It waits for
// a coin to prove it can run, pull back, and then reclaim with real buy flow:
//
//   LEG      price rises >= LEG_MIN (default +20%) off its first-seen price.
//   PULLBACK price then falls >= PULLBACK_MIN (default 8%) below the leg high.
//   RECLAIM  over the last FLOW_SLOTS slots the coin shows net buy flow
//            (>= FLOW_MIN_SOL of net buys, >= FLOW_MIN_BUYS buys) and the price
//            has climbed back at least halfway from the pullback low toward the
//            leg high, while still sitting below the leg high (no top-chasing).
//
// Entries are one per coin, tiny (STAKE_SOL), with full-position exits only —
// no partial ladders, no pyramids. Exits: take-profit, hard stop, a trailing
// give-back exit once the trade is in profit, a stall exit for dead money, and
// a hard max-hold. A drawdown guard halts new entries when equity is down
// GUARD_DD from its peak. Entry bars relax on a fixed elapsed-slot schedule
// (insurance only, so a cold final window still clears the 20-coin bar).
//
// Determinism: everything keys off slot numbers and event data. No clock, no
// environment, no Math.random. Two runs produce byte-identical order logs.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tunables

export const PARAMS = {
  /** SOL risked per coin. */
  STAKE_SOL: 0.02,
  /** Max coins held at once (also capped by hello.caps.max_open_positions). */
  MAX_OPEN: 6,
  /** Coin age at entry, in slots since its CreateEvent. */
  MIN_AGE_SLOTS: 300,
  MAX_AGE_SLOTS: 5000,
  /** Real SOL reserves a coin must hold to be tradable. */
  MIN_REAL_SOL: 0.5,
  MAX_REAL_SOL: 80,
  /** Leg: price must rise this far above its first-seen price (fraction). */
  LEG_MIN: 0.2,
  /** Pullback: price must fall this far below the leg high (fraction). */
  PULLBACK_MIN: 0.08,
  /** Reclaim: price must recover this share of the pullback depth. */
  RECLAIM_SHARE: 0.5,
  /** Reclaim: price must stay this far below the leg high (no top-chase). */
  BELOW_HIGH_MAX: 0.98,
  /** Flow window, in slots, for the reclaim confirmation. */
  FLOW_SLOTS: 20,
  /** Net buy SOL over the flow window. */
  FLOW_MIN_SOL: 0.25,
  /** Buy trades over the flow window. */
  FLOW_MIN_BUYS: 4,
  /** Take profit: sell everything at this multiple of entry price. */
  TAKE_PROFIT: 1.18,
  /** Hard stop: sell everything at this multiple of entry price. */
  STOP_LOSS: 0.93,
  /** Trailing: arms once price reaches this multiple of entry. */
  TRAIL_ARM: 1.1,
  /** Trailing: sell when price gives back this share of the peak. */
  TRAIL_GIVEBACK: 0.08,
  /** Max hold, in slots since the buy filled. */
  MAX_HOLD_SLOTS: 400,
  /** Stall: after this many slots, sell if the trade is not in profit. */
  STALL_SLOTS: 100,
  /** Drawdown guard: halt entries when equity is down this far from peak. */
  GUARD_DD: 0.2,
  /** Buy slippage cap (bps). Tight: a fill jumping through the latency is refused for free. */
  BUY_SLIPPAGE_BPS: 150,
  /** Take-profit sell slippage cap (bps). */
  TP_SLIPPAGE_BPS: 300,
  /** Stop / stall sell slippage cap (bps): getting out matters more than price. */
  EXIT_SLIPPAGE_BPS: 10_000,
  /** Elapsed-slot tier boundaries for the breadth insurance (see tierFor). */
  TIER1_ELAPSED: 40_000,
  TIER2_ELAPSED: 90_000,
};

// ------------------------------------------------------------------ per-coin state

interface FlowSample {
  slot: number;
  buySol: number;
  sellSol: number;
  buys: number;
}

interface CoinTrack {
  /** Slot of the CreateEvent, or first-seen slot when the create was missed. */
  createdSlot: number;
  firstPrice: number;
  legHigh: number;
  pulledBack: boolean;
  pullbackLow: number;
  /** Entry decided (bought) — one entry per coin, ever. */
  entered: boolean;
  /** Recent per-slot flow samples, pruned to the flow window. */
  flow: FlowSample[];
  lastPrice: number;
  lastSlot: number;
}

interface OpenTrade {
  mint: string;
  entryPrice: number;
  entrySlot: number;
  peakPrice: number;
}

interface PendingBuy {
  mint: string;
  decidedSlot: number;
}

/** Price of one token in SOL, from virtual reserves (deterministic). */
function priceOf(vToken: bigint, vQuote: bigint): number {
  if (vToken <= 0n || vQuote <= 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

function solOf(lamports: bigint): number {
  return Number(lamports) / 1e9;
}

/** Breadth-insurance tier: 0 strict, 1 relaxed, 2 loosest. Pure slot schedule. */
function tierFor(elapsedSlots: number): number {
  if (elapsedSlots >= PARAMS.TIER2_ELAPSED) return 2;
  if (elapsedSlots >= PARAMS.TIER1_ELAPSED) return 1;
  return 0;
}

export function createStrategy() {
  const coins = new Map<string, CoinTrack>();
  const trades = new Map<string, OpenTrade>();
  const pendingBuys = new Map<string, PendingBuy>();
  let runStartSlot = -1;
  let peakEquitySol = 0;
  let stakeLamports = 0n;

  function equitySol(state: BotState): number {
    let equity = solOf(BigInt(state.account.cash_lamports));
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      const p = priceOf(curve.virtual_token_reserves, curve.virtual_quote_reserves);
      if (p > 0) equity += solOf(pos.token_amount) * p;
    }
    return equity;
  }

  function trackCoin(mint: string, slot: number, price: number): CoinTrack {
    let t = coins.get(mint);
    if (t === undefined) {
      t = {
        createdSlot: slot,
        firstPrice: price,
        legHigh: price,
        pulledBack: false,
        pullbackLow: price,
        entered: false,
        flow: [],
        lastPrice: price,
        lastSlot: slot,
      };
      coins.set(mint, t);
    }
    return t;
  }

  /** Fold this batch's fills into open-trade bookkeeping. */
  function applyFills(batch: Batch): void {
    for (const f of batch.fills) {
      if (f.status !== 'filled') {
        // A rejected/failed buy frees the coin for a later re-try only when the
        // rejection was slippage (a free refusal); other rejections mark it done.
        if (f.side === 'buy') {
          const pb = pendingBuys.get(f.client_id);
          if (pb !== undefined) {
            pendingBuys.delete(f.client_id);
            if (f.reason !== 'max_slippage') {
              const t = coins.get(pb.mint);
              if (t !== undefined) t.entered = true;
            }
          }
        }
        continue;
      }
      if (f.side === 'buy') {
        const pb = pendingBuys.get(f.client_id);
        pendingBuys.delete(f.client_id);
        const tokens = BigInt(f.token_amount);
        const quote = BigInt(f.quote_lamports);
        if (tokens > 0n && quote > 0n) {
          const entryPrice = Number(quote) / Number(tokens);
          trades.set(f.mint, {
            mint: f.mint,
            entryPrice,
            entrySlot: f.slot,
            peakPrice: entryPrice,
          });
          const t = coins.get(f.mint);
          if (t !== undefined) t.entered = true;
        }
      } else {
        trades.delete(f.mint);
      }
    }
  }

  return {
    onHello(state: BotState): void {
      stakeLamports = BigInt(Math.round(PARAMS.STAKE_SOL * 1e9));
      peakEquitySol = solOf(BigInt(state.hello.capital.lamports));
    },

    onBatch(state: BotState, batch: Batch): OrderInput[] {
      if (runStartSlot < 0) runStartSlot = batch.slot;
      const elapsed = batch.slot - runStartSlot;
      const tier = tierFor(elapsed);
      const orders: OrderInput[] = [];
      const { caps } = state.hello;
      const txFee = state.txFeeLamports();
      let freeCash = state.freeCashLamports();
      let openSlots = Math.min(PARAMS.MAX_OPEN, caps.max_open_positions) - state.committedPositionCount();

      applyFills(batch);

      // --- fold this batch's events into per-coin tracks and flow windows ---
      const batchFlow = new Map<string, FlowSample>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const curve = state.curves.get(e.mint);
          const p = curve === undefined ? 0 : priceOf(curve.virtual_token_reserves, curve.virtual_quote_reserves);
          const t = trackCoin(e.mint, e.slot, p > 0 ? p : 0);
          t.createdSlot = e.slot;
          if (p > 0 && t.firstPrice === 0) t.firstPrice = p;
          continue;
        }
        if (e.event === 'TradeEvent') {
          const curve = state.curves.get(e.mint);
          if (curve === undefined) continue;
          const p = priceOf(curve.virtual_token_reserves, curve.virtual_quote_reserves);
          if (p <= 0) continue;
          const t = trackCoin(e.mint, curve.created_slot ?? batch.slot, p);
          if (t.firstPrice === 0) t.firstPrice = p;
          if (p > t.legHigh) t.legHigh = p;
          // A leg is banked once price clears LEG_MIN above first-seen; only
          // then does a dip below the high count as a pullback.
          if (!t.pulledBack && t.legHigh >= t.firstPrice * (1 + PARAMS.LEG_MIN) && p <= t.legHigh * (1 - PARAMS.PULLBACK_MIN)) {
            t.pulledBack = true;
            t.pullbackLow = p;
          }
          if (t.pulledBack && p < t.pullbackLow) t.pullbackLow = p;
          t.lastPrice = p;
          t.lastSlot = batch.slot;
          let s = batchFlow.get(e.mint);
          if (s === undefined) {
            s = { slot: batch.slot, buySol: 0, sellSol: 0, buys: 0 };
            batchFlow.set(e.mint, s);
          }
          const amt = solOf(BigInt(e.sol_amount));
          if (e.is_buy) {
            s.buySol += amt;
            s.buys += 1;
          } else {
            s.sellSol += amt;
          }
        } else if (e.event === 'CompleteEvent') {
          trades.delete(e.mint);
        }
      }
      for (const [mint, s] of batchFlow) {
        const t = coins.get(mint);
        if (t === undefined) continue;
        t.flow.push(s);
        const cutoff = batch.slot - PARAMS.FLOW_SLOTS;
        while (t.flow.length > 0 && t.flow[0].slot < cutoff) t.flow.shift();
      }

      // --- drawdown guard: halt entries while equity is down GUARD_DD ---
      const equity = equitySol(state);
      if (equity > peakEquitySol) peakEquitySol = equity;
      const guardTripped = peakEquitySol > 0 && equity < peakEquitySol * (1 - PARAMS.GUARD_DD);

      // --- exits first: every open trade is checked against all exit rules ---
      for (const [mint, trade] of trades) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined || curve.complete) continue;
        const p = priceOf(curve.virtual_token_reserves, curve.virtual_quote_reserves);
        if (p <= 0) continue;
        if (p > trade.peakPrice) trade.peakPrice = p;
        const heldSlots = batch.slot - trade.entrySlot;
        let exit: 'tp' | 'stop' | 'trail' | 'stall' | 'maxhold' | null = null;
        if (p >= trade.entryPrice * PARAMS.TAKE_PROFIT) exit = 'tp';
        else if (p <= trade.entryPrice * PARAMS.STOP_LOSS) exit = 'stop';
        else if (trade.peakPrice >= trade.entryPrice * PARAMS.TRAIL_ARM && p <= trade.peakPrice * (1 - PARAMS.TRAIL_GIVEBACK)) exit = 'trail';
        else if (heldSlots >= PARAMS.MAX_HOLD_SLOTS) exit = 'maxhold';
        else if (heldSlots >= PARAMS.STALL_SLOTS && p < trade.entryPrice) exit = 'stall';
        if (exit === null) continue;
        if (orders.length >= caps.max_orders_per_batch) break;
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: exit === 'tp' ? PARAMS.TP_SLIPPAGE_BPS : PARAMS.EXIT_SLIPPAGE_BPS,
        });
      }

      // --- entries: reclaim setups only, in first-seen coin order ---
      if (!guardTripped) {
        const legMin = tier === 0 ? PARAMS.LEG_MIN : tier === 1 ? 0.15 : 0.12;
        const pullMin = tier === 0 ? PARAMS.PULLBACK_MIN : tier === 1 ? 0.06 : 0.05;
        const flowMin = tier === 0 ? PARAMS.FLOW_MIN_SOL : tier === 1 ? 0.15 : 0.1;
        const flowBuys = tier === 0 ? PARAMS.FLOW_MIN_BUYS : 3;
        const maxAge = tier === 2 ? 8000 : PARAMS.MAX_AGE_SLOTS;
        for (const [mint, t] of coins) {
          if (orders.length >= caps.max_orders_per_batch) break;
          if (openSlots <= 0) break;
          if (t.entered || trades.has(mint)) continue;
          if (pendingBuys.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const age = batch.slot - (curve.created_slot ?? t.createdSlot);
          if (age < PARAMS.MIN_AGE_SLOTS || age > maxAge) continue;
          const realSol = solOf(curve.real_quote_reserves);
          if (realSol < PARAMS.MIN_REAL_SOL || realSol > PARAMS.MAX_REAL_SOL) continue;
          const p = priceOf(curve.virtual_token_reserves, curve.virtual_quote_reserves);
          if (p <= 0) continue;
          // Leg + pullback must both have happened.
          if (!t.pulledBack) continue;
          if (t.legHigh < t.firstPrice * (1 + legMin)) continue;
          if (t.pullbackLow > t.legHigh * (1 - pullMin)) continue;
          // Reclaim: price back at least halfway from the pullback low, still below the high.
          const depth = t.legHigh - t.pullbackLow;
          if (depth <= 0) continue;
          if (p < t.pullbackLow + depth * PARAMS.RECLAIM_SHARE) continue;
          if (p >= t.legHigh * PARAMS.BELOW_HIGH_MAX) continue;
          // Flow: net buys over the window with enough distinct buy trades.
          let netBuy = 0;
          let buys = 0;
          for (const s of t.flow) {
            netBuy += s.buySol - s.sellSol;
            buys += s.buys;
          }
          if (netBuy < flowMin || buys < flowBuys) continue;
          // Size cap + cash: one whole order, never split (same price either way).
          const cap = state.maxBuyLamports(mint);
          const amount = cap < stakeLamports ? cap : stakeLamports;
          if (amount <= 0n) continue;
          if (freeCash < amount + txFee) continue;
          const clientId = state.clientId();
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: PARAMS.BUY_SLIPPAGE_BPS, client_id: clientId });
          pendingBuys.set(clientId, { mint, decidedSlot: batch.slot });
          freeCash -= amount + txFee;
          openSlots -= 1;
        }
      }

      return orders;
    },

    onDone(): void {
      // Nothing to persist: the replay flattens positions at the end.
    },
  };
}
