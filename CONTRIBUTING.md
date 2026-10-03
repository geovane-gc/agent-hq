# Contributing to Agent HQ

Thanks for your interest in Agent HQ! The project is early, so bug reports, ideas and pull requests all help a lot.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug**: open an issue with the *Bug report* template. Include your OS, Node.js and Claude Code versions and
  how you run Agent HQ (desktop app, browser or runner).
- **Suggest a feature**: open an issue with the *Feature request* template, or start a thread in
  [Discussions](https://github.com/geovane-gc/agent-hq/discussions) if the idea is still loose.
- **Send a pull request**: fixes, features, docs and 3D models are all welcome. For anything larger than a small fix,
  open an issue first so we can agree on the approach before you spend time on it.
- **Security issues**: please don't open a public issue. Follow [SECURITY.md](SECURITY.md) instead.

## Development setup

You need the same things as a regular install:

- **Node.js 22.18 or newer**
- **Claude Code**, installed and logged in (`claude` on your PATH)
- **git**

```sh
git clone https://github.com/geovane-gc/agent-hq.git
cd agent-hq
npm install
npm run dev        # desktop app (Electron) with hot reload
npm run dev:web    # or the same in your browser: open the printed ?token=… link
```

Your local data (database, worktrees, agent notes, owner token) lives in `~/.agent-hq` by default. Point
`--data-dir` / `AGENT_HQ_DATA_DIR` somewhere else if you want to keep a development office apart from your real one.

## Where things live

| Path | What's there |
|---|---|
| `packages/protocol` | Shared types: the client/server protocol and the runner protocol |
| `packages/core` | Host server, orchestrator, runners, Claude Code adapters, hooks, HQ MCP tools, terminal, SQLite |
| `apps/web` | The game: React + Three.js (React Three Fiber) office, campus and HUD |
| `apps/desktop` | The Electron app: starts the host server and shows the office |
| `assets/blender` | The Blender script that generates every 3D model |
| `docs` | Architecture notes and screenshots |

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit together. Read it before changing the
protocol, the orchestrator or the agent session lifecycle.

## Making changes

- **Keep pull requests focused.** One fix or feature per PR is much easier to review.
- **Protocol changes** go in `packages/protocol` and must keep the host, the web client and remote runners in sync.
- **3D models** are generated, not hand-edited. Change `assets/blender/build_assets.py`, regenerate with
  `npm run models` (Blender 4.2+ on your PATH) and commit the updated `apps/web/public/models/*.glb` together with the
  script change.
- **Cross-platform**: Agent HQ runs on Windows, macOS and Linux. Be careful with paths, shells and spawning processes,
  and mention in your PR which OS you tested on.
- **Security-sensitive areas** (tokens, permissions, folder trust, anything that lets agents run commands) deserve an
  extra note in the PR description explaining the impact.

## Before you open a pull request

Run the checks from the repository root:

```sh
npm run typecheck   # type-check packages/core and apps/web
npm run build       # build the web UI
npm run smoke       # end-to-end smoke test with a fake Claude Code (needs the build)
```

CI runs the same checks on Linux, macOS and Windows, and the smoke test on Linux.

Then try your change in the running app (`npm run dev` or `npm run dev:web`). For visual changes, add a screenshot or
a short clip to the PR. If you changed behavior described in the README or in `docs/`, update those docs in the same PR.

## Testing in isolation

`scripts/fake-claude.mjs` is a stand-in for the `claude` CLI: no network, no login, no subscription, Node built-ins
only. It covers what Agent HQ uses: `--version`, `auth status|login|logout` (a marker file per `CLAUDE_CONFIG_DIR`),
the interactive session (folder trust dialog, canned answers, permission prompts, the hooks and statusline Agent HQ
configures, `--resume`) and the headless `-p` stream-json mode. Its header lists the knobs, for example
`FAKE_CLAUDE_REPLY`, `FAKE_CLAUDE_EMAIL`, `FAKE_CLAUDE_PLAN`, `FAKE_CLAUDE_TOOL`, `FAKE_CLAUDE_MCP=agent-hq` (connect
to the HQ board tools) and `FAKE_CLAUDE_LOG=<file>` (one JSON line per action). Put `fake:tool=Bash` or
`fake:slow=10000` in a message to an agent to get a permission prompt or a long turn.

Run a throwaway office with it, so you never touch your real `~/.agent-hq` or your real Claude login:

```sh
export HQ_TMP=$(mktemp -d)
export AGENT_HQ_CLAUDE_PATH="$PWD/scripts/fake-claude.mjs"
export CLAUDE_CONFIG_DIR="$HQ_TMP/claude"      # the fake's "default login"
export FAKE_CLAUDE_LOG="$HQ_TMP/fake-claude.log"
node scripts/fake-claude.mjs auth login < /dev/null    # optional: start logged in

npm run build
npm run start:web -- --data-dir "$HQ_TMP/data" --port 4417   # prints the ?token=… link
```

On Windows (PowerShell) set the same variables with `$env:NAME = "…"`. Agent HQ runs a `.mjs` / `.js`
`AGENT_HQ_CLAUDE_PATH` with Node, so the fake works there without a shim.

- **Ports**: the core listens on `--port` / `AGENT_HQ_PORT` (default 4317). `npm run start:web` takes any port, so it
  can run next to your real office. `npm run dev:web` passes no arguments to the core and Vite proxies `/ws` to 4317,
  so use it only with your real office stopped, with `AGENT_HQ_DATA_DIR` (and the variables above) in the environment.
  `npm start` (the desktop window) reads `AGENT_HQ_PORT` and `AGENT_HQ_DATA_DIR`.
- **Never** point a test at the real `~/.agent-hq` or run it without `CLAUDE_CONFIG_DIR`: account tests log in and out
  for real when `claude` is the real CLI. The fake itself never reads or writes `~/.claude`.
- **Headless Chrome**: the 3D office needs WebGL, which headless Chrome provides through SwiftShader. Drive it with
  Puppeteer (`puppeteer-core` plus your installed Chrome) or Playwright, with a throwaway profile and these flags:
  `--headless=new --user-data-dir="$HQ_TMP/chrome" --use-angle=swiftshader --enable-unsafe-swiftshader
  --window-size=1440,900`, then open `http://localhost:4417/?token=$(cat "$HQ_TMP/data/owner-token")`. Chrome's
  one-shot `--screenshot` mode tends to hang on the live scene; take screenshots from the script instead.
- `npm run smoke` does all of this on its own: temp dirs, a free port, the fake CLI, then checks over HTTP and
  WebSocket (office, hiring, a turn with hooks, a permission prompt, an interrupt, a login and logout, the headless
  mode) and shuts everything down. `SMOKE_DIR=<dir>` keeps its logs and data.

## Commit messages

Write short, imperative commit subjects that say what the change does, for example
`Add task filters to the board` or `Fix camera flight when leaving a monitor`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
