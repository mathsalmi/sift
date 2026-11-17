/** One request to an AI: a prompt, and the JSON shape the answer must have. */
export interface AiRequest {
  prompt: string;
  /** JSON Schema of the expected answer. */
  schema: Record<string, unknown>;
  /** Repository root; providers with tools may read files there. */
  cwd: string;
}

/**
 * Anything that can answer a prompt with JSON: Claude Code, a VS Code language model
 * (Copilot or any extension that provides one), or a command line tool.
 */
export interface AiProvider {
  /** Shown as the author of AI messages, e.g. "Claude" or "GPT-4o". */
  readonly name: string;
  ask(request: AiRequest, signal: AbortSignal): Promise<unknown>;
}

/** The answer to a comment thread. */
export interface ThreadAnswer {
  reply: string;
  edits?: FileEdit[];
}

/** Replace `find` (exact text, once in the file) with `replace`. An empty `find` creates a new file. */
export interface FileEdit {
  path: string;
  find: string;
  replace: string;
}
