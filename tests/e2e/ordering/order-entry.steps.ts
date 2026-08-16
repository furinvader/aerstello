import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { chooseOrder } from '../ordering/order-ui';
import { csrfHeaders } from '../support/operational-api-data';
import { installLiveQueryFailure,installQueryOutage,releaseQueryOutage,restoreLiveQueryFailure,restoreQueryOutage,retryQueryOutage } from '../support/query-outage';
import { stateFor } from './order-entry.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('the Take Orders guest directory remains pending',async({page})=>{
  await installQueryOutage(page,['/api/v1/guests']);
  await page.goto('/app/orders/new');
});

Then('Take Orders shows guest loading without empty or guest actions',async({page})=>{
  const picker=page.locator('.guest-picker');
  await expect(picker.getByText(/Wird geladen|Caricamento|Loading/)).toBeVisible();
  await expect(picker.locator('.empty,.guest-list,.search')).toHaveCount(0);
  await expect(picker.getByRole('button',{name:/Hinzufügen.*Gäste|Aggiungi.*Ospiti|Add.*Guests/})).toHaveCount(0);
});

When('the pending Take Orders guest directory fails',async({page})=>{await releaseQueryOutage(page)});

Then('Take Orders shows guest failure and retry without empty or guest actions',async({page})=>{
  const picker=page.locator('.guest-picker');
  await expect(picker.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/);
  await expect(picker.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();
  await expect(picker.locator('.empty,.guest-list,.search')).toHaveCount(0);
  await expect(picker.getByRole('button',{name:/Hinzufügen.*Gäste|Aggiungi.*Ospiti|Add.*Guests/})).toHaveCount(0);
});

When('the host retries the Take Orders guest directory',async({page})=>{
  const picker=page.locator('.guest-picker');
  await retryQueryOutage(page,picker.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}));
});

Then('authoritative guest selection and creation recover without reload',async({page})=>{
  const picker=page.locator('.guest-picker');
  await expect(picker.getByRole('button',{name:/Anna Berger/})).toBeVisible();
  await expect(picker.getByRole('button',{name:/Hinzufügen.*Gäste|Aggiungi.*Ospiti|Add.*Guests/})).toBeEnabled();
  expect(await page.evaluate(()=>(window as unknown as {__aerstelloQueryOutage:{attempts:number}}).__aerstelloQueryOutage.attempts)).toBeGreaterThanOrEqual(3);
  await restoreQueryOutage(page);
});

When('the Take Orders catalog remains pending',async({page})=>{
  await installQueryOutage(page,['/api/v1/products','/api/v1/categories']);
  await page.goto('/app/orders/new');
});

Then('Take Orders shows catalog loading without empty or product actions',async({page})=>{
  const catalog=page.locator('.catalog');
  await expect(catalog.getByText(/Wird geladen|Caricamento|Loading/)).toBeVisible();
  await expect(catalog.locator('.empty,.catalog-group,.product-tile')).toHaveCount(0);
});

When('the pending Take Orders catalog fails',async({page})=>{await releaseQueryOutage(page)});

Then('Take Orders shows catalog failure and retry without empty or product actions',async({page})=>{
  const catalog=page.locator('.catalog');
  await expect(catalog.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/);
  await expect(catalog.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();
  await expect(catalog.locator('.empty,.catalog-group,.product-tile')).toHaveCount(0);
});

When('the host retries the Take Orders catalog',async({page})=>{
  const catalog=page.locator('.catalog');
  await retryQueryOutage(page,catalog.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}));
});

Then('authoritative catalog products recover without reload',async({page})=>{
  await expect(page.locator('.product-tile').filter({hasText:'Helles'})).toBeVisible();
  await page.locator('.guest-list').getByRole('button',{name:/Anna Berger/}).click();
  await page.locator('.product-tile').filter({hasText:'Helles'}).click();
  await expect(page.getByRole('button',{name:/Bestellung buchen|Registra ordine|Submit order/})).toBeEnabled();
  await restoreQueryOutage(page);
});

When('the recovered Take Orders catalog fails during background refresh',async({page})=>{
  await installLiveQueryFailure(page,['/api/v1/products','/api/v1/categories']);
  const request=page.context().request;
  const products=await (await request.get('/api/v1/products')).json() as {data:{id:string;name:{de:string;it:string;en:string};description?:{de:string;it:string;en:string};priceCents:number;categoryId:string;enabled:boolean;selfServiceOnly:boolean;version:number}[]};
  const product=products.data.find(item=>item.name.de==='Helles')!;
  expect((await request.patch(`/api/v1/products/${product.id}`,{headers:csrfHeaders,data:{name:product.name,...(product.description?{description:product.description}:{}),priceCents:product.priceCents+1,categoryId:product.categoryId,enabled:product.enabled,selfServiceOnly:product.selfServiceOnly,expectedVersion:product.version}})).status()).toBe(200);
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {__aerstelloLiveQueryFailure:{attempts:number}}).__aerstelloLiveQueryFailure.attempts),{timeout:10_000}).toBeGreaterThan(0);
});

Then('cached catalog ordering remains usable',async({page})=>{
  await expect(page.locator('.product-tile').filter({hasText:'Helles'})).toBeVisible();
  await expect(page.locator('.cart-lines').getByText('Helles',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/Bestellung buchen|Registra ordine|Submit order/})).toBeEnabled();
  await restoreLiveQueryFailure(page);
});

When('the host adds one {string} to {string} in room {string}',async({page},product:string,guest:string,room:string)=>chooseOrder(page,product,guest,room));

Then('the staged cart total is {string}',async({page},total:string)=>{await expect(page.locator('.cart-total strong')).toHaveText(total)});

When('the host submits the order',async({page})=>{await page.getByRole('button',{name:/Bestellung buchen/}).click()});

Then("Anna's open tab contains one item",async({page})=>{await expect(page.locator('.tab-pill')).toContainText('1 Artikel')});

When('the host stages an order for Anna and confirms a switch to Luca',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const rooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;name:string}[]};
  const room=rooms.data.find((item)=>item.name==='102')!;
  const luca=await (await request.post('/api/v1/guests',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:'Luca Rossi',roomId:room.id,language:'de'}})).json() as {id:string};
  await chooseOrder(page,'Helles','Anna Berger','101');
  page.once('dialog',(dialog)=>dialog.accept());
  await page.locator('.room-chips').getByRole('button',{name:'102',exact:true}).click();
  await page.locator('.guest-list').getByRole('button',{name:/Luca Rossi/}).click();
  workflow.switchedGuestTabCount=((await (await request.get(`/api/v1/guests/${luca.id}/tab`)).json()) as {itemCount:number}).itemCount;
});

Then('the staged cart is cleared before Luca is selected',async({page})=>{await expect(page.locator('.catalog-toolbar')).toContainText('0 ausgewählt');await expect(page.getByRole('button',{name:/Bestellung buchen/})).toBeDisabled();await expect(page.locator('.page-header')).toContainText('Luca Rossi')});

Then("Luca's tab is unchanged",async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.switchedGuestTabCount).toBe(0)});

When('the host adds the maximum quantity of {string} for {string} in room {string}',async({page},product:string,guest:string,room:string)=>{await chooseOrder(page,product,guest,room);await page.locator('.product-tile').filter({hasText:product}).click({clickCount:98})});

Then('that cart line cannot exceed the order batch quantity limit',async({page})=>{await expect(page.locator('.product-tile').filter({hasText:'Helles'})).toBeDisabled();await expect(page.locator('.cart-lines .stepper b')).toHaveText('99')});
