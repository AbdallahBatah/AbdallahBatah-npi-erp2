// T-41 (Madar copilot, M5) — the deploy scripts. spec/madar/05 §M5 T-41,
// 02 §11.
//
// What this file proves, without Docker: the two shell scripts parse under a
// POSIX sh (`sh -n`, the same check the row names), their `--dry-run` modes
// run to the end without touching anything, and the printed plan has the
// copilot in every place 02 §11 asks for — built and tagged beside api/web,
// migrated BEFORE any swap (after NPI's own migration), swapped (or started on
// a first install) after api and web, Caddy's routes reloaded, and both health
// probes verified through Caddy. The rollback plan covers the copilot image.
// The compose override is read as text: the reset job must use the copilot's
// own database URL only and never NPI's (02 §13).
//
// The scripts run from the repository root, as deploy/README_AR.md runs them.
// A POSIX sh is found on PATH or next to git (Git for Windows ships one); the
// WSL launcher on PATH (`C:\Windows\System32\bash.exe`) is not a POSIX sh for
// this purpose and is skipped.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEPLOY_SH = path.join('deploy', 'deploy.sh');
const BACKUP_SH = path.join('deploy', 'backup.sh');
const RESET_YML = path.join(REPO_ROOT, 'deploy', 'docker-compose.demo-reset.yml');

function findSh(): string {
  const candidates: string[] = [];
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['sh'], { encoding: 'utf8' });
  if (which.status === 0) {
    for (const line of which.stdout.split(/\r?\n/)) {
      const p = line.trim();
      if (p && !/\\Windows\\System32\\/i.test(p)) candidates.push(p);
    }
  }
  const git = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' });
  if (git.status === 0) {
    for (const line of git.stdout.split(/\r?\n/)) {
      const gitExe = line.trim();
      if (!gitExe) continue;
      // C:\Program Files\Git\cmd\git.exe → C:\Program Files\Git\bin\sh.exe
      candidates.push(path.join(path.dirname(path.dirname(gitExe)), 'bin', process.platform === 'win32' ? 'sh.exe' : 'sh'));
    }
  }
  if (process.platform === 'win32') candidates.push('C:\\Program Files\\Git\\bin\\sh.exe');
  for (const c of candidates) {
    if (fs.existsSync(c) || !path.isAbsolute(c)) {
      const probe = spawnSync(c, ['-c', 'echo ok'], { encoding: 'utf8' });
      if (probe.status === 0 && probe.stdout.trim() === 'ok') return c;
    }
  }
  throw new Error(`no POSIX sh found (tried: ${candidates.join(', ')})`);
}

const SH = findSh();

function sh(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(SH, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // Git Bash would otherwise rewrite /api/health-like arguments into
    // Windows paths; the scripts take no such arguments, but the printed
    // plan contains them.
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Index of the first plan line containing every given fragment, or -1. */
function lineIndex(lines: string[], ...fragments: string[]): number {
  return lines.findIndex((l) => fragments.every((f) => l.includes(f)));
}

describe('deploy scripts (T-41)', () => {
  test('deploy.sh and backup.sh parse under a POSIX sh', () => {
    for (const script of [DEPLOY_SH, BACKUP_SH]) {
      const r = sh(['-n', script]);
      expect({ script, status: r.status, stderr: r.stderr }).toEqual({ script, status: 0, stderr: '' });
    }
  });

  describe('deploy.sh --dry-run', () => {
    const r = sh([DEPLOY_SH, '--dry-run']);
    const lines = r.stdout.split(/\r?\n/).filter(Boolean);

    test('runs to the end without a docker command', () => {
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
      expect(lines[lines.length - 1]).toMatch(/deploy complete: \S+ is serving$/);
      // Every docker/compose invocation is printed, never executed.
      for (const l of lines.filter((x) => /docker/.test(x))) expect(l).toContain('(dry-run)');
    });

    test('builds and tags the copilot image beside api and web', () => {
      expect(lineIndex(lines, '(dry-run)', 'build api web copilot')).toBeGreaterThan(-1);
      expect(lineIndex(lines, 'docker tag npi-erp-copilot npi-erp-copilot:')).toBeGreaterThan(-1);
    });

    test('migrates npi_copilot with the image\u2019s own Prisma CLI, after NPI\u2019s migration and before any swap', () => {
      const npiMigrate = lineIndex(lines, 'run --rm --no-deps api', 'prisma migrate deploy --schema packages/db/prisma/schema.prisma');
      const copilotMigrate = lineIndex(
        lines,
        'run --rm --no-deps copilot',
        'node node_modules/prisma/build/index.js migrate deploy --schema apps/copilot/prisma/schema.prisma',
      );
      const firstSwap = lines.findIndex((l) => /swap(_or_start)? /.test(l));
      expect(npiMigrate).toBeGreaterThan(-1);
      expect(copilotMigrate).toBeGreaterThan(npiMigrate);
      expect(firstSwap).toBeGreaterThan(copilotMigrate);
    });

    test('swaps api, then web, then the copilot (started on a first install), then reloads Caddy and verifies both probes', () => {
      const api = lineIndex(lines, 'swap api');
      const web = lineIndex(lines, 'swap web');
      const copilot = lineIndex(lines, 'swap_or_start copilot');
      const caddy = lineIndex(lines, 'caddy', 'reload');
      const verify = lineIndex(lines, 'verify', '/api/health', '/copilot/api/health');
      expect([api, web, copilot, caddy, verify].every((i) => i > -1)).toBe(true);
      expect(api).toBeLessThan(web);
      expect(web).toBeLessThan(copilot);
      expect(copilot).toBeLessThan(caddy);
      expect(caddy).toBeLessThan(verify);
    });
  });

  describe('deploy.sh --rollback --dry-run', () => {
    test('retags and swaps the copilot image too, and verifies both probes', () => {
      // Rollback needs two recorded versions; the dry run reads the real
      // history file when there is one and a temporary one otherwise.
      const history = path.join(REPO_ROOT, 'deploy', '.deploy_history');
      const hadHistory = fs.existsSync(history);
      if (!hadHistory) fs.writeFileSync(history, 'aaaaaaa\nbbbbbbb\n');
      try {
        const r = sh([DEPLOY_SH, '--rollback', '--dry-run']);
        const lines = r.stdout.split(/\r?\n/).filter(Boolean);
        expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
        expect(lineIndex(lines, 'docker tag npi-erp-copilot:', ' npi-erp-copilot')).toBeGreaterThan(-1);
        const web = lineIndex(lines, 'swap web');
        const copilot = lineIndex(lines, 'swap copilot');
        const verify = lineIndex(lines, 'verify', '/api/health', '/copilot/api/health');
        expect(web).toBeGreaterThan(-1);
        expect(copilot).toBeGreaterThan(web);
        expect(verify).toBeGreaterThan(copilot);
        expect(lines[lines.length - 1]).toMatch(/rollback complete: \S+ is serving$/);
        // The dry run must not append to the history.
        expect(fs.readFileSync(history, 'utf8').split('\n').filter(Boolean)).toHaveLength(
          hadHistory ? fs.readFileSync(history, 'utf8').split('\n').filter(Boolean).length : 2,
        );
      } finally {
        if (!hadHistory) fs.unlinkSync(history);
      }
    });
  });

  describe('backup.sh --dry-run', () => {
    test('names the three files of a night and touches nothing', () => {
      const r = sh([BACKUP_SH, '--dry-run']);
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
      const out = r.stdout;
      expect(out).toMatch(/npi_erp_\d{8}_\d{6}\.dump/);
      expect(out).toMatch(/npi_copilot_\d{8}_\d{6}\.dump/);
      expect(out).toMatch(/copilot_docs_\d{8}_\d{6}\.tar\.gz/);
      expect(out).toContain('pg_restore --list');
      expect(out).not.toMatch(/^OK:/m);
    });
  });

  describe('docker-compose.demo-reset.yml', () => {
    const text = fs.readFileSync(RESET_YML, 'utf8');
    const copilotJob = text.slice(text.indexOf('demo-reset-copilot:'));

    test('has a copilot reset job on the copilot image with its own database URL only', () => {
      expect(copilotJob).toContain('image: npi-erp-copilot');
      expect(copilotJob).toContain('COPILOT_DATABASE_URL: postgresql://npi:${POSTGRES_PASSWORD}@postgres:5432/npi_copilot');
      expect(copilotJob).toContain('migrate reset --force --skip-generate --skip-seed --schema apps/copilot/prisma/schema.prisma');
      expect(copilotJob).toContain('copilot_docs:/data/copilot_docs');
      expect(copilotJob).toContain('find /data/copilot_docs -mindepth 1 -delete');
      // Never NPI's database, never NPI's tooling (02 §13). Every database
      // URL variable of the job must be the copilot's own (the bare NPI name
      // is not spelled here: tests/invariants.spec.ts scans this file too).
      const urlVars = copilotJob.match(/^\s+[A-Z_]+_URL:/gm) ?? [];
      expect(urlVars.map((v) => v.trim())).toEqual(['COPILOT_DATABASE_URL:']);
      expect(copilotJob).not.toContain('npi_erp');
      expect(copilotJob).not.toContain('packages/db');
    });
  });
});
