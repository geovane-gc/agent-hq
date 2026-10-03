import { randomUUID } from 'node:crypto';
import type {
  ID,
  PlayerMail,
  PlayerMailCommandName,
  PlayerMailCommands,
  PlayerMailFolder,
  PlayerMailThread,
  ServerEvent,
  User,
} from '@agent-hq/protocol';
import type { Db } from './db.ts';

// Player-to-player e-mail. Messages are stored once in the office database;
// each participant (sender and recipients) has a row of their own in
// player_mail_box saying whether they sent or received it and whether they
// read or archived it. Deleting removes your row only; a message nobody has a
// row for any more is purged. Every query is scoped to the caller's rows, so
// nobody can read, change or delete a message they didn't send or receive.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS player_mail (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    from_user TEXT NOT NULL,
    to_users TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    in_reply_to TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS player_mail_thread ON player_mail (thread_id, created_at);
  CREATE TABLE IF NOT EXISTS player_mail_box (
    user_id TEXT NOT NULL,
    mail_id TEXT NOT NULL,
    sent INTEGER NOT NULL,
    received INTEGER NOT NULL,
    read INTEGER NOT NULL,
    archived INTEGER NOT NULL,
    PRIMARY KEY (user_id, mail_id)
  );
  CREATE INDEX IF NOT EXISTS player_mail_box_mail ON player_mail_box (mail_id);`;

const MAX_SUBJECT = 200;
const MAX_BODY = 20_000;
const MAX_RECIPIENTS = 20;
const PAGE = 30;

export const PLAYER_MAIL_COMMANDS = new Set<string>([
  'list_player_mail', 'get_player_thread', 'send_player_mail', 'update_player_mail', 'delete_player_mail',
] satisfies PlayerMailCommandName[]);

export const isPlayerMailCommand = (command: string): command is PlayerMailCommandName => PLAYER_MAIL_COMMANDS.has(command);

const FOLDER_SQL: Record<PlayerMailFolder, string> = {
  inbox: 'b.received = 1 AND b.archived = 0',
  sent: 'b.sent = 1',
  archive: 'b.archived = 1',
};

type Row = Record<string, unknown>;

/** A message joined with the caller's box row. */
const toMail = (r: Row): PlayerMail => ({
  id: String(r.id),
  threadId: String(r.thread_id),
  fromUserId: String(r.from_user),
  toUserIds: JSON.parse(String(r.to_users)) as ID[],
  subject: String(r.subject),
  body: String(r.body),
  inReplyTo: r.in_reply_to == null ? null : String(r.in_reply_to),
  createdAt: Number(r.created_at),
  sent: Number(r.sent) === 1,
  received: Number(r.received) === 1,
  read: Number(r.read) === 1,
  archived: Number(r.archived) === 1,
});

const snippetOf = (body: string) => body.replace(/```[\s\S]*?```/g, ' ').replace(/[#*`_>~[\]()-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export class PlayerMailbox {
  private readonly db: Db;
  private readonly users: () => User[];
  private readonly emit: (userId: ID, event: ServerEvent) => void;
  /** Timestamps are unique and increasing, so `before` pages never skip or repeat a conversation. */
  private lastAt: number;

  constructor(db: Db, users: () => User[], emit: (userId: ID, event: ServerEvent) => void) {
    this.db = db;
    this.users = users;
    this.emit = emit;
    db.sql.exec(SCHEMA);
    this.lastAt = Number((db.sql.prepare('SELECT COALESCE(MAX(created_at), 0) AS t FROM player_mail').get() as Row).t);
  }

  /** Unread messages in your inbox. */
  unread(userId: ID): number {
    const row = this.db.sql.prepare('SELECT COUNT(*) AS n FROM player_mail_box WHERE user_id = ? AND received = 1 AND read = 0 AND archived = 0').get(userId) as Row;
    return Number(row.n);
  }

  handle<K extends PlayerMailCommandName>(command: K, args: PlayerMailCommands[K]['args'], user: User): PlayerMailCommands[K]['result'] {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (command) {
      case 'list_player_mail': return this.list(user.id, a as PlayerMailCommands['list_player_mail']['args']) as PlayerMailCommands[K]['result'];
      case 'get_player_thread': return this.thread(user.id, String(a.threadId)) as PlayerMailCommands[K]['result'];
      case 'send_player_mail': return this.send(user, a as PlayerMailCommands['send_player_mail']['args']) as PlayerMailCommands[K]['result'];
      case 'update_player_mail': return this.update(user.id, a as PlayerMailCommands['update_player_mail']['args']) as PlayerMailCommands[K]['result'];
      case 'delete_player_mail': return this.delete(user.id, String(a.threadId), a.id ? String(a.id) : null) as PlayerMailCommands[K]['result'];
      default: throw new Error(`Unknown command: ${command}`);
    }
  }

  // ---- reading

  /**
   * Conversations with at least one of your messages in the folder (and, when
   * searching, one matching the query), ordered by their newest message.
   */
  private list(userId: ID, args: PlayerMailCommands['list_player_mail']['args']) {
    const folder = FOLDER_SQL[args.folder];
    if (!folder) throw new Error('Unknown folder');
    const limit = Math.min(Math.max(Number(args.limit) || PAGE, 1), 100);
    const having = [`SUM(CASE WHEN ${folder} THEN 1 ELSE 0 END) > 0`];
    const params: Array<string | number> = [userId];
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, 100) : '';
    if (query) {
      // Subject, body, or a participant whose name matches.
      const like = `%${escapeLike(query)}%`;
      const ors = [`m.subject LIKE ? ESCAPE '\\'`, `m.body LIKE ? ESCAPE '\\'`];
      params.push(like, like);
      const q = query.toLowerCase();
      for (const u of this.users().filter((x) => x.name.toLowerCase().includes(q)).slice(0, 20)) {
        ors.push('m.from_user = ?', 'instr(m.to_users, ?) > 0');
        params.push(u.id, JSON.stringify(u.id));
      }
      having.push(`SUM(CASE WHEN ${ors.join(' OR ')} THEN 1 ELSE 0 END) > 0`);
    }
    const before = Number(args.before);
    if (Number.isFinite(before) && before > 0) {
      having.push('latest < ?');
      params.push(before);
    }
    const rows = this.db.sql.prepare(
      `SELECT m.thread_id AS thread_id, MAX(m.created_at) AS latest
       FROM player_mail_box b JOIN player_mail m ON m.id = b.mail_id
       WHERE b.user_id = ?
       GROUP BY m.thread_id HAVING ${having.join(' AND ')}
       ORDER BY latest DESC LIMIT ?`,
    ).all(...params, limit + 1) as Row[];
    const threads = rows.slice(0, limit).map((r) => this.summarize(userId, String(r.thread_id)));
    return { threads: threads.filter((t): t is PlayerMailThread => !!t), more: rows.length > limit };
  }

  /** Your messages of a conversation, oldest first. */
  private messages(userId: ID, threadId: ID): PlayerMail[] {
    return (this.db.sql.prepare(
      `SELECT m.*, b.sent, b.received, b.read, b.archived
       FROM player_mail m JOIN player_mail_box b ON b.mail_id = m.id AND b.user_id = ?
       WHERE m.thread_id = ? ORDER BY m.created_at, m.rowid`,
    ).all(userId, threadId) as Row[]).map(toMail);
  }

  private summarize(userId: ID, threadId: ID): PlayerMailThread | null {
    const list = this.messages(userId, threadId);
    if (!list.length) return null;
    const latest = list[list.length - 1];
    const participants = new Set<ID>([latest.fromUserId]);
    for (const m of list) {
      participants.add(m.fromUserId);
      for (const id of m.toUserIds) participants.add(id);
    }
    return {
      threadId,
      subject: list[0].subject,
      latest: { ...latest, body: '' },
      snippet: snippetOf(latest.body),
      participantIds: [...participants],
      count: list.length,
      unread: list.filter((m) => m.received && !m.read).length,
    };
  }

  private thread(userId: ID, threadId: ID): PlayerMail[] {
    const list = this.messages(userId, threadId);
    if (!list.length) throw new Error('Conversation not found');
    return list;
  }

  // ---- writing

  private send(user: User, args: PlayerMailCommands['send_player_mail']['args']): PlayerMail {
    const known = new Map(this.users().map((u) => [u.id, u]));
    const to = [...new Set(Array.isArray(args.to) ? args.to.map(String) : [])];
    if (!to.length) throw new Error('Pick at least one recipient');
    if (to.length > MAX_RECIPIENTS) throw new Error(`At most ${MAX_RECIPIENTS} recipients`);
    const unknown = to.find((id) => !known.has(id));
    if (unknown) throw new Error('One of the recipients is not a player of this office');
    const body = typeof args.body === 'string' ? args.body.replace(/\r\n/g, '\n').trimEnd() : '';
    if (!body.trim()) throw new Error('Write something first');
    if (body.length > MAX_BODY) throw new Error(`Messages are limited to ${MAX_BODY.toLocaleString()} characters`);

    let threadId: ID;
    let subject = typeof args.subject === 'string' ? args.subject.replace(/\s+/g, ' ').trim() : '';
    const parentId = args.inReplyTo ? String(args.inReplyTo) : null;
    if (parentId) {
      // You can only answer a message you sent or received (and haven't deleted).
      const parent = this.db.sql.prepare(
        'SELECT m.thread_id, m.subject FROM player_mail m JOIN player_mail_box b ON b.mail_id = m.id AND b.user_id = ? WHERE m.id = ?',
      ).get(user.id, parentId) as Row | undefined;
      if (!parent) throw new Error('The message you are replying to is gone');
      threadId = String(parent.thread_id);
      if (!subject) subject = /^re:/i.test(String(parent.subject)) ? String(parent.subject) : `Re: ${String(parent.subject)}`;
    } else {
      threadId = '';
    }
    if (!subject) subject = '(no subject)';
    subject = subject.slice(0, MAX_SUBJECT);

    const id = randomUUID();
    if (!threadId) threadId = id;
    const now = this.lastAt = Math.max(Date.now(), this.lastAt + 1);
    const participants = new Set<ID>([user.id, ...to]);
    const sql = this.db.sql;
    sql.exec('BEGIN');
    try {
      sql.prepare('INSERT INTO player_mail (id, thread_id, from_user, to_users, subject, body, in_reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, threadId, user.id, JSON.stringify(to), subject, body, parentId, now);
      const box = sql.prepare('INSERT INTO player_mail_box (user_id, mail_id, sent, received, read, archived) VALUES (?, ?, ?, ?, ?, 0)');
      for (const uid of participants) {
        const sent = uid === user.id;
        const received = to.includes(uid);
        box.run(uid, id, sent ? 1 : 0, received ? 1 : 0, sent ? 1 : 0);
        // A new message brings an archived conversation back to the recipient's inbox.
        if (received) sql.prepare('UPDATE player_mail_box SET archived = 0 WHERE user_id = ? AND mail_id IN (SELECT id FROM player_mail WHERE thread_id = ?)').run(uid, threadId);
      }
      sql.exec('COMMIT');
    } catch (err) {
      sql.exec('ROLLBACK');
      throw err;
    }
    let mine: PlayerMail | null = null;
    for (const uid of participants) {
      const mail = this.messages(uid, threadId).find((m) => m.id === id)!;
      if (uid === user.id) mine = mail;
      this.emit(uid, { type: 'player_mail', mail, unread: this.unread(uid) });
    }
    return mine!;
  }

  private update(userId: ID, args: PlayerMailCommands['update_player_mail']['args']): null {
    const list = this.thread(userId, String(args.threadId));
    const sql = this.db.sql;
    const ids = list.map((m) => m.id);
    const inThread = `user_id = ? AND mail_id IN (${ids.map(() => '?').join(',')})`;
    if (args.read === true) sql.prepare(`UPDATE player_mail_box SET read = 1 WHERE ${inThread}`).run(userId, ...ids);
    if (args.read === false) {
      // Unread again: the latest message someone sent you.
      const last = [...list].reverse().find((m) => m.received);
      if (last) sql.prepare('UPDATE player_mail_box SET read = 0 WHERE user_id = ? AND mail_id = ?').run(userId, last.id);
    }
    if (typeof args.archived === 'boolean') sql.prepare(`UPDATE player_mail_box SET archived = ? WHERE ${inThread}`).run(args.archived ? 1 : 0, userId, ...ids);
    this.emit(userId, { type: 'player_mail_changed', unread: this.unread(userId) });
    return null;
  }

  private delete(userId: ID, threadId: ID, id: ID | null): null {
    const list = this.thread(userId, threadId);
    const ids = id ? list.filter((m) => m.id === id).map((m) => m.id) : list.map((m) => m.id);
    if (!ids.length) throw new Error('Message not found');
    const marks = ids.map(() => '?').join(',');
    const sql = this.db.sql;
    sql.exec('BEGIN');
    try {
      sql.prepare(`DELETE FROM player_mail_box WHERE user_id = ? AND mail_id IN (${marks})`).run(userId, ...ids);
      // Nobody has a copy any more: drop the message itself.
      sql.prepare(`DELETE FROM player_mail WHERE id IN (${marks}) AND NOT EXISTS (SELECT 1 FROM player_mail_box b WHERE b.mail_id = player_mail.id)`).run(...ids);
      sql.exec('COMMIT');
    } catch (err) {
      sql.exec('ROLLBACK');
      throw err;
    }
    this.emit(userId, { type: 'player_mail_changed', unread: this.unread(userId) });
    return null;
  }
}
