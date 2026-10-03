import { useEffect, useMemo, useRef, useState } from 'react';
import type { Floor, ID, Snapshot, User, VoiceState } from '@agent-hq/protocol';
import { floorLabel, initials } from '../format.ts';
import { openScreen, shareScreen, useVoice, voice, type MicMode, type VoiceView } from '../voice/engine.ts';
import { avatarSpots, channelOf, meetingMembers } from '../voice/spatial.ts';

// Voice chat and the meeting room in the HUD: a small dock in the bottom-right
// corner (mic, nearby/everyone, people), a meeting card above it, and the
// shared screen full size. Nothing here ever turns the mic on by itself.

const MIC_LABEL: Record<MicMode, string> = { off: 'Off', open: 'On', ptt: 'Push to talk' };

function nameOf(world: Snapshot, id: ID) {
  return world.users.find((u) => u.id === id)?.name ?? 'Someone';
}

/** A player's badge with a ring while they talk. */
function Talker({ user, speaking, live }: { user: User; speaking: boolean; live: boolean }) {
  return (
    <span className={`avatar talker ${speaking ? 'speaking' : ''}`} style={{ background: user.color }} title={`${user.name}${speaking ? ' (talking)' : live ? ' (mic on)' : ''}`}>
      {initials(user.name)}
    </span>
  );
}

function peerStatus(v: VoiceView, world: Snapshot, spots: Spots, other: VoiceState): string {
  const peer = v.peers[other.userId];
  if (!peer || peer.connection === 'new' || peer.connection === 'connecting') return 'Connecting…';
  if (peer.connection !== 'connected') return 'Connection problem';
  const channel = channelOf(world, spots, other);
  if (channel.startsWith('meeting:')) return peer.inRange ? 'In your meeting' : 'In a meeting';
  if (channel === 'global') return peer.inRange ? 'Company channel' : 'On the company channel';
  if (peer.inRange) return peer.distance === null ? 'Nearby' : `Nearby · ${peer.distance.toFixed(1)} m`;
  const me = world.voice.find((s) => s.userId === world.you.id);
  if (me && channelOf(world, spots, me) !== 'proximity') return 'Talking nearby';
  const floor = spots.get(other.userId)?.floorId;
  return floor && floor !== spots.get(world.you.id)?.floorId ? 'On another floor' : 'Out of earshot';
}

type Spots = ReturnType<typeof avatarSpots>;

function VoicePanel({ world, v, spots, onClose }: { world: Snapshot; v: VoiceView; spots: Spots; onClose: () => void }) {
  const others = world.voice.filter((s) => s.userId !== world.you.id);
  const offline = world.users.filter((u) => u.id !== world.you.id && u.online && !world.voice.some((s) => s.userId === u.id));
  return (
    <div className="popover voice-panel" role="dialog" aria-label="Voice settings" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <header className="voice-head">
        <strong>🎧 Voice</strong>
        <label className="toggle compact">
          <input type="checkbox" role="switch" checked={v.enabled} onChange={(e) => voice.setEnabled(e.target.checked)} />
          <span><small>{v.enabled ? 'On' : 'Off'}</small></span>
        </label>
        <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">✕</button>
      </header>
      {v.enabled && (
        <>
          <div className="field">
            <span className="field-label">Microphone</span>
            <div className="seg small" role="radiogroup" aria-label="Microphone">
              {(['off', 'open', 'ptt'] as MicMode[]).map((m) => (
                <button key={m} role="radio" aria-checked={v.micMode === m} className={v.micMode === m ? 'active' : ''} onClick={() => void voice.setMicMode(m)}>
                  {MIC_LABEL[m]}{m === 'ptt' && <> <kbd>V</kbd></>}
                </button>
              ))}
            </div>
            {v.micError && <p className="error small-text">{v.micError}</p>}
          </div>
          <label className="field">
            <span className="field-label">Input</span>
            <select value={v.inputId} onChange={(e) => void voice.setInput(e.target.value)}>
              <option value="">System default</option>
              {v.inputs.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Output</span>
            <select value={v.outputId} disabled={!v.outputSelectable} onChange={(e) => void voice.setOutput(e.target.value)}>
              <option value="">System default</option>
              {v.outputs.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
            {!v.outputSelectable && <small className="hint">This browser always plays through the system default.</small>}
          </label>
          <div className="field">
            <span className="field-label">People</span>
            {others.length === 0 && <p className="hint">Nobody else is in voice right now.</p>}
            <ul className="voice-people">
              {others.map((o) => {
                const user = world.users.find((u) => u.id === o.userId);
                if (!user) return null;
                const muted = !!v.muted[o.userId];
                const volume = v.volumes[o.userId] ?? 1;
                return (
                  <li key={o.userId} className={v.peers[o.userId]?.inRange ? 'audible' : ''}>
                    <Talker user={user} speaking={!!v.speaking[o.userId]} live={o.mic} />
                    <span className="voice-person">
                      <strong>{user.name}{o.mic && <span className="mic-dot" title="Mic on" aria-label="mic on" />}</strong>
                      <small>{peerStatus(v, world, spots, o)}</small>
                    </span>
                    <input
                      type="range" min={0} max={200} step={5} value={Math.round(volume * 100)} disabled={muted}
                      aria-label={`${user.name}'s volume`} title={`${Math.round(volume * 100)}%`}
                      onChange={(e) => voice.setVolume(o.userId, Number(e.target.value) / 100)}
                    />
                    <button className={`icon-btn ${muted ? 'danger on' : ''}`} onClick={() => voice.setMuted(o.userId, !muted)} aria-pressed={muted} aria-label={muted ? `Unmute ${user.name}` : `Mute ${user.name}`} title={muted ? 'Unmute' : 'Mute for you'}>
                      {muted ? '🔇' : '🔊'}
                    </button>
                  </li>
                );
              })}
            </ul>
            {offline.length > 0 && <p className="hint">Not in voice: {offline.map((u) => u.name).join(', ')}</p>}
          </div>
        </>
      )}
      <p className="hint">
        Your mic stays off until you turn it on. Audio and screens go straight between players' computers (WebRTC), so
        the players you're connected to can see your IP address.
      </p>
    </div>
  );
}

/** Bottom-right: mic, nearby/everyone, and who's around. */
export function VoiceDock({ world, floor, compact }: { world: Snapshot; floor: Floor | undefined; compact?: boolean }) {
  const v = useVoice();
  const [panel, setPanel] = useState(false);
  const spots = useMemo(() => avatarSpots(world), [world]);
  const audible = world.voice.filter((o) => o.userId !== world.you.id && v.peers[o.userId]?.inRange);
  const talking = world.users.filter((u) => v.speaking[u.id] && u.id !== world.you.id);
  const inVoice = world.voice.filter((o) => o.userId !== world.you.id).length;

  // Over an agent's monitor: only what's live, so you never forget your mic or screen is on.
  if (compact) {
    if (!v.transmitting && !v.sharing && v.micMode !== 'ptt') return null;
    return (
      <div className="voice-dock compact">
        <div className="voice-bar">
          {v.micMode !== 'off' && (
            <button className={`mic-btn ${v.transmitting ? 'live' : 'armed'}`} onClick={() => void voice.setMicMode('off')} title="Turn your mic off">
              <span aria-hidden>🎙️</span>{v.transmitting ? <span className="live-label">● Live</span> : <span>Hold <kbd>V</kbd></span>}
            </button>
          )}
          {v.sharing && <button className="small danger" onClick={() => voice.stopShare()}>■ Stop sharing</button>}
        </div>
      </div>
    );
  }

  if (v.elsewhere) {
    return (
      <div className="voice-dock">
        <div className="voice-bar">
          <span className="voice-note">🎧 Voice is on in another window</span>
          <button className="small" onClick={() => voice.useHere()}>Use here</button>
        </div>
      </div>
    );
  }

  return (
    <div className="voice-dock">
      <MeetingCard world={world} floor={floor} v={v} spots={spots} />
      {panel && (
        <>
          <div className="click-away" onMouseDown={() => setPanel(false)} />
          <VoicePanel world={world} v={v} spots={spots} onClose={() => setPanel(false)} />
        </>
      )}
      <div className="voice-bar" role="group" aria-label="Voice">
        {!v.enabled ? (
          <>
            <span className="voice-note">🔕 Voice is off</span>
            <button className="small" onClick={() => voice.setEnabled(true)}>Turn on</button>
          </>
        ) : (
          <>
            <button
              className={`mic-btn ${v.transmitting ? 'live' : v.micMode === 'ptt' ? 'armed' : ''}`}
              onClick={() => void voice.setMicMode(v.micMode === 'off' ? 'open' : 'off')}
              aria-pressed={v.micMode !== 'off'}
              title={v.micMode === 'off' ? 'Turn your mic on' : 'Turn your mic off'}
            >
              <span aria-hidden>{v.micMode === 'off' ? '🔇' : '🎙️'}</span>
              {v.transmitting ? <span className="live-label">● Live</span> : v.micMode === 'ptt' ? <span>Hold <kbd>V</kbd></span> : <span>Mic off</span>}
            </button>
            {v.meetingFloorId ? (
              <span className="chip meeting-chip" title="Everyone in the meeting room hears each other">🎥 Meeting</span>
            ) : (
              <div className="seg small" role="radiogroup" aria-label="Who hears you">
                <button role="radio" aria-checked={v.mode === 'proximity'} className={v.mode === 'proximity' ? 'active' : ''} onClick={() => voice.setMode('proximity')} title="Players near your avatar on this floor">📍 Nearby</button>
                <button role="radio" aria-checked={v.mode === 'global'} className={v.mode === 'global' ? 'active' : ''} onClick={() => voice.setMode('global')} title="The company-wide channel">🌐 Everyone</button>
              </div>
            )}
          </>
        )}
        <button className={`voice-people-btn ${panel ? 'open' : ''}`} onClick={() => setPanel(!panel)} aria-expanded={panel} aria-haspopup="dialog" title="Voice settings and people">
          <span className="avatars">
            {(talking.length ? talking : audible.map((o) => world.users.find((u) => u.id === o.userId)).filter((u): u is User => !!u)).slice(0, 3).map((u) => (
              <Talker key={u.id} user={u} speaking={!!v.speaking[u.id]} live={!!world.voice.find((o) => o.userId === u.id)?.mic} />
            ))}
          </span>
          <span className="small-text">{v.enabled ? `${audible.length}/${inVoice}` : ''} ⚙</span>
        </button>
      </div>
      {v.enabled && v.audioBlocked && inVoice > 0 && <div className="voice-hint">🔈 Click anywhere to hear voice</div>}
    </div>
  );
}

/** Who's in the meeting room, the screen share, and the share / join buttons. */
function MeetingCard({ world, floor, v, spots }: { world: Snapshot; floor: Floor | undefined; v: VoiceView; spots: Spots }) {
  const meetingFloor = world.floors.find((f) => f.id === v.meetingFloorId);
  // Your meeting, or else the meeting on the floor you're looking at if something is going on there.
  const shown = meetingFloor ?? floor;
  const members = shown ? meetingMembers(world, spots, shown.id) : [];
  const share = shown ? world.screenShares.find((s) => s.floorId === shown.id) : undefined;
  if (!shown || !v.enabled) return null;
  const inside = !!meetingFloor;
  if (!inside && !share && members.length === 0) return null;
  const sharer = share ? (share.userId === world.you.id ? 'You' : nameOf(world, share.userId)) : null;
  return (
    <section className={`meeting-card ${v.sharing ? 'sharing' : ''}`} aria-label="Meeting room">
      <div className="meeting-top">
        <span className="note-icon" aria-hidden>🎥</span>
        <span className="note-body">
          <strong>Meeting room{meetingFloor && floor?.id !== meetingFloor.id ? ` · ${floorLabel(meetingFloor.level)} ${meetingFloor.name}` : ''}</strong>
          <span className="meeting-members">
            {members.map((id) => world.users.find((u) => u.id === id)).filter((u): u is User => !!u).slice(0, 6).map((u) => (
              <Talker key={u.id} user={u} speaking={!!v.speaking[u.id]} live={!!world.voice.find((o) => o.userId === u.id)?.mic} />
            ))}
            <small>{members.length} in the meeting</small>
          </span>
        </span>
      </div>
      {share && (
        <div className={`share-line ${share.userId === world.you.id ? 'mine' : ''}`}>
          <span className="rec-dot" aria-hidden /> {sharer} {share.userId === world.you.id ? 'are' : 'is'} sharing {share.userId === world.you.id ? 'your' : 'their'} screen
        </div>
      )}
      <div className="row">
        {inside ? (
          <>
            {v.sharing ? (
              <button className="small danger" onClick={() => voice.stopShare()}>■ Stop sharing</button>
            ) : (
              <button className="small" disabled={!!share || !v.joined} onClick={shareScreen} title={share ? `${sharer} is sharing; one screen at a time` : 'Show your screen on the wall'}>🖥 Share screen</button>
            )}
            {v.screen && <button className="small ghost" onClick={openScreen}>⤢ Full size</button>}
            {v.joinedMeeting && <button className="small ghost" onClick={() => voice.leaveMeeting()}>Leave meeting</button>}
          </>
        ) : (
          <button className="small" disabled={!v.joined} onClick={() => voice.joinMeeting(shown.id)} title="Hear the meeting and see its screen without walking in">Join meeting</button>
        )}
      </div>
    </section>
  );
}

/** The meeting's shared screen, full size. */
export function ScreenOverlay({ world }: { world: Snapshot }) {
  const v = useVoice();
  const [open, setOpen] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener('hq-open-screen', on);
    return () => window.removeEventListener('hq-open-screen', on);
  }, []);
  const stream = v.screen?.stream ?? null;
  useEffect(() => {
    if (video.current && video.current.srcObject !== stream) video.current.srcObject = stream;
  }, [stream, open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open || !v.screen) return null;
  const mine = v.screen.share.userId === world.you.id;
  return (
    <div className="screen-overlay" role="dialog" aria-modal="true" aria-label="Shared screen" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="screen-frame">
        <header className="monitor-bar">
          <span className="rec-dot" aria-hidden />
          <strong>{mine ? 'Your screen' : `${nameOf(world, v.screen.share.userId)}'s screen`}</strong>
          <span className="spacer" />
          {mine && <button className="small danger" onClick={() => voice.stopShare()}>■ Stop sharing</button>}
          <button className="small ghost" onClick={() => setOpen(false)}>Close (Esc)</button>
        </header>
        <video ref={video} className="screen-video" autoPlay playsInline muted />
      </div>
    </div>
  );
}
