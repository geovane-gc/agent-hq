import { useEffect, useState } from 'react';
import type { ID } from '@agent-hq/protocol';
import { useClient } from './api.ts';
import { TakeoverAlerts } from './components/Accounts.tsx';
import { AgentPanel } from './components/AgentPanel.tsx';
import { AgentTerminal } from './components/AgentTerminal.tsx';
import { Board } from './components/Board.tsx';
import { Avatars, FloorPicker, MainMenu, Notifications, StatusCard, type MenuItem } from './components/Hud.tsx';
import { AgentModal, BuildingModal, FloorModal, NewFloorModal, NewProjectModal, NewTaskModal } from './components/forms.tsx';
import { BossComputer } from './components/Inbox.tsx';
import { Modal } from './components/Modal.tsx';
import { SettingsModal } from './components/Settings.tsx';
import { openFinances } from './components/Finance.tsx';
import { StartScreen, TycoonLayer, openStartScreen } from './components/StartScreen.tsx';
import { EmptyBalconyModal, SummonModal } from './components/SummonModal.tsx';
import { UsageModal } from './components/Usage.tsx';
import { WhiteboardLayer } from './components/Whiteboards.tsx';
import { openWhiteboards } from './whiteboards.ts';
import { floorLabel } from './format.ts';
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
  | { kind: 'computer'; mailId?: ID; tab?: 'inbox' | 'terminal' }
  | { kind: 'summon'; agentId: ID }
  | { kind: 'balcony' }
  | { kind: 'usage' }
  | { kind: 'settings'; tab?: 'general' | 'integrations' | 'team' }
  | null;

function remember<T extends string>(key: string, fallback: T): T {
  try { return (localStorage.getItem(key) as T) || fallback; } catch { return fallback; }
}
function store(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch {}
}

export function App() {
  const { connection, world, lobby } = useClient();
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
  /** Floor picker (from the status card) and main menu popovers. */
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);

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
      if (e.key === 'Escape' && !document.pointerLockElement && !inTerminal) { setOverlay(null); setMenu(false); setPicker(false); }
      // M opens the menu, unless the player is typing, in a dialog or walking with the mouse captured.
      const busy = !!(e.target as HTMLElement | null)?.closest?.('input, textarea, select, .xterm, [role="dialog"]');
      if (e.key.toLowerCase() === 'm' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !busy && !document.pointerLockElement && !document.querySelector('.modal-backdrop, .monitor-overlay')) {
        setPicker(false);
        setMenu((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (connection === 'unauthorized') {
    return <div className="splash"><h1>Agent HQ</h1><p>Open the link printed by the server, or an invite link from the office owner.</p></div>;
  }
  if (lobby) return <StartScreen offices={lobby} />; // tycoon: no office yet
  if (!world) return <div className="splash"><h1>Agent HQ</h1><p className="muted">Connecting…</p></div>;

  const owner = world.you.role === 'owner';
  const floor = world.floors.find((f) => f.id === floorId);
  const building = world.buildings.find((b) => b.id === floor?.buildingId);
  const projects = world.projects.filter((p) => p.floorId === floorId);
  const floorAgents = world.agents.filter((a) => a.floorId === floorId);
  /** Repo agents live on the balcony: they don't take desks. */
  const floorStaff = floorAgents.filter((a) => a.kind !== 'repo');
  const unread = world.mail.filter((m) => !m.read).length;
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

  const officeItems: MenuItem[] = view === 'office' && floor ? [
    { icon: '📋', label: 'Task board', hint: openTasks ? `${openTasks} open on this floor` : 'Plan work for this floor', badge: openTasks > 0 && <span className="count-badge">{openTasks}</span>, onSelect: () => setOverlay({ kind: 'board' }) },
    { icon: '🧑‍💻', label: 'Recruit an agent', hint: `${floorStaff.length} of ${floor.desks} desks taken`, onSelect: () => setOverlay({ kind: 'hire' }) },
    ...(owner ? [
      { icon: '📁', label: 'Add a project', hint: projects.length ? projects.map((p) => p.name).join(', ') : 'A GitHub repository for this floor', onSelect: () => setOverlay({ kind: 'project' }) },
      { icon: '🎨', label: 'Customize floor', hint: 'Desks, floor and wall colors', onSelect: () => setOverlay({ kind: 'floor' }) },
    ] : []),
  ] : view === 'campus' && owner ? [
    { icon: '🏗️', label: 'New building', hint: 'A studio for another kind of work', onSelect: () => setOverlay({ kind: 'building' }) },
  ] : [];
  const menuGroups: MenuItem[][] = [
    officeItems,
    [
      {
        icon: '📧', label: 'Inbox', hint: unread ? `${unread} unread report${unread > 1 ? 's' : ''}` : 'Reports from the balcony crew',
        badge: unread > 0 && <span className="count-badge">{unread}</span>, onSelect: () => setOverlay({ kind: 'computer' }),
      },
      { icon: '🖍️', label: 'Whiteboards', hint: 'Draw together; boards stay in the office', onSelect: openWhiteboards },
      ...(world.economy ? [{ icon: '💼', label: 'Finances', hint: 'Cash, profit and the ledger', onSelect: openFinances }] : []),
      { icon: '📊', label: 'Usage', hint: 'Tokens and cost per agent and project', onSelect: () => setOverlay({ kind: 'usage' }) },
      { icon: '👥', label: 'Team', hint: 'Players and invites', badge: <Avatars world={world} />, onSelect: () => setOverlay({ kind: 'settings', tab: 'team' }) },
      ...(world.terminalAvailable ? [{ icon: '👑', label: 'Boss terminal', hint: 'Your private shell', onSelect: () => setOverlay({ kind: 'computer', tab: 'terminal' }) }] : []),
      { icon: '⚙️', label: 'Settings', onSelect: () => setOverlay({ kind: 'settings' }) },
    ],
    owner ? [{ icon: '🏠', label: 'Main menu', hint: world.office ? `${world.office.name} · new or saved offices` : 'New or saved offices', onSelect: openStartScreen }] : [],
  ];

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
          onEmptyBalcony={() => setOverlay({ kind: 'balcony' })}
        />
      ) : (
        <div className="splash"><p className="muted">No floors yet.</p></div>
      )}

      {/* ---------------- HUD */}
      {!focusAgentId && (
        <StatusCard
          world={world}
          floor={view === 'office' ? floor : undefined}
          building={view === 'office' ? building : undefined}
          agents={view === 'office' ? floorAgents : world.agents}
          reconnecting={connection !== 'open'}
          pickerOpen={picker}
          onPicker={view === 'office' ? () => { setMenu(false); setPicker(!picker); } : null}
        />
      )}
      {picker && view === 'office' && !focusAgentId && (
        <>
          <div className="click-away" onMouseDown={() => setPicker(false)} />
          <FloorPicker
            world={world}
            floorId={floorId}
            owner={owner}
            onFloor={(id) => { setFloorId(id); setAgentId(null); closeTerminal(); setPicker(false); }}
            onEditBuilding={(id) => { setPicker(false); setOverlay({ kind: 'building', id }); }}
            onNewFloor={(buildingId) => { setPicker(false); setOverlay({ kind: 'new-floor', buildingId }); }}
          />
        </>
      )}

      <div className="hud-corner">
        <div className="seg icons" role="group" aria-label="View">
          <button className={view === 'campus' ? 'active' : ''} aria-pressed={view === 'campus'} onClick={() => { closeTerminal(); setView('campus'); }} title="Campus: every building">🏙️</button>
          <button className={view === 'office' && mode === 'iso' ? 'active' : ''} aria-pressed={view === 'office' && mode === 'iso'} onClick={() => { closeTerminal(); setView('office'); setMode('iso'); }} title="Office overview: drag to rotate, wheel to zoom">🗺️</button>
          <button className={view === 'office' && mode === 'first' ? 'active' : ''} aria-pressed={view === 'office' && mode === 'first'} onClick={() => { closeTerminal(); setView('office'); setMode('first'); }} title="Walk around in first person (WASD)">🚶</button>
        </div>
        <button className={`menu-btn ${menu ? 'open' : ''}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => { setPicker(false); setMenu(!menu); }} title="Menu (M)">
          <span aria-hidden>☰</span> Menu
        </button>
      </div>
      {menu && (
        <>
          <div className="click-away" onMouseDown={() => setMenu(false)} />
          <MainMenu groups={menuGroups} onClose={() => setMenu(false)} />
        </>
      )}

      <Notifications
        world={world}
        onOpenAgent={openAgent}
        onBoard={() => { setView('office'); setOverlay({ kind: 'board' }); }}
        onInbox={(mailId) => setOverlay({ kind: 'computer', mailId })}
      />
      <TakeoverAlerts world={world} onOpen={openAgent} />

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
        <Modal title="📋 Task board" subtitle={floor && `${floorLabel(floor.level)} · ${floor.name}${building ? ` · ${building.name}` : ''}`} onClose={close} wide>
          <Board
            world={world}
            projectIds={projectIds}
            onNewTask={() => newTask(true)}
            onNewProject={owner ? () => setOverlay({ kind: 'project' }) : null}
            onOpenAgent={(id) => { close(); openAgent(id); }}
          />
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
      {overlay?.kind === 'computer' && <BossComputer world={world} initialMailId={overlay.mailId} initialTab={overlay.tab} onClose={close} onOpenAgent={openAgent} />}
      {overlay?.kind === 'summon' && <SummonModal world={world} agentId={overlay.agentId} onClose={close} onOpenAgent={openAgent} />}
      {overlay?.kind === 'balcony' && floor && (
        <EmptyBalconyModal world={world} floorId={floor.id} onClose={close} onAddProject={owner ? () => setOverlay({ kind: 'project' }) : null} />
      )}
      {overlay?.kind === 'usage' && <UsageModal onClose={close} />}
      {overlay?.kind === 'settings' && <SettingsModal world={world} initial={overlay.tab} onClose={close} />}
      <TycoonLayer world={world} />
      <WhiteboardLayer world={world} floorId={view === 'office' ? floorId : null} />
    </div>
  );
}
