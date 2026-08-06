import { migrate, pool } from './db.js';

await migrate();
console.log('Database migrations are up to date.');
await pool.end();
