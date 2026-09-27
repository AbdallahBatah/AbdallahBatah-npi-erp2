# Packs npi-erp-deploy.tar.gz for server transfer (no node_modules / build output / secrets).
# Uses tar (built into Windows 10+) so paths extract correctly on Linux.
# Run from repo root:  powershell -ExecutionPolicy Bypass -File deploy\pack.ps1

$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP 'npi-erp-stage'
$tarball = Join-Path $root 'npi-erp-deploy.tar.gz'

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Path $stage | Out-Null

robocopy $root $stage /E `
  /XD node_modules .next dist .git .claude docs `
  /XF npi-erp-deploy.tar.gz .env .deploy_history *.log *.tsbuildinfo | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }

if (Test-Path $tarball) { Remove-Item -Force $tarball }
tar -czf $tarball -C $stage .
if ($LASTEXITCODE -ne 0) { throw "tar failed with code $LASTEXITCODE" }
Remove-Item -Recurse -Force $stage

Write-Host "OK: $tarball"
Write-Host "Next: scp npi-erp-deploy.tar.gz root@SERVER_IP:/opt/"
