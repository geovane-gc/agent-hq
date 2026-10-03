#!/usr/bin/env node
import { networkInterfaces } from 'node:os';
import { ClaudeCodeAdapter } from './adapters/claude-code.ts';
import { loadConfig } from './config.ts';
import { OfficeHost } from './offices.ts';
import { join } from './runner/join.ts';
import { startServer } from './server.ts';
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

  const terminal = new BossTerminal();
  // Offices are saves (see offices.ts). The most recently used one opens right
  // away, so teammates and runners can join without waiting for the owner's
  // start screen; a fresh install waits for the owner to create one.
  const host = new OfficeHost(config, [claude], terminal);
  const recent = host.mostRecent();
  if (recent) await host.open(recent.id);
  const server = await startServer(config, host, terminal);

  const webPort = config.dev ? DEV_WEB_PORT : config.port;
  console.log(`Agent HQ is open for business  (Claude Code ${health.version})`);
  console.log(`  data: ${config.rootDir}`);
  console.log(`  office: ${host.current ? `${host.current.info.name} (${host.current.info.mode})` : 'none yet, create one in the app'}`);
  console.log(`  open: http://localhost:${webPort}/?token=${config.ownerToken}`);
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
    console.log(`  teammates: http://${ips[0] ?? config.host}:${config.port}/  (send them an invite from the HUD)`);
  }

  const stop = () => {
    server.close();
    // Let agent processes exit cleanly, but never hang on shutdown.
    setTimeout(() => process.exit(0), 6000).unref();
    host.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const [command, ...rest] = process.argv.slice(2);
(command === 'join' ? join(rest) : host()).catch((err) => {
  console.error(err);
  process.exit(1);
});
