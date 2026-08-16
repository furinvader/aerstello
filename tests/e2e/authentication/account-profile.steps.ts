import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { createBrowserContext } from '../support/browser-context';
import { csrfHeaders } from '../support/operational-api-data';
import { stateFor } from './account-profile.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('a profile save response is lost before another device edits the profile',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  await page.goto('/app/account');
  await page.getByLabel(/Name|Nome/).first().fill('First profile save');
  await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let loseResponse=true;const commands:Record<string,unknown>[]=[];Object.assign(window,{__aerstelloProfileCommands:commands});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/account')&&init?.method==='PATCH'){commands.push(JSON.parse(String(init.body)) as Record<string,unknown>);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)}});
  await page.getByRole('button',{name:/Speichern|Salva|Save/}).first().click();
  await expect(page.locator('.notice--error')).toBeVisible();
  workflow.uncertainProfileFieldsLocked=await page.locator('form.stack').first().locator('input,select').evaluateAll(fields=>fields.every(field=>(field as HTMLInputElement).disabled));
  const request=page.context().request;const current=await (await request.get('/api/v1/auth/me')).json() as {host:{version:number;language:string}};
  expect((await request.patch('/api/v1/account',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedVersion:current.host.version,name:'Newer device profile',language:current.host.language}})).status()).toBe(200);
  await page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).first().click();
  await expect(page.locator('.notice--success')).toBeVisible();
  workflow.retriedProfileMutationIds=(await page.evaluate(()=>(window as unknown as {__aerstelloProfileCommands:Array<Record<string,unknown>>}).__aerstelloProfileCommands)).map(command=>String(command.mutationId));
  workflow.finalProfileName=((await (await request.get('/api/v1/auth/me')).json()) as {host:{name:string}}).host.name;
});

Then('both profile save attempts use the same mutation identifier',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedProfileMutationIds).toHaveLength(2);expect(new Set(workflow.retriedProfileMutationIds).size).toBe(1)});

Then('the uncertain profile fields stay locked for retry',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.uncertainProfileFieldsLocked).toBe(true)});

Then('the newer profile remains configured',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);expect(workflow.finalProfileName).toBe('Newer device profile');await expect(page.getByLabel(/Name|Nome/).first()).toHaveValue('Newer device profile')});

When('the host selects Italian on an English-locale device',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);expect(await page.evaluate(()=>navigator.language)).toMatch(/^en/);await page.goto('/app/account');await expect(page.getByText('Dieses Gerät')).toBeVisible();const payload=await (await page.context().request.get('/api/v1/account/sessions')).json() as {data:{lastSeenAt:string;current:boolean}[]};const lastSeenAt=payload.data.find(session=>session.current)!.lastSeenAt;workflow.expectedItalianSessionTimestamp=await page.evaluate(value=>new Date(value).toLocaleString('it'),lastSeenAt);await page.getByLabel('Sprache').selectOption('it');await page.getByRole('button',{name:'Speichern'}).click()});

Then('the last-active timestamp uses Italian formatting',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);const current=page.locator('.device-list>div').filter({hasText:'Questo dispositivo'});await expect(current).toContainText(`Ultima attività ${workflow.expectedItalianSessionTimestamp}`)});

When('the administrator changes the password with another device logged in',async({resources, scenarioState, page,browser})=>{const workflow=stateFor(scenarioState);
  const other=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});
  expect((await other.request.post('/api/v1/auth/login',{data:{email:'admin@aerstello.test',password:'AerstelloTest123!'}})).status()).toBe(200);
  const me=await (await page.context().request.get('/api/v1/auth/me')).json() as {host:{version:number}};
  expect((await page.context().request.patch('/api/v1/account',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedVersion:me.host.version,currentPassword:'AerstelloTest123!',newPassword:'ChangedPassword123!'}})).status()).toBe(200);
  workflow.currentDeviceAfterPasswordChangeStatus=(await page.context().request.get('/api/v1/auth/me')).status();
  workflow.otherDeviceAfterPasswordChangeStatus=(await other.request.get('/api/v1/auth/me')).status();
  const fresh=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});
  workflow.newPasswordLoginStatus=(await fresh.request.post('/api/v1/auth/login',{data:{email:'admin@aerstello.test',password:'ChangedPassword123!'}})).status();
});

Then('the password change keeps the current device and revokes the other device',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.currentDeviceAfterPasswordChangeStatus).toBe(200);expect(workflow.otherDeviceAfterPasswordChangeStatus).toBe(401)});

Then('the new password can be used to sign in',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.newPasswordLoginStatus).toBe(200)});

When('the administrator submits an incorrect current password',async({page})=>{await page.goto('/app/account');await page.getByLabel(/Aktuelles Passwort|Password attuale|Current password/).fill('IncorrectPassword123!');await page.getByLabel(/Neues Passwort|Nuova password|New password/).fill('ReplacementPassword123!');await page.getByRole('button',{name:/Speichern|Salva|Save/}).click()});

Then('the account screen shows the localized password error',async({page})=>{await expect(page.locator('.notice--error')).toContainText('Das aktuelle Passwort ist falsch.')});
