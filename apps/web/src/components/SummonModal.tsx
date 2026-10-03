import { useState } from 'react';
import type { ID, Snapshot } from '@agent-hq/protocol';
import { client, run } from '../api.ts';
import { FormModal, Modal } from './Modal.tsx';

const EXAMPLE_AGENT = `---
name: reviewer
description: Reviews the latest changes for bugs
tools: Read, Grep, Glob
---
You are a careful code reviewer…`;

/** The balcony with nobody on it: where its crew comes from, and a way to look again. */
export function EmptyBalconyModal(props: { world: Snapshot; floorId: ID; onClose: () => void; onAddProject: (() => void) | null }) {
  const projects = props.world.projects.filter((p) => p.floorId === props.floorId);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const rescan = async () => {
    setScanning(true);
    setResult(null);
    const found = await Promise.allSettled(projects.map((p) => run('scan_repo_agents', { projectId: p.id })));
    const crew = found.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    setScanning(false);
    if (crew.length) props.onClose(); // they walk out onto the balcony
    else if (found.some((r) => r.status === 'fulfilled')) setResult('Still no agents: no definitions found in .claude/agents/.');
  };
  return (
    <Modal title="🚬 The balcony" subtitle="Where this floor's repo agents hang out" onClose={props.onClose}>
      <div className="form balcony-howto">
        {projects.length ? (
          <>
            <p className="callout">
              No balcony agents yet. Add agent definitions to <code>.claude/agents/</code> in this floor's project repo
              {projects.length > 1 ? 's' : ''} ({projects.map((p) => p.name).join(', ')}), then re-scan.
            </p>
            <p className="hint">Each one is a Claude Code subagent: a Markdown file such as <code>.claude/agents/reviewer.md</code>:</p>
            <pre>{EXAMPLE_AGENT}</pre>
            <p className="hint">Summoned agents walk to a hot desk out here, do the job and mail you a report.</p>
          </>
        ) : (
          <p className="callout">
            This floor has no project yet. Add one; the agents its repository defines in <code>.claude/agents/</code> come out
            here, ready to be summoned.
          </p>
        )}
        {result && <p className="hint">{result}</p>}
        <footer className="form-actions">
          <button type="button" className="ghost" onClick={props.onClose}>Close</button>
          {projects.length ? (
            <button type="button" onClick={rescan} disabled={scanning}>{scanning ? 'Reading…' : '↻ Re-scan'}</button>
          ) : props.onAddProject ? (
            <button type="button" onClick={props.onAddProject}>Add a project</button>
          ) : null}
        </footer>
      </div>
    </Modal>
  );
}

/** Call a repo agent in from the balcony: it walks to a hot desk, works, and mails you a report. */
export function SummonModal(props: { world: Snapshot; agentId: ID; onClose: () => void; onOpenAgent: (id: ID) => void }) {
  const { world } = props;
  const agent = world.agents.find((a) => a.id === props.agentId);
  const [rescanning, setRescanning] = useState(false);
  if (!agent?.repo) return null;
  const repo = agent.repo;
  const project = world.projects.find((p) => p.id === repo.projectId);
  const free = (repo.location === 'balcony' || repo.location === 'to_balcony') && !agent.live;
  const boss = world.users.find((u) => u.id === repo.invokedBy);

  const about = (
    <>
      <p className="summon-about">{repo.description || 'No description.'}</p>
      <div className="row small-text">
        <span className="chip">⎇ {project?.name ?? 'project'}</span>
        <span className="chip">{repo.readOnly ? '👀 Reads only: works in the repository itself' : '✏️ Edits: works in its own git worktree and branch'}</span>
        {agent.model && <span className="chip">{agent.model}</span>}
        <span className="spacer" />
        <button
          type="button"
          className="link small"
          disabled={rescanning || !project}
          title="Re-read .claude/agents in the repository"
          onClick={() => { setRescanning(true); run('scan_repo_agents', { projectId: repo.projectId }).catch(() => {}).finally(() => setRescanning(false)); }}
        >
          {rescanning ? 'Reading…' : '↻ Re-read agents'}
        </button>
      </div>
    </>
  );

  if (!free) {
    return (
      <Modal title={`🚬 ${agent.name}`} subtitle="Repo agent on the balcony" onClose={props.onClose}>
        <div className="form">
          {about}
          <p className="callout">{agent.name} is working{boss ? ` for ${boss.name}` : ''} right now{agent.activity ? `: ${agent.activity}` : ''}. Try again when they're back on the balcony.</p>
          <footer>
            {agent.live && <button className="ghost" onClick={() => { props.onClose(); props.onOpenAgent(agent.id); }}>Watch their screen</button>}
            <button onClick={props.onClose}>OK</button>
          </footer>
        </div>
      </Modal>
    );
  }

  return (
    <FormModal
      title={`🚬 Summon ${agent.name}`}
      subtitle={`Repo agent from ${project?.name ?? 'this project'}'s .claude/agents`}
      submitLabel="Summon"
      onClose={props.onClose}
      onSubmit={(d) => client.request('invoke_repo_agent', { agentId: agent.id, prompt: String(d.get('prompt') ?? '').trim() })}
    >
      {about}
      <label>What should {agent.name} do?
        <textarea name="prompt" rows={5} required autoFocus placeholder="Describe the job. The answer comes back as a report in your inbox." />
      </label>
      <p className="hint">
        Runs on your machine with your Claude Code login. When done, {agent.name} mails a report to your inbox on the boss computer
        and goes back to the balcony; reply there to keep the conversation going.
      </p>
    </FormModal>
  );
}
