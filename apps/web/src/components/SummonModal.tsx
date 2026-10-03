import { useState } from 'react';
import type { ID, Snapshot } from '@agent-hq/protocol';
import { client, run } from '../api.ts';
import { FormModal, Modal } from './Modal.tsx';

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
      <Modal title={`🚬 ${agent.name}`} onClose={props.onClose}>
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
