import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';

export { createApp } from './app.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.SECOND_BRAIN_PORT ?? 18997);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SECOND_BRAIN_PORT must be 1–65535.');
  const app = createApp();
  try {
    await app.listen(port);
    process.stdout.write(`Second Brain API ${app.version}: ${app.origin} (PID ${process.pid})\n`);
  } catch {
    process.stderr.write('Second Brain could not bind its loopback port. No existing process was stopped.\n');
    await app.close(); process.exitCode = 1;
  }
  let stopping = false;
  const shutdown = async () => { if (stopping) return; stopping = true; await app.close(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
