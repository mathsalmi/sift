export interface ResolvedAnchor {
  line: number;
  /** True when the anchored line text is no longer in the file. */
  outdated: boolean;
}

/**
 * Finds where a thread's line is now: the stored line if its text still matches,
 * else the nearest line with the same text, else the stored line (clamped) marked outdated.
 */
export function resolveAnchor(lines: string[], line: number, lineText: string): ResolvedAnchor {
  const last = Math.max(lines.length - 1, 0);
  const clamped = Math.min(Math.max(line, 0), last);
  if (lines[line] === lineText) {
    return { line, outdated: false };
  }
  if (lineText.trim().length > 0) {
    for (let distance = 1; distance <= lines.length; distance++) {
      if (lines[line - distance] === lineText) {
        return { line: line - distance, outdated: false };
      }
      if (lines[line + distance] === lineText) {
        return { line: line + distance, outdated: false };
      }
    }
  }
  return { line: clamped, outdated: true };
}
