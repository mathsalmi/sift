/** A row of a file list shown as a tree: a folder (single-child folders compressed, like "src/ui") or a file. */
export type FileTreeEntry<F extends { path: string }> =
  | { type: 'dir'; /** Full prefix with a trailing slash, e.g. "src/ui/". */ dir: string; label: string }
  | { type: 'file'; file: F };

/** Children of the folder `prefix` ("" for the top): folders first, then files, both sorted. */
export function fileTreeChildren<F extends { path: string }>(files: F[], prefix: string): FileTreeEntry<F>[] {
  const folders = new Map<string, F[]>();
  const direct: F[] = [];
  for (const file of files) {
    if (!file.path.startsWith(prefix)) {
      continue;
    }
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      direct.push(file);
      continue;
    }
    const name = rest.slice(0, slash);
    const group = folders.get(name) ?? [];
    group.push(file);
    folders.set(name, group);
  }

  const entries: FileTreeEntry<F>[] = [];
  for (const name of [...folders.keys()].sort((a, b) => a.localeCompare(b))) {
    const group = folders.get(name)!;
    let label = name;
    let dir = `${prefix}${name}/`;
    // Compress chains of folders that only hold one folder.
    for (;;) {
      const next = new Set<string>();
      let hasFile = false;
      for (const file of group) {
        const rest = file.path.slice(dir.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          hasFile = true;
          break;
        }
        next.add(rest.slice(0, slash));
      }
      if (hasFile || next.size !== 1) {
        break;
      }
      const [only] = next;
      label += `/${only}`;
      dir += `${only}/`;
    }
    entries.push({ type: 'dir', dir, label });
  }
  for (const file of [...direct].sort((a, b) => a.path.localeCompare(b.path))) {
    entries.push({ type: 'file', file });
  }
  return entries;
}
