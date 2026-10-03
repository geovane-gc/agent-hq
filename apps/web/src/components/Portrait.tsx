import { useEffect, useState, type CSSProperties } from 'react';
import type { Agent, Appearance, User } from '@agent-hq/protocol';
import { initials } from '../format.ts';
import { cachedPortrait, portrait, portraitKey, type Outfit } from '../portrait.ts';
import './portrait.css';

/**
 * A character's "photo": their 3D character's head and shoulders (see
 * portrait.ts), over a disc in their color. Shows their initials until the
 * picture is ready, or if it can't be rendered.
 */
export function Portrait(props: {
  appearance: Appearance;
  name: string;
  color: string;
  outfit?: Outfit;
  /** CSS pixels. */
  size?: number;
  title?: string;
  className?: string;
}) {
  const { appearance, outfit = 'casual', size = 32 } = props;
  const key = portraitKey(appearance, outfit);
  const [shot, setShot] = useState<{ key: string; src: string | null }>(() => ({ key, src: cachedPortrait(key) }));
  const src = shot.key === key ? shot.src : cachedPortrait(key);

  useEffect(() => {
    if (cachedPortrait(key)) {
      setShot({ key, src: cachedPortrait(key) });
      return;
    }
    let alive = true;
    portrait(appearance, outfit).then((url) => { if (alive) setShot({ key, src: url }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <span
      className={`portrait ${src ? 'ready' : ''} ${props.className ?? ''}`}
      style={{ '--portrait-color': props.color, width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.38)) } as CSSProperties}
      title={props.title ?? props.name}
      role="img"
      aria-label={props.title ?? props.name}
    >
      {src ? <img src={src} alt="" draggable={false} /> : initials(props.name)}
    </span>
  );
}

/** A player's portrait; the boss wears a suit, like in the office. */
export function UserPortrait(props: { user: User | undefined; size?: number; title?: string; className?: string }) {
  const { user } = props;
  if (!user) return <span className={`portrait gone ${props.className ?? ''}`} style={{ width: props.size ?? 32, height: props.size ?? 32 }} title="Former player">?</span>;
  return <Portrait appearance={user.appearance} name={user.name} color={user.color} outfit={user.role === 'owner' ? 'suit' : 'casual'} size={props.size} title={props.title} className={props.className} />;
}

/** An agent's portrait, in its shirt color. */
export function AgentPortrait(props: { agent: Agent | undefined; size?: number; title?: string; className?: string }) {
  const { agent } = props;
  if (!agent) return <span className={`portrait gone ${props.className ?? ''}`} style={{ width: props.size ?? 32, height: props.size ?? 32 }} title="Former agent">?</span>;
  return <Portrait appearance={agent.appearance} name={agent.name} color={agent.appearance.shirt} size={props.size} title={props.title} className={props.className} />;
}
