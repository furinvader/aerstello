import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { createBrowserContext } from '../support/browser-context';
import { csrfHeaders,operationalData } from '../support/operational-api-data';
import { stateFor } from './authorization.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('guest archival races with their first grant exchange',async({resources, scenarioState, page,browser})=>{const workflow=stateFor(scenarioState);const request=page.context().request;const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};const room=bootstrap.rooms.find(item=>item.name==='102')!;const created=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Archived grant race',roomId:room.id,language:'de'}})).json() as {id:string;statusToken:string};const approved=await (await request.post(`/api/v1/access-requests/${created.id}/approve`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expiresAt:new Date(Date.now()+86_400_000).toISOString()}})).json() as {guestId:string};const guests=await (await request.get('/api/v1/guests')).json() as {data:{id:string;version:number}[]};const guest=guests.data.find(item=>item.id===approved.guestId)!;const context=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});const [,exchange]=await Promise.all([request.delete(`/api/v1/guests/${guest.id}`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedVersion:guest.version}}),context.request.post(`/api/v1/public/access-requests/${created.id}/status`,{data:{token:created.statusToken,grantId:crypto.randomUUID()}})]);expect(exchange.status()).toBe(200);workflow.archivedGrantGuestStatus=(await context.request.get('/api/v1/guest/me')).status()});

Then('no archived guest session remains active',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.archivedGrantGuestStatus).toBe(401)});

When('the host links a room {string} request to a guest in room {string}',async({scenarioState, page},requestRoom:string,guestRoom:string)=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const rooms=bootstrap.rooms;
  const created=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Room-bound guest',roomId:rooms.find((room)=>room.name===requestRoom)!.id,language:'de'}})).json() as {id:string};
  const guests=await (await request.get('/api/v1/guests')).json() as {data:{id:string;roomName:string}[]};
  const response=await request.post(`/api/v1/access-requests/${created.id}/approve`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),guestId:guests.data.find((guest)=>guest.roomName===guestRoom)!.id,expiresAt:new Date(Date.now()+86_400_000).toISOString()}});
  workflow.crossRoomApprovalStatus=response.status();
});

Then('the cross-room approval is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.crossRoomApprovalStatus).toBe(404)});

When('linked approval races with moving its guest to another room',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};const source=bootstrap.rooms.find(item=>item.name==='102')!;const target=bootstrap.rooms.find(item=>item.name==='101')!;workflow.approvalMoveRaceStatuses=[];
  for(let attempt=0;attempt<8;attempt+=1){const guest=await (await request.post('/api/v1/guests',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:`Approval race ${attempt}`,roomId:source.id,language:'de'}})).json() as {id:string;version:number};const access=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:`Approval race ${attempt}`,roomId:source.id,language:'de'}})).json() as {id:string};const [approval,move]=await Promise.all([request.post(`/api/v1/access-requests/${access.id}/approve`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),guestId:guest.id,expiresAt:new Date(Date.now()+86_400_000).toISOString()}}),request.patch(`/api/v1/guests/${guest.id}`,{headers:csrfHeaders,data:{name:`Approval race ${attempt}`,roomId:target.id,language:'de',expectedVersion:guest.version}})]);workflow.approvalMoveRaceStatuses.push([approval.status(),move.status()])}
});

Then('approval either wins before the move or rejects the moved guest',async({ scenarioState })=>{const workflow=stateFor(scenarioState);for(const statuses of workflow.approvalMoveRaceStatuses)expect([[200,200],[404,200]]).toContainEqual(statuses)});

When("another host submits the administrator's queued order",async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);
  await request.post('/api/v1/hosts',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),email:'staff@aerstello.test',name:'Queue Staff',password:'QueueStaff123!',role:'staff',language:'de'}});
  await request.post('/api/v1/auth/logout',{headers:csrfHeaders});
  await request.post('/api/v1/auth/login',{data:{email:'staff@aerstello.test',password:'QueueStaff123!'}});
  const product=products.data.find((item)=>item.name.de==='Helles')!;
  const guest=guests.data.find((item)=>item.name==='Anna Berger')!;
  const response=await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}});
  workflow.mismatchedHostOrderStatus=response.status();
});

Then('the queued order is rejected for the other host',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.mismatchedHostOrderStatus).toBe(403)});

When('the host submits a product disabled in the captured catalog',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);
  const product=products.data.find((item)=>item.name.de==='Helles')!;
  const disabled=await request.patch(`/api/v1/products/${product.id}`,{headers:csrfHeaders,data:{name:product.name,...(product.description?{description:product.description}:{}),priceCents:product.priceCents,categoryId:product.categoryId,enabled:false,selfServiceOnly:product.selfServiceOnly,expectedVersion:product.version}});
  expect(disabled.status()).toBe(200);
  const updated=await (await request.get('/api/v1/products')).json() as {catalogVersion:number;data:{id:string;enabled:boolean}[]};
  expect(updated.data.find((item)=>item.id===product.id)?.enabled).toBe(false);
  const response=await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guests.data.find((item)=>item.name==='Anna Berger')!.id,catalogVersion:updated.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}});
  workflow.disabledCatalogOrderStatus=response.status();
});

Then('the captured catalog order is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.disabledCatalogOrderStatus).toBe(409)});
