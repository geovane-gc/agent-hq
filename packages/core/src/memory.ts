import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Agent, Project, Task } from '@agent-hq/protocol';

const MAX_MEMORY_CHARS = 8000;

/**
 * Each agent keeps one notes file per project (plus a general one for work
 * outside projects) that survives across tasks and restarts.
 */
export function memoryFile(dataDir: string, agent: Agent, project: Project | null): string {
  const dir = path.join(dataDir, 'memory', agent.id);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${project?.id ?? 'general'}.md`);
  if (!existsSync(file)) writeFileSync(file, `# ${agent.name}'s notes${project ? ` on ${project.name}` : ''}\n\n`);
  return file;
}

/** A private scratch folder for conversations that aren't about a project. */
export function agentWorkspace(dataDir: string, agent: Agent): string {
  const dir = path.join(dataDir, 'agents', agent.id.slice(0, 8));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function buildSystemPrompt(opts: {
  agent: Agent;
  project: Project | null;
  task: Task | null;
  memoryPath: string;
  /** The agent runs on a teammate's machine: its branch must be pushed for others to see it. */
  remote: boolean;
}): string {
  const { agent, project, task, memoryPath, remote } = opts;
  let memory = readFileSync(memoryPath, 'utf8');
  if (memory.length > MAX_MEMORY_CHARS) memory = `${memory.slice(0, MAX_MEMORY_CHARS)}\n…(truncated)`;

  const finish = remote ? 'When done, push the branch to origin so the team can review it.' : 'Do not push or merge unless asked.';
  let workspace: string;
  if (!project) {
    workspace = 'You are in your own scratch folder, chatting with the lead outside any project. Ask before creating files elsewhere.';
  } else if (task?.branch) {
    workspace = `You work in a dedicated git worktree on branch \`${task.branch}\`, isolated from your teammates. Commit your work on this branch with clear messages when the task is done. ${finish}`;
  } else {
    workspace = 'You work directly in the project directory, which may be shared with teammates. Keep changes focused.';
  }

  const board = agent.isManager
    ? 'You are a coordinator. Use the agent-hq tools (list_team, list_projects, list_tasks, create_task, assign_task) to break work into well-scoped tasks and delegate them to teammates whose roles fit. Write each brief so it can be done without further context. Do work yourself only when delegating would be slower.'
    : 'You can inspect the office board with the agent-hq tools (list_team, list_projects, list_tasks).';

  return [
    `You are ${agent.name}, a ${agent.role} at Agent HQ, a virtual office where a human lead works with a team of AI agents. The lead may type to you directly in this terminal.`,
    project ? `Project: ${project.name}.` : '',
    workspace,
    board,
    'Never change global or system configuration on this machine (for example `git config --global`). If git has no identity, use `git -c user.name=... -c user.email=...` for that command or ask the lead.',
    agent.instructions.trim(),
    `Your persistent notes${project ? ' for this project' : ''} live at ${memoryPath}. Before finishing a task, update them with durable learnings (conventions, commands, pitfalls). Keep them short. Current notes:\n<notes>\n${memory}\n</notes>`,
    task ? 'When you finish the task, reply with a brief summary of what you did and anything the lead should review.' : '',
  ].filter(Boolean).join('\n\n');
}

/**
 * Appended to a repo agent's own definition (`claude --agent`): where it
 * works and that its final message is the report mailed to whoever called it.
 */
export function repoAgentSystemPrompt(opts: { agent: Agent; project: Project; task: Task | null; remote: boolean }): string {
  const { agent, project, task, remote } = opts;
  let workspace: string;
  if (task?.branch) {
    const finish = remote ? 'When done, push the branch to origin so the team can review it.' : 'Do not push or merge unless asked.';
    workspace = `You work in a dedicated git worktree on branch \`${task.branch}\`. Commit your changes on this branch with clear messages before you finish. ${finish}`;
  } else {
    workspace = 'You work directly in the project checkout, which teammates share. Do not modify files.';
  }
  return [
    `You were called in to Agent HQ, a virtual office, to work on ${project.name} as the "${agent.repo?.agentName ?? agent.name}" agent defined in this repository.`,
    workspace,
    'Never change global or system configuration on this machine (for example `git config --global`).',
    'Work autonomously. Your final message of each turn is delivered as an e-mail report to the person who called you, who may reply with follow-up requests: make it a complete, self-contained report (what you did or found, and anything they should review), written in Markdown.',
  ].join('\n\n');
}

export function taskPrompt(task: Task): string {
  return `# Task: ${task.title}\n\n${task.description || '(no further description)'}`;
}
