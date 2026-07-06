import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One commit touching a file, as returned by concept_history. */
export interface FileCommit {
  hash: string;
  /** Author date, strict ISO 8601. */
  date: string;
  /** Author name. */
  author: string;
  subject: string;
}

/** SHA-1 of git's empty tree: lets us diff a file's very first commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Field separator for `git log --format`; cannot appear in %H/%aI/%an/%s. */
const SEP = "\x1f";

async function runGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

const workTreeChecks = new Map<string, Promise<boolean>>();

/**
 * Whether `root` lives inside a git work tree. Detected once per root and
 * cached, so non-git bundles pay the probe cost only on first use.
 */
export function isGitWorkTree(root: string): Promise<boolean> {
  let check = workTreeChecks.get(root);
  if (!check) {
    check = runGit(root, ["rev-parse", "--is-inside-work-tree"]).then(
      (out) => out.trim() === "true",
      () => false,
    );
    workTreeChecks.set(root, check);
  }
  return check;
}

/**
 * Commits touching `relPath` (newest first), following renames. Paths with
 * no history — including a repo with no commits at all — yield [].
 */
export async function fileHistory(
  root: string,
  relPath: string,
  limit?: number,
): Promise<FileCommit[]> {
  const args = [
    "log",
    "--follow",
    `--format=%H${SEP}%aI${SEP}%an${SEP}%s`,
    ...(limit !== undefined ? ["-n", String(limit)] : []),
    "--",
    relPath,
  ];
  let stdout: string;
  try {
    stdout = await runGit(root, args);
  } catch (error) {
    // A freshly-initialized repo has no HEAD; treat it as empty history.
    if (/does not have any commits yet/.test(String(error))) return [];
    throw error;
  }
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [hash = "", date = "", author = "", subject = ""] = line.split(SEP);
      return { hash, date, author, subject };
    });
}

/**
 * Unified diff of `relPath` between `ref` and the working tree. With no ref,
 * diffs against the commit before the last one touching the file, so the
 * default output is the file's most recent change; a file with a single
 * commit is diffed against the empty tree (its creation). Files with no git
 * history yield "".
 */
export async function fileDiff(
  root: string,
  relPath: string,
  ref?: string,
): Promise<string> {
  let base = ref;
  if (base === undefined) {
    const commits = await fileHistory(root, relPath, 2);
    if (commits.length === 0) return "";
    base = commits[1]?.hash ?? EMPTY_TREE;
  } else if (base.startsWith("-")) {
    // execFile prevents shell injection, but a leading "-" would still be
    // parsed as a git option.
    throw new Error(`invalid git ref: ${base}`);
  }
  return runGit(root, ["diff", base, "--", relPath]);
}
