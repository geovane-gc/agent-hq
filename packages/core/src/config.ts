import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  /**
   * The open office's data dir (database, worktrees, agent notes). Each office
   * (save) has its own; see offices.ts. Before an office is open it equals rootDir.
   */
  dataDir: string;
  /** Machine-wide data dir (`--data-dir`): owner token, the offices index and every office. */
  rootDir: string;
  host: string;
  port: number;
  dev: boolean;
  ownerToken: string;
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function loadConfig(argv = process.argv.slice(2)): Config {
  const dataDir = path.resolve(
    argValue(argv, '--data-dir') ?? process.env.AGENT_HQ_DATA_DIR ?? path.join(os.homedir(), '.agent-hq'),
  );
  mkdirSync(dataDir, { recursive: true });

  // The owner token authenticates the local player. Other players will get
  // their own invite tokens once multiplayer lands.
  const tokenFile = path.join(dataDir, 'owner-token');
  let ownerToken: string;
  if (existsSync(tokenFile)) {
    ownerToken = readFileSync(tokenFile, 'utf8').trim();
  } else {
    ownerToken = randomBytes(24).toString('base64url');
    writeFileSync(tokenFile, ownerToken, { mode: 0o600 });
  }

  return {
    dataDir,
    rootDir: dataDir,
    host: argValue(argv, '--host') ?? process.env.AGENT_HQ_HOST ?? '127.0.0.1',
    port: Number(argValue(argv, '--port') ?? process.env.AGENT_HQ_PORT ?? 4317),
    dev: argv.includes('--dev'),
    ownerToken,
  };
}
