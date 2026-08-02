import { z } from 'zod';
import { migrate, pool, transaction } from './db.js';
import { audit } from './events.js';
import { hashPassword } from './security.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function passwordFromStdin(): Promise<string | undefined> {
  if (!process.argv.includes('--password-stdin') || process.stdin.isTTY) return undefined;
  process.stdin.setEncoding('utf8');
  let value = '';
  for await (const chunk of process.stdin) value += chunk;
  return value.split('\n', 1)[0]?.replace(/\r$/, '');
}

const input = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  name: z.string().min(1),
}).safeParse({ email: argument('email'), password: await passwordFromStdin(), name: argument('name') });

if (!input.success) {
  console.error('Usage: pipe the password on stdin, then run npm run admin:create -- --email admin@example.com --name "Admin" --password-stdin');
  process.exit(1);
}

await migrate();
const passwordHash = await hashPassword(input.data.password);
await transaction(async (client) => {
  const host = await client.query<{ id: string }>(
    `INSERT INTO hosts(email,name,password_hash,role) VALUES (lower($1),$2,$3,'admin')
     ON CONFLICT ((lower(email))) DO UPDATE SET name=excluded.name,password_hash=excluded.password_hash,role='admin',active=true,version=hosts.version+1
     RETURNING id`,
    [input.data.email, input.data.name, passwordHash],
  );
  const hostId = host.rows[0]!.id;
  await client.query('UPDATE host_sessions SET revoked_at=now() WHERE host_id=$1 AND revoked_at IS NULL', [hostId]);
  await audit('admin.credentials-reset', 'host', hostId, { email: input.data.email }, {}, client);
});
console.log(`Administrator ${input.data.email} is ready.`);
await pool.end();
