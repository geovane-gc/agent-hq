import type { PermissionMode, RunnerSessionEvent } from '@agent-hq/protocol';

// An adapter turns a concrete coding agent (Claude Code today; Codex, Gemini
// CLI, ... later) into a uniform session the orchestrator can drive.

export interface SessionOptions {
  cwd: string;
  model: string | null;
  permissionMode: PermissionMode;
  /** Appended to the agent's default system prompt. */
  systemPrompt: string;
  /** Resume an earlier conversation instead of starting a new one. */
  resumeSessionId: string | null;
  /** Claude Code config dir (CLAUDE_CONFIG_DIR) of the account to run on; null = the default login. */
  configDir: string | null;
  /** Extra directories the agent may access (e.g. its memory folder). */
  addDirs: string[];
  /** MCP servers to load, as a Claude Code `mcpServers` map. */
  mcpServers: Record<string, unknown>;
  /** Run as this agent from the project's .claude/agents (`claude --agent <name>`). */
  agentName: string | null;
  /** First prompt; null opens the session and waits for the user. */
  initialPrompt: string | null;
  /**
   * Where interactive sessions report hook events (see hooks/hq-hook.ts):
   * the runner's loopback URL and a function registering a per-session handler.
   */
  hooks: { url: string; register: (handler: (event: string, input: any) => void) => string } | null;
}

export type SessionEvent = Exclude<RunnerSessionEvent, { type: 'workspace' }>;

export interface PermissionDecision {
  allow: boolean;
  always?: boolean;
  message?: string;
}

export interface AgentSession {
  /** True when the session is a real terminal (TUI) the user can type into. */
  readonly interactive: boolean;
  send(text: string): void;
  interrupt(): void;
  respondPermission(requestId: string, decision: PermissionDecision): void;
  /** Raw keystrokes into the terminal (interactive sessions only). */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Ends the session gracefully; resolves once the process is gone (an `exit` event follows). */
  close(): Promise<void>;
}

export interface AdapterHealth {
  ok: boolean;
  version: string | null;
  error: string | null;
}

export interface AgentAdapter {
  readonly kind: string;
  check(): Promise<AdapterHealth>;
  start(opts: SessionOptions, onEvent: (e: SessionEvent) => void): AgentSession;
}
