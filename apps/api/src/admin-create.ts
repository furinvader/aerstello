import { z } from 'zod';
import { migrate, pool } from './db.js';
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
await pool.query(
  `INSERT INTO hosts(email,name,password_hash,role) VALUES (lower($1),$2,$3,'admin')
   ON CONFLICT ((lower(email))) DO UPDATE SET name=excluded.name,password_hash=excluded.password_hash,role='admin',active=true`,
  [input.data.email, input.data.name, passwordHash],
);
console.log(`Administrator ${input.data.email} is ready.`);
await pool.end();
