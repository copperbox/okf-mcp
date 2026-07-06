/**
 * Fake GitHub for tests: serves the contents API for repo acme/kb at ref
 * `main` and raw downloads. `files` maps repo-relative paths to markdown
 * sources; `sizes` optionally overrides the size reported in listings.
 */
export function fakeGitHub(
  files: Record<string, string>,
  sizes: Record<string, number> = {},
): typeof fetch {
  return (async (input: unknown): Promise<Response> => {
    const url = String(input);
    const listing = url.match(
      /^https:\/\/api\.github\.com\/repos\/acme\/kb\/contents\/([^?]*)\?ref=main$/,
    );
    if (listing) {
      const dir = decodeURIComponent(listing[1]!).replace(/\/$/, "");
      const prefix = dir === "" ? "" : `${dir}/`;
      const entries = new Map<string, { type: string; path: string; size: number }>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const child = rest.split("/")[0]!;
        const childPath = `${prefix}${child}`;
        entries.set(childPath, {
          type: rest.includes("/") ? "dir" : "file",
          path: childPath,
          size: sizes[childPath] ?? files[childPath]?.length ?? 0,
        });
      }
      if (entries.size === 0) return new Response("Not Found", { status: 404 });
      return Response.json(
        [...entries.values()].map((entry) => ({
          name: entry.path.split("/").pop(),
          path: entry.path,
          type: entry.type,
          size: entry.size,
          download_url:
            entry.type === "file" ? `https://raw.example/${entry.path}` : null,
        })),
      );
    }
    const raw = url.match(/^https:\/\/raw\.example\/(.*)$/);
    if (raw) {
      const content = files[raw[1]!];
      if (content === undefined) return new Response("Not Found", { status: 404 });
      return new Response(content);
    }
    return new Response(`unexpected url: ${url}`, { status: 500 });
  }) as typeof fetch;
}
