# CLAUDE.md — Pulpo

Mac (Electron) PR/MR client for Jesús — supports **GitHub and GitLab** (one provider per install, chosen in onboarding). Bitbucket-style PR list + detail pane.

## Hard rules (product decisions, never change without being asked)
- Update branch = **rebase** (GitHub: `updatePullRequestBranch` REBASE; GitLab: `PUT .../rebase`).
- Merge = **merge commit** (GitHub: `merge_method: "merge"`; GitLab: `squash: false`). **Squash must never be offered or implemented.**
- The token is never hardcoded, committed, or sent to the renderer. Resolution per provider: GitHub `GITHUB_TOKEN` → `gh auth token` → manual; GitLab `GITLAB_TOKEN` → `glab` CLI → manual. Manual token in userData config (0600).
- **Provider is one-per-install** (`config.provider`). Switching providers clears the token (it belonged to the other provider). Never mix repos from both.

## Stack & layout
- Electron (no bundler, no framework): vanilla JS renderer.
- `src/main.js` — window, IPC handlers (all routed through the provider, never a hardcoded backend), `--selftest` (screenshot to /tmp/pulpo-selftest.png then quit).
- `src/provider.js` — router: `current()` returns the github or gitlab module based on `config.provider` (resolved per call, not cached).
- `src/github.js` / `src/gitlab.js` — the two provider implementations. **Same public interface**; both normalize to the **GitHub data shape** the renderer consumes. The renderer must stay provider-agnostic. (`cherryPick` and `listMilestones`/`milestoneIssues` are GitLab-only — the GitHub side has throwing stubs kept only for interface parity; those features are gated to `provider==="gitlab"` in the renderer.)
- `src/config.js` — config.json in `app.getPath("userData")` (`provider`, `gitlabBaseUrl`, repos[], pollSeconds, optional manual token, `cherryPick` `{prefix, branches[], siblingMx}`, `milestones` `{group, statusLabels[], doneLabels[]}`). `config:set` in main.js is a strict whitelist — new config keys must be validated/added there or they're silently dropped. The deep-merged `cherryPick` and `milestones` keys also need deep-merge lines in `config.load()`.
- `src/preload.js` — contextBridge API (`window.pulpo.*`); renderer is sandboxed, contextIsolation on, CSP strict (no remote scripts; images https only).
- `renderer/` — index.html + styles.css + app.js. UI text in Spanish.

## Provider abstraction (GitHub ⇄ GitLab)
- `gitlab.js` maps Merge Requests → PR shape. **Critical: the renderer branches on exact enum literals**, not shape. Emit GitHub tokens exactly: `state` OPEN/MERGED/CLOSED, `reviewDecision` APPROVED/CHANGES_REQUESTED/REVIEW_REQUIRED, `mergeable` MERGEABLE/CONFLICTING, `mergeStateStatus` CLEAN/UNSTABLE/HAS_HOOKS/BEHIND/BLOCKED/DIRTY, `commits.nodes[0].commit.statusCheckRollup.state` SUCCESS/FAILURE/ERROR/PENDING/EXPECTED.
- Mutations: the renderer passes `pr.id` (a node id). GitLab encodes it as `gl:<projectEnc>#<iid>`; `updateBranchRebase`/`setPrDraft`/`revertPullRequest` decode it.
- GitLab caveats (API ≠ GitHub): **no force-update ref** → `forceUpdateBranch` does delete+recreate (non-atomic: checks the SHA exists first and reports it if recreate fails; still fails on protected/open-MR branches); **revert** creates a direct commit, not an MR (`{number:null, url}`); **REQUEST_CHANGES** has no universal verdict → posts a note; list rows omit per-MR additions/deletions and pipeline status (only the detail view fetches them).
- **`submitReview` is not atomic** on GitLab (no single-POST review like GitHub's `/reviews`): it posts N inline discussions + a note + approve in sequence. If it fails mid-way, published comments stay AND the local draft is intact → a retry can duplicate. Future fix: GitLab `draft_notes/bulk_publish`.
- **`listPRs` does N+1 on GitLab** (one `/approvals` call per open MR, every poll) to populate the facepile + review decision. Fine for small projects; watch rate limits on large self-hosted instances.
- **Hotfix cherry-pick** (GitLab-only): after merging an MR whose source branch starts with the configured prefix (default `hotfix/`), the renderer offers to replicate the MR content onto other branches. Targets = config `branches` (default `["development"]`) + the sibling `-mx` branch of the merge's target release branch (derived: `rb/x` ⇄ `rb/x-mx`, only for `rb/…`/`-mx` bases). It cherry-picks the **merge commit SHA** (`mergePR` returns `sha`), which GitLab applies as the whole MR diff. **Never auto-fires**: a post-merge modal dry-runs each target (`cherry_pick` with `dry_run:true`) and shows ✓/✗ per branch before the user confirms. **Non-atomic across N branches**: applied sequentially, partial failure leaves some branches done; reported per-branch. First-real-use check: eyeball the resulting diff on a target branch is the full hotfix, not an empty commit.
- GitLab notes are markdown (no sanitized HTML): `gitlab.js` escapes them into safe HTML. Do not inject GitLab note/description text unescaped.

## Commands
- `npm start` — run the app.
- `npm run selftest` — headed run that screenshots the first rendered state and exits (use this to verify changes; Read the PNG). Routes: `--selftest-route=list|changes|history`, `--seed-draft` seeds an in-memory draft for captures.
- `npm run icon` — regenerate assets/icon-1024.png (then sips/iconutil for build/icon.icns).

## Feature invariants
- **Review drafts**: comments (inline + general) are saved locally via `src/drafts.js` and only published when the user clicks Publicar — ONE review (POST /pulls/N/reviews) with verdict COMMENT/APPROVE/REQUEST_CHANGES. Never auto-publish.
- **AI review** (`src/ai.js`): generates English review comments from the PR diff as DRAFTS only (ai:true, purple cards) — never publishes. Backend order: `ANTHROPIC_API_KEY` → official Anthropic SDK (structured outputs via `output_config.format`) → fallback to the user's authenticated Claude Code CLI (`claude -p --output-format json --model … [--effort …]`, parse `.result`). Model and effort are user-configurable in Settings (catalog in `AI_MODELS`, defaults `claude-opus-4-8` / `high`; Haiku gets no effort/thinking params). Every AI draft is tagged with `aiModel`/`aiEffort` and the card shows them. Anchors are validated against commentable diff lines in the renderer; unanchorable comments fold into the general summary draft.
- **Notifications** (`detectAndNotify`): first poll never notifies; only state *changes* do. Dock badge = PRs awaiting my review.
- **Multi-repo**: `state.repo === "__all__"` aggregates across repos (GitHub: GraphQL search; GitLab: per-project list); detail/drafts/merge must use `detailRepo()` (the PR's own repo), never `state.repo` directly.
- History graph layout lives in `renderer/graph.js` (lane algorithm) — keep it dependency-free.
- **Milestones view** (GitLab-only, `state.view==="milestones"`): a top-level view (like history) showing a **group** milestone's issues grouped by **assignee** (an issue with N assignees shows under each; unassigned → "Sin asignar", sorted last). Group = `config.milestones.group` or derived from `repos[0]`'s first path segment. **GOTCHA: the GitLab issues API param is `milestone=<title>`, NOT `milestone_title=` — the wrong one is silently ignored and returns the whole group's issues.** Default scope is `state=opened` (closed are fetched only when "Mostrar cerradas" is on, so the thousands of closed issues in an active group never crowd out open ones within `apiAll`'s 5-page/500 cap). `statusLabels` render as **tri-state filter chips** (`filters.status` is a `Map<label,"include"|"exclude">`: neutral → include-only → exclude/hide → neutral); `doneLabels` (`finished` + the `pending check*` variants = "terminada pero no cerrada") are **seeded as `exclude`** so they start hidden, plus closed are hidden until "Mostrar cerradas". Default milestone = the date-current one (`pickCurrentMilestone`: skip future/past by `start_date`/`due_date`, prefer the one containing today). **Two metrics** (milestone-level header + per-assignee), always computed over the FULL open set (not the filtered view, so hiding a label never zeroes its %): "sin programar" = open issues with no `statusLabels`; "en comprobar" = open issues bearing a `doneLabels`. Descriptions are GitLab markdown → escaped via `mdToSafeHtml` (never inject unescaped).

## Conventions
- Modern JS, double quotes, no semicolon omission, descriptive names; comments only where the why isn't obvious.
- PR body HTML comes from GitHub's `bodyHTML` (already sanitized) — do not inject other HTML unescaped; everything else goes through `esc()`.
- No default repo: a fresh install shows the onboarding repo picker (suggestions from `viewerRepos()`), and repos can be edited later in Settings. Never reintroduce a hardcoded default repo.
