import { useEffect, useState } from 'react';
import type { Integration, Invite, Snapshot } from '@agent-hq/protocol';
import { client, run } from '../api.ts';
import { AccountsPanel } from './Accounts.tsx';
import { ControlsSettings } from './ControlsSettings.tsx';
import { ago, initials, stamp } from '../format.ts';
import { COLORS, LookPicker } from './forms.tsx';
import { Modal } from './Modal.tsx';

type Tab = 'general' | 'controls' | 'integrations' | 'team' | 'accounts';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'general', label: '⚙️ General' },
  { id: 'controls', label: '🎮 Controls' },
  { id: 'integrations', label: '🔌 Integrations' },
  { id: 'team', label: '👥 Team' },
  { id: 'accounts', label: '🔑 Claude accounts' },
];

function General({ world }: { world: Snapshot }) {
  const owner = world.you.role === 'owner';
  const [name, setName] = useState(world.you.name);
  const [look, setLook] = useState(world.you.appearance);
  const changeLook = (next: typeof look) => {
    setLook(next);
    run('update_profile', { appearance: next }).catch(() => {});
  };
  return (
    <div className="form settings-grid">
      <section className="card-section">
        <h3>You</h3>
        <label>Display name
          <div className="row nowrap">
            <input value={name} onChange={(e) => setName(e.target.value)} />
            <button type="button" disabled={!name.trim() || name === world.you.name} onClick={() => run('update_profile', { name }).catch(() => {})}>Rename</button>
          </div>
        </label>
        <div className="field">
          <span className="field-label">Name tag color</span>
          <div className="swatches" role="radiogroup" aria-label="Name tag color">
            {COLORS.map((c) => (
              <button key={c} role="radio" aria-checked={world.you.color === c} aria-label={c} className={`swatch ${world.you.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => run('update_profile', { color: c }).catch(() => {})} />
            ))}
          </div>
        </div>
      </section>
      <section className="card-section">
        <h3>Your avatar</h3>
        <p className="hint">How teammates see you in the office{owner ? ' (as the boss you wear a suit)' : ''}.</p>
        <LookPicker look={look} onChange={changeLook} />
      </section>
      {owner && (
        <section className="card-section span2">
          <h3>Company</h3>
          <label className="toggle">
            <input type="checkbox" role="switch" checked={world.settings.dispatchMode === 'auto'}
              onChange={(e) => run('update_settings', { patch: { dispatchMode: e.target.checked ? 'auto' : 'manual' } }).catch(() => {})} />
            <span><strong>Auto-dispatch</strong><small>Idle agents pick up unassigned tasks from their floor's projects.</small></span>
          </label>
          <label className="toggle">
            <input type="checkbox" role="switch" checked={world.settings.gamification}
              onChange={(e) => run('update_settings', { patch: { gamification: e.target.checked } }).catch(() => {})} />
            <span><strong>Gamification</strong><small>Agents earn XP and level up as they finish turns.</small></span>
          </label>
          <label className="inline-field">
            <span><strong>Maximum agents</strong><small>{world.agents.length} hired across the company.</small></span>
            <input
              type="number" min={1} max={100} defaultValue={world.settings.maxAgents}
              onBlur={(e) => run('update_settings', { patch: { maxAgents: Number(e.target.value) } }).catch(() => {})}
            />
          </label>
          <label className="toggle">
            <input type="checkbox" role="switch" checked={world.settings.takeoverPolicy === 'approval'}
              onChange={(e) => run('update_settings', { patch: { takeoverPolicy: e.target.checked ? 'approval' : 'free' } }).catch(() => {})} />
            <span>
              <strong>Takeovers need approval</strong>
              <small>Taking over another player's agent waits for the OK of the player whose Claude account runs it.</small>
            </span>
          </label>
        </section>
      )}
      {owner && <VoiceServers world={world} />}
    </div>
  );
}

/** Owner: proximity radius and the STUN/TURN servers players' browsers use to reach each other. */
function VoiceServers({ world }: { world: Snapshot }) {
  const v = world.settings.voice;
  const [stun, setStun] = useState(v.stunUrls.join('\n'));
  const [turnUrl, setTurnUrl] = useState(v.turnUrl ?? '');
  const [turnUsername, setTurnUsername] = useState(v.turnUsername ?? '');
  const [turnCredential, setTurnCredential] = useState('');
  const [radius, setRadius] = useState(String(v.proximityRadius));
  const [saved, setSaved] = useState(false);
  const save = () => {
    setSaved(false);
    run('set_voice_settings', {
      stunUrls: stun.split(/[\s,]+/).filter(Boolean),
      turnUrl: turnUrl.trim() || null,
      turnUsername: turnUsername.trim() || null,
      // Empty keeps the stored credential; clearing the TURN URL clears it too.
      ...(turnCredential ? { turnCredential } : !turnUrl.trim() ? { turnCredential: null } : {}),
      proximityRadius: Number(radius),
    }).then(() => { setTurnCredential(''); setSaved(true); }).catch(() => {});
  };
  return (
    <section className="card-section span2">
      <h3>Voice &amp; screen sharing</h3>
      <p className="hint">
        Players talk and share screens peer to peer (WebRTC, every player connected to every other: comfortable up to
        about 8 people). STUN lets browsers find each other; players behind strict NATs or corporate firewalls also need a
        TURN relay. The TURN credential is kept on this machine and only handed to players when they join voice.
      </p>
      <label className="inline-field">
        <span><strong>Proximity radius</strong><small>Beyond this distance (meters) you can't hear someone nearby.</small></span>
        <input type="number" min={2} max={50} step={0.5} value={radius} onChange={(e) => setRadius(e.target.value)} />
      </label>
      <label>STUN servers <small className="muted">(one per line)</small>
        <textarea rows={2} className="code" value={stun} onChange={(e) => setStun(e.target.value)} placeholder="stun:stun.l.google.com:19302" spellCheck={false} />
      </label>
      <div className="grid2">
        <label>TURN server
          <input value={turnUrl} onChange={(e) => setTurnUrl(e.target.value)} placeholder="turn:turn.example.com:3478" spellCheck={false} />
        </label>
        <label>TURN username
          <input value={turnUsername} onChange={(e) => setTurnUsername(e.target.value)} autoComplete="off" />
        </label>
      </div>
      <label>TURN credential
        <input type="password" value={turnCredential} onChange={(e) => setTurnCredential(e.target.value)} autoComplete="new-password"
          placeholder={v.turnCredentialSet ? '•••••• stored (leave empty to keep)' : 'Not set'} />
      </label>
      <div className="row">
        <button type="button" onClick={save}>Save voice settings</button>
        {saved && <span className="hint">Saved. It applies to new voice connections.</span>}
      </div>
    </section>
  );
}

function IntegrationEditor({ integration, users, onSave, onRemove }: { integration: Integration; users: number; onSave: (i: Integration) => void; onRemove: () => void }) {
  const [json, setJson] = useState(JSON.stringify(integration.config, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <details className="integration">
      <summary>
        <span className="summary-text"><strong>{integration.name}</strong><small>{integration.description}</small></span>
        <UsedBy n={users} />
      </summary>
      <p className="hint"><strong>Setup:</strong> {integration.setup}</p>
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

/** How many agents were given an integration. */
function UsedBy({ n }: { n: number }) {
  return <span className={`pill ${n ? 'status-working' : ''}`}>{n ? `${n} agent${n === 1 ? '' : 's'}` : 'Unused'}</span>;
}

function Integrations({ world }: { world: Snapshot }) {
  const usedBy = (id: string) => world.agents.filter((a) => a.integrations.includes(id)).length;
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
            users={usedBy(i.id)}
            onSave={(next) => save(list.map((x, j) => (j === idx ? next : x)))}
            onRemove={() => save(list.filter((_, j) => j !== idx))}
          />
        ) : (
          <div key={i.id} className="integration static">
            <span className="summary-text"><strong>{i.name}</strong><small>{i.description}</small><small>Setup: {i.setup}</small></span>
            <UsedBy n={usedBy(i.id)} />
          </div>
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

/** A read-only invite link with a copy button. */
function InviteLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(url).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }).catch(() => {});
  return (
    <span className="copy-field">
      <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Invite link" />
      <button className="small ghost" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
    </span>
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
      <h3>Players · {world.users.length}</h3>
      <ul className="people">
        {world.users.map((u) => {
          const agents = world.agents.filter((a) => a.ownerId === u.id).length;
          return (
            <li key={u.id}>
              <span className={`avatar ${u.online ? 'online' : ''}`} style={{ background: u.color }} aria-hidden>{initials(u.name)}</span>
              <span className="person">
                <strong>{u.name}{u.id === world.you.id && <span className="muted"> (you)</span>}</strong>
                <small>{u.role === 'owner' ? '👑 Boss' : 'Manager'} · {agents} agent{agents === 1 ? '' : 's'}</small>
              </span>
              <span className={`pill ${u.online ? 'status-working' : ''}`}>{u.online ? 'Online' : 'Offline'}</span>
              <span
                className={`pill ${u.runnerOnline ? 'status-working' : 'status-offline'}`}
                title={u.runnerOnline ? 'Their agents can work' : 'No runner connected: their agents are offline'}
              >
                {u.runnerOnline ? 'Agents can work' : 'Runner offline'}
              </span>
              {owner && u.role !== 'owner' && (
                <button className="small ghost danger" onClick={() => run('remove_member', { id: u.id }).catch(() => {})}>Remove</button>
              )}
            </li>
          );
        })}
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
          <div className="row">
            <button onClick={() => {
              const name = window.prompt('Teammate name');
              if (name) client.request('create_invite', { name }).then(reload).catch(() => {});
            }}>＋ Invite a manager</button>
          </div>
          {invites.length === 0 ? <p className="empty">No invites yet. Each invite is a private link for one teammate.</p> : (
            <ul className="people invites">
              {invites.map((i) => (
                <li key={i.id}>
                  <span className="person">
                    <strong>{i.name}</strong>
                    <small title={stamp(i.createdAt)}>Invited {ago(i.createdAt)}</small>
                  </span>
                  <span className={`pill ${i.usedBy ? 'status-working' : 'status-awaiting_approval'}`}>{i.usedBy ? 'Joined' : 'Pending'}</span>
                  <InviteLink url={`${hostUrl}/?token=${i.token}`} />
                  <button className="small ghost danger" onClick={() => client.request('revoke_invite', { id: i.id }).then(reload).catch(() => {})}>Revoke</button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function SettingsModal({ world, onClose, initial = 'general' }: { world: Snapshot; onClose: () => void; initial?: Tab }) {
  const [tab, setTab] = useState<Tab>(initial);
  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="tabs inline" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {tab === 'general' && <General world={world} />}
      {tab === 'controls' && <ControlsSettings />}
      {tab === 'integrations' && <Integrations world={world} />}
      {tab === 'team' && <Team world={world} />}
      {tab === 'accounts' && <AccountsPanel world={world} />}
    </Modal>
  );
}
