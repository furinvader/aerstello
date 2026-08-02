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
let oldestBillNumber = '';
let revokedStreamEventCount = 0;
let transientReplayAttempts = 0;
let loginFailureResults: { status: number; body: unknown }[] = [];
let recoveredGrantStatus = 0;
let differentGrantStatus = 0;
let billArchiveRaceStatuses: [number, number][] = [];
let freshGuestPage: import('@playwright/test').Page | undefined;
let expiredGrantResult: { status: string; granted: boolean } | undefined;
let expiredGrantGuestStatus = 0;
let guestRevokedStatus = 0;
let approvalMoveRaceStatuses: [number, number][] = [];
let concurrentOrderStatuses: number[] = [];
let concurrentOrderItemCount = 0;
let concurrentSettlementStatuses: number[] = [];
let concurrentSettlementBillCount = 0;
let staleSettlementBillCount = 0;
let concurrentGuestItemStatuses: number[] = [];
let concurrentGuestItemCount = 0;
let pendingRoomArchiveStatus = 0;
let pendingRoomRequestCount = 0;
let grantExchangeRequest: { method: string; url: string; body: unknown } | undefined;
let archivedGrantGuestStatus = 0;
let retriedAccessRequestMutationIds: string[] = [];
let pendingAccessRequestCount = 0;
let retriedGuestAddMutationIds: string[] = [];
let uncertainGuestProductCounts: Record<string,number> = {};
let switchedGuestTabCount = 0;
let aggregateSettlementStatus = 0;
let uncertainOrderControlsLocked = false;
let uncertainSettlementDetailsLocked = false;
let changedSettlementReplayStatus = 0;
let sharedNetworkPollStatuses: number[] = [];
let conflictGuestId = '';
let changedItemVoidReplayStatus = 0;
let changedBillVoidReplayStatus = 0;
let snapshottedBillDate = '';
let retriedProductMutationIds: string[] = [];
let recoverableProductCount = 0;
let changedProductCreationReplayStatus = 0;
let deniedPollCounts: [number, number] = [0, 0];
let approvalDefaultLifetimeHours = 0;
let reloadedOrderMutationIds: string[] = [];
let reloadedOrderItemCount = 0;
let roleChangedHostPage: import('@playwright/test').Page | undefined;
let changedOrderReplayStatus = 0;
let changedOrderReplayItemCount = 0;
let dashboardOpenItemCount = 0;
let currentDeviceAfterPasswordChangeStatus = 0;
let otherDeviceAfterPasswordChangeStatus = 0;
let newPasswordLoginStatus = 0;
let retriedRoomMutationIds: string[] = [];
let recoverableRoomCount = 0;
let changedRoomCreationReplayStatus = 0;
let retriedCategoryMutationIds: string[] = [];
let recoverableCategoryCount = 0;
let changedCategoryCreationReplayStatus = 0;
let reopenedGuestAddMutationIds: string[] = [];
let reopenedGuestAddItemCount = 0;
let archivedGuestBillVoidStatus = 0;
let archivedGuestRestoredItemCount = 0;

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
When('the administrator changes the password with another device logged in',async({page,browser})=>{
  const other=await browser.newContext({baseURL:e2eBaseURL});extraContexts.push(other);
  expect((await other.request.post('/api/v1/auth/login',{data:{email:'admin@skybar.test',password:'SkyBarTest123!'}})).status()).toBe(200);
  expect((await page.context().request.patch('/api/v1/account',{headers:csrfHeaders,data:{currentPassword:'SkyBarTest123!',newPassword:'ChangedPassword123!'}})).status()).toBe(200);
  currentDeviceAfterPasswordChangeStatus=(await page.context().request.get('/api/v1/auth/me')).status();
  otherDeviceAfterPasswordChangeStatus=(await other.request.get('/api/v1/auth/me')).status();
  const fresh=await browser.newContext({baseURL:e2eBaseURL});extraContexts.push(fresh);
  newPasswordLoginStatus=(await fresh.request.post('/api/v1/auth/login',{data:{email:'admin@skybar.test',password:'ChangedPassword123!'}})).status();
});
Then('the password change keeps the current device and revokes the other device',async()=>{expect(currentDeviceAfterPasswordChangeStatus).toBe(200);expect(otherDeviceAfterPasswordChangeStatus).toBe(401)});
Then('the new password can be used to sign in',async()=>{expect(newPasswordLoginStatus).toBe(200)});
When('the administrator submits an incorrect current password',async({page})=>{await page.goto('/app/account');await page.getByLabel(/Aktuelles Passwort|Password attuale|Current password/).fill('IncorrectPassword123!');await page.getByLabel(/Neues Passwort|Nuova password|New password/).fill('ReplacementPassword123!');await page.getByRole('button',{name:/Speichern|Salva|Save/}).click()});
Then('the account screen shows the localized password error',async({page})=>{await expect(page.getByText('Das aktuelle Passwort ist falsch.')).toBeVisible()});
When('the host revokes the current device from the account screen', async ({ page }) => {
  await page.goto('/app/account');
  const current=page.locator('.device-list>div').filter({hasText:/Dieses Gerät|Questo dispositivo|This device/});
  await current.getByRole('button').click();
});
Then('the host is redirected to login without cached venue data', async ({ page }) => {
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('Hotel Aurora',{exact:true})).toHaveCount(0);
});
Given('an authenticated staff host', async ({ page }) => {
  await signIn(page);
  const request=page.context().request;
  expect((await request.post('/api/v1/hosts',{headers:csrfHeaders,data:{email:'room-staff@skybar.test',name:'Room Staff',password:'RoomStaff123!',role:'staff',language:'de'}})).status()).toBe(201);
  expect((await request.post('/api/v1/auth/logout',{headers:csrfHeaders})).status()).toBe(204);
  expect((await request.post('/api/v1/auth/login',{data:{email:'room-staff@skybar.test',password:'RoomStaff123!'}})).status()).toBe(200);
  await page.goto('/app');
});
Then('room management is absent from the navigation', async ({ page }) => { await expect(page.getByRole('link',{name:/^Zimmer$|^Camere$|^Rooms$/})).toHaveCount(0); });
Then('opening the room-management URL shows no mutation controls', async ({ page }) => { await page.goto('/app/rooms');await expect(page.locator('.notice--error')).toBeVisible();await expect(page.locator('.inline-form,.sortable-list')).toHaveCount(0); });
Then('opening the product-management URL shows no mutation controls', async ({ page }) => { await page.goto('/app/products');await expect(page.locator('.notice--error')).toBeVisible();await expect(page.locator('.inline-form,.product-admin-list')).toHaveCount(0); });
When('another administrator demotes an open host session to staff',async({page,browser})=>{const request=page.context().request;const created=await (await request.post('/api/v1/hosts',{headers:csrfHeaders,data:{email:'role-refresh@skybar.test',name:'Role Refresh',password:'RoleRefresh123!',role:'admin',language:'en'}})).json() as {id:string};const context=await browser.newContext({baseURL:e2eBaseURL});extraContexts.push(context);roleChangedHostPage=await context.newPage();await roleChangedHostPage.goto('/login');await roleChangedHostPage.getByLabel('Email').fill('role-refresh@skybar.test');await roleChangedHostPage.getByLabel('Password').fill('RoleRefresh123!');await roleChangedHostPage.getByRole('button',{name:'Sign in'}).click();await expect(roleChangedHostPage.getByRole('link',{name:'Rooms'})).toBeVisible();expect((await request.patch(`/api/v1/hosts/${created.id}`,{headers:csrfHeaders,data:{role:'staff'}})).status()).toBe(200)});
Then('administrator controls disappear from the affected session',async()=>{await expect(roleChangedHostPage!.getByRole('link',{name:'Rooms'})).toHaveCount(0,{timeout:10_000});expect(((await (await roleChangedHostPage!.context().request.get('/api/v1/auth/me')).json()) as {host:{role:string}}).host.role).toBe('staff')});
When('the current host session is revoked from another administrator',async({page,browser})=>{
  const request=page.context().request;
  expect((await request.post('/api/v1/hosts',{headers:csrfHeaders,data:{email:'remote-admin@skybar.test',name:'Remote Admin',password:'RemoteAdmin123!',role:'admin',language:'de'}})).status()).toBe(201);
  const other=await browser.newContext({baseURL:e2eBaseURL});extraContexts.push(other);expect((await other.request.post('/api/v1/auth/login',{data:{email:'remote-admin@skybar.test',password:'RemoteAdmin123!'}})).status()).toBe(200);
  await page.waitForTimeout(250);
  execFileSync('npm',['run','admin:create:dev','-w','@sky-bar/api','--','--email','admin@skybar.test','--password','RemoteReset123!','--name','Mira Host'],{cwd:process.cwd(),env:process.env,stdio:'pipe'});
  expect((await other.request.post('/api/v1/rooms',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:'Remote logout signal'}})).status()).toBe(201);
});
Then('the remotely revoked host is redirected to login',async({page})=>{await expect(page).toHaveURL(/\/login$/,{timeout:10_000});await expect(page.getByText('Hotel Aurora',{exact:true})).toHaveCount(0)});
When('invalid passwords are submitted for known and unknown host emails', async ({ page }) => {
  const request=page.context().request;
  const responses=await Promise.all([
    request.post('/api/v1/auth/login',{data:{email:'admin@skybar.test',password:'DefinitelyWrong123!'}}),
    request.post('/api/v1/auth/login',{data:{email:'missing@skybar.test',password:'DefinitelyWrong123!'}}),
  ]);
  loginFailureResults=await Promise.all(responses.map(async response=>({status:response.status(),body:await response.json()})));
});
Then('both login attempts return the same credential error', async () => { expect(loginFailureResults).toHaveLength(2);expect(loginFailureResults[0]).toEqual(loginFailureResults[1]); });
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
When('the host stages an order for Anna and confirms a switch to Luca',async({page})=>{
  const request=page.context().request;
  const rooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;name:string}[]};
  const room=rooms.data.find((item)=>item.name==='102')!;
  const luca=await (await request.post('/api/v1/guests',{headers:csrfHeaders,data:{name:'Luca Rossi',roomId:room.id,language:'de'}})).json() as {id:string};
  await chooseOrder(page,'Helles','Anna Berger','101');
  page.once('dialog',(dialog)=>dialog.accept());
  await page.locator('.room-chips').getByRole('button',{name:'102',exact:true}).click();
  await page.locator('.guest-list').getByRole('button',{name:/Luca Rossi/}).click();
  switchedGuestTabCount=((await (await request.get(`/api/v1/guests/${luca.id}/tab`)).json()) as {itemCount:number}).itemCount;
});
Then('the staged cart is cleared before Luca is selected',async({page})=>{await expect(page.locator('.catalog-toolbar')).toContainText('0 ausgewählt');await expect(page.getByRole('button',{name:/Bestellung buchen/})).toBeDisabled();await expect(page.locator('.page-header')).toContainText('Luca Rossi')});
Then("Luca's tab is unchanged",async()=>{expect(switchedGuestTabCount).toBe(0)});
Given('an authenticated administrator with the order catalog loaded',async({page})=>{await signIn(page);await page.goto('/app/orders/new');await expect(page.getByText('Helles',{exact:true})).toBeVisible()});
When('the device goes offline and the host submits one {string} for {string} in room {string}',async({page,context},product:string,guest:string,room:string)=>{await page.locator('.room-chips').getByRole('button',{name:room,exact:true}).click();await page.locator('.guest-list').getByRole('button',{name:new RegExp(guest)}).click();await page.locator('.product-tile').getByText(product,{exact:true}).click();await context.setOffline(true);await page.getByRole('button',{name:/Bestellung buchen/}).click()});
Then('the order is marked as queued for synchronization',async({page,context})=>{await expect(page.getByText(/Synchronisierung vorgemerkt|coda per la sincronizzazione|queued for sync/)).toBeVisible();await context.setOffline(false)});
Given('an open {string} order for {string} in room {string}',async({page},product:string,guest:string,room:string)=>{await chooseOrder(page,product,guest,room);await page.getByRole('button',{name:/Bestellung buchen/}).click();await expect(page.locator('.open-tab')).toContainText(product)});
When('the host removes the open item while offline',async({page,context})=>{await context.setOffline(true);await page.locator('.open-tab').getByRole('button',{name:/Artikel entfernen|Rimuovi articolo|Remove item/}).click();await page.locator('.modal input').fill('Falscher Artikel');await page.locator('.modal').getByRole('button',{name:/Bestätigen|Conferma|Confirm/}).click()});
Then('the item removal is queued for synchronization',async({page,context})=>{await expect(page.getByText(/Entfernen offline gespeichert|Rimozione salvata offline|Removal saved offline/)).toBeVisible();await context.setOffline(false)});
When('the host removes the only open item',async({page})=>{await page.locator('.open-tab').getByRole('button',{name:/Artikel entfernen|Rimuovi articolo|Remove item/}).click();await page.locator('.modal input').fill('Empty tab regression');await page.locator('.modal').getByRole('button',{name:/Bestätigen|Conferma|Confirm/}).click();await expect(page.locator('.open-tab')).toHaveCount(0)});
Then('no settlement action is offered for the empty tab',async({page})=>{await expect(page.getByRole('button',{name:/Abrechnen|Incassa|Settle/})).toHaveCount(0)});
When('a queued order encounters one transient synchronization failure',async({page,context})=>{
  await page.locator('.room-chips').getByRole('button',{name:'101',exact:true}).click();await page.locator('.guest-list').getByRole('button',{name:/Anna Berger/}).click();await page.locator('.product-tile').getByText('Helles',{exact:true}).click();
  await context.setOffline(true);await page.getByRole('button',{name:/Bestellung buchen/}).click();await expect(page.getByText(/Synchronisierung vorgemerkt|queued for sync/)).toBeVisible();
  await page.evaluate(()=>{
    const originalFetch=window.fetch.bind(window);let attempts=0;
    Object.assign(window,{__skyBarTransientReplayAttempts:0});
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/order-batches')&&init?.method==='POST'){attempts+=1;Object.assign(window,{__skyBarTransientReplayAttempts:attempts});if(attempts===1)throw new TypeError('Simulated transient sync failure')}return originalFetch(input,init)};
  });
  await context.setOffline(false);
  const {request,guests}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;
  await expect.poll(async()=>((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount,{timeout:15_000}).toBe(1);
  transientReplayAttempts=await page.evaluate(()=>(window as unknown as {__skyBarTransientReplayAttempts:number}).__skyBarTransientReplayAttempts);
});
Then('the queued order is retried without another connectivity event',async()=>{expect(transientReplayAttempts).toBeGreaterThanOrEqual(2)});

When('an offline order is quarantined as a synchronization conflict',async({page})=>{
  const {me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;const mutationId=crypto.randomUUID();const capturedAt=new Date().toISOString();conflictGuestId=guest.id;
  await page.evaluate(async({mutationId,capturedAt,hostId,guest,product,catalogVersion})=>new Promise<void>((resolve,reject)=>{
    const request=indexedDB.open('sky-bar');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const transaction=request.result.transaction('mutations','readwrite');transaction.objectStore('mutations').put({id:mutationId,hostId,path:'/order-batches',method:'POST',createdAt:capturedAt,status:'conflict',errorCode:'CATALOG_CONFLICT',body:{mutationId,originHostId:hostId,guestId:guest.id,catalogVersion,capturedAt,items:[{productId:product.id,quantity:2}]},display:{kind:'order',guestId:guest.id,guestName:guest.name,roomName:guest.roomName,items:[{productId:product.id,productName:product.name,quantity:2}]}});transaction.oncomplete=()=>resolve();transaction.onerror=()=>reject(transaction.error)};
  }),{mutationId,capturedAt,hostId:me.host.id,guest,product,catalogVersion:products.catalogVersion});
  await expect(page.locator('.sync-conflict-banner')).toBeVisible({timeout:10_000});await page.locator('.sync-conflict-banner').click();
});
Then('the conflict shows its guest, room, products, and quantities',async({page})=>{const modal=page.locator('.modal');await expect(modal).toContainText('Anna Berger');await expect(modal).toContainText('101');await expect(modal).toContainText('2 × Helles')});
Then('the host can retry it without discarding it',async({page})=>{await page.locator('.modal').getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();await expect.poll(async()=>((await (await page.context().request.get(`/api/v1/guests/${conflictGuestId}/tab`)).json()) as {itemCount:number}).itemCount,{timeout:10_000}).toBe(2)});

Given('a version-one device database contains a queued financial mutation',async({page})=>{
  await page.goto('/login');
  const mutationId=crypto.randomUUID();
  await page.evaluate(async({mutationId})=>{
    await new Promise<void>((resolve,reject)=>{const request=indexedDB.deleteDatabase('sky-bar');request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('Database deletion blocked'))});
    await new Promise<void>((resolve,reject)=>{
      const request=indexedDB.open('sky-bar',1);
      request.onupgradeneeded=()=>{const store=request.result.createObjectStore('mutations',{keyPath:'id'});store.createIndex('createdAt','createdAt')};
      request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{const transaction=request.result.transaction('mutations','readwrite');transaction.objectStore('mutations').put({id:mutationId,path:'/order-batches',method:'POST',createdAt:new Date().toISOString(),body:{mutationId,guestId:crypto.randomUUID(),catalogVersion:1,capturedAt:new Date().toISOString(),items:[{productId:crypto.randomUUID(),quantity:1}]}});transaction.oncomplete=()=>{request.result.close();resolve()};transaction.onerror=()=>reject(transaction.error)};
    });
  },{mutationId});
  await signIn(page);
});
Then('the queued financial mutation is preserved without assigning an owner',async({page})=>{await expect(page.locator('.sync-conflict-banner')).toBeVisible({timeout:10_000});await page.locator('.sync-conflict-banner').click();await expect(page.locator('.modal')).toContainText('/order-batches');const stored=await page.evaluate(async()=>new Promise<{hostId:string;status:string;body:{mutationId:string;originHostId?:string}}>((resolve,reject)=>{const request=indexedDB.open('sky-bar');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const transaction=request.result.transaction('mutations');const all=transaction.objectStore('mutations').getAll();all.onsuccess=()=>{request.result.close();resolve(all.result[0] as {hostId:string;status:string;body:{mutationId:string;originHostId?:string}})};all.onerror=()=>reject(all.error)}}));expect(stored.hostId).toBe('00000000-0000-0000-0000-000000000000');expect(stored.status).toBe('conflict');expect(stored.body.mutationId).toBeTruthy();expect(stored.body.originHostId).toBeUndefined()});
Then('the unowned mutation cannot be retried',async({page})=>{await page.locator('.modal').getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();await page.waitForTimeout(100);const stored=await page.evaluate(async()=>new Promise<{hostId:string;status:string}>((resolve,reject)=>{const request=indexedDB.open('sky-bar');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const transaction=request.result.transaction('mutations');const all=transaction.objectStore('mutations').getAll();all.onsuccess=()=>{request.result.close();resolve(all.result[0] as {hostId:string;status:string})};all.onerror=()=>reject(all.error)}}));expect(stored).toEqual(expect.objectContaining({hostId:'00000000-0000-0000-0000-000000000000',status:'conflict'}))});

Given('an authenticated administrator and a separate guest device',async({page,browser})=>{await signIn(page);const context=await browser.newContext();guestPage=await context.newPage();});
When('{string} requests access for room {string}',async({},name:string,room:string)=>{await guestPage!.goto('/guest/request');await guestPage!.locator('form select').nth(1).selectOption('de');await guestPage!.getByLabel('Name').fill(name);await guestPage!.locator('form select').first().selectOption({label:room});await guestPage!.locator('form button[type="submit"]').click()});
Then('the host sees the pending request for {string}',async({page},name:string)=>{await page.goto('/app/requests');await expect(page.getByText(name,{exact:true})).toBeVisible()});
When('the host opens approval for {string}',async({page},name:string)=>{const card=page.locator('.request-card').filter({hasText:name});await card.getByRole('button',{name:/Genehmigen|Approva|Approve/}).click()});
Then('creating a new guest is selected by default',async({page})=>{await expect(page.locator('.modal select').first()).toHaveValue('new')});
When('the host approves the request for one day',async({page})=>{await page.getByRole('button',{name:/Genehmigen|Approve/}).click();await page.locator('.modal').getByRole('button',{name:/Genehmigen|Approve/}).click()});
Then("the guest device opens Luca's guest view without a password",async()=>{await expect(guestPage!).toHaveURL(/\/guest$/,{timeout:10000});await expect(guestPage!.getByRole('heading',{name:'Luca Rossi'})).toBeVisible()});
When('the guest retries an access request after its first response is lost',async()=>{
  await guestPage!.goto('/guest/request');
  await guestPage!.locator('form select').nth(1).selectOption('de');
  await guestPage!.getByLabel('Name').fill('Retry Guest');
  await guestPage!.locator('form select').first().selectOption({label:'102'});
  await guestPage!.evaluate(()=>{
    const originalFetch=window.fetch.bind(window);let loseResponse=true;const ids:string[]=[];
    Object.assign(window,{__skyBarAccessRequestRetryIds:ids});
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/public/access-requests')&&init?.method==='POST'){ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)};
  });
  await guestPage!.locator('form button[type="submit"]').click();
  await expect(guestPage!.locator('.notice--error')).toBeVisible();
  await guestPage!.locator('form button[type="submit"]').click();
  await expect(guestPage!.locator('.request-wait')).toBeVisible();
  retriedAccessRequestMutationIds=await guestPage!.evaluate(()=>(window as unknown as {__skyBarAccessRequestRetryIds:string[]}).__skyBarAccessRequestRetryIds);
});
Then('both access request attempts use the same mutation identifier',async()=>{expect(retriedAccessRequestMutationIds).toHaveLength(2);expect(new Set(retriedAccessRequestMutationIds).size).toBe(1)});
Then('the host sees only one pending request from that guest',async({page})=>{const requests=await (await page.context().request.get('/api/v1/access-requests')).json() as {data:{name:string}[]};pendingAccessRequestCount=requests.data.filter((item)=>item.name==='Retry Guest').length;expect(pendingAccessRequestCount).toBe(1)});
When('the guest closes the pending request page',async()=>{await guestPage!.close()});
Then('reopening the request restores the approved guest access',async()=>{const context=guestPage!.context();guestPage=await context.newPage();await guestPage.goto('/guest/request');await expect(guestPage).toHaveURL(/\/guest$/,{timeout:10_000});await expect(guestPage.getByRole('heading',{name:'Persistent Guest'})).toBeVisible()});
When('the host denies the request for {string}',async({page},name:string)=>{let polls=0;guestPage!.on('request',request=>{if(request.url().includes('/api/v1/public/access-requests/')&&request.url().endsWith('/status'))polls+=1});const card=page.locator('.request-card').filter({hasText:name});await card.getByRole('button',{name:/Ablehnen|Rifiuta|Deny/}).click();await expect(guestPage!.locator('.request-wait').getByRole('heading')).toHaveText(/Ablehnen|Rifiuta|Deny/,{timeout:10_000});await guestPage!.waitForTimeout(500);const terminalCount=polls;await guestPage!.waitForTimeout(3_000);deniedPollCounts=[terminalCount,polls]});
Then('the denied guest device stops status polling',async()=>{expect(deniedPollCounts[1]).toBe(deniedPollCounts[0])});
When('a host in a non-UTC timezone opens a guest approval',async({page,browser})=>{const request=page.context().request;const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};const room=bootstrap.rooms.find(item=>item.name==='102')!;expect((await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Local expiry guest',roomId:room.id,language:'de'}})).status()).toBe(201);const context=await browser.newContext({baseURL:e2eBaseURL,timezoneId:'Pacific/Kiritimati'});extraContexts.push(context);const localPage=await context.newPage();await signIn(localPage);await localPage.goto('/app/requests');const card=localPage.locator('.request-card').filter({hasText:'Local expiry guest'});await card.getByRole('button',{name:/Genehmigen|Approva|Approve/}).click();approvalDefaultLifetimeHours=await localPage.locator('input[type="datetime-local"]').evaluate((input:HTMLInputElement)=>(new Date(input.value).getTime()-Date.now())/3_600_000)});
Then('the approval expiry is one local day from now',async()=>{expect(approvalDefaultLifetimeHours).toBeGreaterThan(23.9);expect(approvalDefaultLifetimeHours).toBeLessThan(24.1)});

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
When('the same guest item mutation is submitted concurrently',async()=>{const request=guestPage!.context().request;const catalog=await (await request.get('/api/v1/guest/catalog')).json() as {data:{id:string;name:{de:string}}[]};const product=catalog.data.find(item=>item.name.de==='Mineralwasser')!;const data={mutationId:crypto.randomUUID(),productId:product.id};const responses=await Promise.all([request.post('/api/v1/guest/items',{headers:csrfHeaders,data}),request.post('/api/v1/guest/items',{headers:csrfHeaders,data})]);concurrentGuestItemStatuses=responses.map(response=>response.status());concurrentGuestItemCount=((await (await request.get('/api/v1/guest/tab')).json()) as {itemCount:number}).itemCount});
Then('both concurrent guest item responses succeed',async()=>{expect(concurrentGuestItemStatuses).toEqual([201,201])});
Then('the concurrent guest item is stored only once',async()=>{expect(concurrentGuestItemCount).toBe(1)});

When('an approved guest grant response is lost before its cookie is retained',async({page,browser})=>{
  const request=page.context().request;
  const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const room=bootstrap.rooms.find(item=>item.name==='102')!;
  const created=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Recoverable grant',roomId:room.id,language:'de'}})).json() as {id:string;statusToken:string};
  expect((await request.post(`/api/v1/access-requests/${created.id}/approve`,{headers:csrfHeaders,data:{expiresAt:new Date(Date.now()+86_400_000).toISOString()}})).status()).toBe(200);
  const same=await browser.newContext({baseURL:e2eBaseURL});const different=await browser.newContext({baseURL:e2eBaseURL});extraContexts.push(same,different);
  const grantId=crypto.randomUUID();const statusPath=`/api/v1/public/access-requests/${created.id}/status`;const statusData={token:created.statusToken,grantId};
  expect((await same.request.post(statusPath,{data:statusData})).status()).toBe(200);
  await same.clearCookies();
  expect((await same.request.post(statusPath,{data:statusData})).status()).toBe(200);
  recoveredGrantStatus=(await same.request.get('/api/v1/guest/me')).status();
  await different.request.post(statusPath,{data:{token:created.statusToken,grantId:crypto.randomUUID()}});
  differentGrantStatus=(await different.request.get('/api/v1/guest/me')).status();
});
Then('retrying the same grant exchange restores guest access',async()=>{expect(recoveredGrantStatus).toBe(200)});
Then('a different grant exchange receives no guest access',async()=>{expect(differentGrantStatus).toBe(401)});
When('an approved guest request expires before its grant exchange',async({page,browser})=>{
  const request=page.context().request;const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};const room=bootstrap.rooms.find(item=>item.name==='102')!;
  const created=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Expired grant',roomId:room.id,language:'de'}})).json() as {id:string;statusToken:string};
  expect((await request.post(`/api/v1/access-requests/${created.id}/approve`,{headers:csrfHeaders,data:{expiresAt:new Date(Date.now()+1500).toISOString()}})).status()).toBe(200);
  await page.waitForTimeout(1800);
  const context=await browser.newContext({baseURL:e2eBaseURL});extraContexts.push(context);const response=await context.request.post(`/api/v1/public/access-requests/${created.id}/status`,{data:{token:created.statusToken,grantId:crypto.randomUUID()}});
  expiredGrantResult=await response.json() as {status:string;granted:boolean};expiredGrantGuestStatus=(await context.request.get('/api/v1/guest/me')).status();
});
Then('the expired exchange is not consumed or granted',async()=>{expect(expiredGrantResult).toEqual(expect.objectContaining({status:'expired',granted:false}));expect(expiredGrantGuestStatus).toBe(401)});
When("the host revokes Luca's device from the guest directory",async({page})=>{await page.goto('/app/guests');const row=page.locator('.table-row').filter({hasText:'Luca Rossi'});await row.getByRole('button',{name:/Angemeldete Geräte|Dispositivi connessi|Logged-in devices/}).click();await expect(page.locator('.modal .device-list')).toBeVisible();await page.locator('.modal').getByRole('button',{name:/Widerrufen|Revoca|Revoke/}).click();await expect(page.locator('.modal .device-list')).toHaveCount(0)});
Then("Luca's revoked device loses guest access",async()=>{guestRevokedStatus=(await guestPage!.context().request.get('/api/v1/guest/me')).status();expect(guestRevokedStatus).toBe(401)});
Then("Luca's open guest view returns to access request without cached data",async()=>{await expect(guestPage!).toHaveURL(/\/guest\/request$/,{timeout:10_000});await expect(guestPage!.getByText('Luca Rossi',{exact:true})).toHaveCount(0)});
When('the host renames Luca to {string}',async({page},name:string)=>{const request=page.context().request;const guests=await (await request.get('/api/v1/guests')).json() as {data:{id:string;name:string;roomId:string;language:string}[]};const luca=guests.data.find((item)=>item.name==='Luca Rossi')!;expect((await request.patch(`/api/v1/guests/${luca.id}`,{headers:csrfHeaders,data:{name,roomId:luca.roomId,language:luca.language}})).status()).toBe(200)});
Then("Luca's open guest view shows {string}",async({},name:string)=>{await expect(guestPage!.getByRole('heading',{name})).toBeVisible({timeout:10_000})});
When('the guest adds two different self-service items',async()=>{await guestPage!.locator('.product-tile').getByText('Mineralwasser',{exact:true}).click();await expect(guestPage!.locator('.undo-toast')).toHaveCount(1);await guestPage!.locator('.product-tile').getByText('Hauskeks',{exact:true}).click()});
Then('both provisional items offer their own undo action',async()=>{await expect(guestPage!.locator('.undo-toast')).toHaveCount(2);await expect(guestPage!.getByRole('button',{name:'Rückgängig'})).toHaveCount(2)});
When('one guest addition loses its response before another product is added',async()=>{
  await guestPage!.evaluate(()=>{
    const originalFetch=window.fetch.bind(window);let loseResponse=true;const entries:{productId:string;mutationId:string}[]=[];
    Object.assign(window,{__skyBarGuestAddRetryEntries:entries});
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/guest/items')&&init?.method==='POST'){const body=JSON.parse(String(init.body)) as {productId:string;mutationId:string};entries.push(body);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)};
  });
  await guestPage!.locator('.product-tile').getByText('Mineralwasser',{exact:true}).click();await expect(guestPage!.locator('.notice--error')).toBeVisible();await expect(guestPage!.locator('.undo-toast')).toHaveCount(1);
  await guestPage!.locator('.product-tile').getByText('Hauskeks',{exact:true}).click();await expect(guestPage!.locator('.undo-toast')).toHaveCount(2);
  await guestPage!.locator('.product-tile').getByText('Mineralwasser',{exact:true}).click();await expect(guestPage!.locator('.undo-toast')).toHaveCount(2);
  const entries=await guestPage!.evaluate(()=>(window as unknown as {__skyBarGuestAddRetryEntries:{productId:string;mutationId:string}[]}).__skyBarGuestAddRetryEntries);
  retriedGuestAddMutationIds=[entries[0]!.mutationId,entries[2]!.mutationId];
  const tab=await (await guestPage!.context().request.get('/api/v1/guest/tab')).json() as {items:{productName:{de:string};quantity:number}[]};
  uncertainGuestProductCounts=Object.fromEntries(tab.items.map((item)=>[item.productName.de,item.quantity]));
});
Then('retrying the uncertain product reuses its mutation identifier',async()=>{expect(retriedGuestAddMutationIds).toHaveLength(2);expect(new Set(retriedGuestAddMutationIds).size).toBe(1)});
Then('each selected self-service product is stored once',async()=>{expect(uncertainGuestProductCounts).toEqual(expect.objectContaining({Mineralwasser:1,Hauskeks:1}))});

When('the guest closes the app after a self-service response is lost',async()=>{
  await guestPage!.evaluate(()=>{
    const originalFetch=window.fetch.bind(window);const ids:string[]=[];Object.assign(window,{__skyBarClosingGuestAddIds:ids});
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/guest/items')&&init?.method==='POST'){ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);await originalFetch(input,init);throw new TypeError('Simulated lost response')}return originalFetch(input,init)};
  });
  await guestPage!.locator('.product-tile').getByText('Mineralwasser',{exact:true}).click();
  await expect(guestPage!.locator('.notice--error')).toBeVisible();
  reopenedGuestAddMutationIds=await guestPage!.evaluate(()=>(window as unknown as {__skyBarClosingGuestAddIds:string[]}).__skyBarClosingGuestAddIds);
  const context=guestPage!.context();await guestPage!.close();guestPage=await context.newPage();await guestPage.goto('/guest');await expect(guestPage.getByRole('heading',{name:'Luca Rossi'})).toBeVisible();
  await guestPage.evaluate(()=>{const originalFetch=window.fetch.bind(window);const ids:string[]=[];Object.assign(window,{__skyBarReopenedGuestAddIds:ids});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/guest/items')&&init?.method==='POST')ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);return originalFetch(input,init)}});
  await guestPage.locator('.product-tile').getByText('Mineralwasser',{exact:true}).click();
  await expect(guestPage.getByRole('button',{name:'Rückgängig'})).toBeVisible();
  reopenedGuestAddMutationIds.push(...await guestPage.evaluate(()=>(window as unknown as {__skyBarReopenedGuestAddIds:string[]}).__skyBarReopenedGuestAddIds));
  reopenedGuestAddItemCount=((await (await guestPage.context().request.get('/api/v1/guest/tab')).json()) as {itemCount:number}).itemCount;
});
Then('reopening and retrying reuses the original item mutation identifier',async()=>{expect(reopenedGuestAddMutationIds).toHaveLength(2);expect(new Set(reopenedGuestAddMutationIds).size).toBe(1)});
Then('the recovered self-service product is stored once',async()=>{expect(reopenedGuestAddItemCount).toBe(1)});

When('the administrator creates room {string}',async({page},name:string)=>{await page.goto('/app/rooms');await page.getByPlaceholder(/Zimmername|Nome camera|Room name/).fill(name);await page.locator('.inline-form').getByRole('button').click()});
Then('room {string} is listed',async({page},name:string)=>{await expect(page.getByText(name,{exact:true})).toBeVisible()});
When('the administrator renames room {string} to {string}',async({page},oldName:string,newName:string)=>{const row=page.locator('.sortable-list>div').filter({hasText:oldName});await row.getByRole('button').nth(2).click();await page.locator('.modal input').fill(newName);await page.locator('.modal').getByRole('button',{name:'Speichern'}).click()});
When('the administrator retries room creation after its first response is lost',async({page})=>{await page.goto('/app/rooms');await page.getByPlaceholder(/Zimmername|Nome camera|Room name/).fill('Recoverable room');await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let loseResponse=true;const commands:Record<string,unknown>[]=[];Object.assign(window,{__skyBarRoomCreateCommands:commands});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/rooms')&&init?.method==='POST'){commands.push(JSON.parse(String(init.body)) as Record<string,unknown>);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)}});await page.locator('.inline-form').getByRole('button').click();await expect(page.locator('.notice--error')).toBeVisible();await page.locator('.inline-form').getByRole('button').click();await expect(page.getByText('Recoverable room',{exact:true})).toBeVisible();const commands=await page.evaluate(()=>(window as unknown as {__skyBarRoomCreateCommands:Array<Record<string,unknown>>}).__skyBarRoomCreateCommands);retriedRoomMutationIds=commands.map(command=>String(command.mutationId));const rooms=await (await page.context().request.get('/api/v1/rooms')).json() as {data:{name:string}[]};recoverableRoomCount=rooms.data.filter(room=>room.name==='Recoverable room').length;changedRoomCreationReplayStatus=(await page.context().request.post('/api/v1/rooms',{headers:csrfHeaders,data:{...commands[0]!,name:'Changed recoverable room'}})).status()});
Then('both room creation attempts use the same mutation identifier',async()=>{expect(retriedRoomMutationIds).toHaveLength(2);expect(new Set(retriedRoomMutationIds).size).toBe(1)});
Then('only one recoverable room exists',async()=>{expect(recoverableRoomCount).toBe(1)});
Then('changing the replayed room creation is rejected',async()=>{expect(changedRoomCreationReplayStatus).toBe(409)});
When('the administrator retries category creation after its first response is lost',async({page})=>{await page.goto('/app/products');await page.getByPlaceholder(/Deutscher Name|Nome tedesco|German name/).fill('Recoverable category');await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let loseResponse=true;const commands:Record<string,unknown>[]=[];Object.assign(window,{__skyBarCategoryCreateCommands:commands});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/categories')&&init?.method==='POST'){commands.push(JSON.parse(String(init.body)) as Record<string,unknown>);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)}});const form=page.locator('.inline-form');await form.getByRole('button').click();await expect(page.locator('.notice--error')).toBeVisible();await form.getByRole('button').click();await expect(page.getByText('Recoverable category',{exact:true})).toBeVisible();const commands=await page.evaluate(()=>(window as unknown as {__skyBarCategoryCreateCommands:Array<Record<string,unknown>>}).__skyBarCategoryCreateCommands);retriedCategoryMutationIds=commands.map(command=>String(command.mutationId));const categories=await (await page.context().request.get('/api/v1/categories')).json() as {data:{name:{de:string}}[]};recoverableCategoryCount=categories.data.filter(category=>category.name.de==='Recoverable category').length;changedCategoryCreationReplayStatus=(await page.context().request.post('/api/v1/categories',{headers:csrfHeaders,data:{...commands[0]!,name:{de:'Changed recoverable category',it:'',en:''}}})).status()});
Then('both category creation attempts use the same mutation identifier',async()=>{expect(retriedCategoryMutationIds).toHaveLength(2);expect(new Set(retriedCategoryMutationIds).size).toBe(1)});
Then('only one recoverable category exists',async()=>{expect(recoverableCategoryCount).toBe(1)});
Then('changing the replayed category creation is rejected',async()=>{expect(changedCategoryCreationReplayStatus).toBe(409)});
When('the host creates guest {string} in room {string}',async({page},name:string,room:string)=>{await page.goto('/app/guests');await page.getByRole('button',{name:/Hinzufügen/}).click();await page.locator('.modal').getByLabel('Name').fill(name);await page.locator('.modal').getByLabel('Zimmer').selectOption({label:room});await page.locator('.modal').getByRole('button',{name:'Speichern'}).click()});
Then('guest {string} is listed in room {string}',async({page},name:string,room:string)=>{const row=page.locator('.table-row').filter({hasText:name});await expect(row).toContainText(room)});
When('another device creates guest {string} in room {string}',async({page},name:string,roomName:string)=>{await page.goto('/app/guests');await expect(page.getByText('Anna Berger',{exact:true})).toBeVisible();const request=page.context().request;const rooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;name:string}[]};const room=rooms.data.find(item=>item.name===roomName)!;expect((await request.post('/api/v1/guests',{headers:csrfHeaders,data:{name,roomId:room.id,language:'de'}})).status()).toBe(201)});
Then('guest {string} appears after the committed event',async({page},name:string)=>{await expect(page.getByText(name,{exact:true})).toBeVisible({timeout:10_000})});
When('the administrator creates the self-service product {string} priced {string}',async({page},name:string,price:string)=>{await page.goto('/app/products');await page.getByRole('button',{name:/Hinzufügen/}).first().click();await page.getByLabel('Name · DE').fill(name);await page.getByLabel(/Preis · EUR|Prezzo · EUR|Price · EUR/).fill(price);await page.locator('.modal').getByText(/Selbstbedienung|Self-service/,{exact:true}).click();await page.locator('.modal').getByRole('button',{name:'Speichern'}).click()});
Then('product {string} is listed as self-service',async({page},name:string)=>{const row=page.locator('.product-admin-list>button').filter({hasText:name});await expect(row).toContainText('Selbstbedienung')});
When('the administrator retries product creation after its first response is lost',async({page})=>{await page.goto('/app/products');await page.getByRole('button',{name:/Hinzufügen|Aggiungi|Add/}).first().click();await page.getByLabel('Name · DE').fill('Recoverable product');await page.getByLabel(/Preis · EUR|Prezzo · EUR|Price · EUR/).fill('4.20');await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let loseResponse=true;const commands:Record<string,unknown>[]=[];Object.assign(window,{__skyBarProductCreateCommands:commands});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/products')&&init?.method==='POST'){commands.push(JSON.parse(String(init.body)) as Record<string,unknown>);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)}});await page.locator('.modal').getByRole('button',{name:/Speichern|Salva|Save/}).click();await expect(page.locator('.modal .notice--error')).toBeVisible();await page.locator('.modal').getByRole('button',{name:/Speichern|Salva|Save/}).click();await expect(page.locator('.modal')).toHaveCount(0);const commands=await page.evaluate(()=>(window as unknown as {__skyBarProductCreateCommands:Array<Record<string,unknown>>}).__skyBarProductCreateCommands);retriedProductMutationIds=commands.map(command=>String(command.mutationId));const products=await (await page.context().request.get('/api/v1/products')).json() as {data:{name:{de:string}}[]};recoverableProductCount=products.data.filter(product=>product.name.de==='Recoverable product').length;changedProductCreationReplayStatus=(await page.context().request.post('/api/v1/products',{headers:csrfHeaders,data:{...commands[0]!,name:{de:'Changed recoverable product',it:'',en:''}}})).status()});
Then('both product creation attempts use the same mutation identifier',async()=>{expect(retriedProductMutationIds).toHaveLength(2);expect(new Set(retriedProductMutationIds).size).toBe(1)});
Then('only one recoverable product exists',async()=>{expect(recoverableProductCount).toBe(1)});
Then('changing the replayed product creation is rejected',async()=>{expect(changedProductCreationReplayStatus).toBe(409)});
When('the administrator tries to create product {string} priced {string}',async({page},name:string,price:string)=>{await page.goto('/app/products');await page.getByRole('button',{name:/Hinzufügen/}).first().click();await page.getByLabel('Name · DE').fill(name);await page.getByLabel(/Preis · EUR|Prezzo · EUR|Price · EUR/).fill(price);await page.locator('.modal').getByRole('button',{name:'Speichern'}).click()});
Then('the product price is rejected before submission',async({page})=>{const price=page.getByLabel(/Preis · EUR|Prezzo · EUR|Price · EUR/);await expect(price).toBeVisible();expect(await price.evaluate((input:HTMLInputElement)=>input.validity.valid)).toBe(false)});
When('the host attempts to create a guest in an archived room',async({page})=>{const request=page.context().request;const room=await (await request.post('/api/v1/rooms',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:'Archived room'}})).json() as {id:string};expect((await request.delete(`/api/v1/rooms/${room.id}`,{headers:csrfHeaders})).status()).toBe(204);archivedRoomGuestStatus=(await request.post('/api/v1/guests',{headers:csrfHeaders,data:{name:'Late guest',roomId:room.id,language:'de'}})).status()});
Then('the archived room guest is rejected',async()=>{expect(archivedRoomGuestStatus).toBe(404)});
When('the administrator archives a room with a pending access request',async({page})=>{const request=page.context().request;const room=await (await request.post('/api/v1/rooms',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:'Pending request room'}})).json() as {id:string};const pending=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Waiting guest',roomId:room.id,language:'de'}})).json() as {id:string};pendingRoomArchiveStatus=(await request.delete(`/api/v1/rooms/${room.id}`,{headers:csrfHeaders})).status();const requests=await (await request.get('/api/v1/access-requests')).json() as {data:{id:string}[]};pendingRoomRequestCount=requests.data.filter(item=>item.id===pending.id).length});
Then('room archival is rejected and the request remains pending',async()=>{expect(pendingRoomArchiveStatus).toBe(409);expect(pendingRoomRequestCount).toBe(1)});
When('guest archival races with a new order',async({page})=>{const {request,me,products}=await operationalData(page);const rooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;name:string}[]};const product=products.data.find((item)=>item.name.de==='Helles')!;guestArchiveRaceStatuses=[];for(let attempt=0;attempt<8;attempt+=1){const guest=await (await request.post('/api/v1/guests',{headers:csrfHeaders,data:{name:`Race guest ${attempt}`,roomId:rooms.data.find((room)=>room.name==='102')!.id,language:'de'}})).json() as {id:string};const [archive,order]=await Promise.all([request.delete(`/api/v1/guests/${guest.id}`,{headers:csrfHeaders}),request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})]);guestArchiveRaceStatuses.push([archive.status(),order.status()])}});
Then('either the archive or the order is rejected',async()=>{for(const [archive,order] of guestArchiveRaceStatuses){expect([[204,404],[409,201]]).toContainEqual([archive,order])}});

When('the PWA manifest is requested',async({request})=>{const response=await request.get('/manifest.webmanifest');expect(response.ok()).toBeTruthy();manifestPayload=await response.json()});
Then('it names the software {string} and provides application icons',async({},name:string)=>{expect(manifestPayload?.name).toBe(name);expect(manifestPayload?.icons?.length).toBeGreaterThanOrEqual(2)});
Then('Take Orders navigation is visually prominent',async({page})=>{await expect(page.locator('.nav-primary')).toHaveCSS('background-color','rgb(66, 189, 255)')});
When('the host opens the bills screen',async({page})=>{await page.goto('/app/bills')});
Then('only Bills is active in the primary navigation',async({page})=>{await expect(page.locator('.sidebar nav a.active')).toHaveCount(1);await expect(page.locator('.sidebar nav a.active')).toHaveAttribute('href','/app/bills')});
When('the host changes their language to Italian',async({page})=>{await page.goto('/app/account');await page.getByLabel(/Sprache|Language/).selectOption('it');await page.getByRole('button',{name:/Speichern|Save/}).click()});
Then('the navigation is shown in Italian',async({page})=>{await expect(page.getByText('Panoramica')).toBeVisible()});
When('the host changes their language to Italian and opens the product editor',async({page})=>{await page.goto('/app/account');await page.getByLabel(/Sprache|Language/).selectOption('it');await page.getByRole('button',{name:/Speichern|Save/}).click();await expect(page.getByText('Panoramica')).toBeVisible();await page.goto('/app/products');await page.getByRole('button',{name:/Aggiungi/}).first().click()});
Then('the product name label is shown in Italian',async({page})=>{await expect(page.getByLabel('Nome · DE')).toBeVisible()});
When('the guest selects Italian',async()=>{await guestPage!.getByLabel(/Sprache|Lingua|Language/).selectOption('it')});
Then('untranslated product content falls back to German',async()=>{await expect(guestPage!.getByText('Hauskeks',{exact:true})).toBeVisible()});
When('the venue default language is Italian',async({page,browser})=>{const request=page.context().request;const venue=await (await request.get('/api/v1/venue')).json() as {name:string;timezone:string};expect((await request.put('/api/v1/venue',{headers:csrfHeaders,data:{name:venue.name,timezone:venue.timezone,language:'it'}})).status()).toBe(200);const context=await browser.newContext({baseURL:e2eBaseURL,locale:'en-US'});extraContexts.push(context);freshGuestPage=await context.newPage();await freshGuestPage.goto('/guest/request')});
Then('a fresh English guest device starts in Italian',async()=>{await expect(freshGuestPage!.getByRole('heading',{name:'Accesso ospite'})).toBeVisible()});
When('a fresh guest selects Italian on the access form',async({page})=>{await page.goto('/guest/request');await page.locator('form select').nth(1).selectOption('it')});
Then('the guest name field is labeled in Italian',async({page})=>{await expect(page.getByLabel('Nome')).toBeVisible()});

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
  const created=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'One-time guest',roomId:room.id,language:'de'}})).json() as {id:string;statusToken:string};
  await request.post(`/api/v1/access-requests/${created.id}/approve`,{headers:csrfHeaders,data:{expiresAt:new Date(Date.now()+86_400_000).toISOString()}});
  const first=await browser.newContext({baseURL:e2eBaseURL});const second=await browser.newContext({baseURL:e2eBaseURL});extraContexts.push(first,second);
  await Promise.all([
    first.request.post(`/api/v1/public/access-requests/${created.id}/status`,{data:{token:created.statusToken,grantId:crypto.randomUUID()}}),
    second.request.post(`/api/v1/public/access-requests/${created.id}/status`,{data:{token:created.statusToken,grantId:crypto.randomUUID()}}),
  ]);
  firstGuestAccessStatus=(await first.request.get('/api/v1/guest/me')).status();
  secondGuestAccessStatus=(await second.request.get('/api/v1/guest/me')).status();
});
Then('exactly one device receives guest access',async()=>{expect([firstGuestAccessStatus,secondGuestAccessStatus].sort()).toEqual([200,401])});

When('an approved request is exchanged for a guest grant',async({page,browser})=>{
  const request=page.context().request;
  const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const room=bootstrap.rooms.find(item=>item.name==='102')!;
  const created=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Body grant',roomId:room.id,language:'de'}})).json() as {id:string;statusToken:string};
  expect((await request.post(`/api/v1/access-requests/${created.id}/approve`,{headers:csrfHeaders,data:{expiresAt:new Date(Date.now()+86_400_000).toISOString()}})).status()).toBe(200);
  const context=await browser.newContext({baseURL:e2eBaseURL});
  extraContexts.push(context);
  const pending={id:created.id,token:created.statusToken,grantId:crypto.randomUUID()};
  await context.addInitScript((value)=>sessionStorage.setItem('skybar-pending',JSON.stringify(value)),pending);
  const device=await context.newPage();
  const observed=device.waitForRequest(candidate=>candidate.url().includes(`/api/v1/public/access-requests/${created.id}/status`));
  await device.goto('/guest/request');
  const exchange=await observed;
  grantExchangeRequest={method:exchange.method(),url:exchange.url(),body:exchange.postDataJSON()};
});
Then('the grant token is sent in the request body',async()=>{expect(grantExchangeRequest?.method).toBe('POST');expect(new URL(grantExchangeRequest!.url).search).toBe('');expect(grantExchangeRequest?.body).toEqual(expect.objectContaining({token:expect.any(String),grantId:expect.any(String)}))});

When('thirteen guest devices poll pending access from one network',async({page})=>{
  const request=page.context().request;const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string}[]};const room=bootstrap.rooms[0]!;
  const pending=await Promise.all(Array.from({length:13},async(_,index)=>{
    const response=await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:`Shared network guest ${index}`,roomId:room.id,language:'de'}});expect(response.status()).toBe(201);return response.json() as Promise<{id:string;statusToken:string}>;
  }));
  sharedNetworkPollStatuses=[];
  for(let round=0;round<25;round+=1){const responses=await Promise.all(pending.map(item=>request.post(`/api/v1/public/access-requests/${item.id}/status`,{data:{token:item.statusToken,grantId:crypto.randomUUID()}})));sharedNetworkPollStatuses.push(...responses.map(response=>response.status()))}
});
Then('none of their valid status polls is rate limited',async()=>{expect(sharedNetworkPollStatuses).toHaveLength(325);expect(sharedNetworkPollStatuses).not.toContain(429);expect(new Set(sharedNetworkPollStatuses)).toEqual(new Set([200]))});

When('guest archival races with their first grant exchange',async({page,browser})=>{const request=page.context().request;const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};const room=bootstrap.rooms.find(item=>item.name==='102')!;const created=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Archived grant race',roomId:room.id,language:'de'}})).json() as {id:string;statusToken:string};const approved=await (await request.post(`/api/v1/access-requests/${created.id}/approve`,{headers:csrfHeaders,data:{expiresAt:new Date(Date.now()+86_400_000).toISOString()}})).json() as {guestId:string};const context=await browser.newContext({baseURL:e2eBaseURL});extraContexts.push(context);const [,exchange]=await Promise.all([request.delete(`/api/v1/guests/${approved.guestId}`,{headers:csrfHeaders}),context.request.post(`/api/v1/public/access-requests/${created.id}/status`,{data:{token:created.statusToken,grantId:crypto.randomUUID()}})]);expect(exchange.status()).toBe(200);archivedGrantGuestStatus=(await context.request.get('/api/v1/guest/me')).status()});
Then('no archived guest session remains active',async()=>{expect(archivedGrantGuestStatus).toBe(401)});

When('the host links a room {string} request to a guest in room {string}',async({page},requestRoom:string,guestRoom:string)=>{
  const request=page.context().request;
  const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const rooms=bootstrap.rooms;
  const created=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Room-bound guest',roomId:rooms.find((room)=>room.name===requestRoom)!.id,language:'de'}})).json() as {id:string};
  const guests=await (await request.get('/api/v1/guests')).json() as {data:{id:string;roomName:string}[]};
  const response=await request.post(`/api/v1/access-requests/${created.id}/approve`,{headers:csrfHeaders,data:{guestId:guests.data.find((guest)=>guest.roomName===guestRoom)!.id,expiresAt:new Date(Date.now()+86_400_000).toISOString()}});
  crossRoomApprovalStatus=response.status();
});
Then('the cross-room approval is rejected',async()=>{expect(crossRoomApprovalStatus).toBe(404)});

When('linked approval races with moving its guest to another room',async({page})=>{
  const request=page.context().request;const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};const source=bootstrap.rooms.find(item=>item.name==='102')!;const target=bootstrap.rooms.find(item=>item.name==='101')!;approvalMoveRaceStatuses=[];
  for(let attempt=0;attempt<8;attempt+=1){const guest=await (await request.post('/api/v1/guests',{headers:csrfHeaders,data:{name:`Approval race ${attempt}`,roomId:source.id,language:'de'}})).json() as {id:string};const access=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:`Approval race ${attempt}`,roomId:source.id,language:'de'}})).json() as {id:string};const [approval,move]=await Promise.all([request.post(`/api/v1/access-requests/${access.id}/approve`,{headers:csrfHeaders,data:{guestId:guest.id,expiresAt:new Date(Date.now()+86_400_000).toISOString()}}),request.patch(`/api/v1/guests/${guest.id}`,{headers:csrfHeaders,data:{name:`Approval race ${attempt}`,roomId:target.id,language:'de'}})]);approvalMoveRaceStatuses.push([approval.status(),move.status()])}
});
Then('approval either wins before the move or rejects the moved guest',async()=>{for(const statuses of approvalMoveRaceStatuses)expect([[200,200],[404,200]]).toContainEqual(statuses)});

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
  uncertainOrderControlsLocked=await page.locator('.product-tile').filter({hasText:'Helles'}).isDisabled()&&await page.locator('.guest-list').getByRole('button',{name:/Anna Berger/}).isDisabled()&&await page.locator('.stepper button').last().isDisabled();
  await page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();
  await expect(page.getByText(/Bestellung hinzugefügt|Order added/)).toBeVisible();
  retriedOrderMutationIds=await page.evaluate(()=>(window as unknown as {__skyBarOrderRetryIds:string[]}).__skyBarOrderRetryIds);
  const {request,guests}=await operationalData(page);const guest=guests.data.find((item)=>item.name==='Anna Berger')!;retriedOrderItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
});
Then('both order attempts use the same mutation identifier',async()=>{expect(retriedOrderMutationIds).toHaveLength(2);expect(new Set(retriedOrderMutationIds).size).toBe(1)});
Then('order editing was locked while the result was uncertain',async()=>{expect(uncertainOrderControlsLocked).toBe(true)});
Then('the guest tab contains the order only once',async()=>{expect(retriedOrderItemCount).toBe(1)});

When('the host reloads after an order response is lost',async({page})=>{
  await chooseOrder(page,'Helles','Anna Berger','101');
  await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);const ids:string[]=[];Object.assign(window,{__skyBarReloadOrderIds:ids});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/order-batches')&&init?.method==='POST'){ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);await originalFetch(input,init);throw new TypeError('Simulated lost response')}return originalFetch(input,init)}});
  await page.getByRole('button',{name:/Bestellung buchen|Submit order/}).click();await expect(page.locator('.notice--error')).toBeVisible();const firstIds=await page.evaluate(()=>(window as unknown as {__skyBarReloadOrderIds:string[]}).__skyBarReloadOrderIds);await page.reload();await expect(page.locator('.cart-lines').getByText('Helles',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);const ids:string[]=[];Object.assign(window,{__skyBarReloadOrderIds:ids});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/order-batches')&&init?.method==='POST')ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);return originalFetch(input,init)}});await page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();await expect(page.getByText(/Bestellung hinzugefügt|Order added/)).toBeVisible();const secondIds=await page.evaluate(()=>(window as unknown as {__skyBarReloadOrderIds:string[]}).__skyBarReloadOrderIds);reloadedOrderMutationIds=[...firstIds,...secondIds];const {request,guests}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;reloadedOrderItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
});
Then('the restored order retry uses the original mutation identifier',async()=>{expect(reloadedOrderMutationIds).toHaveLength(2);expect(new Set(reloadedOrderMutationIds).size).toBe(1)});
Then('the guest tab contains the restored order only once',async()=>{expect(reloadedOrderItemCount).toBe(1)});

When('an order mutation is replayed with a changed quantity',async({page})=>{
  const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;
  const command={mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]};
  expect((await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:command})).status()).toBe(201);
  changedOrderReplayStatus=(await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{...command,items:[{productId:product.id,quantity:2}]}})).status();
  changedOrderReplayItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
});
Then('the changed order replay is rejected',async()=>{expect(changedOrderReplayStatus).toBe(409)});
Then('the original order quantity remains unchanged',async()=>{expect(changedOrderReplayItemCount).toBe(1)});

When('the host submits five items in one order line',async({page})=>{
  const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;
  expect((await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:5}]}})).status()).toBe(201);
  dashboardOpenItemCount=((await (await request.get('/api/v1/dashboard')).json()) as {openItemCount:number}).openItemCount;
});
Then('the dashboard reports five open items',async()=>{expect(dashboardOpenItemCount).toBe(5)});

When('the host retries settlement after its first response is lost',async({page})=>{
  await chooseOrder(page,'Helles','Anna Berger','101');await page.getByRole('button',{name:/Bestellung buchen/}).click();await expect(page.locator('.tab-pill')).toContainText('1 Artikel');
  await page.evaluate(() => {
    const originalFetch=window.fetch.bind(window);let loseResponse=true;const ids:string[]=[];
    Object.assign(window,{__skyBarSettlementRetryIds:ids});
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(/\/api\/v1\/tabs\/[^/]+\/settle$/.test(url)&&init?.method==='POST'){ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)};
  });
  await page.getByRole('button',{name:/Abrechnen/}).click();await page.locator('.modal').getByRole('button',{name:'Abrechnen'}).click();await expect(page.locator('.modal .notice--error')).toBeVisible();uncertainSettlementDetailsLocked=await page.locator('.choice-grid').getByRole('button',{name:/Bar/}).isDisabled()&&await page.locator('.choice-grid').getByRole('button',{name:/Karte/}).isDisabled();await page.locator('.modal').getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();await expect(page).toHaveURL(/\/app\/bills\//);
  retriedSettlementMutationIds=await page.evaluate(()=>(window as unknown as {__skyBarSettlementRetryIds:string[]}).__skyBarSettlementRetryIds);
});
Then('both settlement attempts use the same mutation identifier',async()=>{expect(retriedSettlementMutationIds).toHaveLength(2);expect(new Set(retriedSettlementMutationIds).size).toBe(1)});
Then('settlement details were locked while the result was uncertain',async()=>{expect(uncertainSettlementDetailsLocked).toBe(true)});
Then('the host reaches the single resulting bill',async({page})=>{await expect(page.locator('.bill-sheet')).toBeVisible();const bills=await (await page.context().request.get('/api/v1/bills')).json() as {data:unknown[]};expect(bills.data).toHaveLength(1)});

When('the host adds the maximum quantity of {string} for {string} in room {string}',async({page},product:string,guest:string,room:string)=>{await chooseOrder(page,product,guest,room);await page.locator('.product-tile').filter({hasText:product}).click({clickCount:98})});
Then('that cart line cannot exceed the order batch quantity limit',async({page})=>{await expect(page.locator('.product-tile').filter({hasText:'Helles'})).toBeDisabled();await expect(page.locator('.cart-lines .stepper b')).toHaveText('99')});

When('the same settlement mutation is submitted concurrently',async({page})=>{const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};const data={mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'};const responses=await Promise.all([request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data}),request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data})]);concurrentSettlementStatuses=responses.map(response=>response.status());concurrentSettlementBillCount=((await (await request.get('/api/v1/bills')).json()) as {data:unknown[]}).data.length});
Then('both concurrent settlement responses succeed',async()=>{expect(concurrentSettlementStatuses).toEqual([200,200])});
Then('concurrent settlement creates only one bill',async()=>{expect(concurrentSettlementBillCount).toBe(1)});

When('a settlement mutation is replayed with another payment method',async({page})=>{const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};const mutationId=crypto.randomUUID();const command={mutationId,expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'};expect((await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:command})).status()).toBe(200);changedSettlementReplayStatus=(await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{...command,paymentMethod:'card'}})).status()});
Then('the changed settlement replay is rejected',async()=>{expect(changedSettlementReplayStatus).toBe(409)});
When('another order changes the tab while settlement is open',async({page})=>{await chooseOrder(page,'Helles','Anna Berger','101');await page.getByRole('button',{name:/Bestellung buchen/}).click();await expect(page.locator('.tab-pill')).toContainText('1 Artikel');await page.getByRole('button',{name:/Abrechnen/}).click();const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;expect((await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).status()).toBe(201);await page.locator('.modal').getByRole('button',{name:'Abrechnen'}).click();await expect(page.locator('.modal .notice--error')).toBeVisible();staleSettlementBillCount=((await (await request.get('/api/v1/bills')).json()) as {data:unknown[]}).data.length});
Then('settlement reports that the displayed tab changed',async({page})=>{await expect(page.locator('.modal')).toContainText(/Bestellung hat sich geändert|ordine è cambiato|order changed/i)});
Then('no bill is created for the stale confirmation',async()=>{expect(staleSettlementBillCount).toBe(0)});

When('the host submits orders beyond the maximum tab total',async({page})=>{
  const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find((item)=>item.name==='Anna Berger')!;const categoryId=products.data[0]!.categoryId;
  const created=await request.post('/api/v1/products',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:{de:'Limitprodukt',it:'',en:''},priceCents:10_000_000,categoryId,enabled:true,selfServiceOnly:false}});expect(created.status()).toBe(201);const product=await created.json() as {id:string};const catalog=await (await request.get('/api/v1/products')).json() as {catalogVersion:number};
  const submit=async(quantity:number)=>request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:catalog.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity}]}});
  expect((await submit(99)).status()).toBe(201);expect((await submit(99)).status()).toBe(201);tabTotalBeforeExcess=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {totalCents:number}).totalCents;excessiveOrderStatus=(await submit(17)).status();tabTotalAfterExcess=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {totalCents:number}).totalCents;
});
Then('the excessive order is rejected without changing the tab',async()=>{expect(excessiveOrderStatus).toBe(409);expect(tabTotalBeforeExcess).toBe(1_980_000_000);expect(tabTotalAfterExcess).toBe(tabTotalBeforeExcess)});
When('a tab accumulates more than 9900 zero-cost items across valid batches',async({page})=>{
  const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find((item)=>item.name==='Anna Berger')!;const categoryId=products.data[0]!.categoryId;
  const product=await (await request.post('/api/v1/products',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:{de:'Freiprodukt',it:'',en:''},priceCents:0,categoryId,enabled:true,selfServiceOnly:false}})).json() as {id:string};
  const catalog=await (await request.get('/api/v1/products')).json() as {catalogVersion:number};let tabId='';
  for(let index=0;index<101;index+=1){const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:catalog.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:99}]}})).json() as {tabId:string};tabId=order.tabId;}
  aggregateSettlementStatus=(await request.post(`/api/v1/tabs/${tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:9_999,expectedTotalCents:0,paymentMethod:'cash'}})).status();
});
Then('the aggregate tab can still be settled',async()=>{expect(aggregateSettlementStatus).toBe(200)});

When('the venue has more bills than one archive page',async({page})=>{const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find((item)=>item.name==='Anna Berger')!;const product=products.data.find((item)=>item.name.de==='Helles')!;for(let index=0;index<51;index+=1){const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};const bill=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}})).json() as {number:string};if(index===0)oldestBillNumber=bill.number}const firstPage=await (await request.get('/api/v1/bills?page=1&pageSize=50')).json() as {data:{number:string}[]};expect(firstPage.data.some((bill)=>bill.number===oldestBillNumber)).toBe(false)});
Then('the host can find the oldest bill by its number',async({page})=>{await page.goto('/app/bills');const [response]=await Promise.all([page.waitForResponse((candidate)=>candidate.url().includes(`/api/v1/bills?search=${oldestBillNumber}&`)),page.getByPlaceholder(/Nach Gast|Cerca per|Search by/).fill(oldestBillNumber)]);const result=await response.json() as {data:{id:string;number:string}[]};expect(result.data.map((bill)=>bill.number)).toContain(oldestBillNumber);const found=result.data.find((bill)=>bill.number===oldestBillNumber)!;await expect(page.locator(`a[href="/app/bills/${found.id}"]`)).toBeVisible()});

When('the venue timezone changes after a bill is settled',async({page})=>{const {request,me,guests,products}=await operationalData(page);const venue=await (await request.get('/api/v1/venue')).json() as {name:string;defaultLanguage:string};expect((await request.put('/api/v1/venue',{headers:csrfHeaders,data:{name:venue.name,language:venue.defaultLanguage,timezone:'Pacific/Kiritimati'}})).status()).toBe(200);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};const settled=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}})).json() as {id:string};const bill=await (await request.get(`/api/v1/bills/${settled.id}`)).json() as {settledAt:string;venueTimezone:string};expect(bill.venueTimezone).toBe('Pacific/Kiritimati');snapshottedBillDate=new Date(bill.settledAt).toLocaleDateString('de',{timeZone:bill.venueTimezone});expect((await request.put('/api/v1/venue',{headers:csrfHeaders,data:{name:venue.name,language:venue.defaultLanguage,timezone:'Pacific/Honolulu'}})).status()).toBe(200);await page.goto(`/app/bills/${settled.id}`)});
Then('the bill date uses its snapshotted venue timezone',async({page})=>{await expect(page.locator('.bill-meta')).toContainText(snapshottedBillDate)});

When('the same item void mutation is submitted twice',async({page})=>{
  const {request,me,guests,products}=await operationalData(page);
  const guest=guests.data.find((item)=>item.name==='Anna Berger')!;const product=products.data.find((item)=>item.name.de==='Helles')!;
  await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}});
  const tab=await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json() as {items:{id:string}[]};
  const mutationId=crypto.randomUUID();
  repeatedVoidStatuses=[];
  repeatedVoidStatuses.push((await request.post(`/api/v1/order-items/${tab.items[0]!.id}/void`,{headers:csrfHeaders,data:{mutationId,reason:'E2E correction'}})).status());
  repeatedVoidStatuses.push((await request.post(`/api/v1/order-items/${tab.items[0]!.id}/void`,{headers:csrfHeaders,data:{mutationId,reason:'E2E correction'}})).status());
  changedItemVoidReplayStatus=(await request.post(`/api/v1/order-items/${tab.items[0]!.id}/void`,{headers:csrfHeaders,data:{mutationId,reason:'Changed correction'}})).status();
});
Then('both item void responses succeed',async()=>{expect(repeatedVoidStatuses).toEqual([200,200])});
Then('changing the replayed item void reason is rejected',async()=>{expect(changedItemVoidReplayStatus).toBe(409)});

When('the same order mutation is submitted concurrently',async({page})=>{
  const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;const mutationId=crypto.randomUUID();const data={mutationId,originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]};
  const responses=await Promise.all([request.post('/api/v1/order-batches',{headers:csrfHeaders,data}),request.post('/api/v1/order-batches',{headers:csrfHeaders,data})]);concurrentOrderStatuses=responses.map(response=>response.status());concurrentOrderItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
});
Then('both concurrent order responses succeed',async()=>{expect(concurrentOrderStatuses).toEqual([201,201])});
Then('the concurrent order is stored only once',async()=>{expect(concurrentOrderItemCount).toBe(1)});

When('the same bill void mutation is submitted twice',async({page})=>{
  const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find((item)=>item.name==='Anna Berger')!;const product=products.data.find((item)=>item.name.de==='Helles')!;
  const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};
  const bill=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}})).json() as {id:string};const mutationId=crypto.randomUUID();repeatedBillVoidStatuses=[];
  repeatedBillVoidStatuses.push((await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId,reason:'E2E correction'}})).status());repeatedBillVoidStatuses.push((await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId,reason:'E2E correction'}})).status());changedBillVoidReplayStatus=(await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId,reason:'Changed correction'}})).status();restoredBillItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
});
Then('both bill void responses succeed',async()=>{expect(repeatedBillVoidStatuses).toEqual([200,200])});
Then('the billed items are restored only once',async()=>{expect(restoredBillItemCount).toBe(1)});
Then('changing the replayed bill void reason is rejected',async()=>{expect(changedBillVoidReplayStatus).toBe(409)});

When('guest archival races with reversal of their bill',async({page})=>{
  const {request,me,products}=await operationalData(page);const rooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;name:string}[]};const product=products.data.find(item=>item.name.de==='Helles')!;const room=rooms.data.find(item=>item.name==='102')!;billArchiveRaceStatuses=[];
  for(let attempt=0;attempt<8;attempt+=1){
    const guest=await (await request.post('/api/v1/guests',{headers:csrfHeaders,data:{name:`Bill race guest ${attempt}`,roomId:room.id,language:'de'}})).json() as {id:string};
    const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};
    const bill=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}})).json() as {id:string};
    const [archive,reversal]=await Promise.all([request.delete(`/api/v1/guests/${guest.id}`,{headers:csrfHeaders}),request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),reason:'Race correction'}})]);
    billArchiveRaceStatuses.push([archive.status(),reversal.status()]);
  }
});
Then('the bill reversal succeeds before or after guest archival',async()=>{for(const statuses of billArchiveRaceStatuses)expect([[204,200],[409,200]]).toContainEqual(statuses)});

When('the administrator reverses a bill for an archived guest',async({page})=>{
  const {request,me,products}=await operationalData(page);const rooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;name:string}[]};const product=products.data.find(item=>item.name.de==='Helles')!;const room=rooms.data.find(item=>item.name==='102')!;
  const guest=await (await request.post('/api/v1/guests',{headers:csrfHeaders,data:{name:'Archived correction guest',roomId:room.id,language:'de'}})).json() as {id:string};
  const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};
  const bill=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}})).json() as {id:string};
  expect((await request.delete(`/api/v1/guests/${guest.id}`,{headers:csrfHeaders})).status()).toBe(204);
  archivedGuestBillVoidStatus=(await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),reason:'Archived guest correction'}})).status();
  archivedGuestRestoredItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
});
Then('the archived guest bill is voided and its item is restored',async()=>{expect(archivedGuestBillVoidStatus).toBe(200);expect(archivedGuestRestoredItemCount).toBe(1)});

When('the host opens a voided bill for printing',async({page})=>{const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};const bill=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}})).json() as {id:string};expect((await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),reason:'Printed correction'}})).status()).toBe(200);await page.goto(`/app/bills/${bill.id}`);await page.emulateMedia({media:'print'})});
Then('the printed bill shows its void reason',async({page})=>{await expect(page.locator('.bill-void-marker .notice')).toBeVisible();await expect(page.locator('.bill-void-marker')).toContainText('Printed correction')});

When('the administrator session is revoked while its event stream is open',async({page,browser})=>{
  await page.evaluate(()=>new Promise<void>((resolve,reject)=>{sessionStorage.setItem('__skyBarRevokedEvents','0');const events=new EventSource('/api/v1/events');Object.assign(window,{__skyBarRevokedStream:events});events.addEventListener('rooms.changed',()=>sessionStorage.setItem('__skyBarRevokedEvents',String(Number(sessionStorage.getItem('__skyBarRevokedEvents'))+1)));events.addEventListener('open',()=>resolve(),{once:true});events.addEventListener('error',()=>{if(events.readyState===EventSource.CLOSED)reject(new Error('Event stream closed before opening'))},{once:true})}));
  const request=page.context().request;await request.post('/api/v1/hosts',{headers:csrfHeaders,data:{email:'realtime-admin@skybar.test',name:'Realtime Admin',password:'RealtimeAdmin123!',role:'admin',language:'de'}});const other=await browser.newContext({baseURL:e2eBaseURL});extraContexts.push(other);await other.request.post('/api/v1/auth/login',{data:{email:'realtime-admin@skybar.test',password:'RealtimeAdmin123!'}});execFileSync('npm',['run','admin:create:dev','-w','@sky-bar/api','--','--email','admin@skybar.test','--password','RecoveredAgain123!','--name','Mira Host'],{cwd:process.cwd(),env:process.env,stdio:'pipe'});expect((await other.request.post('/api/v1/rooms',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:'After revocation'}})).status()).toBe(201);await page.waitForTimeout(500);revokedStreamEventCount=await page.evaluate(()=>Number(sessionStorage.getItem('__skyBarRevokedEvents')));
});
Then('the revoked stream receives no later venue events',async()=>{expect(revokedStreamEventCount).toBe(0)});

When('the administrator submits an invalid venue time zone',async({page})=>{const request=page.context().request;const before=await (await request.get('/api/v1/venue')).json() as {name:string;defaultLanguage:string;timezone:string};venueTimezoneBefore=before.timezone;invalidTimezoneStatus=(await request.put('/api/v1/venue',{headers:csrfHeaders,data:{name:before.name,language:before.defaultLanguage,timezone:'Europe/Definitely-Not-A-Zone'}})).status();venueTimezoneAfter=((await (await request.get('/api/v1/venue')).json()) as {timezone:string}).timezone});
Then('the venue time zone is rejected without changing the settings',async()=>{expect(invalidTimezoneStatus).toBe(400);expect(venueTimezoneAfter).toBe(venueTimezoneBefore)});
