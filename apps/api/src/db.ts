import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.DATABASE_URL, max: 12 });

export async function transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function migrationsPath(): Promise<string> {
  const candidates = [resolve('apps/api/migrations'), resolve('migrations')];
  for (const candidate of candidates) {
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      // Try the workspace-local path next.
    }
  }
  throw new Error('Could not find apps/api/migrations');
}

type MigrationDatabase = Pick<pg.Pool, 'connect'>;

export async function migrate(database: MigrationDatabase = pool): Promise<void> {
  const directory = await migrationsPath();
  const client = await database.connect();
  let locked = false;
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('sky-bar-schema-migrations'))`);
    locked = true;
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      const applied = await client.query<{ name: string }>('SELECT name FROM schema_migrations WHERE name = $1', [file]);
      if (applied.rowCount) continue;
      const sql = await readFile(resolve(directory, file), 'utf8');
      await client.query('BEGIN');
      try {
        if (file === '0018_legacy_bill_timezone.sql' && config.LEGACY_BILL_TIMEZONE) {
          await client.query(`SELECT set_config('sky_bar.legacy_bill_timezone',$1,true)`, [config.LEGACY_BILL_TIMEZONE]);
        }
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      if (locked) await client.query(`SELECT pg_advisory_unlock(hashtext('sky-bar-schema-migrations'))`);
    } finally {
      client.release();
    }
  }
}
