# Renders the evaluation documents under eval/extract/<flow>/src/*.html to
# PDF through Microsoft Word (COM automation; Windows with Word installed,
# i.e. the owner's machine). Word-exported PDFs are what Saudi firms attach
# in practice, and their text layer extracts in logical order through pdf.js
# with the artifacts `src/extract/run.ts repairPdfText` repairs (probed
# 2026-10-05, T-23). Chromium's PDF export was rejected: its text layer
# comes back as presentation-form glyphs in visual order, unreadable to
# pdf-parse.
#
# Usage, from apps/copilot:
#   powershell -ExecutionPolicy Bypass -File scripts/eval-extract-docs.ps1 [-Flow customer_contract] [-Name contract-07]
# `-Name` renders one source only (T-36: a new document joins the set without
# re-exporting the committed PDFs of its siblings).
# The PDFs are committed; re-run only after changing a source file.
param([string]$Flow = 'customer_contract', [string]$Name = '')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\eval\extract\$Flow")).Path
$src = Join-Path $root 'src'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
  $filter = if ($Name) { "$Name.html" } else { '*.html' }
  Get-ChildItem -Path $src -Filter $filter | Sort-Object Name | ForEach-Object {
    $out = Join-Path $root ($_.BaseName + '.pdf')
    $doc = $word.Documents.Open($_.FullName, $false, $true)
    $doc.SaveAs2([string]$out, 17)   # 17 = wdFormatPDF
    $doc.Close($false)
    Write-Host ("{0} -> {1}" -f $_.Name, (Split-Path $out -Leaf))
  }
} finally {
  $word.Quit()
}
