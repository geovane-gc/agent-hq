// Presentation helpers: turn raw protocol values (timestamps, token counts,
// tool ids, tool inputs) into text a player can read at a glance.

const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const intFmt = new Intl.NumberFormat();
const usdFmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 43500 → "43.5K". */
export const compact = (n: number) => compactFmt.format(n);
/** 1284 → "1,284". */
export const int = (n: number) => intFmt.format(n);
export const usd = (n: number) => usdFmt.format(n);

/** "just now", "5m ago", "3h ago", "2d ago", then a date. */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Time left until `ts`: "45m", "2h 14m", "3d 4h". */
export function until(ts: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((ts - now) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Full local date and time, for tooltips. */
export const stamp = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** "0F" style storey label, matching the elevator signs in the office. */
export const floorLabel = (level: number) => `${level}F`;

/** First letter(s) of a name, for avatar badges. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** "mcp__agent-hq__list_tasks" → "agent-hq › list tasks"; built-in tools stay as they are. */
export function toolLabel(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const [server, ...tool] = name.slice(5).split('__');
  return `${server} › ${tool.join(' ').replace(/_/g, ' ')}`;
}

/** Replaces raw MCP tool ids inside a sentence, e.g. an agent's activity line. */
export const humanize = (text: string) => text.replace(/mcp__[\w-]+/g, toolLabel);

/** The fields of a tool call worth showing before the raw input. */
const KEY_FIELDS: Array<[string, string]> = [
  ['command', 'Command'],
  ['file_path', 'File'],
  ['notebook_path', 'Notebook'],
  ['path', 'Path'],
  ['pattern', 'Pattern'],
  ['url', 'URL'],
  ['query', 'Query'],
  ['description', 'Why'],
];

/** Label/value pairs summarizing a tool call's input; empty when nothing is recognizable. */
export function toolFields(input: unknown): Array<{ label: string; value: string }> {
  if (!input || typeof input !== 'object') return [];
  const obj = input as Record<string, unknown>;
  return KEY_FIELDS.filter(([k]) => typeof obj[k] === 'string' && obj[k]).map(([k, label]) => ({ label, value: String(obj[k]) }));
}
