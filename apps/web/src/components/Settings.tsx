import { useEffect, useState } from 'react';
import type { Integration, Invite, Snapshot } from '@agent-hq/protocol';
import { client, run } from '../api.ts';
import { AccountsPanel } from './Accounts.tsx';
import { COLORS, LookPicker } from './forms.tsx';
import { Modal } from './Modal.tsx';

type Tab = 'general' | 'integrations' | 'team' | 'accounts';

function General({ world }: { world: Snapshot }) {
  const owner = world.you.role === 'owner';
  const [name, setName] = useState(world.you.name);
  const [look, setLook] = useState(world.you.appearance);
  const changeLook = (next: typeof look) => {
    setLook(next);
    run('update_profile', { appearance: next }).catch(() => {});
  };
  return (
    <div className="form">
      <h3>You</h3>
      <div className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={() => run('update_profile', { name }).catch(() => {})}>Rename</button>
      </div>
      <div className="swatches">
        {COLORS.map((c) => (
          <button key={c} className={`swatch ${world.you.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => run('update_profile', { color: c }).catch(() => {})} />
        ))}
      </div>
      <h3>Your avatar</h3>
      <p className="hint">How teammates see you in the office{owner ? ' (as the boss you wear a suit)' : ''}.</p>
      <LookPicker look={look} onChange={changeLook} />
      {owner && (
        <>
          <h3>Company</h3>
          <label>Maximum agents
            <input
              type="number" min={1} max={100} defaultValue={world.settings.maxAgents}
              onBlur={(e) => run('update_settings', { patch: { maxAgents: Number(e.target.value) } }).catch(() => {})}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={world.settings.dispatchMode === 'auto'}
              onChange={(e) => run('update_settings', { patch: { dispatchMode: e.target.checked ? 'auto' : 'manual' } }).catch(() => {})} />
            Auto-dispatch: idle agents pick up open tasks from their floor's projects
          </label>
          <label className="check">
            <input type="checkbox" checked={world.settings.gamification}
              onChange={(e) => run('update_settings', { patch: { gamification: e.target.checked } }).catch(() => {})} />
            Gamification: XP and levels for agents
          </label>
          <label>Taking over another player's agent
            <select value={world.settings.takeoverPolicy}
              onChange={(e) => run('update_settings', { patch: { takeoverPolicy: e.target.value as 'approval' | 'free' } }).catch(() => {})}>
              <option value="approval">Needs the approval of the player whose account runs it</option>
              <option value="free">Allowed right away</option>
            </select>
          </label>
        </>
      )}
    </div>
  );
}

function IntegrationEditor({ integration, onSave, onRemove }: { integration: Integration; onSave: (i: Integration) => void; onRemove: () => void }) {
  const [json, setJson] = useState(JSON.stringify(integration.config, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <details className="integration">
      <summary><strong>{integration.name}</strong> <span className="muted">— {integration.description}</span></summary>
      <p className="hint">Setup: {integration.setup}</p>
      <textarea rows={6} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} className="code" />
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="small" onClick={() => {
          try { onSave({ ...integration, config: JSON.parse(json) }); setError(null); } catch (e) { setError((e as Error).message); }
        }}>Save</button>
        <button className="small ghost danger" onClick={onRemove}>Remove</button>
      </div>
    </details>
  );
}

function Integrations({ world }: { world: Snapshot }) {
  const list = world.settings.integrations;
  const save = (integrations: Integration[]) => run('update_settings', { patch: { integrations } }).catch(() => {});
  const owner = world.you.role === 'owner';
  return (
    <div className="form">
      <p className="hint">
        Integrations are MCP servers you can give to individual agents (edit an agent to choose). They run on the machine of
        the agent's owner and are entirely optional — Agent HQ only needs Node and Claude Code. The config is a Claude Code
        <code> mcpServers</code> entry.
      </p>
      {list.map((i, idx) => (
        owner ? (
          <IntegrationEditor
            key={i.id}
            integration={i}
            onSave={(next) => save(list.map((x, j) => (j === idx ? next : x)))}
            onRemove={() => save(list.filter((_, j) => j !== idx))}
          />
        ) : (
          <div key={i.id} className="integration"><strong>{i.name}</strong> <span className="muted">— {i.setup}</span></div>
        )
      ))}
      {owner && (
        <button className="ghost" onClick={() => {
          const name = window.prompt('Integration name');
          if (!name) return;
          const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          save([...list, { id, name, description: 'Custom MCP server', setup: 'Edit the config below.', config: { type: 'stdio', command: '', args: [] } }]);
        }}>+ Add custom MCP server</button>
      )}
    </div>
  );
}

function Team({ world }: { world: Snapshot }) {
  const owner = world.you.role === 'owner';
  const [invites, setInvites] = useState<Invite[]>([]);
  const reload = () => { if (owner) client.request('list_invites', {}).then(setInvites).catch(() => {}); };
  useEffect(reload, [owner]);
  const hostUrl = `${location.protocol}//${location.hostname}:${location.port === '5173' ? '4317' : location.port}`;

  return (
    <div className="form">
      <h3>Players</h3>
      <ul className="people">
        {world.users.map((u) => (
          <li key={u.id}>
            <span className="dot" style={{ background: u.color }} />
            <strong>{u.name}</strong> <span className="chip">{u.role === 'owner' ? '👑 Boss' : 'Manager'}</span>
            <span className="muted"> {u.online ? 'online' : 'offline'} · agents {u.runnerOnline ? 'can work' : 'offline (runner not connected)'}</span>
            {owner && u.role !== 'owner' && (
              <button className="small ghost danger" onClick={() => run('remove_member', { id: u.id }).catch(() => {})}>Remove</button>
            )}
          </li>
        ))}
      </ul>

      {world.you.role === 'manager' && (
        <div className="callout">
          <strong>Run your agents.</strong> Your agents work on <em>your</em> machine with <em>your</em> Claude Code logins
          (connect more in the Claude accounts tab).
          With Agent HQ cloned and installed, run:
          <pre>node packages/core/src/index.ts join {hostUrl} --token {client.token}</pre>
          Add <code>--repo "Project name=C:\path\to\clone"</code> to use an existing checkout; otherwise projects with a git remote are cloned automatically.
        </div>
      )}

      {owner && (
        <>
          <h3>Invites</h3>
          <p className="hint">
            Teammates need to reach this machine: start the host with <code>--host 0.0.0.0</code> on your LAN, or put it behind a
            tunnel. Each teammate's agents run on their own computer and Claude subscription.
          </p>
          <button onClick={() => {
            const name = window.prompt('Teammate name');
            if (name) client.request('create_invite', { name }).then(reload).catch(() => {});
          }}>+ Invite a manager</button>
          <ul className="people">
            {invites.map((i) => (
              <li key={i.id}>
                <strong>{i.name}</strong> <span className="muted">{i.usedBy ? 'joined' : 'pending'}</span>
                <input readOnly value={`${hostUrl}/?token=${i.token}`} onFocus={(e) => e.target.select()} />
                <button className="small ghost danger" onClick={() => client.request('revoke_invite', { id: i.id }).then(reload).catch(() => {})}>Revoke</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function SettingsModal({ world, onClose, initial = 'general' }: { world: Snapshot; onClose: () => void; initial?: Tab }) {
  const [tab, setTab] = useState<Tab>(initial);
  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="tabs inline">
        <button className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>General</button>
        <button className={tab === 'integrations' ? 'active' : ''} onClick={() => setTab('integrations')}>Integrations</button>
        <button className={tab === 'team' ? 'active' : ''} onClick={() => setTab('team')}>Team</button>
        <button className={tab === 'accounts' ? 'active' : ''} onClick={() => setTab('accounts')}>Claude accounts</button>
      </div>
      {tab === 'general' && <General world={world} />}
      {tab === 'integrations' && <Integrations world={world} />}
      {tab === 'team' && <Team world={world} />}
      {tab === 'accounts' && <AccountsPanel world={world} />}
    </Modal>
  );
}
