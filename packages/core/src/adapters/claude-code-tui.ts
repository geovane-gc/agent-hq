import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { AgentSession, PermissionDecision, SessionEvent, SessionOptions } from './adapter.ts';
import { describeToolUse } from './claude-code.ts';
import { cleanEnv } from './env.ts';

// Runs Claude Code's real interactive terminal UI in a pseudo-terminal, so
// the user can watch and type into each agent's session. Status comes from
// Claude Code hooks and its statusline (see hooks/hq-hook.ts); the raw
// terminal stream is relayed to whoever opens the agent's computer.

const HOOK_SCRIPT = path.resolve(import.meta.dirname, '../hooks/hq-hook.ts');
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'] as const;

type NodePty = typeof import('@lydell/node-pty');
type Pty = ReturnType<NodePty['spawn']>;

let nodePty: NodePty | null | undefined;

/** The optional native PTY module, or null when it can't load on this machine. */
export function loadNodePty(): NodePty | null {
  if (nodePty === undefined) {
    try { nodePty = createRequire(import.meta.url)('@lydell/node-pty') as NodePty; } catch { nodePty = null; }
  }
  return nodePty;
}

const ESC = String.fromCharCode(27);

/** Terminal output reduced to its visible characters, without whitespace, for prompt detection. */
function flatten(data: string): string {
  return data
    .split(ESC)
    .map((part, i) => (i === 0 ? part : part.replace(/^\[[0-9;?<>=]*[ -/]*[@-~]/, '').replace(/^\][^\x07]*(\x07)?/, '').replace(/^[()][0-9A-Za-z]/, '').replace(/^[=>78cDEHM]/, '')))
    .join('')
    .replace(/\s+/g, '');
}

interface StatusSnapshot {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

function lastAssistantText(transcriptPath: string | undefined): string | null {
  if (!transcriptPath) return null;
  try {
    const lines = readFileSync(transcriptPath, 'utf8').trimEnd().split('\n');
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 200); i--) {
      const entry = JSON.parse(lines[i]);
      if (entry.type !== 'assistant') continue;
      const text = (entry.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
      if (text) return text;
    }
  } catch {}
  return null;
}

export class ClaudeCodeTuiSession implements AgentSession {
  readonly interactive = true;
  private readonly pty: Pty;
  private readonly onEvent: (e: SessionEvent) => void;
  private exited = false;
  private readonly exitedPromise: Promise<void>;
  private resolveExited!: () => void;
  private trustAnswered = false;
  private recent = '';
  private lastTool: string | null = null;
  private busy = false;
  private last: StatusSnapshot = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  private current: StatusSnapshot = { costUsd: 0, inputTokens: 0, outputTokens: 0 };

  constructor(pty: NodePty, binary: string, opts: SessionOptions, onEvent: (e: SessionEvent) => void) {
    this.onEvent = onEvent;
    this.exitedPromise = new Promise((r) => { this.resolveExited = r; });

    const hookKey = opts.hooks!.register((event, input) => this.onHook(event, input));
    const hook = (event: string) => ({
      type: 'command',
      command: `"${process.execPath}" --no-warnings "${HOOK_SCRIPT}" ${opts.hooks!.url} ${hookKey} ${event}`,
      timeout: 5,
    });
    const settings = {
      hooks: Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [hook(e)] }]])),
      statusLine: { ...hook('status'), padding: 0 },
    };

    // The prompt goes first: options like --add-dir take several values and
    // would swallow a trailing positional argument.
    const args: string[] = [];
    if (opts.initialPrompt) args.push(opts.initialPrompt);
    args.push('--settings', JSON.stringify(settings), '--append-system-prompt', opts.systemPrompt, '--permission-mode', opts.permissionMode);
    if (opts.permissionMode === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions');
    if (opts.agentName) args.push('--agent', opts.agentName);
    if (opts.model) args.push('--model', opts.model);
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
    if (Object.keys(opts.mcpServers).length) args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));
    for (const dir of opts.addDirs) args.push('--add-dir', dir);

    this.pty = pty.spawn(binary, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 34,
      cwd: opts.cwd,
      env: cleanEnv({ COLORTERM: 'truecolor', FORCE_COLOR: '3' }),
    });
    this.pty.onData((data) => this.onOutput(data));
    this.pty.onExit(({ exitCode }) => {
      if (this.exited) return;
      this.exited = true;
      this.resolveExited();
      this.onEvent({ type: 'exit', code: exitCode, error: exitCode ? `Claude Code exited with code ${exitCode}` : null });
    });
  }

  private onOutput(data: string) {
    this.onEvent({ type: 'pty', data });
    this.recent = (this.recent + flatten(data)).slice(-4000);
    // New worktrees are unknown to Claude Code, which asks whether to trust
    // them. Agent HQ created the folder from a repository you chose, so pick
    // "Yes, I trust this folder" (the second option) on your behalf.
    if (!this.trustAnswered && this.recent.includes('Yes,Itrustthisfolder')) {
      this.trustAnswered = true;
      this.recent = '';
      this.onEvent({ type: 'transcript', kind: 'system', text: 'Trusted the workspace folder for Claude Code.' });
      setTimeout(() => { this.pty.write(`${ESC}[B`); setTimeout(() => this.pty.write('\r'), 250); }, 400);
    }
    // Esc interrupts a turn without running the Stop hook; notice it from the screen.
    if (this.busy && this.recent.includes('Interruptedbyuser')) {
      this.recent = '';
      this.busy = false;
      this.onEvent({ type: 'turn_end', ok: false, interrupted: true, error: null, usage: this.usageDelta() });
    }
  }

  private usageDelta() {
    const d = {
      inputTokens: Math.max(0, this.current.inputTokens - this.last.inputTokens),
      outputTokens: Math.max(0, this.current.outputTokens - this.last.outputTokens),
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: Math.max(0, this.current.costUsd - this.last.costUsd),
    };
    this.last = { ...this.current };
    return d;
  }

  private onHook(event: string, input: any) {
    switch (event) {
      case 'SessionStart':
        if (input.session_id) this.onEvent({ type: 'session', sessionId: input.session_id, interactive: true });
        return;
      case 'UserPromptSubmit':
        this.busy = true;
        this.recent = '';
        this.onEvent({ type: 'turn_start', prompt: String(input.prompt ?? '') });
        return;
      case 'PreToolUse': {
        const summary = describeToolUse(String(input.tool_name), input.tool_input ?? {});
        this.lastTool = String(input.tool_name);
        this.onEvent({ type: 'activity', activity: summary });
        this.onEvent({ type: 'transcript', kind: 'tool_use', text: summary, meta: { tool: input.tool_name, input: input.tool_input } });
        return;
      }
      case 'PostToolUse':
        this.onEvent({ type: 'resumed' });
        return;
      case 'Notification':
        if (input.notification_type === 'permission_prompt' || /permission/i.test(String(input.message ?? ''))) {
          this.onEvent({ type: 'waiting', reason: this.lastTool ? `Permission to use ${this.lastTool}` : 'Waiting for permission' });
        }
        return;
      case 'Stop': {
        this.busy = false;
        // The transcript file may not have the final message yet; newer CLIs pass it in the payload.
        const text = (typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim()) || lastAssistantText(input.transcript_path);
        if (text) this.onEvent({ type: 'transcript', kind: 'text', text });
        // Give the statusline a moment to report the final cost of the turn.
        setTimeout(() => this.onEvent({ type: 'turn_end', ok: true, interrupted: false, error: null, usage: this.usageDelta() }), 300);
        return;
      }
      case 'status': {
        const cw = input.context_window ?? {};
        this.current = {
          costUsd: Number(input.cost?.total_cost_usd ?? this.current.costUsd),
          inputTokens: Number(cw.total_input_tokens ?? this.current.inputTokens),
          outputTokens: Number(cw.total_output_tokens ?? this.current.outputTokens),
        };
        const rl = input.rate_limits;
        if (rl) {
          const win = (w: any) => (w ? { utilization: Number(w.used_percentage) / 100, resetsAt: Number(w.resets_at) * 1000 } : null);
          this.onEvent({ type: 'rate_limits', rateLimits: { fiveHour: win(rl.five_hour), sevenDay: win(rl.seven_day), updatedAt: Date.now() } });
        }
        return;
      }
    }
  }

  send(text: string) {
    // Bracketed paste keeps multi-line text together; Enter submits it.
    const body = text.includes('\n') ? `${ESC}[200~${text}${ESC}[201~` : text;
    this.pty.write(body);
    setTimeout(() => this.pty.write('\r'), 150);
  }

  interrupt() {
    this.pty.write(ESC);
  }

  respondPermission(_requestId: string, decision: PermissionDecision) {
    // The terminal's permission prompt has "Yes" preselected; Esc cancels.
    this.pty.write(decision.allow ? '\r' : ESC);
  }

  write(data: string) {
    if (!this.exited) this.pty.write(data);
  }

  resize(cols: number, rows: number) {
    if (!this.exited && cols > 10 && rows > 4) this.pty.resize(Math.floor(cols), Math.floor(rows));
  }

  close(): Promise<void> {
    if (!this.exited) {
      try { this.pty.kill(); } catch {}
      setTimeout(() => {
        if (this.exited) return;
        this.exited = true;
        this.resolveExited();
        this.onEvent({ type: 'exit', code: null, error: null });
      }, 3000).unref();
    }
    return this.exitedPromise;
  }
}
