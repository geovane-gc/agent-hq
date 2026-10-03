import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ID, Mail, Snapshot } from '@agent-hq/protocol';
import { client, run } from '../api.ts';
import { ago, stamp } from '../format.ts';
import { AgentPortrait } from './Portrait.tsx';

// Reports from repo agents (the balcony crew), shown in the mail client
// (MailClient.tsx), and the small Markdown renderer mail bodies use.

/** Inline Markdown: `code`, **bold**, *italic* and [links](https://…). */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [token] = m;
    const key = out.length;
    if (m[1]) out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={key}>{token.slice(1, -1)}</em>);
    else out.push(<a key={key} href={m[5]} target="_blank" rel="noreferrer">{token.slice(1, token.indexOf(']'))}</a>);
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A small Markdown renderer for reports (no HTML is ever injected). */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code: string[] = [];
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
      blocks.push(<pre key={blocks.length}>{code.join('\n')}</pre>);
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push(<h4 key={blocks.length}>{inline(line.replace(/^#+\s*/, ''))}</h4>);
    } else if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\.\s/.test(line);
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*+]|\d+\.)\s/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
      i--;
      const list = items.map((item, k) => <li key={k}>{inline(item)}</li>);
      blocks.push(ordered ? <ol key={blocks.length}>{list}</ol> : <ul key={blocks.length}>{list}</ul>);
    } else if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      blocks.push(<hr key={blocks.length} />);
    } else if (line.trim()) {
      const para = [line];
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^(```|#{1,6}\s|\s*([-*+]|\d+\.)\s|\s*(---|\*\*\*)\s*$)/.test(lines[i + 1])) para.push(lines[++i]);
      blocks.push(<p key={blocks.length}>{inline(para.join('\n'))}</p>);
    }
  }
  return <div className="markdown">{blocks}</div>;
}

function Thread({ world, mail }: { world: Snapshot; mail: Mail }) {
  // Earlier mails of the same conversation, oldest first.
  const earlier: Mail[] = [];
  for (let id = mail.inReplyTo; id; ) {
    const m = world.mail.find((x) => x.id === id);
    if (!m) break;
    earlier.unshift(m);
    id = m.inReplyTo;
  }
  if (!earlier.length) return null;
  return (
    <details className="mail-thread">
      <summary className="muted small-text">{earlier.length} earlier report{earlier.length > 1 ? 's' : ''} in this conversation</summary>
      {earlier.map((m) => (
        <div key={m.id} className="mail-earlier">
          <div className="muted small-text" title={stamp(m.createdAt)}>{stamp(m.createdAt)}</div>
          <Markdown text={m.body} />
        </div>
      ))}
    </details>
  );
}

/** An agent report: read it, reply to continue the conversation (the agent comes back to a desk). */
export function MailView(props: { world: Snapshot; mail: Mail; onOpenAgent: (id: ID) => void; onDeleted: () => void }) {
  const { world, mail } = props;
  const agent = world.agents.find((a) => a.id === mail.fromAgentId);
  const project = world.projects.find((p) => p.id === agent?.repo?.projectId);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!mail.read) run('mark_mail_read', { id: mail.id }).catch(() => {});
    setSent(false);
  }, [mail.id, mail.read]);

  async function reply(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await run('reply_mail', { id: mail.id, text });
      setText('');
      setSent(true);
    } catch {} finally {
      setBusy(false);
    }
  }

  const working = agent?.repo && agent.repo.location !== 'balcony' && agent.repo.invokedBy === world.you.id && agent.live;
  return (
    <article className="mail-view">
      <header className="report-head">
        <AgentPortrait agent={agent} size={44} />
        <div>
          <h3 className="mail-subject">{mail.subject} <span className="tag-report">Agent report</span></h3>
          <div className="muted small-text">
            From <strong>{agent?.name ?? 'an agent who left'}</strong>{project ? ` · ${project.name}` : ''} · <time title={stamp(mail.createdAt)}>{stamp(mail.createdAt)} ({ago(mail.createdAt)})</time>
          </div>
        </div>
      </header>
      <Thread world={world} mail={mail} />
      <Markdown text={mail.body} />
      <form className="mail-reply" onSubmit={reply}>
        <textarea
          rows={3}
          value={text}
          placeholder={agent ? `Reply to ${agent.name}: they come back to a desk and continue the same conversation…` : 'This agent is no longer in the repository'}
          disabled={!agent || busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) reply(e); }}
        />
        <div className="row">
          {sent && <span className="muted small-text">Sent. {agent?.name} is on it; the answer will arrive here.</span>}
          {working && <button type="button" className="ghost small" onClick={() => props.onOpenAgent(agent!.id)}>Watch {agent!.name} work</button>}
          <span className="spacer" />
          <button type="button" className="ghost danger small" onClick={() => client.deleteMail(mail.id).then(props.onDeleted, (err) => window.dispatchEvent(new CustomEvent('hq-error', { detail: err.message })))}>Delete</button>
          <button type="submit" disabled={!agent || busy || !text.trim()}>{busy ? 'Sending…' : 'Reply & continue'}</button>
        </div>
      </form>
    </article>
  );
}
