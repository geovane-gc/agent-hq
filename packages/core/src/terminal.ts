import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import os from 'node:os';
import { cleanEnv } from './adapters/env.ts';

// The boss's private terminal (owner only). Uses a real PTY through the
// optional @lydell/node-pty dependency, falling back to a plain piped shell
// (no full-screen apps) when the native module can't load.

const HISTORY_LIMIT = 200_000;

interface Pty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] };
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] };
}

function loadNodePty(): typeof import('@lydell/node-pty') | null {
  try {
    return createRequire(import.meta.url)('@lydell/node-pty');
  } catch {
    return null;
  }
}

export class BossTerminal extends EventEmitter<{ data: [string]; exit: [number | null] }> {
  private pty: Pty | null = null;
  private history = '';
  private readonly cwd: string;

  constructor(cwd = os.homedir()) {
    super();
    this.cwd = cwd;
  }

  /** Starts the shell if needed; returns what was printed so far. */
  open(cols: number, rows: number): string {
    if (this.pty) {
      this.pty.resize(cols, rows);
      return this.history;
    }
    const { file, args } = defaultShell();
    const nodePty = loadNodePty();
    const onData = (data: string) => {
      this.history = (this.history + data).slice(-HISTORY_LIMIT);
      this.emit('data', data);
    };
    const onExit = (code: number | null) => {
      this.pty = null;
      this.emit('exit', code);
    };

    if (nodePty) {
      const p = nodePty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: this.cwd, env: cleanEnv() });
      p.onData(onData);
      p.onExit(({ exitCode }) => onExit(exitCode));
      this.pty = { write: (d) => p.write(d), resize: (c, r) => p.resize(c, r), kill: () => p.kill() };
    } else {
      const child = spawn(file, args, { cwd: this.cwd, env: cleanEnv(), windowsHide: true });
      child.stdout.setEncoding('utf8').on('data', (d: string) => onData(d.replace(/\r?\n/g, '\r\n')));
      child.stderr.setEncoding('utf8').on('data', (d: string) => onData(d.replace(/\r?\n/g, '\r\n')));
      child.on('exit', onExit);
      onData('\x1b[33m(basic terminal: interactive full-screen programs are not supported)\x1b[0m\r\n');
      // Without a PTY there is no line discipline: echo input and buffer lines ourselves.
      let line = '';
      this.pty = {
        write: (d) => {
          for (const ch of d) {
            if (ch === '\r') { onData('\r\n'); child.stdin.write(`${line}\n`); line = ''; }
            else if (ch === '\x7f') { if (line) { line = line.slice(0, -1); onData('\b \b'); } }
            else if (ch === '\x03') { line = ''; onData('^C\r\n'); }
            else { line += ch; onData(ch); }
          }
        },
        resize: () => {},
        kill: () => child.kill(),
      };
    }
    return this.history;
  }

  write(data: string) {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number) {
    this.pty?.resize(cols, rows);
  }

  dispose() {
    this.pty?.kill();
    this.pty = null;
  }
}
