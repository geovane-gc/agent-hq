import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanEnv } from './adapters/env.ts';

// The system's "choose a folder" dialog, for players using Agent HQ in a
// browser (the desktop app uses Electron's own dialog through its preload).
// It opens on the screen of the machine running this process: the host for
// the boss, the `agent-hq join` runner for a teammate. macOS uses AppleScript,
// Windows a WinForms dialog through PowerShell, Linux zenity or kdialog.

/** How long the dialog may stay open before it is closed and the request fails. */
export const PICK_FOLDER_TIMEOUT_MS = 10 * 60_000;

const TITLE = 'Choose a folder for Agent HQ';

export interface PickerCommand {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  /** Exit codes that mean "the user closed the dialog". */
  cancelCodes: number[];
  /** stderr that means the same (AppleScript's "User canceled", -128). */
  cancelText?: RegExp;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The command does not exist on this machine. */
  missing: boolean;
  timedOut: boolean;
}

export type Exec = (cmd: PickerCommand, timeoutMs: number) => Promise<ExecResult>;

/** Where the dialog starts: the closest existing folder to `wanted`, else the home folder. */
export function startFolder(wanted: string | null | undefined): string {
  const home = os.homedir();
  let dir = wanted?.trim() ? path.resolve(wanted.trim().replace(/^~(?=$|[\\/])/, home)) : home;
  for (;;) {
    try {
      if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return home;
    dir = parent;
  }
}

// Runs as `on run argv`: the start folder is an argument, never part of the script.
const APPLESCRIPT = [
  'on run argv',
  'activate',
  `return POSIX path of (choose folder with prompt "${TITLE}" default location ((POSIX file (item 1 of argv)) as alias))`,
  'end run',
];

// The start folder comes in through the environment, never through the script text.
const POWERSHELL = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${TITLE}'
$dialog.ShowNewFolderButton = $true
$dialog.SelectedPath = $env:AGENT_HQ_PICK_START
$result = $dialog.ShowDialog($owner)
$owner.Dispose()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }
`;

/** The dialog commands to try on `platform`, in order (the next one runs when a command is missing). */
export function folderPickerCommands(platform: NodeJS.Platform, start: string): PickerCommand[] {
  if (platform === 'darwin') {
    return [{ cmd: 'osascript', args: [...APPLESCRIPT.flatMap((line) => ['-e', line]), start], cancelCodes: [], cancelText: /-128|User cancel/i }];
  }
  if (platform === 'win32') {
    return [{
      cmd: 'powershell.exe',
      // -EncodedCommand sidesteps Windows command-line quoting; -STA is required by WinForms dialogs.
      args: ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(POWERSHELL, 'utf16le').toString('base64')],
      env: { AGENT_HQ_PICK_START: start },
      cancelCodes: [],
    }];
  }
  // Linux and the BSDs: GNOME's zenity, else KDE's kdialog. Both exit 1 when cancelled.
  const inside = start.endsWith('/') ? start : `${start}/`;
  return [
    { cmd: 'zenity', args: ['--file-selection', '--directory', `--title=${TITLE}`, `--filename=${inside}`], cancelCodes: [1] },
    { cmd: 'kdialog', args: ['--getexistingdirectory', start, '--title', TITLE], cancelCodes: [1] },
  ];
}

function missingMessage(platform: NodeJS.Platform): string {
  if (platform === 'darwin' || platform === 'win32') return 'The system folder dialog is not available on this machine. Type the folder path instead.';
  return 'No folder dialog is available on this machine: install zenity (GNOME) or kdialog (KDE), or type the folder path instead.';
}

const execCommand: Exec = (c, timeoutMs) => new Promise((resolve) => {
  // Not windowsHide: on Windows that hides the first window the child shows, which is the dialog itself.
  execFile(c.cmd, c.args, { env: cleanEnv(c.env), windowsHide: false, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
    resolve({
      code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
      stdout: String(stdout),
      stderr: String(stderr),
      missing: e?.code === 'ENOENT',
      timedOut: !!e?.killed,
    });
  });
});

/** Strips the newline the tools print and a trailing separator ("/Users/me/dev/" from AppleScript), keeping roots. */
function cleanPath(out: string): string | null {
  const p = out.replace(/[\r\n]+$/, '');
  if (!p) return null;
  const trimmed = p.replace(/[\\/]+$/, '');
  return trimmed && !/^[A-Za-z]:$/.test(trimmed) ? trimmed : p;
}

let open = false;

/**
 * Shows the system's folder chooser on this machine and resolves the chosen
 * absolute path, or null when the user cancels. Rejects with an explanation
 * when no dialog is available, one is already open, or it stayed open too long.
 */
export async function pickFolder(
  defaultPath: string | null,
  opts: { platform?: NodeJS.Platform; exec?: Exec; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (platform !== 'darwin' && platform !== 'win32' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    throw new Error('This machine has no desktop session to show a folder dialog in. Type the folder path instead.');
  }
  if (open) throw new Error('A folder dialog is already open on this machine. Finish or cancel it first.');
  open = true;
  try {
    for (const c of folderPickerCommands(platform, startFolder(defaultPath))) {
      const r = await (opts.exec ?? execCommand)(c, opts.timeoutMs ?? PICK_FOLDER_TIMEOUT_MS);
      if (r.missing) continue;
      if (r.timedOut) throw new Error('The folder dialog was open for too long and was closed. Try again, or type the folder path.');
      if (r.code === 0) return cleanPath(r.stdout);
      if ((r.code !== null && c.cancelCodes.includes(r.code)) || c.cancelText?.test(r.stderr)) return null;
      throw new Error(`The folder dialog failed${r.stderr.trim() ? `: ${r.stderr.trim().split('\n').pop()}` : ` (${c.cmd} exited with ${r.code})`}. Type the folder path instead.`);
    }
    throw new Error(missingMessage(platform));
  } finally {
    open = false;
  }
}
