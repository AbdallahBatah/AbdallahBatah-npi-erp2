#!/usr/bin/env node
// Runs the API dev server and the copilot dev server together, prefixing
// each line of output with the process name. `shell: true` is required so
// `npm` resolves correctly on Windows (npm.cmd via cmd.exe).
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure the repository-root .env has a COPILOT_SESSION_KEY before either
// server starts — the copilot's auth route needs it on its very first
// request. Synchronous and idempotent (see the script itself).
const ensureKey = spawnSync(
  process.execPath,
  [path.join(__dirname, '..', 'apps', 'copilot', 'scripts', 'ensure-session-key.mjs')],
  { stdio: 'inherit' },
);
if (ensureKey.status !== 0) {
  process.exit(ensureKey.status ?? 1);
}

function run(name, args) {
  const child = spawn('npm', args, { shell: true, stdio: ['inherit', 'pipe', 'pipe'] });

  const prefix = (stream) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        process.stdout.write(`[${name}] ${line}\n`);
      }
    });
    stream.on('end', () => {
      if (buffer.length > 0) {
        process.stdout.write(`[${name}] ${buffer}\n`);
      }
    });
  };

  prefix(child.stdout);
  prefix(child.stderr);

  return child;
}

const api = run('api', ['run', 'dev:api']);
const copilot = run('copilot', ['run', 'dev', '-w', '@npi/copilot']);

let exiting = false;
function shutdown(code) {
  if (exiting) return;
  exiting = true;
  for (const child of [api, copilot]) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    if (process.platform === 'win32') {
      // With `shell: true` the child is cmd.exe; kill() would leave the npm
      // and node processes under it running and holding the port.
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill();
    }
  }
  process.exit(code);
}

api.on('exit', (code) => shutdown(code ?? 0));
copilot.on('exit', (code) => shutdown(code ?? 0));

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
