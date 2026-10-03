import type { ID, Mail } from '@agent-hq/protocol';
import type { Db } from './db.ts';

/** A mail plus the task (conversation) it came from, so a reply can resume it. Never sent to clients as is. */
interface MailRecord extends Mail {
  taskId: ID | null;
}

const toMail = ({ taskId: _taskId, ...mail }: MailRecord): Mail => mail;

/**
 * Players' inboxes: reports repo agents deliver to whoever invoked them. Kept
 * in memory and persisted as `mail` entities; only the recipient ever sees a
 * mail (see the server's event filter).
 */
export class Mailbox {
  private readonly db: Db;
  private readonly mails: Map<ID, MailRecord>;

  constructor(db: Db) {
    this.db = db;
    this.mails = new Map(db.loadEntities<MailRecord>('mail').map((m) => [m.id, m]));
  }

  /** A player's inbox, newest first. */
  inbox(userId: ID, limit = 300): Mail[] {
    return [...this.mails.values()]
      .filter((m) => m.toUserId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(toMail);
  }

  get(id: ID): (Mail & { taskId: ID | null }) | undefined {
    return this.mails.get(id);
  }

  /** The latest mail of a conversation, which a follow-up report answers. */
  latestForTask(taskId: ID): Mail | undefined {
    let latest: MailRecord | undefined;
    for (const m of this.mails.values()) if (m.taskId === taskId && (!latest || m.createdAt >= latest.createdAt)) latest = m;
    return latest && toMail(latest);
  }

  put(record: MailRecord): Mail {
    this.mails.set(record.id, record);
    this.db.putEntity('mail', record.id, record);
    return toMail(record);
  }

  patch(id: ID, patch: Partial<Pick<Mail, 'read'>>): Mail {
    const m = this.mails.get(id);
    if (!m) throw new Error('Mail not found');
    return this.put({ ...m, ...patch });
  }

  remove(id: ID) {
    this.mails.delete(id);
    this.db.deleteEntity('mail', id);
  }
}
