import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type HookHandler = (event: string, input: Record<string, any>) => void;

/**
 * Tiny loopback HTTP endpoint that receives Claude Code hook events from
 * hooks/hq-hook.ts and routes them to the session that registered the key.
 */
export class HookServer {
  private server: Server | null = null;
  private ready: Promise<string> | null = null;
  private readonly handlers = new Map<string, HookHandler>();

  url(): Promise<string> {
    this.ready ??= new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/hook') {
          res.writeHead(404).end();
          return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (d) => { body += d; if (body.length > 2_000_000) req.destroy(); });
        req.on('end', () => {
          res.writeHead(204).end();
          try {
            const { key, event, input } = JSON.parse(body);
            this.handlers.get(key)?.(event, input ?? {});
          } catch {}
        });
      });
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`));
    });
    return this.ready;
  }

  /** Returns an unguessable key; hook calls carrying it reach `handler`. */
  register(handler: HookHandler): string {
    const key = randomBytes(12).toString('base64url');
    this.handlers.set(key, handler);
    return key;
  }

  unregister(key: string) {
    this.handlers.delete(key);
  }
}
