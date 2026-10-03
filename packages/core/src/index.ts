#!/usr/bin/env node
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { ClaudeCodeAdapter } from './adapters/claude-code.ts';
import { loadConfig } from './config.ts';
import { Db } from './db.ts';
import { Orchestrator } from './orchestrator.ts';
import { join } from './runner/join.ts';
import { LocalRunner } from './runner/local.ts';
import { startServer } from './server.ts';
import { Store } from './store.ts';
import { BossTerminal } from './terminal.ts';

const DEV_WEB_PORT = 5173;

async function host() {
  const config = loadConfig();
  const claude = new ClaudeCodeAdapter();
  const health = await claude.check();
  if (!health.ok) {
    console.error(`✖ ${health.error}`);
    process.exit(1);
  }

  const db = new Db(path.join(config.dataDir, 'agent-hq.db'));
  const store = new Store(db);
  const terminal = new BossTerminal();
  const orchestrator = new Orchestrator(store, db, config, terminal);
  const owner = orchestrator.ensureOwner();
  orchestrator.boot(new LocalRunner({
    userId: owner.id,
    dataDir: config.dataDir,
    adapters: [claude],
    remote: false,
    hqUrl: `ws://127.0.0.1:${config.port}`,
    resolveRepo: async (project) => ({ repoPath: project.repoPath, git: project.git }),
  }));
  const server = await startServer(config, store, orchestrator, terminal);

  const webPort = config.dev ? DEV_WEB_PORT : config.port;
  console.log(`Agent HQ is open for business  (Claude Code ${health.version})`);
  console.log(`  data: ${config.dataDir}`);
  console.log(`  open: http://localhost:${webPort}/?token=${config.ownerToken}`);
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
    console.log(`  teammates: http://${ips[0] ?? config.host}:${config.port}/  (send them an invite from the HUD)`);
  }

  const stop = () => {
    server.close();
    // Let agent processes exit cleanly, but never hang on shutdown.
    setTimeout(() => process.exit(0), 6000).unref();
    orchestrator.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const [command, ...rest] = process.argv.slice(2);
(command === 'join' ? join(rest) : host()).catch((err) => {
  console.error(err);
  process.exit(1);
});
