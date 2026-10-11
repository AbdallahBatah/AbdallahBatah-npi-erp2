/** Stable React keys for a list of display strings: the string itself, with a
 *  counter appended from the second occurrence on, so duplicates stay unique. */
export function lineKeys(lines: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const count = (seen.get(line) ?? 0) + 1;
    seen.set(line, count);
    return count === 1 ? line : `${line}\u0000${count}`;
  });
}

/** `lineKeys` paired with its lines, so a list renders `key` and `line` without indexing. */
export function keyedLines(lines: readonly string[]): { key: string; line: string }[] {
  const keys = lineKeys(lines);
  return lines.map((line, position) => ({ key: keys[position], line }));
}
