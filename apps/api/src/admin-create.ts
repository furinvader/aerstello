import { z } from 'zod';
import { migrate, pool, transaction } from './db.js';
import { audit } from './events.js';
import { hashPassword } from './security.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const input = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  name: z.string().min(1),
}).safeParse({ email: argument('email'), password: argument('password'), name: argument('name') });

if (!input.success) {
  console.error('Usage: npm run admin:create -- --email admin@example.com --password "at-least-12-characters" --name "Admin"');
  process.exit(1);
}

await migrate();
const passwordHash = await hashPassword(input.data.password);
await transaction(async (client) => {
  const host = await client.query<{ id: string }>(
    `INSERT INTO hosts(email,name,password_hash,role) VALUES (lower($1),$2,$3,'admin')
     ON CONFLICT ((lower(email))) DO UPDATE SET name=excluded.name,password_hash=excluded.password_hash,role='admin',active=true
     RETURNING id`,
    [input.data.email, input.data.name, passwordHash],
  );
  const hostId = host.rows[0]!.id;
  await client.query('UPDATE host_sessions SET revoked_at=now() WHERE host_id=$1 AND revoked_at IS NULL', [hostId]);
  await audit('admin.credentials-reset', 'host', hostId, { email: input.data.email }, {}, client);
});
console.log(`Administrator ${input.data.email} is ready.`);
await pool.end();
