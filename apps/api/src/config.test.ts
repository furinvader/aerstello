import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';

const productionEnvironment = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://skybar:secret@database.example/skybar',
  SESSION_SECRET: 'a-unique-production-session-secret-value',
  ACCESS_CAPABILITY_KEYS: 'v1:an-independent-access-capability-secret',
} as const;

describe('runtime configuration', () => {
  it('rejects the development session secret in production', () => {
    expect(() => parseConfig({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/);
  });

  it('rejects the published session secret placeholder in production', () => {
    expect(() => parseConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://skybar:secret@database.example/skybar',
      SESSION_SECRET: 'replace-with-at-least-32-random-characters',
      ACCESS_CAPABILITY_KEYS: productionEnvironment.ACCESS_CAPABILITY_KEYS,
    })).toThrow(/SESSION_SECRET/);
  });

  it('rejects the development database default in production', () => {
    expect(() => parseConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'a-unique-production-session-secret-value',
      ACCESS_CAPABILITY_KEYS: productionEnvironment.ACCESS_CAPABILITY_KEYS,
    })).toThrow(/DATABASE_URL/);
  });

  it('requires an explicit access-capability keyring in production', () => {
    expect(() => parseConfig({
      NODE_ENV: 'production',
      DATABASE_URL: productionEnvironment.DATABASE_URL,
      SESSION_SECRET: productionEnvironment.SESSION_SECRET,
    })).toThrow(/ACCESS_CAPABILITY_KEYS/);
    expect(() => parseConfig({
      ...productionEnvironment,
      ACCESS_CAPABILITY_KEYS: 'v2:a-valid-new-access-capability-secret,v1:replace-with-at-least-32-random-characters',
    })).toThrow(/ACCESS_CAPABILITY_KEYS/);
    expect(() => parseConfig({
      ...productionEnvironment,
      ACCESS_CAPABILITY_KEYS: `v1:${productionEnvironment.SESSION_SECRET}`,
    })).toThrow(/ACCESS_CAPABILITY_KEYS/);
  });

  it('accepts an ordered, versioned production capability keyring', () => {
    const parsed = parseConfig({
      ...productionEnvironment,
      ACCESS_CAPABILITY_KEYS: [
        'v2:a-new-independent-access-capability-secret',
        'v1:the-previous-access-capability-secret',
      ].join(','),
    });
    expect(parsed.SESSION_SECRET).toBe(productionEnvironment.SESSION_SECRET);
    expect(parsed.ACCESS_CAPABILITY_KEYS).toEqual([
      { id: 'v2', secret: 'a-new-independent-access-capability-secret' },
      { id: 'v1', secret: 'the-previous-access-capability-secret' },
    ]);
  });

  it('rejects ambiguous or unbounded capability keyrings without echoing secrets', () => {
    const duplicated = 'do-not-echo-this-duplicated-capability-secret';
    expect(() => parseConfig({ ACCESS_CAPABILITY_KEYS: `v1:${duplicated},v1:another-long-access-capability-secret` }))
      .toThrow(/identifiers must be unique/);
    expect(() => parseConfig({ ACCESS_CAPABILITY_KEYS: `v1:${duplicated},v2:${duplicated}` }))
      .toThrow(/secrets must be unique/);
    expect(() => parseConfig({ ACCESS_CAPABILITY_KEYS: Array.from({ length: 9 }, (_, index) => `v${index}:access-capability-secret-number-${index}-long`).join(',') }))
      .toThrow(/between one and eight/);
    let redactedError = '';
    try {
      parseConfig({ ACCESS_CAPABILITY_KEYS: 'v1:too-short-and-sensitive' });
    } catch (error) {
      redactedError = String(error);
    }
    expect(redactedError).toMatch(/entry 1/);
    expect(redactedError).not.toContain('too-short-and-sensitive');
  });

  it('uses distinct development session and access-capability secrets', () => {
    const parsed = parseConfig({});
    expect(parsed.ACCESS_CAPABILITY_KEYS[0]!.secret).not.toBe(parsed.SESSION_SECRET);
  });
});
