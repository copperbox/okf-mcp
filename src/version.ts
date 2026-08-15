import { createRequire } from "node:module";

/**
 * The published package version, read from package.json rather than
 * hardcoded — it reaches clients through the MCP handshake and, since v0.2,
 * through this server's own actor id (`okf-mcp/<version>`, spec §7), so a
 * stale copy would misreport what actually produced a concept.
 */
export const PACKAGE_VERSION: string = createRequire(import.meta.url)(
  "../package.json",
).version;
