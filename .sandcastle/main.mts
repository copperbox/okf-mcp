// Entry point for the Sandcastle feature-PR workflow.
//
// Usage:
//   npx tsx .sandcastle/main.mts        (aliased as `npm run sandcastle`)
// Run it continuously with `npm run sandcastle:loop`.
//
// Exit codes (contract with scripts/sandcastle-loop.sh):
//   0 -- reached maxIterations (there may be more to do; run again)
//   1 -- a crash / unhandled error
//   3 -- idle: nothing queued or everything remaining is blocked/in-review

import { IDLE_EXIT_CODE, runFeatureFlow } from "@copperbox/sandcastle-workflow";
import config from "./config.mts";

const result = await runFeatureFlow(config);
process.exit(result.status === "idle" ? IDLE_EXIT_CODE : 0);
