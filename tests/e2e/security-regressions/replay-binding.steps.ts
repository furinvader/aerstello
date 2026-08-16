import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { csrfHeaders,operationalData } from '../support/operational-api-data';
import { stateFor } from './replay-binding.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('a settlement mutation is replayed with another payment method',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};const mutationId=crypto.randomUUID();const command={mutationId,expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'};expect((await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:command})).status()).toBe(200);workflow.changedSettlementReplayStatus=(await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{...command,paymentMethod:'card'}})).status()});

Then('the changed settlement replay is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.changedSettlementReplayStatus).toBe(409)});

When('the same item void mutation is submitted twice',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);
  const guest=guests.data.find((item)=>item.name==='Anna Berger')!;const product=products.data.find((item)=>item.name.de==='Helles')!;
  await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}});
  const tab=await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json() as {items:{id:string;billingVersion:number}[]};
  const mutationId=crypto.randomUUID();
  const command={mutationId,reason:'E2E correction',expectedBillingVersion:tab.items[0]!.billingVersion};
  workflow.repeatedVoidStatuses=[];
  workflow.repeatedVoidStatuses.push((await request.post(`/api/v1/order-items/${tab.items[0]!.id}/void`,{headers:csrfHeaders,data:command})).status());
  workflow.repeatedVoidStatuses.push((await request.post(`/api/v1/order-items/${tab.items[0]!.id}/void`,{headers:csrfHeaders,data:command})).status());
  workflow.changedItemVoidReplayStatus=(await request.post(`/api/v1/order-items/${tab.items[0]!.id}/void`,{headers:csrfHeaders,data:{...command,reason:'Changed correction'}})).status();
  workflow.changedItemVoidVersionReplayStatus=(await request.post(`/api/v1/order-items/${tab.items[0]!.id}/void`,{headers:csrfHeaders,data:{...command,expectedBillingVersion:command.expectedBillingVersion+1}})).status();
});

Then('both item void responses succeed',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.repeatedVoidStatuses).toEqual([200,200])});

Then('changing the replayed item void reason is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.changedItemVoidReplayStatus).toBe(409)});

Then('changing the replayed item billing version is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.changedItemVoidVersionReplayStatus).toBe(409)});

When('the same order mutation is submitted concurrently',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;const mutationId=crypto.randomUUID();const data={mutationId,originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]};
  const responses=await Promise.all([request.post('/api/v1/order-batches',{headers:csrfHeaders,data}),request.post('/api/v1/order-batches',{headers:csrfHeaders,data})]);workflow.concurrentOrderStatuses=responses.map(response=>response.status());workflow.concurrentOrderItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
});

Then('both concurrent order responses succeed',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.concurrentOrderStatuses).toEqual([201,201])});

Then('the concurrent order is stored only once',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.concurrentOrderItemCount).toBe(1)});

When('the same bill void mutation is submitted twice',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find((item)=>item.name==='Anna Berger')!;const product=products.data.find((item)=>item.name.de==='Helles')!;
  const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};
  const bill=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}})).json() as {id:string};const mutationId=crypto.randomUUID();workflow.repeatedBillVoidStatuses=[];
  workflow.repeatedBillVoidStatuses.push((await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId,reason:'E2E correction'}})).status());workflow.repeatedBillVoidStatuses.push((await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId,reason:'E2E correction'}})).status());workflow.changedBillVoidReplayStatus=(await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId,reason:'Changed correction'}})).status();workflow.restoredBillItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
});

Then('both bill void responses succeed',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.repeatedBillVoidStatuses).toEqual([200,200])});

Then('the billed items are restored only once',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.restoredBillItemCount).toBe(1)});

Then('changing the replayed bill void reason is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.changedBillVoidReplayStatus).toBe(409)});
