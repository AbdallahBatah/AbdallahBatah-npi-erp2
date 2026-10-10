#!/usr/bin/env node
// Starts `next dev` or `next start` on the port named by COPILOT_PORT
// (repository-root .env), falling back to 3100. An npm script cannot read an
// environment variable the same way on Windows and on Linux, so the port is
// resolved here.
import { spawn } from 'node:child_process';

const mode = process.argv[2];
if (mode !== 'dev' && mode !== 'start') {
  console.error('usage: node scripts/run-next.mjs <dev|start>');
  process.exit(1);
}

const raw = (process.env.COPILOT_PORT ?? '').trim();
const port = /^[0-9]{2,5}$/.test(raw) && Number(raw) <= 65535 ? raw : '3100';

const child = spawn('npx', ['next', mode, '-p', port], { stdio: 'inherit', shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
