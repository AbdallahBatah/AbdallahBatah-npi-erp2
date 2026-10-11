/**
 * React keys for a list of plain strings: the text itself, with a counter
 * suffix on repeats (`text`, `text#2`, ...), so the keys stay unique without
 * using the array index.
 */
export function lineKeys(lines: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const n = (seen.get(line) ?? 0) + 1;
    seen.set(line, n);
    return n === 1 ? line : `${line}#${n}`;
  });
}
