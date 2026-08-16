import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { signIn } from '../authentication/sign-in';
import { test } from '../fixtures/test';
import { createBrowserContext } from '../support/browser-context';
import { connectDatabase } from '../support/database';
import { registerRoute } from '../support/network-route';
import { csrfHeaders } from '../support/operational-api-data';
import { stateFor } from './access-request.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

Given('an authenticated administrator and a separate guest device',async({resources, guestDevice, page})=>{await signIn(page);await guestDevice.create();});

When('{string} requests access for room {string}',async({resources, guestDevice},name:string,room:string)=>{await guestDevice.page.goto('/guest/request');await guestDevice.page.locator('form select').nth(1).selectOption('de');await guestDevice.page.getByLabel('Name').fill(name);await guestDevice.page.locator('form select').first().selectOption({label:room});await guestDevice.page.locator('form button[type="submit"]').click()});

Then('the host sees the pending request for {string}',async({resources, guestDevice, page},name:string)=>{await page.goto('/app/requests');await expect(page.getByText(name,{exact:true})).toBeVisible()});

When('the host opens approval for {string}',async({resources, guestDevice, page},name:string)=>{const card=page.locator('.request-card').filter({hasText:name});await card.getByRole('button',{name:/Genehmigen|Approva|Approve/}).click()});

Then('creating a new guest is selected by default',async({resources, guestDevice, page})=>{await expect(page.locator('.modal select').first()).toHaveValue('new')});

When('approval guest directory data remains loading',async({resources, guestDevice, page})=>{
  const request=page.context().request;
  const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const room=bootstrap.rooms.find(item=>item.name==='102')!;
  expect((await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Approval Directory Guest',roomId:room.id,language:'de'}})).status()).toBe(201);
  await page.addInitScript(()=>{
    const originalFetch=window.fetch.bind(window);
    const state=window as unknown as {__aerstelloApprovalGuestDirectory:{release?:()=>void;attempts:number}};
    state.__aerstelloApprovalGuestDirectory={attempts:0};
    window.fetch=async(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(new URL(url,window.location.href).pathname==='/api/v1/guests'&&state.__aerstelloApprovalGuestDirectory.attempts===0){
        state.__aerstelloApprovalGuestDirectory.attempts+=1;
        await new Promise<void>((resolve)=>{state.__aerstelloApprovalGuestDirectory.release=resolve});
      }
      return originalFetch(input,init);
    };
  });
  await page.goto('/app/requests');
});

Then('approval is unavailable before the guest directory loads',async({resources, guestDevice, page})=>{
  const card=page.locator('.request-card').filter({hasText:'Approval Directory Guest'});
  await expect(card).toBeVisible();
  const approve=card.getByRole('button',{name:/Genehmigen|Approva|Approve/});
  await expect(approve).toBeDisabled();
  await expect(page.locator('.modal')).toHaveCount(0);
});

When('the approval guest directory finishes loading',async({resources, guestDevice, page})=>{
  await page.evaluate(()=>{
    const release=(window as unknown as {__aerstelloApprovalGuestDirectory:{release?:()=>void}}).__aerstelloApprovalGuestDirectory.release;
    if(!release)throw new Error('Approval guest directory was not pending');
    release();
  });
});

Then('the host can open approval with the loaded guest directory',async({resources, guestDevice, page})=>{
  const approve=page.locator('.request-card').filter({hasText:'Approval Directory Guest'}).getByRole('button',{name:/Genehmigen|Approva|Approve/});
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.locator('.modal select').first()).toHaveValue('new');
});

When('the host retries an approval after its first response is lost',async({resources, guestDevice, scenarioState, page})=>{const workflow=stateFor(scenarioState);await guestDevice.page.goto('/guest/request');await guestDevice.page.locator('form select').nth(1).selectOption('de');await guestDevice.page.getByLabel('Name').fill('Approval Retry');await guestDevice.page.locator('form select').first().selectOption({label:'102'});await guestDevice.page.locator('form button[type="submit"]').click();await page.goto('/app/requests');const card=page.locator('.request-card').filter({hasText:'Approval Retry'});await expect(card).toBeVisible();await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let loseResponse=true;const commands:Record<string,unknown>[]=[];Object.assign(window,{__aerstelloApprovalRetryCommands:commands});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/access-requests/')&&url.endsWith('/approve')&&init?.method==='POST'){commands.push(JSON.parse(String(init.body)) as Record<string,unknown>);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)}});await card.getByRole('button',{name:/Genehmigen|Approva|Approve/}).click();const modal=page.locator('.modal');await modal.getByRole('button',{name:/Genehmigen|Approva|Approve/}).click();await expect(modal.locator('.notice--error')).toBeVisible();workflow.uncertainApprovalFieldsLocked=await modal.locator('input,select').evaluateAll(fields=>fields.every(field=>(field as HTMLInputElement).disabled));await modal.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();await expect(modal).toHaveCount(0);const commands=await page.evaluate(()=>(window as unknown as {__aerstelloApprovalRetryCommands:Array<Record<string,unknown>>}).__aerstelloApprovalRetryCommands);workflow.retriedApprovalMutationIds=commands.map(command=>String(command.mutationId));const guests=await (await page.context().request.get('/api/v1/guests')).json() as {data:{name:string}[]};workflow.approvedGuestIdentityCount=guests.data.filter(guest=>guest.name==='Approval Retry').length});

Then('both approval attempts use the same mutation identifier',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedApprovalMutationIds).toHaveLength(2);expect(new Set(workflow.retriedApprovalMutationIds).size).toBe(1)});

Then('approval fields stay locked while the result is uncertain',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.uncertainApprovalFieldsLocked).toBe(true)});

Then('only one approved guest identity exists',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.approvedGuestIdentityCount).toBe(1)});

Then('the guest device receives access',async({resources, guestDevice})=>{await expect(guestDevice.page).toHaveURL(/\/guest$/,{timeout:10_000});await expect(guestDevice.page.getByRole('heading',{name:'Approval Retry'})).toBeVisible()});

When('the host approves the request for one day',async({resources, guestDevice, page})=>{await page.getByRole('button',{name:/Genehmigen|Approve/}).click();await page.locator('.modal').getByRole('button',{name:/Genehmigen|Approve/}).click()});

Then("the guest device opens Luca's guest view without a password",async({resources, guestDevice})=>{await expect(guestDevice.page).toHaveURL(/\/guest$/,{timeout:10000});await expect(guestDevice.page.getByRole('heading',{name:'Luca Rossi'})).toBeVisible()});

When('the guest retries an access request after its first response is lost',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  await guestDevice.page.goto('/guest/request');
  await guestDevice.page.locator('form select').nth(1).selectOption('de');
  await guestDevice.page.getByLabel('Name').fill('Retry Guest');
  await guestDevice.page.locator('form select').first().selectOption({label:'102'});
  await guestDevice.page.evaluate(()=>{
    const originalFetch=window.fetch.bind(window);let loseResponse=true;const ids:string[]=[];
    Object.assign(window,{__aerstelloAccessRequestRetryIds:ids});
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/public/access-requests')&&init?.method==='POST'){ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)};
  });
  await guestDevice.page.locator('form button[type="submit"]').click();
  await expect(guestDevice.page.locator('.notice--error')).toBeVisible();
  workflow.uncertainAccessRequestFieldsLocked=await guestDevice.page.locator('form input,form select').evaluateAll(fields=>fields.every(field=>(field as HTMLInputElement).disabled));
  await guestDevice.page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();
  await expect(guestDevice.page.locator('.request-wait')).toBeVisible();
  workflow.retriedAccessRequestMutationIds=await guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloAccessRequestRetryIds:string[]}).__aerstelloAccessRequestRetryIds);
});

Then('both access request attempts use the same mutation identifier',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedAccessRequestMutationIds).toHaveLength(2);expect(new Set(workflow.retriedAccessRequestMutationIds).size).toBe(1)});

Then('the uncertain access request fields stay locked for retry',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.uncertainAccessRequestFieldsLocked).toBe(true)});

Then('the host sees only one pending request from that guest',async({resources, guestDevice, page})=>{const requests=await (await page.context().request.get('/api/v1/access-requests')).json() as {data:{name:string}[]};const pendingAccessRequestCount=requests.data.filter((item)=>item.name==='Retry Guest').length;expect(pendingAccessRequestCount).toBe(1)});

When('the guest closes the pending request page',async({resources, guestDevice})=>{await guestDevice.closePage()});

Then('reopening the request restores the approved guest access',async({resources, guestDevice})=>{const guestPage=await guestDevice.reopen('/guest/request');await expect(guestPage).toHaveURL(/\/guest$/,{timeout:10_000});await expect(guestPage.getByRole('heading',{name:'Persistent Guest'})).toBeVisible()});

When('the host denies the request for {string}',async({resources, guestDevice, scenarioState, page},name:string)=>{const workflow=stateFor(scenarioState);let polls=0;guestDevice.page.on('request',request=>{if(request.url().includes('/api/v1/public/access-requests/')&&request.url().endsWith('/status'))polls+=1});const card=page.locator('.request-card').filter({hasText:name});await card.getByRole('button',{name:/Ablehnen|Rifiuta|Deny/}).click();await expect(guestDevice.page.locator('.request-wait').getByRole('heading')).toHaveText(/Ablehnen|Rifiuta|Deny/,{timeout:10_000});await guestDevice.page.waitForTimeout(500);const terminalCount=polls;await guestDevice.page.waitForTimeout(3_000);workflow.deniedPollCounts=[terminalCount,polls]});

Then('the denied guest device stops status polling',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.deniedPollCounts[1]).toBe(workflow.deniedPollCounts[0])});

When('the host retries a denial after its first response is lost',async({resources, guestDevice, scenarioState, page})=>{const workflow=stateFor(scenarioState);await guestDevice.page.goto('/guest/request');await guestDevice.page.locator('form select').nth(1).selectOption('de');await guestDevice.page.getByLabel('Name').fill('Denial Retry');await guestDevice.page.locator('form select').first().selectOption({label:'102'});await guestDevice.page.locator('form button[type="submit"]').click();await page.goto('/app/requests');const card=page.locator('.request-card').filter({hasText:'Denial Retry'});await expect(card).toBeVisible();await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let loseResponse=true;const commands:Record<string,unknown>[]=[];Object.assign(window,{__aerstelloDenialRetryCommands:commands});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/access-requests/')&&url.endsWith('/deny')&&init?.method==='POST'){commands.push(JSON.parse(String(init.body)) as Record<string,unknown>);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)}});await card.getByRole('button',{name:/Ablehnen|Rifiuta|Deny/}).click();const retry=page.getByRole('button',{name:/Erneut versuchen.*Denial Retry|Riprova.*Denial Retry|Retry.*Denial Retry/});await expect(retry).toBeVisible();await retry.click();await expect(retry).toHaveCount(0);const commands=await page.evaluate(()=>(window as unknown as {__aerstelloDenialRetryCommands:Array<Record<string,unknown>>}).__aerstelloDenialRetryCommands);workflow.retriedDenialMutationIds=commands.map(command=>String(command.mutationId));const databaseResource=await connectDatabase(resources);const database=databaseResource.client;try{workflow.deniedRequestCount=Number((await database.query("SELECT count(*) FROM access_requests WHERE name='Denial Retry' AND status='denied'")).rows[0].count)}finally{await databaseResource.dispose()}});

Then('both denial attempts use the same mutation identifier',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedDenialMutationIds).toHaveLength(2);expect(new Set(workflow.retriedDenialMutationIds).size).toBe(1)});

Then('the denied request remains resolved only once',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.deniedRequestCount).toBe(1)});

When('approved guest access expires before the requesting page exchanges it',async({resources, guestDevice, page})=>{await guestDevice.page.goto('/guest/request');const statusRoute=await registerRoute(resources,guestDevice.page,'**/api/v1/public/access-requests/*/status',route=>route.fulfill({json:{status:'pending',granted:false}}));await guestDevice.page.locator('form select').nth(1).selectOption('de');await guestDevice.page.getByLabel('Name').fill('Expired UI');await guestDevice.page.locator('form select').first().selectOption({label:'102'});await guestDevice.page.locator('form button[type="submit"]').click();await expect(guestDevice.page.locator('.request-wait')).toBeVisible();const pending=await (await page.context().request.get('/api/v1/access-requests')).json() as {data:{id:string;name:string}[]};const access=pending.data.find(item=>item.name==='Expired UI')!;expect((await page.context().request.post(`/api/v1/access-requests/${access.id}/approve`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expiresAt:new Date(Date.now()+1_200).toISOString()}})).status()).toBe(200);await guestDevice.page.waitForTimeout(1_300);await statusRoute.dispose()});

Then('the requesting page explains that access expired',async({resources, guestDevice})=>{await expect(guestDevice.page.getByRole('heading',{name:'Zugang abgelaufen'})).toBeVisible({timeout:10_000});await expect(guestDevice.page.getByText('Der genehmigte Gastzugang ist abgelaufen.')).toBeVisible()});

When('an approved linked guest is disabled before exchange',async({resources, guestDevice, page})=>{await guestDevice.page.getByRole('button',{name:'Zugang anfragen'}).click();const statusRoute=await registerRoute(resources,guestDevice.page,'**/api/v1/public/access-requests/*/status',route=>route.fulfill({json:{status:'pending',granted:false}}));await guestDevice.page.getByLabel('Name').fill('Disabled UI');await guestDevice.page.locator('form button[type="submit"]').click();await expect(guestDevice.page.locator('.request-wait')).toBeVisible();const request=page.context().request;const pending=await (await request.get('/api/v1/access-requests')).json() as {data:{id:string;name:string}[]};const access=pending.data.find(item=>item.name==='Disabled UI')!;const approved=await (await request.post(`/api/v1/access-requests/${access.id}/approve`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expiresAt:new Date(Date.now()+86_400_000).toISOString()}})).json() as {guestId:string};const guests=await (await request.get('/api/v1/guests')).json() as {data:{id:string;version:number}[]};const guest=guests.data.find(item=>item.id===approved.guestId)!;expect((await request.delete(`/api/v1/guests/${guest.id}`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedVersion:guest.version}})).status()).toBe(204);await statusRoute.dispose()});

Then('the requesting page explains that access is disabled',async({resources, guestDevice})=>{await expect(guestDevice.page.getByRole('heading',{name:'Zugang deaktiviert'})).toBeVisible({timeout:10_000});await expect(guestDevice.page.getByText('Der zugeordnete Gastzugang wurde deaktiviert.')).toBeVisible()});

When('a host in a non-UTC timezone opens a guest approval',async({resources, guestDevice, scenarioState, page,browser})=>{const workflow=stateFor(scenarioState);const request=page.context().request;const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};const room=bootstrap.rooms.find(item=>item.name==='102')!;expect((await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Local expiry guest',roomId:room.id,language:'de'}})).status()).toBe(201);const context=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL,timezoneId:'Pacific/Kiritimati'});const localPage=await context.newPage();await signIn(localPage);await localPage.goto('/app/requests');const card=localPage.locator('.request-card').filter({hasText:'Local expiry guest'});await card.getByRole('button',{name:/Genehmigen|Approva|Approve/}).click();workflow.approvalDefaultLifetimeHours=await localPage.locator('input[type="datetime-local"]').evaluate((input:HTMLInputElement)=>(new Date(input.value).getTime()-Date.now())/3_600_000)});

Then('the approval expiry is one local day from now',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.approvalDefaultLifetimeHours).toBeGreaterThan(23.9);expect(workflow.approvalDefaultLifetimeHours).toBeLessThan(24.1)});

Then('the request queue shows a localized failure instead of an empty state',async({resources, guestDevice, page})=>{
  await expect(page.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/);
  await expect(page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();
  await expect(page.getByText(/Noch keine Einträge|Nessun elemento|Nothing here yet/)).toHaveCount(0);
});

When('the host retries the request queue',async({resources, guestDevice, page})=>{
  const retry=page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/});
  await retry.evaluate((button)=>button.addEventListener('click',()=>{
    (window as unknown as {__aerstelloRequestQueueOutage:{active:boolean}}).__aerstelloRequestQueueOutage.active=false;
  },{capture:true,once:true}));
  await retry.click();
});

Then('the pending request appears after request queue recovery',async({resources, guestDevice, page})=>{
  await expect(page.locator('.request-card').filter({hasText:'Retry Queue Guest'})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {__aerstelloRequestQueueOutage:{attempts:number}}).__aerstelloRequestQueueOutage.attempts)).toBeGreaterThanOrEqual(2);
});
