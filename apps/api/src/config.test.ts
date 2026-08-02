import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';

describe('runtime configuration', () => {
  it('rejects the development session secret in production', () => {
    expect(() => parseConfig({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/);
  });

  it('rejects the published session secret placeholder in production', () => {
    expect(() => parseConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'replace-with-at-least-32-random-characters',
    })).toThrow(/SESSION_SECRET/);
  });

  it('accepts an explicitly configured production session secret', () => {
    expect(parseConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'a-unique-production-session-secret-value',
    }).SESSION_SECRET).toBe('a-unique-production-session-secret-value');
  });
});
