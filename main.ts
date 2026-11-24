// ReclaimScalper — entrypoint for the Pump.fun Bot Sprint.
// Hands the strategy in ./strategy.ts to the vendored makefun-bot shim,
// which speaks agent-fun/replay/v2 on stdin/stdout (hello, batch, done).
// The grader runs: node /bot/main.ts  (Node 22, types stripped, no build).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
