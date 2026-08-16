import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { csrfHeaders,operationalData } from '../support/operational-api-data';
import { stateFor } from './guests.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('the host retries guest creation after its first response is lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await page.goto('/app/guests');await page.getByRole('button',{name:/Hinzufügen|Aggiungi|Add/}).first().click();const modal=page.locator('.modal');await modal.getByLabel('Name').fill('Recoverable guest');await modal.getByLabel(/Zimmer|Camere|Rooms/).selectOption({label:'101'});await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let loseResponse=true;const commands:Record<string,unknown>[]=[];Object.assign(window,{__aerstelloGuestCreateCommands:commands});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/guests')&&init?.method==='POST'){commands.push(JSON.parse(String(init.body)) as Record<string,unknown>);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)}});await modal.getByRole('button',{name:/Speichern|Salva|Save/}).click();await expect(modal.locator('.notice--error')).toBeVisible();workflow.uncertainGuestFieldsLocked=await modal.locator('input,select').evaluateAll(fields=>fields.every(field=>(field as HTMLInputElement).disabled));await modal.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();await expect(modal).toHaveCount(0);const commands=await page.evaluate(()=>(window as unknown as {__aerstelloGuestCreateCommands:Array<Record<string,unknown>>}).__aerstelloGuestCreateCommands);workflow.retriedGuestCreationMutationIds=commands.map(command=>String(command.mutationId));const guests=await (await page.context().request.get('/api/v1/guests')).json() as {data:{name:string}[]};workflow.recoverableGuestCount=guests.data.filter(guest=>guest.name==='Recoverable guest').length;workflow.changedGuestCreationReplayStatus=(await page.context().request.post('/api/v1/guests',{headers:csrfHeaders,data:{...commands[0]!,name:'Changed recoverable guest'}})).status()});

Then('both guest creation attempts use the same mutation identifier',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedGuestCreationMutationIds).toHaveLength(2);expect(new Set(workflow.retriedGuestCreationMutationIds).size).toBe(1)});

Then('the uncertain guest fields stay locked for retry',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.uncertainGuestFieldsLocked).toBe(true)});

Then('only one recoverable guest exists',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.recoverableGuestCount).toBe(1)});

Then('changing the replayed guest creation is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.changedGuestCreationReplayStatus).toBe(409)});

When('the host tries to close a guest creation whose response was lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  await page.goto('/app/guests');
  await page.getByRole('button',{name:/Hinzufügen|Aggiungi|Add/}).first().click();
  const modal=page.locator('.modal');
  await modal.getByLabel('Name').fill('Locked guest creation');
  await modal.getByLabel(/Zimmer|Camere|Rooms/).selectOption({label:'101'});
  await page.evaluate(()=>{
    const originalFetch=window.fetch.bind(window);let loseResponse=true;
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/guests')&&init?.method==='POST'){const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)};
  });
  await modal.getByRole('button',{name:/Speichern|Salva|Save/}).click();
  await expect(modal.locator('.notice--error')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal.locator('.icon-button')).toBeDisabled();
  await expect(modal.getByRole('button',{name:/Abbrechen|Annulla|Cancel/})).toBeDisabled();
  workflow.uncertainGuestCreationStayedOpen=await modal.isVisible();
  await modal.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();
  await expect(modal).toHaveCount(0);
});

Then('the uncertain guest creation remains open for retry',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.uncertainGuestCreationStayedOpen).toBe(true)});

When('the host retries guest creation after a committed HTTP timeout',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await page.goto('/app/guests');await page.getByRole('button',{name:/Hinzufügen|Aggiungi|Add/}).first().click();const modal=page.locator('.modal');await modal.getByLabel('Name').fill('Timed out guest');await modal.getByLabel(/Zimmer|Camere|Rooms/).selectOption({label:'101'});await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let returnTimeout=true;const commands:Record<string,unknown>[]=[];Object.assign(window,{__aerstelloGuestCreateCommands:commands});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/guests')&&init?.method==='POST'){commands.push(JSON.parse(String(init.body)) as Record<string,unknown>);const response=await originalFetch(input,init);if(returnTimeout){returnTimeout=false;return new Response(JSON.stringify({error:{code:'REQUEST_TIMEOUT',message:'The upstream response timed out.'}}),{status:408,headers:{'content-type':'application/json'}})}return response}return originalFetch(input,init)}});await modal.getByRole('button',{name:/Speichern|Salva|Save/}).click();await expect(modal.locator('.notice--error')).toBeVisible();await modal.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();await expect(modal).toHaveCount(0);const commands=await page.evaluate(()=>(window as unknown as {__aerstelloGuestCreateCommands:Array<Record<string,unknown>>}).__aerstelloGuestCreateCommands);workflow.retriedGuestCreationMutationIds=commands.map(command=>String(command.mutationId));const guests=await (await page.context().request.get('/api/v1/guests')).json() as {data:{name:string}[]};workflow.recoverableGuestCount=guests.data.filter(guest=>guest.name==='Timed out guest').length});

Then('both timed-out guest creations use the same mutation identifier',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedGuestCreationMutationIds).toHaveLength(2);expect(new Set(workflow.retriedGuestCreationMutationIds).size).toBe(1)});

Then('only one timed-out guest exists',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.recoverableGuestCount).toBe(1)});

When('the host creates guest {string} in room {string}',async({page},name:string,room:string)=>{await page.goto('/app/guests');await page.getByRole('button',{name:/Hinzufügen/}).click();await page.locator('.modal').getByLabel('Name').fill(name);await page.locator('.modal').getByLabel('Zimmer').selectOption({label:room});await page.locator('.modal').getByRole('button',{name:'Speichern'}).click()});

Then('guest {string} is listed in room {string}',async({page},name:string,room:string)=>{const row=page.locator('.table-row').filter({hasText:name});await expect(row).toContainText(room)});

When('the guest directory fails to load',async({page})=>{
  await page.addInitScript(()=>{
    const originalFetch=window.fetch.bind(window);
    const state=window as unknown as {__aerstelloGuestDirectoryOutage:{active:boolean;attempts:number}};
    state.__aerstelloGuestDirectoryOutage={active:true,attempts:0};
    window.fetch=async(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(new URL(url,window.location.href).pathname==='/api/v1/guests'){
        state.__aerstelloGuestDirectoryOutage.attempts+=1;
        if(state.__aerstelloGuestDirectoryOutage.active)return new Response(JSON.stringify({error:{code:'SERVICE_UNAVAILABLE',message:'Simulated guest directory outage'}}),{status:503,headers:{'content-type':'application/json'}});
      }
      return originalFetch(input,init);
    };
  });
  await page.goto('/app/guests');
});

Then('the guest directory failure is localized instead of empty',async({page})=>{
  await expect(page.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/);
  await expect(page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();
  await expect(page.locator('.empty')).toHaveCount(0);
  await expect(page.locator('.table-row')).toHaveCount(0);
});

When('the host retries the guest directory',async({page})=>{
  const retry=page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/});
  await retry.evaluate((button)=>button.addEventListener('click',()=>{
    (window as unknown as {__aerstelloGuestDirectoryOutage:{active:boolean}}).__aerstelloGuestDirectoryOutage.active=false;
  },{capture:true,once:true}));
  await retry.click();
});

Then('existing guests appear after guest directory recovery',async({page})=>{
  await expect(page.locator('.table-row').filter({hasText:'Anna Berger'})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {__aerstelloGuestDirectoryOutage:{attempts:number}}).__aerstelloGuestDirectoryOutage.attempts)).toBeGreaterThanOrEqual(2);
});

When('a guest update response is lost before another host edits the guest',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);const request=page.context().request;const guests=await (await request.get('/api/v1/guests')).json() as {data:{id:string;name:string;roomId:string;language:string;version:number}[]};const original=guests.data.find(guest=>guest.name==='Anna Berger')!;const command={name:'First guest edit',roomId:original.roomId,language:original.language,expectedVersion:original.version};const committed=await (await request.patch(`/api/v1/guests/${original.id}`,{headers:csrfHeaders,data:command})).json() as {version:number};expect((await request.patch(`/api/v1/guests/${original.id}`,{headers:csrfHeaders,data:{...command,name:'Newer guest edit',expectedVersion:committed.version}})).status()).toBe(200);workflow.staleGuestUpdateStatus=(await request.patch(`/api/v1/guests/${original.id}`,{headers:csrfHeaders,data:command})).status();const finalGuests=await (await request.get('/api/v1/guests')).json() as {data:{id:string;name:string}[]};workflow.staleGuestFinalName=finalGuests.data.find(guest=>guest.id===original.id)!.name});

Then('retrying the stale guest update is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleGuestUpdateStatus).toBe(409)});

Then('the newer guest name remains configured',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleGuestFinalName).toBe('Newer guest edit')});

When('a guest receives an order while their archive confirmation is open',async({page})=>{await page.goto('/app/guests');await page.getByRole('button',{name:/Entfernen Anna Berger|Rimuovi Anna Berger|Remove Anna Berger/}).click();const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;expect((await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).status()).toBe(201);await page.locator('.modal').getByRole('button',{name:/Entfernen|Rimuovi|Remove/}).click()});

Then('the archive confirmation explains that the order must be settled',async({page})=>{await expect(page.locator('.modal .notice--error')).toContainText(/offene Bestellung|ordine aperto|open order/i)});

When('the host retries guest archival after its response is lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const rooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;name:string}[]};
  const guest=await (await request.post('/api/v1/guests',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:'Recoverable archive guest',roomId:rooms.data.find(room=>room.name==='102')!.id,language:'de'}})).json() as {id:string;version:number};
  await page.goto('/app/guests');
  await page.getByRole('button',{name:/Entfernen Recoverable archive guest|Rimuovi Recoverable archive guest|Remove Recoverable archive guest/}).click();
  await page.evaluate((guestId)=>{const originalFetch=window.fetch.bind(window);let loseResponse=true;const commands:Record<string,unknown>[]=[];Object.assign(window,{__aerstelloGuestArchiveCommands:commands});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith(`/api/v1/guests/${guestId}`)&&init?.method==='DELETE'){commands.push(JSON.parse(String(init.body)) as Record<string,unknown>);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)}},guest.id);
  const modal=page.locator('.modal');
  await modal.getByRole('button',{name:/Entfernen|Rimuovi|Remove/}).click();
  await expect(modal.locator('.notice--error')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal.locator('.icon-button')).toBeDisabled();
  await expect(modal.getByRole('button',{name:/Abbrechen|Annulla|Cancel/})).toBeDisabled();
  workflow.uncertainGuestArchiveStayedOpen=await modal.isVisible();
  await modal.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();
  await expect(modal).toHaveCount(0);
  const commands=await page.evaluate(()=>(window as unknown as {__aerstelloGuestArchiveCommands:Array<Record<string,unknown>>}).__aerstelloGuestArchiveCommands);
  workflow.retriedGuestArchiveMutationIds=commands.map(command=>String(command.mutationId));
  const guests=await (await request.get('/api/v1/guests')).json() as {data:{id:string}[]};
  workflow.archivedGuestCount=guests.data.filter(item=>item.id===guest.id).length;
});

Then('both guest archival attempts use the same mutation identifier',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedGuestArchiveMutationIds).toHaveLength(2);expect(new Set(workflow.retriedGuestArchiveMutationIds).size).toBe(1)});

Then('the uncertain guest archival cannot be closed',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.uncertainGuestArchiveStayedOpen).toBe(true)});

Then('the guest is archived only once',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.archivedGuestCount).toBe(0)});

When('another host edits a guest before a stale archival arrives',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const rooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;name:string}[]};
  const guest=await (await request.post('/api/v1/guests',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:'Stale archive guest',roomId:rooms.data.find(room=>room.name==='102')!.id,language:'de'}})).json() as {id:string;name:string;roomId:string;language:string;version:number};
  expect((await request.patch(`/api/v1/guests/${guest.id}`,{headers:csrfHeaders,data:{name:'Newer archive guest',roomId:guest.roomId,language:guest.language,expectedVersion:guest.version}})).status()).toBe(200);
  workflow.staleGuestArchiveStatus=(await request.delete(`/api/v1/guests/${guest.id}`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedVersion:guest.version}})).status();
  const guests=await (await request.get('/api/v1/guests')).json() as {data:{id:string;name:string}[]};
  workflow.staleGuestArchiveFinalName=guests.data.find(item=>item.id===guest.id)?.name??'';
});

Then('the stale guest archival is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleGuestArchiveStatus).toBe(409)});

Then("the guest's newer edit remains configured",async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleGuestArchiveFinalName).toBe('Newer archive guest')});

When('guest archival races with a new order',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);const {request,me,products}=await operationalData(page);const rooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;name:string}[]};const product=products.data.find((item)=>item.name.de==='Helles')!;workflow.guestArchiveRaceStatuses=[];for(let attempt=0;attempt<8;attempt+=1){const guest=await (await request.post('/api/v1/guests',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:`Race guest ${attempt}`,roomId:rooms.data.find((room)=>room.name==='102')!.id,language:'de'}})).json() as {id:string;version:number};const [archive,order]=await Promise.all([request.delete(`/api/v1/guests/${guest.id}`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedVersion:guest.version}}),request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})]);workflow.guestArchiveRaceStatuses.push([archive.status(),order.status()])}});

Then('either the archive or the order is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);for(const [archive,order] of workflow.guestArchiveRaceStatuses){expect([[204,404],[409,201]]).toContainEqual([archive,order])}});
