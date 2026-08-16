import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { csrfHeaders } from '../support/operational-api-data';
import { installQueryOutage,releaseQueryOutage,restoreQueryOutage,retryQueryOutage } from '../support/query-outage';
import { stateFor } from './self-service-catalog.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

Then('the host has no empty open order for {string}',async({resources, guestDevice, page},name:string)=>{await page.goto('/app/orders');await expect(page.locator('.tab-card').filter({hasText:name})).toHaveCount(0)});

When('the guest catalog request remains pending',async({resources, guestDevice})=>{
  await installQueryOutage(guestDevice.page,['/api/v1/guest/catalog']);
  await guestDevice.page.reload();
});

Then('guest catalog loading is localized without empty or product state',async({resources, guestDevice})=>{
  const catalog=guestDevice.page.locator('.guest-tabs>section').first();
  await expect(catalog.getByText(/Wird geladen|Caricamento|Loading/)).toBeVisible();
  await expect(catalog.locator('.empty,.product-tile')).toHaveCount(0);
});

When('the pending guest catalog request fails',async({resources, guestDevice})=>{await releaseQueryOutage(guestDevice.page)});

Then('guest catalog failure and retry are localized without empty state',async({resources, guestDevice})=>{
  const catalog=guestDevice.page.locator('.guest-tabs>section').first();
  await expect(catalog.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/);
  await expect(catalog.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();
  await expect(catalog.locator('.empty,.product-tile')).toHaveCount(0);
});

When('the guest retries the catalog request',async({resources, guestDevice})=>{
  const catalog=guestDevice.page.locator('.guest-tabs>section').first();
  await retryQueryOutage(guestDevice.page,catalog.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}));
});

Then('recovered self-service products appear without a reload',async({resources, guestDevice})=>{
  await expect(guestDevice.page.getByText('Mineralwasser',{exact:true})).toBeVisible();
  expect(await guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloQueryOutage:{attempts:number}}).__aerstelloQueryOutage.attempts)).toBeGreaterThanOrEqual(3);
  await restoreQueryOutage(guestDevice.page);
});

When('a self-service price changes after the guest catalog is displayed',async({resources, guestDevice, scenarioState, page})=>{const workflow=stateFor(scenarioState);const guestRequest=guestDevice.page.context().request;const me=await (await guestRequest.get('/api/v1/guest/me')).json() as {guest:{sessionId:string}};const catalog=await (await guestRequest.get('/api/v1/guest/catalog')).json() as {data:{id:string;name:{de:string};priceCents:number;version:number}[]};const displayed=catalog.data.find(item=>item.name.de==='Mineralwasser')!;const staleMutationId=crypto.randomUUID();workflow.staleGuestMutationIds=[];guestDevice.page.on('request',request=>{if(request.url().endsWith('/api/v1/guest/items')&&request.method()==='POST')workflow.staleGuestMutationIds.push((request.postDataJSON() as {mutationId:string}).mutationId)});const request=page.context().request;const products=await (await request.get('/api/v1/products')).json() as {data:{id:string;name:{de:string;it:string;en:string};description?:{de:string;it:string;en:string};priceCents:number;categoryId:string;enabled:boolean;selfServiceOnly:boolean;version:number}[]};const product=products.data.find(item=>item.id===displayed.id)!;expect((await request.patch(`/api/v1/products/${product.id}`,{headers:csrfHeaders,data:{name:product.name,...(product.description?{description:product.description}:{}),priceCents:product.priceCents+100,categoryId:product.categoryId,enabled:product.enabled,selfServiceOnly:product.selfServiceOnly,expectedVersion:product.version}})).status()).toBe(200);await guestDevice.page.evaluate(({sessionId,productId,mutationId,expectedPriceCents,expectedProductVersion})=>localStorage.setItem('aerstello-guest-pending-adds',JSON.stringify({sessionId,entries:[[productId,mutationId,expectedPriceCents,expectedProductVersion]]})),{sessionId:me.guest.sessionId,productId:product.id,mutationId:staleMutationId,expectedPriceCents:displayed.priceCents,expectedProductVersion:displayed.version});await guestDevice.page.reload();await guestDevice.page.locator('.product-tile').filter({hasText:'Mineralwasser'}).click();await expect(guestDevice.page.locator('.notice--error')).toBeVisible();workflow.staleGuestPriceRejected=true;workflow.staleGuestPriceItemCount=((await (await guestRequest.get('/api/v1/guest/tab')).json()) as {itemCount:number}).itemCount;await guestDevice.page.reload();await guestDevice.page.locator('.product-tile').filter({hasText:'Mineralwasser'}).click();await expect.poll(async()=>((await (await guestRequest.get('/api/v1/guest/tab')).json()) as {itemCount:number}).itemCount).toBe(1)});

Then('adding the stale self-service product is rejected without a charge',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleGuestPriceRejected).toBe(true);expect(workflow.staleGuestPriceItemCount).toBe(0)});

Then('the guest can retry the refreshed self-service product',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleGuestMutationIds).toHaveLength(2);expect(workflow.staleGuestMutationIds[1]).not.toBe(workflow.staleGuestMutationIds[0])});

When('a self-service product is renamed after the guest catalog is displayed',async({resources, guestDevice, scenarioState, page})=>{const workflow=stateFor(scenarioState);await expect(guestDevice.page.getByText('Mineralwasser',{exact:true})).toBeVisible();await guestDevice.page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let loseRequest=true;window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/guest/items')&&init?.method==='POST'&&loseRequest){loseRequest=false;throw new TypeError('Simulated request loss')}return originalFetch(input,init)}});await guestDevice.page.locator('.product-tile').filter({hasText:'Mineralwasser'}).click();await expect(guestDevice.page.locator('.notice--error')).toBeVisible();const request=page.context().request;const products=await (await request.get('/api/v1/products')).json() as {data:{id:string;name:{de:string;it:string;en:string};description?:{de:string;it:string;en:string};priceCents:number;categoryId:string;enabled:boolean;selfServiceOnly:boolean;version:number}[]};const product=products.data.find(item=>item.name.de==='Mineralwasser')!;expect((await request.patch(`/api/v1/products/${product.id}`,{headers:csrfHeaders,data:{name:{de:'Quellwasser',it:'Acqua di fonte',en:'Spring water'},...(product.description?{description:product.description}:{}),priceCents:product.priceCents,categoryId:product.categoryId,enabled:product.enabled,selfServiceOnly:product.selfServiceOnly,expectedVersion:product.version}})).status()).toBe(200);await guestDevice.page.reload();await expect(guestDevice.page.getByText('Quellwasser',{exact:true})).toBeVisible();const response=guestDevice.page.waitForResponse(candidate=>candidate.url().endsWith('/api/v1/guest/items')&&candidate.request().method()==='POST');await guestDevice.page.locator('.product-tile').filter({hasText:'Quellwasser'}).click();workflow.staleGuestSnapshotRejected=(await response).status()===409;await expect(guestDevice.page.locator('.notice--error')).toBeVisible();workflow.staleGuestSnapshotItemCount=((await (await guestDevice.page.context().request.get('/api/v1/guest/tab')).json()) as {itemCount:number}).itemCount});

Then('adding the stale product snapshot is rejected without a charge',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleGuestSnapshotRejected).toBe(true);expect(workflow.staleGuestSnapshotItemCount).toBe(0)});

Then('the guest catalog shows the renamed product after refresh',async({resources, guestDevice})=>{await expect(guestDevice.page.getByText('Quellwasser',{exact:true})).toBeVisible()});

When('the host adds another self-service category named {string}',async({resources, guestDevice, page},categoryName:string)=>{
  const request=page.context().request;
  const category=await (await request.post('/api/v1/categories',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:{de:categoryName,it:'Bevande duplicate',en:'Duplicate drinks'}}})).json() as {id:string};
  expect((await request.post('/api/v1/products',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:{de:'Getrenntes Wasser',it:'Acqua separata',en:'Separate water'},priceCents:275,categoryId:category.id,enabled:true,selfServiceOnly:true}})).status()).toBe(201);
  await expect(guestDevice.page.getByText('Getrenntes Wasser',{exact:true})).toBeVisible();
});

Then('both {string} categories remain separate in the guest catalog',async({resources, guestDevice},categoryName:string)=>{
  const headings=guestDevice.page.locator('.guest-tabs>section').first().locator('.catalog-group>h3').filter({hasText:categoryName});
  await expect(headings).toHaveCount(2);
  await expect(headings.nth(0).locator('..')).toContainText('Mineralwasser');
  await expect(headings.nth(1).locator('..')).toContainText('Getrenntes Wasser');
});
