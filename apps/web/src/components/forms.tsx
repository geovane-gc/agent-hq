import { useEffect, useState } from 'react';
import type { Agent, Appearance, Building, BuildingKind, Commands, Floor, FloorMaterial, ID, PermissionMode, Snapshot } from '@agent-hq/protocol';
import { client } from '../api.ts';
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
export const COLORS = ['#3d63dd', '#e5484d', '#30a46c', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#ffb224', '#5b6170'];
const SKINS = ['#ffdbac', '#f1c27d', '#e0ac69', '#c68642', '#a0662f', '#8d5524'];
const HAIRS = ['#1c1c1c', '#2c1b10', '#6a4e2e', '#b8860b', '#a33b20', '#d8d8d8', '#6b4bd6'];
const HAIR_STYLES: Appearance['hairStyle'][] = ['short', 'long', 'bun', 'bald'];

function Swatches(props: { colors: string[]; value: string; onChange: (c: string) => void }) {
  return (
    <div className="swatches">
      {props.colors.map((c) => (
        <button type="button" key={c} className={`swatch ${c === props.value ? 'on' : ''}`} style={{ background: c }} onClick={() => props.onChange(c)} aria-label={c} />
      ))}
    </div>
  );
}

/** Skin, hair, shirt and hairstyle swatches; used for agents and for your own avatar. */
export function LookPicker({ look, onChange }: { look: Appearance; onChange: (look: Appearance) => void }) {
  return (
    <div className="look">
      <span>Skin</span><Swatches colors={SKINS} value={look.skin} onChange={(skin) => onChange({ ...look, skin })} />
      <span>Hair</span><Swatches colors={HAIRS} value={look.hair} onChange={(hair) => onChange({ ...look, hair })} />
      <span>Shirt</span><Swatches colors={COLORS} value={look.shirt} onChange={(shirt) => onChange({ ...look, shirt })} />
      <span>Style</span>
      <div className="row">
        {HAIR_STYLES.map((s) => (
          <button type="button" key={s} className={`small ${look.hairStyle === s ? '' : 'ghost'}`} onClick={() => onChange({ ...look, hairStyle: s })}>{s}</button>
        ))}
        <button type="button" className="small ghost" onClick={() => onChange(randomAppearance())}>🎲</button>
      </div>
    </div>
  );
}

function randomAppearance(): Appearance {
  const pick = <T,>(l: T[]) => l[Math.floor(Math.random() * l.length)];
  return { skin: pick(SKINS), hair: pick(HAIRS), shirt: pick(COLORS), hairStyle: pick(HAIR_STYLES) };
}

/** Hire a new agent, or edit an existing one when `agent` is given. */
export function AgentModal(props: { world: Snapshot; floorId: ID; agent?: Agent; onClose: () => void }) {
  const { agent, world } = props;
  const [look, setLook] = useState<Appearance>(agent?.appearance ?? randomAppearance());
  const [integrations, setIntegrations] = useState<ID[]>(agent?.integrations ?? []);
  const toggle = (id: ID) => setIntegrations((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));

  return (
    <FormModal
      title={agent ? `Edit ${agent.name}` : 'Recruit an agent'}
      submitLabel={agent ? 'Save' : 'Hire'}
      onClose={props.onClose}
      onSubmit={(d) => {
        const fields = {
          name: str(d, 'name'),
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
      <div className="grid2">
        <label>Name<input name="name" required autoFocus defaultValue={agent?.name} placeholder="Ada" /></label>
        <label>Role
          <input name="role" required list="roles" defaultValue={agent?.role} placeholder="Full-stack developer" />
          <datalist id="roles">{ROLE_PRESETS.map((r) => <option key={r} value={r} />)}</datalist>
        </label>
        <label>Model<input name="model" defaultValue={agent?.model ?? ''} placeholder="Default (opus, sonnet, haiku…)" /></label>
        <label>Permissions
          <select name="permissionMode" defaultValue={agent?.permissionMode ?? 'manual'}>
            {PERMISSION_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" name="isManager" defaultChecked={agent?.isManager} />
        Manager — plans work and delegates tasks to teammates through the board
      </label>
      <fieldset>
        <legend>Look</legend>
        <div className="look">
          <span>Skin</span><Swatches colors={SKINS} value={look.skin} onChange={(skin) => setLook({ ...look, skin })} />
          <span>Hair</span><Swatches colors={HAIRS} value={look.hair} onChange={(hair) => setLook({ ...look, hair })} />
          <span>Shirt</span><Swatches colors={COLORS} value={look.shirt} onChange={(shirt) => setLook({ ...look, shirt })} />
          <span>Style</span>
          <div className="row">
            {HAIR_STYLES.map((s) => (
              <button type="button" key={s} className={`small ${look.hairStyle === s ? '' : 'ghost'}`} onClick={() => setLook({ ...look, hairStyle: s })}>{s}</button>
            ))}
            <button type="button" className="small ghost" onClick={() => setLook(randomAppearance())}>🎲</button>
          </div>
        </div>
      </fieldset>
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

/** Every project is a GitHub repository: an existing clone, or a new repository created from here. */
export function NewProjectModal(props: { floorId: ID; note?: string; onClose: () => void }) {
  const [mode, setMode] = useState<'link' | 'create'>('link');
  const [name, setName] = useState('');
  const [repoName, setRepoName] = useState<string | null>(null);
  const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (
    <FormModal
      title="New project"
      submitLabel={mode === 'create' ? 'Create repository & project' : 'Add project'}
      onClose={props.onClose}
      onSubmit={(d) => client.request('create_project', {
        name: str(d, 'name'),
        repoPath: str(d, 'repoPath'),
        floorId: props.floorId,
        createGithubRepo: mode === 'create' ? { name: str(d, 'repoName'), private: d.get('private') === 'on' } : null,
      })}
    >
      {props.note && <p className="callout">{props.note}</p>}
      <div className="tabs inline">
        <button type="button" className={mode === 'link' ? 'active' : ''} onClick={() => setMode('link')}>Link a GitHub clone</button>
        <button type="button" className={mode === 'create' ? 'active' : ''} onClick={() => setMode('create')}>Create a new GitHub repository</button>
      </div>
      <label>Name<input name="name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
      {mode === 'link' ? (
        <>
          <label>Local folder<input name="repoPath" required placeholder="C:\dev\my-app or ~/dev/my-app" /></label>
          <p className="hint">The root of a git repository whose <code>origin</code> is on GitHub, for example a clone of it.</p>
        </>
      ) : (
        <>
          <label>Local folder<input name="repoPath" required placeholder="~/dev/my-app (created if it doesn't exist)" /></label>
          <div className="grid2">
            <label>Repository name
              <input name="repoName" required value={repoName ?? slug(name)} onChange={(e) => setRepoName(e.target.value)} placeholder="my-app or my-org/my-app" />
            </label>
            <label className="check"><input type="checkbox" name="private" defaultChecked /> Private</label>
          </div>
          <p className="hint">
            Agent HQ initializes git in the folder if needed, creates the repository with <code>gh repo create</code>, makes it
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
          {props.world.agents.filter((a) => a.kind !== 'repo').map((a) => <option key={a.id} value={a.id}>{a.name} — {a.role}{a.isManager ? ' (manager)' : ''}</option>)}
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
  return (
    <FormModal
      title={b ? `Edit ${b.name}` : 'New building'}
      submitLabel={b ? 'Save' : 'Build'}
      onClose={props.onClose}
      onSubmit={(d) => {
        const fields = { name: str(d, 'name'), kind: str(d, 'kind') as BuildingKind, color };
        return b ? client.request('update_building', { id: b.id, patch: fields }) : client.request('create_building', fields);
      }}
    >
      <label>Name<input name="name" required autoFocus defaultValue={b?.name} placeholder="Game Studio" /></label>
      <label>Kind
        <select name="kind" defaultValue={b?.kind ?? 'web'}>
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </label>
      <label>Facade color<Swatches colors={COLORS} value={color} onChange={setColor} /></label>
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

const MATERIALS: Array<{ value: FloorMaterial; label: string }> = [
  { value: 'wood', label: 'Wood' },
  { value: 'carpet', label: 'Carpet' },
  { value: 'tiles', label: 'Tiles' },
  { value: 'concrete', label: 'Concrete' },
];
const WALLS = ['#e9e4da', '#f4f4f2', '#dfe7ef', '#e8dcd0', '#d5e3d5', '#3a3f4b', '#f2d7d9'];

export function FloorModal(props: { floor: Floor; world: Snapshot; onClose: () => void }) {
  const f = props.floor;
  const [theme, setTheme] = useState(f.theme);
  const [desks, setDesks] = useState(f.desks);
  const seated = props.world.agents.filter((a) => a.floorId === f.id).length;
  return (
    <FormModal
      title={`Customize ${f.name}`}
      submitLabel="Save"
      onClose={props.onClose}
      onSubmit={(d) => client.request('update_floor', { id: f.id, patch: { name: str(d, 'name'), desks, theme } })}
    >
      <label>Name<input name="name" required defaultValue={f.name} /></label>
      <label>Workstations: {desks}
        <input type="range" min={Math.max(1, seated)} max={24} value={desks} onChange={(e) => setDesks(Number(e.target.value))} />
        <span className="hint">Expand the office to fit more agents on this floor.</span>
      </label>
      <label>Floor
        <div className="row">
          {MATERIALS.map((m) => (
            <button type="button" key={m.value} className={`small ${theme.floor === m.value ? '' : 'ghost'}`} onClick={() => setTheme({ ...theme, floor: m.value })}>{m.label}</button>
          ))}
        </div>
      </label>
      <label>Walls<Swatches colors={WALLS} value={theme.wallColor} onChange={(wallColor) => setTheme({ ...theme, wallColor })} /></label>
      <label>Accent<Swatches colors={COLORS} value={theme.accentColor} onChange={(accentColor) => setTheme({ ...theme, accentColor })} /></label>
      <label className="check"><input type="checkbox" checked={theme.plants} onChange={(e) => setTheme({ ...theme, plants: e.target.checked })} /> Plants</label>
      <label className="check"><input type="checkbox" checked={theme.lounge} onChange={(e) => setTheme({ ...theme, lounge: e.target.checked })} /> Lounge with coffee machine</label>
      <button type="button" className="ghost danger" onClick={() => client.request('remove_floor', { id: f.id }).then(props.onClose, (e) => window.dispatchEvent(new CustomEvent('hq-error', { detail: e.message })))}>
        Remove floor
      </button>
    </FormModal>
  );
}
