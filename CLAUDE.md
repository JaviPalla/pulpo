# CLAUDE.md — Pulpo

Mac (Electron) GitHub PR client for Jesús. Bitbucket-style PR list + detail pane.

## Hard rules (product decisions, never change without being asked)
- Update branch = **rebase** (`updatePullRequestBranch` with `updateMethod: REBASE`).
- Merge = **merge commit** (`merge_method: "merge"`). **Squash must never be offered or implemented.**
- The token is never hardcoded, committed, or sent to the renderer. Resolution: `GITHUB_TOKEN` env → `gh auth token` → manual token in userData config (0600).

## Stack & layout
- Electron (no bundler, no framework): vanilla JS renderer.
- `src/main.js` — window, IPC handlers, `--selftest` (screenshot to /tmp/pulpo-selftest.png then quit).
- `src/github.js` — GraphQL (list/detail/update-branch) + REST (merge, delete ref). All GitHub calls live in the main process.
- `src/config.js` — config.json in `app.getPath("userData")` (repos[], pollSeconds, optional manual token).
- `src/preload.js` — contextBridge API (`window.pulpo.*`); renderer is sandboxed, contextIsolation on, CSP strict (no remote scripts; images https only).
- `renderer/` — index.html + styles.css + app.js. UI text in Spanish.

## Commands
- `npm start` — run the app.
- `npm run selftest` — headed run that screenshots the first rendered state and exits (use this to verify changes; Read the PNG). Routes: `--selftest-route=list|changes|history`, `--seed-draft` seeds an in-memory draft for captures.
- `npm run icon` — regenerate assets/icon-1024.png (then sips/iconutil for build/icon.icns).

## Feature invariants
- **Review drafts**: comments (inline + general) are saved locally via `src/drafts.js` and only published when the user clicks Publicar — ONE review (POST /pulls/N/reviews) with verdict COMMENT/APPROVE/REQUEST_CHANGES. Never auto-publish.
- **AI review** (`src/ai.js`): generates English review comments from the PR diff as DRAFTS only (ai:true, purple cards) — never publishes. Backend order: `ANTHROPIC_API_KEY` → official Anthropic SDK (`claude-opus-4-8`, structured outputs via `output_config.format`) → fallback to the user's authenticated Claude Code CLI (`claude -p --output-format json`, parse `.result`). Anchors are validated against commentable diff lines in the renderer; unanchorable comments fold into the general summary draft.
- **Notifications** (`detectAndNotify`): first poll never notifies; only state *changes* do. Dock badge = PRs awaiting my review.
- **Multi-repo**: `state.repo === "__all__"` aggregates via GraphQL search; detail/drafts/merge must use `detailRepo()` (the PR's own repo), never `state.repo` directly.
- History graph layout lives in `renderer/graph.js` (lane algorithm) — keep it dependency-free.

## Conventions
- Modern JS, double quotes, no semicolon omission, descriptive names; comments only where the why isn't obvious.
- PR body HTML comes from GitHub's `bodyHTML` (already sanitized) — do not inject other HTML unescaped; everything else goes through `esc()`.
- No default repo: a fresh install shows the onboarding repo picker (suggestions from `viewerRepos()`), and repos can be edited later in Settings. Never reintroduce a hardcoded default repo.
