// Claude Code hook / statusline command for interactive agent sessions.
// Claude Code runs it with the event JSON on stdin; we forward it to the local
// runner, which turns it into agent status in the office.
//
// Usage: node hq-hook.ts <runner-url> <session-key> <event>

const [url, key, event] = process.argv.slice(2);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  let payload: unknown = {};
  try { payload = JSON.parse(input || '{}'); } catch {}
  if (event === 'status') process.stdout.write('🏢 Agent HQ');
  try {
    await fetch(`${url}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, event, input: payload }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Never block or fail the agent because the office is unreachable.
  }
  process.exit(0);
});
