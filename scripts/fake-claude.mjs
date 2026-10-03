#!/usr/bin/env node
// A fake `claude` CLI for testing Agent HQ in isolation: no network, no real
// login, no subscription, Node built-ins only. Point Agent HQ at it with
//
//   AGENT_HQ_CLAUDE_PATH=/path/to/agent-hq/scripts/fake-claude.mjs
//
// (Agent HQ runs `.mjs`/`.js` paths with Node, so this also works on Windows.)
// It covers every way the core drives the CLI:
//
//   claude --version | --help
//   claude auth status [--json]       logged in = a marker file in the config dir
//   claude auth login                 short interactive flow (PTY or pipes), writes the marker
//   claude auth logout                removes the marker
//   claude [prompt] [options]         the interactive TUI: trust dialog, prompt box, canned
//                                     answers, permission prompts, hooks and statusline
//   claude -p --input-format stream-json --output-format stream-json ...
//                                     the headless protocol: init, assistant, tool results,
//                                     can_use_tool control requests, interrupts, results
//
// It never reads or writes ~/.claude: without CLAUDE_CONFIG_DIR its "default
// login" lives in FAKE_CLAUDE_DEFAULT_DIR (default: <tmp>/fake-claude-default).
//
// Knobs (environment):
//   FAKE_CLAUDE_LOG            append one JSON line per action to this file
//   FAKE_CLAUDE_EMAIL          email after login (default fake-{dir}@example.com; {dir} = config dir name)
//   FAKE_CLAUDE_PLAN           max (default) | pro | team | enterprise | api (Console account)
//   FAKE_CLAUDE_REPLY          answer template; {prompt} {agent} {model} {turn} {tool} {result} {cwd}
//   FAKE_CLAUDE_DELAY          ms of "thinking" per turn (default 300)
//   FAKE_CLAUDE_TOOL           use this tool on every turn (Bash, Read, Write, Edit, mcp__<server>__<tool>…)
//   FAKE_CLAUDE_TOOL_INPUT     JSON input for that tool
//   FAKE_CLAUDE_PERMISSIONS    ask (default: follow --permission-mode) | allow | deny
//   FAKE_CLAUDE_TRUST          ask (default: trust dialog for unknown folders) | yes
//   FAKE_CLAUDE_MCP            connect to stdio MCP servers from --mcp-config: off (default) | all | name,name
//   FAKE_CLAUDE_REQUIRE_LOGIN  1: sessions answer "Not logged in" while the config dir is logged out
//   FAKE_CLAUDE_LOGIN          interactive (default) | auto (`auth login` completes on its own)
//   FAKE_CLAUDE_STRICT         1 (default): unknown options fail like the real CLI; 0: ignore them
//   FAKE_CLAUDE_VERSION        what --version prints (default "2.1.0 (Claude Code)")
//   FAKE_CLAUDE_DEFAULT_DIR    config dir used when CLAUDE_CONFIG_DIR is unset
//
// Per-prompt directives (anywhere in a prompt): fake:tool=<Tool>, fake:slow=<ms>, fake:exit=<code>.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const env = process.env;
const VERSION = env.FAKE_CLAUDE_VERSION || '2.1.0 (Claude Code)';
const ESC = '\x1b';
const MARKER = '.fake-claude-auth.json';
const PERMISSION_MODES = ['default', 'manual', 'acceptEdits', 'auto', 'plan', 'bypassPermissions', 'dontAsk'];
const SAFE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoWrite']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// ------------------------------------------------------------------ helpers

function log(action, data = {}) {
  if (!env.FAKE_CLAUDE_LOG) return;
  try {
    appendFileSync(env.FAKE_CLAUDE_LOG, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, action, ...data })}\n`);
  } catch {}
}

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** The config dir this process works in. Never the real ~/.claude. */
function configDir() {
  return path.resolve(env.CLAUDE_CONFIG_DIR || env.FAKE_CLAUDE_DEFAULT_DIR || path.join(os.tmpdir(), 'fake-claude-default'));
}

function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readAuth(dir = configDir()) {
  return readJson(path.join(dir, MARKER));
}

function defaultEmail(dir = configDir()) {
  return (env.FAKE_CLAUDE_EMAIL || 'fake-{dir}@example.com').replaceAll('{dir}', path.basename(dir).replace(/^\./, '') || 'claude');
}

/** Claude Code keeps transcripts in <config>/projects/<cwd with non-alphanumerics as dashes>/<session>.jsonl. */
const projectDir = (cwd) => path.join(configDir(), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

function findTranscript(sessionId, cwd) {
  const own = path.join(projectDir(cwd), `${sessionId}.jsonl`);
  if (existsSync(own)) return own;
  const root = path.join(configDir(), 'projects');
  if (!existsSync(root)) return null;
  for (const sub of readdirSync(root)) {
    const file = path.join(root, sub, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

function latestTranscript(cwd) {
  const dir = projectDir(cwd);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

const oneLine = (s, n) => {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** A stable id derived from text, for deterministic tool-use ids and such. */
const stableId = (prefix, ...parts) => `${prefix}${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24)}`;

// ------------------------------------------------------------------ arguments

// Options the real CLI takes: 0 = flag, 1 = one value, '?' = optional value, '*' = variadic
// (like commander's `<values...>`, it swallows every following non-option argument).
const OPTIONS = {
  '-p': 0, '--print': 0, '--verbose': 0, '--debug': '?', '-d': '?', '--continue': 0, '-c': 0, '--fork-session': 0,
  '--allow-dangerously-skip-permissions': 0, '--dangerously-skip-permissions': 0, '--include-partial-messages': 0,
  '--strict-mcp-config': 0, '--ide': 0, '--replay-user-messages': 0,
  '--settings': 1, '--append-system-prompt': 1, '--system-prompt': 1, '--permission-mode': 1, '--agent': 1,
  '--model': 1, '--fallback-model': 1, '--session-id': 1, '--input-format': 1, '--output-format': 1,
  '--permission-prompt-tool': 1, '--max-turns': 1, '--agents': 1, '--setting-sources': 1,
  '--resume': '?', '-r': '?',
  '--mcp-config': '*', '--add-dir': '*', '--allowedTools': '*', '--allowed-tools': '*', '--disallowedTools': '*', '--disallowed-tools': '*',
};
const ALIASES = { '-p': '--print', '-c': '--continue', '-r': '--resume', '-d': '--debug', '--allowed-tools': '--allowedTools', '--disallowed-tools': '--disallowedTools' };

function parseArgs(argv) {
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline;
    if (arg.startsWith('--') && arg.includes('=')) [arg, inline] = [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)];
    if (!arg.startsWith('-') || arg === '-') { positionals.push(arg); continue; }
    const kind = OPTIONS[arg];
    const name = ALIASES[arg] ?? arg;
    if (kind === undefined) {
      if (env.FAKE_CLAUDE_STRICT === '0') continue;
      fail(`error: unknown option '${arg}'`);
    }
    const isValue = (v) => v !== undefined && !v.startsWith('-');
    if (kind === 0) opts[name] = true;
    else if (kind === 1) {
      const v = inline ?? argv[++i];
      if (v === undefined) fail(`error: option '${arg} <value>' argument missing`);
      opts[name] = v;
    } else if (kind === '?') {
      opts[name] = inline ?? (isValue(argv[i + 1]) ? argv[++i] : true);
    } else {
      const values = inline !== undefined ? [inline] : [];
      while (isValue(argv[i + 1])) values.push(argv[++i]);
      opts[name] = [...(opts[name] ?? []), ...values];
    }
  }
  return { opts, positionals };
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  log('error', { message });
  process.exit(code);
}

/** --settings / --mcp-config take inline JSON or a file path. */
function jsonArg(value, what) {
  const text = value.trim().startsWith('{') ? value : (() => {
    try { return readFileSync(path.resolve(value), 'utf8'); } catch { fail(`Error: ${what} file not found: ${value}`); }
  })();
  try { return JSON.parse(text); } catch (err) { fail(`Error: Invalid ${what}: ${err.message}`); }
}

// ------------------------------------------------------------------ terminal input

/**
 * Turns raw terminal input into keys. In a TTY we run in raw mode and echo
 * ourselves; on pipes every line ends with an Enter key.
 */
function keyReader(onKey) {
  const tty = !!process.stdin.isTTY;
  if (tty) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  let pasting = null;
  process.stdin.on('data', (chunk) => {
    let i = 0;
    while (i < chunk.length) {
      if (pasting !== null) {
        const end = chunk.indexOf(`${ESC}[201~`, i);
        if (end < 0) { pasting += chunk.slice(i); return; }
        pasting += chunk.slice(i, end);
        onKey({ name: 'paste', text: pasting });
        pasting = null;
        i = end + 6;
        continue;
      }
      const ch = chunk[i];
      if (ch === ESC) {
        if (chunk.startsWith(`${ESC}[200~`, i)) { pasting = ''; i += 6; continue; }
        const csi = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O[A-Za-z])/.exec(chunk.slice(i));
        if (csi) {
          const final = csi[0].at(-1);
          onKey({ name: { A: 'up', B: 'down', C: 'right', D: 'left' }[final] ?? 'unknown' });
          i += csi[0].length;
          continue;
        }
        onKey({ name: 'escape' });
        i += 1;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        onKey({ name: 'enter' });
        if (ch === '\r' && chunk[i + 1] === '\n') i++;
      } else if (ch === '\x7f' || ch === '\b') onKey({ name: 'backspace' });
      else if (ch === '\x03') onKey({ name: 'ctrl-c' });
      else if (ch === '\x04') onKey({ name: 'ctrl-d' });
      else if (ch >= ' ') onKey({ name: 'char', text: ch });
      i += 1;
    }
  });
  process.stdin.on('end', () => onKey({ name: 'eof' }));
  return { tty };
}

const out = (s) => { try { process.stdout.write(s.replace(/\r?\n/g, '\r\n')); } catch {} };
process.stdout.on('error', () => {});
const dim = (s) => `${ESC}[2m${s}${ESC}[22m`;
const bold = (s) => `${ESC}[1m${s}${ESC}[22m`;
const orange = (s) => `${ESC}[38;2;215;119;87m${s}${ESC}[39m`;

/** A numbered menu like the CLI's selects: arrows move, Enter picks, a digit picks, Esc cancels. */
function menu(title, options, { cancel = null } = {}) {
  let selected = 0;
  const draw = (first) => {
    if (!first) out(`${ESC}[${options.length}A`);
    options.forEach((o, i) => out(`${ESC}[2K${i === selected ? orange('❯') : ' '} ${i + 1}. ${o}\n`));
  };
  out(`${title}\n`);
  draw(true);
  return (key) => {
    if (key.name === 'up' || key.name === 'down') {
      selected = (selected + (key.name === 'up' ? options.length - 1 : 1)) % options.length;
      draw(false);
      return undefined;
    }
    if (key.name === 'enter') return selected;
    if (key.name === 'char' && /[1-9]/.test(key.text) && Number(key.text) <= options.length) return Number(key.text) - 1;
    if (key.name === 'escape' && cancel !== null) return cancel;
    return undefined;
  };
}

// ------------------------------------------------------------------ auth

function authStatus(args) {
  const dir = configDir();
  const auth = readAuth(dir);
  const loggedIn = !!auth;
  const status = loggedIn
    ? {
        loggedIn: true,
        authMethod: auth.plan === 'api' ? 'console' : 'claude.ai',
        apiProvider: 'firstParty',
        email: auth.email,
        orgId: stableId('org-', auth.email),
        orgName: `${auth.email}'s Organization`,
        subscriptionType: auth.plan === 'api' ? null : auth.plan,
        configDirectory: dir,
      }
    : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', configDirectory: dir };
  log('auth_status', { configDir: dir, loggedIn, email: auth?.email ?? null });
  if (args.includes('--json')) out(`${JSON.stringify(status, null, 2)}\n`);
  else out(loggedIn ? `Logged in as ${auth.email} (${auth.plan})\nConfig: ${dir}\n` : `Not logged in. Run claude auth login.\nConfig: ${dir}\n`);
  // Like the real CLI: exit 1 when logged out, still printing the status.
  process.exit(loggedIn ? 0 : 1);
}

function authLogin() {
  const dir = configDir();
  log('auth_login_start', { configDir: dir });
  let plan = (env.FAKE_CLAUDE_PLAN || 'max').toLowerCase();
  let step = 'method';
  let code = '';
  let pick = null;
  const state = createHash('sha256').update(dir).digest('hex').slice(0, 16);

  const finish = (email) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, MARKER), `${JSON.stringify({ email, plan, loggedInAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    log('auth_login', { configDir: dir, email, plan });
    out(`\n${orange('✔')} Login successful. Logged in as ${bold(email)}\n`);
    setTimeout(() => process.exit(0), 50);
  };
  const askCode = () => {
    step = 'code';
    out(`\nOpening browser to sign in…\n`);
    out(`Browser didn't open? Use the url below to sign in (fake, nothing to open):\n\n`);
    out(`  https://claude.ai/oauth/authorize?code=true&client_id=fake-claude&state=${state}\n\n`);
    out(dim('Type any code (or an email address to log in as it); "fail" simulates an invalid code.\n'));
    out('Paste code here if prompted > ');
    if (env.FAKE_CLAUDE_LOGIN === 'auto') setTimeout(() => finish(defaultEmail(dir)), 300);
  };

  out(`${orange('✻')} Welcome to Claude Code ${dim('(fake)')}\n\n`);
  if (env.FAKE_CLAUDE_LOGIN === 'auto') { askCode(); return; }
  pick = menu(' Select login method:\n', [
    'Claude account with subscription · Pro, Max, Team, or Enterprise',
    'Anthropic Console account · API usage billing',
  ]);
  const { tty } = keyReader((key) => {
    if (key.name === 'ctrl-c') { log('auth_login_cancelled', { configDir: dir }); out('\n'); process.exit(130); }
    if (key.name === 'eof') {
      // Nobody will type (e.g. `claude auth login < /dev/null`): complete as if a code was pasted.
      if (step !== 'done') { step = 'done'; finish(defaultEmail(dir)); }
      return;
    }
    if (step === 'method') {
      const choice = pick(key);
      if (choice === undefined) return;
      if (choice === 1) plan = 'api';
      askCode();
      return;
    }
    if (step !== 'code') return;
    if (key.name === 'char' || key.name === 'paste') {
      code += key.text;
      if (tty) out(key.name === 'paste' ? key.text.replace(/\s+/g, '') : key.text);
    } else if (key.name === 'backspace' && code) {
      code = code.slice(0, -1);
      if (tty) out('\b \b');
    } else if (key.name === 'enter') {
      const value = code.trim();
      code = '';
      if (!value) return; // the real prompt waits for a code too
      step = 'done';
      out('\n');
      if (value === 'fail') {
        log('auth_login_failed', { configDir: dir });
        out('OAuth error: Invalid code. Please make sure the full code was copied\n');
        setTimeout(() => process.exit(1), 50);
        return;
      }
      out(dim('Logging in…\n'));
      setTimeout(() => finish(value.includes('@') ? value : defaultEmail(dir)), 200);
    }
  });
}

function authLogout() {
  const dir = configDir();
  const marker = path.join(dir, MARKER);
  const was = readAuth(dir);
  rmSync(marker, { force: true });
  log('auth_logout', { configDir: dir, wasLoggedIn: !!was, email: was?.email ?? null });
  out(was ? `Successfully logged out from your Anthropic account.\n` : 'Not logged in.\n');
  process.exit(0);
}

// ------------------------------------------------------------------ MCP (stdio client)

class McpClient {
  constructor(name, config, cwd) {
    this.name = name;
    this.tools = [];
    this.pending = new Map();
    this.nextId = 1;
    this.child = spawn(config.command, config.args ?? [], {
      cwd, env: { ...env, ...(config.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child.on('error', (err) => { for (const p of this.pending.values()) p.reject(err); this.pending.clear(); });
    this.child.stderr.on('data', () => {});
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'MCP error'));
      else p.resolve(msg.result);
    });
  }

  request(method, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async connect() {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: VERSION } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const { tools } = await this.request('tools/list', {});
    this.tools = (tools ?? []).map((t) => t.name);
    return this.tools;
  }

  close() {
    try { this.child.kill(); } catch {}
  }
}

// ------------------------------------------------------------------ the agent ("model")

/**
 * Everything a session shares between the TUI and headless modes: options,
 * transcript, usage, tools, MCP servers.
 */
class Brain {
  constructor(opts, cwd) {
    this.opts = opts;
    this.cwd = cwd;
    this.model = opts['--model'] || 'claude-sonnet-4-5';
    this.permissionMode = opts['--permission-mode'] || 'default';
    if (!PERMISSION_MODES.includes(this.permissionMode)) {
      fail(`error: option '--permission-mode <mode>' argument '${this.permissionMode}' is invalid. Allowed choices are ${PERMISSION_MODES.join(', ')}.`);
    }
    if (opts['--dangerously-skip-permissions']) this.permissionMode = 'bypassPermissions';
    this.agent = opts['--agent'] || null;
    this.allowed = new Set(opts['--allowedTools'] ?? []);
    this.turn = 0;
    this.usage = { cost: 0, input: 0, output: 0 };
    this.mcp = new Map();
    this.mcpServers = {};
    for (const value of opts['--mcp-config'] ?? []) Object.assign(this.mcpServers, jsonArg(value, 'MCP config').mcpServers ?? {});

    // Session: new, --session-id, --resume <id>, --resume (latest) or --continue.
    const resume = opts['--resume'];
    let previous = null;
    if (typeof resume === 'string') {
      previous = findTranscript(resume, cwd);
      if (!previous) fail(`No conversation found with session ID: ${resume}`);
    } else if (resume === true || opts['--continue']) {
      previous = latestTranscript(cwd);
      if (!previous) fail('No conversation found to continue');
    }
    this.history = previous ? readFileSync(previous, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    this.resumed = !!previous;
    this.sessionId = previous && !opts['--fork-session'] ? path.basename(previous, '.jsonl') : opts['--session-id'] || randomUUID();
    this.transcriptPath = path.join(projectDir(cwd), `${this.sessionId}.jsonl`);
    if (previous && previous !== this.transcriptPath) {
      mkdirSync(path.dirname(this.transcriptPath), { recursive: true });
      writeFileSync(this.transcriptPath, readFileSync(previous));
    }
    this.turn = this.history.filter((e) => e.type === 'user' && typeof e.message?.content === 'string').length;
    this.lastUuid = this.history.at(-1)?.uuid ?? null;
  }

  async connectMcp() {
    const want = (env.FAKE_CLAUDE_MCP || 'off').trim();
    const names = Object.keys(this.mcpServers);
    if (want === 'off' || want === '0' || !names.length) return;
    const list = want === 'all' || want === '1' ? names : want.split(',').map((s) => s.trim());
    await Promise.all(names.filter((n) => list.includes(n)).map(async (name) => {
      const config = this.mcpServers[name];
      if (!config.command) { log('mcp', { server: name, ok: false, error: 'only stdio servers are supported by the fake' }); return; }
      const client = new McpClient(name, config, this.cwd);
      try {
        const tools = await client.connect();
        this.mcp.set(name, client);
        log('mcp', { server: name, ok: true, tools });
      } catch (err) {
        client.close();
        log('mcp', { server: name, ok: false, error: err.message });
      }
    }));
  }

  get loggedIn() {
    return !!readAuth();
  }

  record(entry) {
    const uuid = randomUUID();
    const line = {
      parentUuid: this.lastUuid, isSidechain: false, userType: 'external', cwd: this.cwd, sessionId: this.sessionId,
      version: VERSION.split(' ')[0], type: entry.type, message: entry.message, uuid, timestamp: new Date().toISOString(),
    };
    this.lastUuid = uuid;
    try {
      mkdirSync(path.dirname(this.transcriptPath), { recursive: true });
      appendFileSync(this.transcriptPath, `${JSON.stringify(line)}\n`);
    } catch {}
  }

  /** Which tool (if any) to use this turn, and directives from the prompt. */
  plan(prompt) {
    const directives = {};
    for (const m of prompt.matchAll(/fake:(\w+)(?:=([^\s]+))?/g)) directives[m[1]] = m[2] ?? true;
    const tool = typeof directives.tool === 'string' ? directives.tool : env.FAKE_CLAUDE_TOOL || null;
    return { tool, delay: Number(directives.slow ?? env.FAKE_CLAUDE_DELAY ?? 300), exit: directives.exit, directives };
  }

  toolInput(tool) {
    if (env.FAKE_CLAUDE_TOOL_INPUT) {
      try { return JSON.parse(env.FAKE_CLAUDE_TOOL_INPUT); } catch {}
    }
    switch (tool) {
      case 'Bash': return { command: 'echo "hello from fake claude"', description: 'Say hello' };
      case 'Read': return { file_path: path.join(this.cwd, 'README.md') };
      case 'Write': return { file_path: path.join(this.cwd, 'FAKE_CLAUDE.md'), content: `Written by fake Claude Code (turn ${this.turn}).\n` };
      case 'Edit': return { file_path: path.join(this.cwd, 'FAKE_CLAUDE.md'), old_string: 'fake', new_string: 'fake (edited)' };
      case 'Grep':
      case 'Glob': return { pattern: '*.md' };
      default: return {};
    }
  }

  /** "allow", "deny" or "ask", as the CLI decides before prompting. */
  permissionFor(tool) {
    const forced = env.FAKE_CLAUDE_PERMISSIONS;
    if (forced === 'allow' || forced === 'deny') return forced;
    if (this.allowed.has(tool)) return 'allow';
    if (SAFE_TOOLS.has(tool)) return 'allow';
    switch (this.permissionMode) {
      case 'bypassPermissions':
      case 'auto': return 'allow';
      case 'dontAsk': return 'deny';
      case 'acceptEdits': return EDIT_TOOLS.has(tool) ? 'allow' : 'ask';
      default: return 'ask';
    }
  }

  /** Runs the tool. Nothing real happens except Write/Edit on FAKE_CLAUDE.md and MCP calls. */
  async runTool(tool, input) {
    try {
      if (tool.startsWith('mcp__')) {
        const [, server, name] = tool.split('__');
        const client = this.mcp.get(server);
        if (!client) return { ok: false, text: `MCP server "${server}" is not connected (set FAKE_CLAUDE_MCP=${server})` };
        const result = await client.request('tools/call', { name, arguments: input });
        const text = (result?.content ?? []).map((c) => c.text ?? '').join('\n');
        return { ok: !result?.isError, text };
      }
      switch (tool) {
        case 'Bash': return { ok: true, text: `hello from fake claude\n(fake: "${input.command}" was not really run)` };
        case 'Read': {
          const file = String(input.file_path ?? '');
          if (!existsSync(file)) return { ok: false, text: `File does not exist: ${file}` };
          return { ok: true, text: readFileSync(file, 'utf8').split('\n').slice(0, 20).join('\n') };
        }
        case 'Write':
          writeFileSync(String(input.file_path), String(input.content ?? ''));
          return { ok: true, text: `File created successfully at: ${input.file_path}` };
        case 'Edit': {
          const file = String(input.file_path);
          if (!existsSync(file)) return { ok: false, text: `File does not exist: ${file}` };
          writeFileSync(file, readFileSync(file, 'utf8').replace(String(input.old_string), String(input.new_string)));
          return { ok: true, text: `The file ${file} has been updated.` };
        }
        default: return { ok: true, text: `(fake) ${tool} done` };
      }
    } catch (err) {
      return { ok: false, text: err.message };
    }
  }

  reply(prompt, tool, result) {
    if (this.opts.requireLogin && !this.loggedIn) return 'Not logged in · Please run /login';
    const template = env.FAKE_CLAUDE_REPLY
      || `Hi! I'm a fake Claude Code${this.agent ? ` running as ${this.agent}` : ''}. You said: "{prompt}"${tool ? (result?.ok ? ' I used {tool}: {result}' : ' {tool} failed: {result}') : ''}`;
    return template
      .replaceAll('{prompt}', oneLine(prompt.replace(/fake:\w+(=[^\s]+)?/g, ''), 160))
      .replaceAll('{agent}', this.agent ?? '')
      .replaceAll('{model}', this.model)
      .replaceAll('{turn}', String(this.turn))
      .replaceAll('{tool}', tool ?? '')
      .replaceAll('{result}', result ? oneLine(result.text, 200) : '')
      .replaceAll('{cwd}', this.cwd);
  }

  /** Deterministic usage per turn. */
  account(prompt, text) {
    const input = 1000 + prompt.length;
    const output = Math.ceil(text.length / 4) + 20;
    this.usage.input += input;
    this.usage.output += output;
    this.usage.cost = Math.round((this.usage.cost + 0.0125) * 10000) / 10000;
    return { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  }

  rateLimits() {
    const hour = Math.ceil(Date.now() / 3_600_000) * 3600;
    return {
      five_hour: { used_percentage: Math.min(100, 5 + this.turn * 2), resets_at: hour + 4 * 3600 },
      seven_day: { used_percentage: Math.min(100, 10 + this.turn), resets_at: hour + 6 * 86400 },
    };
  }

  close() {
    for (const c of this.mcp.values()) c.close();
  }
}

// ------------------------------------------------------------------ hooks

function loadSettings(opts, cwd) {
  const sources = [
    path.join(configDir(), 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ].map((f) => readJson(f, {}));
  if (opts['--settings']) sources.push(jsonArg(opts['--settings'], 'settings'));
  const settings = { hooks: {}, statusLine: null };
  for (const s of sources) {
    for (const [event, groups] of Object.entries(s.hooks ?? {})) settings.hooks[event] = [...(settings.hooks[event] ?? []), ...groups];
    if (s.statusLine) settings.statusLine = s.statusLine;
  }
  return settings;
}

function matches(matcher, value) {
  if (!matcher || matcher === '*' || value === undefined) return true;
  try { return new RegExp(`^(?:${matcher})$`).test(value); } catch { return matcher === value; }
}

function runCommand(command, input, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { shell: true, cwd, env: { ...env, CLAUDE_PROJECT_DIR: cwd }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: err.message, ms: Date.now() - started }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - started }); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

class Hooks {
  constructor(settings, brain) {
    this.settings = settings;
    this.brain = brain;
  }

  base(event) {
    const b = this.brain;
    return { session_id: b.sessionId, transcript_path: b.transcriptPath, cwd: b.cwd, permission_mode: b.permissionMode, hook_event_name: event };
  }

  /** Runs the event's hooks in parallel. Exit code 2 blocks (where the CLI supports it). */
  async fire(event, extra = {}, matchValue = undefined) {
    const commands = (this.settings.hooks[event] ?? [])
      .filter((g) => matches(g.matcher, matchValue))
      .flatMap((g) => g.hooks ?? [])
      .filter((h) => h.type === 'command' && h.command);
    if (!commands.length) return { blocked: false, reason: '' };
    const input = { ...this.base(event), ...extra };
    const results = await Promise.all(commands.map((h) => runCommand(h.command, input, this.brain.cwd, (h.timeout ?? 60) * 1000)));
    log('hook', { event, sessionId: this.brain.sessionId, commands: results.length, codes: results.map((r) => r.code), ms: Math.max(...results.map((r) => r.ms)) });
    const blocking = results.find((r) => r.code === 2);
    return { blocked: !!blocking, reason: blocking?.stderr.trim() ?? '' };
  }

  /** The statusline command; returns its first line of output. */
  async status() {
    const s = this.settings.statusLine;
    if (!s?.command) return null;
    const b = this.brain;
    const input = {
      ...this.base('Status'),
      model: { id: b.model, display_name: b.model },
      workspace: { current_dir: b.cwd, project_dir: b.cwd },
      version: VERSION.split(' ')[0],
      output_style: { name: 'default' },
      cost: { total_cost_usd: b.usage.cost, total_duration_ms: b.turn * 1000, total_api_duration_ms: b.turn * 800, total_lines_added: 0, total_lines_removed: 0 },
      context_window: { total_input_tokens: b.usage.input, total_output_tokens: b.usage.output, context_window_size: 200000 },
      rate_limits: b.rateLimits(),
    };
    const r = await runCommand(s.command, input, b.cwd, (s.timeout ?? 5) * 1000);
    log('statusline', { sessionId: b.sessionId, code: r.code });
    return r.stdout.split('\n')[0] || null;
  }
}

// ------------------------------------------------------------------ interactive TUI

async function interactive(opts, positionals) {
  const cwd = process.cwd();
  const brain = new Brain(opts, cwd);
  const hooks = new Hooks(loadSettings(opts, cwd), brain);
  const dir = configDir();
  log('session_start', {
    mode: 'tui', sessionId: brain.sessionId, resumed: brain.resumed, cwd, configDir: dir, model: brain.model,
    permissionMode: brain.permissionMode, agent: brain.agent, addDirs: opts['--add-dir'] ?? [],
    mcpServers: Object.keys(brain.mcpServers), appendSystemPrompt: opts['--append-system-prompt']?.length ?? 0,
    hookEvents: Object.keys(hooks.settings.hooks), statusLine: !!hooks.settings.statusLine, prompt: positionals[0] ?? null,
  });

  let mode = 'starting'; // starting | trust | idle | busy | permission
  let input = '';
  let pasted = null;
  let menuKey = null;
  let menuDone = null;
  let turnAbort = null;
  let lastCtrlC = 0;
  let statusText = null;
  const queue = [];

  const exit = async (code, reason) => {
    log('exit', { sessionId: brain.sessionId, code, reason });
    if (mode !== 'trust' && mode !== 'starting') await Promise.race([hooks.fire('SessionEnd', { reason }), sleep(1500)]);
    brain.close();
    out(`${ESC}[?2004l`);
    process.exit(code);
  };
  for (const sig of ['SIGHUP', 'SIGTERM']) process.on(sig, () => { exit(0, 'other'); });

  const showPrompt = () => {
    mode = 'idle';
    input = '';
    pasted = null;
    out(`\n${dim('─'.repeat(60))}\n${statusText ? `${dim(statusText)}\n` : ''}> `);
  };
  const ask = (title, options, cancel) => new Promise((resolve) => {
    menuKey = menu(title, options, { cancel });
    menuDone = resolve;
  });

  const { tty } = keyReader((key) => {
    if (key.name === 'eof') { if (!tty) exit(0, 'other'); return; }
    if (key.name === 'ctrl-d') { exit(0, 'prompt_input_exit'); return; }
    if (menuKey && (mode === 'trust' || mode === 'permission')) {
      if (key.name === 'ctrl-c') { exit(0, 'other'); return; }
      const choice = menuKey(key);
      if (choice !== undefined) { const done = menuDone; menuKey = null; menuDone = null; done(choice); }
      return;
    }
    if (mode === 'busy' && (key.name === 'escape' || key.name === 'ctrl-c')) { turnAbort?.abort(); return; }
    if (key.name === 'ctrl-c') {
      if (input) { input = ''; out(`${ESC}[2K\r> `); return; }
      if (Date.now() - lastCtrlC < 2000) { exit(0, 'prompt_input_exit'); return; }
      lastCtrlC = Date.now();
      out(dim('\nPress Ctrl-C again to exit\n> '));
      return;
    }
    if (key.name === 'char') { input += key.text; if (tty && mode === 'idle') out(key.text); return; }
    if (key.name === 'paste') {
      if (key.text.includes('\n')) { pasted = (pasted ?? '') + key.text; if (mode === 'idle') out(`[Pasted text +${key.text.split('\n').length} lines] `); }
      else { input += key.text; if (mode === 'idle') out(key.text); }
      return;
    }
    if (key.name === 'backspace') { if (input) { input = input.slice(0, -1); if (tty && mode === 'idle') out('\b \b'); } return; }
    if (key.name === 'enter') {
      const text = `${pasted ?? ''}${input}`.trim();
      input = '';
      pasted = null;
      if (!text) return;
      if (mode !== 'idle') { queue.push(text); return; }
      out('\n');
      submit(text);
    }
  });
  out(`${ESC}[?2004h`); // bracketed paste, like the real TUI

  const header = () => {
    out(`${orange('╭───────────────────────────────────────────────────╮')}\n`);
    out(`${orange('│')} ${orange('✻')} ${bold('Welcome to Claude Code!')} ${dim('(fake)')}\n`);
    out(`${orange('│')}   ${dim(`cwd: ${cwd}`)}\n`);
    out(`${orange('│')}   ${dim(`model: ${brain.model} · ${brain.permissionMode}${brain.agent ? ` · agent: ${brain.agent}` : ''}`)}\n`);
    out(`${orange('╰───────────────────────────────────────────────────╯')}\n`);
  };

  // Folder trust, like the real CLI on a folder it hasn't seen. Hooks don't run before it.
  const stateFile = path.join(dir, '.claude.json');
  const state = readJson(stateFile, {});
  if (env.FAKE_CLAUDE_TRUST !== 'yes' && !state.projects?.[cwd]?.hasTrustDialogAccepted) {
    mode = 'trust';
    out(`${bold('Do you trust the files in this folder?')}\n\n${cwd}\n\n`);
    out(dim('Claude Code may read, write, or execute files contained in this directory. This can pose security risks, so only use\nfiles and tools from trusted sources.\n\n'));
    const choice = await ask('', ['No, exit', 'Yes, I trust this folder'], 0);
    log('trust', { cwd, trusted: choice === 1 });
    if (choice !== 1) return exit(1, 'other');
    state.projects = { ...(state.projects ?? {}), [cwd]: { ...(state.projects?.[cwd] ?? {}), hasTrustDialogAccepted: true } };
    try { mkdirSync(dir, { recursive: true }); writeFileSync(stateFile, JSON.stringify(state, null, 2)); } catch {}
    out(`${ESC}[2J${ESC}[H`);
  }

  header();
  if (brain.agent) {
    const agentsDir = path.join(cwd, '.claude', 'agents');
    const defines = (f) => { try { return readFileSync(path.join(agentsDir, f), 'utf8').includes(`name: ${brain.agent}`); } catch { return false; } };
    const found = existsSync(agentsDir) && readdirSync(agentsDir).some((f) => f === `${brain.agent}.md` || (f.endsWith('.md') && defines(f)));
    if (!found) out(`${dim(`(fake) agent "${brain.agent}" was not found in .claude/agents; continuing anyway`)}\n`);
  }
  if (brain.resumed) out(dim(`Resumed conversation ${brain.sessionId} (${brain.history.length} messages)\n`));
  await brain.connectMcp();
  if (brain.mcp.size) out(dim(`MCP: ${[...brain.mcp].map(([n, c]) => `${n} (${c.tools.length} tools)`).join(', ')}\n`));
  if (brain.opts.requireLogin && !brain.loggedIn) out(`${orange('Not logged in')} · Run /login\n`);
  await hooks.fire('SessionStart', { source: brain.resumed ? 'resume' : 'startup', model: brain.model }, brain.resumed ? 'resume' : 'startup');
  statusText = await hooks.status();

  async function submit(prompt) {
    mode = 'busy';
    const abort = new AbortController();
    turnAbort = abort;
    const interrupted = () => {
      if (!abort.signal.aborted) return false;
      out(`  ${dim('⎿')}  ${ESC}[31mInterrupted by user${ESC}[39m\n`);
      log('interrupted', { sessionId: brain.sessionId, turn: brain.turn });
      return true;
    };
    const done = async () => {
      turnAbort = null;
      showPrompt();
      if (queue.length) { const next = queue.shift(); out(`${next}\n`); await submit(next); }
    };

    if (prompt === '/exit' || prompt === '/quit') return exit(0, 'prompt_input_exit');
    const gate = await hooks.fire('UserPromptSubmit', { prompt });
    if (gate.blocked) {
      out(`${ESC}[31mUserPromptSubmit hook blocked this prompt${gate.reason ? `: ${gate.reason}` : ''}${ESC}[39m\n`);
      return done();
    }
    brain.turn++;
    brain.record({ type: 'user', message: { role: 'user', content: prompt } });
    log('prompt', { sessionId: brain.sessionId, turn: brain.turn, prompt: oneLine(prompt, 200) });
    const plan = brain.plan(prompt);
    out(`${orange('✻')} ${dim('Thinking… (esc to interrupt)')}\n`);
    await sleep(plan.delay, abort.signal);
    if (interrupted()) return done();
    if (plan.exit !== undefined) {
      log('crash', { sessionId: brain.sessionId, code: Number(plan.exit) });
      out(`${ESC}[31m(fake) exiting with code ${plan.exit}${ESC}[39m\n`);
      brain.close();
      process.exit(Number(plan.exit) || 1);
    }

    let result = null;
    if (plan.tool) {
      const tool = plan.tool;
      const toolInput = brain.toolInput(tool);
      const toolUseId = stableId('toolu_', brain.sessionId, String(brain.turn), tool);
      brain.record({ type: 'assistant', message: { role: 'assistant', model: brain.model, content: [{ type: 'tool_use', id: toolUseId, name: tool, input: toolInput }] } });
      out(`${orange('⏺')} ${bold(tool)}(${oneLine(JSON.stringify(toolInput), 70)})\n`);
      const pre = await hooks.fire('PreToolUse', { tool_name: tool, tool_input: toolInput, tool_use_id: toolUseId }, tool);
      let decision = pre.blocked ? 'blocked' : brain.permissionFor(tool);
      if (decision === 'ask') {
        mode = 'permission';
        void hooks.fire('Notification', { message: `Claude needs your permission to use ${tool}`, notification_type: 'permission_prompt' }, 'permission_prompt');
        const choices = ['Yes', `Yes, and don't ask again for ${tool} this session`, 'No, and tell Claude what to do differently (esc)'];
        const choice = await ask(`\n${bold(`${tool.startsWith('mcp__') ? 'Tool use' : tool} `)}\n  ${oneLine(JSON.stringify(toolInput), 90)}\n\nDo you want to proceed?`, choices, 2);
        mode = 'busy';
        if (choice === 1) brain.allowed.add(tool);
        decision = choice === 2 ? 'deny' : 'allow';
        log('permission', { sessionId: brain.sessionId, tool, allow: decision === 'allow', always: choice === 1 });
        if (decision === 'deny') {
          // The CLI stops the turn and waits for the user's instructions.
          brain.record({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'The user rejected this tool use', is_error: true }] } });
          abort.abort();
          interrupted();
          return done();
        }
      }
      if (decision === 'allow') {
        result = await brain.runTool(tool, toolInput);
        log('tool', { sessionId: brain.sessionId, tool, ok: result.ok, result: oneLine(result.text, 300) });
        out(`  ${dim('⎿')}  ${oneLine(result.text, 100)}\n`);
        await hooks.fire('PostToolUse', { tool_name: tool, tool_input: toolInput, tool_response: { ok: result.ok, output: result.text }, tool_use_id: toolUseId }, tool);
      } else {
        result = { ok: false, text: pre.blocked ? `Blocked by hook: ${pre.reason}` : 'Permission denied' };
        out(`  ${dim('⎿')}  ${ESC}[31m${result.text}${ESC}[39m\n`);
      }
      brain.record({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result.text, is_error: !result.ok }] } });
      await sleep(Math.min(plan.delay, 200), abort.signal);
      if (interrupted()) return done();
    }

    const text = brain.reply(prompt, plan.tool, result);
    brain.account(prompt, text);
    brain.record({ type: 'assistant', message: { role: 'assistant', model: brain.model, content: [{ type: 'text', text }] } });
    out(`\n${ESC}[37m⏺${ESC}[39m ${text}\n`);
    log('reply', { sessionId: brain.sessionId, turn: brain.turn, text });
    statusText = await hooks.status();
    await hooks.fire('Stop', { stop_hook_active: false, last_assistant_message: text });
    return done();
  }

  // The prompt argument, or whatever was typed while starting up.
  const first = positionals[0]?.trim() || queue.shift();
  if (first) { out(`> ${oneLine(first, 100)}\n`); await submit(first); }
  else showPrompt();
}

// ------------------------------------------------------------------ headless (-p)

async function headless(opts, positionals) {
  const cwd = process.cwd();
  const brain = new Brain(opts, cwd);
  const streamIn = opts['--input-format'] === 'stream-json';
  const format = opts['--output-format'] || 'text';
  if (format === 'stream-json' && !opts['--verbose']) fail('Error: When using --print, --output-format=stream-json requires --verbose');
  const promptTool = opts['--permission-prompt-tool'];
  log('session_start', {
    mode: 'headless', sessionId: brain.sessionId, resumed: brain.resumed, cwd, configDir: configDir(), model: brain.model,
    permissionMode: brain.permissionMode, agent: brain.agent, addDirs: opts['--add-dir'] ?? [], mcpServers: Object.keys(brain.mcpServers),
    appendSystemPrompt: opts['--append-system-prompt']?.length ?? 0, inputFormat: opts['--input-format'] ?? 'text', outputFormat: format,
  });
  const hooks = new Hooks(loadSettings(opts, cwd), brain);
  await brain.connectMcp();
  await hooks.fire('SessionStart', { source: brain.resumed ? 'resume' : 'startup', model: brain.model }, brain.resumed ? 'resume' : 'startup');

  const emit = (msg) => { if (format === 'stream-json') out(`${JSON.stringify(msg)}\n`); };
  const pendingControl = new Map();
  let initSent = false;
  let current = null; // AbortController of the running turn

  const sendInit = () => {
    if (initSent) return;
    initSent = true;
    emit({
      type: 'system', subtype: 'init', cwd, session_id: brain.sessionId, tools: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write', ...[...brain.mcp].flatMap(([s, c]) => c.tools.map((t) => `mcp__${s}__${t}`))],
      mcp_servers: Object.keys(brain.mcpServers).map((name) => ({ name, status: brain.mcp.has(name) ? 'connected' : 'pending' })),
      model: brain.model, permissionMode: brain.permissionMode, slash_commands: [], apiKeySource: 'none',
      claude_code_version: VERSION.split(' ')[0], output_style: 'default', agents: brain.agent ? [brain.agent] : [], uuid: randomUUID(),
    });
  };

  const assistant = (content) => emit({
    type: 'assistant',
    message: { id: stableId('msg_', brain.sessionId, String(brain.turn), JSON.stringify(content)), type: 'message', role: 'assistant', model: brain.model, content, stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
    parent_tool_use_id: null, session_id: brain.sessionId, uuid: randomUUID(),
  });

  /** Asks the SDK host (stdio permission prompt tool) whether a tool may run. */
  const canUseTool = (tool, input, toolUseId, signal) => new Promise((resolve) => {
    const requestId = randomUUID();
    pendingControl.set(requestId, resolve);
    signal.addEventListener('abort', () => { pendingControl.delete(requestId); resolve({ behavior: 'deny', message: 'Interrupted' }); }, { once: true });
    emit({
      type: 'control_request', request_id: requestId,
      request: {
        subtype: 'can_use_tool', tool_name: tool, display_name: tool, input, tool_use_id: toolUseId,
        description: tool === 'Bash' ? input.description ?? null : null,
        permission_suggestions: [{ type: 'addRules', rules: [{ toolName: tool }], behavior: 'allow', destination: 'session' }],
      },
    });
  });

  const runTurn = async (prompt) => {
    const abort = new AbortController();
    current = abort;
    const started = Date.now();
    brain.turn++;
    sendInit();
    await hooks.fire('UserPromptSubmit', { prompt });
    brain.record({ type: 'user', message: { role: 'user', content: prompt } });
    log('prompt', { sessionId: brain.sessionId, turn: brain.turn, prompt: oneLine(prompt, 200) });
    const plan = brain.plan(prompt);
    const denials = [];
    await sleep(plan.delay, abort.signal);
    if (plan.exit !== undefined && !abort.signal.aborted) { brain.close(); process.exit(Number(plan.exit) || 1); }

    let result = null;
    if (plan.tool && !abort.signal.aborted) {
      const tool = plan.tool;
      const input = brain.toolInput(tool);
      const toolUseId = stableId('toolu_', brain.sessionId, String(brain.turn), tool);
      assistant([{ type: 'tool_use', id: toolUseId, name: tool, input }]);
      const pre = await hooks.fire('PreToolUse', { tool_name: tool, tool_input: input, tool_use_id: toolUseId }, tool);
      let decision = pre.blocked ? 'deny' : brain.permissionFor(tool);
      if (decision === 'ask') {
        if (promptTool === 'stdio') {
          const answer = await canUseTool(tool, input, toolUseId, abort.signal);
          decision = answer.behavior === 'allow' ? 'allow' : 'deny';
          if (answer.updatedPermissions) brain.allowed.add(tool);
          log('permission', { sessionId: brain.sessionId, tool, allow: decision === 'allow', always: !!answer.updatedPermissions });
          if (decision === 'deny') result = { ok: false, text: answer.message || 'The user denied this action.' };
        } else {
          decision = 'deny';
        }
      }
      if (decision === 'allow' && !abort.signal.aborted) {
        result = await brain.runTool(tool, input);
        log('tool', { sessionId: brain.sessionId, tool, ok: result.ok, result: oneLine(result.text, 300) });
        await hooks.fire('PostToolUse', { tool_name: tool, tool_input: input, tool_response: { ok: result.ok, output: result.text }, tool_use_id: toolUseId }, tool);
      } else {
        result ??= { ok: false, text: `Claude requested permissions to use ${tool}, but you haven't granted it yet.` };
        denials.push({ tool_name: tool, tool_use_id: toolUseId, tool_input: input });
      }
      emit({ type: 'user', message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: result.text, is_error: !result.ok }] }, parent_tool_use_id: null, session_id: brain.sessionId, uuid: randomUUID() });
    }

    const usage = brain.account(prompt, '');
    if (abort.signal.aborted) {
      log('interrupted', { sessionId: brain.sessionId, turn: brain.turn });
      emit({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: Date.now() - started, duration_api_ms: 0, num_turns: brain.turn, session_id: brain.sessionId, total_cost_usd: brain.usage.cost, usage, permission_denials: denials, uuid: randomUUID() });
      current = null;
      return null;
    }
    const text = brain.reply(prompt, plan.tool, result);
    brain.record({ type: 'assistant', message: { role: 'assistant', model: brain.model, content: [{ type: 'text', text }] } });
    assistant([{ type: 'text', text }]);
    log('reply', { sessionId: brain.sessionId, turn: brain.turn, text });
    const rl = brain.rateLimits();
    emit({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: rl.five_hour.used_percentage / 100, resetsAt: rl.five_hour.resets_at }, seven_day: { utilization: rl.seven_day.used_percentage / 100, resetsAt: rl.seven_day.resets_at } } } });
    const loginError = brain.opts.requireLogin && !brain.loggedIn;
    const final = {
      type: 'result', subtype: 'success', is_error: loginError, duration_ms: Date.now() - started, duration_api_ms: plan.delay,
      num_turns: brain.turn, result: text, session_id: brain.sessionId, total_cost_usd: brain.usage.cost, usage, permission_denials: denials, uuid: randomUUID(),
    };
    emit(final);
    await hooks.fire('Stop', { stop_hook_active: false, last_assistant_message: text });
    current = null;
    return final;
  };

  if (!streamIn) {
    // One prompt from the arguments or stdin, then exit.
    let prompt = positionals.join(' ');
    if (!prompt && !process.stdin.isTTY) prompt = await new Promise((r) => { let s = ''; process.stdin.setEncoding('utf8').on('data', (d) => { s += d; }).on('end', () => r(s)); });
    if (!prompt.trim()) fail('Error: Input must be provided either through stdin or as a prompt argument when using --print');
    const final = await runTurn(prompt.trim());
    if (format === 'text') out(`${final.result}\n`);
    else if (format === 'json') out(`${JSON.stringify(final)}\n`);
    log('exit', { sessionId: brain.sessionId, code: 0 });
    brain.close();
    process.exit(final.is_error ? 1 : 0);
  }

  const turns = [];
  let chain = Promise.resolve();
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'user') {
      const c = msg.message?.content;
      const prompt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
      chain = chain.then(() => runTurn(prompt));
      turns.push(chain);
    } else if (msg.type === 'control_response') {
      const r = msg.response ?? {};
      const resolve = pendingControl.get(r.request_id);
      if (resolve) { pendingControl.delete(r.request_id); resolve(r.subtype === 'success' ? r.response ?? {} : { behavior: 'deny', message: r.error }); }
    } else if (msg.type === 'control_request') {
      const sub = msg.request?.subtype;
      if (sub === 'interrupt') current?.abort();
      emit({ type: 'control_response', response: sub === 'interrupt' || sub === 'initialize' ? { subtype: 'success', request_id: msg.request_id, response: {} } : { subtype: 'error', request_id: msg.request_id, error: `Unsupported control request: ${sub}` } });
      log('control_request', { sessionId: brain.sessionId, subtype: sub });
    }
  });
  lines.on('close', async () => {
    await chain;
    log('exit', { sessionId: brain.sessionId, code: 0, reason: 'stdin closed' });
    brain.close();
    process.exit(0);
  });
  for (const sig of ['SIGHUP', 'SIGTERM']) process.on(sig, () => { log('exit', { sessionId: brain.sessionId, code: 0, reason: sig }); brain.close(); process.exit(0); });
}

// ------------------------------------------------------------------ main

const HELP = `Usage: claude [options] [command] [prompt]

Fake Claude Code for testing Agent HQ (scripts/fake-claude.mjs). Starts an
interactive session by default; use -p/--print for non-interactive output.

Options:
  -p, --print                       Print response and exit (headless)
  --input-format <format>           text | stream-json (with --print)
  --output-format <format>          text | json | stream-json (with --print)
  --permission-mode <mode>          ${PERMISSION_MODES.join(', ')}
  --permission-prompt-tool <tool>   stdio: ask the SDK host (control_request can_use_tool)
  --settings <file-or-json>         Hooks and statusLine
  --mcp-config <configs...>         MCP servers (stdio servers are connected with FAKE_CLAUDE_MCP)
  --append-system-prompt <prompt>   Accepted (not used by the fake)
  --model <model>, --agent <name>   Shown in the header and statusline
  -r, --resume [sessionId]          Resume a conversation from <config>/projects
  -c, --continue                    Continue the most recent conversation in this folder
  --add-dir <directories...>        Accepted
  -v, --version                     Output the version number
  -h, --help                        Display help

Commands:
  auth status [--json]   auth login   auth logout
`;

const argv = process.argv.slice(2);
if (argv[0] === 'auth') {
  log('invoke', { args: argv, configDir: configDir() });
  const sub = argv[1];
  if (sub === 'status') authStatus(argv.slice(2));
  else if (sub === 'login') authLogin();
  else if (sub === 'logout') authLogout();
  else fail(`error: unknown command 'auth ${sub ?? ''}'`.trim());
} else if (argv.includes('--version') || argv.includes('-v')) {
  log('version', {});
  out(`${VERSION}\n`);
  process.exit(0);
} else if (argv.includes('--help') || argv.includes('-h')) {
  out(HELP);
  process.exit(0);
} else if (['mcp', 'config', 'doctor', 'update', 'install', 'setup-token', 'plugin', 'migrate-installer'].includes(argv[0])) {
  fail(`fake claude: '${argv[0]}' is not simulated`);
} else {
  const { opts, positionals } = parseArgs(argv);
  if (positionals.length > 1) fail(`error: too many arguments. Expected 1 argument but got ${positionals.length}.`);
  opts.requireLogin = env.FAKE_CLAUDE_REQUIRE_LOGIN === '1';
  // Agent HQ passes the HQ MCP token inside --mcp-config: keep it out of the log.
  const redact = (a) => a.replace(/("--token",\s*")[^"]*"/g, '$1***"');
  log('invoke', { args: argv.map(redact).map((a) => (a.length > 300 ? `${a.slice(0, 300)}…` : a)), configDir: configDir() });
  const run = opts['--print'] ? headless : interactive;
  run(opts, positionals).catch((err) => fail(`fake claude: ${err.stack ?? err.message}`));
}
