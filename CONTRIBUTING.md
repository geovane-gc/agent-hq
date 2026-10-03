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
```

Then try your change in the running app (`npm run dev` or `npm run dev:web`). For visual changes, add a screenshot or
a short clip to the PR. If you changed behavior described in the README or in `docs/`, update those docs in the same PR.

## Commit messages

Write short, imperative commit subjects that say what the change does, for example
`Add task filters to the board` or `Fix camera flight when leaving a monitor`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
