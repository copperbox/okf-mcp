/**
 * Canonical-location matching for cross-bundle awareness. OKF §5 has no
 * cross-bundle link syntax, but the server knows every mounted bundle's
 * canonical location (GitHub tree URL, or a configured canonicalUrl), so a
 * citation or external link whose URL points into another mounted bundle can
 * be resolved to that bundle's concept — derived, read-only, no new syntax.
 */

import { conceptIdFromPath } from "./parser.js";

export interface GitHubTreeRef {
  owner: string;
  repo: string;
  ref: string;
  /** Repo-relative directory the bundle root maps to ("" for the repo root). */
  path: string;
}

const TREE_URL =
  /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/tree\/([^/\s]+)(?:\/(.+?))?\/?$/;

/**
 * Parse a public GitHub tree URL. Refs containing `/` (e.g. `feature/x`
 * branches) are not supported — the first path segment after `/tree/` is
 * taken as the ref.
 */
export function parseGitHubTreeUrl(url: string): GitHubTreeRef {
  const match = TREE_URL.exec(url.trim());
  if (!match) {
    throw new Error(
      `not a public GitHub tree URL (expected https://github.com/<owner>/<repo>/tree/<ref>[/<path>]): ${url}`,
    );
  }
  return { owner: match[1]!, repo: match[2]!, ref: match[3]!, path: match[4] ?? "" };
}

/**
 * Expand a bundle's canonical URL into the prefixes a citation might use.
 * GitHub tree URLs also match the equivalent blob and raw.githubusercontent
 * forms (files are cited by their blob URL, not their tree URL); any other
 * URL is one literal prefix. Trailing slashes are trimmed.
 */
export function canonicalUrlPrefixes(url: string): string[] {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (TREE_URL.test(trimmed)) {
    const { owner, repo, ref, path } = parseGitHubTreeUrl(trimmed);
    const suffix = path === "" ? "" : `/${path}`;
    return [
      `https://github.com/${owner}/${repo}/tree/${ref}${suffix}`,
      `https://github.com/${owner}/${repo}/blob/${ref}${suffix}`,
      `https://raw.githubusercontent.com/${owner}/${repo}/${ref}${suffix}`,
    ];
  }
  return [trimmed];
}

/**
 * The prefix a concept file should be cited under: the blob form for GitHub
 * canonicals (canonicalUrlPrefixes puts it second — files are cited by their
 * blob URL, not their tree URL), otherwise the sole literal prefix.
 */
export function citationPrefix(prefixes: string[]): string {
  return prefixes.length > 1 ? prefixes[1]! : prefixes[0]!;
}

/**
 * Concept ID a URL points at inside a bundle whose canonical location has
 * the given prefixes, or undefined. Fragments, query strings, and a `.md`
 * suffix are tolerated, like body link targets.
 */
export function resolveUrlToConcept(
  url: string,
  prefixes: string[],
  conceptExists: (id: string) => boolean,
): string | undefined {
  const clean = url.split("#")[0]!.split("?")[0]!.replace(/\/+$/, "");
  for (const prefix of prefixes) {
    if (!clean.startsWith(`${prefix}/`)) continue;
    let rest = clean.slice(prefix.length + 1);
    try {
      rest = decodeURIComponent(rest);
    } catch {
      // keep the raw path when the URL is not valid percent-encoding
    }
    const id = conceptIdFromPath(rest);
    if (conceptExists(id)) return id;
  }
  return undefined;
}
