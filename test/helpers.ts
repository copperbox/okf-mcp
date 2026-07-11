import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { LoadedBundle } from "../src/types.js";

const execFileAsync = promisify(execFile);

/** Build an in-memory bundle from minimal concept specs, for tests that need no fixture on disk. */
export function makeBundle(
  specs: { id: string; type: string; tags?: string[]; body?: string }[],
): LoadedBundle {
  return {
    id: "synthetic",
    root: "/synthetic",
    concepts: new Map(
      specs.map((spec) => [
        spec.id,
        {
          id: spec.id,
          bundleId: "synthetic",
          path: `${spec.id}.md`,
          frontmatter: {
            type: spec.type,
            ...(spec.tags !== undefined && { tags: spec.tags }),
          },
          body: spec.body ?? "",
          links: [],
        },
      ]),
    ),
    reserved: [],
    problems: [],
    readOnly: false,
  };
}

/** Environment that isolates test repos from user/system git config. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test Author",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: GIT_ENV });
  return stdout;
}

export async function initRepo(root: string): Promise<void> {
  await git(root, "init", "-q", "-b", "main", ".");
}

export async function commitAll(root: string, message: string): Promise<void> {
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", message);
}

/** Parse the graph data embedded in a `graph html` export; `raw` is the JSON as it appears in the document. */
export function embeddedGraphData(html: string): {
  raw: string;
  nodes: {
    id: string;
    title?: string;
    community: string;
    external?: boolean;
  }[];
  edges: { from: string; to: string; kind?: string }[];
} {
  const match =
    /<script type="application\/json" id="graph-data">(.*?)<\/script>/s.exec(html);
  assert.ok(match, `no embedded graph data in: ${html.slice(0, 400)}`);
  return { raw: match[1]!, ...JSON.parse(match[1]!) };
}
