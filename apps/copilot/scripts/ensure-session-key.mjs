#!/usr/bin/env node
// Ensures the repository-root .env has a non-empty COPILOT_SESSION_KEY line
// (32 random bytes as 64 hex characters), appending one if it is missing or
// empty. Idempotent: running it again with a key already present does
// nothing. Never prints the key value itself — only whether one was found
// or created.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/copilot/scripts -> repository root (three levels up).
const ENV_PATH = path.resolve(__dirname, '..', '..', '..', '.env');

function hasNonEmptyKey(contents) {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('COPILOT_SESSION_KEY=')) continue;
    const value = line.slice('COPILOT_SESSION_KEY='.length).trim().replace(/^["']|["']$/g, '');
    if (value.length > 0) return true;
  }
  return false;
}

function main() {
  let contents = '';
  if (existsSync(ENV_PATH)) {
    contents = readFileSync(ENV_PATH, 'utf8');
  }

  if (hasNonEmptyKey(contents)) {
    console.log('session key present');
    return;
  }

  const key = randomBytes(32).toString('hex');
  const needsNewline = contents.length > 0 && !contents.endsWith('\n');
  const line = `${needsNewline ? '\n' : ''}COPILOT_SESSION_KEY=${key}\n`;
  writeFileSync(ENV_PATH, contents + line, 'utf8');
  console.log('session key created');
}

main();
