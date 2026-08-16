import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { createBrowserContext } from '../support/browser-context';
import { registerBrowserStream } from '../support/browser-stream';
import { csrfHeaders } from '../support/operational-api-data';
import { stateFor } from './session-realtime.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('the administrator session is revoked while its event stream is open',async({resources, scenarioState, page,browser})=>{const workflow=stateFor(scenarioState);
  const revokedStream=registerBrowserStream(resources,'revoked administrator event stream',async()=>{if(page.isClosed())return;try{await page.evaluate(()=>{(window as unknown as {__aerstelloRevokedStream?:EventSource}).__aerstelloRevokedStream?.close()})}catch(error){if(!page.isClosed())throw error}});
  await page.evaluate(()=>new Promise<void>((resolve,reject)=>{sessionStorage.setItem('__aerstelloRevokedEvents','0');const events=new EventSource('/api/v1/events?scope=host');Object.assign(window,{__aerstelloRevokedStream:events});events.addEventListener('rooms.changed',()=>sessionStorage.setItem('__aerstelloRevokedEvents',String(Number(sessionStorage.getItem('__aerstelloRevokedEvents'))+1)));events.addEventListener('open',()=>resolve(),{once:true});events.addEventListener('error',()=>{if(events.readyState===EventSource.CLOSED)reject(new Error('Event stream closed before opening'))},{once:true})}));
  const request=page.context().request;await request.post('/api/v1/hosts',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),email:'realtime-admin@aerstello.test',name:'Realtime Admin',password:'RealtimeAdmin123!',role:'admin',language:'de'}});const other=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});await other.request.post('/api/v1/auth/login',{data:{email:'realtime-admin@aerstello.test',password:'RealtimeAdmin123!'}});execFileSync('npm',['run','admin:create:dev','-w','@aerstello/api','--','--email','admin@aerstello.test','--name','Mira Host','--password-stdin'],{cwd:process.cwd(),env:process.env,stdio:'pipe',input:'RecoveredAgain123!\n'});expect((await other.request.post('/api/v1/rooms',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:'After revocation'}})).status()).toBe(201);await page.waitForTimeout(500);workflow.revokedStreamEventCount=await page.evaluate(()=>Number(sessionStorage.getItem('__aerstelloRevokedEvents')));await revokedStream.dispose();
});

Then('the revoked stream receives no later venue events',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.revokedStreamEventCount).toBe(0)});
