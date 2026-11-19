import { describe, expect, it } from 'vitest';
import { fuzzyMatch } from '../src/ui/fuzzy';

describe('fuzzyMatch', () => {
  it('matches each word as letters in order, ignoring case', () => {
    expect(fuzzyMatch('ctrl rev', 'src/controller/ReviewController.ts')).toBe(true);
    expect(fuzzyMatch('RVWctl', 'src/controller/ReviewController.ts')).toBe(true);
    expect(fuzzyMatch('', 'anything')).toBe(true);
    expect(fuzzyMatch('tsx', 'src/a.ts')).toBe(false);
    expect(fuzzyMatch('ui zzz', 'src/ui/PlanTree.ts')).toBe(false);
  });
});
