import { hashPassword } from './security.js';
import { migrate, pool, transaction } from './db.js';
import { seedPassword } from './seed-config.js';

const administratorPassword = seedPassword(process.env);
await migrate();
await transaction(async (client) => {
  if (process.env.E2E_RESET === 'true') {
    await client.query(`TRUNCATE rate_limit_counters,host_account_commands,product_create_commands,audit_events,realtime_events,bill_items,order_items,bills,order_batches,order_tabs,guest_sessions,access_requests,product_versions,products,categories,guests,rooms,host_sessions,hosts RESTART IDENTITY CASCADE`);
    await client.query(`UPDATE venue_settings SET name='',default_language='de',timezone='Europe/Berlin',catalog_version=1,version=1`);
  }
  const passwordHash = await hashPassword(administratorPassword);
  await client.query(
    `INSERT INTO hosts(email,name,password_hash,role,language) VALUES ('admin@skybar.test','Mira Host',$1,'admin','de')
     ON CONFLICT ((lower(email))) DO UPDATE SET password_hash=excluded.password_hash,active=true,role='admin',version=hosts.version+1`,
    [passwordHash],
  );
  await client.query(`UPDATE venue_settings SET name='Hotel Aurora',default_language='de',timezone='Europe/Berlin' WHERE id=1`);
  let rooms = await client.query<{id:string;name:string}>(`SELECT id,name FROM rooms WHERE archived_at IS NULL`);
  for (const [position,name] of ['101','102','Terrace'].entries()) {
    if (!rooms.rows.some((room) => room.name === name)) await client.query('INSERT INTO rooms(name,position) VALUES ($1,$2)',[name,position]);
  }
  rooms = await client.query(`SELECT id,name FROM rooms WHERE archived_at IS NULL`);
  const room101 = rooms.rows.find((room) => room.name === '101');
  if (room101) {
    const guest = await client.query(`SELECT id FROM guests WHERE name='Anna Berger' AND room_id=$1 AND archived_at IS NULL`,[room101.id]);
    if (!guest.rowCount) await client.query(`INSERT INTO guests(name,room_id,language) VALUES ('Anna Berger',$1,'de')`,[room101.id]);
  }
  let categories = await client.query<{id:string;name:{de:string}}>(`SELECT id,name FROM categories WHERE archived_at IS NULL`);
  for (const [position,name] of ['Getränke','Snacks'].entries()) {
    if (!categories.rows.some((category) => category.name.de === name)) await client.query('INSERT INTO categories(name,position) VALUES ($1,$2)',[JSON.stringify({de:name,it:name==='Getränke'?'Bevande':'Snack',en:name==='Getränke'?'Drinks':'Snacks'}),position]);
  }
  categories = await client.query(`SELECT id,name FROM categories WHERE archived_at IS NULL`);
  const drinks = categories.rows.find((category) => category.name.de === 'Getränke');
  const snacks = categories.rows.find((category) => category.name.de === 'Snacks');
  const version = (await client.query<{catalogVersion:number}>(`UPDATE venue_settings SET catalog_version=catalog_version+1 WHERE id=1 RETURNING catalog_version AS "catalogVersion"`)).rows[0]!.catalogVersion;
  const examples = [
    {categoryId:drinks?.id,name:{de:'Helles',it:'Birra chiara',en:'Lager'},price:420,self:false},
    {categoryId:drinks?.id,name:{de:'Mineralwasser',it:'Acqua minerale',en:'Mineral water'},price:260,self:true},
    {categoryId:snacks?.id,name:{de:'Chips',it:'Patatine',en:'Crisps'},price:220,self:true},
    {categoryId:snacks?.id,name:{de:'Hauskeks',it:'',en:''},price:180,self:true},
  ];
  for (const example of examples) {
    if(!example.categoryId) continue;
    const found=await client.query(`SELECT id FROM products WHERE name->>'de'=$1 AND archived_at IS NULL`,[example.name.de]);
    if(found.rowCount) continue;
    const product=await client.query<{id:string}>(`INSERT INTO products(category_id,name,price_cents,enabled,self_service_only,position,catalog_version) VALUES ($1,$2,$3,true,$4,0,$5) RETURNING id`,[example.categoryId,JSON.stringify(example.name),example.price,example.self,version]);
    await client.query(`INSERT INTO product_versions(product_id,catalog_version,name,price_cents,enabled,self_service_only) VALUES ($1,$2,$3,$4,true,$5)`,[product.rows[0]!.id,version,JSON.stringify(example.name),example.price,example.self]);
  }
});
console.log('Seed complete: admin@skybar.test');
await pool.end();
