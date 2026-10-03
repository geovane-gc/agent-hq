import { useEffect, useState } from 'react';
import type { Agent, Appearance, Building, BuildingKind, Commands, FacadeMaterial, Floor, ID, PermissionMode, Snapshot } from '@agent-hq/protocol';
import { FACADES, HAIR_COLORS, HAIR_STYLES, PALETTE, SKIN_TONES } from '@agent-hq/protocol/catalog';
import { COORDINATOR, MODELS } from '../agentUtil.ts';
import { client, pickFolder } from '../api.ts';
import { randomAgentName } from '../names.ts';
import { assignBlocked } from './Accounts.tsx';
import { HiringFeeNote } from './Finance.tsx';
import { FormModal } from './Modal.tsx';

const str = (d: FormData, k: string) => String(d.get(k) ?? '').trim();

export const PERMISSION_MODES: Array<{ value: PermissionMode; label: string }> = [
  { value: 'manual', label: 'Ask me before sensitive actions' },
  { value: 'acceptEdits', label: 'Auto-accept file edits' },
  { value: 'auto', label: 'Auto mode (Claude decides what is safe)' },
  { value: 'plan', label: 'Plan only (read-only)' },
  { value: 'bypassPermissions', label: 'Bypass all checks (sandboxes only)' },
];

export const ROLE_PRESETS = ['Full-stack developer', 'Frontend developer', 'Backend developer', 'QA engineer', 'Tech lead', 'DevOps engineer', 'Game developer', '3D artist', 'UI designer'];
export const COLORS = [...PALETTE, '#5b6170'];

function Swatches(props: { colors: string[]; value: string; onChange: (c: string) => void }) {
  return (
    <div className="swatches" role="radiogroup">
      {props.colors.map((c) => (
        <button type="button" key={c} role="radio" aria-checked={c === props.value} className={`swatch ${c === props.value ? 'on' : ''}`} style={{ background: c }} onClick={() => props.onChange(c)} aria-label={c} />
      ))}
    </div>
  );
}

/** Skin, hair, shirt and hairstyle swatches; used for agents and for your own avatar. */
export function LookPicker({ look, onChange }: { look: Appearance; onChange: (look: Appearance) => void }) {
  return (
    <div className="look">
      <span>Skin</span><Swatches colors={SKIN_TONES} value={look.skin} onChange={(skin) => onChange({ ...look, skin })} />
      <span>Hair</span><Swatches colors={HAIR_COLORS} value={look.hair} onChange={(hair) => onChange({ ...look, hair })} />
      <span>Shirt</span><Swatches colors={COLORS} value={look.shirt} onChange={(shirt) => onChange({ ...look, shirt })} />
      <span>Style</span>
      <div className="row">
        {HAIR_STYLES.map((s) => (
          <button type="button" key={s} className={`small ${look.hairStyle === s ? '' : 'ghost'}`} onClick={() => onChange({ ...look, hairStyle: s })}>{s}</button>
        ))}
        <button type="button" className="small ghost" onClick={() => onChange(randomAppearance())} aria-label="Random look" title="Random look">🎲</button>
      </div>
    </div>
  );
}

function randomAppearance(): Appearance {
  const pick = <T,>(l: T[]) => l[Math.floor(Math.random() * l.length)];
  return { skin: pick(SKIN_TONES), hair: pick(HAIR_COLORS), shirt: pick(COLORS), hairStyle: pick(HAIR_STYLES) };
}

/** Hire a new agent, or edit an existing one when `agent` is given. */
export function AgentModal(props: { world: Snapshot; floorId: ID; agent?: Agent; onClose: () => void }) {
  const { agent, world } = props;
  const [look, setLook] = useState<Appearance>(agent?.appearance ?? randomAppearance());
  const [integrations, setIntegrations] = useState<ID[]>(agent?.integrations ?? []);
  const toggle = (id: ID) => setIntegrations((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  // New hires start with a suggestion; every name in the company counts as taken.
  const taken = world.agents.filter((a) => a.id !== agent?.id).map((a) => a.name);
  const [name, setName] = useState(() => agent?.name ?? randomAgentName(taken));

  return (
    <FormModal
      title={agent ? `Edit ${agent.name}` : 'Recruit an agent'}
      subtitle={agent ? undefined : 'A Claude Code session with its own desk, worktree and memory.'}
      submitLabel={agent ? 'Save' : 'Hire'}
      onClose={props.onClose}
      onSubmit={(d) => {
        const fields = {
          name: str(d, 'name') || randomAgentName(taken),
          role: str(d, 'role'),
          model: str(d, 'model') || null,
          instructions: str(d, 'instructions'),
          permissionMode: str(d, 'permissionMode') as PermissionMode,
          isManager: d.get('isManager') === 'on',
          integrations,
          appearance: look,
        };
        return agent
          ? client.request('update_agent', { id: agent.id, patch: fields })
          : client.request('hire_agent', { ...fields, floorId: props.floorId });
      }}
    >
      {!agent && <HiringFeeNote world={world} />}
      <div className="grid2">
        <label>Name
          <span className="input-with-btn">
            <input name="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Leave empty for a random name" />
            <button type="button" className="icon-btn" onClick={() => setName(randomAgentName([...taken, name]))} aria-label="Random name" title="Random name">🎲</button>
          </span>
        </label>
        <label>Role
          <input name="role" required list="roles" defaultValue={agent?.role} placeholder="Full-stack developer" />
          <datalist id="roles">{ROLE_PRESETS.map((r) => <option key={r} value={r} />)}</datalist>
        </label>
      </div>
      <fieldset>
        <legend>Look</legend>
        <LookPicker look={look} onChange={setLook} />
      </fieldset>
      <details className="advanced" open={!!agent}>
        <summary>Advanced <span className="muted">· model, permissions, {COORDINATOR.label.toLowerCase()}, integrations, instructions</span></summary>
          <div className="grid2">
          <label>Model
            <select name="model" defaultValue={agent?.model ?? ''}>
              {MODELS.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </optgroup>
              ))}
              {/* Keep a model typed in before this list existed instead of silently dropping it. */}
              {agent?.model && !MODELS.some((g) => g.options.some((o) => o.value === agent.model)) && (
                <optgroup label="Current"><option value={agent.model}>{agent.model}</option></optgroup>
              )}
            </select>
          </label>
          <label>Permissions
            <select name="permissionMode" defaultValue={agent?.permissionMode ?? 'manual'}>
              {PERMISSION_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" name="isManager" defaultChecked={agent?.isManager} />
          <span><strong>{COORDINATOR.label}</strong> <span className="muted">· {COORDINATOR.help}</span></span>
        </label>
        <fieldset>
          <legend>Integrations (optional MCP servers)</legend>
          {world.settings.integrations.map((i) => (
            <label key={i.id} className="check" title={i.setup}>
              <input type="checkbox" checked={integrations.includes(i.id)} onChange={() => toggle(i.id)} />
              <span><strong>{i.name}</strong> <span className="muted">— {i.description}</span></span>
            </label>
          ))}
          <p className="hint">Each integration may need setup on the machine that runs this agent. See Settings → Integrations.</p>
        </fieldset>
        <label>Instructions<textarea name="instructions" rows={3} defaultValue={agent?.instructions} placeholder="Extra guidance: style, focus areas, things to avoid…" /></label>
      </details>
    </FormModal>
  );
}

type GithubStatus = Commands['get_github_status']['result'];

/** Where gh gets its GitHub login, with a way to save a token when it has none. */
function GithubAccount() {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [token, setToken] = useState('');
  const refresh = () => client.request('get_github_status', {}).then(setStatus, () => {});
  useEffect(() => { refresh(); }, []);
  if (!status) return <p className="hint">Checking your GitHub login…</p>;
  if (status.configured) {
    const via = { gh: 'the GitHub CLI', env: 'GITHUB_TOKEN', settings: 'the saved token' }[status.source ?? 'gh'];
    return <p className="hint">✓ GitHub: {status.login ? <>signed in as <strong>{status.login}</strong></> : 'token set'} (via {via}).</p>;
  }
  return (
    <div className="callout github-login">
      <span>
        GitHub isn't connected. Install the <a href="https://cli.github.com" target="_blank" rel="noreferrer">GitHub CLI</a> and
        run <code>gh auth login</code> (the boss terminal works), or paste a token with the <code>repo</code> scope:
      </span>
      <div className="row">
        <input type="password" value={token} placeholder="ghp_… or github_pat_…" onChange={(e) => setToken(e.target.value)} />
        <button
          type="button"
          className="small"
          disabled={!token.trim()}
          onClick={() => client.request('set_github_token', { token }).then(() => { setToken(''); refresh(); }, (e) => window.dispatchEvent(new CustomEvent('hq-error', { detail: e.message })))}
        >
          Save
        </button>
        <button type="button" className="small ghost" onClick={refresh}>Check again</button>
      </div>
    </div>
  );
}

/**
 * A folder on the machine that runs your agents: typed, or chosen with the
 * system's folder dialog (the desktop app's own, or one the host opens).
 */
function FolderField(props: { label: string; value: string; onChange: (path: string) => void; placeholder: string }) {
  const [picking, setPicking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const browse = async () => {
    setPicking(true);
    setProblem(null);
    try {
      const chosen = await pickFolder(props.value.trim() || undefined);
      if (chosen) props.onChange(chosen);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setPicking(false);
    }
  };
  return (
    <label>{props.label}
      <span className="input-with-btn">
        <input required value={props.value} onChange={(e) => props.onChange(e.target.value)} placeholder={props.placeholder} spellCheck={false} autoComplete="off" />
        <button type="button" className="ghost browse" onClick={browse} disabled={picking}>{picking ? 'Choosing…' : 'Browse…'}</button>
      </span>
      {picking && !window.agentHQ && <span className="hint folder-note">Choose a folder in the dialog that just opened (it may be behind this window).</span>}
      {problem && <span className="hint folder-note">{problem}</span>}
    </label>
  );
}

/** `folder` inside `parent`, with the parent's own separator; `parent` itself when it already is that folder. */
function joinFolder(parent: string, folder: string): string {
  const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/';
  const base = parent.replace(/[\\/]+$/, '');
  if (!folder || base.split(/[\\/]/).pop() === folder) return parent;
  return `${base}${sep}${folder}`;
}

/** Every project is a GitHub repository: an existing clone, or a new repository created from here. */
export function NewProjectModal(props: { floorId: ID; note?: string; onClose: () => void }) {
  const [mode, setMode] = useState<'link' | 'create'>('link');
  const [name, setName] = useState('');
  const [repoName, setRepoName] = useState<string | null>(null);
  const [clone, setClone] = useState('');
  const [parent, setParent] = useState('');
  const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const repo = repoName ?? slug(name);
  // A new repository gets its own folder, named after it, inside the chosen one.
  const target = parent.trim() ? joinFolder(parent.trim(), repo.split('/').pop() ?? '') : '';
  return (
    <FormModal
      title="New project"
      subtitle="Every project is a GitHub repository"
      submitLabel={mode === 'create' ? 'Create repository & project' : 'Add project'}
      onClose={props.onClose}
      onSubmit={(d) => client.request('create_project', {
        name: str(d, 'name'),
        repoPath: mode === 'create' ? target : clone.trim(),
        floorId: props.floorId,
        createGithubRepo: mode === 'create' ? { name: str(d, 'repoName'), private: d.get('private') === 'on' } : null,
      })}
    >
      {props.note && <p className="callout">{props.note}</p>}
      <div className="tabs inline segmented" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'link'} className={mode === 'link' ? 'active' : ''} onClick={() => setMode('link')}>Link a GitHub clone</button>
        <button type="button" role="tab" aria-selected={mode === 'create'} className={mode === 'create' ? 'active' : ''} onClick={() => setMode('create')}>Create a new GitHub repository</button>
      </div>
      <label>Name<input name="name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
      {mode === 'link' ? (
        <>
          <FolderField label="Local folder" value={clone} onChange={setClone} placeholder="C:\dev\my-app or ~/dev/my-app" />
          <p className="hint">The root of a git repository whose <code>origin</code> is on GitHub, for example a clone of it.</p>
        </>
      ) : (
        <>
          <div className="grid2">
            <label>Repository name
              <input name="repoName" required value={repo} onChange={(e) => setRepoName(e.target.value)} placeholder="my-app or my-org/my-app" />
            </label>
            <label className="check"><input type="checkbox" name="private" defaultChecked /> Private</label>
          </div>
          <FolderField label="Create in" value={parent} onChange={setParent} placeholder="C:\dev or ~/dev" />
          <p className="hint">
            {target ? <>The project goes in <code>{target}</code>, created if it doesn't exist. </> : null}
            Agent HQ initializes git there if needed, creates the repository with <code>gh repo create</code>, makes it
            the <code>origin</code> and pushes.
          </p>
          <GithubAccount />
        </>
      )}
      <p className="hint">Agents defined in the repository's <code>.claude/agents</code> show up on the balcony, ready to be summoned.</p>
    </FormModal>
  );
}

export function NewTaskModal(props: { world: Snapshot; projectIds: ID[]; assigneeId?: ID; onClose: () => void }) {
  const projects = props.world.projects.filter((p) => props.projectIds.includes(p.id));
  return (
    <FormModal
      title={props.assigneeId ? `New task for ${props.world.agents.find((a) => a.id === props.assigneeId)?.name ?? 'agent'}` : 'New task'}
      submitLabel="Add to board"
      onClose={props.onClose}
      onSubmit={(d) => client.request('create_task', {
        projectId: str(d, 'projectId'),
        title: str(d, 'title'),
        description: str(d, 'description'),
        assigneeId: str(d, 'assigneeId') || null,
      })}
    >
      <label>Project
        <select name="projectId" required>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label>Title<input name="title" required autoFocus /></label>
      <label>Description<textarea name="description" rows={6} placeholder="What should be done, acceptance criteria, relevant files…" /></label>
      <label>Assignee
        <select name="assigneeId" defaultValue={props.assigneeId ?? ''}>
          <option value="">{props.world.settings.dispatchMode === 'auto' ? 'Anyone free on the floor (auto)' : 'Unassigned'}</option>
          {props.world.agents.filter((a) => a.kind !== 'repo').map((a) => {
            const why = assignBlocked(props.world, a);
            return (
              <option key={a.id} value={a.id} disabled={!!why} title={why ?? undefined}>
                {a.name} — {a.role}{a.isManager ? ` (${COORDINATOR.label.toLowerCase()})` : ''}{why ? ' · other player\'s account' : ''}
              </option>
            );
          })}
        </select>
      </label>
    </FormModal>
  );
}

const KINDS: Array<{ value: BuildingKind; label: string }> = [
  { value: 'web', label: 'Web development' },
  { value: 'desktop', label: 'Desktop development' },
  { value: 'game', label: 'Game development' },
  { value: 'custom', label: 'Custom' },
];

export function BuildingModal(props: { building?: Building; onClose: () => void }) {
  const b = props.building;
  const [color, setColor] = useState(b?.color ?? COLORS[0]);
  const [facade, setFacade] = useState<FacadeMaterial>(b?.facade ?? 'paint');
  return (
    <FormModal
      title={b ? `Edit ${b.name}` : 'New building'}
      submitLabel={b ? 'Save' : 'Build'}
      onClose={props.onClose}
      onSubmit={(d) => {
        const fields = { name: str(d, 'name'), kind: str(d, 'kind') as BuildingKind, color };
        if (!b) return client.request('create_building', fields).then((created) => client.request('update_building', { id: created.id, patch: { facade, sign: str(d, 'sign') || null } }));
        return client.request('update_building', { id: b.id, patch: { ...fields, facade, sign: str(d, 'sign') || null } });
      }}
    >
      <label>Name<input name="name" required autoFocus defaultValue={b?.name} placeholder="Game Studio" /></label>
      <label>Kind
        <select name="kind" defaultValue={b?.kind ?? 'web'}>
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </label>
      <label>Facade color<Swatches colors={COLORS} value={color} onChange={setColor} /></label>
      <label>Exterior
        <div className="row">
          {FACADES.map((f) => (
            <button type="button" key={f.id} className={`small ${facade === f.id ? '' : 'ghost'}`} onClick={() => setFacade(f.id)}>{f.name}</button>
          ))}
        </div>
      </label>
      <label>Rooftop sign
        <input name="sign" maxLength={40} defaultValue={b?.sign ?? ''} placeholder="Your company's name (the office name if empty)" />
      </label>
      {b && (
        <button type="button" className="ghost danger" onClick={() => client.request('remove_building', { id: b.id }).then(props.onClose, (e) => window.dispatchEvent(new CustomEvent('hq-error', { detail: e.message })))}>
          Demolish building
        </button>
      )}
    </FormModal>
  );
}

export function NewFloorModal(props: { buildingId: ID; onClose: () => void }) {
  return (
    <FormModal
      title="New floor"
      submitLabel="Add floor"
      onClose={props.onClose}
      onSubmit={(d) => client.request('create_floor', { buildingId: props.buildingId, name: str(d, 'name') })}
    >
      <label>Name<input name="name" required autoFocus placeholder="Backend team" /></label>
    </FormModal>
  );
}

export function FloorModal(props: { floor: Floor; world: Snapshot; onClose: () => void }) {
  const f = props.floor;
  const [desks, setDesks] = useState(f.desks);
  const seated = props.world.agents.filter((a) => a.floorId === f.id && a.kind !== 'repo').length;
  return (
    <FormModal
      title={`${f.name} settings`}
      submitLabel="Save"
      onClose={props.onClose}
      onSubmit={(d) => client.request('update_floor', { id: f.id, patch: { name: str(d, 'name'), desks } })}
    >
      <label>Name<input name="name" required defaultValue={f.name} /></label>
      <label>Workstations: {desks}
        <input type="range" min={Math.max(1, seated)} max={24} value={desks} onChange={(e) => setDesks(Number(e.target.value))} />
        <span className="hint">Expand the office to fit more agents on this floor.</span>
      </label>
      <p className="hint">Furniture, floor and wall finishes, lighting and desk upgrades are in <strong>Menu → Decorate</strong>.</p>
      <button type="button" className="ghost danger" onClick={() => client.request('remove_floor', { id: f.id }).then(props.onClose, (e) => window.dispatchEvent(new CustomEvent('hq-error', { detail: e.message })))}>
        Remove floor
      </button>
    </FormModal>
  );
}
