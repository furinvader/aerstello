import { afterAll, describe, expect, it, vi } from 'vitest';
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
});
