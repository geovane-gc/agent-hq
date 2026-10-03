import type { ReactNode } from 'react';

// HUD notices: small cards in the bottom-left corner (see Notifications in
// components/Hud.tsx). Anything can raise one with `notify`; each notice
// carries its own title and icon (or a portrait).

export interface HudNotice {
  title: string;
  text?: string;
  /** An emoji; ignored when `portrait` is set. */
  icon?: string;
  /** E.g. a <UserPortrait>, shown instead of the icon. */
  portrait?: ReactNode;
  tone?: 'waiting' | 'success' | 'error';
  action?: { label: string; run: () => void };
  /** Same id replaces an earlier card. */
  id?: string;
  /** How long the card stays, in ms. */
  ttl?: number;
}

export const NOTICE_EVENT = 'hq-notice';

export function notify(notice: HudNotice) {
  window.dispatchEvent(new CustomEvent<HudNotice>(NOTICE_EVENT, { detail: notice }));
}
