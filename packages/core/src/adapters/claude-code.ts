import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { ClaudeCodeTuiSession, loadNodePty } from './claude-code-tui.ts';
import { cleanEnv } from './env.ts';
import type {
  AdapterHealth,
  AgentAdapter,
  AgentSession,
  PermissionDecision,
  SessionEvent,
  SessionOptions,
} from './adapter.ts';

// Drives the user's own `claude` CLI in headless stream-json mode. Agent HQ
// never handles Claude credentials: each user logs in to Claude Code
// themselves, and we only spawn the binary they installed.

/** Finds the native Claude Code binary without going through a shell. */
export function resolveClaudeBinary(): string {
  const override = process.env.AGENT_HQ_CLAUDE_PATH;
  if (override) return override;

  const win = process.platform === 'win32';
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local'));

  for (const dir of dirs) {
    if (win) {
      const exe = path.join(dir, 'claude.exe');
      if (existsSync(exe)) return exe;
      // npm's global install puts a .cmd shim next to the package; Node can't
      // spawn .cmd files without a shell, so use the binary it points at.
      if (existsSync(path.join(dir, 'claude.cmd'))) {
        const native = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
        if (existsSync(native)) return native;
      }
    } else {
      const bin = path.join(dir, 'claude');
      if (existsSync(bin)) return bin;
    }
  }
  throw new Error('Claude Code not found. Install it (https://claude.com/claude-code) or set AGENT_HQ_CLAUDE_PATH.');
}

const MAX_TOOL_RESULT = 4000;

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s;
}

/** A one-line, human-readable summary of a tool call, used for avatar activity. */
export function describeToolUse(name: string, input: Record<string, unknown>): string {
  const file = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
  const base = file ? path.basename(file) : undefined;
  switch (name) {
    case 'Read': return `Reading ${base ?? 'a file'}`;
    case 'Write': return `Writing ${base ?? 'a file'}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return `Editing ${base ?? 'a file'}`;
    case 'Bash':
    case 'PowerShell': return `Running ${truncate(String(input.description ?? input.command ?? 'a command'), 80)}`;
    case 'Grep':
    case 'Glob': return `Searching for ${truncate(String(input.pattern ?? ''), 60)}`;
    case 'WebFetch':
    case 'WebSearch': return 'Browsing the web';
    case 'Task':
    case 'Agent': return `Delegating: ${truncate(String(input.description ?? 'subtask'), 60)}`;
    default: return name.startsWith('mcp__') ? `Using ${name.split('__').slice(1).join(' / ')}` : `Using ${name}`;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '[non-text content]'))
      .join('\n');
  }
  return '';
}

type Json = Record<string, any>;

/** Headless fallback: stream-json over pipes, used when no PTY is available. */
class ClaudeCodeSession implements AgentSession {
  readonly interactive = false;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly onEvent: (e: SessionEvent) => void;
  private readonly pending = new Map<string, Json>();
  private lastCost = 0;
  private interrupted = false;
  private exited = false;
  private readonly exitedPromise: Promise<void>;
  private resolveExited!: () => void;

  constructor(binary: string, opts: SessionOptions, onEvent: (e: SessionEvent) => void) {
    this.onEvent = onEvent;
    this.exitedPromise = new Promise((r) => { this.resolveExited = r; });
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', opts.permissionMode,
      '--append-system-prompt', opts.systemPrompt,
    ];
    if (opts.permissionMode === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions');
    if (opts.model) args.push('--model', opts.model);
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
    for (const dir of opts.addDirs) args.push('--add-dir', dir);
    if (Object.keys(opts.mcpServers).length) args.push('--mcp-config', JSON.stringify({ mcpServers: opts.mcpServers }));

    this.child = spawn(binary, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: cleanEnv(opts.configDir ? { CLAUDE_CONFIG_DIR: opts.configDir } : {}) });

    let stderr = '';
    this.child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    this.child.on('error', (err) => this.finish(null, err.message));
    this.child.on('exit', (code) => this.finish(code, code ? stderr.trim() || `exited with code ${code}` : null));

    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      if (!line.trim()) return;
      let msg: Json;
      try { msg = JSON.parse(line); } catch { return; }
      try { this.handle(msg); } catch (err) {
        this.onEvent({ type: 'transcript', kind: 'error', text: `Adapter error: ${(err as Error).message}` });
      }
    });
  }

  private finish(code: number | null, error: string | null) {
    if (this.exited) return;
    this.exited = true;
    this.resolveExited();
    this.onEvent({ type: 'exit', code, error });
  }

  private writeJson(obj: unknown) {
    if (!this.exited && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private handle(msg: Json) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init' && msg.session_id) this.onEvent({ type: 'session', sessionId: msg.session_id, interactive: false });
        else if (msg.subtype === 'compact_boundary') this.onEvent({ type: 'transcript', kind: 'system', text: 'Context compacted.' });
        return;

      case 'assistant': {
        const sub = msg.parent_tool_use_id ? { subagent: true } : {};
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) {
            this.onEvent({ type: 'transcript', kind: 'text', text: block.text, meta: sub });
          } else if (block.type === 'thinking' && block.thinking?.trim()) {
            this.onEvent({ type: 'transcript', kind: 'thinking', text: block.thinking, meta: sub });
          } else if (block.type === 'tool_use') {
            const summary = describeToolUse(block.name, block.input ?? {});
            this.onEvent({ type: 'activity', activity: summary });
            this.onEvent({
              type: 'transcript', kind: 'tool_use', text: summary,
              meta: { ...sub, tool: block.name, toolUseId: block.id, input: block.input },
            });
          }
        }
        return;
      }

      case 'user': {
        const content = msg.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          this.onEvent({
            type: 'transcript', kind: 'tool_result',
            text: truncate(toolResultText(block.content), MAX_TOOL_RESULT),
            meta: { toolUseId: block.tool_use_id, isError: !!block.is_error, subagent: !!msg.parent_tool_use_id },
          });
        }
        return;
      }

      case 'control_request': {
        const req = msg.request ?? {};
        if (req.subtype === 'can_use_tool') {
          this.pending.set(msg.request_id, req);
          this.onEvent({
            type: 'permission_request',
            requestId: msg.request_id,
            toolName: req.display_name ?? req.tool_name,
            input: req.input,
            description: req.description ?? null,
            canAlwaysAllow: Array.isArray(req.permission_suggestions) && req.permission_suggestions.length > 0,
          });
        } else {
          // We don't register hooks or SDK MCP servers, so nothing else should
          // arrive; answer anyway so the CLI never blocks waiting for us.
          this.writeJson({
            type: 'control_response',
            response: { subtype: 'error', request_id: msg.request_id, error: `Unsupported request: ${req.subtype}` },
          });
        }
        return;
      }

      case 'rate_limit_event': {
        const w = msg.rate_limit_info?.unifiedWindows ?? {};
        const win = (x: Json | undefined) =>
          x ? { utilization: Number(x.utilization), resetsAt: Number(x.resetsAt) * 1000 } : null;
        this.onEvent({
          type: 'rate_limits',
          rateLimits: { fiveHour: win(w.five_hour), sevenDay: win(w.seven_day), updatedAt: Date.now() },
        });
        return;
      }

      case 'result': {
        // total_cost_usd is cumulative for the process; report per-turn deltas.
        const cost = Number(msg.total_cost_usd ?? 0);
        const costDelta = Math.max(0, cost - this.lastCost);
        this.lastCost = cost;
        const u = msg.usage ?? {};
        const interrupted = this.interrupted;
        this.interrupted = false;
        const ok = msg.subtype === 'success' && !msg.is_error;
        this.onEvent({
          type: 'turn_end',
          ok,
          interrupted,
          error: ok || interrupted ? null : String(msg.result ?? msg.subtype),
          usage: {
            inputTokens: Number(u.input_tokens ?? 0),
            outputTokens: Number(u.output_tokens ?? 0),
            cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
            cacheCreationTokens: Number(u.cache_creation_input_tokens ?? 0),
            costUsd: costDelta,
          },
        });
        return;
      }
    }
  }

  send(text: string) {
    this.onEvent({ type: 'turn_start', prompt: text });
    this.writeJson({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  }

  write(_data: string) {}

  resize(_cols: number, _rows: number) {}

  interrupt() {
    this.interrupted = true;
    this.writeJson({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
  }

  respondPermission(requestId: string, decision: PermissionDecision) {
    const req = this.pending.get(requestId);
    if (!req) return;
    this.pending.delete(requestId);
    const response = decision.allow
      ? {
          behavior: 'allow',
          updatedInput: req.input,
          ...(decision.always && req.permission_suggestions ? { updatedPermissions: req.permission_suggestions } : {}),
        }
      : { behavior: 'deny', message: decision.message || 'The user denied this action.' };
    this.writeJson({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  close(): Promise<void> {
    if (!this.exited) {
      this.child.stdin.end();
      // Give the CLI a moment to flush and exit on its own.
      setTimeout(() => { if (!this.exited) this.child.kill(); }, 5000).unref();
    }
    return this.exitedPromise;
  }
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly kind = 'claude-code';
  private binary: string | null = null;

  private resolve(): string {
    this.binary ??= resolveClaudeBinary();
    return this.binary;
  }

  check(): Promise<AdapterHealth> {
    return new Promise((resolve) => {
      let bin: string;
      try { bin = this.resolve(); } catch (err) {
        resolve({ ok: false, version: null, error: (err as Error).message });
        return;
      }
      execFile(bin, ['--version'], { timeout: 15000, windowsHide: true }, (err, stdout) => {
        if (err) resolve({ ok: false, version: null, error: err.message });
        else resolve({ ok: true, version: stdout.trim(), error: null });
      });
    });
  }

  /** Interactive terminal sessions need the optional PTY module; otherwise fall back to headless. */
  get interactive(): boolean {
    return loadNodePty() !== null;
  }

  start(opts: SessionOptions, onEvent: (e: SessionEvent) => void): AgentSession {
    const pty = loadNodePty();
    if (pty && opts.hooks) return new ClaudeCodeTuiSession(pty, this.resolve(), opts, onEvent);
    const session = new ClaudeCodeSession(this.resolve(), opts, onEvent);
    if (opts.initialPrompt) session.send(opts.initialPrompt);
    return session;
  }
}
