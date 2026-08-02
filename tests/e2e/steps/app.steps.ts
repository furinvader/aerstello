import { execFileSync } from 'node:child_process';
import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createBdd } from 'playwright-bdd';

const { Before, After, Given, When, Then } = createBdd();
const e2eBaseURL = `http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
let guestPage: import('@playwright/test').Page | undefined;
let manifestPayload: { name?: string; icons?: unknown[] } | undefined;
const extraContexts: import('@playwright/test').BrowserContext[] = [];
let firstGuestAccessStatus = 0;
let secondGuestAccessStatus = 0;
let crossRoomApprovalStatus = 0;
let mismatchedHostOrderStatus = 0;
let disabledCatalogOrderStatus = 0;
let repeatedVoidStatuses: number[] = [];
let repeatedBillVoidStatuses: number[] = [];
let restoredBillItemCount = 0;
let archivedRoomGuestStatus = 0;
let invalidTimezoneStatus = 0;
let venueTimezoneBefore = '';
let venueTimezoneAfter = '';
let recoveredDeviceStatus = 0;
let retriedOrderMutationIds: string[] = [];
let retriedSettlementMutationIds: string[] = [];
let retriedOrderItemCount = 0;
let excessiveOrderStatus = 0;
let tabTotalBeforeExcess = 0;
let tabTotalAfterExcess = 0;
let guestArchiveRaceStatuses: [number, number][] = [];
let retriedGuestUndoMutationIds: string[] = [];
let oldestBillNumber = 0;
let revokedStreamEventCount = 0;

Before(async () => {
  execFileSync('npm',['run','db:seed','-w','@sky-bar/api'],{cwd:process.cwd(),env:{...process.env,E2E_RESET:'true'},stdio:'pipe'});
});

After(async () => {
  if (guestPage) { await guestPage.context().close(); guestPage=undefined; }
  await Promise.all(extraContexts.splice(0).map((context) => context.close()));
});

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@skybar.test');
  await page.getByLabel('Password').fill('SkyBarTest123!');
  await page.getByRole('button',{name:'Sign in'}).click();
  await expect(page).toHaveURL(/\/app/);
}

Given('the seeded Sky Bar venue', async ({ page }) => { await page.goto('/login'); });
When('the administrator signs in', async ({ page }) => { await signIn(page); });
Given('an authenticated administrator', async ({ page }) => { await signIn(page); });
Then('the host dashboard shows the venue name {string}', async ({ page }, name:string) => { await expect(page.locator('.page-header')).toContainText(name); });
Then('the page has no serious accessibility violations', async ({ page }) => { const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze();expect(result.violations.filter(v=>['serious','critical'].includes(v.impact??''))).toEqual([]); });
When('the host opens the account screen', async ({ page }) => { await page.goto('/app/account'); });
Then('the current device is listed', async ({ page }) => { await expect(page.getByText(/Dieses Gerät|Questo dispositivo|This device/)).toBeVisible(); });
When('the administrator credentials are recovered from the command line', async ({ page }) => {
  execFileSync('npm',['run','admin:create:dev','-w','@sky-bar/api','--','--email','admin@skybar.test','--password','RecoveredAdmin123!','--name','Mira Host'],{cwd:process.cwd(),env:process.env,stdio:'pipe'});
  recoveredDeviceStatus=(await page.context().request.get('/api/v1/auth/me')).status();
});
Then('the existing host device is signed out',async()=>{expect(recoveredDeviceStatus).toBe(401)});

When('the administrator changes the venue name to {string}', async ({ page }, name:string) => { await page.goto('/app/settings');await page.getByLabel('Name des Betriebs').fill(name);await page.getByRole('button',{name:'Speichern'}).click(); });
Then('the navigation shows the venue name {string}', async ({ page }, name:string) => { await expect(page.locator('.brand strong')).toHaveText(name); });
When('the administrator opens venue settings', async ({ page }) => { await page.goto('/app/settings'); });
Then('a venue QR code and room QR codes are shown', async ({ page }) => { await expect(page.locator('.qr-code')).toHaveCount(4); });
Then('venue settings is available in the primary navigation', async ({ page }) => { await expect(page.getByRole('link',{name:'Betrieb'})).toBeVisible(); });

async function chooseOrder(page: import('@playwright/test').Page, product:string, guest:string, room:string){await page.goto('/app/orders/new');await page.locator('.room-chips').getByRole('button',{name:room,exact:true}).click();await page.locator('.guest-list').getByRole('button',{name:new RegExp(guest)}).click();await page.locator('.product-tile').getByText(product,{exact:true}).click();}
When('the host adds one {string} to {string} in room {string}',async({page},product:string,guest:string,room:string)=>chooseOrder(page,product,guest,room));
Then('the staged cart total is {string}',async({page},total:string)=>{await expect(page.locator('.cart-total strong')).toHaveText(total)});
When('the host submits the order',async({page})=>{await page.getByRole('button',{name:/Bestellung buchen/}).click()});
Then("Anna's open tab contains one item",async({page})=>{await expect(page.locator('.tab-pill')).toContainText('1 Artikel')});
When('the host settles the tab with cash',async({page})=>{await page.getByRole('button',{name:/Abrechnen/}).click();await page.locator('.choice-grid').getByRole('button',{name:/Bar/}).click();await page.locator('.modal').getByRole('button',{name:'Abrechnen'}).click()});
Then('the bill shows the venue name {string}',async({page},name:string)=>{await expect(page.locator('.bill-sheet h1')).toHaveText(name)});
Then('the bill offers printing',async({page})=>{await expect(page.getByRole('button',{name:/Drucken/})).toBeVisible()});
Given('an authenticated administrator with the order catalog loaded',async({page})=>{await signIn(page);await page.goto('/app/orders/new');await expect(page.getByText('Helles',{exact:true})).toBeVisible()});
When('the device goes offline and the host submits one {string} for {string} in room {string}',async({page,context},product:string,guest:string,room:string)=>{await page.locator('.room-chips').getByRole('button',{name:room,exact:true}).click();await page.locator('.guest-list').getByRole('button',{name:new RegExp(guest)}).click();await page.locator('.product-tile').getByText(product,{exact:true}).click();await context.setOffline(true);await page.getByRole('button',{name:/Bestellung buchen/}).click()});
Then('the order is marked as queued for synchronization',async({page,context})=>{await expect(page.getByText(/Synchronisierung vorgemerkt|coda per la sincronizzazione|queued for sync/)).toBeVisible();await context.setOffline(false)});

Given('an authenticated administrator and a separate guest device',async({page,browser})=>{await signIn(page);const context=await browser.newContext();guestPage=await context.newPage();});
When('{string} requests access for room {string}',async({},name:string,room:string)=>{await guestPage!.goto('/guest/request');await guestPage!.locator('form select').nth(1).selectOption('de');await guestPage!.getByLabel('Name').fill(name);await guestPage!.locator('form select').first().selectOption({label:room});await guestPage!.locator('form button[type="submit"]').click()});
Then('the host sees the pending request for {string}',async({page},name:string)=>{await page.goto('/app/requests');await expect(page.getByText(name,{exact:true})).toBeVisible()});
When('the host approves the request for one day',async({page})=>{await page.getByRole('button',{name:/Genehmigen|Approve/}).click();await page.locator('.modal').getByRole('button',{name:/Genehmigen|Approve/}).click()});
Then("the guest device opens Luca's guest view without a password",async()=>{await expect(guestPage!).toHaveURL(/\/guest$/,{timeout:10000});await expect(guestPage!.getByRole('heading',{name:'Luca Rossi'})).toBeVisible()});

async function approveGuest(page:import('@playwright/test').Page,browser:import('@playwright/test').Browser,name:string,room:string){await signIn(page);const context=await browser.newContext();guestPage=await context.newPage();await guestPage.goto('/guest/request');await guestPage.locator('form select').nth(1).selectOption('de');await guestPage.getByLabel('Name').fill(name);await guestPage.locator('form select').first().selectOption({label:room});await guestPage.locator('form button[type="submit"]').click();await page.goto('/app/requests');await page.getByRole('button',{name:/Genehmigen|Approve/}).click();await page.locator('.modal').getByRole('button',{name:/Genehmigen|Approve/}).click();await expect(guestPage).toHaveURL(/\/guest$/,{timeout:10000})}
Given('an approved guest device for {string} in room {string}',async({page,browser},name:string,room:string)=>approveGuest(page,browser,name,room));
When('the guest adds {string} from self-service',async({},product:string)=>{await guestPage!.getByText(product,{exact:true}).click()});
Then('an undo action is available',async()=>{await expect(guestPage!.getByRole('button',{name:'Rückgängig'})).toBeVisible()});
Then('the undo action disappears after ten seconds',async()=>{await expect(guestPage!.getByRole('button',{name:'Rückgängig'})).toBeHidden({timeout:12_000})});
When('the guest uses undo',async()=>{await guestPage!.getByRole('button',{name:'Rückgängig'}).click()});
Then('the guest tab has no open items',async()=>{await expect(guestPage!.getByText('Noch keine Einträge')).toBeVisible()});
Then('the host has no empty open order for {string}',async({page},name:string)=>{await page.goto('/app/orders');await expect(page.locator('.tab-card').filter({hasText:name})).toHaveCount(0)});
When('the guest retries undo after its first response is lost',async()=>{
  await guestPage!.getByText('Mineralwasser',{exact:true}).click();await expect(guestPage!.getByRole('button',{name:'Rückgängig'})).toBeVisible();
  await guestPage!.evaluate(() => {
    const originalFetch=window.fetch.bind(window);let loseResponse=true;const ids:string[]=[];Object.assign(window,{__skyBarGuestUndoRetryIds:ids});
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/guest/items/')&&url.endsWith('/undo')&&init?.method==='POST'){ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)};
  });
  await guestPage!.getByRole('button',{name:'Rückgängig'}).click();await expect(guestPage!.locator('.notice--error')).toBeVisible();await guestPage!.getByRole('button',{name:'Rückgängig'}).click();retriedGuestUndoMutationIds=await guestPage!.evaluate(()=>(window as unknown as {__skyBarGuestUndoRetryIds:string[]}).__skyBarGuestUndoRetryIds);
});
Then('both guest undo attempts use the same mutation identifier',async()=>{expect(retriedGuestUndoMutationIds).toHaveLength(2);expect(new Set(retriedGuestUndoMutationIds).size).toBe(1)});

When('the administrator creates room {string}',async({page},name:string)=>{await page.goto('/app/rooms');await page.getByPlaceholder(/Zimmername|Nome camera|Room name/).fill(name);await page.locator('.inline-form').getByRole('button').click()});
Then('room {string} is listed',async({page},name:string)=>{await expect(page.getByText(name,{exact:true})).toBeVisible()});
When('the administrator renames room {string} to {string}',async({page},oldName:string,newName:string)=>{const row=page.locator('.sortable-list>div').filter({hasText:oldName});await row.getByRole('button').nth(2).click();await page.locator('.modal input').fill(newName);await page.locator('.modal').getByRole('button',{name:'Speichern'}).click()});
When('the host creates guest {string} in room {string}',async({page},name:string,room:string)=>{await page.goto('/app/guests');await page.getByRole('button',{name:/Hinzufügen/}).click();await page.locator('.modal').getByLabel('Name').fill(name);await page.locator('.modal').getByLabel('Zimmer').selectOption({label:room});await page.locator('.modal').getByRole('button',{name:'Speichern'}).click()});
Then('guest {string} is listed in room {string}',async({page},name:string,room:string)=>{const row=page.locator('.table-row').filter({hasText:name});await expect(row).toContainText(room)});
When('the administrator creates the self-service product {string} priced {string}',async({page},name:string,price:string)=>{await page.goto('/app/products');await page.getByRole('button',{name:/Hinzufügen/}).first().click();await page.getByLabel('Name · DE').fill(name);await page.getByLabel(/Preis · EUR|Prezzo · EUR|Price · EUR/).fill(price);await page.locator('.modal').getByText(/Selbstbedienung|Self-service/,{exact:true}).click();await page.locator('.modal').getByRole('button',{name:'Speichern'}).click()});
Then('product {string} is listed as self-service',async({page},name:string)=>{const row=page.locator('.product-admin-list>button').filter({hasText:name});await expect(row).toContainText('Selbstbedienung')});
When('the administrator tries to create product {string} priced {string}',async({page},name:string,price:string)=>{await page.goto('/app/products');await page.getByRole('button',{name:/Hinzufügen/}).first().click();await page.getByLabel('Name · DE').fill(name);await page.getByLabel(/Preis · EUR|Prezzo · EUR|Price · EUR/).fill(price);await page.locator('.modal').getByRole('button',{name:'Speichern'}).click()});
Then('the product price is rejected before submission',async({page})=>{const price=page.getByLabel(/Preis · EUR|Prezzo · EUR|Price · EUR/);await expect(price).toBeVisible();expect(await price.evaluate((input:HTMLInputElement)=>input.validity.valid)).toBe(false)});
When('the host attempts to create a guest in an archived room',async({page})=>{const request=page.context().request;const room=await (await request.post('/api/v1/rooms',{headers:csrfHeaders,data:{name:'Archived room'}})).json() as {id:string};expect((await request.delete(`/api/v1/rooms/${room.id}`,{headers:csrfHeaders})).status()).toBe(204);archivedRoomGuestStatus=(await request.post('/api/v1/guests',{headers:csrfHeaders,data:{name:'Late guest',roomId:room.id,language:'de'}})).status()});
Then('the archived room guest is rejected',async()=>{expect(archivedRoomGuestStatus).toBe(404)});
When('guest archival races with a new order',async({page})=>{const {request,me,products}=await operationalData(page);const rooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;name:string}[]};const product=products.data.find((item)=>item.name.de==='Helles')!;guestArchiveRaceStatuses=[];for(let attempt=0;attempt<8;attempt+=1){const guest=await (await request.post('/api/v1/guests',{headers:csrfHeaders,data:{name:`Race guest ${attempt}`,roomId:rooms.data.find((room)=>room.name==='102')!.id,language:'de'}})).json() as {id:string};const [archive,order]=await Promise.all([request.delete(`/api/v1/guests/${guest.id}`,{headers:csrfHeaders}),request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})]);guestArchiveRaceStatuses.push([archive.status(),order.status()])}});
Then('either the archive or the order is rejected',async()=>{for(const [archive,order] of guestArchiveRaceStatuses){expect([[204,404],[409,201]]).toContainEqual([archive,order])}});

When('the PWA manifest is requested',async({request})=>{const response=await request.get('/manifest.webmanifest');expect(response.ok()).toBeTruthy();manifestPayload=await response.json()});
Then('it names the software {string} and provides application icons',async({},name:string)=>{expect(manifestPayload?.name).toBe(name);expect(manifestPayload?.icons?.length).toBeGreaterThanOrEqual(2)});
Then('Take Orders navigation is visually prominent',async({page})=>{await expect(page.locator('.nav-primary')).toHaveCSS('background-color','rgb(66, 189, 255)')});
When('the host changes their language to Italian',async({page})=>{await page.goto('/app/account');await page.getByLabel(/Sprache|Language/).selectOption('it');await page.getByRole('button',{name:/Speichern|Save/}).click()});
Then('the navigation is shown in Italian',async({page})=>{await expect(page.getByText('Panoramica')).toBeVisible()});
When('the guest selects Italian',async()=>{await guestPage!.getByLabel(/Sprache|Lingua|Language/).selectOption('it')});
Then('untranslated product content falls back to German',async()=>{await expect(guestPage!.getByText('Hauskeks',{exact:true})).toBeVisible()});

const csrfHeaders = { 'x-skybar-csrf': '1' };
async function operationalData(page: import('@playwright/test').Page) {
  const request=page.context().request;
  const me=await (await request.get('/api/v1/auth/me')).json() as {host:{id:string}};
  const guests=await (await request.get('/api/v1/guests')).json() as {data:{id:string;name:string}[]};
  const products=await (await request.get('/api/v1/products')).json() as {catalogVersion:number;data:{id:string;name:{de:string};description?:{de:string;it?:string;en?:string};priceCents:number;categoryId:string;enabled:boolean;selfServiceOnly:boolean}[]};
  return {request,me,guests,products};
}

When('two devices exchange the same approved access request token',async({page,browser})=>{
  const request=page.context().request;
  const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const room=bootstrap.rooms.find((item)=>item.name==='102')!;
  const created=await (await request.post('/api/v1/public/access-requests',{data:{name:'One-time guest',roomId:room.id,language:'de'}})).json() as {id:string;statusToken:string};
  await request.post(`/api/v1/access-requests/${created.id}/approve`,{headers:csrfHeaders,data:{expiresAt:new Date(Date.now()+86_400_000).toISOString()}});
  const first=await browser.newContext({baseURL:e2eBaseURL});const second=await browser.newContext({baseURL:e2eBaseURL});extraContexts.push(first,second);
  await Promise.all([
    first.request.get(`/api/v1/public/access-requests/${created.id}/status?token=${encodeURIComponent(created.statusToken)}`),
    second.request.get(`/api/v1/public/access-requests/${created.id}/status?token=${encodeURIComponent(created.statusToken)}`),
  ]);
  firstGuestAccessStatus=(await first.request.get('/api/v1/guest/me')).status();
  secondGuestAccessStatus=(await second.request.get('/api/v1/guest/me')).status();
});
Then('exactly one device receives guest access',async()=>{expect([firstGuestAccessStatus,secondGuestAccessStatus].sort()).toEqual([200,401])});

When('the host links a room {string} request to a guest in room {string}',async({page},requestRoom:string,guestRoom:string)=>{
  const request=page.context().request;
  const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const rooms=bootstrap.rooms;
  const created=await (await request.post('/api/v1/public/access-requests',{data:{name:'Room-bound guest',roomId:rooms.find((room)=>room.name===requestRoom)!.id,language:'de'}})).json() as {id:string};
  const guests=await (await request.get('/api/v1/guests')).json() as {data:{id:string;roomName:string}[]};
  const response=await request.post(`/api/v1/access-requests/${created.id}/approve`,{headers:csrfHeaders,data:{guestId:guests.data.find((guest)=>guest.roomName===guestRoom)!.id,expiresAt:new Date(Date.now()+86_400_000).toISOString()}});
  crossRoomApprovalStatus=response.status();
});
Then('the cross-room approval is rejected',async()=>{expect(crossRoomApprovalStatus).toBe(404)});

When("another host submits the administrator's queued order",async({page})=>{
  const {request,me,guests,products}=await operationalData(page);
  await request.post('/api/v1/hosts',{headers:csrfHeaders,data:{email:'staff@skybar.test',name:'Queue Staff',password:'QueueStaff123!',role:'staff',language:'de'}});
  await request.post('/api/v1/auth/logout',{headers:csrfHeaders});
  await request.post('/api/v1/auth/login',{data:{email:'staff@skybar.test',password:'QueueStaff123!'}});
  const product=products.data.find((item)=>item.name.de==='Helles')!;
  const guest=guests.data.find((item)=>item.name==='Anna Berger')!;
  const response=await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}});
  mismatchedHostOrderStatus=response.status();
});
Then('the queued order is rejected for the other host',async()=>{expect(mismatchedHostOrderStatus).toBe(403)});

When('the host submits a product disabled in the captured catalog',async({page})=>{
  const {request,me,guests,products}=await operationalData(page);
  const product=products.data.find((item)=>item.name.de==='Helles')!;
  const disabled=await request.patch(`/api/v1/products/${product.id}`,{headers:csrfHeaders,data:{name:product.name,...(product.description?{description:product.description}:{}),priceCents:product.priceCents,categoryId:product.categoryId,enabled:false,selfServiceOnly:product.selfServiceOnly}});
  expect(disabled.status()).toBe(200);
  const updated=await (await request.get('/api/v1/products')).json() as {catalogVersion:number;data:{id:string;enabled:boolean}[]};
  expect(updated.data.find((item)=>item.id===product.id)?.enabled).toBe(false);
  const response=await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guests.data.find((item)=>item.name==='Anna Berger')!.id,catalogVersion:updated.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}});
  disabledCatalogOrderStatus=response.status();
});
Then('the captured catalog order is rejected',async()=>{expect(disabledCatalogOrderStatus).toBe(409)});

When('the host retries an order after its first response is lost',async({page})=>{
  await chooseOrder(page,'Helles','Anna Berger','101');
  await page.evaluate(() => {
    const originalFetch=window.fetch.bind(window);let loseResponse=true;const ids:string[]=[];
    Object.assign(window,{__skyBarOrderRetryIds:ids});
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/order-batches')&&init?.method==='POST'){ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)};
  });
  await page.getByRole('button',{name:/Bestellung buchen/}).click();
  await expect(page.locator('.notice--error')).toBeVisible();
  await page.getByRole('button',{name:/Bestellung buchen/}).click();
  await expect(page.getByText(/Bestellung hinzugefügt|Order added/)).toBeVisible();
  retriedOrderMutationIds=await page.evaluate(()=>(window as unknown as {__skyBarOrderRetryIds:string[]}).__skyBarOrderRetryIds);
  const {request,guests}=await operationalData(page);const guest=guests.data.find((item)=>item.name==='Anna Berger')!;retriedOrderItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
});
Then('both order attempts use the same mutation identifier',async()=>{expect(retriedOrderMutationIds).toHaveLength(2);expect(new Set(retriedOrderMutationIds).size).toBe(1)});
Then('the guest tab contains the order only once',async()=>{expect(retriedOrderItemCount).toBe(1)});

When('the host retries settlement after its first response is lost',async({page})=>{
  await chooseOrder(page,'Helles','Anna Berger','101');await page.getByRole('button',{name:/Bestellung buchen/}).click();await expect(page.locator('.tab-pill')).toContainText('1 Artikel');
  await page.evaluate(() => {
    const originalFetch=window.fetch.bind(window);let loseResponse=true;const ids:string[]=[];
    Object.assign(window,{__skyBarSettlementRetryIds:ids});
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(/\/api\/v1\/tabs\/[^/]+\/settle$/.test(url)&&init?.method==='POST'){ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)};
  });
  await page.getByRole('button',{name:/Abrechnen/}).click();await page.locator('.modal').getByRole('button',{name:'Abrechnen'}).click();await expect(page.locator('.modal .notice--error')).toBeVisible();await page.locator('.modal').getByRole('button',{name:'Abrechnen'}).click();await expect(page).toHaveURL(/\/app\/bills\//);
  retriedSettlementMutationIds=await page.evaluate(()=>(window as unknown as {__skyBarSettlementRetryIds:string[]}).__skyBarSettlementRetryIds);
});
Then('both settlement attempts use the same mutation identifier',async()=>{expect(retriedSettlementMutationIds).toHaveLength(2);expect(new Set(retriedSettlementMutationIds).size).toBe(1)});
Then('the host reaches the single resulting bill',async({page})=>{await expect(page.locator('.bill-sheet')).toBeVisible();const bills=await (await page.context().request.get('/api/v1/bills')).json() as {data:unknown[]};expect(bills.data).toHaveLength(1)});

When('the host submits orders beyond the maximum tab total',async({page})=>{
  const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find((item)=>item.name==='Anna Berger')!;const categoryId=products.data[0]!.categoryId;
  const created=await request.post('/api/v1/products',{headers:csrfHeaders,data:{name:{de:'Limitprodukt',it:'',en:''},priceCents:10_000_000,categoryId,enabled:true,selfServiceOnly:false}});expect(created.status()).toBe(201);const product=await created.json() as {id:string};const catalog=await (await request.get('/api/v1/products')).json() as {catalogVersion:number};
  const submit=async(quantity:number)=>request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:catalog.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity}]}});
  expect((await submit(99)).status()).toBe(201);expect((await submit(99)).status()).toBe(201);tabTotalBeforeExcess=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {totalCents:number}).totalCents;excessiveOrderStatus=(await submit(17)).status();tabTotalAfterExcess=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {totalCents:number}).totalCents;
});
Then('the excessive order is rejected without changing the tab',async()=>{expect(excessiveOrderStatus).toBe(409);expect(tabTotalBeforeExcess).toBe(1_980_000_000);expect(tabTotalAfterExcess).toBe(tabTotalBeforeExcess)});

When('the venue has more bills than one archive page',async({page})=>{const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find((item)=>item.name==='Anna Berger')!;const product=products.data.find((item)=>item.name.de==='Helles')!;for(let index=0;index<51;index+=1){const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};const bill=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),paymentMethod:'cash'}})).json() as {number:string};if(index===0)oldestBillNumber=Number(bill.number)}const firstPage=await (await request.get('/api/v1/bills?page=1&pageSize=50')).json() as {data:{number:number}[]};expect(firstPage.data.some((bill)=>bill.number===oldestBillNumber)).toBe(false)});
Then('the host can find the oldest bill by its number',async({page})=>{await page.goto('/app/bills');const [response]=await Promise.all([page.waitForResponse((candidate)=>candidate.url().includes(`/api/v1/bills?search=${oldestBillNumber}&`)),page.getByPlaceholder(/Nach Gast|Cerca per|Search by/).fill(String(oldestBillNumber))]);const result=await response.json() as {data:{id:string;number:number}[]};expect(result.data.map((bill)=>bill.number)).toContain(oldestBillNumber);const found=result.data.find((bill)=>bill.number===oldestBillNumber)!;await expect(page.locator(`a[href="/app/bills/${found.id}"]`)).toBeVisible()});

When('the same item void mutation is submitted twice',async({page})=>{
  const {request,me,guests,products}=await operationalData(page);
  const guest=guests.data.find((item)=>item.name==='Anna Berger')!;const product=products.data.find((item)=>item.name.de==='Helles')!;
  await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}});
  const tab=await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json() as {items:{id:string}[]};
  const mutationId=crypto.randomUUID();
  repeatedVoidStatuses=[];
  repeatedVoidStatuses.push((await request.post(`/api/v1/order-items/${tab.items[0]!.id}/void`,{headers:csrfHeaders,data:{mutationId,reason:'E2E correction'}})).status());
  repeatedVoidStatuses.push((await request.post(`/api/v1/order-items/${tab.items[0]!.id}/void`,{headers:csrfHeaders,data:{mutationId,reason:'E2E correction'}})).status());
});
Then('both item void responses succeed',async()=>{expect(repeatedVoidStatuses).toEqual([200,200])});

When('the same bill void mutation is submitted twice',async({page})=>{
  const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find((item)=>item.name==='Anna Berger')!;const product=products.data.find((item)=>item.name.de==='Helles')!;
  const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};
  const bill=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),paymentMethod:'cash'}})).json() as {id:string};const mutationId=crypto.randomUUID();repeatedBillVoidStatuses=[];
  repeatedBillVoidStatuses.push((await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId,reason:'E2E correction'}})).status());repeatedBillVoidStatuses.push((await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId,reason:'E2E correction'}})).status());restoredBillItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
});
Then('both bill void responses succeed',async()=>{expect(repeatedBillVoidStatuses).toEqual([200,200])});
Then('the billed items are restored only once',async()=>{expect(restoredBillItemCount).toBe(1)});

When('the administrator session is revoked while its event stream is open',async({page,browser})=>{
  await page.evaluate(()=>new Promise<void>((resolve,reject)=>{const events=new EventSource('/api/v1/events');Object.assign(window,{__skyBarRevokedEvents:0,__skyBarRevokedStream:events});events.addEventListener('rooms.changed',()=>{const state=window as unknown as {__skyBarRevokedEvents:number};state.__skyBarRevokedEvents+=1});events.addEventListener('open',()=>resolve(),{once:true});events.addEventListener('error',()=>{if(events.readyState===EventSource.CLOSED)reject(new Error('Event stream closed before opening'))},{once:true})}));
  const request=page.context().request;await request.post('/api/v1/hosts',{headers:csrfHeaders,data:{email:'realtime-admin@skybar.test',name:'Realtime Admin',password:'RealtimeAdmin123!',role:'admin',language:'de'}});const other=await browser.newContext({baseURL:e2eBaseURL});extraContexts.push(other);await other.request.post('/api/v1/auth/login',{data:{email:'realtime-admin@skybar.test',password:'RealtimeAdmin123!'}});execFileSync('npm',['run','admin:create:dev','-w','@sky-bar/api','--','--email','admin@skybar.test','--password','RecoveredAgain123!','--name','Mira Host'],{cwd:process.cwd(),env:process.env,stdio:'pipe'});expect((await other.request.post('/api/v1/rooms',{headers:csrfHeaders,data:{name:'After revocation'}})).status()).toBe(201);await page.waitForTimeout(500);revokedStreamEventCount=await page.evaluate(()=>(window as unknown as {__skyBarRevokedEvents:number}).__skyBarRevokedEvents);
});
Then('the revoked stream receives no later venue events',async()=>{expect(revokedStreamEventCount).toBe(0)});

When('the administrator submits an invalid venue time zone',async({page})=>{const request=page.context().request;const before=await (await request.get('/api/v1/venue')).json() as {name:string;defaultLanguage:string;timezone:string};venueTimezoneBefore=before.timezone;invalidTimezoneStatus=(await request.put('/api/v1/venue',{headers:csrfHeaders,data:{name:before.name,language:before.defaultLanguage,timezone:'Europe/Definitely-Not-A-Zone'}})).status();venueTimezoneAfter=((await (await request.get('/api/v1/venue')).json()) as {timezone:string}).timezone});
Then('the venue time zone is rejected without changing the settings',async()=>{expect(invalidTimezoneStatus).toBe(400);expect(venueTimezoneAfter).toBe(venueTimezoneBefore)});
