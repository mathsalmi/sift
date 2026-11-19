import { describe, expect, it } from 'vitest';
import { fileTreeChildren } from '../src/ui/fileTree';

const files = ['README.md', 'src/ui/a.ts', 'src/ui/b.ts', 'src/core/c.ts', 'test/deep/only/d.test.ts'].map((path) => ({ path }));

describe('fileTreeChildren', () => {
  it('lists folders first, compresses single-folder chains, then files', () => {
    expect(fileTreeChildren(files, '')).toEqual([
      { type: 'dir', dir: 'src/', label: 'src' },
      { type: 'dir', dir: 'test/deep/only/', label: 'test/deep/only' },
      { type: 'file', file: { path: 'README.md' } },
    ]);
    expect(fileTreeChildren(files, 'src/')).toEqual([
      { type: 'dir', dir: 'src/core/', label: 'core' },
      { type: 'dir', dir: 'src/ui/', label: 'ui' },
    ]);
    expect(fileTreeChildren(files, 'src/ui/').map((e) => (e.type === 'file' ? e.file.path : e.dir))).toEqual([
      'src/ui/a.ts',
      'src/ui/b.ts',
    ]);
  });
});
