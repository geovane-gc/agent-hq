import { useEffect, useState } from 'react';
import type { ID, Snapshot } from '@agent-hq/protocol';
import { useClient } from './api.ts';
import { AgentPanel } from './components/AgentPanel.tsx';
import { AgentTerminal } from './components/AgentTerminal.tsx';
import { Board } from './components/Board.tsx';
import { AgentModal, BuildingModal, FloorModal, NewFloorModal, NewProjectModal, NewTaskModal } from './components/forms.tsx';
import { BossComputer, MailAlerts } from './components/Inbox.tsx';
import { Modal } from './components/Modal.tsx';
import { SettingsModal } from './components/Settings.tsx';
import { SummonModal } from './components/SummonModal.tsx';
import { RateMeters, UsageModal } from './components/Usage.tsx';
import { CampusScene } from './office3d/CampusScene.tsx';
import type { CameraMode } from './office3d/Controls.tsx';
import { OfficeScene } from './office3d/OfficeScene.tsx';

type Overlay =
  | { kind: 'hire' }
  | { kind: 'project'; note?: string }
  | { kind: 'task'; assigneeId?: ID; fromBoard?: boolean }
  | { kind: 'building'; id?: ID }
  | { kind: 'new-floor'; buildingId: ID }
  | { kind: 'floor' }
  | { kind: 'board' }
  | { kind: 'computer'; mailId?: ID }
  | { kind: 'summon'; agentId: ID }
  | { kind: 'usage' }
  | { kind: 'settings'; tab?: 'general' | 'integrations' | 'team' }
  | null;

const BUILDING_ICON = { web: '🌐', desktop: '🖥️', game: '🎮', custom: '🏢' } as const;

function remember<T extends string>(key: string, fallback: T): T {
  try { return (localStorage.getItem(key) as T) || fallback; } catch { return fallback; }
}
function store(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch {}
}

function Toasts() {
  const [msgs, setMsgs] = useState<Array<{ id: number; text: string }>>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const id = Date.now() + Math.random();
      setMsgs((m) => [...m, { id, text: String((e as CustomEvent).detail) }]);
      setTimeout(() => setMsgs((m) => m.filter((x) => x.id !== id)), 6000);
    };
    window.addEventListener('hq-error', on);
    return () => window.removeEventListener('hq-error', on);
  }, []);
  return <div className="toasts">{msgs.map((m) => <div key={m.id} className="toast">{m.text}</div>)}</div>;
}

/** Hands up across the whole company, so approvals are never missed. */
function ApprovalAlerts({ world, onOpen }: { world: Snapshot; onOpen: (agentId: ID) => void }) {
  const waiting = world.agents.filter((a) => a.status === 'awaiting_approval' && a.ownerId === world.you.id);
  if (!waiting.length) return null;
  return (
    <div className="alerts">
      {waiting.map((a) => (
        <button key={a.id} className="alert" onClick={() => onOpen(a.id)}>
          <span className="bounce">✋</span> {a.name} needs your approval
        </button>
      ))}
    </div>
  );
}

function Directory(props: { world: Snapshot; floorId: ID | null; onFloor: (id: ID) => void; open: (o: Overlay) => void; owner: boolean }) {
  const { world } = props;
  return (
    <nav className="directory">
      {world.buildings.map((b) => (
        <div key={b.id} className="building">
          <div className="building-name">
            <span className="dot" style={{ background: b.color }} /> {BUILDING_ICON[b.kind]} {b.name}
            {props.owner && <button className="link small" onClick={() => props.open({ kind: 'building', id: b.id })}>edit</button>}
          </div>
          {world.floors.filter((f) => f.buildingId === b.id).sort((x, y) => y.level - x.level).map((f) => {
            const agents = world.agents.filter((a) => a.floorId === f.id && a.kind !== 'repo');
            const waiting = agents.some((a) => a.status === 'awaiting_approval');
            const busy = agents.filter((a) => a.status === 'working').length;
            return (
              <button key={f.id} className={`floor ${f.id === props.floorId ? 'active' : ''}`} onClick={() => props.onFloor(f.id)}>
                <span>{f.level}F · {f.name}</span>
                <span className="muted">{waiting ? '✋ ' : ''}{busy}/{agents.length}</span>
              </button>
            );
          })}
          {props.owner && <button className="link small" onClick={() => props.open({ kind: 'new-floor', buildingId: b.id })}>+ floor</button>}
        </div>
      ))}
    </nav>
  );
}

export function App() {
  const { connection, world } = useClient();
  const [view, setView] = useState<'campus' | 'office'>(() => remember('hq-view', 'office'));
  const [mode, setMode] = useState<CameraMode>(() => remember('hq-camera', 'iso'));
  const [floorId, setFloorId] = useState<ID | null>(() => remember<string>('hq-floor', '') || null);
  /** Agent whose monitor the camera is flying into / showing. */
  const [focusAgentId, setFocusAgentId] = useState<ID | null>(null);
  /** Set once the camera arrived: shows the agent's terminal on the monitor. */
  const [terminalAgentId, setTerminalAgentId] = useState<ID | null>(null);
  /** History & settings side panel. */
  const [agentId, setAgentId] = useState<ID | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [directory, setDirectory] = useState(true);

  useEffect(() => store('hq-view', view), [view]);
  useEffect(() => store('hq-camera', mode), [mode]);
  useEffect(() => { if (floorId) store('hq-floor', floorId); }, [floorId]);
  useEffect(() => {
    if (world && (!floorId || !world.floors.some((f) => f.id === floorId))) {
      // Default to the ground floor of the oldest building.
      const first = [...world.buildings].sort((a, b) => a.createdAt - b.createdAt)[0];
      const ground = world.floors.filter((f) => f.buildingId === first?.id).sort((a, b) => a.level - b.level)[0];
      setFloorId(ground?.id ?? world.floors[0]?.id ?? null);
    }
  }, [world, floorId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc inside an agent's terminal belongs to Claude Code.
      const inTerminal = !!(e.target as HTMLElement | null)?.closest?.('.xterm');
      if (e.key === 'Escape' && !document.pointerLockElement && !inTerminal) { setOverlay(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (connection === 'unauthorized') {
    return <div className="splash"><h1>Agent HQ</h1><p>Open the link printed by the server, or an invite link from the office owner.</p></div>;
  }
  if (!world) return <div className="splash"><h1>Agent HQ</h1><p className="muted">Connecting…</p></div>;

  const owner = world.you.role === 'owner';
  const floor = world.floors.find((f) => f.id === floorId);
  const building = world.buildings.find((b) => b.id === floor?.buildingId);
  const projects = world.projects.filter((p) => p.floorId === floorId);
  const projectIds = projects.map((p) => p.id);
  const openTasks = world.tasks.filter((t) => projectIds.includes(t.projectId) && t.status !== 'done').length;
  const close = () => setOverlay(null);

  /** Walk up to an agent's computer: the camera zooms into the monitor, then the terminal opens. */
  const openAgent = (id: ID) => {
    const agent = world.agents.find((a) => a.id === id);
    if (agent && agent.floorId !== floorId) setFloorId(agent.floorId);
    setView('office');
    setAgentId(null);
    setTerminalAgentId(null);
    setFocusAgentId(id);
  };
  const closeTerminal = () => {
    setTerminalAgentId(null);
    setFocusAgentId(null);
  };
  const newTask = (fromBoard: boolean, assigneeId?: ID) => {
    const available = assigneeId ? world.projects : projects;
    if (available.length === 0) {
      setOverlay(owner
        ? { kind: 'project', note: 'Tasks belong to a project (a git repository). Add one to this floor first, then create the task.' }
        : null);
      if (!owner) window.dispatchEvent(new CustomEvent('hq-error', { detail: 'There are no projects yet; ask the office owner to add one.' }));
      return;
    }
    setOverlay({ kind: 'task', assigneeId, fromBoard });
  };
  const nextFloor = () => {
    if (!floor) return;
    const floors = world.floors.filter((f) => f.buildingId === floor.buildingId).sort((a, b) => a.level - b.level);
    const next = floors[(floors.findIndex((f) => f.id === floor.id) + 1) % floors.length];
    setFloorId(next.id);
    setAgentId(null);
    closeTerminal();
  };

  return (
    <div className="app">
      {view === 'campus' ? (
        <CampusScene
          world={world}
          onEnterFloor={(id) => { setFloorId(id); setView('office'); }}
          onNewBuilding={owner ? () => setOverlay({ kind: 'building' }) : null}
        />
      ) : floor ? (
        <OfficeScene
          world={world}
          floor={floor}
          mode={mode}
          focusAgentId={focusAgentId}
          onFocused={() => setTerminalAgentId(focusAgentId)}
          onOpenAgent={openAgent}
          onRecruit={() => setOverlay({ kind: 'hire' })}
          onBoard={() => setOverlay({ kind: 'board' })}
          onElevator={nextFloor}
          onTerminal={() => setOverlay({ kind: 'computer' })}
          onSummon={(agentId) => setOverlay({ kind: 'summon', agentId })}
        />
      ) : (
        <div className="splash"><p className="muted">No floors yet.</p></div>
      )}

      {/* ---------------- HUD */}
      <header className="hud-top">
        <h1>🏢 Agent HQ</h1>
        <div className="seg">
          <button className={view === 'campus' ? 'active' : ''} onClick={() => { closeTerminal(); setView('campus'); }}>Campus</button>
          <button className={view === 'office' ? 'active' : ''} onClick={() => setView('office')}>Office</button>
        </div>
        {view === 'office' && (
          <div className="seg">
            <button className={mode === 'iso' ? 'active' : ''} onClick={() => { closeTerminal(); setMode('iso'); }} title="Overview camera">🗺️ Overview</button>
            <button className={mode === 'first' ? 'active' : ''} onClick={() => { closeTerminal(); setMode('first'); }} title="Walk around in first person">🚶 Walk</button>
          </div>
        )}
        {connection !== 'open' && <span className="pill status-error">Reconnecting…</span>}
        <span className="spacer" />
        <RateMeters limits={world.rateLimits} />
        <div className="people-dots" title="Players">
          {world.users.filter((u) => u.online).map((u) => <span key={u.id} className="dot" style={{ background: u.color }} title={u.name} />)}
        </div>
        <button className="ghost" onClick={() => setOverlay({ kind: 'usage' })}>📊 Usage</button>
        <button className="ghost" onClick={() => setOverlay({ kind: 'settings', tab: 'team' })}>👥 Team</button>
        <button className="ghost" onClick={() => setOverlay({ kind: 'settings' })}>⚙️</button>
      </header>

      {view === 'office' && floor && !focusAgentId && (
        <div className="hud-floor">
          <button className="ghost small" onClick={() => setDirectory(!directory)} title="Building directory">🛗</button>
          <div>
            <div className="muted small-text">{building?.name}</div>
            <h2>{floor.level}F · {floor.name}</h2>
          </div>
          <div className="projects">
            {projects.map((p) => <span key={p.id} className="chip" title={p.repoPath}>{p.git ? '⎇ ' : ''}{p.name}</span>)}
            {owner && <button className="small ghost" onClick={() => setOverlay({ kind: 'project' })}>+ Project</button>}
          </div>
          <button onClick={() => setOverlay({ kind: 'board' })}>📋 Board{openTasks ? ` (${openTasks})` : ''}</button>
          {owner && <button className="ghost" onClick={() => setOverlay({ kind: 'floor' })}>🎨 Customize</button>}
        </div>
      )}

      {view === 'office' && directory && mode === 'iso' && !focusAgentId && (
        <Directory world={world} floorId={floorId} onFloor={(id) => { setFloorId(id); setAgentId(null); closeTerminal(); }} open={setOverlay} owner={owner} />
      )}

      <ApprovalAlerts world={world} onOpen={openAgent} />
      <MailAlerts world={world} onOpen={(mailId) => setOverlay({ kind: 'computer', mailId })} />

      {terminalAgentId && view === 'office' && (
        <AgentTerminal
          key={terminalAgentId}
          world={world}
          agentId={terminalAgentId}
          onClose={closeTerminal}
          onNewTask={() => newTask(false, terminalAgentId)}
          onDetails={() => { const id = terminalAgentId; closeTerminal(); setAgentId(id); }}
          onChatOnly={() => { const id = terminalAgentId; closeTerminal(); setAgentId(id); }}
        />
      )}

      {agentId && view === 'office' && <AgentPanel world={world} agentId={agentId} onClose={() => setAgentId(null)} />}

      {/* ---------------- overlays */}
      {overlay?.kind === 'board' && (
        <Modal title={`📋 Board — ${floor?.name ?? ''}`} onClose={close} wide>
          <Board world={world} projectIds={projectIds} onNewTask={() => newTask(true)} onOpenAgent={(id) => { close(); openAgent(id); }} />
        </Modal>
      )}
      {overlay?.kind === 'hire' && floor && <AgentModal world={world} floorId={floor.id} onClose={close} />}
      {overlay?.kind === 'project' && floor && <NewProjectModal floorId={floor.id} note={overlay.note} onClose={close} />}
      {overlay?.kind === 'task' && (
        <NewTaskModal
          world={world}
          projectIds={overlay.assigneeId ? world.projects.map((p) => p.id) : projectIds}
          assigneeId={overlay.assigneeId}
          onClose={() => setOverlay(overlay.fromBoard ? { kind: 'board' } : null)}
        />
      )}
      {overlay?.kind === 'building' && <BuildingModal building={world.buildings.find((b) => b.id === overlay.id)} onClose={close} />}
      {overlay?.kind === 'new-floor' && <NewFloorModal buildingId={overlay.buildingId} onClose={close} />}
      {overlay?.kind === 'floor' && floor && <FloorModal floor={floor} world={world} onClose={close} />}
      {overlay?.kind === 'computer' && <BossComputer world={world} initialMailId={overlay.mailId} onClose={close} onOpenAgent={openAgent} />}
      {overlay?.kind === 'summon' && <SummonModal world={world} agentId={overlay.agentId} onClose={close} onOpenAgent={openAgent} />}
      {overlay?.kind === 'usage' && <UsageModal onClose={close} />}
      {overlay?.kind === 'settings' && <SettingsModal world={world} initial={overlay.tab} onClose={close} />}
      <Toasts />
    </div>
  );
}
