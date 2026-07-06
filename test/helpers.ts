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
