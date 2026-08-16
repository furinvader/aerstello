import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { signIn } from '../authentication/sign-in';
import { test } from '../fixtures/test';
import { createBrowserContext } from '../support/browser-context';
import { connectDatabase } from '../support/database';
import { csrfHeaders } from '../support/operational-api-data';
import { installQueryOutage,releaseQueryOutage,restoreQueryOutage,retryQueryOutage } from '../support/query-outage';
import { stateFor } from './host-accounts.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('the host account directory remains pending',async({page})=>{
  const request=page.context().request;
  expect((await request.post('/api/v1/hosts',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),email:'directory-staff@aerstello.test',name:'Directory Staff',password:'DirectoryStaff123!',role:'staff',language:'de'}})).status()).toBe(201);
  await installQueryOutage(page,['/api/v1/hosts']);
  await page.goto('/app/account');
});

Then('host account loading hides empty and host mutation actions',async({page})=>{
  const heading=page.getByRole('heading',{name:/Host-Konten|Account host|Host accounts/});
  const directory=heading.locator('xpath=../following-sibling::*[1]');
  await expect(directory.getByText(/Wird geladen|Caricamento|Loading/)).toBeVisible();
  await expect(directory.locator('.empty,.table-list')).toHaveCount(0);
  await expect(page.getByRole('button',{name:/^Hinzufügen$|^Aggiungi$|^Add$/})).toHaveCount(0);
  await expect(directory.getByRole('button',{name:/Aktivieren|Deaktivieren|Abilita|Disabilita|Enable|Disable/})).toHaveCount(0);
});

Then('profile and device controls remain usable',async({page})=>{
  await expect(page.getByLabel(/Name|Nome/).first()).toBeEnabled();
  await expect(page.getByRole('button',{name:/Speichern|Salva|Save/,exact:true})).toBeEnabled();
  await expect(page.getByText(/Dieses Gerät|Questo dispositivo|This device/)).toBeVisible();
});

When('the pending host account directory fails',async({page})=>{await releaseQueryOutage(page)});

Then('host account failure and retry hide empty and host mutation actions',async({page})=>{
  const heading=page.getByRole('heading',{name:/Host-Konten|Account host|Host accounts/});
  const directory=heading.locator('xpath=../following-sibling::*[1]');
  await expect(directory.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/);
  await expect(directory.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();
  await expect(directory.locator('.empty,.table-list')).toHaveCount(0);
  await expect(page.getByRole('button',{name:/^Hinzufügen$|^Aggiungi$|^Add$/})).toHaveCount(0);
  await expect(directory.getByRole('button',{name:/Aktivieren|Deaktivieren|Abilita|Disabilita|Enable|Disable/})).toHaveCount(0);
  await expect(page.getByLabel(/Name|Nome/).first()).toBeEnabled();
  await expect(page.getByText(/Dieses Gerät|Questo dispositivo|This device/)).toBeVisible();
});

When('the administrator retries the host account directory',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const heading=page.getByRole('heading',{name:/Host-Konten|Account host|Host accounts/});
  const directory=heading.locator('xpath=../following-sibling::*[1]');
  workflow.hostSessionRequestsBeforeDirectoryRetry=await page.evaluate(()=>(window as unknown as {__aerstelloQueryOutage:{observed:Record<string,number>}}).__aerstelloQueryOutage.observed['/api/v1/account/sessions']??0);
  await retryQueryOutage(page,directory.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}));
});

Then('host account rows and mutation actions recover independently',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const heading=page.getByRole('heading',{name:/Host-Konten|Account host|Host accounts/});
  const directory=heading.locator('xpath=../following-sibling::*[1]');
  await expect(directory.getByText('Directory Staff',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/^Hinzufügen$|^Aggiungi$|^Add$/})).toBeEnabled();
  await expect(directory.getByRole('button',{name:/Deaktivieren|Disabilita|Disable/})).toBeEnabled();
  const state=await page.evaluate(()=>(window as unknown as {__aerstelloQueryOutage:{attempts:number;observed:Record<string,number>}}).__aerstelloQueryOutage);
  expect(state.attempts).toBeGreaterThanOrEqual(3);
  expect(state.observed['/api/v1/account/sessions']??0).toBe(workflow.hostSessionRequestsBeforeDirectoryRetry);
  await restoreQueryOutage(page);
});

When('the administrator retries host creation after its response is lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await page.goto('/app/account');await page.getByRole('button',{name:/Hinzufügen|Aggiungi|Add/}).last().click();const modal=page.locator('.modal');await modal.getByLabel('Name').fill('Recoverable Host');await modal.getByLabel(/E-Mail/).fill('recoverable-host@aerstello.test');await modal.getByLabel(/Temporäres Passwort|Password temporanea|Temporary password/).fill('RecoverableHost123!');await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let loseResponse=true;const commands:Record<string,unknown>[]=[];Object.assign(window,{__aerstelloHostCreateCommands:commands});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/hosts')&&init?.method==='POST'){commands.push(JSON.parse(String(init.body)) as Record<string,unknown>);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)}});await modal.getByRole('button',{name:/Konto erstellen|Crea account|Create account/}).click();await expect(modal.locator('.notice--error')).toBeVisible();workflow.uncertainHostFieldsLocked=await modal.locator('input,select').evaluateAll(fields=>fields.every(field=>(field as HTMLInputElement).disabled));await modal.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();await expect(modal).toHaveCount(0);const commands=await page.evaluate(()=>(window as unknown as {__aerstelloHostCreateCommands:Array<Record<string,unknown>>}).__aerstelloHostCreateCommands);workflow.retriedHostCreationMutationIds=commands.map(command=>String(command.mutationId));const hosts=await (await page.context().request.get('/api/v1/hosts')).json() as {data:{email:string}[]};workflow.recoverableHostCount=hosts.data.filter(host=>host.email==='recoverable-host@aerstello.test').length});

Then('both host creation attempts use the same mutation identifier',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedHostCreationMutationIds).toHaveLength(2);expect(new Set(workflow.retriedHostCreationMutationIds).size).toBe(1)});

Then('the uncertain host fields stay locked for retry',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.uncertainHostFieldsLocked).toBe(true)});

Then('only one recoverable host account exists',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.recoverableHostCount).toBe(1)});

Then('host creation retains no retired password verifier',async({resources})=>{const databaseResource=await connectDatabase(resources);const database=databaseResource.client;try{const host=(await database.query(`SELECT password_hash AS "passwordHash",create_command_hash AS "commandHash" FROM hosts WHERE email='recoverable-host@aerstello.test'`)).rows[0] as {passwordHash:string;commandHash:string};expect(host.passwordHash).toMatch(/^\$argon2id\$/);expect(host.commandHash).toMatch(/^[0-9a-f]{64}$/);expect(Number((await database.query(`SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='hosts' AND column_name='create_password_hash'`)).rows[0].count)).toBe(0)}finally{await databaseResource.dispose()}});

When('another device creates a host while the account directory is open',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/app/account');
  await expect(page.locator('.page-header .eyebrow')).toHaveText('admin@aerstello.test');
  expect((await page.context().request.post('/api/v1/hosts',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),email:'realtime-host@aerstello.test',name:'Realtime Host',password:'RealtimeHost123!',role:'staff',language:'de'}})).status()).toBe(201);
});

Then('the new host appears after the committed authorization event',async({page})=>{const row=page.locator('.section-heading+.card .table-row').filter({hasText:'realtime-host@aerstello.test'});await expect(row).toBeVisible({timeout:10_000});await expect(row).toContainText('Realtime Host')});

Given('an authenticated staff host', async ({ page }) => {
  await signIn(page);
  const request=page.context().request;
  expect((await request.post('/api/v1/hosts',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),email:'room-staff@aerstello.test',name:'Room Staff',password:'RoomStaff123!',role:'staff',language:'de'}})).status()).toBe(201);
  expect((await request.post('/api/v1/auth/logout',{headers:csrfHeaders})).status()).toBe(204);
  expect((await request.post('/api/v1/auth/login',{data:{email:'room-staff@aerstello.test',password:'RoomStaff123!'}})).status()).toBe(200);
  await page.goto('/app');
});

Then('room management is absent from the navigation', async ({ page }) => { await expect(page.getByRole('link',{name:/^Zimmer$|^Camere$|^Rooms$/})).toHaveCount(0); });

Then('opening the room-management URL shows no mutation controls', async ({ page }) => { await page.goto('/app/rooms');await expect(page.locator('.notice--error')).toBeVisible();await expect(page.locator('.inline-form,.sortable-list')).toHaveCount(0); });

Then('opening the product-management URL shows no mutation controls', async ({ page }) => { await page.goto('/app/products');await expect(page.locator('.notice--error')).toBeVisible();await expect(page.locator('.inline-form,.product-admin-list')).toHaveCount(0); });

When('another administrator demotes an open host session to staff',async({resources, scenarioState, page,browser})=>{const workflow=stateFor(scenarioState);const request=page.context().request;const created=await (await request.post('/api/v1/hosts',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),email:'role-refresh@aerstello.test',name:'Role Refresh',password:'RoleRefresh123!',role:'admin',language:'en'}})).json() as {id:string;version:number};const context=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});workflow.roleChangedHostPage=await context.newPage();await workflow.roleChangedHostPage.goto('/login');await workflow.roleChangedHostPage.getByLabel('Email').fill('role-refresh@aerstello.test');await workflow.roleChangedHostPage.getByLabel('Password').fill('RoleRefresh123!');await workflow.roleChangedHostPage.getByRole('button',{name:'Sign in'}).click();await expect(workflow.roleChangedHostPage.getByRole('link',{name:'Rooms'})).toBeVisible();expect((await request.patch(`/api/v1/hosts/${created.id}`,{headers:csrfHeaders,data:{role:'staff',expectedVersion:created.version}})).status()).toBe(200)});

Then('administrator controls disappear from the affected session',async({ scenarioState })=>{const workflow=stateFor(scenarioState);await expect(workflow.roleChangedHostPage!.getByRole('link',{name:'Rooms'})).toHaveCount(0,{timeout:10_000});expect(((await (await workflow.roleChangedHostPage!.context().request.get('/api/v1/auth/me')).json()) as {host:{role:string}}).host.role).toBe('staff')});

When('a host disable response is lost before the account is re-enabled',async({resources, scenarioState, page,browser})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const created=await (await request.post('/api/v1/hosts',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),email:'stale-host@aerstello.test',name:'Stale Host',password:'StaleHostPassword123!',role:'staff',language:'de'}})).json() as {id:string;version:number};
  const staleCommand={active:false,expectedVersion:created.version};
  const disabled=await (await request.patch(`/api/v1/hosts/${created.id}`,{headers:csrfHeaders,data:staleCommand})).json() as {version:number};
  const enabled=await request.patch(`/api/v1/hosts/${created.id}`,{headers:csrfHeaders,data:{active:true,expectedVersion:disabled.version}});
  expect(enabled.status()).toBe(200);
  const context=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});
  expect((await context.request.post('/api/v1/auth/login',{data:{email:'stale-host@aerstello.test',password:'StaleHostPassword123!'}})).status()).toBe(200);
  workflow.staleHostUpdateStatus=(await request.patch(`/api/v1/hosts/${created.id}`,{headers:csrfHeaders,data:staleCommand})).status();
  workflow.reopenedHostSessionStatus=(await context.request.get('/api/v1/auth/me')).status();
  const hosts=await (await request.get('/api/v1/hosts')).json() as {data:{id:string;active:boolean}[]};
  workflow.staleHostFinalActive=hosts.data.find(item=>item.id===created.id)!.active;
});

Then('retrying the stale host disable is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleHostUpdateStatus).toBe(409)});

Then('the re-enabled host remains active and signed in',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleHostFinalActive).toBe(true);expect(workflow.reopenedHostSessionStatus).toBe(200)});
