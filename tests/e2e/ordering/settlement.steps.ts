import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { chooseOrder } from '../ordering/order-ui';
import { createBrowserContext } from '../support/browser-context';
import { connectDatabase } from '../support/database';
import { csrfHeaders,operationalData } from '../support/operational-api-data';
import { stateFor,type SettlementRecoveryRecord } from './settlement.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('the host settles the tab with cash',async({page})=>{await page.getByRole('button',{name:/Abrechnen/}).click();await page.locator('.choice-grid').getByRole('button',{name:/Bar/}).click();await page.locator('.modal').getByRole('button',{name:'Abrechnen'}).click()});

Then('the bill shows the venue name {string}',async({page},name:string)=>{await expect(page.locator('.bill-sheet h1')).toHaveText(name)});

Then('the bill offers printing',async({page})=>{await expect(page.getByRole('button',{name:/Drucken/})).toBeVisible()});

When('the host enters an Other payment note and settles with cash',async({page})=>{const modal=page.locator('.modal');await page.getByRole('button',{name:/Abrechnen|Incassa|Settle/}).click();await modal.locator('.choice-grid').getByRole('button',{name:/Sonstiges|Altro|Other/}).click();await modal.getByLabel(/Notiz|Nota|Note/).fill('Hidden payment note');await modal.locator('.choice-grid').getByRole('button',{name:/Bar|Contanti|Cash/,exact:true}).click();await expect(modal.getByLabel(/Notiz|Nota|Note/)).toHaveCount(0);await modal.getByRole('button',{name:/Abrechnen|Incassa|Settle/,exact:true}).click();await expect(page).toHaveURL(/\/app\/bills\//)});

Then('the cash bill has no payment note',async({page})=>{const billId=new URL(page.url()).pathname.split('/').at(-1)!;const bill=await (await page.context().request.get(`/api/v1/bills/${billId}`)).json() as {paymentMethod:string;paymentNote:string|null};expect(bill.paymentMethod).toBe('cash');expect(bill.paymentNote).toBeNull();await expect(page.locator('.bill-sheet footer')).not.toContainText('Hidden payment note')});

When('the host retries settlement after its first response is lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  await chooseOrder(page,'Helles','Anna Berger','101');await page.getByRole('button',{name:/Bestellung buchen/}).click();await expect(page.locator('.tab-pill')).toContainText('1 Artikel');
  await page.evaluate(() => {
    const originalFetch=window.fetch.bind(window);let loseResponse=true;const ids:string[]=[];
    Object.assign(window,{__aerstelloSettlementRetryIds:ids});
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(/\/api\/v1\/tabs\/[^/]+\/settle$/.test(url)&&init?.method==='POST'){ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)};
  });
  await page.getByRole('button',{name:/Abrechnen/}).click();await page.locator('.modal').getByRole('button',{name:'Abrechnen'}).click();await expect(page.locator('.modal .notice--error')).toBeVisible();workflow.uncertainSettlementDetailsLocked=await page.locator('.choice-grid').getByRole('button',{name:/Bar/}).isDisabled()&&await page.locator('.choice-grid').getByRole('button',{name:/Karte/}).isDisabled();await page.locator('.modal').getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();await expect(page).toHaveURL(/\/app\/bills\//);
  workflow.retriedSettlementMutationIds=await page.evaluate(()=>(window as unknown as {__aerstelloSettlementRetryIds:string[]}).__aerstelloSettlementRetryIds);
});

Then('both settlement attempts use the same mutation identifier',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedSettlementMutationIds).toHaveLength(2);expect(new Set(workflow.retriedSettlementMutationIds).size).toBe(1)});

Then('settlement details were locked while the result was uncertain',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.uncertainSettlementDetailsLocked).toBe(true)});

Then('the host reaches the single resulting bill',async({page})=>{await expect(page.locator('.bill-sheet')).toBeVisible();const bills=await (await page.context().request.get('/api/v1/bills')).json() as {data:unknown[]};expect(bills.data).toHaveLength(1)});

When('a committed settlement response is lost before modal close and reload',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  await chooseOrder(page,'Helles','Anna Berger','101');
  await page.getByRole('button',{name:/Bestellung buchen|Invia ordine|Submit order/}).click();
  await expect(page.locator('.tab-pill')).toContainText(/1 Artikel|1 articolo|1 item/);
  const instrumentSettlementFetch=()=>{
    const marker='__aerstelloSettlementFetchInstrumented';
    if((window as unknown as Record<string,unknown>)[marker])return;
    (window as unknown as Record<string,unknown>)[marker]=true;
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      if(/\/api\/v1\/tabs\/[^/]+\/settle$/.test(url)&&init?.method==='POST'){
        const requests=JSON.parse(localStorage.getItem('__aerstelloReloadSettlementRequests')??'[]') as {path:string;body:unknown}[];
        requests.push({path:new URL(url,location.href).pathname,body:JSON.parse(String(init.body))});
        localStorage.setItem('__aerstelloReloadSettlementRequests',JSON.stringify(requests));
        const response=await originalFetch(input,init);
        if(localStorage.getItem('__aerstelloLoseSettlementResponse')==='true'){
          localStorage.setItem('__aerstelloLoseSettlementResponse','false');
          throw new TypeError('Simulated committed settlement response loss');
        }
        return response;
      }
      return originalFetch(input,init);
    };
  };
  await page.addInitScript(instrumentSettlementFetch);
  await page.evaluate(()=>{localStorage.setItem('__aerstelloReloadSettlementRequests','[]');localStorage.setItem('__aerstelloLoseSettlementResponse','true')});
  await page.evaluate(instrumentSettlementFetch);
  await page.getByRole('button',{name:/Abrechnen|Incassa|Settle/}).click();
  const modal=page.locator('.modal');
  await modal.locator('.choice-grid').getByRole('button',{name:/Sonstiges|Altro|Other/}).click();
  await modal.getByLabel(/Notiz|Nota|Note/).fill('Recovery voucher');
  await modal.getByRole('button',{name:/Abrechnen|Incassa|Settle/,exact:true}).click();
  await expect(modal.locator('.notice--error')).toBeVisible();
  workflow.settlementRecoveryBeforeReload=await page.evaluate(()=>{
    const key=Object.keys(localStorage).find(item=>item.startsWith('aerstello-pending-settlement:'));
    return key?JSON.parse(localStorage.getItem(key)!) as SettlementRecoveryRecord:undefined;
  });
  await modal.getByRole('button',{name:/Schließen|Chiudi|Close/}).click();
  await expect(page.getByRole('button',{name:/Abrechnung wiederherstellen|Recupera incasso|Recover settlement/})).toBeVisible();
  await page.reload();
  const recoveryButton=page.getByRole('button',{name:/Abrechnung wiederherstellen|Recupera incasso|Recover settlement/});
  await expect(recoveryButton).toBeVisible();
  workflow.settlementRecoveryAfterReload=await page.evaluate(()=>{
    const key=Object.keys(localStorage).find(item=>item.startsWith('aerstello-pending-settlement:'));
    return key?JSON.parse(localStorage.getItem(key)!) as SettlementRecoveryRecord:undefined;
  });
  await recoveryButton.click();
  const recoveryModal=page.locator('.modal');
  await expect(recoveryModal.locator('.choice-grid').getByRole('button',{name:/Sonstiges|Altro|Other/})).toBeDisabled();
  await expect(recoveryModal.getByLabel(/Notiz|Nota|Note/)).toHaveValue('Recovery voucher');
  await expect(recoveryModal.getByLabel(/Notiz|Nota|Note/)).toBeDisabled();
  await recoveryModal.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();
  await expect(page).toHaveURL(/\/app\/bills\//);
  workflow.reloadedSettlementRequests=await page.evaluate(()=>JSON.parse(localStorage.getItem('__aerstelloReloadSettlementRequests')??'[]') as {path:string;body:SettlementRecoveryRecord['command']}[]);
  workflow.reloadedSettlementStorageCount=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('aerstello-pending-settlement:')).length);
  workflow.reloadedSettlementBillCount=((await (await page.context().request.get('/api/v1/bills')).json()) as {data:unknown[]}).data.length;
});

Then('settlement recovery replays the original frozen command',async({ scenarioState })=>{const workflow=stateFor(scenarioState);
  expect(workflow.settlementRecoveryBeforeReload).toBeDefined();
  expect(workflow.settlementRecoveryAfterReload).toEqual(workflow.settlementRecoveryBeforeReload);
  expect(workflow.settlementRecoveryBeforeReload).toEqual(expect.objectContaining({guestName:'Anna Berger',roomName:'101',command:{mutationId:expect.any(String),expectedItemCount:1,expectedTotalCents:420,paymentMethod:'other',note:'Recovery voucher'}}));
  expect(workflow.reloadedSettlementRequests).toHaveLength(2);
  expect(workflow.reloadedSettlementRequests[0]).toEqual(workflow.reloadedSettlementRequests[1]);
  expect(workflow.reloadedSettlementRequests[0]!.body).toEqual(workflow.settlementRecoveryBeforeReload!.command);
  expect(workflow.reloadedSettlementRequests[0]!.path).toBe(`/api/v1/tabs/${workflow.settlementRecoveryBeforeReload!.tabId}/settle`);
});

Then('the reload reaches the single recovered bill exactly once',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);expect(workflow.reloadedSettlementBillCount).toBe(1);await expect(page.locator('.bill-sheet')).toBeVisible()});

Then('the recovered settlement command is cleared',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.reloadedSettlementStorageCount).toBe(0)});

When('settlement waits for a locked tab',async({resources, scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;
  const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};
  const databaseResource=await connectDatabase(resources);const database=databaseResource.client;let committed=false;
  try{
    await database.query('BEGIN');await database.query('SELECT id FROM order_tabs WHERE id=$1 FOR UPDATE',[order.tabId]);const holderXid=String((await database.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid);
    const settlement=request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}});
    await expect.poll(async()=>Number((await database.query(`SELECT count(*) FROM pg_locks WHERE locktype='transactionid' AND transactionid::text=$1 AND NOT granted`,[holderXid])).rows[0].count),{timeout:5_000,intervals:[10,20,50]}).toBeGreaterThan(0);
    await new Promise(resolve=>setTimeout(resolve,2_000));await database.query('COMMIT');committed=true;
    const response=await settlement;expect(response.status()).toBe(200);const bill=await response.json() as {id:string};workflow.settlementTimestampAgeMs=Number((await database.query(`SELECT extract(epoch FROM (clock_timestamp()-settled_at))*1000 AS "ageMs" FROM bills WHERE id=$1`,[bill.id])).rows[0].ageMs);
  }finally{if(!committed)await database.query('ROLLBACK');await databaseResource.dispose()}
});

Then('the bill timestamp follows the lock release',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.settlementTimestampAgeMs).toBeLessThan(1_000)});

When('settlement starts during an active guest undo window and waits for a locked tab',async({resources, scenarioState, page,browser})=>{const workflow=stateFor(scenarioState);
  const hostRequest=page.context().request;
  const bootstrap=await (await hostRequest.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const room=bootstrap.rooms.find(item=>item.name==='102')!;
  const access=await (await hostRequest.post('/api/v1/public/access-requests',{
    data:{mutationId:crypto.randomUUID(),name:'Settlement deadline guest',roomId:room.id,language:'de'},
  })).json() as {id:string;statusToken:string};
  expect((await hostRequest.post(`/api/v1/access-requests/${access.id}/approve`,{
    headers:csrfHeaders,
    data:{mutationId:crypto.randomUUID(),expiresAt:new Date(Date.now()+86_400_000).toISOString()},
  })).status()).toBe(200);
  const guestContext=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});
  const exchange=await guestContext.request.post(`/api/v1/public/access-requests/${access.id}/status`,{
    data:{token:access.statusToken,grantId:crypto.randomUUID()},
  });
  expect(exchange.status()).toBe(200);
  expect((await exchange.json()) as {granted:boolean}).toEqual(expect.objectContaining({granted:true}));
  const catalog=await (await guestContext.request.get('/api/v1/guest/catalog')).json() as {
    data:{id:string;name:{de:string};priceCents:number;version:number}[];
  };
  const product=catalog.data.find(item=>item.name.de==='Mineralwasser')!;
  const addition=await guestContext.request.post('/api/v1/guest/items',{
    headers:csrfHeaders,
    data:{mutationId:crypto.randomUUID(),productId:product.id,expectedPriceCents:product.priceCents,expectedProductVersion:product.version},
  });
  expect(addition.status()).toBe(201);
  const item=await addition.json() as {id:string};
  const tab=await (await guestContext.request.get('/api/v1/guest/tab')).json() as {id:string};
  const settlementCommand=()=>({
    mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash',
  });
  const immediate=await hostRequest.post(`/api/v1/tabs/${tab.id}/settle`,{
    headers:csrfHeaders,data:settlementCommand(),
  });
  const immediateBody=await immediate.json() as {error:{code:string}};
  const databaseResource=await connectDatabase(resources);const database=databaseResource.client;let committed=false;
  try{
    await database.query(
      `UPDATE order_items SET provisional_until=clock_timestamp()+interval '3 seconds' WHERE id=$1`,[item.id],
    );
    await database.query('BEGIN');
    await database.query('SELECT id FROM order_tabs WHERE id=$1 FOR UPDATE',[tab.id]);
    const holderXid=String((await database.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid);
    const settlement=hostRequest.post(`/api/v1/tabs/${tab.id}/settle`,{
      headers:csrfHeaders,data:settlementCommand(),
    });
    await expect.poll(async()=>Number((await database.query(
      `SELECT count(*) FROM pg_locks WHERE locktype='transactionid' AND transactionid::text=$1 AND NOT granted`,[holderXid],
    )).rows[0].count),{timeout:5_000,intervals:[10,20,50]}).toBeGreaterThan(0);
    const startedBeforeExpiry=Boolean((await database.query(
      'SELECT provisional_until>clock_timestamp() AS active FROM order_items WHERE id=$1',[item.id],
    )).rows[0].active);
    await expect.poll(async()=>Boolean((await database.query(
      'SELECT provisional_until<=clock_timestamp() AS expired FROM order_items WHERE id=$1',[item.id],
    )).rows[0].expired),{timeout:5_000,intervals:[25,50,100]}).toBe(true);
    const expiredBeforeRelease=Boolean((await database.query(
      'SELECT provisional_until<=clock_timestamp() AS expired FROM order_items WHERE id=$1',[item.id],
    )).rows[0].expired);
    await database.query('COMMIT');committed=true;
    const settlementResponse=await settlement;
    const stored=(await database.query<{
      billLineCount:string;billCount:string;itemStatus:string;
    }>(
      `SELECT (SELECT count(*) FROM bill_items WHERE original_order_item_id=$1)::text AS "billLineCount",
              (SELECT count(*) FROM bills WHERE tab_id=$2)::text AS "billCount",
              (SELECT status::text FROM order_items WHERE id=$1) AS "itemStatus"`,
      [item.id,tab.id],
    )).rows[0]!;
    workflow.settlementUndoClockResult={
      immediateStatus:immediate.status(),
      immediateCode:immediateBody.error.code,
      startedBeforeExpiry,
      expiredBeforeRelease,
      settlementStatus:settlementResponse.status(),
      billLineCount:Number(stored.billLineCount),
      billCount:Number(stored.billCount),
      itemStatus:stored.itemStatus,
    };
  }finally{if(!committed)await database.query('ROLLBACK');await databaseResource.dispose()}
});

Then('immediate settlement is rejected while the undo deadline is active',async({ scenarioState })=>{const workflow=stateFor(scenarioState);
  expect(workflow.settlementUndoClockResult).toEqual(expect.objectContaining({immediateStatus:409,immediateCode:'UNDO_PENDING'}));
});

Then('settlement succeeds after the undo deadline passes during the lock wait',async({ scenarioState })=>{const workflow=stateFor(scenarioState);
  expect(workflow.settlementUndoClockResult).toEqual(expect.objectContaining({
    startedBeforeExpiry:true,expiredBeforeRelease:true,settlementStatus:200,
  }));
});

Then('the expired provisional item is billed exactly once',async({ scenarioState })=>{const workflow=stateFor(scenarioState);
  expect(workflow.settlementUndoClockResult).toEqual(expect.objectContaining({billLineCount:1,billCount:1,itemStatus:'billed'}));
});

When('bill reversal waits for a locked guest',async({resources, scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;
  const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};
  const settlement=await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}});expect(settlement.status()).toBe(200);const bill=await settlement.json() as {id:string};
  const databaseResource=await connectDatabase(resources);const database=databaseResource.client;let committed=false;
  try{
    const snapshotSql=`SELECT settled_at,venue_name,venue_timezone,guest_name,room_name,host_name,total_cents,payment_method,payment_note FROM bills WHERE id=$1`;
    const linesSql=`SELECT original_order_item_id,product_name,unit_price_cents,quantity,source FROM bill_items WHERE bill_id=$1 ORDER BY id`;
    const billBefore=(await database.query(snapshotSql,[bill.id])).rows[0];const linesBefore=(await database.query(linesSql,[bill.id])).rows;
    await database.query('BEGIN');await database.query('SELECT id FROM guests WHERE id=$1 FOR UPDATE',[guest.id]);const holderXid=String((await database.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid);
    const reversal=request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),reason:'Lock wait correction'}});
    await expect.poll(async()=>Number((await database.query(`SELECT count(*) FROM pg_locks WHERE locktype='transactionid' AND transactionid::text=$1 AND NOT granted`,[holderXid])).rows[0].count),{timeout:5_000,intervals:[10,20,50]}).toBeGreaterThan(0);
    const releaseFloor=(await database.query<{timestamp:Date}>('SELECT clock_timestamp() AS timestamp')).rows[0]!.timestamp;await database.query('COMMIT');committed=true;
    const response=await reversal;expect(response.status()).toBe(200);
    const current=(await database.query<{voidedAt:Date}>(`SELECT voided_at AS "voidedAt" FROM bills WHERE id=$1`,[bill.id])).rows[0]!;
    const auditRow=(await database.query<{createdAt:Date|null;count:number}>(`SELECT min(created_at) AS "createdAt",count(*)::int AS count FROM audit_events WHERE action='bill.voided' AND entity_type='bill' AND entity_id=$1`,[bill.id])).rows[0]!;
    expect(current.voidedAt).toBeInstanceOf(Date);expect(auditRow.createdAt).toBeInstanceOf(Date);
    workflow.billVoidLockTiming={releaseFloor,voidedAt:current.voidedAt,auditCreatedAt:auditRow.createdAt!,auditCount:auditRow.count,billBefore,billAfter:(await database.query(snapshotSql,[bill.id])).rows[0],linesBefore,linesAfter:(await database.query(linesSql,[bill.id])).rows};
  }finally{if(!committed)await database.query('ROLLBACK');await databaseResource.dispose()}
});

Then('the bill void and audit timestamps follow the lock release',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.billVoidLockTiming).toBeDefined();expect(workflow.billVoidLockTiming!.voidedAt.getTime()).toBeGreaterThanOrEqual(workflow.billVoidLockTiming!.releaseFloor.getTime());expect(workflow.billVoidLockTiming!.auditCreatedAt.getTime()).toBeGreaterThanOrEqual(workflow.billVoidLockTiming!.releaseFloor.getTime());expect(workflow.billVoidLockTiming!.auditCreatedAt.getTime()).toBeGreaterThanOrEqual(workflow.billVoidLockTiming!.voidedAt.getTime());expect(workflow.billVoidLockTiming!.auditCount).toBe(1)});

Then('reversal leaves the original bill history unchanged',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.billVoidLockTiming).toBeDefined();expect(workflow.billVoidLockTiming!.billAfter).toEqual(workflow.billVoidLockTiming!.billBefore);expect(workflow.billVoidLockTiming!.linesAfter).toEqual(workflow.billVoidLockTiming!.linesBefore)});

When('the same settlement mutation is submitted concurrently',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};const data={mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'};const responses=await Promise.all([request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data}),request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data})]);workflow.concurrentSettlementStatuses=responses.map(response=>response.status());workflow.concurrentSettlementBillCount=((await (await request.get('/api/v1/bills')).json()) as {data:unknown[]}).data.length});

Then('both concurrent settlement responses succeed',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.concurrentSettlementStatuses).toEqual([200,200])});

Then('concurrent settlement creates only one bill',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.concurrentSettlementBillCount).toBe(1)});

When('another order changes the tab while settlement is open',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await chooseOrder(page,'Helles','Anna Berger','101');await page.getByRole('button',{name:/Bestellung buchen/}).click();await expect(page.locator('.tab-pill')).toContainText('1 Artikel');await page.getByRole('button',{name:/Abrechnen/}).click();const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;expect((await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).status()).toBe(201);await page.locator('.modal').getByRole('button',{name:'Abrechnen'}).click();await expect(page.locator('.modal .notice--error')).toBeVisible();workflow.staleSettlementBillCount=((await (await request.get('/api/v1/bills')).json()) as {data:unknown[]}).data.length});

Then('settlement reports that the displayed tab changed',async({page})=>{await expect(page.locator('.modal')).toContainText(/Bestellung hat sich geändert|ordine è cambiato|order changed/i)});

Then('no bill is created for the stale confirmation',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleSettlementBillCount).toBe(0)});

When('the host retries settlement with the refreshed confirmation',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await page.locator('.modal').getByRole('button',{name:/Abrechnen|Incassa|Settle/}).click();await expect(page).toHaveURL(/\/app\/bills\//);const request=page.context().request;const bills=await (await request.get('/api/v1/bills')).json() as {data:{id:string}[]};workflow.refreshedSettlementBillCount=bills.data.length;const bill=await (await request.get(`/api/v1/bills/${bills.data[0]!.id}`)).json() as {items:{quantity:number}[]};workflow.refreshedSettlementItemCount=bill.items.reduce((sum,item)=>sum+item.quantity,0)});

Then('one bill is created for the refreshed tab',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.refreshedSettlementBillCount).toBe(1);expect(workflow.refreshedSettlementItemCount).toBe(2)});

When('another device voids the last item while settlement is open',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await chooseOrder(page,'Helles','Anna Berger','101');await page.getByRole('button',{name:/Bestellung buchen|Invia ordine|Submit order/}).click();await expect(page.locator('.tab-pill')).toContainText(/1 Artikel|1 articolo|1 item/);await page.getByRole('button',{name:/Abrechnen|Incassa|Settle/}).click();const {request,guests}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const tab=await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json() as {items:{id:string;billingVersion:number}[]};expect((await request.post(`/api/v1/order-items/${tab.items[0]!.id}/void`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),reason:'Removed on another device',expectedBillingVersion:tab.items[0]!.billingVersion}})).status()).toBe(200);await page.locator('.modal').getByRole('button',{name:/Abrechnen|Incassa|Settle/}).click();await expect(page.locator('.modal')).toHaveCount(0);workflow.staleSettlementBillCount=((await (await request.get('/api/v1/bills')).json()) as {data:unknown[]}).data.length});

Then('the empty settlement confirmation closes without a bill',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);expect(workflow.staleSettlementBillCount).toBe(0);await expect(page.getByRole('button',{name:/Abrechnen|Incassa|Settle/})).toHaveCount(0)});

When('the host submits orders beyond the maximum tab total',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find((item)=>item.name==='Anna Berger')!;const categoryId=products.data[0]!.categoryId;
  const created=await request.post('/api/v1/products',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:{de:'Limitprodukt',it:'',en:''},priceCents:10_000_000,categoryId,enabled:true,selfServiceOnly:false}});expect(created.status()).toBe(201);const product=await created.json() as {id:string};const catalog=await (await request.get('/api/v1/products')).json() as {catalogVersion:number};
  const submit=async(quantity:number)=>request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:catalog.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity}]}});
  expect((await submit(99)).status()).toBe(201);expect((await submit(99)).status()).toBe(201);workflow.tabTotalBeforeExcess=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {totalCents:number}).totalCents;workflow.excessiveOrderStatus=(await submit(17)).status();workflow.tabTotalAfterExcess=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {totalCents:number}).totalCents;
});

Then('the excessive order is rejected without changing the tab',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.excessiveOrderStatus).toBe(409);expect(workflow.tabTotalBeforeExcess).toBe(1_980_000_000);expect(workflow.tabTotalAfterExcess).toBe(workflow.tabTotalBeforeExcess)});

When('a tab accumulates more than 9900 zero-cost items across valid batches',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find((item)=>item.name==='Anna Berger')!;const categoryId=products.data[0]!.categoryId;
  const product=await (await request.post('/api/v1/products',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:{de:'Freiprodukt',it:'',en:''},priceCents:0,categoryId,enabled:true,selfServiceOnly:false}})).json() as {id:string};
  const catalog=await (await request.get('/api/v1/products')).json() as {catalogVersion:number};let tabId='';
  for(let index=0;index<101;index+=1){const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:catalog.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:99}]}})).json() as {tabId:string};tabId=order.tabId;}
  workflow.aggregateSettlementStatus=(await request.post(`/api/v1/tabs/${tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:9_999,expectedTotalCents:0,paymentMethod:'cash'}})).status();
});

Then('the aggregate tab can still be settled',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.aggregateSettlementStatus).toBe(200)});
