import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { startApiReplica } from '../support/api-replica';
import { createBrowserContext } from '../support/browser-context';
import { connectDatabase } from '../support/database';
import { csrfHeaders } from '../support/operational-api-data';
import { stateFor } from './capabilities-rate-limits.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('two devices exchange the same approved access request token',async({resources, scenarioState, page,browser})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const room=bootstrap.rooms.find((item)=>item.name==='102')!;
  const created=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'One-time guest',roomId:room.id,language:'de'}})).json() as {id:string;statusToken:string};
  await request.post(`/api/v1/access-requests/${created.id}/approve`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expiresAt:new Date(Date.now()+86_400_000).toISOString()}});
  const first=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});const second=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});
  await Promise.all([
    first.request.post(`/api/v1/public/access-requests/${created.id}/status`,{data:{token:created.statusToken,grantId:crypto.randomUUID()}}),
    second.request.post(`/api/v1/public/access-requests/${created.id}/status`,{data:{token:created.statusToken,grantId:crypto.randomUUID()}}),
  ]);
  workflow.firstGuestAccessStatus=(await first.request.get('/api/v1/guest/me')).status();
  workflow.secondGuestAccessStatus=(await second.request.get('/api/v1/guest/me')).status();
});

Then('exactly one device receives guest access',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect([workflow.firstGuestAccessStatus,workflow.secondGuestAccessStatus].sort()).toEqual([200,401])});

When('an approved request is exchanged for a guest grant',async({resources, scenarioState, page,browser})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const room=bootstrap.rooms.find(item=>item.name==='102')!;
  const created=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Body grant',roomId:room.id,language:'de'}})).json() as {id:string;statusToken:string};
  expect((await request.post(`/api/v1/access-requests/${created.id}/approve`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expiresAt:new Date(Date.now()+86_400_000).toISOString()}})).status()).toBe(200);
  const context=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});
  const pending={id:created.id,token:created.statusToken,grantId:crypto.randomUUID()};
  await context.addInitScript((value)=>localStorage.setItem('aerstello-pending',JSON.stringify(value)),pending);
  const device=await context.newPage();
  const observed=device.waitForRequest(candidate=>candidate.url().includes(`/api/v1/public/access-requests/${created.id}/status`));
  await device.goto('/guest/request');
  const exchange=await observed;
  workflow.grantExchangeRequest={method:exchange.method(),url:exchange.url(),body:exchange.postDataJSON()};
});

Then('the grant token is sent in the request body',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.grantExchangeRequest?.method).toBe('POST');expect(new URL(workflow.grantExchangeRequest!.url).search).toBe('');expect(workflow.grantExchangeRequest?.body).toEqual(expect.objectContaining({token:expect.any(String),grantId:expect.any(String)}))});

When('thirteen guest devices poll pending access from one network',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string}[]};const room=bootstrap.rooms[0]!;
  const pending=await Promise.all(Array.from({length:13},async(_,index)=>{
    const response=await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:`Shared network guest ${index}`,roomId:room.id,language:'de'}});expect(response.status()).toBe(201);return response.json() as Promise<{id:string;statusToken:string}>;
  }));
  workflow.sharedNetworkPollStatuses=[];
  for(let round=0;round<25;round+=1){const responses=await Promise.all(pending.map(item=>request.post(`/api/v1/public/access-requests/${item.id}/status`,{data:{token:item.statusToken,grantId:crypto.randomUUID()}})));workflow.sharedNetworkPollStatuses.push(...responses.map(response=>response.status()))}
});

Then('none of their valid status polls is rate limited',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.sharedNetworkPollStatuses).toHaveLength(325);expect(workflow.sharedNetworkPollStatuses).not.toContain(429);expect(new Set(workflow.sharedNetworkPollStatuses)).toEqual(new Set([200]))});

When('one network rotates invalid access capabilities beyond its address limit',async({resources, scenarioState})=>{const workflow=stateFor(scenarioState);
  const replicaPort=3202;
  await startApiReplica(resources,{
    port:replicaPort,
    args:['apps/api/dist/index.js'],
    cwd:process.cwd(),
    env:{...process.env,PORT:String(replicaPort),LOG_LEVEL:'warn',TRUST_PROXY:'true',RATE_LIMIT_MAX:'50',ACCESS_STATUS_IP_LIMIT_MAX:'2'},
    stdio:'ignore',
  });
  await expect.poll(async()=>{try{return (await fetch(`http://127.0.0.1:${replicaPort}/api/v1/health`)).status}catch{return 0}},{timeout:15_000}).toBe(200);
  const requestId=crypto.randomUUID();
  workflow.rotatingCapabilityStatuses=[];
  for(const token of ['invalid-capability-one','invalid-capability-two','invalid-capability-three']){
    const response=await fetch(`http://127.0.0.1:${replicaPort}/api/v1/public/access-requests/${requestId}/status`,{
      method:'POST',
      headers:{'content-type':'application/json','x-forwarded-for':'198.51.100.27'},
      body:JSON.stringify({token,grantId:crypto.randomUUID()}),
    });
    workflow.rotatingCapabilityStatuses.push(response.status);
  }
});

Then('the access status address limit is enforced',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.rotatingCapabilityStatuses).toEqual([404,404,429])});

When('status polling and ordinary traffic reach their limits from one forwarded address',async({resources, scenarioState})=>{const workflow=stateFor(scenarioState);
  const replicaPort=3203;
  await startApiReplica(resources,{
    port:replicaPort,
    args:['apps/api/dist/index.js'],
    cwd:process.cwd(),
    env:{...process.env,PORT:String(replicaPort),LOG_LEVEL:'warn',TRUST_PROXY:'true',RATE_LIMIT_MAX:'4',ACCESS_STATUS_IP_LIMIT_MAX:'4'},
    stdio:'ignore',
  });
  const baseURL=`http://127.0.0.1:${replicaPort}`;
  let readinessProbe=0;
  await expect.poll(async()=>{try{
    readinessProbe+=1;
    return (await fetch(`${baseURL}/api/v1/health`,{headers:{'x-forwarded-for':`203.0.113.${(readinessProbe%250)+1}`}})).status;
  }catch{return 0}},{timeout:15_000}).toBe(200);
  const forwardedAddress='198.51.100.28';
  const headers={'content-type':'application/json','x-forwarded-for':forwardedAddress};
  const requestId=crypto.randomUUID();
  const poll=async(index:number)=>(await fetch(`${baseURL}/api/v1/public/access-requests/${requestId}/status`,{
    method:'POST',headers,body:JSON.stringify({token:`independent-capability-${index}`,grantId:crypto.randomUUID()}),
  })).status;
  const ordinary=async()=>(await fetch(`${baseURL}/api/v1/health`,{headers:{'x-forwarded-for':forwardedAddress}})).status;
  const statusFirst=[];for(let index=0;index<2;index+=1)statusFirst.push(await poll(index));
  const ordinaryStatuses=[];for(let index=0;index<5;index+=1)ordinaryStatuses.push(await ordinary());
  const statusLast=[];for(let index=2;index<5;index+=1)statusLast.push(await poll(index));
  workflow.independentAddressRateStatuses={statusFirst,ordinary:ordinaryStatuses,statusLast};
});

Then('neither address budget consumes the other',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.independentAddressRateStatuses).toEqual({statusFirst:[404,404],ordinary:[200,200,200,200,429],statusLast:[404,404,429]})});

When('requests at the address limit are split across API replicas',async({resources, scenarioState, page})=>{const workflow=stateFor(scenarioState);const replicaPort=3200;await startApiReplica(resources,{port:replicaPort,args:['apps/api/dist/index.js'],cwd:process.cwd(),env:{...process.env,PORT:String(replicaPort),LOG_LEVEL:'warn',RATE_LIMIT_MAX:'5000'},stdio:'ignore'});await expect.poll(async()=>{try{return (await fetch(`http://127.0.0.1:${replicaPort}/api/v1/health`)).status}catch{return 0}},{timeout:15_000}).toBe(200);const keyHash=createHash('sha256').update('ip:127.0.0.1').digest('base64url');const databaseResource=await connectDatabase(resources);const database=databaseResource.client;try{await database.query(`INSERT INTO rate_limit_counters(scope,key_hash,count,expires_at) VALUES ('global',$1,4999,now()+interval '1 minute') ON CONFLICT (scope,key_hash) DO UPDATE SET count=4999,expires_at=excluded.expires_at`,[keyHash])}finally{await databaseResource.dispose()}const first=await page.context().request.get('/api/v1/health');const second=await fetch(`http://127.0.0.1:${replicaPort}/api/v1/health`);workflow.sharedReplicaRateStatuses=[first.status(),second.status]});

Then('the shared address limit is enforced once',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.sharedReplicaRateStatuses).toEqual([200,429])});

When('a client submits malformed JSON',async({ scenarioState })=>{const workflow=stateFor(scenarioState);const response=await fetch(`${e2eBaseURL}/api/v1/public/access-requests`,{method:'POST',headers:{'content-type':'application/json'},body:'{' });const payload=await response.json() as {error:{code:string}};workflow.malformedJsonResult={status:response.status,code:payload.error.code}});

Then('the malformed request is rejected as a client error',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.malformedJsonResult).toEqual({status:400,code:'FST_ERR_CTP_INVALID_JSON_BODY'})});
