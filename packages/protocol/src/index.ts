// Shared types for the Agent HQ wire protocol.
// The host server is the single source of truth: clients receive a snapshot on
// connect and then a stream of events. The local UI, remote players and
// remote runners (a member's machine executing that member's agents) all
// speak this protocol over one WebSocket endpoint.

export type ID = string;

// ---------------------------------------------------------------- people

/**
 * owner: the boss (owns the building, shown as "Boss"). manager: every other
 * player (stored as 'member' by older versions, migrated on load).
 */
export type UserRole = 'owner' | 'manager';

/**
 * A Claude login on a player's machine. Each player may connect several;
 * agents run on one of their owner's accounts. Only metadata travels over
 * the wire: credentials stay inside Claude Code on that machine.
 */
export interface ClaudeAccount {
  id: ID;
  userId: ID;
  label: string;
  /**
   * Claude Code config dir (CLAUDE_CONFIG_DIR) for this login, on the owner's
   * machine; relative paths are resolved against that runner's data dir.
   * null = the machine's default login.
   */
  configDir: string | null;
  email: string | null;
  /** e.g. "pro", "max" (from `claude auth status`). */
  plan: string | null;
  loggedIn: boolean;
  checkedAt: number;
}

/**
 * A report an agent delivered to a player's inbox (shown as e-mail on the
 * boss computer). Replying continues the conversation with that agent.
 */
export interface Mail {
  id: ID;
  /** Recipient: the player who invoked the agent. */
  toUserId: ID;
  fromAgentId: ID;
  subject: string;
  /** Markdown: the agent's final message for that run. */
  body: string;
  read: boolean;
  /** Earlier mail in the same conversation, if this is a follow-up. */
  inReplyTo: ID | null;
  createdAt: number;
}

export interface User {
  id: ID;
  name: string;
  role: UserRole;
  color: string;
  /** How this player's avatar looks to everyone else. */
  appearance: Appearance;
  online: boolean;
  /** A runner from this user is connected, so their agents can work. */
  runnerOnline: boolean;
}

export interface Invite {
  id: ID;
  name: string;
  token: string;
  createdAt: number;
  usedBy: ID | null;
}

export interface Presence {
  userId: ID;
  floorId: ID | null;
  /** walk: at `position`; overview: parked (the boss at their desk, others by the elevator). */
  mode: 'walk' | 'overview';
  position: [number, number, number];
  rotation: number;
  ts: number;
}

// ---------------------------------------------------------------- world

export type BuildingKind = 'web' | 'desktop' | 'game' | 'custom';

export interface Building {
  id: ID;
  name: string;
  kind: BuildingKind;
  color: string;
  createdAt: number;
}

export type FloorMaterial = 'wood' | 'carpet' | 'concrete' | 'tiles';

export interface FloorTheme {
  floor: FloorMaterial;
  wallColor: string;
  accentColor: string;
  plants: boolean;
  lounge: boolean;
}

export interface Floor {
  id: ID;
  buildingId: ID;
  name: string;
  level: number;
  /** Number of workstations; "expanding the office" raises it. */
  desks: number;
  theme: FloorTheme;
  createdAt: number;
}

export interface Project {
  id: ID;
  name: string;
  repoPath: string;
  /** `origin` URL, used by remote runners to clone the project. */
  remoteUrl: string | null;
  floorId: ID;
  /** True when repoPath is a git repo with at least one commit; enables worktrees. */
  git: boolean;
  /** https://github.com/<owner>/<repo>; required for new projects (null on legacy ones). */
  githubUrl: string | null;
  createdAt: number;
}

// ---------------------------------------------------------------- agents

export type AgentAdapterKind = 'claude-code';

/** Mirrors Claude Code's --permission-mode choices that make sense for agents. */
export type PermissionMode = 'manual' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan';

/** `offline`: the agent's owner has no runner connected. */
export type AgentStatus = 'idle' | 'working' | 'awaiting_approval' | 'error' | 'offline';

export interface Appearance {
  skin: string;
  hair: string;
  shirt: string;
  hairStyle: 'short' | 'long' | 'bun' | 'bald';
}

/** staff: hired by a player, has a desk. repo: defined in the project's .claude/agents, lives on the balcony. */
export type AgentKind = 'staff' | 'repo';

/** Where a repo agent is right now (drives its 3D behaviour). */
export type RepoAgentLocation = 'balcony' | 'to_desk' | 'desk' | 'to_balcony';

export interface RepoAgentInfo {
  projectId: ID;
  /** Name passed to `claude --agent` (the file name in .claude/agents without .md). */
  agentName: string;
  description: string;
  /** No edit/write tools in its definition: runs directly in the repo instead of a worktree. */
  readOnly: boolean;
  location: RepoAgentLocation;
  /** Hot desk index while working (null on the balcony). */
  deskIndex: number | null;
  /** Player who invoked the current run; reports go to their inbox. */
  invokedBy: ID | null;
}

export interface Agent {
  id: ID;
  /** Defaults to 'staff'. Repo agents can't be fired and only work when invoked. */
  kind: AgentKind;
  /** Set when kind === 'repo'. */
  repo: RepoAgentInfo | null;
  /** Claude account this agent runs on (one of ownerId's accounts); null = owner's default login. */
  accountId: ID | null;
  name: string;
  role: string;
  adapter: AgentAdapterKind;
  model: string | null;
  /** Extra instructions appended to the adapter's default system prompt. */
  instructions: string;
  permissionMode: PermissionMode;
  /** Coordinators can create and assign board tasks through the HQ MCP tools. */
  isManager: boolean;
  /** Ids of integrations (MCP servers) from settings this agent may use. */
  integrations: ID[];
  floorId: ID;
  /** Whose machine and Claude subscription run this agent. */
  ownerId: ID;
  appearance: Appearance;
  status: AgentStatus;
  /** What the agent is doing right now, e.g. "Editing src/app.ts". */
  activity: string | null;
  currentTaskId: ID | null;
  /** A Claude Code session is running for this agent (its terminal can be opened). */
  live: boolean;
  xp: number;
  createdAt: number;
}

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'failed';

export interface Task {
  id: ID;
  projectId: ID;
  title: string;
  description: string;
  status: TaskStatus;
  assigneeId: ID | null;
  /** Adapter session id so follow-ups can resume the same conversation. */
  sessionId: string | null;
  branch: string | null;
  worktreePath: string | null;
  /** User or agent id. */
  createdBy: ID;
  createdAt: number;
  updatedAt: number;
}

export interface Approval {
  id: ID;
  agentId: ID;
  taskId: ID | null;
  toolName: string;
  input: unknown;
  description: string | null;
  /** Whether the adapter offered an "always allow" variant. */
  canAlwaysAllow: boolean;
  createdAt: number;
}

export type TranscriptKind =
  | 'user'
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'system'
  | 'error'
  | 'result';

export interface TranscriptEntry {
  id: number;
  agentId: ID;
  taskId: ID | null;
  kind: TranscriptKind;
  text: string;
  meta: Record<string, unknown> | null;
  ts: number;
}

// ---------------------------------------------------------------- integrations

/** An MCP server agents can be given. `config` is a Claude Code mcpServers entry. */
export interface Integration {
  id: ID;
  name: string;
  description: string;
  /** What the user must install or run first. */
  setup: string;
  config: Record<string, unknown>;
}

// ---------------------------------------------------------------- usage

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Equivalent API cost as reported by the adapter. Not a charge on subscriptions. */
  costUsd: number;
  turns: number;
}

export interface UsageReport {
  total: UsageTotals;
  byAgent: Array<{ agentId: ID; name: string; totals: UsageTotals }>;
  byProject: Array<{ projectId: ID; name: string; totals: UsageTotals }>;
  byDay: Array<{ day: string; totals: UsageTotals }>;
}

export interface RateLimitWindow {
  utilization: number;
  resetsAt: number;
}

/** Subscription utilization as reported by Claude Code (per user's own plan). */
export interface RateLimits {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  updatedAt: number;
}

export interface Settings {
  maxAgents: number;
  /** auto: idle agents pull unassigned tasks from their floor's projects. */
  dispatchMode: 'auto' | 'manual';
  gamification: boolean;
  integrations: Integration[];
}

export interface Snapshot {
  you: User;
  users: User[];
  /** Everyone's connected Claude accounts (metadata only). */
  accounts: ClaudeAccount[];
  /** Your inbox only. */
  mail: Mail[];
  buildings: Building[];
  floors: Floor[];
  projects: Project[];
  agents: Agent[];
  tasks: Task[];
  approvals: Approval[];
  settings: Settings;
  /** Your own subscription meters (each player has their own). */
  rateLimits: RateLimits | null;
  presence: Presence[];
  terminalAvailable: boolean;
}

// ---------------------------------------------------------------- events (server -> client)

export type ServerEvent =
  | { type: 'building'; building: Building }
  | { type: 'building_removed'; id: ID }
  | { type: 'floor'; floor: Floor }
  | { type: 'floor_removed'; id: ID }
  | { type: 'project'; project: Project }
  | { type: 'project_removed'; id: ID }
  | { type: 'agent'; agent: Agent }
  | { type: 'agent_removed'; id: ID }
  | { type: 'task'; task: Task }
  | { type: 'task_removed'; id: ID }
  | { type: 'approval'; approval: Approval }
  | { type: 'approval_resolved'; id: ID }
  | { type: 'transcript'; entry: TranscriptEntry }
  | { type: 'settings'; settings: Settings }
  | { type: 'rate_limits'; userId: ID; rateLimits: RateLimits }
  | { type: 'user'; user: User }
  | { type: 'account'; account: ClaudeAccount }
  | { type: 'account_removed'; id: ID }
  /** Sent only to the recipient. */
  | { type: 'mail'; mail: Mail }
  /** Output of an account login terminal (`claude auth login`), sent to the account's owner. */
  | { type: 'account_login_output'; accountId: ID; data: string }
  | { type: 'presence'; presence: Presence }
  | { type: 'presence_left'; userId: ID }
  | { type: 'terminal_output'; data: string }
  | { type: 'terminal_exit'; code: number | null }
  /** Raw output of an agent's Claude Code terminal; sent to clients that opened it. */
  | { type: 'agent_terminal_output'; agentId: ID; data: string };

// ---------------------------------------------------------------- commands (client -> server)

type AgentEditable = 'name' | 'role' | 'model' | 'instructions' | 'permissionMode' | 'floorId' | 'isManager' | 'integrations' | 'appearance';

export interface Commands {
  create_building: { args: { name: string; kind: BuildingKind; color?: string }; result: Building };
  update_building: { args: { id: ID; patch: Partial<Pick<Building, 'name' | 'kind' | 'color'>> }; result: Building };
  remove_building: { args: { id: ID }; result: null };
  create_floor: { args: { buildingId: ID; name: string }; result: Floor };
  update_floor: { args: { id: ID; patch: Partial<Pick<Floor, 'name' | 'desks' | 'theme'>> }; result: Floor };
  remove_floor: { args: { id: ID }; result: null };
  /**
   * The folder must be a git repo whose origin is on GitHub, unless
   * `createGithubRepo` is set: then the host creates that GitHub repo
   * (needs a GitHub token, see set_github_token), adds it as origin and pushes.
   */
  create_project: {
    args: {
      name: string;
      repoPath: string;
      floorId: ID;
      initGit?: boolean;
      createGithubRepo?: { name: string; private: boolean } | null;
    };
    result: Project;
  };
  /** Link a legacy project to GitHub (same rules as create_project). */
  link_project_github: { args: { id: ID; createGithubRepo?: { name: string; private: boolean } | null }; result: Project };
  /** Re-reads .claude/agents in the project and syncs its repo agents (balcony crew). */
  scan_repo_agents: { args: { projectId: ID }; result: Agent[] };
  /** Owner only. Stored on the host, never sent to clients; `gh auth token` or GITHUB_TOKEN are used when unset. */
  set_github_token: { args: { token: string | null }; result: { configured: boolean } };
  get_github_status: { args: Record<string, never>; result: { configured: boolean; source: 'gh' | 'env' | 'settings' | null; login: string | null } };
  remove_project: { args: { id: ID }; result: null };
  hire_agent: {
    args: {
      name: string;
      role: string;
      floorId: ID;
      model?: string | null;
      instructions?: string;
      permissionMode?: PermissionMode;
      isManager?: boolean;
      integrations?: ID[];
      appearance?: Appearance;
    };
    result: Agent;
  };
  update_agent: { args: { id: ID; patch: Partial<Pick<Agent, AgentEditable>> }; result: Agent };
  fire_agent: { args: { id: ID }; result: null };
  create_task: {
    args: { projectId: ID; title: string; description: string; assigneeId?: ID | null };
    result: Task;
  };
  update_task: {
    args: { id: ID; patch: Partial<Pick<Task, 'title' | 'description' | 'status'>> };
    result: Task;
  };
  remove_task: { args: { id: ID }; result: null };
  assign_task: { args: { taskId: ID; agentId: ID }; result: Task };
  send_message: { args: { agentId: ID; text: string }; result: null };
  interrupt_agent: { args: { agentId: ID }; result: null };
  resolve_approval: {
    args: { id: ID; decision: 'allow' | 'deny'; always?: boolean; message?: string };
    result: null;
  };
  get_transcript: { args: { agentId: ID; limit?: number }; result: TranscriptEntry[] };
  // repo agents (balcony crew)
  /** Calls a repo agent to work on your account: it walks to a hot desk, runs, and mails you a report. */
  invoke_repo_agent: { args: { agentId: ID; prompt: string; accountId?: ID | null }; result: Agent };
  // inbox
  mark_mail_read: { args: { id: ID }; result: null };
  /** Continues the conversation with the mail's agent (it comes back to a desk if needed). */
  reply_mail: { args: { id: ID; text: string }; result: null };
  delete_mail: { args: { id: ID }; result: null };
  // Claude accounts
  /** Adds a new login slot on your machine and starts `claude auth login` for it (output via account_login_output). */
  add_account: { args: { label: string }; result: ClaudeAccount };
  account_login_input: { args: { accountId: ID; data: string }; result: null };
  /** Re-checks login status (email, plan) of your accounts. */
  refresh_accounts: { args: Record<string, never>; result: ClaudeAccount[] };
  remove_account: { args: { id: ID }; result: null };
  /** Which of your accounts an agent of yours runs on (applies from its next session). */
  set_agent_account: { args: { agentId: ID; accountId: ID | null }; result: Agent };
  /**
   * Moves an agent's work onto your machine and account: its current
   * task/branch continues in a new session of yours, with a handoff summary.
   */
  take_over_agent: { args: { agentId: ID; accountId?: ID | null }; result: Agent };
  get_usage_report: { args: Record<string, never>; result: UsageReport };
  update_settings: { args: { patch: Partial<Settings> }; result: Settings };
  // multiplayer
  update_profile: { args: { name?: string; color?: string; appearance?: Appearance }; result: User };
  create_invite: { args: { name: string }; result: Invite };
  list_invites: { args: Record<string, never>; result: Invite[] };
  revoke_invite: { args: { id: ID }; result: null };
  remove_member: { args: { id: ID }; result: null };
  presence: { args: { floorId: ID | null; mode: 'walk' | 'overview'; position: [number, number, number]; rotation: number }; result: null };
  // agent terminals: the real Claude Code TUI of each agent
  agent_terminal_open: {
    args: { agentId: ID; cols: number; rows: number };
    /** `interactive`: false when this agent runs in chat-only mode (no terminal support on its machine). */
    result: { history: string; interactive: boolean; canType: boolean };
  };
  agent_terminal_input: { args: { agentId: ID; data: string }; result: null };
  agent_terminal_resize: { args: { agentId: ID; cols: number; rows: number }; result: null };
  agent_terminal_close: { args: { agentId: ID }; result: null };
  // boss terminal (owner only)
  terminal_open: { args: { cols: number; rows: number }; result: { history: string } };
  terminal_input: { args: { data: string }; result: null };
  terminal_resize: { args: { cols: number; rows: number }; result: null };
}

export type CommandName = keyof Commands;

export interface ClientRequest<K extends CommandName = CommandName> {
  type: 'request';
  id: number;
  command: K;
  args: Commands[K]['args'];
}

export type ServerMessage =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'event'; event: ServerEvent }
  | { type: 'reply'; id: number; ok: true; result: unknown }
  | { type: 'reply'; id: number; ok: false; error: string };

// ---------------------------------------------------------------- runner protocol
// A runner executes agent sessions on its user's machine. The host sends it
// operations; it streams session events back. The host's own agents use an
// in-process runner with the same interface.

export interface RunnerStart {
  sessionKey: string;
  agent: Agent;
  /** null: a free conversation with the agent, outside any task. */
  task: Task | null;
  /** null with a null task: the agent's own scratch workspace. */
  project: Project | null;
  /** First message, or null to just open the session and wait for the user. */
  prompt: string | null;
  /** mcpServers entries from enabled integrations. */
  mcpServers: Record<string, unknown>;
  /** Credentials for the HQ MCP tools (board access) for this agent. */
  hq: { url: string; token: string; manager: boolean };
  /** Claude Code config dir of the account to run on (null = default login). */
  configDir: string | null;
  /** Run as this repo agent (`claude --agent <name>`). */
  repoAgentName: string | null;
}

export type RunnerOp =
  | { op: 'start'; start: RunnerStart }
  | { op: 'send'; sessionKey: string; text: string }
  | { op: 'interrupt'; sessionKey: string }
  | { op: 'permission'; sessionKey: string; requestId: string; allow: boolean; always?: boolean; message?: string }
  | { op: 'close'; sessionKey: string }
  | { op: 'pty_input'; sessionKey: string; data: string }
  | { op: 'pty_resize'; sessionKey: string; cols: number; rows: number }
  /** Answered with an `exit` runner_event on `requestKey` (error null = removed). */
  | { op: 'cleanup'; requestKey: string; project: Project; task: Task }
  /** Lists .claude/agents in the runner's checkout; answered with runner_reply. */
  | { op: 'scan_agents'; requestKey: string; project: Project }
  /** `claude auth status --json` for each config dir; answered with runner_reply. */
  | { op: 'account_status'; requestKey: string; configDirs: Array<string | null> }
  /**
   * Starts `claude auth login` in a PTY for that config dir; output via runner_event 'pty' on requestKey,
   * then 'exit'. Keystrokes and close use pty_input / close with sessionKey = requestKey.
   */
  | { op: 'account_login'; requestKey: string; configDir: string }
  /** Deletes an account's config dir (never the default login); answered with runner_reply. */
  | { op: 'account_remove'; requestKey: string; configDir: string }
  /** Before a takeover: commit WIP on the task branch and push it if there is an origin; answered with runner_reply. */
  | { op: 'handoff'; requestKey: string; project: Project; task: Task };

export type RunnerSessionEvent =
  | { type: 'session'; sessionId: string; interactive: boolean }
  /** Terminal output (interactive sessions only). */
  | { type: 'pty'; data: string }
  /** The agent started working on a prompt (typed in the terminal or sent by Agent HQ). */
  | { type: 'turn_start'; prompt: string }
  /** The agent is blocked waiting for the user, e.g. a permission prompt in its terminal. */
  | { type: 'waiting'; reason: string }
  /** Work resumed after waiting. */
  | { type: 'resumed' }
  | { type: 'workspace'; branch: string | null; worktreePath: string | null }
  | { type: 'transcript'; kind: TranscriptKind; text: string; meta?: Record<string, unknown> }
  | { type: 'activity'; activity: string | null }
  | {
      type: 'permission_request';
      requestId: string;
      toolName: string;
      input: unknown;
      description: string | null;
      canAlwaysAllow: boolean;
    }
  | {
      type: 'turn_end';
      ok: boolean;
      interrupted: boolean;
      error: string | null;
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number };
    }
  | { type: 'rate_limits'; rateLimits: RateLimits }
  | { type: 'exit'; code: number | null; error: string | null };

export type RunnerMessage =
  | { type: 'runner_event'; sessionKey: string; event: RunnerSessionEvent }
  | { type: 'runner_reply'; requestKey: string; ok: boolean; result: unknown; error: string | null }
  | { type: 'runner_hello'; claudeVersion: string | null };

export type HostToRunner = { type: 'runner_op'; op: RunnerOp };
