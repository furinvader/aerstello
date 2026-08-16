import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { createBrowserContext } from '../support/browser-context';
import { csrfHeaders } from '../support/operational-api-data';
import { installQueryOutage,releaseQueryOutage,restoreQueryOutage,retryQueryOutage } from '../support/query-outage';
import { stateFor } from './sessions.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('the host opens the account screen', async ({ page }) => { await page.goto('/app/account'); });

Then('the current device is listed', async ({ page }) => { await expect(page.getByText(/Dieses Gerät|Questo dispositivo|This device/)).toBeVisible(); });

When('the host device directory remains pending',async({page})=>{
  await installQueryOutage(page,['/api/v1/account/sessions']);
  await page.goto('/app/account');
});

Then('device loading is localized without an empty list and profile stays usable',async({page})=>{
  const devices=page.locator('.card').filter({has:page.getByRole('heading',{name:/Angemeldete Geräte|Dispositivi connessi|Logged-in devices/})});
  await expect(devices.getByText(/Wird geladen|Caricamento|Loading/)).toBeVisible();
  await expect(devices.locator('.empty,.device-list')).toHaveCount(0);
  await expect(page.getByLabel(/Name|Nome/).first()).toBeEnabled();
  await expect(page.getByRole('button',{name:/Speichern|Salva|Save/}).first()).toBeEnabled();
});

When('the pending host device directory fails',async({page})=>{await releaseQueryOutage(page)});

Then('device failure and retry are localized without an empty list',async({page})=>{
  const devices=page.locator('.card').filter({has:page.getByRole('heading',{name:/Angemeldete Geräte|Dispositivi connessi|Logged-in devices/})});
  await expect(devices.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/);
  await expect(devices.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();
  await expect(devices.locator('.empty,.device-list')).toHaveCount(0);
  await expect(page.getByLabel(/Name|Nome/).first()).toBeEnabled();
});

When('the host retries the device directory',async({page})=>{
  const devices=page.locator('.card').filter({has:page.getByRole('heading',{name:/Angemeldete Geräte|Dispositivi connessi|Logged-in devices/})});
  await retryQueryOutage(page,devices.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}));
});

Then('the current device reappears without a reload',async({page})=>{
  await expect(page.getByText(/Dieses Gerät|Questo dispositivo|This device/)).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {__aerstelloQueryOutage:{attempts:number}}).__aerstelloQueryOutage.attempts)).toBeGreaterThanOrEqual(3);
  await restoreQueryOutage(page);
});

When('the host revokes the current device from the account screen', async ({ page }) => {
  await page.goto('/app/account');
  const current=page.locator('.device-list>div').filter({hasText:/Dieses Gerät|Questo dispositivo|This device/});
  await current.getByRole('button').click();
});

Then('the host is redirected to login without cached venue data', async ({ page }) => {
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText('Hotel Aurora',{exact:true})).toHaveCount(0);
});

When('the host logs out and the committed response is lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/auth/logout')&&init?.method==='POST'){await originalFetch(input,init);throw new TypeError('Simulated lost logout response')}return originalFetch(input,init)}});
  await page.locator('.sidebar-footer button').evaluate((button:HTMLButtonElement)=>button.click());
  await expect(page).toHaveURL(/\/login$/);
  workflow.replayedLogoutStatus=(await page.context().request.post('/api/v1/auth/logout',{headers:csrfHeaders})).status();
});

Then('the host still reaches login without cached venue data',async({page})=>{await expect(page).toHaveURL(/\/login$/);await expect(page.getByText('Hotel Aurora',{exact:true})).toHaveCount(0)});

Then('replaying logout for the revoked session succeeds',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.replayedLogoutStatus).toBe(204)});

When('the current host session is revoked from another administrator',async({resources, page, browser})=>{
  const request=page.context().request;
  expect((await request.post('/api/v1/hosts',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),email:'remote-admin@aerstello.test',name:'Remote Admin',password:'RemoteAdmin123!',role:'admin',language:'de'}})).status()).toBe(201);
  const other=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});expect((await other.request.post('/api/v1/auth/login',{data:{email:'remote-admin@aerstello.test',password:'RemoteAdmin123!'}})).status()).toBe(200);
  await page.waitForTimeout(250);
  execFileSync('npm',['run','admin:create:dev','-w','@aerstello/api','--','--email','admin@aerstello.test','--name','Mira Host','--password-stdin'],{cwd:process.cwd(),env:process.env,stdio:'pipe',input:'RemoteReset123!\n'});
  expect((await other.request.post('/api/v1/rooms',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:'Remote logout signal'}})).status()).toBe(201);
});

Then('the remotely revoked host is redirected to login',async({page})=>{await expect(page).toHaveURL(/\/login$/,{timeout:10_000});await expect(page.getByText('Hotel Aurora',{exact:true})).toHaveCount(0)});
