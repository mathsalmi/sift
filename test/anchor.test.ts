import { describe, expect, it } from 'vitest';
import { resolveAnchor } from '../src/core/anchor';

describe('resolveAnchor', () => {
  const lines = ['import x', '', 'function a() {', '  return 1;', '}'];

  it('keeps the line when its text still matches', () => {
    expect(resolveAnchor(lines, 3, '  return 1;')).toEqual({ line: 3, outdated: false });
  });

  it('follows the text when lines were inserted above', () => {
    const moved = ['// header', '// more', ...lines];
    expect(resolveAnchor(moved, 3, '  return 1;')).toEqual({ line: 5, outdated: false });
  });

  it('marks the thread outdated when the text is gone, clamped to the file', () => {
    expect(resolveAnchor(['a', 'b'], 7, 'gone')).toEqual({ line: 1, outdated: true });
  });

  it('does not chase blank lines', () => {
    expect(resolveAnchor(['x', 'y', ''], 0, '')).toEqual({ line: 0, outdated: true });
  });
});
