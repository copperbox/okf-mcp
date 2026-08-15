import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { loadOkfConfig, userConfigDir } from "../src/config.js";

let root: string;

/** Write a config file into `dir` (created as needed), relative to the sandbox. */
async function writeConfig(
  dir: string,
  config: unknown,
  name = "okf.config.json",
): Promise<string> {
  const target = path.join(root, dir);
  await fs.mkdir(target, { recursive: true });
  const file = path.join(target, name);
  await fs.writeFile(file, JSON.stringify(config, null, 2));
  return file;
}

/** Bundle roots by id, for terse assertions. */
function rootsById(bundles: { id: string; root: string }[]): Record<string, string> {
  return Object.fromEntries(bundles.map((b) => [b.id, b.root]));
}

beforeEach(async () => {
  // realpath: macOS /var → /private/var would break the "config path is inside
  // its own directory" comparisons that gate writability.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "okf-config-")));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("loadOkfConfig discovery", () => {
  it("mounts bundles declared in the working directory's config", async () => {
    await writeConfig(".", { bundles: { brain: { path: "okf-bundle" } } });
    const resolved = await loadOkfConfig({ cwd: root, configHome: path.join(root, "none") });
    assert.deepEqual(rootsById(resolved.bundles), {
      brain: path.join(root, "okf-bundle"),
    });
    assert.deepEqual(resolved.sources, [path.join(root, "okf.config.json")]);
  });

  it("accepts the string shorthand for a bundle path", async () => {
    await writeConfig(".", { bundles: { brain: "okf-bundle" } });
    const resolved = await loadOkfConfig({ cwd: root, configHome: path.join(root, "none") });
    assert.equal(resolved.bundles[0]?.root, path.join(root, "okf-bundle"));
  });

  it("unions bundles from an ancestor directory with the project's own", async () => {
    await writeConfig(".", { bundles: { user: "personal-brain" } });
    await writeConfig("project", { bundles: { brain: "okf-bundle" } });
    const resolved = await loadOkfConfig({
      cwd: path.join(root, "project"),
      configHome: path.join(root, "none"),
    });
    assert.deepEqual(rootsById(resolved.bundles), {
      user: path.join(root, "personal-brain"),
      brain: path.join(root, "project", "okf-bundle"),
    });
  });

  it("resolves each config's relative paths against its own directory", async () => {
    await writeConfig(".", { bundles: { user: "./personal-brain" } });
    await writeConfig("a/b/project", { bundles: { brain: "../shared" } });
    const resolved = await loadOkfConfig({
      cwd: path.join(root, "a/b/project"),
      configHome: path.join(root, "none"),
    });
    assert.deepEqual(rootsById(resolved.bundles), {
      user: path.join(root, "personal-brain"),
      brain: path.join(root, "a/b/shared"),
    });
  });

  it("lets the nearest config replace an ancestor's bundle of the same id", async () => {
    await writeConfig(".", { bundles: { brain: "outer" } });
    await writeConfig("project", { bundles: { brain: "inner" } });
    const resolved = await loadOkfConfig({
      cwd: path.join(root, "project"),
      configHome: path.join(root, "none"),
    });
    assert.deepEqual(rootsById(resolved.bundles), {
      brain: path.join(root, "project", "inner"),
    });
  });

  it("applies okf.config.local.json after okf.config.json in the same directory", async () => {
    await writeConfig("project", { bundles: { brain: "committed" } });
    await writeConfig(
      "project",
      { bundles: { brain: "local", scratch: "notes" } },
      "okf.config.local.json",
    );
    const resolved = await loadOkfConfig({
      cwd: path.join(root, "project"),
      configHome: path.join(root, "none"),
    });
    assert.deepEqual(rootsById(resolved.bundles), {
      brain: path.join(root, "project", "local"),
      scratch: path.join(root, "project", "notes"),
    });
  });

  it("stops the upward walk at a config declaring root: true", async () => {
    await writeConfig(".", { bundles: { outer: "outer-brain" } });
    await writeConfig("project", { root: true, bundles: { brain: "okf-bundle" } });
    const resolved = await loadOkfConfig({
      cwd: path.join(root, "project"),
      configHome: path.join(root, "none"),
    });
    assert.deepEqual(Object.keys(rootsById(resolved.bundles)), ["brain"]);
  });

  it("applies the user config below every project config", async () => {
    const home = path.join(root, "confighome");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ bundles: { user: path.join(root, "personal"), brain: "wrong" } }),
    );
    await writeConfig("project", { bundles: { brain: "okf-bundle" } });
    const resolved = await loadOkfConfig({
      cwd: path.join(root, "project"),
      configHome: home,
    });
    assert.deepEqual(rootsById(resolved.bundles), {
      user: path.join(root, "personal"),
      brain: path.join(root, "project", "okf-bundle"),
    });
    assert.deepEqual(resolved.sources, [
      path.join(home, "config.json"),
      path.join(root, "project", "okf.config.json"),
    ]);
  });

  it("uses only the named file with configPath, skipping discovery", async () => {
    await writeConfig(".", { bundles: { discovered: "nope" } });
    const explicit = await writeConfig("elsewhere", { bundles: { only: "yes" } }, "custom.json");
    const resolved = await loadOkfConfig({ cwd: root, configPath: explicit });
    assert.deepEqual(rootsById(resolved.bundles), {
      only: path.join(root, "elsewhere", "yes"),
    });
  });

  it("mounts nothing with noConfig", async () => {
    await writeConfig(".", { bundles: { brain: "okf-bundle" } });
    const resolved = await loadOkfConfig({ cwd: root, noConfig: true });
    assert.deepEqual(resolved.bundles, []);
    assert.deepEqual(resolved.sources, []);
  });

  it("expands a leading ~ to the home directory", async () => {
    const previous = process.env.HOME;
    process.env.HOME = path.join(root, "home");
    try {
      await writeConfig(".", { bundles: { user: "~/notes" } });
      const resolved = await loadOkfConfig({ cwd: root, configHome: path.join(root, "none") });
      assert.equal(resolved.bundles[0]?.root, path.join(root, "home", "notes"));
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  });
});

describe("loadOkfConfig writability", () => {
  it("defaults bundles to read-only and honours a per-bundle grant", async () => {
    await writeConfig(".", {
      bundles: { brain: { path: "okf-bundle", writable: true }, notes: "notes" },
    });
    const resolved = await loadOkfConfig({ cwd: root, configHome: path.join(root, "none") });
    const writable = Object.fromEntries(resolved.bundles.map((b) => [b.id, b.writable]));
    assert.deepEqual(writable, { brain: true, notes: false });
  });

  it("applies a file-level writable default that a bundle can override", async () => {
    await writeConfig(".", {
      writable: true,
      bundles: { brain: "okf-bundle", reference: { path: "reference", writable: false } },
    });
    const resolved = await loadOkfConfig({ cwd: root, configHome: path.join(root, "none") });
    const writable = Object.fromEntries(resolved.bundles.map((b) => [b.id, b.writable]));
    assert.deepEqual(writable, { brain: true, reference: false });
  });

  it("refuses a discovered config's write grant for a path outside its directory", async () => {
    await writeConfig("project", {
      bundles: { escape: { path: path.join(root, "elsewhere"), writable: true } },
    });
    const resolved = await loadOkfConfig({
      cwd: path.join(root, "project"),
      configHome: path.join(root, "none"),
    });
    assert.equal(resolved.bundles[0]?.writable, false);
    assert.match(resolved.warnings.join("\n"), /cannot grant it write access/);
  });

  it("allows the user config to grant writes anywhere", async () => {
    const home = path.join(root, "confighome");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "config.json"),
      JSON.stringify({
        bundles: { user: { path: path.join(root, "personal"), writable: true } },
      }),
    );
    const resolved = await loadOkfConfig({ cwd: root, configHome: home });
    assert.equal(resolved.bundles[0]?.writable, true);
    assert.deepEqual(resolved.warnings, []);
  });

  it("allows an explicitly named --config file to grant writes anywhere", async () => {
    const explicit = await writeConfig("cfg", {
      bundles: { far: { path: path.join(root, "elsewhere"), writable: true } },
    });
    const resolved = await loadOkfConfig({ cwd: root, configPath: explicit });
    assert.equal(resolved.bundles[0]?.writable, true);
  });

  it("passes a colocated root's writability to the mount", async () => {
    await writeConfig(".", {
      colocatedRoots: [{ path: "brains", writable: true, only: ["a"] }],
    });
    const resolved = await loadOkfConfig({ cwd: root, configHome: path.join(root, "none") });
    assert.deepEqual(resolved.colocatedRoots, [
      { path: path.join(root, "brains"), writable: true, only: ["a"] },
    ]);
  });
});

describe("loadOkfConfig other mounts", () => {
  it("carries remote bundles and colocated remote roots through the merge", async () => {
    await writeConfig(".", {
      remoteBundles: {
        specs: "https://github.com/acme/specs/tree/main",
        docs: { url: "https://example.com/docs.tar.gz", exclude: ["drafts/**"] },
      },
      colocatedRemoteRoots: ["https://github.com/acme/brains/tree/main"],
    });
    const resolved = await loadOkfConfig({ cwd: root, configHome: path.join(root, "none") });
    assert.deepEqual(resolved.remotes, [
      { id: "specs", url: "https://github.com/acme/specs/tree/main" },
      { id: "docs", url: "https://example.com/docs.tar.gz", exclude: ["drafts/**"] },
    ]);
    assert.deepEqual(resolved.colocatedRemoteRoots, [
      { url: "https://github.com/acme/brains/tree/main" },
    ]);
  });

  it("takes searchLimit and searchCutoff from the nearest config that sets them", async () => {
    await writeConfig(".", { searchLimit: 5, searchCutoff: 0.5 });
    await writeConfig("project", { searchLimit: 25 });
    const resolved = await loadOkfConfig({
      cwd: path.join(root, "project"),
      configHome: path.join(root, "none"),
    });
    assert.equal(resolved.searchLimit, 25);
    assert.equal(resolved.searchCutoff, 0.5);
  });
});

describe("loadOkfConfig errors", () => {
  it("names the file when the JSON is malformed", async () => {
    await fs.writeFile(path.join(root, "okf.config.json"), "{ nope }");
    await assert.rejects(
      loadOkfConfig({ cwd: root, configHome: path.join(root, "none") }),
      /okf\.config\.json is not valid JSON/,
    );
  });

  it("rejects a bundle entry that is neither a string nor an object", async () => {
    await writeConfig(".", { bundles: { brain: 42 } });
    await assert.rejects(
      loadOkfConfig({ cwd: root, configHome: path.join(root, "none") }),
      /bundles\.brain must be a string or object/,
    );
  });

  it("rejects a non-boolean writable", async () => {
    await writeConfig(".", { bundles: { brain: { path: "x", writable: "yes" } } });
    await assert.rejects(
      loadOkfConfig({ cwd: root, configHome: path.join(root, "none") }),
      /bundles\.brain\.writable must be true or false/,
    );
  });

  it("errors when --config names a file that does not exist", async () => {
    await assert.rejects(
      loadOkfConfig({ cwd: root, configPath: path.join(root, "missing.json") }),
      /--config file not found/,
    );
  });

  it("warns about an unknown key instead of failing", async () => {
    await writeConfig(".", { bundles: { brain: "x" }, bundels: {} });
    const resolved = await loadOkfConfig({ cwd: root, configHome: path.join(root, "none") });
    assert.match(resolved.warnings.join("\n"), /unknown key "bundels"/);
    assert.equal(resolved.bundles.length, 1);
  });
});

describe("userConfigDir", () => {
  it("prefers an explicit override, then XDG_CONFIG_HOME, then ~/.config/okf", async () => {
    const previous = process.env.XDG_CONFIG_HOME;
    try {
      assert.equal(userConfigDir("/tmp/explicit"), "/tmp/explicit");
      process.env.XDG_CONFIG_HOME = "/tmp/xdg";
      assert.equal(userConfigDir(), path.join("/tmp/xdg", "okf"));
      delete process.env.XDG_CONFIG_HOME;
      assert.equal(userConfigDir(), path.join(os.homedir(), ".config", "okf"));
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });
});

describe("actor (OKF spec §5.2, §7)", () => {
  const noHome = () => path.join(root, "none");

  it("reads it from a config file and lets a nearer layer win", async () => {
    await writeConfig(".", { actor: "process:nightly" });
    await writeConfig("project", { actor: "human:ahormati" });
    const resolved = await loadOkfConfig({
      cwd: path.join(root, "project"),
      configHome: noHome(),
    });
    assert.equal(resolved.actor, "human:ahormati");
  });

  it("is absent when nothing declares one, so the server default applies", async () => {
    await writeConfig(".", { bundles: { brain: "okf-bundle" } });
    const resolved = await loadOkfConfig({ cwd: root, configHome: noHome() });
    assert.equal(resolved.actor, undefined);
  });

  it("rejects a non-string actor rather than stamping it into every write", async () => {
    await writeConfig(".", { actor: 42 });
    await assert.rejects(
      loadOkfConfig({ cwd: root, configHome: noHome() }),
      /actor must be a non-empty string/,
    );
  });
});
