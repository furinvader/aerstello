import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { startApiReplica } from '../support/api-replica';
import { createBrowserContext } from '../support/browser-context';
import { connectDatabase } from '../support/database';
import { csrfHeaders } from '../support/operational-api-data';
import type { ResourceRegistry } from '../support/resource-registry';
import { stateFor } from './grant-exchange.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

async function startClockSkewedApi(resources:ResourceRegistry,port:number,offsetMs:number) {
  const replica=await startApiReplica(resources,{
    port,
    args:['--import','./tests/e2e/fixtures/future-clock.mjs','apps/api/dist/index.js'],
    env:{LOG_LEVEL:'warn',RATE_LIMIT_MAX:'5000',AERSTELLO_TEST_CLOCK_OFFSET_MS:String(offsetMs)},
  });
  await expect.poll(async()=>{try{return (await fetch(`${replica.baseURL}/api/v1/health`)).status}catch{return 0}},{timeout:15_000}).toBe(200);
  return replica.baseURL;
}

When('an approved guest grant response is lost before its cookie is retained',async({resources, guestDevice, scenarioState, page,browser})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const room=bootstrap.rooms.find(item=>item.name==='102')!;
  const created=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Recoverable grant',roomId:room.id,language:'de'}})).json() as {id:string;statusToken:string};
  expect((await request.post(`/api/v1/access-requests/${created.id}/approve`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expiresAt:new Date(Date.now()+86_400_000).toISOString()}})).status()).toBe(200);
  const same=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});const different=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});
  const grantId=crypto.randomUUID();const statusPath=`/api/v1/public/access-requests/${created.id}/status`;const statusData={token:created.statusToken,grantId};
  expect((await same.request.post(statusPath,{data:statusData})).status()).toBe(200);
  await same.clearCookies();
  expect((await same.request.post(statusPath,{data:statusData})).status()).toBe(200);
  workflow.recoveredGrantStatus=(await same.request.get('/api/v1/guest/me')).status();
  await different.request.post(statusPath,{data:{token:created.statusToken,grantId:crypto.randomUUID()}});
  workflow.differentGrantStatus=(await different.request.get('/api/v1/guest/me')).status();
});

Then('retrying the same grant exchange restores guest access',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.recoveredGrantStatus).toBe(200)});

Then('a different grant exchange receives no guest access',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.differentGrantStatus).toBe(401)});

When('a pending guest request crosses a session-secret rotation',async({resources, guestDevice, scenarioState, page,browser})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const room=bootstrap.rooms.find(item=>item.name==='102')!;
  const mutationId=crypto.randomUUID();
  const accessCommand={mutationId,name:'Rotation-safe guest',roomId:room.id,language:'de'};
  const createdResponse=await request.post('/api/v1/public/access-requests',{data:accessCommand});
  expect(createdResponse.status()).toBe(201);
  const created=await createdResponse.json() as {id:string;statusToken:string};
  const capabilityKeys=process.env.ACCESS_CAPABILITY_KEYS??'development-v1:development-only-access-capability-secret';
  const replicaPort=3204;
  await startApiReplica(resources,{port:replicaPort,
    env:{
      ...process.env,
      LOG_LEVEL:'warn',
      RATE_LIMIT_MAX:'5000',
      SESSION_SECRET:'rotated-host-session-secret-at-least-32-characters',
      ACCESS_CAPABILITY_KEYS:capabilityKeys,
    },
  });
  const rotatedURL=`http://127.0.0.1:${replicaPort}`;
  await expect.poll(async()=>{try{return (await fetch(`${rotatedURL}/api/v1/health`)).status}catch{return 0}},{timeout:15_000}).toBe(200);
  workflow.rotatedHostSessionStatus=(await request.get(`${rotatedURL}/api/v1/auth/me`)).status();

  const reissuedResponse=await request.post(`${rotatedURL}/api/v1/public/access-requests`,{data:accessCommand});
  expect(reissuedResponse.status()).toBe(201);
  const reissued=await reissuedResponse.json() as {id:string;statusToken:string};
  const rotatedDevice=await createBrowserContext(resources,browser,{baseURL:rotatedURL});
  const originalPoll=await rotatedDevice.request.post(`/api/v1/public/access-requests/${created.id}/status`,{
    data:{token:created.statusToken,grantId:crypto.randomUUID()},
  });
  const reissuedPoll=await rotatedDevice.request.post(`/api/v1/public/access-requests/${created.id}/status`,{
    data:{token:reissued.statusToken,grantId:crypto.randomUUID()},
  });
  workflow.rotatedCapabilityPollResult={
    statuses:[originalPoll.status(),reissuedPoll.status()],
    sameToken:created.id===reissued.id&&created.statusToken===reissued.statusToken,
    states:[
      String(((await originalPoll.json()) as {status:string}).status),
      String(((await reissuedPoll.json()) as {status:string}).status),
    ],
  };

  expect((await request.post(`/api/v1/access-requests/${created.id}/approve`,{
    headers:csrfHeaders,
    data:{mutationId:crypto.randomUUID(),expiresAt:new Date(Date.now()+86_400_000).toISOString()},
  })).status()).toBe(200);
  const grantId=crypto.randomUUID();
  const originalDevice=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});
  const exchangeData={token:created.statusToken,grantId};
  expect((await originalDevice.request.post(`/api/v1/public/access-requests/${created.id}/status`,{data:exchangeData})).status()).toBe(200);
  await originalDevice.clearCookies();
  const recovered=await originalDevice.request.post(`${rotatedURL}/api/v1/public/access-requests/${created.id}/status`,{data:exchangeData});
  expect(recovered.status()).toBe(200);
  expect((await recovered.json()) as {granted:boolean}).toEqual(expect.objectContaining({granted:true}));
  workflow.rotatedGrantRecoveryStatus=(await originalDevice.request.get(`${rotatedURL}/api/v1/guest/me`)).status();
});

Then('its original and idempotently reissued capabilities remain pollable',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  expect(workflow.rotatedCapabilityPollResult).toEqual({statuses:[200,200],sameToken:true,states:['pending','pending']});
});

Then('the bound grant exchange restores guest access after rotation',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.rotatedGrantRecoveryStatus).toBe(200)});

Then('the rotated replica rejects the old host session',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.rotatedHostSessionStatus).toBe(401)});

When('an approved guest request expires before its grant exchange',async({resources, guestDevice, scenarioState, page,browser})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};const room=bootstrap.rooms.find(item=>item.name==='102')!;
  const created=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Expired grant',roomId:room.id,language:'de'}})).json() as {id:string;statusToken:string};
  expect((await request.post(`/api/v1/access-requests/${created.id}/approve`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expiresAt:new Date(Date.now()+1500).toISOString()}})).status()).toBe(200);
  await page.waitForTimeout(1800);
  const context=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});const response=await context.request.post(`/api/v1/public/access-requests/${created.id}/status`,{data:{token:created.statusToken,grantId:crypto.randomUUID()}});
  workflow.expiredGrantResult=await response.json() as {status:string;granted:boolean};workflow.expiredGrantGuestStatus=(await context.request.get('/api/v1/guest/me')).status();
});

Then('the expired exchange is not consumed or granted',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.expiredGrantResult).toEqual(expect.objectContaining({status:'expired',granted:false}));expect(workflow.expiredGrantGuestStatus).toBe(401)});

When('a clock-skewed API replica exchanges a database-valid grant',async({resources, guestDevice, scenarioState, page,browser})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};const room=bootstrap.rooms.find(item=>item.name==='102')!;
  const created=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Database Clock Grant',roomId:room.id,language:'de'}})).json() as {id:string;statusToken:string};
  expect((await request.post(`/api/v1/access-requests/${created.id}/approve`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expiresAt:new Date(Date.now()+30*60*1000).toISOString()}})).status()).toBe(200);
  const replicaURL=await startClockSkewedApi(resources,3201,60*60*1000);
  const context=await createBrowserContext(resources,browser,{baseURL:replicaURL});
  const exchange=await context.request.post(`/api/v1/public/access-requests/${created.id}/status`,{data:{token:created.statusToken,grantId:crypto.randomUUID()}});
  workflow.databaseClockGrantResult={granted:((await exchange.json()) as {granted:boolean}).granted,guestStatus:(await context.request.get('/api/v1/guest/me')).status()};
});

Then('the database-valid guest access is granted',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.databaseClockGrantResult).toEqual({granted:true,guestStatus:200})});

When('an approved guest grant expires while waiting for its guest lock',async({resources, guestDevice, scenarioState, page,browser})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const room=bootstrap.rooms.find(item=>item.name==='102')!;
  const created=await (await request.post('/api/v1/public/access-requests',{
    data:{mutationId:crypto.randomUUID(),name:'Serialized Expired Grant',roomId:room.id,language:'de'},
  })).json() as {id:string;statusToken:string};
  const context=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});
  const databaseResource=await connectDatabase(resources);const database=databaseResource.client;let rolledBack=false;
  try{
    const expiresAt=((await database.query<{expiresAt:Date}>(
      `SELECT clock_timestamp()+interval '3 seconds' AS "expiresAt"`,
    )).rows[0]!.expiresAt).toISOString();
    const approval=await request.post(`/api/v1/access-requests/${created.id}/approve`,{
      headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expiresAt},
    });
    expect(approval.status()).toBe(200);
    const approved=await approval.json() as {guestId:string};
    await database.query('BEGIN');
    await database.query('SELECT id FROM guests WHERE id=$1 FOR UPDATE',[approved.guestId]);
    const holderXid=String((await database.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid);
    const startsValid=Boolean((await database.query(
      'SELECT expires_at>clock_timestamp() AS valid FROM access_requests WHERE id=$1',[created.id],
    )).rows[0].valid);
    expect(startsValid).toBe(true);
    const exchange=context.request.post(`/api/v1/public/access-requests/${created.id}/status`,{
      data:{token:created.statusToken,grantId:crypto.randomUUID()},
    });
    await expect.poll(async()=>Number((await database.query(
      `SELECT count(*) FROM pg_locks WHERE locktype='transactionid' AND transactionid::text=$1 AND NOT granted`,[holderXid],
    )).rows[0].count),{timeout:5_000,intervals:[10,20,50]}).toBeGreaterThan(0);
    await expect.poll(async()=>Boolean((await database.query(
      'SELECT clock_timestamp()>=expires_at AS expired FROM access_requests WHERE id=$1',[created.id],
    )).rows[0].expired),{timeout:5_000,intervals:[25,50,100]}).toBe(true);
    await database.query('ROLLBACK');rolledBack=true;
    const response=await exchange;
    const payload=await response.json() as {status:string;granted:boolean};
    const accessState=(await database.query<{consumedAt:Date|null}>(
      'SELECT status_token_consumed_at AS "consumedAt" FROM access_requests WHERE id=$1',[created.id],
    )).rows[0]!;
    workflow.serializedGrantResult={
      status:payload.status,
      granted:payload.granted,
      guestStatus:(await context.request.get('/api/v1/guest/me')).status(),
      sessionCount:Number((await database.query('SELECT count(*) FROM guest_sessions WHERE request_id=$1',[created.id])).rows[0].count),
      consumedAt:accessState.consumedAt,
    };
  }finally{if(!rolledBack)await database.query('ROLLBACK');await databaseResource.dispose()}
});

Then('the serialized expired grant is not consumed or issued',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  expect(workflow.serializedGrantResult).toEqual({status:'expired',granted:false,guestStatus:401,sessionCount:0,consumedAt:null});
});

When('clock-skewed API replicas validate access approval expiries',async({resources, guestDevice, scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const room=bootstrap.rooms.find(item=>item.name==='102')!;
  const valid=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Database Valid Approval',roomId:room.id,language:'de'}})).json() as {id:string};
  const expired=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Database Expired Approval',roomId:room.id,language:'de'}})).json() as {id:string};
  const databaseResource=await connectDatabase(resources);const database=databaseResource.client;
  try{
    const times=(await database.query<{validExpiresAt:Date;expiredExpiresAt:Date}>(
      `SELECT clock_timestamp()+interval '30 minutes' AS "validExpiresAt",
              clock_timestamp()-interval '30 minutes' AS "expiredExpiresAt"`,
    )).rows[0]!;
    const futureReplica=await startClockSkewedApi(resources,3202,60*60*1000);
    const pastReplica=await startClockSkewedApi(resources,3203,-60*60*1000);
    const validResponse=await request.post(`${futureReplica}/api/v1/access-requests/${valid.id}/approve`,{
      headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expiresAt:times.validExpiresAt.toISOString()},
    });
    const expiredResponse=await request.post(`${pastReplica}/api/v1/access-requests/${expired.id}/approve`,{
      headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expiresAt:times.expiredExpiresAt.toISOString()},
    });
    const expiredBody=await expiredResponse.json() as {error:{code:string}};
    const states=await database.query<{id:string;status:string}>('SELECT id,status FROM access_requests WHERE id=ANY($1::uuid[])',[ [valid.id,expired.id] ]);
    workflow.databaseClockApprovalResult={
      validStatus:validResponse.status(),
      validRequestStatus:states.rows.find(row=>row.id===valid.id)!.status,
      expiredStatus:expiredResponse.status(),
      expiredCode:expiredBody.error.code,
      expiredRequestStatus:states.rows.find(row=>row.id===expired.id)!.status,
      expiredGuestCount:Number((await database.query(`SELECT count(*) FROM guests WHERE name='Database Expired Approval'`)).rows[0].count),
    };
  }finally{await databaseResource.dispose()}
});

Then('only the database-valid access approval is accepted',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  expect(workflow.databaseClockApprovalResult).toEqual({
    validStatus:200,validRequestStatus:'approved',expiredStatus:400,expiredCode:'INVALID_EXPIRY',expiredRequestStatus:'pending',expiredGuestCount:0,
  });
});

When('an access approval expires while waiting for its request lock',async({resources, guestDevice, scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const room=bootstrap.rooms.find(item=>item.name==='102')!;
  const created=await (await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Serialized Expired Approval',roomId:room.id,language:'de'}})).json() as {id:string};
  const databaseResource=await connectDatabase(resources);const database=databaseResource.client;let committed=false;
  try{
    await database.query('BEGIN');
    await database.query('SELECT id FROM access_requests WHERE id=$1 FOR UPDATE',[created.id]);
    const holderXid=String((await database.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid);
    const expiresAt=((await database.query<{expiresAt:Date}>(`SELECT clock_timestamp()+interval '2 seconds' AS "expiresAt"`)).rows[0]!.expiresAt).toISOString();
    const approval=request.post(`/api/v1/access-requests/${created.id}/approve`,{
      headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expiresAt},
    });
    await expect.poll(async()=>Number((await database.query(
      `SELECT count(*) FROM pg_locks WHERE locktype='transactionid' AND transactionid::text=$1 AND NOT granted`,[holderXid],
    )).rows[0].count),{timeout:5_000,intervals:[10,20,50]}).toBeGreaterThan(0);
    await new Promise(resolve=>setTimeout(resolve,2_200));
    await database.query('COMMIT');committed=true;
    const response=await approval;
    const responseBody=await response.json() as {error:{code:string}};
    workflow.serializedApprovalResult={
      status:response.status(),
      code:responseBody.error.code,
      requestStatus:String((await database.query('SELECT status FROM access_requests WHERE id=$1',[created.id])).rows[0].status),
      guestCount:Number((await database.query(`SELECT count(*) FROM guests WHERE name='Serialized Expired Approval'`)).rows[0].count),
    };
  }finally{if(!committed)await database.query('ROLLBACK');await databaseResource.dispose()}
});

Then('the expired approval is rejected without resolving its request',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  expect(workflow.serializedApprovalResult).toEqual({status:400,code:'INVALID_EXPIRY',requestStatus:'pending',guestCount:0});
});
