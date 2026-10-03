#!/usr/bin/env node
// The "hq" MCP server: gives an agent access to the office board. Claude Code
// starts it over stdio; it talks to the Agent HQ host over WebSocket using a
// short-lived token tied to that agent. Coordinators can also create and assign
// tasks, which is how agents delegate to teammates.
//
// Usage: node hq-mcp.ts --url ws://host:4317 --token <agent token> [--manager]

import { createInterface } from 'node:readline';
import type { Agent, ServerMessage, Snapshot, Task } from '@agent-hq/protocol';

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const url = arg('--url')!;
const token = arg('--token')!;
const manager = argv.includes('--manager');

// ------------------------------------------------------------------ host connection

let world: Snapshot | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let ready: Promise<void>;

function connect() {
  ready = new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}/ws?token=${encodeURIComponent(token)}`);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      if (msg.type === 'snapshot') { world = msg.snapshot; resolve(); }
      else if (msg.type === 'reply') {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) p?.resolve(msg.result); else p?.reject(new Error(msg.error));
      } else if (msg.type === 'event' && world) {
        const e = msg.event;
        if (e.type === 'task') world.tasks = [...world.tasks.filter((t) => t.id !== e.task.id), e.task];
        else if (e.type === 'task_removed') world.tasks = world.tasks.filter((t) => t.id !== e.id);
        else if (e.type === 'agent') world.agents = [...world.agents.filter((a) => a.id !== e.agent.id), e.agent];
        else if (e.type === 'agent_removed') world.agents = world.agents.filter((a) => a.id !== e.id);
      }
    };
    ws.onerror = () => reject(new Error('Cannot reach Agent HQ'));
    ws.onclose = () => { world = null; setTimeout(connect, 2000); };
    request = (command, args) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ type: 'request', id, command, args }));
    });
  });
  ready.catch(() => {});
}

let request: (command: string, args: unknown) => Promise<unknown> = () => Promise.reject(new Error('not connected'));
connect();

// ------------------------------------------------------------------ tools

const describeAgent = (a: Agent) =>
  `- ${a.name} (${a.role}${a.isManager ? ', coordinator' : ''}) id=${a.id} status=${a.status}${a.activity ? ` — ${a.activity}` : ''}`;
const describeTask = (t: Task, w: Snapshot) => {
  const who = w.agents.find((a) => a.id === t.assigneeId)?.name ?? 'unassigned';
  const project = w.projects.find((p) => p.id === t.projectId)?.name ?? '?';
  return `- [${t.status}] ${t.title} (project ${project}, ${who}) id=${t.id}${t.branch ? ` branch=${t.branch}` : ''}`;
};

interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  run: (args: any) => Promise<string>;
}

const tools: Tool[] = [
  {
    name: 'list_team',
    description: 'List the agents in the office with their roles, ids and current status.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => (world!.agents.map(describeAgent).join('\n') || 'No agents.'),
  },
  {
    name: 'list_projects',
    description: 'List projects (each one is a git repository) with their ids.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => (world!.projects.map((p) => `- ${p.name} id=${p.id}`).join('\n') || 'No projects.'),
  },
  {
    name: 'list_tasks',
    description: 'List tasks on the board, optionally filtered by status (todo, in_progress, review, done, failed).',
    inputSchema: { type: 'object', properties: { status: { type: 'string' } } },
    run: async (a: { status?: string }) =>
      (world!.tasks.filter((t) => !a.status || t.status === a.status).map((t) => describeTask(t, world!)).join('\n') || 'No tasks.'),
  },
  ...(manager ? [
    {
      name: 'create_task',
      description: 'Create a task on the board. Leave assignee_id empty to let a free agent pick it up, or set it to delegate to a specific teammate.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string', description: 'Self-contained brief: goal, acceptance criteria, relevant files.' },
          assignee_id: { type: 'string' },
        },
        required: ['project_id', 'title', 'description'],
      },
      run: async (a: { project_id: string; title: string; description: string; assignee_id?: string }) => {
        const t = (await request('create_task', { projectId: a.project_id, title: a.title, description: a.description, assigneeId: a.assignee_id || null })) as Task;
        return `Created task ${t.id}: ${t.title}`;
      },
    },
    {
      name: 'assign_task',
      description: 'Assign an existing task to a teammate. If they are busy it waits in their queue.',
      inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, agent_id: { type: 'string' } }, required: ['task_id', 'agent_id'] },
      run: async (a: { task_id: string; agent_id: string }) => {
        await request('assign_task', { taskId: a.task_id, agentId: a.agent_id });
        return 'Assigned.';
      },
    },
  ] : []),
];

// ------------------------------------------------------------------ MCP (JSON-RPC over stdio)

function reply(id: unknown, result: unknown) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
function fail(id: unknown, message: string) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } })}\n`);
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg: { id?: unknown; method?: string; params?: any };
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notifications
  switch (msg.method) {
    case 'initialize':
      return reply(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-hq', version: '0.1.0' },
      });
    case 'ping':
      return reply(msg.id, {});
    case 'tools/list':
      return reply(msg.id, { tools: tools.map(({ run: _run, ...t }) => t) });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(msg.id, `Unknown tool ${msg.params?.name}`);
      try {
        await ready;
        const text = await tool.run(msg.params?.arguments ?? {});
        return reply(msg.id, { content: [{ type: 'text', text }] });
      } catch (err) {
        return reply(msg.id, { content: [{ type: 'text', text: (err as Error).message }], isError: true });
      }
    }
    default:
      return fail(msg.id, `Method not found: ${msg.method}`);
  }
});
