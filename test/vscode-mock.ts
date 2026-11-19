/** Minimal stand-in for the `vscode` module, enough to drive ReviewController in tests. */

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };
  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
    readonly query: string,
  ) {}
  get fsPath(): string {
    return this.path;
  }
  static file(fsPath: string): Uri {
    return new Uri('file', fsPath, '');
  }
  static from(parts: { scheme: string; path: string; query?: string }): Uri {
    return new Uri(parts.scheme, parts.path, parts.query ?? '');
  }
  toString(): string {
    return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}`;
  }
}

export interface ExecutedCommand {
  id: string;
  args: unknown[];
}

export const executed: ExecutedCommand[] = [];

export const commands = {
  executeCommand: async (id: string, ...args: unknown[]) => {
    executed.push({ id, args });
    return undefined;
  },
};

export const window: { activeTextEditor: { document: { uri: Uri } } | undefined } = {
  activeTextEditor: undefined,
};

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon {
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class FileDecoration {
  constructor(
    readonly badge?: string,
    readonly tooltip?: string,
    readonly color?: ThemeColor,
  ) {}
}
