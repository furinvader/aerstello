import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { createBrowserContext } from '../support/browser-context';
import { connectDatabase } from '../support/database';
import { csrfHeaders } from '../support/operational-api-data';
import { stateFor } from './self-service-undo.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('the guest adds {string} from self-service',async({resources, guestDevice},product:string)=>{await guestDevice.page.getByText(product,{exact:true}).click()});

Then('an undo action is available',async({resources, guestDevice})=>{await expect(guestDevice.page.getByRole('button',{name:'Rückgängig'})).toBeVisible()});

Then('the undo action disappears after ten seconds',async({resources, guestDevice})=>{await expect(guestDevice.page.getByRole('button',{name:'Rückgängig'})).toBeHidden({timeout:12_000})});

Then('the expired item is no longer marked provisional',async({resources, guestDevice})=>{const item=guestDevice.page.locator('.line-item').filter({hasText:'Mineralwasser'});await expect(item).not.toContainText('10s')});

When('the guest uses undo',async({resources, guestDevice})=>{await guestDevice.page.getByRole('button',{name:'Rückgängig'}).click()});

Then('the guest tab has no open items',async({resources, guestDevice})=>{await expect(guestDevice.page.getByText('Noch keine Einträge')).toBeVisible()});

When('a self-service addition waits for a guest lock',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  const request=guestDevice.page.context().request;
  const me=await (await request.get('/api/v1/guest/me')).json() as {guest:{id:string}};
  const catalog=await (await request.get('/api/v1/guest/catalog')).json() as {data:{id:string;name:{de:string};priceCents:number;version:number}[]};
  const product=catalog.data.find(item=>item.name.de==='Mineralwasser')!;
  const databaseResource=await connectDatabase(resources);const database=databaseResource.client;let committed=false;
  try{
    await database.query('BEGIN');
    await database.query('SELECT id FROM guests WHERE id=$1 FOR UPDATE',[me.guest.id]);
    const holderXid=String((await database.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid);
    const addition=request.post('/api/v1/guest/items',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),productId:product.id,expectedPriceCents:product.priceCents,expectedProductVersion:product.version}});
    await expect.poll(async()=>Number((await database.query(`SELECT count(*) FROM pg_locks WHERE locktype='transactionid' AND transactionid::text=$1 AND NOT granted`,[holderXid])).rows[0].count),{timeout:5_000,intervals:[10,20,50]}).toBeGreaterThan(0);
    await new Promise(resolve=>setTimeout(resolve,2_000));
    await database.query('COMMIT');committed=true;
    const response=await addition;
    expect(response.status()).toBe(201);
    const item=await response.json() as {provisionalRemainingMs:number};
    workflow.guestUndoRemainingMs=item.provisionalRemainingMs;
  }finally{if(!committed)await database.query('ROLLBACK');await databaseResource.dispose()}
});

Then('the guest still receives a full undo window',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.guestUndoRemainingMs).toBeGreaterThan(9_000)});

When('guest undo starts before expiry and waits behind a rolled-back item lock',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  await guestDevice.page.getByText('Mineralwasser',{exact:true}).click();
  await expect(guestDevice.page.getByRole('button',{name:'Rückgängig'})).toBeVisible();
  const request=guestDevice.page.context().request;
  const tab=await (await request.get('/api/v1/guest/tab')).json() as {items:{id:string;provisionalUntil:string}[]};
  const item=tab.items[0]!;
  const databaseResource=await connectDatabase(resources);const database=databaseResource.client;let rolledBack=false;
  try{
    await database.query('BEGIN');
    await database.query(`UPDATE order_items SET status='voided',voided_at=clock_timestamp(),void_reason='rolled-back host void' WHERE id=$1`,[item.id]);
    const holderXid=String((await database.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid);
    const startedBeforeExpiry=Boolean((await database.query('SELECT clock_timestamp()<$1::timestamptz AS valid',[item.provisionalUntil])).rows[0].valid);
    const undoResponse=guestDevice.page.waitForResponse(response=>response.url().endsWith(`/api/v1/guest/items/${item.id}/undo`)&&response.request().method()==='POST');
    await guestDevice.page.getByRole('button',{name:'Rückgängig'}).click();
    await expect.poll(async()=>Number((await database.query(
      `SELECT count(*) FROM pg_locks WHERE locktype='transactionid' AND transactionid::text=$1 AND NOT granted`,[holderXid],
    )).rows[0].count),{timeout:5_000,intervals:[10,20,50]}).toBeGreaterThan(0);
    await expect.poll(async()=>Boolean((await database.query(
      'SELECT clock_timestamp()>=$1::timestamptz AS expired',[item.provisionalUntil],
    )).rows[0].expired),{timeout:12_000,intervals:[50,100,200]}).toBe(true);
    await database.query('ROLLBACK');rolledBack=true;
    const response=await undoResponse;
    const responseBody=await response.json() as {error:{code:string}};
    const current=await (await request.get('/api/v1/guest/tab')).json() as {itemCount:number;items:{id:string;status:string}[]};
    workflow.serializedGuestUndoResult={
      startedBeforeExpiry,status:response.status(),code:responseBody.error.code,itemCount:current.itemCount,
      itemStatus:current.items.find(candidate=>candidate.id===item.id)?.status??'missing',
    };
  }finally{if(!rolledBack)await database.query('ROLLBACK');await databaseResource.dispose()}
});

Then('the expired guest undo is rejected',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  expect(workflow.serializedGuestUndoResult).toEqual(expect.objectContaining({startedBeforeExpiry:true,status:409,code:'UNDO_EXPIRED'}));
  await expect(guestDevice.page.locator('.notice--error')).toContainText('Die Rückgängig-Frist ist abgelaufen.');
});

Then('the self-service item remains on the guest tab',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  expect(workflow.serializedGuestUndoResult).toEqual(expect.objectContaining({itemCount:1,itemStatus:'open'}));
  await expect(guestDevice.page.locator('.line-item').filter({hasText:'Mineralwasser'})).toBeVisible();
});

When('the guest device clock is twelve hours fast',async({resources, guestDevice})=>{
  await guestDevice.page.addInitScript(()=>{const actualNow=Date.now.bind(Date);Date.now=()=>actualNow()+12*60*60*1000});
  await guestDevice.page.reload();
  await expect(guestDevice.page.getByRole('heading',{name:'Luca Rossi'})).toBeVisible();
});

When('the guest refreshes a provisional item with a device clock twelve hours slow',async({resources, guestDevice})=>{
  const request=guestDevice.page.context().request;
  const catalog=await (await request.get('/api/v1/guest/catalog')).json() as {data:{id:string;name:{de:string};priceCents:number;version:number}[]};
  const product=catalog.data.find(item=>item.name.de==='Mineralwasser')!;
  expect((await request.post('/api/v1/guest/items',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),productId:product.id,expectedPriceCents:product.priceCents,expectedProductVersion:product.version}})).status()).toBe(201);
  await guestDevice.page.addInitScript(()=>{const actualNow=Date.now.bind(Date);Date.now=()=>actualNow()-12*60*60*1000});
  await guestDevice.page.reload();
  await expect(guestDevice.page.getByRole('heading',{name:'Luca Rossi'})).toBeVisible();
});

When('the guest retries undo after its first response is lost',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  await guestDevice.page.getByText('Mineralwasser',{exact:true}).click();await expect(guestDevice.page.getByRole('button',{name:'Rückgängig'})).toBeVisible();
  await guestDevice.page.evaluate(() => {
    const originalFetch=window.fetch.bind(window);let loseResponse=true;const ids:string[]=[];Object.assign(window,{__aerstelloGuestUndoRetryIds:ids});
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/guest/items/')&&url.endsWith('/undo')&&init?.method==='POST'){ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)};
  });
  await guestDevice.page.getByRole('button',{name:'Rückgängig'}).click();await expect(guestDevice.page.locator('.notice--error')).toBeVisible();await guestDevice.page.getByRole('button',{name:'Rückgängig'}).click();workflow.retriedGuestUndoMutationIds=await guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloGuestUndoRetryIds:string[]}).__aerstelloGuestUndoRetryIds);
});

Then('both guest undo attempts use the same mutation identifier',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedGuestUndoMutationIds).toHaveLength(2);expect(new Set(workflow.retriedGuestUndoMutationIds).size).toBe(1)});

When('the guest adds two different self-service items',async({resources, guestDevice})=>{await guestDevice.page.locator('.product-tile').getByText('Mineralwasser',{exact:true}).click();await expect(guestDevice.page.locator('.undo-toast')).toHaveCount(1);await guestDevice.page.locator('.product-tile').getByText('Hauskeks',{exact:true}).click()});

Then('both provisional items offer their own undo action',async({resources, guestDevice})=>{await expect(guestDevice.page.locator('.undo-toast')).toHaveCount(2);await expect(guestDevice.page.getByRole('button',{name:'Rückgängig'})).toHaveCount(2)});

When('another approved device for the same guest adds {string}',async({resources, guestDevice, page, browser},productName:string)=>{
  const hostRequest=page.context().request;
  const guest=await (await guestDevice.page.context().request.get('/api/v1/guest/me')).json() as {guest:{id:string}};
  const bootstrap=await (await hostRequest.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const room=bootstrap.rooms.find(item=>item.name==='102')!;
  const second=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});
  const access=await (await second.request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Luca second device',roomId:room.id,language:'de'}})).json() as {id:string;statusToken:string};
  expect((await hostRequest.post(`/api/v1/access-requests/${access.id}/approve`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),guestId:guest.guest.id,expiresAt:new Date(Date.now()+86_400_000).toISOString()}})).status()).toBe(200);
  expect((await second.request.post(`/api/v1/public/access-requests/${access.id}/status`,{data:{token:access.statusToken,grantId:crypto.randomUUID()}})).status()).toBe(200);
  const catalog=await (await second.request.get('/api/v1/guest/catalog')).json() as {data:{id:string;name:{de:string};priceCents:number;version:number}[]};
  const product=catalog.data.find(item=>item.name.de===productName)!;
  expect((await second.request.post('/api/v1/guest/items',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),productId:product.id,expectedPriceCents:product.priceCents,expectedProductVersion:product.version}})).status()).toBe(201);
  await expect(guestDevice.page.locator('.line-item').filter({hasText:productName})).toBeVisible();
});

Then('the original guest device sees the item without an undo action',async({resources, guestDevice})=>{await expect(guestDevice.page.getByRole('button',{name:'Rückgängig'})).toHaveCount(0)});
