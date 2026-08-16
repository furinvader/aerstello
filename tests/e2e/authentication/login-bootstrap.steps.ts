import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import argon2 from 'argon2';
import { execFileSync } from 'node:child_process';
import { createBdd } from 'playwright-bdd';
import { signIn } from '../authentication/sign-in';
import { test } from '../fixtures/test';
import { connectDatabase } from '../support/database';
import { stateFor } from './login-bootstrap.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

Given('the seeded Aerstello venue', async ({ page }) => { await page.goto('/login'); });

When('the administrator signs in', async ({ page }) => { await signIn(page); });

Given('an authenticated administrator', async ({ page }) => { await signIn(page); });

Then('the host dashboard shows the venue name {string}', async ({ page }, name:string) => { await expect(page.locator('.page-header')).toContainText(name); });

Then('the page has no serious accessibility violations', async ({ page }) => { const axePage=page as unknown as ConstructorParameters<typeof AxeBuilder>[0]['page'];const result=await new AxeBuilder({page:axePage}).withTags(['wcag2a','wcag2aa']).analyze();expect(result.violations.filter(v=>['serious','critical'].includes(v.impact??''))).toEqual([]); });

When('a public launch identity check fails transiently',async({page})=>{
  await page.addInitScript(()=>{
    const originalFetch=window.fetch.bind(window);
    const state=window as unknown as {__aerstelloLaunchIdentityOutage:{active:boolean;attempts:number}};
    state.__aerstelloLaunchIdentityOutage={active:true,attempts:0};
    window.fetch=async(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(new URL(url,window.location.href).pathname==='/api/v1/auth/me'){
        state.__aerstelloLaunchIdentityOutage.attempts+=1;
        if(state.__aerstelloLaunchIdentityOutage.active)return new Response(JSON.stringify({error:{code:'SERVICE_UNAVAILABLE',message:'Simulated launch identity outage'}}),{status:503,headers:{'content-type':'application/json'}});
      }
      return originalFetch(input,init);
    };
  });
  await page.goto('/');
});

Then('public launch shows a localized failure with retry',async({page})=>{
  await expect(page.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/);
  await expect(page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

When('the visitor retries the launch identity checks',async({page})=>{
  const retry=page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/});
  await retry.evaluate((button)=>button.addEventListener('click',()=>{
    (window as unknown as {__aerstelloLaunchIdentityOutage:{active:boolean}}).__aerstelloLaunchIdentityOutage.active=false;
  },{capture:true,once:true}));
  await retry.click();
});

Then('public entry opens after launch identity recovery',async({page})=>{
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel(/E-Mail|Email/)).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {__aerstelloLaunchIdentityOutage:{attempts:number}}).__aerstelloLaunchIdentityOutage.attempts)).toBeGreaterThanOrEqual(2);
});

When('the initial host identity request fails transiently on the bills route',async({page})=>{
  await page.addInitScript(()=>{
    const originalFetch=window.fetch.bind(window);
    const state=window as unknown as {__aerstelloTransientHostIdentityRequests:number};
    state.__aerstelloTransientHostIdentityRequests=0;
    window.fetch=async(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(new URL(url,window.location.href).pathname==='/api/v1/auth/me'){
        state.__aerstelloTransientHostIdentityRequests+=1;
        if(state.__aerstelloTransientHostIdentityRequests===1)return new Response(JSON.stringify({error:{code:'SERVICE_UNAVAILABLE',message:'Simulated host identity outage'}}),{status:503,headers:{'content-type':'application/json'}});
      }
      return originalFetch(input,init);
    };
  });
  await page.goto('/app/bills');
});

Then('the bills route shows a localized identity failure with retry',async({page})=>{
  await expect(page.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/);
  await expect(page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();
});

Then('the host is not redirected to login',async({page})=>{await expect(page).toHaveURL(/\/app\/bills$/);await expect(page).not.toHaveURL(/\/login$/)});

When('the host retries the initial identity request',async({page})=>{await page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click()});

Then('the requested bills route opens after identity recovery',async({page})=>{
  await expect(page).toHaveURL(/\/app\/bills$/);
  await expect(page.getByRole('heading',{name:/Rechnungen|Conti|Bills/})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {__aerstelloTransientHostIdentityRequests:number}).__aerstelloTransientHostIdentityRequests)).toBeGreaterThanOrEqual(2);
});

When('invalid passwords are submitted for known and unknown host emails', async ({scenarioState,  page }) => {const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const responses=await Promise.all([
    request.post('/api/v1/auth/login',{data:{email:'admin@aerstello.test',password:'DefinitelyWrong123!'}}),
    request.post('/api/v1/auth/login',{data:{email:'missing@aerstello.test',password:'DefinitelyWrong123!'}}),
  ]);
  workflow.loginFailureResults=await Promise.all(responses.map(async response=>({status:response.status(),body:await response.json()})));
});

Then('both login attempts return the same credential error', async ({ scenarioState }) => {const workflow=stateFor(scenarioState); expect(workflow.loginFailureResults).toHaveLength(2);expect(workflow.loginFailureResults[0]).toEqual(workflow.loginFailureResults[1]); });

When('the administrator credentials are recovered from the command line', async ({scenarioState,  page }) => {const workflow=stateFor(scenarioState);
  execFileSync('npm',['run','admin:create:dev','-w','@aerstello/api','--','--email','admin@aerstello.test','--name','Mira Host','--password-stdin'],{cwd:process.cwd(),env:process.env,stdio:'pipe',input:'RecoveredAdmin123!\n'});
  workflow.recoveredDeviceStatus=(await page.context().request.get('/api/v1/auth/me')).status();
});

Then('the existing host device is signed out',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.recoveredDeviceStatus).toBe(401)});

When('credential recovery completes while an old-password login is being verified',async({resources, scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const oldPassword='RacingOldPassword123!';
  const oldHash=await argon2.hash(oldPassword,{type:argon2.argon2id,memoryCost:19_456,timeCost:12,parallelism:1});
  const newHash=await argon2.hash('RacingNewPassword123!',{type:argon2.argon2id,memoryCost:19_456,timeCost:2,parallelism:1});
  const databaseResource=await connectDatabase(resources);
  const database=databaseResource.client;
  try{
    await database.query("UPDATE hosts SET password_hash=$1 WHERE lower(email)='admin@aerstello.test'",[oldHash]);
    await database.query("UPDATE host_sessions SET revoked_at=now() WHERE host_id=(SELECT id FROM hosts WHERE lower(email)='admin@aerstello.test') AND revoked_at IS NULL");
    const login=page.context().request.post('/api/v1/auth/login',{data:{email:'admin@aerstello.test',password:oldPassword}});
    await expect.poll(async()=>Number((await database.query(
      `SELECT count(*) FROM pg_stat_activity
        WHERE pid<>pg_backend_pid() AND state='idle'
          AND query LIKE '%password_hash AS "passwordHash"%lower(email)=lower($1)%'`,
    )).rows[0].count),{timeout:5_000,intervals:[10,20,50]}).toBeGreaterThan(0);
    await database.query('BEGIN');
    await database.query("UPDATE hosts SET password_hash=$1,version=version+1 WHERE lower(email)='admin@aerstello.test'",[newHash]);
    await database.query("UPDATE host_sessions SET revoked_at=now() WHERE host_id=(SELECT id FROM hosts WHERE lower(email)='admin@aerstello.test') AND revoked_at IS NULL");
    await database.query('COMMIT');
    workflow.credentialRaceLoginStatuses=[(await login).status()];
    workflow.credentialRaceActiveSessions=Number((await database.query(
      "SELECT count(*) FROM host_sessions WHERE host_id=(SELECT id FROM hosts WHERE lower(email)='admin@aerstello.test') AND revoked_at IS NULL AND expires_at>now()",
    )).rows[0].count);
  }finally{await databaseResource.dispose()}
});

Then('the old-password login is rejected without creating a session',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.credentialRaceLoginStatuses).toEqual([401]);expect(workflow.credentialRaceActiveSessions).toBe(0)});
