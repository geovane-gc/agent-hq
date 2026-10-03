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
| `machine-accounts.ts` | The host owner's Claude accounts are machine-wide: records in `<data>/claude-accounts.json`, config dirs in `<data>/claude-accounts`, shown in every office. Teammates' accounts stay in the office database |
| `economy.ts`, `economy-config.ts` | The ledger: revenue for verified merged work (once per task), token costs as expenses, hiring fees and career-mode gating. Every balance number lives in `economy-config.ts` |
| `delivery.ts` | Git checks behind revenue: is a task branch merged into the default branch (merge, rebase or squash), and how many lines changed |
| `media.ts` | Voice and screen sharing: who is in voice (runtime only), one screen share per floor's meeting room, WebRTC signaling relay to one player's tab, STUN/TURN settings (the TURN credential is kept out of the broadcast settings) |

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
| `office3d/MeetingRoom.tsx` | The meeting room: partitions with a door, table and chairs, the wall screen (shared screen as a video texture) and the whiteboard anchor |
| `voice/engine.ts` | Voice and screen sharing in the browser: WebRTC mesh, mic and screen capture, Web Audio graph (gain by distance, panner, speaking detection), push-to-talk, local preferences |
| `voice/spatial.ts` | Who hears whom: avatar positions (as `Players.tsx` draws them), meeting membership, channels, proximity gain |
| `components/Voice.tsx` | Voice dock (mic, nearby/everyone, people and devices), meeting card, full-size shared screen |
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

## Voice chat and the meeting room

Media goes peer to peer between players' browsers (WebRTC); the host is only the signaling channel and the keeper of
runtime state (nothing is persisted). Agents are never part of it: their connections get no voice events and can't
use the commands.

- **Joining**: each tab has a random `peerId` and sends `voice_state {peerId, mode, mic, meeting}` (broadcast as
  `voice_state`; `voice_left` when the player's last connection closes or they call `voice_leave`). The newest tab
  of a player wins; older ones show "Voice is on in another window".
- **Signaling**: `rtc_signal {toUserId, toPeerId, fromPeerId, signal}` with an offer, answer or ICE candidate. The
  host checks both ends are in voice with those peer ids, caps sizes, and delivers it only to the target player
  (their tab with `toPeerId` handles it).
- **Full mesh, negotiated once**: every pair of players in voice has one `RTCPeerConnection`; the lower `peerId`
  offers. Each connection carries an audio and a video transceiver from the start, so nothing is renegotiated: what
  you send to whom is `sender.replaceTrack(track | null)`. A failed connection is rebuilt after 3 s. The mesh costs
  one connection per pair and uploads your audio once per listener: fine up to about 8 people in voice; beyond that
  an SFU would be needed.
- **Who hears whom** (`voice/spatial.ts`, computed identically by everyone from the presence stream): a player in a
  floor's meeting room (standing inside it in walk mode, or after *Join meeting*) is in that room's channel;
  otherwise in their chosen mode. Proximity: same floor and closer than `proximityRadius` (default 8 m), full volume
  up to 1.5 m then fading quadratically to 0 at the radius; parked players count at their parked spot. Global and
  meeting channels play at full volume. Senders only send their mic to players who can hear them (with 1 m of slack
  so listeners fade out instead of being cut off), so a far-away client never receives your voice.
- **Playback**: remote audio → `AnalyserNode` (speaking indicator) and `GainNode` (distance × your per-player
  volume, 0 when muted) → HRTF `PannerNode` at the speaker's avatar (proximity in walk mode) → the output device
  (`AudioContext.setSinkId`). Chrome only feeds remote WebRTC audio into Web Audio while a (muted) media element
  plays it, so each peer also has one.
- **Mic**: off by default and never turned on by Agent HQ; modes *off*, *on* and *push-to-talk* (`V`, ignored in
  inputs and terminals). Turning it off stops the capture (the browser's indicator goes away).
- **Screen sharing**: `screen_share_start {floorId, peerId}` claims the floor's meeting-room screen (one sharer at a
  time; refused otherwise), `screen_share_stop` ends it (the sharer, or the boss for anyone's). The sharer's tab
  sends the capture only to players in that meeting, and stops sharing when it leaves the room, the capture ends or
  the share disappears. Receivers show it on the wall (`THREE.VideoTexture`) and full size.
- **ICE**: `Settings.voice` holds the STUN URLs (default `stun:stun.l.google.com:19302`), an optional TURN URL and
  username, and whether a TURN credential is stored. The credential lives in the office database only and reaches
  players through `get_ice_servers`, which only players can call. Players behind symmetric NATs need TURN.
- **Meeting room layout** (`layout.ts → meetingRoom`): the strip below the boss room against the left wall (6 m wide,
  up to 7 m deep, with its own front partition when the floor is deeper). Its back is the boss room's glass, the
  right side a partition with a door next to the spawn point. The wall screen hangs on the outer wall facing +X; the
  long table runs from the screen towards the partition, where `whiteboardAnchor` keeps a 1.2 to 2.4 m stretch of
  wall clear, facing the screen. `MeetingRoom` takes a `whiteboard` node and mounts it at that anchor (a group named
  `whiteboard-anchor`); nothing is built there yet.
- **Electron**: `setupMedia` in `apps/desktop/main.cjs` grants microphone-only `media` and `speaker-selection` to the
  office's own origin (asking macOS for microphone access when needed), and answers `getDisplayMedia` with the system
  picker where there is one (macOS 15+), otherwise a small menu of screens and windows with thumbnails.

## Known limits

- The WebSocket endpoint has no TLS of its own. Use a tunnel or reverse proxy with HTTPS for anything beyond a
  trusted LAN. Browsers only allow the microphone and screen capture on HTTPS or `localhost`: teammates opening a
  plain `http://host:4317` invite can listen to voice but need HTTPS to talk or share their screen.
- Voice is a full mesh: about 8 people in voice at once. Players behind strict NATs need a TURN server, and players in
  voice together can see each other's IP addresses.
- Remote runners need a reachable git `origin` (or a `--repo` mapping) for each project they work on.
- If the host process is killed abruptly (not closed), agent Claude Code processes can outlive it.
