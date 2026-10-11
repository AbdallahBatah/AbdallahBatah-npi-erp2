/**
 * Client-side CSV export for report tables.
 *
 * Excel only reads Arabic text correctly when the file starts with a UTF-8 BOM,
 * so the blob is prefixed with one. Numbers are written unformatted (plain
 * `1234.56`) so the cells stay numeric and can be summed in the sheet.
 */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function downloadCsv(
  filename: string,
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
) {
  const lines = [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const BOM = String.fromCharCode(0xfeff); // Excel needs it to detect UTF-8
  const blob = new Blob([BOM + lines], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** `YYYY-MM-DD` stamp for export filenames (local time, not UTC). */
export function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
