# gotchas

# Concepts

* [fs.watch quirks handled by the watcher](fs-watch-quirks.md) - Platform quirks of recursive fs.watch that watch.ts works around, and the watcher's debounce and serialization rules.
* [Release workflow pins npm 11](npm-11-release-pin.md) - Why release.yml installs npm@11 explicitly and must not move to npm 12.
* [Obsidian compatibility rules](obsidian-compatibility.md) - The deliberate accommodations that let a bundle double as an Obsidian vault.
* [Tags pushed with GITHUB_TOKEN don't trigger workflows](tag-workflow-token-limitation.md) - Why tag-release.yml must explicitly dispatch release.yml instead of relying on the tag-push trigger.
