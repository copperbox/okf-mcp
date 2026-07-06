# Sandcastle workflow

An autonomous loop (from [`@copperbox/sandcastle-workflow`](https://github.com/copperbox/sandcastle-workflow))
that turns open GitHub issues into reviewed, version-bumped **pull requests**
for a human to merge. It never merges to the target branch itself.

Issues are grouped into **features** (cohesive units that ship as one PR). Each
feature is built on its own branch, reviewed, integrated, given a semver bump
(when releases are enabled), and delivered as a draft PR that flips to *ready
for review* once all its issues land. Features run as independent concurrent
pipelines, so one feature waiting on your review never blocks another.

Entry point: `npx tsx .sandcastle/main.mts` (aliased as `npm run sandcastle`).
Run it forever with `npm run sandcastle:loop`. Configure it in
`.sandcastle/config.mts`.

---

## The one idea that makes it safe

**All durable state lives in git + GitHub. There is no local state file.** Every
step is re-runnable, because the truth is always re-read from:

| Fact | Source of truth |
|---|---|
| Which issues are queued | open issues with the queue label, minus in-review |
| Feature identity + fixed membership | a JSON marker in the feature PR body |
| Which issues are done | in-review label / closed state |
| Integrated code | commits on the feature branch (pushed to origin) |
| Per-issue work | commits on the issue branch |
| Version already bumped? | a `chore(release):` commit on the feature branch |
| Blocking graph | **nowhere** — recomputed by the planner every cycle |

A killed process loses nothing: the next run re-derives everything.

---

## Branch topology

(Default prefixes shown; both are configurable.)

```
<target branch>                       synced from origin at the top of each cycle
 └─ sandcastle/feature-<slug>         integration branch, cut off the target
     ├─ sandcastle/issue-<id>         cut off the feature branch (baseBranch)
     └─ sandcastle/issue-<id>
   → merge issue branches → feature branch
   → chore(release): vX.Y.Z           semver bump commit (if releases enabled)
   → push, open/refresh PR → target branch
```

Issue branch names are deterministic and **independent of feature grouping**,
so an issue's work is always locatable even if grouping changes. Issue branches
are cut off the *feature* branch tip, so a later round's issue automatically
builds on earlier merged work (this is how in-feature blocking order is
honored).

---

## The cycle

The outer loop runs up to `maxIterations` times. Each iteration:

### Phase 0 — Sync + reconcile + re-bump (host only, no sandboxes)
1. Fast-forward the local target branch to origin so every downstream
   computation reflects what is actually merged (a diverged/ahead local target
   is left untouched with a warning).
2. Create the in-review label if missing.
3. **Reconcile** — any issue labelled in-review whose feature PR is no longer
   open (you closed it unmerged) has the label removed, so it re-enters the
   queue.
4. **Keep ready PRs current** — for each **ready** (non-draft) feature PR: if
   its version no longer exceeds the target branch's (a sibling merged and took
   that version) it is **re-bumped** (which also merges the target in); else if
   it is merely **behind** it is **refreshed** (merge the target in, no version
   change). Drafts are left alone — they pick up the target naturally as their
   issues integrate.

If there are no queued issues, exit **3** (idle).

### Phase 1 — Plan (one planner agent)
The planner groups the queued issues into features, **respecting the fixed
membership of features that already have an open PR**, and marks each issue
`workNow: true/false` (unblocked vs blocked). It biases toward sequencing: when
unsure whether two issues overlap, it marks one blocked so they run in separate
rounds. Output is validated against a schema (`<plan>` JSON). If nothing is
workable, exit **3**.

### Phase 2 — Deliver (one concurrent pipeline per feature)
For each feature, independently:
1. Ensure the feature branch exists (cut off the target branch).
2. Implement + review each **workable, not-yet-done** issue concurrently, each
   in its own sandbox cut off the feature branch.
3. **Integrate** — merge the issue branches that carry new work onto the feature
   branch (resolve conflicts, run the verify command), then push.
4. **Finalize**:
   - Not all members done → create/update a **draft** PR (checklist of progress).
   - All members done → bump the version + write the description, push, update
     the PR, and flip it **ready**.
5. **Label** newly-integrated issues in-review (done *last* — see Crash
   recovery).

Delivery to the target branch is your manual PR merge. `Closes #…` lines in the
PR body auto-close the issues when you merge.

---

## Version bumps

When `release.enabled` (the default), every feature PR carries a semver bump of
the **root `package.json`**:

- **patch** — bug fixes / internal changes, no functional change
- **minor** — new backward-compatible functionality
- **major** — a breaking change

The release agent judges the level from the whole feature diff (highest wins)
and commits `chore(release): vX.Y.Z (<level>)`.

**Idempotent** — the bump is guarded on that commit's presence, so a re-run
never double-bumps.

**Collision handling (automatic)** — two PRs open concurrently both bump from
the same base (e.g. both `0.1.0 → 0.2.0`). When you merge the first, Phase 0's
auto re-bump detects that the other's version no longer exceeds the target
branch's and refreshes it, re-bumping one level higher (`0.2.0 → 0.3.0`). So
versions are allocated in the order you actually merge.

With `release: { enabled: false }`, feature PRs skip the bump entirely (the
release agent only writes the PR description) and no collision handling is
needed.

---

## Ordering & conflicts

- **Blocking order** is honored across rounds: a blocked issue waits, and when it
  runs a later round its branch is cut off the feature branch that now contains
  its blocker's merged code.
- **Same-round issues** run concurrently and don't see each other until
  integration. The planner is told to sequence anything that might overlap; if
  overlap slips through, the merge agent resolves the conflict and re-runs the
  verify command during integration.

---

## Crash recovery

Nothing needs a clean shutdown. The key invariant: **an issue is labelled
in-review only *after* its feature PR is fully finalized**, and done-detection
uses git integration state (not just labels). So:

- Killed after merging but before labelling → next run re-derives integration
  from git, the unlabelled issue keeps the feature in the queue, and it
  self-heals through the normal path (no duplicate work — re-implementing a
  finished branch is a no-op, re-integrating is skipped).
- Killed after "ready" but before labelling → the feature is requeued and
  re-finalized; the bump is skipped (release commit already present) and
  marking ready is a no-op.
- Bump agent fails on the final round → the PR stays a draft, **no labels are
  applied**, and the feature retries next cycle.

**Leaked worktrees:** Sandcastle *preserves* a worktree when a run leaves
uncommitted changes or is killed, and a leftover worktree blocks re-creating a
sandbox on that branch. The workflow removes any such leftover before every
sandbox creation (committed work is already in the shared repo) so a feature
can never get permanently wedged.

---

## Exit codes

`main.mts` exits with:

- **0** — reached `maxIterations` (there may be more to do).
- **1** — a crash / unhandled error.
- **3** — idle: nothing queued or everything remaining is blocked/in-review.

`scripts/sandcastle-loop.sh` runs `main.mts` continuously: it re-runs
immediately on **0**, sleeps `SANDCASTLE_IDLE_SLEEP` seconds (default 15) then
re-checks on **3**, and stops only on any other non-zero (a real error) or
Ctrl-C.

---

## Files

| File | Role |
|---|---|
| `main.mts` | Entry point: runs the workflow, maps its result to an exit code. |
| `config.mts` | All per-repo configuration (see the file's comments). |
| `prompts/` (optional) | Per-repo prompt overrides (same filenames as the packaged defaults). |
| `Dockerfile` | Sandbox image; add project tooling in the marked section. |
| `CODING_STANDARDS.md` | Loaded by the reviewer agent. |
| `../scripts/sandcastle-loop.sh` | Re-run `npm run sandcastle` until a real error. |

The orchestration itself (planner/implementer/reviewer/merger pipeline, PR
management, crash recovery) lives in `@copperbox/sandcastle-workflow` — update
the package to pick up fixes.

---

## Operational requirements

- **`gh` authenticated** on the host with push access to `origin` (used for all
  branch pushes, PRs, labels, and issue queries — never inside a sandbox).
- **Docker** available for sandboxes (or configure another sandbox provider).
- Run the loop from a **clean checkout of the target branch**. It is
  fast-forwarded from origin each cycle; unpushed local commits on it are
  warned about and left alone.
- The in-review label is created automatically on first run.
