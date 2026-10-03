// Voice chat and screen sharing between players: WebRTC in a full mesh, with
// the Agent HQ server as the signaling channel. Every pair of players in voice
// has one RTCPeerConnection with two transceivers negotiated up front (audio
// and video), so nothing is renegotiated later: who gets your mic or your
// screen is decided by replacing the sender's track (null = send nothing).
//
// - Proximity: you send your mic only to players in range (plus a little
//   slack), and each listener plays it with a gain that falls off with
//   distance, through a PannerNode placed at the speaker's avatar.
// - Global: everyone in global mode hears each other at full volume.
// - Meeting room: whoever is in a floor's meeting room (or joined it) is in
//   that room's channel, and only they receive its screen share.
//
// The mic is never on until the player turns it on. Agents are never in voice.

import { useSyncExternalStore } from 'react';
import type { ID, IceCandidate, IceServer, RtcSignal, ScreenShare, Snapshot, VoiceMode, VoiceState } from '@agent-hq/protocol';
import { client } from '../api.ts';
import { notify } from '../notify.ts';
import { avatarSpots, hearing, meetingOf, type Spot } from './spatial.ts';

export type MicMode = 'off' | 'open' | 'ptt';

export interface Device {
  id: string;
  label: string;
}

export interface PeerView {
  userId: ID;
  connection: RTCPeerConnectionState;
  /** You can hear them (same channel and, in proximity, in range). */
  inRange: boolean;
  /** 0..1 distance factor before your volume setting. */
  gain: number;
  /** Proximity: meters between you (null on another floor or another channel). */
  distance: number | null;
  /** Your mic / screen is being sent to them. */
  sendingMic: boolean;
  sendingScreen: boolean;
}

export interface VoiceView {
  /** Voice on (listening). Off: no connections at all. Remembered per player. */
  enabled: boolean;
  /** Your voice is active in another window: this one stays quiet. */
  elsewhere: boolean;
  /** The server knows this tab is in voice. */
  joined: boolean;
  micMode: MicMode;
  /** Your mic is live: sending to whoever can hear you. */
  transmitting: boolean;
  micError: string | null;
  mode: VoiceMode;
  inputs: Device[];
  outputs: Device[];
  inputId: string;
  outputId: string;
  /** The browser can pick an output device for Web Audio. */
  outputSelectable: boolean;
  volumes: Record<ID, number>;
  muted: Record<ID, boolean>;
  /** Players (you included) whose voice is coming through right now. */
  speaking: Record<ID, boolean>;
  peers: Record<ID, PeerView>;
  /** Floor of the meeting you're in (in its room, or joined from elsewhere). */
  meetingFloorId: ID | null;
  /** The meeting you joined from outside the room with "Join meeting". */
  joinedMeeting: ID | null;
  /** Your active screen share. */
  sharing: ScreenShare | null;
  /** The screen share in your meeting and its video (your own capture when you're the sharer). */
  screen: { share: ScreenShare; stream: MediaStream | null } | null;
  /** The browser hasn't allowed audio playback yet (needs a click or key press). */
  audioBlocked: boolean;
}

interface Prefs {
  enabled: boolean;
  mode: VoiceMode;
  inputId: string;
  outputId: string;
  volumes: Record<ID, number>;
  muted: Record<ID, boolean>;
}

interface Peer {
  userId: ID;
  peerId: string;
  pc: RTCPeerConnection;
  audio: RTCRtpTransceiver | null;
  video: RTCRtpTransceiver | null;
  /** Tracks currently handed to the senders (null = sending nothing). */
  sentAudio: MediaStreamTrack | null;
  sentVideo: MediaStreamTrack | null;
  pendingIce: IceCandidate[];
  /** Playback chain: source -> analyser (speaking) / gain -> panner -> master. */
  sink: HTMLAudioElement | null;
  source: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
  gain: GainNode | null;
  panner: PannerNode | null;
  videoStream: MediaStream | null;
  targetGain: number;
  view: PeerView;
}

const PREFS_KEY = 'agent-hq-voice';
const PTT_CODE = 'KeyV';
const SPEAKING_RMS = 0.015;
const SPEAKING_HOLD_MS = 350;
/** Senders keep sending a bit past the radius so listeners fade out instead of cutting off. */
const SEND_SLACK = 1;
const RETRY_MS = 3000;

function loadPrefs(): Prefs {
  const fallback: Prefs = { enabled: true, mode: 'proximity', inputId: '', outputId: '', volumes: {}, muted: {} };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<Prefs> | null;
    return saved ? { ...fallback, ...saved, mode: saved.mode === 'global' ? 'global' : 'proximity' } : fallback;
  } catch {
    return fallback;
  }
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Keys typed into inputs, terminals or the whiteboard editor (its V is the selection tool) are never push-to-talk. */
function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t?.closest?.('input, textarea, select, [contenteditable="true"], .xterm, [data-captures-keys]');
}

const rms = (analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>) => {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const v of buffer) sum += v * v;
  return Math.sqrt(sum / buffer.length);
};

const errorText = (err: unknown) => (err as Error)?.message || String(err);

/** Browsers only offer the mic and screen capture on HTTPS or localhost (listening works anywhere). */
function requireCapture() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(window.isSecureContext ? 'This browser has no media capture' : 'Open Agent HQ over HTTPS (or on localhost) to talk or share your screen');
  }
}

export class VoiceEngine {
  readonly peerId = randomId();
  private prefs = loadPrefs();
  private world: Snapshot | null = null;
  private spots = new Map<ID, Spot>();
  private readonly peers = new Map<ID, Peer>();
  private readonly retryAt = new Map<ID, number>();
  private readonly listeners = new Set<() => void>();
  private view: VoiceView;
  private viewKey = '';
  /** Between getDisplayMedia and the server's OK: the share isn't ours to clean up yet. */
  private startingShare = false;
  /** startedAt of the share we already asked the server to stop. */
  private stopRequested = 0;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private mic: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micMode: MicMode = 'off';
  private micError: string | null = null;
  private pttHeld = false;
  private screenStream: MediaStream | null = null;
  private iceServers: IceServer[] | null = null;
  private iceKey = '';
  private joined = false;
  private joining = false;
  private elsewhere = false;
  /** What the server last accepted for this tab (to resend only on change). */
  private published = '';
  private joinedMeeting: ID | null = null;
  private inputs: Device[] = [];
  private outputs: Device[] = [];
  private readonly speakingSince = new Map<ID, number>();
  private signals: Promise<void> = Promise.resolve();
  private readonly buffer = new Float32Array(512);

  constructor() {
    this.view = this.buildView();
    client.subscribe(() => this.onWorld(client.get().world));
    client.rtc.addEventListener('signal', (e) => {
      const detail = (e as CustomEvent).detail as { fromUserId: ID; fromPeerId: string; toPeerId: string; signal: RtcSignal };
      this.signals = this.signals.then(() => this.onSignal(detail)).catch((err) => console.warn('voice signal', err));
    });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.setPtt(false));
    // Browsers only start audio after a gesture.
    const unlock = () => { void this.ctx?.resume().then(() => this.emit()); };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    window.addEventListener('pagehide', () => { if (this.joined) client.request('voice_leave', { peerId: this.peerId }).catch(() => {}); });
    navigator.mediaDevices?.addEventListener?.('devicechange', () => void this.refreshDevices());
    setInterval(() => this.tick(), 100);
    setInterval(() => this.reconcile(), 1000);
    this.onWorld(client.get().world);
  }

  // ------------------------------------------------------------------ React

  get = () => this.view;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  /** Publishes a new view, only when something visible changed (presence updates arrive several times a second). */
  private emit() {
    const next = this.buildView();
    const key = JSON.stringify(next, (_, v) => (v instanceof MediaStream ? `${v.id}:${v.getTracks().map((t) => t.id).join()}` : v));
    if (key === this.viewKey) return;
    this.viewKey = key;
    this.view = next;
    for (const fn of this.listeners) fn();
  }

  private buildView(): VoiceView {
    const world = this.world;
    const me = world?.you.id;
    const myShare = world?.screenShares.find((s) => s.userId === me && s.peerId === this.peerId) ?? null;
    const meetingFloorId = world && me ? meetingOf(world, this.spots, me, this.myState()) : null;
    const share = meetingFloorId ? world?.screenShares.find((s) => s.floorId === meetingFloorId) ?? null : null;
    const peers: Record<ID, PeerView> = {};
    for (const p of this.peers.values()) peers[p.userId] = p.view;
    const speaking: Record<ID, boolean> = {};
    for (const id of this.speakingSince.keys()) speaking[id] = true;
    return {
      enabled: this.prefs.enabled,
      elsewhere: this.elsewhere,
      joined: this.joined,
      micMode: this.micMode,
      transmitting: this.transmitting(),
      micError: this.micError,
      mode: this.prefs.mode,
      inputs: this.inputs,
      outputs: this.outputs,
      inputId: this.prefs.inputId,
      outputId: this.prefs.outputId,
      outputSelectable: typeof (AudioContext.prototype as { setSinkId?: unknown }).setSinkId === 'function',
      volumes: this.prefs.volumes,
      muted: this.prefs.muted,
      speaking,
      peers,
      meetingFloorId,
      joinedMeeting: this.joinedMeeting,
      sharing: myShare,
      screen: share
        ? { share, stream: share.userId === me && share.peerId === this.peerId ? this.screenStream : this.peers.get(share.userId)?.videoStream ?? null }
        : null,
      audioBlocked: !!this.ctx && this.ctx.state !== 'running',
    };
  }

  // ------------------------------------------------------------------ player actions

  setEnabled(enabled: boolean) {
    this.prefs.enabled = enabled;
    this.savePrefs();
    if (!enabled) this.leave();
    this.reconcile();
  }

  /** Voice is active in another window: take it over here. */
  useHere() {
    this.elsewhere = false;
    this.published = '';
    this.reconcile();
  }

  setMode(mode: VoiceMode) {
    this.prefs.mode = mode;
    this.savePrefs();
    this.reconcile();
  }

  async setMicMode(mode: MicMode) {
    this.micMode = mode;
    this.micError = null;
    this.pttHeld = false;
    if (mode === 'off') this.releaseMic();
    else if (!this.mic) {
      try {
        await this.acquireMic();
      } catch (err) {
        this.micMode = 'off';
        this.micError = `Microphone unavailable: ${errorText(err)}`;
      }
    }
    this.reconcile();
  }

  async setInput(deviceId: string) {
    this.prefs.inputId = deviceId;
    this.savePrefs();
    if (this.mic) {
      this.releaseMic();
      try { await this.acquireMic(); } catch (err) { this.micMode = 'off'; this.micError = `Microphone unavailable: ${errorText(err)}`; }
    }
    this.reconcile();
  }

  async setOutput(deviceId: string) {
    this.prefs.outputId = deviceId;
    this.savePrefs();
    await this.applyOutput();
    this.emit();
  }

  setVolume(userId: ID, volume: number) {
    this.prefs.volumes = { ...this.prefs.volumes, [userId]: Math.max(0, Math.min(2, volume)) };
    this.savePrefs();
    this.emit();
  }

  setMuted(userId: ID, muted: boolean) {
    this.prefs.muted = { ...this.prefs.muted, [userId]: muted };
    this.savePrefs();
    this.emit();
  }

  joinMeeting(floorId: ID) {
    this.joinedMeeting = floorId;
    this.reconcile();
  }

  leaveMeeting() {
    this.joinedMeeting = null;
    this.reconcile();
  }

  /** Shares your screen on the wall of the meeting room you're in. Call from a click (getDisplayMedia needs it). */
  async startShare() {
    const floorId = this.view.meetingFloorId;
    if (!floorId) throw new Error('Go into a meeting room (or join a meeting) to share your screen');
    if (!this.joined) throw new Error('Voice is not connected yet');
    requireCapture();
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
    const track = stream.getVideoTracks()[0];
    if (track) track.contentHint = 'detail';
    this.startingShare = true;
    try {
      await client.request('screen_share_start', { floorId, peerId: this.peerId });
    } catch (err) {
      for (const t of stream.getTracks()) t.stop();
      throw err;
    } finally {
      this.startingShare = false;
    }
    this.stopCapture();
    this.screenStream = stream;
    track?.addEventListener('ended', () => { if (this.screenStream === stream) this.stopShare(); });
    this.reconcile();
  }

  stopShare() {
    const share = this.myShare();
    this.stopCapture();
    if (share) {
      this.stopRequested = share.startedAt;
      client.request('screen_share_stop', { floorId: share.floorId }).catch(() => {});
    }
    this.reconcile();
  }

  private myShare(): ScreenShare | null {
    const world = this.world;
    return world?.screenShares.find((s) => s.userId === world.you.id && s.peerId === this.peerId) ?? null;
  }

  // ------------------------------------------------------------------ state

  private myState(): VoiceState | undefined {
    const world = this.world;
    return world?.voice.find((v) => v.userId === world.you.id && v.peerId === this.peerId);
  }

  private transmitting() {
    return !!this.mic && this.joined && (this.micMode === 'open' || (this.micMode === 'ptt' && this.pttHeld));
  }

  private savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch {}
  }

  private onWorld(world: Snapshot | null) {
    if (world === this.world) return;
    this.world = world;
    this.reconcile();
  }

  /** Brings connections, senders and our published state in line with the world. Idempotent. */
  private reconcile() {
    const world = this.world;
    if (!world) return this.emit();
    this.spots = avatarSpots(world);
    const mine = world.voice.find((v) => v.userId === world.you.id);

    // Another tab of yours took over voice.
    if (this.joined && mine && mine.peerId !== this.peerId) {
      this.elsewhere = true;
      this.leave(false);
    }
    // The server forgot us (reconnect, office switch): start over.
    if (this.joined && !mine) {
      this.joined = false;
      this.published = '';
      this.closeAll();
    }
    if (!this.prefs.enabled || this.elsewhere) return this.emit();

    this.ensureAudio();
    this.loadIce(world);
    const desired = { peerId: this.peerId, mode: this.prefs.mode, mic: this.transmitting(), meeting: this.joinedMeeting };
    const key = JSON.stringify(desired);
    if (key !== this.published && !this.joining) {
      this.joining = true;
      client.request('voice_state', desired)
        .then(() => {
          this.published = key;
          if (!this.joined) { this.joined = true; void this.refreshDevices(); }
        })
        .catch(() => {})
        .finally(() => { this.joining = false; this.reconcile(); });
    }
    const me = this.myState();
    if (!me || !this.iceServers) return this.emit();

    // The share we hold must still be ours, and we must still be in that meeting.
    let share = world.screenShares.find((s) => s.userId === me.userId && s.peerId === this.peerId) ?? null;
    if (!this.startingShare) {
      if (this.screenStream && !share) {
        this.stopCapture(); // stopped by the boss, or by another tab of ours
      } else if (share && (!this.screenStream || meetingOf(world, this.spots, me.userId, me) !== share.floorId)) {
        // Left the room (or the capture ended): stop sharing.
        this.stopCapture();
        if (this.stopRequested !== share.startedAt) {
          this.stopRequested = share.startedAt;
          client.request('screen_share_stop', { floorId: share.floorId }).catch(() => {});
        }
        share = null;
      }
    }

    const others = world.voice.filter((v) => v.userId !== me.userId && world.users.some((u) => u.id === v.userId && u.online));
    for (const peer of [...this.peers.values()]) {
      const entry = others.find((v) => v.userId === peer.userId);
      if (!entry || entry.peerId !== peer.peerId) this.closePeer(peer.userId);
    }
    const now = Date.now();
    for (const entry of others) {
      // The lower peer id offers; the other side answers. One offer per pair, never renegotiated.
      if (!this.peers.has(entry.userId) && this.peerId < entry.peerId && (this.retryAt.get(entry.userId) ?? 0) <= now) {
        void this.offer(entry);
      }
    }
    for (const peer of this.peers.values()) {
      const entry = others.find((v) => v.userId === peer.userId);
      if (entry) this.gate(peer, me, entry, share);
    }
    this.emit();
  }

  /** Decides what this tab sends to one peer: mic if they can hear us, screen if they're in the sharing meeting. */
  private gate(peer: Peer, me: VoiceState, other: VoiceState, share: ScreenShare | null) {
    const world = this.world!;
    const h = hearing(world, this.spots, me, other, SEND_SLACK);
    const audio = h.gain > 0 && this.transmitting() ? this.mic?.getAudioTracks()[0] ?? null : null;
    const screenTo = !!share && !!this.screenStream && meetingOf(world, this.spots, other.userId, other) === share.floorId;
    const video = screenTo ? this.screenStream?.getVideoTracks()[0] ?? null : null;
    if (peer.audio && peer.sentAudio !== audio) {
      peer.sentAudio = audio;
      peer.audio.sender.replaceTrack(audio).catch((err) => console.warn('voice replaceTrack', err));
    }
    if (peer.video && peer.sentVideo !== video) {
      peer.sentVideo = video;
      peer.video.sender.replaceTrack(video).catch((err) => console.warn('screen replaceTrack', err));
    }
    peer.view = { ...peer.view, sendingMic: !!audio, sendingScreen: !!video };
  }

  // ------------------------------------------------------------------ audio

  private ensureAudio() {
    if (this.ctx) return;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.ctx.addEventListener('statechange', () => this.emit());
    void this.ctx.resume().catch(() => {});
    void this.applyOutput();
  }

  private async applyOutput() {
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!ctx?.setSinkId) return;
    try { await ctx.setSinkId(this.prefs.outputId || ''); } catch (err) { console.warn('voice output', err); }
  }

  private async acquireMic() {
    requireCapture();
    const constraints = (deviceId: string): MediaStreamConstraints => ({
      audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(this.prefs.inputId));
    } catch (err) {
      // The remembered device is gone: fall back to the default one.
      if (!this.prefs.inputId || (err as DOMException).name !== 'OverconstrainedError') throw err;
      stream = await navigator.mediaDevices.getUserMedia(constraints(''));
    }
    if (this.micMode === 'off') { for (const t of stream.getTracks()) t.stop(); return; }
    this.mic = stream;
    this.ensureAudio();
    if (this.ctx) {
      this.micSource = this.ctx.createMediaStreamSource(stream);
      this.micAnalyser = this.ctx.createAnalyser();
      this.micAnalyser.fftSize = 512;
      this.micSource.connect(this.micAnalyser); // analysis only: never played back
    }
    stream.getAudioTracks()[0]?.addEventListener('ended', () => { if (this.mic === stream) void this.setMicMode('off'); });
    void this.refreshDevices(); // labels appear once the mic was granted
  }

  private releaseMic() {
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.micSource?.disconnect();
    this.mic = null;
    this.micSource = null;
    this.micAnalyser = null;
    this.pttHeld = false;
  }

  private async refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const pick = (kind: MediaDeviceKind) => all
        .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `${kind === 'audioinput' ? 'Microphone' : 'Speakers'} ${i + 1}` }));
      this.inputs = pick('audioinput');
      this.outputs = pick('audiooutput');
      this.emit();
    } catch {}
  }

  private setPtt(held: boolean) {
    if (this.pttHeld === held) return;
    this.pttHeld = held;
    this.reconcile();
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code !== PTT_CODE || e.repeat || this.micMode !== 'ptt' || e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return;
    this.setPtt(true);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === PTT_CODE) this.setPtt(false);
  };

  /** Volumes, panning and speaking indicators, ten times a second. */
  private tick() {
    const world = this.world;
    const me = this.myState();
    const ctx = this.ctx;
    const now = Date.now();
    let changed = false;
    const speak = (id: ID, active: boolean) => {
      if (active) {
        if (!this.speakingSince.has(id)) changed = true;
        this.speakingSince.set(id, now);
      } else if (this.speakingSince.has(id) && now - this.speakingSince.get(id)! > SPEAKING_HOLD_MS) {
        this.speakingSince.delete(id);
        changed = true;
      }
    };
    if (world) speak(world.you.id, !!this.micAnalyser && this.transmitting() && rms(this.micAnalyser, this.buffer) > SPEAKING_RMS);
    if (world && me && ctx) {
      const mySpot = this.spots.get(me.userId);
      const yaw = mySpot?.walking ? mySpot.rotation : 0;
      const listener = mySpot ? [mySpot.position[0], 1.6, mySpot.position[2]] : [0, 1.6, 0];
      const forward = [-Math.sin(yaw), 0, -Math.cos(yaw)];
      const l = ctx.listener;
      if (l.positionX) {
        l.positionX.value = listener[0]; l.positionY.value = listener[1]; l.positionZ.value = listener[2];
        l.forwardX.value = forward[0]; l.forwardY.value = forward[1]; l.forwardZ.value = forward[2];
        l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
      }
      for (const peer of this.peers.values()) {
        const other = world.voice.find((v) => v.userId === peer.userId);
        if (!other) continue;
        const h = hearing(world, this.spots, me, other);
        const volume = this.prefs.muted[peer.userId] ? 0 : this.prefs.volumes[peer.userId] ?? 1;
        const target = h.gain * volume;
        if (peer.gain && Math.abs(target - peer.targetGain) > 1e-3) {
          peer.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.08);
          peer.targetGain = target;
        }
        // Proximity voices come from where the avatar stands; meeting and global ones from in front of you.
        const spot = this.spots.get(peer.userId);
        const at = h.channel === 'proximity' && spot && mySpot?.walking
          ? [spot.position[0], 1.6, spot.position[2]]
          : [listener[0] + forward[0], listener[1], listener[2] + forward[2]];
        if (peer.panner?.positionX) {
          peer.panner.positionX.value = at[0]; peer.panner.positionY.value = at[1]; peer.panner.positionZ.value = at[2];
        }
        const inRange = h.gain > 0;
        const distance = h.distance === null ? null : Math.round(h.distance * 10) / 10;
        if (inRange !== peer.view.inRange || Math.abs(h.gain - peer.view.gain) > 0.05 || distance !== peer.view.distance) {
          peer.view = { ...peer.view, inRange, gain: Math.round(h.gain * 100) / 100, distance };
          changed = true;
        }
        speak(peer.userId, !!peer.analyser && rms(peer.analyser, this.buffer) > SPEAKING_RMS);
      }
    }
    if (changed) this.emit();
  }

  // ------------------------------------------------------------------ peers

  private createPeer(entry: VoiceState): Peer {
    const pc = new RTCPeerConnection({ iceServers: (this.iceServers ?? []) as RTCIceServer[] });
    const peer: Peer = {
      userId: entry.userId, peerId: entry.peerId, pc, audio: null, video: null, sentAudio: null, sentVideo: null, pendingIce: [],
      sink: null, source: null, analyser: null, gain: null, panner: null, videoStream: null, targetGain: 0,
      view: { userId: entry.userId, connection: 'new', inRange: false, gain: 0, distance: null, sendingMic: false, sendingScreen: false },
    };
    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !ev.candidate.candidate) return;
      const c = ev.candidate;
      this.signal(entry, { kind: 'ice', candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment } });
    };
    pc.onconnectionstatechange = () => {
      peer.view = { ...peer.view, connection: pc.connectionState };
      if (pc.connectionState === 'failed' && this.peers.get(peer.userId) === peer) {
        // Try again in a moment (the offering side reconnects; see reconcile).
        this.closePeer(peer.userId);
        this.retryAt.set(peer.userId, Date.now() + RETRY_MS);
      }
      this.emit();
    };
    this.peers.set(entry.userId, peer);
    return peer;
  }

  /** Hooks the remote tracks up once the transceivers exist. */
  private attachTransceivers(peer: Peer) {
    for (const t of peer.pc.getTransceivers()) {
      const kind = t.receiver.track.kind;
      if (kind === 'audio' && !peer.audio) peer.audio = t;
      if (kind === 'video' && !peer.video) peer.video = t;
    }
    if (peer.video) peer.videoStream = new MediaStream([peer.video.receiver.track]);
    const ctx = this.ctx;
    if (!peer.audio || !ctx || !this.master) return;
    const stream = new MediaStream([peer.audio.receiver.track]);
    // Chrome only feeds a remote WebRTC stream into Web Audio while a media element plays it (muted here).
    const sink = new Audio();
    sink.muted = true;
    sink.srcObject = stream;
    void sink.play().catch(() => {});
    peer.sink = sink;
    peer.source = ctx.createMediaStreamSource(stream);
    peer.analyser = ctx.createAnalyser();
    peer.analyser.fftSize = 512;
    peer.gain = ctx.createGain();
    peer.gain.gain.value = 0;
    peer.panner = ctx.createPanner();
    peer.panner.panningModel = 'HRTF';
    peer.panner.distanceModel = 'linear';
    peer.panner.rolloffFactor = 0; // distance is handled by the gain above
    peer.source.connect(peer.analyser);
    peer.source.connect(peer.gain);
    peer.gain.connect(peer.panner);
    peer.panner.connect(this.master);
  }

  private async offer(entry: VoiceState) {
    const peer = this.createPeer(entry);
    peer.pc.addTransceiver('audio', { direction: 'sendrecv' });
    peer.pc.addTransceiver('video', { direction: 'sendrecv' });
    this.attachTransceivers(peer);
    this.reconcile(); // gate the new senders before the offer goes out
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      if (this.peers.get(entry.userId) === peer) this.signal(entry, { kind: 'offer', sdp: offer.sdp ?? '' });
    } catch (err) {
      console.warn('voice offer', err);
      this.closePeer(entry.userId);
      this.retryAt.set(entry.userId, Date.now() + RETRY_MS);
    }
  }

  private async onSignal(e: { fromUserId: ID; fromPeerId: string; toPeerId: string; signal: RtcSignal }) {
    if (e.toPeerId !== this.peerId || !this.joined) return;
    const entry = this.world?.voice.find((v) => v.userId === e.fromUserId);
    if (!entry || entry.peerId !== e.fromPeerId) return;
    const { signal } = e;
    if (signal.kind === 'offer') {
      if (this.peers.has(entry.userId)) this.closePeer(entry.userId);
      const peer = this.createPeer(entry);
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      for (const t of peer.pc.getTransceivers()) t.direction = 'sendrecv';
      this.attachTransceivers(peer);
      this.reconcile();
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.signal(entry, { kind: 'answer', sdp: answer.sdp ?? '' });
      await this.flushIce(peer);
    } else if (signal.kind === 'answer') {
      const peer = this.peers.get(entry.userId);
      if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      await this.flushIce(peer);
    } else if (signal.kind === 'ice') {
      const peer = this.peers.get(entry.userId);
      if (!peer) return;
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(signal.candidate).catch(() => {});
      else peer.pendingIce.push(signal.candidate);
    }
  }

  private async flushIce(peer: Peer) {
    const pending = peer.pendingIce.splice(0);
    for (const c of pending) await peer.pc.addIceCandidate(c).catch(() => {});
  }

  private signal(to: VoiceState, signal: RtcSignal) {
    client.request('rtc_signal', { toUserId: to.userId, toPeerId: to.peerId, fromPeerId: this.peerId, signal }).catch(() => {});
  }

  private closePeer(userId: ID) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    this.peers.delete(userId);
    this.speakingSince.delete(userId);
    peer.pc.onconnectionstatechange = null;
    peer.pc.onicecandidate = null;
    peer.pc.close();
    peer.source?.disconnect();
    peer.gain?.disconnect();
    peer.panner?.disconnect();
    if (peer.sink) { peer.sink.pause(); peer.sink.srcObject = null; }
  }

  private closeAll() {
    for (const id of [...this.peers.keys()]) this.closePeer(id);
  }

  private stopCapture() {
    for (const t of this.screenStream?.getTracks() ?? []) t.stop();
    this.screenStream = null;
  }

  /** Out of voice: connections closed, mic and screen released. */
  private leave(tellServer = true) {
    const share = this.myShare();
    if (share && tellServer) client.request('screen_share_stop', { floorId: share.floorId }).catch(() => {});
    this.stopCapture();
    this.closeAll();
    this.releaseMic();
    this.micMode = 'off';
    if (this.joined && tellServer) client.request('voice_leave', { peerId: this.peerId }).catch(() => {});
    this.joined = false;
    this.published = '';
    this.speakingSince.clear();
    this.emit();
  }

  /** STUN/TURN servers come from the office settings; the TURN credential only through this request. */
  private loadIce(world: Snapshot) {
    const key = JSON.stringify(world.settings.voice);
    if (key === this.iceKey) return;
    this.iceKey = key;
    client.request('get_ice_servers', {})
      .then(({ iceServers }) => {
        this.iceServers = iceServers;
        for (const p of this.peers.values()) {
          try { p.pc.setConfiguration({ iceServers: iceServers as RTCIceServer[] }); } catch {}
        }
        this.reconcile();
      })
      .catch(() => { this.iceKey = ''; });
  }

  /** For tests and troubleshooting: what each connection is doing. */
  async debug() {
    const peers = await Promise.all([...this.peers.values()].map(async (p) => {
      let audioIn = 0;
      let videoIn = 0;
      let audioOut = 0;
      let videoOut = 0;
      try {
        (await p.pc.getStats()).forEach((s) => {
          if (s.type === 'inbound-rtp') { if (s.kind === 'audio') audioIn = s.bytesReceived; else videoIn = s.bytesReceived; }
          if (s.type === 'outbound-rtp') { if (s.kind === 'audio') audioOut = s.bytesSent; else videoOut = s.bytesSent; }
        });
      } catch {}
      return {
        userId: p.userId, state: p.pc.connectionState, gain: p.gain?.gain.value ?? null, targetGain: p.targetGain,
        sendingMic: !!p.sentAudio, sendingScreen: !!p.sentVideo, audioIn, videoIn, audioOut, videoOut,
      };
    }));
    return {
      peerId: this.peerId, joined: this.joined, micMode: this.micMode, transmitting: this.transmitting(), audio: this.ctx?.state ?? null,
      micCaptured: !!this.mic?.getTracks().some((t) => t.readyState === 'live'),
      sharing: !!this.screenStream?.getTracks().some((t) => t.readyState === 'live'),
      peers,
    };
  }
}

export const voice = new VoiceEngine();
(window as unknown as { __agentHqVoice: VoiceEngine }).__agentHqVoice = voice;

export function useVoice(): VoiceView {
  return useSyncExternalStore(voice.subscribe, voice.get);
}

/** Opens the shared screen full size (handled by ScreenOverlay). */
export function openScreen() {
  if (document.pointerLockElement) document.exitPointerLock();
  window.dispatchEvent(new CustomEvent('hq-open-screen'));
}

/** Starts sharing and reports failures as a toast (a cancelled picker is not a failure). */
export function shareScreen() {
  voice.startShare().catch((err: Error) => {
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') return;
    notify({ tone: 'error', icon: '🖥️', title: 'Couldn’t share your screen', text: err.message, id: 'screen-share-error' });
  });
}
