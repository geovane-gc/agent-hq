import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { ClientRequest, HostToRunner, RunnerMessage, ServerEvent, ServerMessage } from '@agent-hq/protocol';
import type { Config } from './config.ts';
import type { Actor, Orchestrator } from './orchestrator.ts';
import type { Store } from './store.ts';
import type { BossTerminal } from './terminal.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
};

const WEB_DIST = path.resolve(import.meta.dirname, '../../../apps/web/dist');

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://local');
  let file = path.join(WEB_DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(WEB_DIST) || !existsSync(file) || statSync(file).isDirectory()) {
    file = path.join(WEB_DIST, 'index.html'); // SPA fallback
  }
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Web UI not built. Run `npm run build` or use `npm run dev`.');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

export function startServer(config: Config, store: Store, orchestrator: Orchestrator, terminal: BossTerminal) {
  const http = createServer(serveStatic);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const clients = new Map<WebSocket, Actor>();
  /** Which agent terminals each client has open. */
  const watching = new Map<WebSocket, Set<string>>();

  function unwatch(ws: WebSocket, agentId: string) {
    if (watching.get(ws)?.delete(agentId)) orchestrator.watch(agentId, -1);
  }

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const actor = orchestrator.authenticate(url.searchParams.get('token') ?? '');
      if (!actor) {
        ws.close(4001, 'Invalid token');
        return;
      }
      if (url.searchParams.get('runner') === '1') {
        if (actor.kind !== 'user') return ws.close(4001, 'Invalid token');
        attachRunner(ws, actor);
        return;
      }
      clients.set(ws, actor);
      if (actor.kind === 'user') orchestrator.connected(actor.user.id);
      send(ws, { type: 'snapshot', snapshot: orchestrator.snapshot(actor) });
      ws.on('message', (raw) => onMessage(ws, actor, raw.toString()));
      ws.on('close', () => {
        for (const agentId of watching.get(ws) ?? []) orchestrator.watch(agentId, -1);
        watching.delete(ws);
        clients.delete(ws);
        if (actor.kind === 'user') orchestrator.disconnected(actor.user.id);
      });
    });
  });

  /** A teammate's machine offering to run their agents. */
  function attachRunner(ws: WebSocket, actor: Extract<Actor, { kind: 'user' }>) {
    const userId = actor.user.id;
    if (userId === orchestrator.owner().id) {
      ws.close(4002, 'The owner\'s agents already run on the host');
      return;
    }
    const runner = orchestrator.attachRunner(userId, (msg: HostToRunner) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    });
    ws.send(JSON.stringify({ type: 'snapshot', snapshot: orchestrator.snapshot(actor) } satisfies ServerMessage));
    ws.on('message', (raw) => {
      let msg: RunnerMessage;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'runner_event') runner.deliver(msg.sessionKey, msg.event);
      else if (msg.type === 'runner_reply') runner.reply(msg);
    });
    ws.on('close', () => orchestrator.detachRunner(userId, runner));
  }

  function send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  async function onMessage(ws: WebSocket, actor: Actor, raw: string) {
    let req: ClientRequest;
    try { req = JSON.parse(raw); } catch { return; }
    if (req.type !== 'request' || typeof req.id !== 'number') return;
    try {
      const result = await orchestrator.handle(req.command, req.args, actor);
      if (req.command === 'agent_terminal_open') {
        const agentId = (req.args as { agentId: string }).agentId;
        const set = watching.get(ws) ?? new Set<string>();
        watching.set(ws, set);
        if (!set.has(agentId)) { set.add(agentId); orchestrator.watch(agentId, 1); }
      } else if (req.command === 'agent_terminal_close') {
        unwatch(ws, (req.args as { agentId: string }).agentId);
      }
      send(ws, { type: 'reply', id: req.id, ok: true, result: result ?? null });
    } catch (err) {
      send(ws, { type: 'reply', id: req.id, ok: false, error: (err as Error).message });
    }
  }

  function broadcast(event: ServerEvent, filter: (actor: Actor) => boolean = () => true) {
    const msg = JSON.stringify({ type: 'event', event } satisfies ServerMessage);
    for (const [ws, actor] of clients) if (filter(actor) && ws.readyState === WebSocket.OPEN) ws.send(msg);
  }

  const isOwner = (a: Actor) => a.kind === 'user' && a.user.role === 'owner';
  store.on('event', (event) => {
    // Meters and mail are private to one player.
    const to = event.type === 'rate_limits' ? event.userId : event.type === 'mail' ? event.mail.toUserId : null;
    broadcast(event, to ? (a) => a.kind === 'user' && a.user.id === to : undefined);
  });
  terminal.on('data', (data) => broadcast({ type: 'terminal_output', data }, isOwner));
  orchestrator.terminals.on('data', (agentId, data) => {
    const msg = JSON.stringify({ type: 'event', event: { type: 'agent_terminal_output', agentId, data } } satisfies ServerMessage);
    for (const [ws, set] of watching) if (set.has(agentId) && ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
  terminal.on('exit', (code) => broadcast({ type: 'terminal_exit', code }, isOwner));

  return new Promise<{ close: () => void }>((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, config.host, () => {
      resolve({
        close: () => {
          for (const ws of wss.clients) ws.close();
          http.close();
        },
      });
    });
  });
}
