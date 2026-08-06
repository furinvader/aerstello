import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { migrate, pool } from './db.js';

afterAll(async () => pool.end());

describe('database migrations', () => {
  it('holds an advisory lock while discovering and applying migrations', async () => {
    const client = {
      query: vi.fn(async (statement: string) => statement.startsWith('SELECT name FROM schema_migrations')
        ? { rowCount: 1, rows: [{ name: 'applied' }] }
        : { rowCount: 1, rows: [] }),
      release: vi.fn(),
    };

    await migrate({ connect: async () => client } as never);

    const statements = client.query.mock.calls.map(([statement]) => statement);
    expect(statements[0]).toContain('pg_advisory_lock');
    expect(statements.at(-1)).toContain('pg_advisory_unlock');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('makes catalog snapshots and audit evidence append-only', async () => {
    const client = {
      query: vi.fn(async (statement: string) => statement.startsWith('SELECT name FROM schema_migrations')
        ? { rowCount: 0, rows: [] }
        : { rowCount: 1, rows: [] }),
      release: vi.fn(),
    };

    await migrate({ connect: async () => client } as never);

    const migration = client.query.mock.calls
      .map(([statement]) => statement)
      .find((statement) => statement.includes('CREATE TABLE product_versions'));
    expect(migration).toMatch(/CREATE TRIGGER product_versions_enforce_append_only\s+BEFORE UPDATE OR DELETE ON product_versions/);
    expect(migration).toMatch(/CREATE TRIGGER product_versions_reject_truncate\s+BEFORE TRUNCATE ON product_versions/);
    expect(migration).toMatch(/CREATE TRIGGER audit_events_enforce_append_only\s+BEFORE UPDATE OR DELETE ON audit_events/);
    expect(migration).toMatch(/CREATE TRIGGER audit_events_reject_truncate\s+BEFORE TRUNCATE ON audit_events/);
  });

  it('temporarily disables every append-only truncate guard during reset', async () => {
    const seed = await readFile(new URL('./seed.ts', import.meta.url), 'utf8');

    for (const [table, trigger] of [
      ['product_versions', 'product_versions_reject_truncate'],
      ['audit_events', 'audit_events_reject_truncate'],
    ]) {
      const disable = `ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`;
      const truncate = 'TRUNCATE rate_limit_counters';
      const enable = `ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`;
      expect(seed.indexOf(disable)).toBeGreaterThan(-1);
      expect(seed.indexOf(truncate)).toBeGreaterThan(seed.indexOf(disable));
      expect(seed.indexOf(enable)).toBeGreaterThan(seed.indexOf(truncate));
    }
  });
});
