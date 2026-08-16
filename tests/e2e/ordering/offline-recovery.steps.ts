import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { signIn } from '../authentication/sign-in';
import { test } from '../fixtures/test';
import { chooseOrder } from '../ordering/order-ui';
import { csrfHeaders,operationalData } from '../support/operational-api-data';
import { stateFor } from './offline-recovery.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

Given('an authenticated administrator with the order catalog loaded',async({page})=>{await signIn(page);await page.goto('/app/orders/new');await expect(page.getByText('Helles',{exact:true})).toBeVisible()});

When('the device goes offline and the host submits one {string} for {string} in room {string}',async({page,context},product:string,guest:string,room:string)=>{await page.locator('.room-chips').getByRole('button',{name:room,exact:true}).click();await page.locator('.guest-list').getByRole('button',{name:new RegExp(guest)}).click();await page.locator('.product-tile').getByText(product,{exact:true}).click();await context.setOffline(true);await page.getByRole('button',{name:/Bestellung buchen/}).click()});

Then('the order is marked as queued for synchronization',async({page,context})=>{await expect(page.getByText(/Synchronisierung vorgemerkt|coda per la sincronizzazione|queued for sync/)).toBeVisible();await context.setOffline(false)});

Given('an open {string} order for {string} in room {string}',async({page},product:string,guest:string,room:string)=>{await chooseOrder(page,product,guest,room);await page.getByRole('button',{name:/Bestellung buchen/}).click();await expect(page.locator('.open-tab')).toContainText(product)});

When('the host removes the open item while offline',async({page,context})=>{await context.setOffline(true);await page.locator('.open-tab').getByRole('button',{name:/Artikel entfernen|Rimuovi articolo|Remove item/}).click();await page.locator('.modal input').fill('Falscher Artikel');await page.locator('.modal').getByRole('button',{name:/Bestätigen|Conferma|Confirm/}).click()});

Then('the item removal is queued for synchronization',async({page,context})=>{await expect(page.getByText(/Entfernen offline gespeichert|Rimozione salvata offline|Removal saved offline/)).toBeVisible();await context.setOffline(false)});

When('an item removal command crosses settlement and bill reversal',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);
  const guest=guests.data.find(item=>item.name==='Anna Berger')!;
  const product=products.data.find(item=>item.name.de==='Helles')!;
  workflow.lifecycleGuestId=guest.id;
  const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};
  const captured=await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json() as {items:{id:string;billingVersion:number}[]};
  const item=captured.items[0]!;
  const bill=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}})).json() as {id:string};
  expect((await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),reason:'Lifecycle correction'}})).status()).toBe(200);
  const stale=await request.post(`/api/v1/order-items/${item.id}/void`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),reason:'Queued before settlement',expectedBillingVersion:item.billingVersion}});
  workflow.itemBillingConflictResult={status:stale.status(),code:((await stale.json()) as {error:{code:string}}).error.code};
  workflow.correctedLifecycleItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
});

Then('the stale item removal is rejected as a billing conflict',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.itemBillingConflictResult).toEqual({status:409,code:'ITEM_BILLING_CONFLICT'})});

Then('the corrected item remains on the open tab',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.correctedLifecycleItemCount).toBe(1)});

When('the host submits a new removal from the refreshed tab',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const current=await (await request.get(`/api/v1/guests/${workflow.lifecycleGuestId}/tab`)).json() as {items:{id:string;billingVersion:number}[]};
  const item=current.items[0]!;
  workflow.refreshedLifecycleVoidStatus=(await request.post(`/api/v1/order-items/${item.id}/void`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),reason:'Reviewed correction',expectedBillingVersion:item.billingVersion}})).status();
});

Then('the refreshed item removal succeeds',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.refreshedLifecycleVoidStatus).toBe(200)});

When('the host retries item removal after its response is lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  await page.evaluate(()=>{
    const originalFetch=window.fetch.bind(window);let loseResponse=true;const reasons:string[]=[];
    Object.assign(window,{__aerstelloVoidRetryReasons:reasons});
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(/\/api\/v1\/order-items\/[^/]+\/void$/.test(url)&&init?.method==='POST'){reasons.push((JSON.parse(String(init.body)) as {reason:string}).reason);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)};
  });
  await page.locator('.open-tab').getByRole('button',{name:/Artikel entfernen|Rimuovi articolo|Remove item/}).click();
  const modal=page.locator('.modal');const reason=modal.getByLabel(/Grund|Motivo|Reason/);
  await reason.fill('Original correction');
  await modal.getByRole('button',{name:/Bestätigen|Conferma|Confirm/}).click();
  await expect(modal.locator('.notice--error')).toBeVisible();
  workflow.uncertainVoidReasonLocked=await reason.isDisabled();
  await modal.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();
  await expect(modal).toHaveCount(0);
  workflow.retriedVoidReasons=await page.evaluate(()=>(window as unknown as {__aerstelloVoidRetryReasons:string[]}).__aerstelloVoidRetryReasons);
});

Then('the uncertain void reason is locked',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.uncertainVoidReasonLocked).toBe(true)});

Then('both item removal attempts use the same reason',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedVoidReasons).toEqual(['Original correction','Original correction'])});

When('the host reloads after an item removal response is lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const installLostResponse=()=>{
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(/\/api\/v1\/order-items\/[^/]+\/void$/.test(new URL(url,window.location.href).pathname)&&init?.method==='POST'){
        const requests=JSON.parse(localStorage.getItem('__aerstelloReloadVoidRequests')??'[]') as {mutationId:string;reason:string;expectedBillingVersion:number}[];
        requests.push(JSON.parse(String(init.body)) as {mutationId:string;reason:string;expectedBillingVersion:number});
        localStorage.setItem('__aerstelloReloadVoidRequests',JSON.stringify(requests));
        const response=await originalFetch(input,init);
        if(requests.length===1)throw new TypeError('Simulated lost response');
        return response;
      }
      return originalFetch(input,init);
    };
  };
  await page.evaluate(()=>localStorage.setItem('__aerstelloReloadVoidRequests','[]'));
  await page.addInitScript(installLostResponse);
  await page.evaluate(installLostResponse);
  await page.locator('.open-tab').getByRole('button',{name:/Artikel entfernen|Rimuovi articolo|Remove item/}).click();
  const modal=page.locator('.modal');await modal.getByLabel(/Grund|Motivo|Reason/).fill('Reload recovery');
  await modal.getByRole('button',{name:/Bestätigen|Conferma|Confirm/}).click();
  await expect.poll(async()=>page.evaluate(async()=>new Promise<number>((resolve,reject)=>{const open=indexedDB.open('aerstello');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const transaction=open.result.transaction('mutations');const count=transaction.objectStore('mutations').count();count.onsuccess=()=>{open.result.close();resolve(count.result)};count.onerror=()=>reject(count.error)}})),{timeout:10_000}).toBe(1);
  const originalRequest=(await page.evaluate(()=>JSON.parse(localStorage.getItem('__aerstelloReloadVoidRequests')??'[]') as {mutationId:string;reason:string;expectedBillingVersion:number}[]))[0]!;
  const storedRequest=await page.evaluate(async()=>new Promise<{id:string;status:string;body:{mutationId:string;reason:string;expectedBillingVersion:number}}>((resolve,reject)=>{const open=indexedDB.open('aerstello');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const transaction=open.result.transaction('mutations');const all=transaction.objectStore('mutations').getAll();all.onsuccess=()=>{open.result.close();resolve(all.result[0] as {id:string;status:string;body:{mutationId:string;reason:string;expectedBillingVersion:number}})};all.onerror=()=>reject(all.error)}}));
  expect(storedRequest).toEqual(expect.objectContaining({id:originalRequest.mutationId,status:'pending',body:originalRequest}));
  await page.reload();
  await expect.poll(async()=>page.evaluate(()=>((JSON.parse(localStorage.getItem('__aerstelloReloadVoidRequests')??'[]')) as unknown[]).length),{timeout:10_000}).toBeGreaterThanOrEqual(2);
  const {request,guests}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;
  workflow.reloadedVoidItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
  await expect.poll(async()=>page.evaluate(async()=>new Promise<number>((resolve,reject)=>{const open=indexedDB.open('aerstello');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const transaction=open.result.transaction('mutations');const count=transaction.objectStore('mutations').count();count.onsuccess=()=>{open.result.close();resolve(count.result)};count.onerror=()=>reject(count.error)}})),{timeout:10_000}).toBe(0);
  workflow.reloadedVoidPendingCount=await page.evaluate(async()=>new Promise<number>((resolve,reject)=>{const open=indexedDB.open('aerstello');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const transaction=open.result.transaction('mutations');const count=transaction.objectStore('mutations').count();count.onsuccess=()=>{open.result.close();resolve(count.result)};count.onerror=()=>reject(count.error)}}));
  workflow.reloadedVoidRequests=await page.evaluate(()=>JSON.parse(localStorage.getItem('__aerstelloReloadVoidRequests')??'[]') as {mutationId:string;reason:string;expectedBillingVersion:number}[]);
});

Then('the restored item removal uses the original mutation identifier',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.reloadedVoidRequests.length).toBeGreaterThanOrEqual(2);expect(new Set(workflow.reloadedVoidRequests.map(request=>request.mutationId)).size).toBe(1);expect(workflow.reloadedVoidRequests[0]!.reason).toBe('Reload recovery');for(const request of workflow.reloadedVoidRequests.slice(1))expect(request).toEqual(workflow.reloadedVoidRequests[0])});

Then('the restored item removal is applied and cleared from recovery',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.reloadedVoidItemCount).toBe(0);expect(workflow.reloadedVoidPendingCount).toBe(0)});

When('the host removes the only open item',async({page})=>{await page.locator('.open-tab').getByRole('button',{name:/Artikel entfernen|Rimuovi articolo|Remove item/}).click();await page.locator('.modal input').fill('Empty tab regression');await page.locator('.modal').getByRole('button',{name:/Bestätigen|Conferma|Confirm/}).click();await expect(page.locator('.open-tab')).toHaveCount(0)});

Then('no settlement action is offered for the empty tab',async({page})=>{await expect(page.getByRole('button',{name:/Abrechnen|Incassa|Settle/})).toHaveCount(0)});

When('the selected guest tab service is unavailable',async({page})=>{
  const guests=await (await page.context().request.get('/api/v1/guests')).json() as {data:{id:string;name:string}[]};
  const anna=guests.data.find(guest=>guest.name==='Anna Berger')!;
  await page.addInitScript(()=>{
    const fetch=window.fetch.bind(window);
    window.fetch=(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(/^\/api\/v1\/guests\/[^/]+\/tab$/.test(new URL(url,window.location.href).pathname))return new Promise((_,reject)=>setTimeout(()=>reject(new TypeError('Simulated host tab outage')),1_500));
      return fetch(input,init);
    };
  });
  await page.goto(`/app/orders/new?guest=${anna.id}`);
});

Then('the host sees tab loading without a zero balance',async({page})=>{const summary=page.locator('.tab-pill');await expect(summary).toContainText(/Wird geladen|Caricamento|Loading/);await expect(summary).not.toContainText(/0[,.]00\s*€/)});

Then('the host sees a tab error without a zero balance or settlement action',async({page})=>{const summary=page.locator('.tab-pill');await expect(summary).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/,{timeout:10_000});await expect(summary).not.toContainText(/0[,.]00\s*€/);await expect(page.locator('.cart-panel .notice--error')).toBeVisible();await expect(page.getByRole('button',{name:/Abrechnen|Incassa|Settle/})).toHaveCount(0)});

When('a queued order encounters one transient synchronization failure',async({scenarioState, page,context})=>{const workflow=stateFor(scenarioState);
  await page.locator('.room-chips').getByRole('button',{name:'101',exact:true}).click();await page.locator('.guest-list').getByRole('button',{name:/Anna Berger/}).click();await page.locator('.product-tile').getByText('Helles',{exact:true}).click();
  await context.setOffline(true);await page.getByRole('button',{name:/Bestellung buchen/}).click();await expect(page.getByText(/Synchronisierung vorgemerkt|queued for sync/)).toBeVisible();
  await page.evaluate(()=>{
    const originalFetch=window.fetch.bind(window);let attempts=0;
    Object.assign(window,{__aerstelloTransientReplayAttempts:0});
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/order-batches')&&init?.method==='POST'){attempts+=1;Object.assign(window,{__aerstelloTransientReplayAttempts:attempts});if(attempts===1)throw new TypeError('Simulated transient sync failure')}return originalFetch(input,init)};
  });
  await context.setOffline(false);
  const {request,guests}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;
  await expect.poll(async()=>((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount,{timeout:15_000}).toBe(1);
  workflow.transientReplayAttempts=await page.evaluate(()=>(window as unknown as {__aerstelloTransientReplayAttempts:number}).__aerstelloTransientReplayAttempts);
});

Then('the queued order is retried without another connectivity event',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.transientReplayAttempts).toBeGreaterThanOrEqual(2)});

When('an offline order is quarantined as a synchronization conflict',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')! as {id:string;name:string;roomName:string};const product=products.data.find(item=>item.name.de==='Helles')!;const mutationId=crypto.randomUUID();const capturedAt=new Date().toISOString();workflow.conflictGuestId=guest.id;
  await page.evaluate(async({mutationId,capturedAt,hostId,guest,product,catalogVersion})=>new Promise<void>((resolve,reject)=>{
    const request=indexedDB.open('aerstello');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const transaction=request.result.transaction('mutations','readwrite');transaction.objectStore('mutations').put({id:mutationId,hostId,path:'/order-batches',method:'POST',createdAt:capturedAt,status:'conflict',errorCode:'CATALOG_CONFLICT',body:{mutationId,originHostId:hostId,guestId:guest.id,catalogVersion,capturedAt,items:[{productId:product.id,quantity:2}]},display:{kind:'order',guestId:guest.id,guestName:guest.name,roomName:guest.roomName,items:[{productId:product.id,productName:product.name,unitPriceCents:product.priceCents,quantity:2}]}});transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error)};
  }),{mutationId,capturedAt,hostId:me.host.id,guest,product,catalogVersion:products.catalogVersion});
  await expect(page.locator('.sync-conflict-banner')).toBeVisible({timeout:10_000});await page.locator('.sync-conflict-banner').click();
});

Then('the conflict shows its guest, room, products, and quantities',async({page})=>{const modal=page.locator('.modal');await expect(modal).toContainText('Anna Berger');await expect(modal).toContainText('101');await expect(modal).toContainText('2 × Helles')});

Then('the host can retry it without discarding it',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await page.locator('.modal').getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();await expect.poll(async()=>((await (await page.context().request.get(`/api/v1/guests/${workflow.conflictGuestId}/tab`)).json()) as {itemCount:number}).itemCount,{timeout:10_000}).toBe(2)});

When('the host retries an order after its first response is lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  await chooseOrder(page,'Helles','Anna Berger','101');
  await page.evaluate(() => {
    const originalFetch=window.fetch.bind(window);let loseResponse=true;const ids:string[]=[];
    Object.assign(window,{__aerstelloOrderRetryIds:ids});
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/order-batches')&&init?.method==='POST'){ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)};
  });
  await page.getByRole('button',{name:/Bestellung buchen/}).click();
  await expect(page.locator('.notice--error')).toBeVisible();
  workflow.uncertainOrderControlsLocked=await page.locator('.product-tile').filter({hasText:'Helles'}).isDisabled()&&await page.locator('.guest-list').getByRole('button',{name:/Anna Berger/}).isDisabled()&&await page.locator('.stepper button').last().isDisabled();
  await page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();
  await expect(page.getByText(/Bestellung hinzugefügt|Order added/)).toBeVisible();
  workflow.retriedOrderMutationIds=await page.evaluate(()=>(window as unknown as {__aerstelloOrderRetryIds:string[]}).__aerstelloOrderRetryIds);
  const {request,guests}=await operationalData(page);const guest=guests.data.find((item)=>item.name==='Anna Berger')!;workflow.retriedOrderItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
});

Then('both order attempts use the same mutation identifier',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedOrderMutationIds).toHaveLength(2);expect(new Set(workflow.retriedOrderMutationIds).size).toBe(1)});

Then('order editing was locked while the result was uncertain',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.uncertainOrderControlsLocked).toBe(true)});

Then('the guest tab contains the order only once',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedOrderItemCount).toBe(1)});

When('the host retries an order after a committed HTTP timeout',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await chooseOrder(page,'Helles','Anna Berger','101');await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let returnTimeout=true;const ids:string[]=[];Object.assign(window,{__aerstelloOrderRetryIds:ids});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/order-batches')&&init?.method==='POST'){ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);const response=await originalFetch(input,init);if(returnTimeout){returnTimeout=false;return new Response(JSON.stringify({error:{code:'REQUEST_TIMEOUT',message:'The upstream response timed out.'}}),{status:408,headers:{'content-type':'application/json'}})}return response}return originalFetch(input,init)}});await page.getByRole('button',{name:/Bestellung buchen|Invia ordine|Submit order/}).click();await expect(page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();await page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();await expect(page.getByText(/Bestellung hinzugefügt|Ordine aggiunto|Order added/)).toBeVisible();workflow.retriedOrderMutationIds=await page.evaluate(()=>(window as unknown as {__aerstelloOrderRetryIds:string[]}).__aerstelloOrderRetryIds);const {request,guests}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;workflow.retriedOrderItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount});

When('the host reloads after an order response is lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  await chooseOrder(page,'Helles','Anna Berger','101');
  await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);const ids:string[]=[];Object.assign(window,{__aerstelloReloadOrderIds:ids});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/order-batches')&&init?.method==='POST'){ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);await originalFetch(input,init);throw new TypeError('Simulated lost response')}return originalFetch(input,init)}});
  await page.getByRole('button',{name:/Bestellung buchen|Submit order/}).click();await expect(page.locator('.notice--error')).toBeVisible();const firstIds=await page.evaluate(()=>(window as unknown as {__aerstelloReloadOrderIds:string[]}).__aerstelloReloadOrderIds);await page.reload();await expect(page.locator('.cart-lines').getByText('Helles',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);const ids:string[]=[];Object.assign(window,{__aerstelloReloadOrderIds:ids});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/order-batches')&&init?.method==='POST')ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);return originalFetch(input,init)}});await page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();await expect(page.getByText(/Bestellung hinzugefügt|Order added/)).toBeVisible();const secondIds=await page.evaluate(()=>(window as unknown as {__aerstelloReloadOrderIds:string[]}).__aerstelloReloadOrderIds);workflow.reloadedOrderMutationIds=[...firstIds,...secondIds];const {request,guests}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;workflow.reloadedOrderItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
});

Then('the restored order retry uses the original mutation identifier',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.reloadedOrderMutationIds).toHaveLength(2);expect(new Set(workflow.reloadedOrderMutationIds).size).toBe(1)});

Then('the guest tab contains the restored order only once',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.reloadedOrderItemCount).toBe(1)});

When('the host closes the app after an order response is lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await chooseOrder(page,'Helles','Anna Berger','101');await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);const ids:string[]=[];Object.assign(window,{__aerstelloClosedOrderIds:ids});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/order-batches')&&init?.method==='POST'){ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);await originalFetch(input,init);throw new TypeError('Simulated lost response')}return originalFetch(input,init)}});await page.getByRole('button',{name:/Bestellung buchen|Submit order/}).click();await expect(page.locator('.notice--error')).toBeVisible();workflow.closedOrderMutationIds=await page.evaluate(()=>(window as unknown as {__aerstelloClosedOrderIds:string[]}).__aerstelloClosedOrderIds);workflow.closedOrderPreReopenTransmissionCount=workflow.closedOrderMutationIds.length;const context=page.context();await page.close();const reopened=await context.newPage();await reopened.goto('/app/orders/new');await expect(reopened.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();await reopened.evaluate(()=>{const originalFetch=window.fetch.bind(window);const ids:string[]=[];Object.assign(window,{__aerstelloClosedOrderIds:ids});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/order-batches')&&init?.method==='POST')ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);return originalFetch(input,init)}});await reopened.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();await expect(reopened.getByText(/Bestellung hinzugefügt|Order added/)).toBeVisible();workflow.closedOrderMutationIds.push(...await reopened.evaluate(()=>(window as unknown as {__aerstelloClosedOrderIds:string[]}).__aerstelloClosedOrderIds));const {request,guests}=await operationalData(reopened);const guest=guests.data.find(item=>item.name==='Anna Berger')!;workflow.closedOrderItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount});

Then('reopening the order uses the original mutation identifier',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.closedOrderPreReopenTransmissionCount).toBeGreaterThan(0);expect(workflow.closedOrderMutationIds.length).toBeGreaterThan(workflow.closedOrderPreReopenTransmissionCount);expect(new Set(workflow.closedOrderMutationIds).size).toBe(1)});

Then('the guest tab contains the reopened order only once',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.closedOrderItemCount).toBe(1)});

When('a product price changes after its order response is lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await chooseOrder(page,'Helles','Anna Berger','101');workflow.capturedUncertainTotal=await page.locator('.cart-total strong').innerText();const {request,products}=await operationalData(page);const product=products.data.find(item=>item.name.de==='Helles')!;workflow.capturedExpectedTotalCents=product.priceCents;await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);Object.assign(window,{__aerstelloLosePriceOrderResponse:true});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/order-batches')&&init?.method==='POST'&&(window as unknown as {__aerstelloLosePriceOrderResponse:boolean}).__aerstelloLosePriceOrderResponse){(window as unknown as {__aerstelloLosePriceOrderResponse:boolean}).__aerstelloLosePriceOrderResponse=false;await originalFetch(input,init);throw new TypeError('Simulated lost response')}return originalFetch(input,init)}});await page.getByRole('button',{name:/Bestellung buchen|Submit order/}).click();await expect(page.locator('.notice--error')).toBeVisible();const refreshed=page.waitForResponse(response=>response.url().endsWith('/api/v1/products')&&response.request().method()==='GET');expect((await request.patch(`/api/v1/products/${product.id}`,{headers:csrfHeaders,data:{name:product.name,...(product.description?{description:product.description}:{}),priceCents:product.priceCents+1000,categoryId:product.categoryId,enabled:product.enabled,selfServiceOnly:product.selfServiceOnly,expectedVersion:product.version}})).status()).toBe(200);await refreshed});

Then('the uncertain cart still shows its captured total',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await expect(page.locator('.cart-total strong')).toHaveText(workflow.capturedUncertainTotal)});

Then('retrying retains the captured charge',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();await expect(page.getByText(/Bestellung hinzugefügt|Order added/)).toBeVisible();const {request,guests}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const capturedOrderTabTotalCents=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {totalCents:number}).totalCents;expect(capturedOrderTabTotalCents).toBe(workflow.capturedExpectedTotalCents)});

When('an order mutation is replayed with a changed quantity',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;
  const command={mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]};
  expect((await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:command})).status()).toBe(201);
  workflow.changedOrderReplayStatus=(await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{...command,items:[{productId:product.id,quantity:2}]}})).status();
  workflow.changedOrderReplayItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
});

Then('the changed order replay is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.changedOrderReplayStatus).toBe(409)});

Then('the original order quantity remains unchanged',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.changedOrderReplayItemCount).toBe(1)});
