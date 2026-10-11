/** Drops every trailing `/` from a configured base URL so joining a path
 *  that starts with `/` never doubles the slash. A scan rather than
 *  `replace(/\/+$/, '')`: the unanchored `\/+` is retried from every slash
 *  and runs quadratically on a long run of them (SonarCloud S8786). */
export function stripTrailingSlashes(base: string): string {
  let end = base.length;
  while (end > 0 && base[end - 1] === '/') end -= 1;
  return base.slice(0, end);
}
