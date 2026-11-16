import { describe, expect, it } from 'vitest';
import { shellQuote, withToolTimeout } from '../src/claudeSetup';

describe('withToolTimeout', () => {
  it('adds the timeout to empty or missing settings', () => {
    expect(JSON.parse(withToolTimeout(null)!)).toEqual({ env: { MCP_TOOL_TIMEOUT: '660000' } });
    expect(JSON.parse(withToolTimeout('  ')!)).toEqual({ env: { MCP_TOOL_TIMEOUT: '660000' } });
  });

  it('keeps every other setting and env var', () => {
    const updated = withToolTimeout(JSON.stringify({ model: 'opus', env: { FOO: '1' } }));
    expect(JSON.parse(updated!)).toEqual({ model: 'opus', env: { FOO: '1', MCP_TOOL_TIMEOUT: '660000' } });
  });

  it('never overwrites a value the user already set', () => {
    expect(withToolTimeout(JSON.stringify({ env: { MCP_TOOL_TIMEOUT: '900000' } }))).toBeNull();
  });

  it('refuses to touch a file it cannot parse', () => {
    expect(() => withToolTimeout('{ not json')).toThrow();
  });
});

describe('shellQuote', () => {
  it('quotes values with spaces and single quotes', () => {
    expect(shellQuote('http://127.0.0.1:47821/mcp')).toBe('http://127.0.0.1:47821/mcp');
    expect(shellQuote('Authorization: Bearer abc')).toBe(`'Authorization: Bearer abc'`);
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
  });
});
