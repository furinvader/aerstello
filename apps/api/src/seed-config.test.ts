import { describe, expect, it } from 'vitest';
import { seedPassword } from './seed-config.js';

describe('development seed configuration', () => {
  it('requires an explicit administrator password', () => {
    expect(() => seedPassword({ NODE_ENV: 'development' })).toThrow(/SEED_ADMIN_PASSWORD/);
  });

  it('rejects production seeding even with an explicit password', () => {
    expect(() => seedPassword({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: 'ExplicitSeedPassword123!' })).toThrow(/disabled in production/);
  });

  it('accepts an explicit non-production password', () => {
    expect(seedPassword({ NODE_ENV: 'test', SEED_ADMIN_PASSWORD: 'ExplicitSeedPassword123!' })).toBe('ExplicitSeedPassword123!');
  });
});
