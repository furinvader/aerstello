import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';

describe('runtime configuration', () => {
  it('rejects the development session secret in production', () => {
    expect(() => parseConfig({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/);
  });

  it('rejects the published session secret placeholder in production', () => {
    expect(() => parseConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://skybar:secret@database.example/skybar',
      SESSION_SECRET: 'replace-with-at-least-32-random-characters',
    })).toThrow(/SESSION_SECRET/);
  });

  it('rejects the development database default in production', () => {
    expect(() => parseConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'a-unique-production-session-secret-value',
    })).toThrow(/DATABASE_URL/);
  });

  it('accepts explicit production credentials and database destination', () => {
    expect(parseConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://skybar:secret@database.example/skybar',
      SESSION_SECRET: 'a-unique-production-session-secret-value',
    }).SESSION_SECRET).toBe('a-unique-production-session-secret-value');
  });

  it('treats the empty Compose legacy timezone default as unset', () => {
    expect(parseConfig({ LEGACY_BILL_TIMEZONE: '' }).LEGACY_BILL_TIMEZONE).toBeUndefined();
    expect(parseConfig({ LEGACY_BILL_TIMEZONE: 'Europe/Rome' }).LEGACY_BILL_TIMEZONE).toBe('Europe/Rome');
  });
});
