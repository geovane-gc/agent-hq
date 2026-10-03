import type {
  Commands,
  ID,
  IceServer,
  MediaSnapshot,
  RtcSignal,
  ScreenShare,
  ServerEvent,
  User,
  VoiceSettings,
  VoiceState,
} from '@agent-hq/protocol';
import type { Db } from './db.ts';
import type { Store } from './store.ts';

// Voice chat and meeting-room screen sharing. Media goes peer to peer between
// players' browsers (WebRTC, full mesh); the host only keeps who is in voice
// and who is sharing (runtime state, never persisted) and relays signaling to
// the one tab it is addressed to. Agents never take part.

export const DEFAULT_VOICE: VoiceSettings = {
  stunUrls: ['stun:stun.l.google.com:19302'],
  turnUrl: null,
  turnUsername: null,
  turnCredentialSet: false,
  proximityRadius: 8,
};

/** Where the TURN credential lives: the office database, never in the broadcast settings. */
const TURN_CREDENTIAL_KEY = 'voiceTurnCredential';
const MAX_SDP = 64 * 1024;
const MAX_CANDIDATE = 2048;
const ICE_URL = /^(stun|stuns|turn|turns):[^\s]+$/;

const peerIdOk = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);

function validSignal(signal: RtcSignal): boolean {
  if (!signal || typeof signal !== 'object') return false;
  if (signal.kind === 'offer' || signal.kind === 'answer') return typeof signal.sdp === 'string' && signal.sdp.length <= MAX_SDP;
  if (signal.kind === 'ice') {
    const c = signal.candidate;
    return !!c && typeof c.candidate === 'string' && c.candidate.length <= MAX_CANDIDATE;
  }
  return false;
}

export class MediaHub {
  private readonly voice = new Map<ID, VoiceState>();
  /** Active screen share per floor (its meeting room). */
  private readonly shares = new Map<ID, ScreenShare>();
  private readonly store: Store;
  private readonly db: Db;
  /** Delivers an event to every connection of one player. */
  private readonly sendTo: (userId: ID, event: ServerEvent) => void;

  constructor(store: Store, db: Db, sendTo: (userId: ID, event: ServerEvent) => void) {
    this.store = store;
    this.db = db;
    this.sendTo = sendTo;
  }

  snapshot(): MediaSnapshot {
    return { voice: [...this.voice.values()], screenShares: [...this.shares.values()] };
  }

  /** A player's last connection closed (or they were removed): out of voice, shares stopped. */
  gone(userId: ID) {
    this.endShares(userId);
    if (this.voice.delete(userId)) this.store.broadcast({ type: 'voice_left', userId });
  }

  private endShares(userId: ID) {
    for (const share of [...this.shares.values()]) {
      if (share.userId !== userId) continue;
      this.shares.delete(share.floorId);
      this.store.broadcast({ type: 'screen_share_ended', floorId: share.floorId, userId });
    }
  }

  private iceServers(): IceServer[] {
    const v = this.store.settings.voice;
    const servers: IceServer[] = v.stunUrls.length ? [{ urls: v.stunUrls }] : [];
    if (v.turnUrl) {
      const credential = this.db.getKv<string>(TURN_CREDENTIAL_KEY);
      servers.push({ urls: v.turnUrl, ...(v.turnUsername ? { username: v.turnUsername } : {}), ...(credential ? { credential } : {}) });
    }
    return servers;
  }

  readonly handlers: { [K in keyof Commands]?: (args: Commands[K]['args'], user: User) => Commands[K]['result'] } = {
    voice_state: ({ peerId, mode, mic, meeting }, user) => {
      if (!peerIdOk(peerId)) throw new Error('Invalid voice peer id');
      const previous = this.voice.get(user.id);
      // Another tab took over voice: its shares belong to the old tab.
      if (previous && previous.peerId !== peerId) this.endShares(user.id);
      const state: VoiceState = {
        userId: user.id,
        peerId,
        mode: mode === 'global' ? 'global' : 'proximity',
        mic: mic === true,
        meeting: meeting && this.store.get('floor', meeting) ? meeting : null,
      };
      this.voice.set(user.id, state);
      this.store.broadcast({ type: 'voice_state', voice: state });
      return state;
    },

    voice_leave: ({ peerId }, user) => {
      if (this.voice.get(user.id)?.peerId === peerId) this.gone(user.id);
      return null;
    },

    rtc_signal: ({ toUserId, toPeerId, fromPeerId, signal }, user) => {
      if (this.voice.get(user.id)?.peerId !== fromPeerId) throw new Error('Join voice first');
      if (toUserId === user.id) throw new Error('Cannot signal yourself');
      if (this.voice.get(toUserId)?.peerId !== toPeerId) throw new Error('That player left voice');
      if (!validSignal(signal)) throw new Error('Invalid signal');
      this.sendTo(toUserId, { type: 'rtc_signal', fromUserId: user.id, fromPeerId, toPeerId, signal });
      return null;
    },

    screen_share_start: ({ floorId, peerId }, user) => {
      this.store.require('floor', floorId);
      if (this.voice.get(user.id)?.peerId !== peerId) throw new Error('Join voice first');
      const current = this.shares.get(floorId);
      if (current && current.userId !== user.id) {
        const who = this.store.get('user', current.userId)?.name ?? 'Someone';
        throw new Error(`${who} is already sharing in this meeting room`);
      }
      // One share per player: sharing here stops a share elsewhere.
      for (const s of [...this.shares.values()]) {
        if (s.userId === user.id && s.floorId !== floorId) {
          this.shares.delete(s.floorId);
          this.store.broadcast({ type: 'screen_share_ended', floorId: s.floorId, userId: user.id });
        }
      }
      const share: ScreenShare = { floorId, userId: user.id, peerId, startedAt: current?.startedAt ?? Date.now() };
      this.shares.set(floorId, share);
      this.store.broadcast({ type: 'screen_share', share });
      return share;
    },

    screen_share_stop: ({ floorId }, user) => {
      const share = this.shares.get(floorId);
      if (!share) return null;
      if (share.userId !== user.id && user.role !== 'owner') throw new Error('Only the player sharing can stop it');
      this.shares.delete(floorId);
      this.store.broadcast({ type: 'screen_share_ended', floorId, userId: share.userId });
      return null;
    },

    get_ice_servers: () => ({ iceServers: this.iceServers() }),

    set_voice_settings: ({ stunUrls, turnUrl, turnUsername, turnCredential, proximityRadius }) => {
      const next: VoiceSettings = { ...this.store.settings.voice };
      if (stunUrls !== undefined) {
        if (!Array.isArray(stunUrls)) throw new Error('stunUrls must be a list');
        const urls = stunUrls.map((u) => String(u).trim()).filter(Boolean);
        for (const u of urls) if (!/^stuns?:/.test(u) || !ICE_URL.test(u)) throw new Error(`Not a STUN URL: ${u}`);
        next.stunUrls = urls.slice(0, 8);
      }
      if (turnUrl !== undefined) {
        const url = turnUrl?.trim() || null;
        if (url && (!/^turns?:/.test(url) || !ICE_URL.test(url))) throw new Error(`Not a TURN URL: ${url}`);
        next.turnUrl = url;
      }
      if (turnUsername !== undefined) next.turnUsername = turnUsername?.trim() || null;
      if (turnCredential !== undefined) {
        const value = turnCredential?.trim() || null;
        this.db.setKv(TURN_CREDENTIAL_KEY, value);
      }
      next.turnCredentialSet = !!this.db.getKv<string>(TURN_CREDENTIAL_KEY);
      if (proximityRadius !== undefined) {
        if (typeof proximityRadius !== 'number' || !(proximityRadius >= 2 && proximityRadius <= 50)) throw new Error('The proximity radius must be between 2 and 50 m');
        next.proximityRadius = proximityRadius;
      }
      return this.store.setSettings({ voice: next }).voice;
    },
  };
}
