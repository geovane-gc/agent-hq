import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ID, Project, RunnerSessionEvent, RunnerStart, Task } from '@agent-hq/protocol';
import {
  accountStatus, ensureSessionInConfigDir, removeAccount, resolveConfigDir, startAccountLogin, type AccountRemoval, type AccountStatus,
} from '../accounts.ts';
import type { AgentAdapter, AgentSession, PermissionDecision } from '../adapters/adapter.ts';
import { addWorktree, handoffBranch, removeWorktree, syncBranchFromOrigin, type HandoffResult } from '../git.ts';
import { platformMcpConfig } from '../integrations.ts';
import { agentWorkspace, buildSystemPrompt, memoryFile, repoAgentSystemPrompt } from '../memory.ts';
import { scanRepoAgents, type RepoAgentDef } from '../repo-agents.ts';
import { HookServer } from './hook-server.ts';
import type { Runner, RunnerSession } from './runner.ts';

const HQ_MCP = path.resolve(import.meta.dirname, '../mcp/hq-mcp.ts');

export interface Workspace {
  /** Local checkout of the project. */
  repoPath: string;
  git: boolean;
}

function slug(s: string) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
}

/**
 * Runs sessions on this machine. Used in-process by the host and inside
 * `agent-hq join` on teammates' machines.
 */
export class LocalRunner implements Runner {
  readonly userId: ID;
  private readonly dataDir: string;
  /** Where managed Claude account dirs live (machine-wide on the host; the runner's own data dir with `join`). */
  private readonly accountsRoot: string;
  private readonly adapters: Map<string, AgentAdapter>;
  private readonly resolveRepo: (project: Project) => Promise<Workspace>;
  private readonly remote: boolean;
  private readonly hqUrl: string;
  private readonly hookServer = new HookServer();

  constructor(opts: {
    userId: ID;
    dataDir: string;
    /** Root of <root>/claude-accounts; defaults to dataDir. */
    accountsRoot?: string;
    adapters: AgentAdapter[];
    resolveRepo: (project: Project) => Promise<Workspace>;
    remote: boolean;
    /** How this machine reaches the host, for the agents' HQ MCP tools. */
    hqUrl: string;
  }) {
    this.userId = opts.userId;
    this.dataDir = opts.dataDir;
    this.accountsRoot = opts.accountsRoot ?? opts.dataDir;
    this.adapters = new Map(opts.adapters.map((a) => [a.kind, a]));
    this.resolveRepo = opts.resolveRepo;
    this.remote = opts.remote;
    this.hqUrl = opts.hqUrl;
  }

  start(start: RunnerStart, onEvent: (e: RunnerSessionEvent) => void): RunnerSession {
    // Preparing the workspace is async; buffer calls until the session exists.
    let session: AgentSession | null = null;
    let closed = false;
    const queue: Array<(s: AgentSession) => void> = [];
    const withSession = (fn: (s: AgentSession) => void) => (session ? fn(session) : queue.push(fn));
    let size: [number, number] | null = null;

    const boot = async () => {
      const { agent, project } = start;
      let { task } = start;
      const adapter = this.adapters.get(agent.adapter);
      if (!adapter) throw new Error(`No adapter for ${agent.adapter}`);

      let cwd: string;
      if (project) {
        const ws = await this.resolveRepo(project);
        cwd = ws.repoPath;
        // Read-only repo agents work in the checkout itself; everyone else gets a worktree per task.
        const isolate = !agent.repo?.readOnly;
        if (task && ws.git && isolate && !(task.worktreePath && existsSync(task.worktreePath))) {
          // The branch may have been started on another machine (a takeover, or a
          // teammate's runner): bring it from origin first.
          if (task.branch) await syncBranchFromOrigin(ws.repoPath, task.branch);
          const branch = task.branch ?? `hq/${slug(agent.name)}-${task.id.slice(0, 8)}`;
          // Short ids keep paths under Windows' MAX_PATH once git adds its own nesting.
          const worktreePath = path.join(this.dataDir, 'wt', project.id.slice(0, 8), task.id.slice(0, 8));
          await addWorktree(ws.repoPath, worktreePath, branch, !!task.branch);
          task = { ...task, branch, worktreePath };
          onEvent({ type: 'workspace', branch, worktreePath });
        }
        if (task?.worktreePath) cwd = task.worktreePath;
      } else {
        cwd = agentWorkspace(this.dataDir, agent);
      }
      if (closed) return;

      // The Claude account this agent runs on. Its sessions live in that
      // account's config dir, so a session started on another account is
      // copied over before resuming it.
      const configDir = resolveConfigDir(this.accountsRoot, start.configDir);
      let resumeSessionId = task?.sessionId ?? null;
      if (resumeSessionId && !ensureSessionInConfigDir(this.accountsRoot, resumeSessionId, configDir)) {
        onEvent({ type: 'transcript', kind: 'system', text: 'The previous conversation is not on this machine; starting a new one.' });
        resumeSessionId = null;
      }

      const hqArgs = [HQ_MCP, '--url', this.hqUrl, '--token', start.hq.token, ...(start.hq.manager ? ['--manager'] : [])];
      const hookUrl = await this.hookServer.url();
      // Repo agents bring their own definition (prompt, tools, model): no notes, board tools or integrations.
      const repoAgent = start.repoAgentName && project ? start.repoAgentName : null;
      const memoryPath = repoAgent ? null : memoryFile(this.dataDir, agent, project);
      session = adapter.start(
        {
          cwd,
          model: agent.model,
          permissionMode: agent.permissionMode,
          systemPrompt: memoryPath
            ? buildSystemPrompt({ agent, project, task, memoryPath, remote: this.remote })
            : repoAgentSystemPrompt({ agent, project: project!, task, remote: this.remote }),
          resumeSessionId,
          configDir,
          addDirs: memoryPath ? [path.dirname(memoryPath)] : [],
          mcpServers: repoAgent ? {} : {
            'agent-hq': { type: 'stdio', command: process.execPath, args: ['--no-warnings', ...hqArgs] },
            ...Object.fromEntries(Object.entries(start.mcpServers).map(([k, v]) => [k, platformMcpConfig(v as Record<string, unknown>)])),
          },
          agentName: repoAgent,
          initialPrompt: start.prompt,
          hooks: { url: hookUrl, register: (handler) => this.hookServer.register(handler) },
        },
        onEvent,
      );
      if (size) session.resize(...size);
      for (const fn of queue.splice(0)) fn(session);
    };

    boot().catch((err) => {
      onEvent({ type: 'transcript', kind: 'error', text: `Could not start: ${(err as Error).message}` });
      onEvent({ type: 'exit', code: null, error: (err as Error).message });
    });

    return {
      send: (text) => withSession((s) => s.send(text)),
      interrupt: () => withSession((s) => s.interrupt()),
      respondPermission: (requestId, decision: PermissionDecision) => withSession((s) => s.respondPermission(requestId, decision)),
      write: (data) => session?.write(data),
      resize: (cols, rows) => { size = [cols, rows]; session?.resize(cols, rows); },
      close: async () => {
        closed = true;
        if (session) await session.close();
      },
    };
  }

  async scanAgents(project: Project): Promise<RepoAgentDef[]> {
    const ws = await this.resolveRepo(project);
    return scanRepoAgents(ws.repoPath);
  }

  async cleanup(project: Project, task: Task): Promise<boolean> {
    if (!task.worktreePath || !existsSync(task.worktreePath)) return true;
    const ws = await this.resolveRepo(project).catch(() => null);
    return ws ? removeWorktree(ws.repoPath, task.worktreePath) : false;
  }

  // ------------------------------------------------------------------ Claude accounts

  accountStatus(configDirs: Array<string | null>): Promise<AccountStatus[]> {
    return Promise.all(configDirs.map((dir) => accountStatus(this.accountsRoot, dir)));
  }

  accountLogin(_key: string, configDir: string, onEvent: (e: RunnerSessionEvent) => void): RunnerSession {
    return startAccountLogin(this.accountsRoot, configDir, onEvent);
  }

  accountRemove(configDir: string, email: string | null): Promise<AccountRemoval> {
    return removeAccount(this.accountsRoot, configDir, email);
  }

  async handoff(project: Project, task: Task): Promise<HandoffResult> {
    const notesFile = task.assigneeId ? path.join(this.dataDir, 'memory', task.assigneeId, `${project.id}.md`) : null;
    const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : null;
    if (!task.branch) return { branch: null, committed: false, pushed: false, head: null, notes, error: null };
    const ws = await this.resolveRepo(project);
    if (!ws.git) return { branch: task.branch, committed: false, pushed: false, head: null, notes, error: 'not a git repository' };
    const worktree = task.worktreePath && existsSync(task.worktreePath) ? task.worktreePath : null;
    const result = await handoffBranch(ws.repoPath, worktree, task.branch, `WIP: hand off "${task.title}" (Agent HQ takeover)`);
    return { ...result, notes };
  }
}
