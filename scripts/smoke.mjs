// End-to-end smoke test with the fake Claude Code (scripts/fake-claude.mjs):
// starts the core on a temp data dir and a free port, then drives it over
// HTTP and WebSocket as the owner. Never touches ~/.agent-hq or a real
// Claude login. Needs the built UI (`npm run build`).
//
//   npm run smoke                  # temp dir, removed afterwards
//   SMOKE_DIR=/some/dir npm run smoke   # keep everything there (logs, data)
//   SMOKE_KEEP=1 npm run smoke     # keep the temp dir
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const FAKE = path.join(ROOT, 'scripts', 'fake-claude.mjs');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);

const base = process.env.SMOKE_DIR ? path.resolve(process.env.SMOKE_DIR) : mkdtempSync(path.join(os.tmpdir(), 'agent-hq-smoke-'));
const MARKER = path.join(base, '.agent-hq-smoke');
if (process.env.SMOKE_DIR && existsSync(base)) {
  // Only ever wipe a dir an earlier smoke run created.
  if (readdirSync(base).length && !existsSync(MARKER)) {
    console.error(`smoke: SMOKE_DIR ${base} is not empty and was not created by the smoke test; refusing to wipe it`);
    process.exit(2);
  }
  rmSync(base, { recursive: true, force: true });
}
mkdirSync(base, { recursive: true });
writeFileSync(MARKER, '');
const dirs = {
  data: path.join(base, 'data'),
  claude: path.join(base, 'claude-default'),
  home: path.join(base, 'home'),
  headless: path.join(base, 'headless'),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
const fakeLog = path.join(base, 'fake-claude.log');
const coreLogFile = path.join(base, 'core.log');

// Everything below (the core, its agents, the fake CLI) sees only the temp dirs.
for (const k of Object.keys(process.env)) if (k.startsWith('AGENT_HQ_') || k.startsWith('FAKE_CLAUDE_')) delete process.env[k];
Object.assign(process.env, {
  AGENT_HQ_CLAUDE_PATH: FAKE,
  CLAUDE_CONFIG_DIR: dirs.claude,
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  FAKE_CLAUDE_LOG: fakeLog,
  FAKE_CLAUDE_MCP: 'agent-hq',
  FAKE_CLAUDE_DELAY: '150',
});

// ------------------------------------------------------------------ reporting

const results = [];
let core = null;
let coreLog = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return !!pass;
}

function must(name, pass, detail) {
  if (!check(name, pass, detail)) throw new Error(`required check failed: ${name}`);
}

function fakeEvents() {
  if (!existsSync(fakeLog)) return [];
  return readFileSync(fakeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function shutdown() {
  if (core && core.exitCode === null && core.signalCode === null) {
    const exited = new Promise((r) => core.once('exit', r));
    core.kill('SIGTERM');
    const done = await Promise.race([exited.then(() => true), sleep(10_000).then(() => false)]);
    if (!done) { core.kill('SIGKILL'); await exited; }
    check('core shuts down on SIGTERM', done);
  }
  // Agent sessions must not outlive the core.
  const pids = [...new Set(fakeEvents().filter((e) => e.action === 'session_start').map((e) => e.pid))];
  for (let i = 0; i < 30 && pids.some(isAlive); i++) await sleep(100);
  const left = pids.filter(isAlive);
  for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  if (pids.length) check('no fake Claude Code session outlives the core', left.length === 0, left.length ? `killed ${left.join(', ')}` : `${pids.length} sessions`);
}

// ------------------------------------------------------------------ helpers

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const client = {
      ws, first: null, events: [], closed: null, nextId: 1, pending: new Map(), waiters: [],
      request(command, args = {}) {
        return new Promise((res, rej) => {
          const id = client.nextId++;
          client.pending.set(id, { res, rej });
          ws.send(JSON.stringify({ type: 'request', id, command, args }));
        });
      },
      /**
       * Resolves with the next event matching `pred`, already received or not.
       * Events are consumed in order: everything up to the match is dropped.
       */
      waitFor(what, pred, ms = 20_000) {
        const i = client.events.findIndex(pred);
        if (i >= 0) return Promise.resolve(client.events.splice(0, i + 1)[i]);
        return new Promise((res, rej) => {
          const w = { pred, res, timer: setTimeout(() => { client.waiters = client.waiters.filter((x) => x !== w); rej(new Error(`timed out waiting for ${what}`)); }, ms) };
          client.waiters.push(w);
        });
      },
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      // Events can arrive before the snapshot (e.g. the owner going online).
      if (!client.first && (msg.type === 'snapshot' || msg.type === 'lobby')) { client.first = msg; resolve(client); }
      if (msg.type === 'reply') {
        const p = client.pending.get(msg.id);
        client.pending.delete(msg.id);
        if (msg.ok) p?.res(msg.result); else p?.rej(new Error(msg.error));
      } else if (msg.type === 'event') {
        const w = client.waiters.find((x) => x.pred(msg.event));
        if (w) { clearTimeout(w.timer); client.waiters = client.waiters.filter((x) => x !== w); client.events.length = 0; w.res(msg.event); }
        else client.events.push(msg.event);
      }
    };
    ws.onclose = (ev) => { client.closed = ev.code; if (!client.first) reject(Object.assign(new Error(`closed ${ev.code} ${ev.reason}`), { code: ev.code })); };
    ws.onerror = () => {};
  });
}

const agentEvent = (id, pred) => (e) => e.type === 'agent' && e.agent.id === id && pred(e.agent);

// ------------------------------------------------------------------ the test

async function main() {
  console.log(`smoke: working in ${base}`);
  if (!existsSync(path.join(ROOT, 'apps/web/dist/index.html'))) throw new Error('apps/web/dist is missing: run `npm run build` first');

  // The fake's default login, as a player would have after `claude auth login`.
  const seed = spawnSync(process.execPath, [FAKE, 'auth', 'login'], { input: '', encoding: 'utf8', env: process.env });
  must('fake claude: seeded default login', seed.status === 0, seed.stderr.trim());

  const port = await freePort();
  core = spawn(process.execPath, ['packages/core/src/index.ts', '--data-dir', dirs.data, '--port', String(port)], {
    cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onOut = (d) => { coreLog += d; };
  core.stdout.setEncoding('utf8').on('data', onOut);
  core.stderr.setEncoding('utf8').on('data', onOut);
  const started = await Promise.race([
    new Promise((r) => { const t = setInterval(() => { if (/open: http/.test(coreLog)) { clearInterval(t); r(true); } }, 100); }),
    new Promise((r) => core.once('exit', () => r(false))),
    sleep(30_000).then(() => false),
  ]);
  must('core starts and listens', started, `port ${port}`);
  check('core reports the fake Claude Code version', /Claude Code 2\.1\.0 \(Claude Code\)/.test(coreLog));

  // HTTP: the built UI is served.
  const page = await fetch(`http://127.0.0.1:${port}/`);
  const html = await page.text();
  must('HTTP serves the web UI', page.status === 200 && /<div id="root">/.test(html), `status ${page.status}`);

  const token = readFileSync(path.join(dirs.data, 'owner-token'), 'utf8').trim();
  const wsUrl = (t) => `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(t)}`;
  const rejected = await connect(wsUrl('not-the-token')).then(() => null, (err) => err.code);
  check('WebSocket rejects a wrong token', rejected === 4001, `close code ${rejected}`);

  // Fresh install: the owner lands in the lobby and creates an office.
  let owner = await connect(wsUrl(token));
  if (owner.first.type === 'lobby') {
    check('owner gets the lobby on a fresh install', owner.first.offices.length === 0);
    const office = await owner.request('create_office', { name: 'Smoke office', mode: 'sandbox' });
    check('create_office', office?.name === 'Smoke office');
    for (let i = 0; i < 50 && owner.closed === null; i++) await sleep(100);
    owner = await connect(wsUrl(token));
  }
  must('owner gets a snapshot', owner.first.type === 'snapshot', owner.first.type);
  const snap = owner.first.snapshot;
  must('snapshot has the owner and a floor', snap.you.role === 'owner' && snap.floors.length > 0, `floors ${snap.floors.length}`);

  // The default login, through `claude auth status --json`.
  const accounts = await owner.request('refresh_accounts');
  const def = accounts.find((a) => a.configDir === null);
  check('default login is logged in (auth status)', def?.loggedIn && def.email === 'fake-claude-default@example.com' && def.plan === 'max', JSON.stringify(def && { loggedIn: def.loggedIn, email: def.email, plan: def.plan }));

  // Hire an agent and talk to it: TUI session in a PTY, hooks drive its status.
  const agent = await owner.request('hire_agent', { name: 'Smokey', role: 'QA', floorId: snap.floors[0].id, permissionMode: 'manual' });
  must('hire_agent', agent?.id && agent.status === 'idle', agent?.status);

  await owner.request('send_message', { agentId: agent.id, text: 'Hello from the smoke test' });
  await owner.waitFor('agent working', agentEvent(agent.id, (a) => a.status === 'working'));
  check('UserPromptSubmit hook: agent is working', true);
  await owner.waitFor('agent idle after the turn', agentEvent(agent.id, (a) => a.status === 'idle' && a.live));
  check('Stop hook: agent back to idle', true);
  let transcript = await owner.request('get_transcript', { agentId: agent.id });
  check('trust dialog answered by the adapter', transcript.some((t) => t.kind === 'system' && /Trusted the workspace folder/.test(t.text)));
  check('transcript has the prompt', transcript.some((t) => t.kind === 'user' && t.text === 'Hello from the smoke test'));
  check('transcript has the reply (Stop last_assistant_message)', transcript.some((t) => t.kind === 'text' && /You said: "Hello from the smoke test"/.test(t.text)));
  check('transcript has the turn result', transcript.some((t) => t.kind === 'result' && t.text === 'Turn finished.'));

  // A tool that needs permission: an HQ MCP tool, approved from the agent's terminal.
  await owner.request('send_message', { agentId: agent.id, text: 'Who is on the team? fake:tool=mcp__agent-hq__list_team' });
  await owner.waitFor('permission prompt', agentEvent(agent.id, (a) => a.status === 'awaiting_approval'));
  check('Notification hook: agent awaits approval', true);
  const term = await owner.request('agent_terminal_open', { agentId: agent.id, cols: 120, rows: 34 });
  check('agent terminal opens with the TUI', term.interactive && term.canType && /Do you want to proceed/.test(term.history));
  await owner.request('agent_terminal_input', { agentId: agent.id, data: '\r' });
  await owner.waitFor('agent idle after the tool turn', agentEvent(agent.id, (a) => a.status === 'idle'));
  await owner.request('agent_terminal_close', { agentId: agent.id });
  transcript = await owner.request('get_transcript', { agentId: agent.id });
  check('PreToolUse hook: tool use in the transcript', transcript.some((t) => t.kind === 'tool_use' && t.text === 'Using agent-hq / list_team'));
  check('HQ MCP tool answered through the host', transcript.some((t) => t.kind === 'text' && /I used mcp__agent-hq__list_team: .*Smokey/.test(t.text)));

  // Esc interrupts a turn (no Stop hook; the adapter reads the screen).
  await owner.request('send_message', { agentId: agent.id, text: 'Take your time fake:slow=15000' });
  await owner.waitFor('agent working (slow turn)', agentEvent(agent.id, (a) => a.status === 'working'));
  await owner.request('interrupt_agent', { agentId: agent.id });
  await owner.waitFor('agent idle after the interrupt', agentEvent(agent.id, (a) => a.status === 'idle'));
  transcript = await owner.request('get_transcript', { agentId: agent.id });
  check('interrupt (Esc) ends the turn', transcript.at(-1)?.kind === 'result' && transcript.at(-1).text === 'Interrupted.', transcript.at(-1)?.text);

  // A second Claude account: `claude auth login` in a PTY, typed into from the game, then removed (logout).
  const acct = await owner.request('add_account', { label: 'Smoke account' });
  let loginScreen = '';
  const loginOutput = (pattern) => owner.waitFor(`login output ${pattern}`, (e) => {
    if (e.type !== 'account_login_output' || e.accountId !== acct.id) return false;
    loginScreen += e.data;
    return pattern.test(loginScreen.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''));
  });
  await loginOutput(/Select login method/);
  await owner.request('account_login_input', { accountId: acct.id, data: '\r' });
  await loginOutput(/Paste code here/);
  await owner.request('account_login_input', { accountId: acct.id, data: 'smoke@example.com\r' });
  const loggedIn = await owner.waitFor('account logged in', (e) => e.type === 'account' && e.account.id === acct.id && e.account.loggedIn);
  check('auth login: account logged in from the game', loggedIn.account.email === 'smoke@example.com' && loggedIn.account.plan === 'max', loggedIn.account.email);
  const removal = await owner.request('remove_account', { id: acct.id });
  check('auth logout: account removed and logged out', removal.loggedOut && !removal.warning, removal.warning ?? '');
  check('account config dir deleted', !existsSync(path.join(dirs.data, acct.configDir)));

  owner.ws.close();

  // What the fake saw from the core.
  const ev = fakeEvents();
  const tui = ev.find((e) => e.action === 'session_start' && e.mode === 'tui');
  check('session flags: permission mode, system prompt, MCP config, add-dir', tui && tui.permissionMode === 'manual' && tui.appendSystemPrompt > 0 && tui.mcpServers.includes('agent-hq') && tui.addDirs.length > 0);
  check('session settings: hooks and statusline', tui && ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop'].every((h) => tui.hookEvents.includes(h)) && tui.statusLine);
  const hookRuns = ev.filter((e) => e.action === 'hook');
  check('hooks ran and exited 0', ['SessionStart', 'UserPromptSubmit', 'Stop'].every((h) => hookRuns.some((r) => r.event === h)) && hookRuns.every((r) => r.codes.every((c) => c === 0)), `${hookRuns.length} hook runs`);
  check('statusline ran', ev.some((e) => e.action === 'statusline' && e.code === 0));
  const mcp = ev.find((e) => e.action === 'mcp' && e.server === 'agent-hq');
  check('HQ MCP server starts and lists its tools', mcp?.ok && mcp.tools.includes('list_tasks'), mcp?.error ?? mcp?.tools?.join(','));
  check('auth logout ran on the account dir only', ev.filter((e) => e.action === 'auth_logout').every((e) => e.configDir.includes('claude-accounts')) && ev.some((e) => e.action === 'auth_logout'));

  await headless();
}

/** The headless (stream-json) fallback, driven through the core's adapter in-process, plus --resume. */
async function headless() {
  const { ClaudeCodeAdapter } = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/adapters/claude-code.ts')).href);
  const adapter = new ClaudeCodeAdapter();
  const health = await adapter.check();
  check('headless: adapter health check', health.ok, health.version ?? health.error);

  const run = (opts) => {
    const events = [];
    const waiters = [];
    const session = adapter.start({
      cwd: dirs.headless, model: 'claude-sonnet-4-5', permissionMode: 'manual', systemPrompt: 'You are a smoke test.',
      resumeSessionId: null, configDir: null, addDirs: [], mcpServers: {}, agentName: null, initialPrompt: null, hooks: null, ...opts,
    }, (e) => {
      events.push(e);
      for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.res(e); }
    });
    const waitFor = (what, pred, ms = 15_000) => {
      const found = events.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((res, rej) => waiters.push({ pred, res, timer: setTimeout(() => rej(new Error(`headless: timed out waiting for ${what}`)), ms) }));
    };
    return { session, events, waitFor };
  };

  const a = run({ initialPrompt: 'Hello headless fake:tool=Bash' });
  check('headless: not interactive', a.session.interactive === false);
  const { sessionId } = await a.waitFor('init', (e) => e.type === 'session');
  const perm = await a.waitFor('permission request', (e) => e.type === 'permission_request');
  check('headless: can_use_tool permission request', perm.toolName === 'Bash' && perm.canAlwaysAllow);
  a.session.respondPermission(perm.requestId, { allow: true });
  const end = await a.waitFor('turn end', (e) => e.type === 'turn_end');
  check('headless: turn ends ok with usage', end.ok && end.usage.costUsd > 0 && end.usage.inputTokens > 0);
  check('headless: tool result and reply', a.events.some((e) => e.type === 'transcript' && e.kind === 'tool_result' && /hello from fake claude/.test(e.text))
    && a.events.some((e) => e.type === 'transcript' && e.kind === 'text' && /I used Bash/.test(e.text)));
  check('headless: rate limits reported', a.events.some((e) => e.type === 'rate_limits' && e.rateLimits.fiveHour));
  await a.session.close();
  check('headless: session exits cleanly on close', a.events.some((e) => e.type === 'exit' && e.code === 0));

  const b = run({ resumeSessionId: sessionId });
  b.session.send('Do you remember me?');
  const resumed = await b.waitFor('resumed init', (e) => e.type === 'session');
  await b.waitFor('resumed turn end', (e) => e.type === 'turn_end');
  check('headless: --resume continues the same session', resumed.sessionId === sessionId);
  await b.session.close();
}

// ------------------------------------------------------------------ run

const deadline = setTimeout(() => {
  console.error(`smoke: timed out after ${TIMEOUT_MS} ms`);
  shutdown().finally(() => process.exit(1));
}, TIMEOUT_MS);

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  console.error(`\nsmoke: ${err.stack ?? err.message}`);
} finally {
  await shutdown();
  clearTimeout(deadline);
}
failed ||= results.some((r) => !r.pass);
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed`);
if (failed) {
  console.log(`\n--- core log (tail) ---\n${coreLog.split('\n').slice(-40).join('\n')}`);
  console.log(`--- fake claude log (tail) ---\n${fakeEvents().slice(-30).map((e) => JSON.stringify(e)).join('\n')}`);
  console.log(`\nsmoke: kept ${base}`);
} else if (!process.env.SMOKE_DIR && process.env.SMOKE_KEEP !== '1') {
  rmSync(base, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
