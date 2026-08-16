import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { startApiReplica } from '../support/api-replica';
import { registerBrowserStream } from '../support/browser-stream';
import { connectDatabase } from '../support/database';
import { csrfHeaders } from '../support/operational-api-data';
import { stateFor } from './realtime-concurrency.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('another device creates guest {string} in room {string}',async({page},name:string,roomName:string)=>{await page.goto('/app/guests');await expect(page.getByText('Anna Berger',{exact:true})).toBeVisible();const request=page.context().request;const rooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;name:string}[]};const room=rooms.data.find(item=>item.name===roomName)!;expect((await request.post('/api/v1/guests',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name,roomId:room.id,language:'de'}})).status()).toBe(201)});

Then('guest {string} appears after the committed event',async({page},name:string)=>{await expect(page.getByText(name,{exact:true})).toBeVisible({timeout:10_000})});

When('realtime event persistence fails during a guest edit',async({resources, scenarioState, page})=>{const workflow=stateFor(scenarioState);const request=page.context().request;const guests=await (await request.get('/api/v1/guests')).json() as {data:{id:string;name:string;roomId:string;language:string;version:number}[]};const guest=guests.data.find(item=>item.name==='Anna Berger')!;const databaseResource=await connectDatabase(resources);const database=databaseResource.client;try{await database.query(`CREATE FUNCTION fail_guest_realtime_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.topic='guests.changed' THEN RAISE EXCEPTION 'simulated event failure'; END IF; RETURN NEW; END $$`);await database.query(`CREATE TRIGGER fail_guest_realtime_event BEFORE INSERT ON realtime_events FOR EACH ROW EXECUTE FUNCTION fail_guest_realtime_event()`);workflow.transactionalGuestEditStatus=(await request.patch(`/api/v1/guests/${guest.id}`,{headers:csrfHeaders,data:{name:'Uncommitted guest edit',roomId:guest.roomId,language:guest.language,expectedVersion:guest.version}})).status()}finally{await database.query('DROP TRIGGER IF EXISTS fail_guest_realtime_event ON realtime_events');await database.query('DROP FUNCTION IF EXISTS fail_guest_realtime_event()');await databaseResource.dispose()}const final=await (await request.get('/api/v1/guests')).json() as {data:{id:string;name:string}[]};workflow.transactionalGuestFinalName=final.data.find(item=>item.id===guest.id)!.name});

Then('the guest edit is rolled back',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.transactionalGuestEditStatus).toBe(500);expect(workflow.transactionalGuestFinalName).toBe('Anna Berger')});

When('another API replica creates a room',async({resources, scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const replicaPort=3199;
  const replica=await startApiReplica(resources,{
    port:replicaPort,
    args:['apps/api/dist/index.js'],
    cwd:process.cwd(),
    env:{...process.env,PORT:String(replicaPort),LOG_LEVEL:'warn',RATE_LIMIT_MAX:'5000'},
    stdio:'ignore',
  });
  await expect.poll(async()=>{try{return (await fetch(`${replica.baseURL}/api/v1/health`)).status}catch{return 0}},{timeout:15_000}).toBe(200);
  workflow.replicaRoomEventStreamResource=registerBrowserStream(resources,'replica room event stream',async()=>{
    if(page.isClosed())return;
    try{await page.evaluate(()=>{
      (window as unknown as {__aerstelloReplicaStream?:EventSource}).__aerstelloReplicaStream?.close();
    })}catch(error){if(!page.isClosed())throw error}
  });
  await page.evaluate(()=>new Promise<void>((resolve,reject)=>{
    sessionStorage.setItem('__aerstelloReplicaRoomEvent','0');
    const events=new EventSource('/api/v1/events?scope=host');
    Object.assign(window,{__aerstelloReplicaStream:events});
    events.addEventListener('rooms.changed',()=>sessionStorage.setItem('__aerstelloReplicaRoomEvent','1'));
    events.addEventListener('open',()=>resolve(),{once:true});
    events.addEventListener('error',()=>{if(events.readyState===EventSource.CLOSED)reject(new Error('Replica test stream closed before opening'))},{once:true});
  }));
  const cookie=(await page.context().cookies()).map(item=>`${item.name}=${item.value}`).join('; ');
  const response=await fetch(`http://127.0.0.1:${replicaPort}/api/v1/rooms`,{
    method:'POST',
    headers:{cookie,'content-type':'application/json','x-aerstello-csrf':'1'},
    body:JSON.stringify({mutationId:crypto.randomUUID(),name:'Replica room'}),
  });
  expect(response.status).toBe(201);
});

Then('the connected host receives the other replica room event',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  await expect.poll(()=>page.evaluate(()=>sessionStorage.getItem('__aerstelloReplicaRoomEvent')),{timeout:10_000}).toBe('1');
  await workflow.replicaRoomEventStreamResource?.dispose();
  delete workflow.replicaRoomEventStreamResource;
});

When('realtime events try to commit out of identity order',async({resources, scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const testId=crypto.randomUUID();
  workflow.laterRealtimeInsertWaited=false;
  workflow.commitOrderedRealtimeIds=[];
  workflow.relayedCommitOrderedEvents=[];
  const streamResource=registerBrowserStream(resources,'commit-order event stream',async()=>{
    if(page.isClosed())return;
    try{await page.evaluate(()=>{
      (window as unknown as {__aerstelloCommitOrderStream?:EventSource}).__aerstelloCommitOrderStream?.close();
    })}catch(error){if(!page.isClosed())throw error}
  });
  await page.evaluate((currentTestId)=>new Promise<void>((resolve,reject)=>{
    sessionStorage.setItem('__aerstelloCommitOrderedEvents','[]');
    const events=new EventSource('/api/v1/events?scope=host');
    Object.assign(window,{__aerstelloCommitOrderStream:events});
    events.addEventListener('rooms.changed',(rawEvent)=>{
      const event=rawEvent as MessageEvent<string>;
      const payload=JSON.parse(event.data) as {commitOrderTest?:string;marker?:string};
      if(payload.commitOrderTest!==currentTestId||!payload.marker)return;
      const received=JSON.parse(sessionStorage.getItem('__aerstelloCommitOrderedEvents')??'[]') as {id:string;marker:string}[];
      received.push({id:event.lastEventId,marker:payload.marker});
      sessionStorage.setItem('__aerstelloCommitOrderedEvents',JSON.stringify(received));
    });
    events.addEventListener('open',()=>resolve(),{once:true});
    events.addEventListener('error',()=>{if(events.readyState===EventSource.CLOSED)reject(new Error('Commit-order event stream closed before opening'))},{once:true});
  }),testId);
  const firstResource=await connectDatabase(resources);
  const secondResource=await connectDatabase(resources);
  const first=firstResource.client;
  const second=secondResource.client;
  let firstCommitted=false;
  let secondCommitted=false;
  let laterInsert:Promise<{rows:{id:string}[]}>|undefined;
  try{
    await first.query('BEGIN');
    const earlier=await first.query<{id:string}>(
      `INSERT INTO realtime_events(topic,payload) VALUES ('rooms.changed',$1::jsonb) RETURNING id::text AS id`,
      [JSON.stringify({commitOrderTest:testId,marker:'earlier'})],
    );
    const holderXid=String((await first.query<{xid:string}>('SELECT pg_current_xact_id()::text AS xid')).rows[0]!.xid);
    await second.query('BEGIN');
    laterInsert=second.query<{id:string}>(
      `INSERT INTO realtime_events(topic,payload) VALUES ('rooms.changed',$1::jsonb) RETURNING id::text AS id`,
      [JSON.stringify({commitOrderTest:testId,marker:'later'})],
    );
    await expect.poll(async()=>Number((await first.query(
      `SELECT count(*)::int AS count FROM pg_locks WHERE locktype='transactionid' AND transactionid::text=$1 AND NOT granted`,
      [holderXid],
    )).rows[0].count),{timeout:5_000,intervals:[10,20,50]}).toBeGreaterThan(0);
    workflow.laterRealtimeInsertWaited=true;
    await page.waitForTimeout(750);
    await first.query('COMMIT');
    firstCommitted=true;
    const later=await laterInsert;
    await second.query('COMMIT');
    secondCommitted=true;
    workflow.commitOrderedRealtimeIds=[earlier.rows[0]!.id,later.rows[0]!.id];
    await expect.poll(()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('__aerstelloCommitOrderedEvents')??'[]').length),{timeout:10_000}).toBe(2);
    workflow.relayedCommitOrderedEvents=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('__aerstelloCommitOrderedEvents')??'[]') as {id:string;marker:string}[]);
  }finally{
    if(!firstCommitted)await first.query('ROLLBACK');
    if(!secondCommitted){
      await laterInsert?.catch(()=>undefined);
      await second.query('ROLLBACK');
    }
    await secondResource.dispose();
    await firstResource.dispose();
    await streamResource.dispose();
  }
});

Then('the later realtime insertion waits for the earlier transaction',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.laterRealtimeInsertWaited).toBe(true)});

Then('the connected host receives both realtime events in commit order',async({ scenarioState })=>{const workflow=stateFor(scenarioState);
  expect(BigInt(workflow.commitOrderedRealtimeIds[0]!)).toBeLessThan(BigInt(workflow.commitOrderedRealtimeIds[1]!));
  expect(workflow.relayedCommitOrderedEvents).toEqual([
    {id:workflow.commitOrderedRealtimeIds[0]!,marker:'earlier'},
    {id:workflow.commitOrderedRealtimeIds[1]!,marker:'later'},
  ]);
});
