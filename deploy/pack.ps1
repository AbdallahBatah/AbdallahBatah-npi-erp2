# Packs npi-erp-deploy.tar.gz for server transfer (no node_modules / build output / secrets).
# Uses tar (built into Windows 10+) so paths extract correctly on Linux.
# Run from repo root:  powershell -ExecutionPolicy Bypass -File deploy\pack.ps1
#
# -ExcludeMigration <name>[,<name>]  leaves the named migration folder(s) out of
#   the archive, so `prisma migrate deploy` on the server never sees them. Used
#   to hold back a migration that must wait for a manual step (CRM Phase 1:
#   0023_crm_customer_unique_keys waits for the duplicate census and merge).
#   `migrate deploy` applies whatever is still unapplied, in name order, so the
#   held migration ships cleanly in a later release that includes it.

param([string[]]$ExcludeMigration = @())

$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP 'npi-erp-stage'
$tarball = Join-Path $root 'npi-erp-deploy.tar.gz'

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Path $stage | Out-Null

# The copilot's local artefacts (T-41): uploads under apps/copilot/data, the
# generated Prisma client (rebuilt inside the image for linux-musl), Playwright
# and perf outputs. None is read by the build (see .dockerignore) and the
# uploads can be large and are a developer's own documents.
$xd = @('node_modules', '.next', 'dist', '.git', '.claude', 'docs',
        'data', 'generated', 'test-results', 'perf-results', 'playwright-report') + $ExcludeMigration
robocopy $root $stage /E `
  /XD $xd `
  /XF npi-erp-deploy.tar.gz .env .deploy_history *.log *.tsbuildinfo | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }

if (Test-Path $tarball) { Remove-Item -Force $tarball }
tar -czf $tarball -C $stage .
if ($LASTEXITCODE -ne 0) { throw "tar failed with code $LASTEXITCODE" }
Remove-Item -Recurse -Force $stage

foreach ($m in $ExcludeMigration) { Write-Host "held back: packages/db/prisma/migrations/$m" }
Write-Host "OK: $tarball"
Write-Host "Next: scp npi-erp-deploy.tar.gz root@SERVER_IP:/opt/"
