import type { Agent, Task, TranscriptEntry } from '@agent-hq/protocol';
import type { HandoffResult } from './git.ts';
import { taskPrompt } from './memory.ts';

// The first prompt of a session that takes over another player's work. The
// previous session's conversation stays on its machine and account, so the
// new one gets a summary built from the transcript the host keeps, plus the
// branch (committed and pushed by the handoff) and the agent's notes.

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (truncated)` : s);

export function handoffPrompt(opts: {
  agent: Agent;
  /** null: a run outside any board task (a conversation, or a repo agent's invocation). */
  task: Task | null;
  fromName: string;
  toName: string;
  transcript: TranscriptEntry[];
  /** null: no handoff ran (no task, or the previous machine was offline). */
  handoff: HandoffResult | null;
}): string {
  const { agent, task, handoff } = opts;
  let entries = opts.transcript.filter((e) => e.taskId === (task?.id ?? null));
  if (!task) {
    // Only the current run: what came after the previous run's end.
    const lastEnd = entries.findLastIndex((e, i) => e.kind === 'result' && entries.slice(i + 1).some((x) => x.kind === 'user'));
    entries = entries.slice(lastEnd + 1).slice(-80);
  }
  const requests = entries.filter((e) => e.kind === 'user').slice(-5).map((e) => `- ${clip(e.text.trim().replace(/\s+/g, ' '), task ? 400 : 2000)}`);
  const files = [...new Set(entries
    .filter((e) => e.kind === 'tool_use')
    .map((e) => (e.meta?.input as Record<string, unknown> | undefined)?.file_path)
    .filter((f): f is string => typeof f === 'string'))].slice(-30);
  const lastReport = [...entries].reverse().find((e) => e.kind === 'text');
  const recentActivity = entries.filter((e) => e.kind === 'tool_use').slice(-12).map((e) => `- ${e.text}`);

  let workspace: string;
  if (!task) {
    workspace = agent.repo?.readOnly
      ? 'You work directly in the repository and only read it, so there is no branch to carry over.'
      : 'This run was not tied to a board task, so no branch was carried over; the previous machine\'s uncommitted changes, if any, stayed there.';
  } else if (!task.branch) {
    workspace = 'No branch was created for this task yet.';
  } else if (handoff?.pushed) {
    workspace = `The work so far is on branch \`${task.branch}\`${handoff.head ? ` (at ${handoff.head.slice(0, 10)})` : ''}, which you are on now.`
      + (handoff.committed ? ' Uncommitted changes were saved in a "WIP: hand off" commit; feel free to amend or squash it.' : '');
  } else if (!handoff) {
    workspace = `The previous machine was offline, so only what was already pushed to \`${task.branch}\` on origin carried over. Recent uncommitted work may be missing: check the branch and redo what is needed.`;
  } else {
    workspace = `The branch \`${task.branch}\` could not be pushed from the previous machine${handoff.error ? ` (${clip(handoff.error, 300)})` : ''}. Check what is on the branch here before continuing.`;
  }
  const review = task?.branch ? '\nStart by reviewing the state: `git status`, `git log --oneline -15` and the diff of this branch against its base.' : '';

  return [
    task ? '# Handoff: you are taking over this task' : '# Handoff: you are taking over this run',
    `${opts.toName} took over this work from ${opts.fromName}. The previous session ran on ${opts.fromName}'s machine and Claude account; you continue it on ${opts.toName}'s. Pick up where it stopped.`,
    task ? taskPrompt(task) : '',
    `## Workspace\n${workspace}${review}`,
    requests.length ? `## ${task ? 'Requests from the lead so far' : 'What you were asked'}\n${requests.join('\n')}` : '',
    files.length ? `## Files touched so far\n${files.map((f) => `- ${f}`).join('\n')}` : '',
    recentActivity.length ? `## Last steps of the previous session\n${recentActivity.join('\n')}` : '',
    lastReport ? `## Last message of the previous session\n${clip(lastReport.text.trim(), 3000)}` : '',
    handoff?.notes?.trim() ? `## Notes the agent kept on the previous machine\n${clip(handoff.notes.trim(), 4000)}` : '',
    task
      ? 'Continue the task. When you finish, reply with a brief summary of what you did and anything the lead should review.'
      : 'Continue where the previous session stopped. When you finish, reply with your final report.',
  ].filter(Boolean).join('\n\n');
}
