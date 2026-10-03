# Architecture

## Principles

- **Only Node.js and Claude Code are required.** Blender, Unity, Figma, GitHub and browser testing are optional MCP
  integrations given to individual agents.
- **The host server is the single source of truth.** Clients get a snapshot on connect, then a stream of events.
  Browser players, the Electron window, teammates' runners and agents' HQ tools all use one WebSocket endpoint and the
  types in `packages/protocol`.
- **Agents run on their owner's machine.** Agent HQ never embeds Claude login and never uses subscription credentials
  through the Agent SDK. It spawns each user's own `claude` binary on that user's computer.
- **No compilers needed.** SQLite comes from `node:sqlite` and the build uses WebAssembly Rollup, so installs work
  without a C++ toolchain and under Windows Smart App Control. Terminals use the prebuilt, optional
  `@lydell/node-pty`; without it agents fall back to headless sessions and the boss terminal to a piped shell.

## Components

```
                 +--------------------- host (owner's machine) ---------------------+
browser /  --ws->|  server.ts      auth: owner token, invites, agent tokens          |
Electron         |  orchestrator   commands, roles, dispatch, sessions, terminals    |
                 |  store + db     world state, SQLite persistence                   |
                 |  terminal       boss PTY (owner only)                             |
                 |  LocalRunner -> claude (interactive TUI in a PTY) per agent       |
                 |  RemoteRunner <-ws- teammate's `agent-hq join`                    |
                 +-------------------------------------------------------------------+
claude --stdio--> hq-mcp.ts --ws--> host          (board tools for agents/coordinators)
claude --hooks--> hq-hook.ts --http--> runner     (agent status, usage, rate limits)
```

### packages/core

| File | Role |
|---|---|
| `server.ts` | HTTP (static UI) and WebSocket. Resolves each connection to an actor: owner, member, agent (HQ MCP) or runner. Relays agent terminal output to the clients watching it |
| `orchestrator.ts` | Commands, permission checks (owner-only, agent-owner-only, coordinator-only), dispatch, session lifecycle, terminal buffers |
| `store.ts`, `db.ts` | In-memory world backed by SQLite: entities, transcript, usage. Normalizes records saved by older versions |
| `runner/local.ts` | Runs sessions on this machine: worktree, memory and system prompt, MCP config, adapter |
| `runner/hook-server.ts` | Loopback HTTP endpoint receiving Claude Code hook events for this runner's sessions |
| `runner/remote.ts` | Host-side proxy that sends runner ops (start, input, resize, close…) to a teammate's machine |
| `runner/join.ts` | `agent-hq join`: the teammate's side. Clones or maps repos and runs a LocalRunner |
| `adapters/claude-code-tui.ts` | The default: Claude Code's interactive UI in a PTY, status from hooks and the statusline |
| `adapters/claude-code.ts` | Binary discovery and the headless `claude -p` stream-json fallback |
| `adapters/env.ts` | Strips inherited Claude Code session variables from spawned processes |
| `hooks/hq-hook.ts` | Hook/statusline command that forwards events to the runner |
| `mcp/hq-mcp.ts` | Stdio MCP server giving agents `list_team`, `list_projects` and `list_tasks`; coordinators also get `create_task` and `assign_task` |
| `integrations.ts` | Default optional MCP catalog and the Windows `cmd /c` wrapping for npx/uvx |
| `terminal.ts` | Boss terminal |
| `offices.ts` | Offices as separate saves (`<data>/offices.json`, one data dir each; a pre-offices install becomes the sandbox save "My office"). Opens one at a time and switches in-process; also answers the host commands (offices, ledger) |
| `economy.ts`, `economy-config.ts` | The ledger: revenue for verified merged work (once per task), token costs as expenses, hiring fees and career-mode gating. Every balance number lives in `economy-config.ts` |
| `delivery.ts` | Git checks behind revenue: is a task branch merged into the default branch (merge, rebase or squash), and how many lines changed |

### apps/web

| Path | Role |
|---|---|
| `office3d/OfficeScene.tsx` | One floor: lights, room, workstations, players, and the camera director (controls, zoom into a monitor and back) |
| `office3d/Room.tsx` | Themed floor and walls (cut away in the overview), ceiling with lights (first person), windows, boss room, whiteboard, elevator, lounge, plants |
| `office3d/layout.ts` | Floor plan, fixture positions and collision boxes shared by the room, cameras and players |
| `office3d/Workstation.tsx` | Desk, monitor (live screen), keyboard and chair with the seated agent; status picks the animation clip |
| `office3d/models.tsx` | Loads the Blender glTF models; per-instance recoloring; the animated `Character` (hair styles, suit) |
| `office3d/Controls.tsx` | Overview orbit camera (+WASD); first-person walking with raw pointer lock, smoothing and sliding collisions; camera flights |
| `office3d/Players.tsx` | Other players: walking avatars, the boss at their desk, everyone else by the elevator |
| `office3d/CampusScene.tsx` | Buildings as towers with one storey per floor; lit windows show activity |
| `office3d/Label.tsx` | In-world HTML labels through a stable portal |
| `components/AgentTerminal.tsx` | An agent's real Claude Code terminal (xterm.js) shown on the zoomed monitor |
| `components/*` | Other HUD panels: board, forms, history and settings, team and invites, usage, boss terminal |

3D models (characters, furniture, trees) are generated by `assets/blender/build_assets.py` and committed as
`apps/web/public/models/*.glb` (about 1 MB in total), so players never need Blender. Regenerate them with `npm run models`
(Blender 4.2+ on PATH). The character is rigged with six clips: Stand, Walk, SitIdle, SitType, SitWave and SitError, and
has optional `Outfit_Suit*` pieces (the boss wears them). Materials named Skin, Hair, Shirt, Upholstery and Accent are
recolored per instance, and the monitor's Screen material is replaced with the live screen.

## Agent sessions

### Interactive (default)

Each running agent is Claude Code's own terminal UI inside a pseudo-terminal:

```
claude [initial prompt] --settings <hooks + statusline> --append-system-prompt <role, workspace, board, notes>
       --permission-mode <mode> --mcp-config <agent-hq + integrations>
       [--model m] [--resume <session>] [--add-dir <notes dir>]
```

- The raw terminal stream is buffered on the host and relayed to whoever opens the agent's computer. The agent's
  owner can type into it (keystrokes and resizes go back to the PTY); teammates watch read-only.
- Hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`) are sent by
  `hq-hook.ts` to the runner and become office state: working, activity text, "needs approval" (permission prompts),
  turn finished. The statusline payload provides cumulative cost and tokens (stored as per-turn deltas) and the
  subscription's 5h / 7d rate limits.
- Permission prompts are answered in the terminal (or with the Approve / Deny buttons, which send Enter / Esc).
- New worktrees trigger Claude Code's folder-trust question; Agent HQ answers "Yes, I trust this folder" for the
  folders it creates from repositories you chose.
- Sessions without a task are free conversations, in the floor's first project or the agent's scratch folder.

### Headless (fallback)

When the PTY module can't load, sessions run as `claude -p --input-format stream-json --output-format stream-json
--permission-prompt-tool stdio …`. Permission requests become approval cards in the agent's chat panel, `result`
messages end turns, and `rate_limit_event`s feed the meters.

## Task lifecycle

```
todo --assign/dispatch--> in_progress --turn ends--> review --mark done--> done
  ^                            ^                       |
  +---------- reopen ----------+----- user message ----+
```

A worktree is created on the runner's machine at `<data>/wt/<project8>/<task8>` on branch `hq/<agent>-<task8>`.
Reopened tasks reuse their branch. Marking a task done stops the session, waits for the process to exit (Windows locks
a process's working directory) and removes the worktree if it is clean.

Auto-dispatch: idle non-coordinator agents take the oldest unassigned `todo` task whose project is on their floor, but
never interrupt a free conversation someone is watching. Tasks assigned to a busy agent wait in that agent's queue.

## Multiplayer model

- **Identity**: the owner token lives in `<data>/owner-token`; the owner is the **boss**. Invites create **manager**
  users on first use (stored as `member` by older versions and migrated on load). Agents get a short-lived token per
  session for the HQ MCP tools.
- **Authority**: the boss manages the world (buildings, floors, projects, settings, invites, terminal). Anyone can use
  the board and hire agents, which are owned by whoever hired them. Only an agent's owner can edit it.
- **Execution**: an agent runs on its owner's runner. The boss's runner is in-process on the host; managers connect
  theirs with `agent-hq join`. When a manager's runner disconnects, their agents show as offline.
- **Claude accounts**: each player can connect several Claude logins on their own machine, one Claude Code config dir
  each (`<runner data>/claude-accounts/<id>`, used as `CLAUDE_CONFIG_DIR`; `null` is the machine's default login).
  Logins run as `claude auth login` in a terminal inside the game (`account_login` runner op, output sent only to that
  player). The host only stores metadata: email, plan and logged-in state from `claude auth status --json`
  (`account_status` op), re-checked when a runner connects, after a login, on demand and every 10 minutes. An agent
  runs on one of its owner's accounts; switching restarts its session there and resumes it (the session file is copied
  between config dirs on that machine). Removing an account logs it out (`account_remove` op) and deletes its dir, with
  guards: never the default login, only dirs under `claude-accounts/` (symlinks resolved), `claude` always runs with
  `CLAUDE_CONFIG_DIR` set to that dir, and `claude auth logout` only runs when `claude auth status` in that dir reports
  the same dir and the account's email. Otherwise the dir is still deleted and the player is warned that credentials
  may remain (revoke at claude.ai).
- **Input belongs to the account**: nobody may type into a Claude Code session running on someone else's account. The
  orchestrator checks it for terminal input, messages, interrupts and approvals, against the agent's owner, its account
  and the account the live session was started on. Everyone else can watch read-only.
- **Work belongs to the account too**: board tasks can only be handed to agents running on the assigner's account
  (`assign_task`, `create_task` with an assignee, a coordinator's MCP tools: the coordinator's own player's account).
  Auto-dispatch gives an open task only to agents running on the account of whoever created it (for a task created by
  a coordinator, its player), and repo agents never pick up open tasks.
- **Takeover**: `take_over_agent` moves an agent's work to the caller's machine and account. With the boss's
  `takeoverPolicy: 'approval'` (the default) it first files a `TakeoverRequest` that the player whose account runs the
  agent approves or denies (`respond_takeover`); it stays pending while they are away and the requester can cancel it.
  With `'free'` it happens at once. The host stops the
  session, asks the previous owner's runner to commit uncommitted work on the task branch as a WIP commit and push it
  (`handoff` op; aborted if the push fails), removes that worktree, then reassigns the agent (owner and account) and
  clears the task's session and worktree. The new runner fetches the branch from origin (fast-forwarding a stale local
  copy), creates its worktree and starts a fresh session whose prompt is a summary built from the transcript the host
  keeps (requests, files touched, last steps, last message) plus the agent's notes from the previous machine. If the
  previous machine is offline, whatever is already on origin carries over. Projects need a git origin for this.
  Work queued for the agent on the old account goes back to the open board. Repo agents can be taken over too: a run
  outside any task (e.g. read-only in the repo) restarts on the new machine from a summary of that run, and its report
  goes to the new owner (`repo.invokedBy`).
- **Presence**: players walking in first person broadcast their position and render as walking avatars; players in the
  overview are shown parked (the boss at the executive desk, others by the elevator).

## Known limits

- The WebSocket endpoint has no TLS of its own. Use a tunnel or reverse proxy with HTTPS for anything beyond a
  trusted LAN.
- Remote runners need a reachable git `origin` (or a `--repo` mapping) for each project they work on.
- If the host process is killed abruptly (not closed), agent Claude Code processes can outlive it.
