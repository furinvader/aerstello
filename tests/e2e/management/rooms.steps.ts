import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { csrfHeaders } from '../support/operational-api-data';
import { installQueryOutage,releaseQueryOutage,restoreQueryOutage,retryQueryOutage } from '../support/query-outage';
import { stateFor } from './rooms.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('room management remains pending',async({page})=>{
  await installQueryOutage(page,['/api/v1/rooms']);
  await page.goto('/app/rooms');
});

Then('room loading hides empty and mutation controls',async({page})=>{
  await expect(page.getByText(/Wird geladen|Caricamento|Loading/)).toBeVisible();
  await expect(page.locator('.empty,.two-column,.inline-form,.sortable-list')).toHaveCount(0);
  await expect(page.getByPlaceholder(/Zimmername|Nome camera|Room name/)).toHaveCount(0);
});

When('the pending room directory request fails',async({page})=>{await releaseQueryOutage(page)});

Then('room failure and retry are localized without mutation controls',async({page})=>{
  await expect(page.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/);
  await expect(page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();
  await expect(page.locator('.empty,.two-column,.inline-form,.sortable-list')).toHaveCount(0);
});

When('the administrator retries the room directory',async({page})=>{
  await retryQueryOutage(page,page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}));
});

Then('recovered rooms and room mutation controls appear',async({page})=>{
  await expect(page.getByText('101',{exact:true})).toBeVisible();
  await expect(page.getByPlaceholder(/Zimmername|Nome camera|Room name/)).toBeEnabled();
  await expect(page.locator('.sortable-list')).toBeVisible();
  await expect(page.getByRole('button',{name:/Archiv.*101|Archivia.*101|Archive.*101/})).toBeVisible();
  await restoreQueryOutage(page);
});

When('the administrator creates room {string}',async({page},name:string)=>{await page.goto('/app/rooms');await page.getByPlaceholder(/Zimmername|Nome camera|Room name/).fill(name);await page.locator('.inline-form').getByRole('button').click()});

Then('room {string} is listed',async({page},name:string)=>{await expect(page.getByText(name,{exact:true})).toBeVisible()});

When('the administrator renames room {string} to {string}',async({page},oldName:string,newName:string)=>{const row=page.locator('.sortable-list>div').filter({hasText:oldName});await row.getByRole('button').nth(2).click();await page.locator('.modal input').fill(newName);await page.locator('.modal').getByRole('button',{name:'Speichern'}).click()});

When('the administrator submits an invalid room rename',async({page})=>{await page.goto('/app/rooms');const row=page.locator('.sortable-list>div').filter({hasText:'101'});await row.getByRole('button').nth(2).click();await page.locator('.modal input').fill('   ');await page.locator('.modal').getByRole('button',{name:/Speichern|Salva|Save/}).click()});

Then('the room editor shows a validation error',async({page})=>{await expect(page.locator('.modal .notice--error')).toContainText(/Eingaben prüfen|dati inseriti|entered information/)});

When('a room rename response is lost before another administrator renames it',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);const request=page.context().request;const rooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;name:string;version:number}[]};const original=rooms.data.find(room=>room.name==='101')!;const command={name:'First room rename',expectedVersion:original.version};const committed=await (await request.patch(`/api/v1/rooms/${original.id}`,{headers:csrfHeaders,data:command})).json() as {version:number};expect((await request.patch(`/api/v1/rooms/${original.id}`,{headers:csrfHeaders,data:{name:'Newer room rename',expectedVersion:committed.version}})).status()).toBe(200);workflow.staleRoomUpdateStatus=(await request.patch(`/api/v1/rooms/${original.id}`,{headers:csrfHeaders,data:command})).status();const finalRooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;name:string}[]};workflow.staleRoomFinalName=finalRooms.data.find(room=>room.id===original.id)!.name});

Then('retrying the stale room rename is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleRoomUpdateStatus).toBe(409)});

Then('the newer room name remains configured',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleRoomFinalName).toBe('Newer room rename')});

When('the administrator retries room creation after its first response is lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await page.goto('/app/rooms');await page.getByPlaceholder(/Zimmername|Nome camera|Room name/).fill('Recoverable room');await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let loseResponse=true;const commands:Record<string,unknown>[]=[];Object.assign(window,{__aerstelloRoomCreateCommands:commands});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/rooms')&&init?.method==='POST'){commands.push(JSON.parse(String(init.body)) as Record<string,unknown>);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)}});await page.locator('.inline-form').getByRole('button').click();await expect(page.locator('.notice--error')).toBeVisible();workflow.uncertainRoomFieldsLocked=await page.getByPlaceholder(/Zimmername|Nome camera|Room name/).isDisabled();await page.locator('.inline-form').getByRole('button').click();await expect(page.getByText('Recoverable room',{exact:true})).toBeVisible();const commands=await page.evaluate(()=>(window as unknown as {__aerstelloRoomCreateCommands:Array<Record<string,unknown>>}).__aerstelloRoomCreateCommands);workflow.retriedRoomMutationIds=commands.map(command=>String(command.mutationId));const rooms=await (await page.context().request.get('/api/v1/rooms')).json() as {data:{name:string}[]};workflow.recoverableRoomCount=rooms.data.filter(room=>room.name==='Recoverable room').length;workflow.changedRoomCreationReplayStatus=(await page.context().request.post('/api/v1/rooms',{headers:csrfHeaders,data:{...commands[0]!,name:'Changed recoverable room'}})).status()});

Then('both room creation attempts use the same mutation identifier',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedRoomMutationIds).toHaveLength(2);expect(new Set(workflow.retriedRoomMutationIds).size).toBe(1)});

Then('the uncertain room name stays locked for retry',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.uncertainRoomFieldsLocked).toBe(true)});

Then('only one recoverable room exists',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.recoverableRoomCount).toBe(1)});

Then('changing the replayed room creation is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.changedRoomCreationReplayStatus).toBe(409)});

When('the host attempts to create a guest in an archived room',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);const request=page.context().request;const room=await (await request.post('/api/v1/rooms',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:'Archived room'}})).json() as {id:string;version:number};expect((await request.delete(`/api/v1/rooms/${room.id}`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedVersion:room.version}})).status()).toBe(204);workflow.archivedRoomGuestStatus=(await request.post('/api/v1/guests',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:'Late guest',roomId:room.id,language:'de'}})).status()});

Then('the archived room guest is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.archivedRoomGuestStatus).toBe(404)});

When('the administrator archives a room with a pending access request',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);const request=page.context().request;const room=await (await request.post('/api/v1/rooms',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:'Pending request room'}})).json() as {id:string};const pending=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Waiting guest',roomId:room.id,language:'de'}})).json() as {id:string};await page.goto('/app/rooms');const response=page.waitForResponse(candidate=>candidate.url().endsWith(`/api/v1/rooms/${room.id}`)&&candidate.request().method()==='DELETE');await page.getByRole('button',{name:/Pending request room/}).click();workflow.pendingRoomArchiveStatus=(await response).status();const requests=await (await request.get('/api/v1/access-requests')).json() as {data:{id:string}[]};workflow.pendingRoomRequestCount=requests.data.filter(item=>item.id===pending.id).length});

Then('room archival is rejected and the request remains pending',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);expect(workflow.pendingRoomArchiveStatus).toBe(409);expect(workflow.pendingRoomRequestCount).toBe(1);await expect(page.locator('.notice--error')).toContainText(/ausstehenden Zugangsanfragen|richieste di accesso in sospeso|pending access requests/)});

When('the administrator archives a room with an active guest',async({page})=>{await page.goto('/app/rooms');const response=page.waitForResponse(candidate=>candidate.url().includes('/api/v1/rooms/')&&candidate.request().method()==='DELETE');await page.getByRole('button',{name:/101/}).click();expect((await response).status()).toBe(409)});

Then('the room screen explains that active guests must be moved',async({page})=>{await expect(page.locator('.notice--error')).toContainText(/aktiven Gäste.*anderes Zimmer|ospiti attivi.*camera|active guests.*another room/)});

When('the administrator retries room archival after its response is lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const room=await (await request.post('/api/v1/rooms',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:'Recoverable archive room'}})).json() as {id:string;version:number};
  await page.goto('/app/rooms');
  await page.evaluate((roomId)=>{const originalFetch=window.fetch.bind(window);let loseResponse=true;const commands:Record<string,unknown>[]=[];Object.assign(window,{__aerstelloRoomArchiveCommands:commands});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith(`/api/v1/rooms/${roomId}`)&&init?.method==='DELETE'){commands.push(JSON.parse(String(init.body)) as Record<string,unknown>);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)}},room.id);
  await page.getByRole('button',{name:/Archiv Recoverable archive room|Archivio Recoverable archive room|Archive Recoverable archive room/}).click();
  const retry=page.getByRole('button',{name:/Erneut versuchen.*Recoverable archive room|Riprova.*Recoverable archive room|Retry.*Recoverable archive room/});
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(retry).toHaveCount(0);
  const commands=await page.evaluate(()=>(window as unknown as {__aerstelloRoomArchiveCommands:Array<Record<string,unknown>>}).__aerstelloRoomArchiveCommands);
  workflow.retriedRoomArchiveMutationIds=commands.map(command=>String(command.mutationId));
  const rooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string}[]};
  workflow.archivedRoomCount=rooms.data.filter(item=>item.id===room.id).length;
});

Then('both room archival attempts use the same mutation identifier',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedRoomArchiveMutationIds).toHaveLength(2);expect(new Set(workflow.retriedRoomArchiveMutationIds).size).toBe(1)});

Then('the room is archived only once',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.archivedRoomCount).toBe(0)});

When('another administrator renames a room before a stale archival arrives',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const room=await (await request.post('/api/v1/rooms',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:'Stale archive room'}})).json() as {id:string;version:number};
  expect((await request.patch(`/api/v1/rooms/${room.id}`,{headers:csrfHeaders,data:{name:'Newer archive room',expectedVersion:room.version}})).status()).toBe(200);
  workflow.staleRoomArchiveStatus=(await request.delete(`/api/v1/rooms/${room.id}`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedVersion:room.version}})).status();
  const rooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;name:string}[]};
  workflow.staleRoomArchiveFinalName=rooms.data.find(item=>item.id===room.id)?.name??'';
});

Then('the stale room archival is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleRoomArchiveStatus).toBe(409)});

Then("the room's newer name remains configured",async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleRoomArchiveFinalName).toBe('Newer archive room')});

When('administrators submit conflicting room orders concurrently',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);const request=page.context().request;workflow.concurrentRoomOrderStatuses=[];for(let attempt=0;attempt<8;attempt+=1){const current=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;version:number}[]};const [a,b,c]=current.data;const versions=new Map(current.data.map(room=>[room.id,room.version]));const command=(ids:string[])=>({rooms:ids.map(id=>({id,expectedVersion:versions.get(id)!}))});const responses=await Promise.all([request.put('/api/v1/rooms/order',{headers:csrfHeaders,data:command([b!.id,a!.id,c!.id])}),request.put('/api/v1/rooms/order',{headers:csrfHeaders,data:command([a!.id,c!.id,b!.id])})]);workflow.concurrentRoomOrderStatuses.push(...responses.map(response=>response.status()))}});

Then('every room reorder completes without a server error',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.concurrentRoomOrderStatuses).toHaveLength(16);for(let index=0;index<workflow.concurrentRoomOrderStatuses.length;index+=2)expect(workflow.concurrentRoomOrderStatuses.slice(index,index+2).sort()).toEqual([200,409])});

When('a room reorder response is lost before another administrator reorders rooms',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);const request=page.context().request;const original=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;version:number}[]};const [a,b,c]=original.data;const command=(ids:string[],rooms:{id:string;version:number}[])=>({rooms:ids.map(id=>({id,expectedVersion:rooms.find(room=>room.id===id)!.version}))});const staleCommand=command([b!.id,a!.id,c!.id],original.data);expect((await request.put('/api/v1/rooms/order',{headers:csrfHeaders,data:staleCommand})).status()).toBe(200);const afterFirst=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;version:number}[]};workflow.expectedRoomOrderFinalIds=[c!.id,b!.id,a!.id];expect((await request.put('/api/v1/rooms/order',{headers:csrfHeaders,data:command(workflow.expectedRoomOrderFinalIds,afterFirst.data)})).status()).toBe(200);workflow.staleRoomOrderStatus=(await request.put('/api/v1/rooms/order',{headers:csrfHeaders,data:staleCommand})).status();workflow.staleRoomOrderFinalIds=((await (await request.get('/api/v1/rooms')).json()) as {data:{id:string}[]}).data.map(room=>room.id)});

Then('retrying the stale room reorder is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleRoomOrderStatus).toBe(409)});

Then('the newer room order remains configured',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleRoomOrderFinalIds).toEqual(workflow.expectedRoomOrderFinalIds)});
