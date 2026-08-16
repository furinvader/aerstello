import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { dashboardOrderList,openOrdersPageCard,requestFailedMessage } from '../ordering/order-ui';
import { csrfHeaders,operationalData } from '../support/operational-api-data';
import { stateFor } from './bills.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('the venue has more bills than one archive page',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find((item)=>item.name==='Anna Berger')!;const product=products.data.find((item)=>item.name.de==='Helles')!;for(let index=0;index<51;index+=1){const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};const bill=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}})).json() as {number:string};if(index===0)workflow.oldestBillNumber=bill.number}const firstPage=await (await request.get('/api/v1/bills?page=1&pageSize=50')).json() as {data:{number:string}[]};expect(firstPage.data.some((bill)=>bill.number===workflow.oldestBillNumber)).toBe(false)});

Then('the oldest exact bill is the first API result without internal ranking data',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  await page.goto('/app/bills');
  const [response]=await Promise.all([
    page.waitForResponse(candidate=>candidate.url().includes(`/api/v1/bills?search=${workflow.oldestBillNumber}&`)),
    page.getByPlaceholder(/Nach Gast|Cerca per|Search by/).fill(workflow.oldestBillNumber),
  ]);
  const result=await response.json() as {data:Array<{id:string;number:string;[key:string]:unknown}>};
  expect(result.data[0]?.number).toBe(workflow.oldestBillNumber);
  expect(result.data.slice(1).some(bill=>bill.number.includes(workflow.oldestBillNumber)&&BigInt(bill.number)>BigInt(workflow.oldestBillNumber))).toBe(true);
  for(const bill of result.data)expect(bill).not.toHaveProperty('search_rank');
  workflow.oldestBillSearchId=result.data[0]!.id;
});

Then('the oldest exact bill is the first rendered archive row',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const firstRow=page.locator('.bills-list .table-row').first();
  await expect(firstRow).toHaveAttribute('href',`/app/bills/${workflow.oldestBillSearchId}`);
  await expect(firstRow).toContainText(`#${workflow.oldestBillNumber}`);
});

When('the host opens a bill while its detail service is unavailable',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);
  const guest=guests.data.find(item=>item.name==='Anna Berger')!;
  const product=products.data.find(item=>item.name.de==='Helles')!;
  const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};
  const settlement=await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}});
  expect(settlement.status()).toBe(200);
  const bill=await settlement.json() as {id:string;number:string};
  workflow.recoverableBillId=bill.id;workflow.recoverableBillNumber=bill.number;
  await page.addInitScript(({billId})=>{
    const originalFetch=window.fetch.bind(window);
    const state={billId,active:true,attempts:0};
    Object.assign(window,{__aerstelloBillDetailOutage:state});
    window.fetch=async(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(new URL(url,window.location.href).pathname===`/api/v1/bills/${state.billId}`){
        state.attempts+=1;
        if(state.active){await new Promise(resolve=>setTimeout(resolve,1_500));return new Response(JSON.stringify({error:{code:'SERVICE_UNAVAILABLE',message:'Simulated bill detail outage'}}),{status:503,headers:{'content-type':'application/json'}})}
      }
      return originalFetch(input,init);
    };
  },{billId:workflow.recoverableBillId});
  await page.goto(`/app/bills/${workflow.recoverableBillId}`);
});

Then('bill detail shows loading without fabricated bill content',async({page})=>{await expect(page.locator('.splash')).toContainText(/Wird geladen|Caricamento|Loading/);await expect(page.locator('.bill-sheet')).toHaveCount(0)});

Then('bill detail shows localized failure and retry without fabricated bill content',async({page})=>{
  await expect(page.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/,{timeout:10_000});
  await expect(page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();
  await expect(page.locator('.bill-sheet')).toHaveCount(0);
});

When('the host retries the bill detail request after recovery',async({page})=>{
  await page.evaluate(()=>{(window as unknown as {__aerstelloBillDetailOutage:{active:boolean}}).__aerstelloBillDetailOutage.active=false});
  await page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();
});

Then('the same bill detail is rendered',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await expect(page).toHaveURL(new RegExp(`/app/bills/${workflow.recoverableBillId}$`));await expect(page.locator('.bill-sheet h1')).toHaveText('Hotel Aurora');await expect(page.locator('.bill-sheet header')).toContainText(`#${workflow.recoverableBillNumber}`)});

When('the initial bill archive request is delayed and fails',async({page})=>{
  await page.addInitScript(()=>{
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(new URL(url,window.location.href).pathname==='/api/v1/bills'){
        await new Promise(resolve=>setTimeout(resolve,1_500));
        throw new TypeError('Simulated bill archive outage');
      }
      return originalFetch(input,init);
    };
  });
  await page.goto('/app/bills');
});

Then('the bill archive shows loading without a successful empty state',async({page})=>{const archive=page.locator('.app-content>.card');await expect(archive).toContainText(/Wird geladen|Caricamento|Loading/);await expect(archive.locator('.empty')).toHaveCount(0)});

Then('the bill archive shows failure without a successful empty state',async({page})=>{const archive=page.locator('.app-content>.card');await expect(archive.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/,{timeout:10_000});await expect(archive.locator('.empty')).toHaveCount(0)});

When('the host opens a successfully empty bill archive',async({page})=>{const response=page.waitForResponse(candidate=>new URL(candidate.url()).pathname==='/api/v1/bills');await page.goto('/app/bills');expect((await response).ok()).toBe(true)});

Then('the bill archive shows its successful empty state',async({page})=>{const archive=page.locator('.app-content>.card');await expect(archive.locator('.empty')).toContainText(/Noch keine Einträge|Nessun elemento|Nothing here yet/)});

When('the initial open order list request is delayed and fails',async({page})=>{
  await page.addInitScript(()=>{
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(new URL(url,window.location.href).pathname==='/api/v1/orders'){
        await new Promise(resolve=>setTimeout(resolve,1_500));
        throw new TypeError('Simulated open orders outage');
      }
      return originalFetch(input,init);
    };
  });
  await page.goto('/app/orders');
});

Then('the open orders page shows loading without a successful empty state',async({page})=>{const orders=openOrdersPageCard(page);await expect(orders).toContainText(/Wird geladen|Caricamento|Loading/);await expect(orders.locator('.empty')).toHaveCount(0)});

Then('the open orders page shows failure without a successful empty state',async({page})=>{const orders=openOrdersPageCard(page);await expect(orders.locator('.notice--error')).toContainText(requestFailedMessage,{timeout:10_000});await expect(orders.locator('.empty')).toHaveCount(0)});

When('the host opens the dashboard with a failed open order list',async({page})=>{await page.goto('/app')});

Then('the dashboard open order list shows loading without a successful empty state',async({page})=>{const orders=dashboardOrderList(page);await expect(orders).toContainText(/Wird geladen|Caricamento|Loading/);await expect(orders.locator('.empty')).toHaveCount(0)});

Then('the dashboard open order list shows failure without a successful empty state',async({page})=>{const orders=dashboardOrderList(page);await expect(orders.locator('.notice--error')).toContainText(requestFailedMessage,{timeout:10_000});await expect(orders.locator('.empty')).toHaveCount(0)});

When('the host opens a successfully empty open order list',async({page})=>{const response=page.waitForResponse(candidate=>new URL(candidate.url()).pathname==='/api/v1/orders');await page.goto('/app/orders');expect((await response).ok()).toBe(true)});

Then('the open orders page shows its successful empty state',async({page})=>{await expect(openOrdersPageCard(page).locator('.empty')).toContainText(/Noch keine Einträge|Nessun elemento|Nothing here yet/)});

When('the host opens the dashboard with a successful empty open order list',async({page})=>{const response=page.waitForResponse(candidate=>new URL(candidate.url()).pathname==='/api/v1/orders');await page.goto('/app');expect((await response).ok()).toBe(true)});

Then('the dashboard open order list shows its successful empty state',async({page})=>{await expect(dashboardOrderList(page).locator('.empty')).toContainText(/Noch keine Einträge|Nessun elemento|Nothing here yet/)});

When('the venue timezone changes after a bill is settled',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);const {request,me,guests,products}=await operationalData(page);const venue=await (await request.get('/api/v1/venue')).json() as {name:string;defaultLanguage:string;version:number};const firstVenue=await (await request.put('/api/v1/venue',{headers:csrfHeaders,data:{name:venue.name,language:venue.defaultLanguage,timezone:'Pacific/Kiritimati',expectedVersion:venue.version}})).json() as {version:number};const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};const settled=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}})).json() as {id:string};const bill=await (await request.get(`/api/v1/bills/${settled.id}`)).json() as {settledAt:string;venueTimezone:string};expect(bill.venueTimezone).toBe('Pacific/Kiritimati');workflow.snapshottedBillDate=new Date(bill.settledAt).toLocaleDateString('de',{timeZone:bill.venueTimezone});expect((await request.put('/api/v1/venue',{headers:csrfHeaders,data:{name:venue.name,language:venue.defaultLanguage,timezone:'Pacific/Honolulu',expectedVersion:firstVenue.version}})).status()).toBe(200);await page.goto(`/app/bills/${settled.id}`)});

Then('the bill date uses its snapshotted venue timezone',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await expect(page.locator('.bill-meta')).toContainText(workflow.snapshottedBillDate)});

When('the settling host changes their name after billing',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};const settled=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}})).json() as {id:string};expect((await request.patch('/api/v1/account',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedVersion:me.host.version,name:'Renamed Host'}})).status()).toBe(200);const bill=await (await request.get(`/api/v1/bills/${settled.id}`)).json() as {hostName:string};workflow.snapshottedBillHostName=bill.hostName;await page.goto(`/app/bills/${settled.id}`)});

Then('the bill still shows the original host name',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);expect(workflow.snapshottedBillHostName).toBe('Mira Host');await expect(page.locator('.bill-meta')).toContainText('Mira Host');await expect(page.locator('.bill-meta')).not.toContainText('Renamed Host')});

When('the host opens a voided bill for printing',async({page})=>{const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};const bill=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}})).json() as {id:string};expect((await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),reason:'Printed correction'}})).status()).toBe(200);await page.goto(`/app/bills/${bill.id}`);await page.emulateMedia({media:'print'})});

Then('the printed bill shows its void reason',async({page})=>{await expect(page.locator('.bill-void-marker .notice')).toBeVisible();await expect(page.locator('.bill-void-marker')).toContainText('Printed correction')});
