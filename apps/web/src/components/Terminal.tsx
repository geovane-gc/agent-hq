import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { client } from '../api.ts';
import { Modal } from './Modal.tsx';

/** The boss's private shell, opened from the computer in the boss room. */
export function BossTerminal({ onClose }: { onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: "'Cascadia Code', Menlo, Consolas, monospace",
      fontSize: 13,
      theme: { background: '#0f1117', foreground: '#d8dee9' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    fit.fit();

    const onData = (e: Event) => term.write((e as CustomEvent<string>).detail);
    const onExit = () => term.write('\r\n\x1b[90m[shell exited — reopen the terminal to start a new one]\x1b[0m\r\n');
    client.terminal.addEventListener('data', onData);
    client.terminal.addEventListener('exit', onExit);
    client.request('terminal_open', { cols: term.cols, rows: term.rows }).then(({ history }) => {
      if (history) term.write(history);
      term.focus();
    }).catch((err) => term.write(`\x1b[31m${err.message}\x1b[0m\r\n`));

    const input = term.onData((data) => { client.request('terminal_input', { data }).catch(() => {}); });
    const observer = new ResizeObserver(() => {
      fit.fit();
      client.request('terminal_resize', { cols: term.cols, rows: term.rows }).catch(() => {});
    });
    observer.observe(host.current!);

    return () => {
      observer.disconnect();
      input.dispose();
      client.terminal.removeEventListener('data', onData);
      client.terminal.removeEventListener('exit', onExit);
      term.dispose();
    };
  }, []);

  return (
    <Modal title="👑 Boss terminal" onClose={onClose} wide>
      <p className="hint">A real shell on the host machine, visible only to you. It keeps running when you close this window.</p>
      <div className="terminal" ref={host} />
    </Modal>
  );
}
