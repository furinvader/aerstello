import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { signIn } from '../authentication/sign-in';
import { test } from '../fixtures/test';
import { createBrowserContext } from '../support/browser-context';
import { registerBrowserStream } from '../support/browser-stream';
import { connectDatabase } from '../support/database';
import { csrfHeaders } from '../support/operational-api-data';
import { stateFor } from './guest-devices.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

Given('an approved guest device for {string} in room {string}',async({resources, guestDevice, page},name:string,room:string)=>{
  await signIn(page);
  const guestPage=await guestDevice.create();
  await guestPage.goto('/guest/request');
  await guestPage.locator('form select').nth(1).selectOption('de');
  await guestPage.getByLabel('Name').fill(name);
  await guestPage.locator('form select').first().selectOption({label:room});
  await guestPage.locator('form button[type="submit"]').click();
  await page.goto('/app/requests');
  await page.getByRole('button',{name:/Genehmigen|Approve/}).click();
  await page.locator('.modal').getByRole('button',{name:/Genehmigen|Approve/}).click();
  await expect(guestPage).toHaveURL(/\/guest$/,{timeout:10000});
});

When('a transient guest identity outage occurs during app launch',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  const request=guestDevice.page.context().request;
  const identity=await (await request.get('/api/v1/guest/me')).json() as {guest:{sessionId:string}};
  const catalog=await (await request.get('/api/v1/guest/catalog')).json() as {data:{id:string;priceCents:number;version:number}[]};
  const product=catalog.data[0]!;
  workflow.transientGuestPendingState=JSON.stringify({sessionId:identity.guest.sessionId,entries:[[product.id,crypto.randomUUID(),product.priceCents,product.version]]});
  await guestDevice.page.evaluate((pending)=>localStorage.setItem('aerstello-guest-pending-adds',pending),workflow.transientGuestPendingState);
  await guestDevice.page.addInitScript(()=>{
    const originalFetch=window.fetch.bind(window);
    const state=window as unknown as {__aerstelloTransientGuestIdentityRequests:number};
    state.__aerstelloTransientGuestIdentityRequests=0;
    window.fetch=async(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(new URL(url,window.location.href).pathname==='/api/v1/guest/me'){
        state.__aerstelloTransientGuestIdentityRequests+=1;
        if(state.__aerstelloTransientGuestIdentityRequests===1)return new Response(JSON.stringify({error:{code:'SERVICE_UNAVAILABLE',message:'Simulated guest identity outage'}}),{status:503,headers:{'content-type':'application/json'}});
      }
      return originalFetch(input,init);
    };
  });
  await guestDevice.page.reload();
});

Then('the guest remains on the guest page with a retry action',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  await expect(guestDevice.page).toHaveURL(/\/guest$/);
  await expect(guestDevice.page.locator('.notice--error')).toContainText('Die Anfrage konnte nicht abgeschlossen werden.');
  await expect(guestDevice.page.getByRole('button',{name:'Erneut versuchen'})).toBeVisible();
  expect(await guestDevice.page.evaluate(()=>localStorage.getItem('aerstello-guest-pending-adds'))).toBe(workflow.transientGuestPendingState);
});

When('the guest retries the identity request',async({resources, guestDevice})=>{await guestDevice.page.getByRole('button',{name:'Erneut versuchen'}).click()});

Then("Luca's guest application opens with persisted guest state intact",async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  await expect(guestDevice.page.getByRole('heading',{name:'Luca Rossi'})).toBeVisible();
  expect(await guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloTransientGuestIdentityRequests:number}).__aerstelloTransientGuestIdentityRequests)).toBe(2);
  expect(await guestDevice.page.evaluate(()=>localStorage.getItem('aerstello-guest-pending-adds'))).toBe(workflow.transientGuestPendingState);
});

When('the guest logs out and the committed response is lost',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  await guestDevice.page.evaluate(()=>{const originalFetch=window.fetch.bind(window);window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/guest/logout')&&init?.method==='POST'){await originalFetch(input,init);throw new TypeError('Simulated lost guest logout response')}return originalFetch(input,init)}});
  await guestDevice.page.getByRole('button',{name:/Abmelden|Esci|Log out/}).click();
  await expect(guestDevice.page).toHaveURL(/\/guest\/request$/);
  workflow.replayedGuestLogoutStatus=(await guestDevice.page.context().request.post('/api/v1/guest/logout',{headers:csrfHeaders})).status();
});

Then('the guest reaches access request without cached data',async({resources, guestDevice})=>{await expect(guestDevice.page).toHaveURL(/\/guest\/request$/);await expect(guestDevice.page.getByRole('heading',{name:'Luca Rossi'})).toHaveCount(0)});

Then('replaying guest logout for the revoked session succeeds',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.replayedGuestLogoutStatus).toBe(204)});

When('the guest tab service is unavailable',async({resources, guestDevice})=>{await guestDevice.page.addInitScript(()=>{const fetch=window.fetch.bind(window);window.fetch=(input,init)=>{const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);if(new URL(url,window.location.href).pathname==='/api/v1/guest/tab')return Promise.reject(new TypeError('Simulated guest tab outage'));return fetch(input,init)}});await guestDevice.page.reload();await expect(guestDevice.page.locator('.guest-total')).toContainText('Die Anfrage konnte nicht abgeschlossen werden.',{timeout:10_000})});

Then('the guest sees an error without a zero balance or empty order',async({resources, guestDevice})=>{await expect(guestDevice.page.locator('.guest-total')).not.toContainText(/0[,.]00\s*€/);const orders=guestDevice.page.locator('.guest-tabs>section').nth(1);await expect(orders.locator('.notice--error')).toBeVisible();await expect(orders.locator('.empty')).toHaveCount(0)});

When("the host revokes Luca's device from the guest directory",async({resources, guestDevice, page})=>{await page.goto('/app/guests');const row=page.locator('.table-row').filter({hasText:'Luca Rossi'});await row.getByRole('button',{name:/Angemeldete Geräte|Dispositivi connessi|Logged-in devices/}).click();await expect(page.locator('.modal .device-list')).toBeVisible();await page.locator('.modal').getByRole('button',{name:/Widerrufen|Revoca|Revoke/}).click();await expect(page.locator('.modal .device-list')).toHaveCount(0)});

Then("Luca's revoked device loses guest access",async({resources, guestDevice})=>{const guestRevokedStatus=(await guestDevice.page.context().request.get('/api/v1/guest/me')).status();expect(guestRevokedStatus).toBe(401)});

When('the guest device directory fails to load',async({resources, guestDevice, page})=>{
  await page.addInitScript(()=>{
    const originalFetch=window.fetch.bind(window);
    const state=window as unknown as {__aerstelloGuestDeviceOutage:{active:boolean;attempts:number}};
    state.__aerstelloGuestDeviceOutage={active:true,attempts:0};
    window.fetch=async(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(/^\/api\/v1\/guests\/[^/]+\/sessions$/.test(new URL(url,window.location.href).pathname)){
        state.__aerstelloGuestDeviceOutage.attempts+=1;
        if(state.__aerstelloGuestDeviceOutage.active)return new Response(JSON.stringify({error:{code:'SERVICE_UNAVAILABLE',message:'Simulated guest device outage'}}),{status:503,headers:{'content-type':'application/json'}});
      }
      return originalFetch(input,init);
    };
  });
  await page.goto('/app/guests');
  const row=page.locator('.table-row').filter({hasText:'Luca Rossi'});
  await row.getByRole('button',{name:/Angemeldete Geräte|Dispositivi connessi|Logged-in devices/}).click();
});

Then('the guest device failure is localized instead of empty',async({resources, guestDevice, page})=>{
  const modal=page.locator('.modal');
  await expect(modal.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/);
  await expect(modal.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();
  await expect(modal.locator('.empty')).toHaveCount(0);
  await expect(modal.locator('.device-list')).toHaveCount(0);
});

When('the host retries the guest device directory',async({resources, guestDevice, page})=>{
  const retry=page.locator('.modal').getByRole('button',{name:/Erneut versuchen|Riprova|Retry/});
  await retry.evaluate((button)=>button.addEventListener('click',()=>{
    (window as unknown as {__aerstelloGuestDeviceOutage:{active:boolean}}).__aerstelloGuestDeviceOutage.active=false;
  },{capture:true,once:true}));
  await retry.click();
});

Then("Luca's device appears after guest device recovery",async({resources, guestDevice, page})=>{
  const modal=page.locator('.modal');
  await expect(modal.locator('.device-list')).toBeVisible();
  await expect(modal.getByRole('button',{name:/Widerrufen|Revoca|Revoke/})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {__aerstelloGuestDeviceOutage:{attempts:number}}).__aerstelloGuestDeviceOutage.attempts)).toBeGreaterThanOrEqual(2);
});

When("another host revokes Luca's device while the first host's device list is open",async({resources, guestDevice, page, browser})=>{
  await page.goto('/app/guests');
  const row=page.locator('.table-row').filter({hasText:'Luca Rossi'});
  await row.getByRole('button',{name:/Angemeldete Geräte|Dispositivi connessi|Logged-in devices/}).click();
  await expect(page.locator('.modal .device-list')).toBeVisible();
  const firstHost=page.context().request;
  const guests=await (await firstHost.get('/api/v1/guests')).json() as {data:{id:string;name:string}[]};
  const luca=guests.data.find(guest=>guest.name==='Luca Rossi')!;
  const sessions=await (await firstHost.get(`/api/v1/guests/${luca.id}/sessions`)).json() as {data:{id:string}[]};
  expect((await firstHost.post('/api/v1/hosts',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),email:'guest-device-revoker@aerstello.test',name:'Guest Device Revoker',password:'GuestDeviceRevoker123!',role:'staff',language:'de'}})).status()).toBe(201);
  const other=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL});

  expect((await other.request.post('/api/v1/auth/login',{data:{email:'guest-device-revoker@aerstello.test',password:'GuestDeviceRevoker123!'}})).status()).toBe(200);
  expect((await other.request.delete(`/api/v1/guests/${luca.id}/sessions/${sessions.data[0]!.id}`,{headers:csrfHeaders})).status()).toBe(204);
});

Then("the first host's open guest device list updates",async({resources, guestDevice, page})=>{await expect(page.locator('.modal .device-list')).toHaveCount(0,{timeout:10_000})});

When("the host repeats revocation of Luca's device",async({resources, guestDevice, scenarioState, page})=>{const workflow=stateFor(scenarioState);const request=page.context().request;const guests=await (await request.get('/api/v1/guests')).json() as {data:{id:string;name:string}[]};const luca=guests.data.find(guest=>guest.name==='Luca Rossi')!;const other=guests.data.find(guest=>guest.id!==luca.id)!;const sessions=await (await request.get(`/api/v1/guests/${luca.id}/sessions`)).json() as {data:{id:string}[]};const sessionId=sessions.data[0]!.id;workflow.repeatedGuestSessionRevokeStatuses=[(await request.delete(`/api/v1/guests/${luca.id}/sessions/${sessionId}`,{headers:csrfHeaders})).status(),(await request.delete(`/api/v1/guests/${luca.id}/sessions/${sessionId}`,{headers:csrfHeaders})).status()];workflow.mismatchedGuestSessionRevokeStatus=(await request.delete(`/api/v1/guests/${other.id}/sessions/${sessionId}`,{headers:csrfHeaders})).status();const databaseResource=await connectDatabase(resources);const database=databaseResource.client;try{workflow.guestSessionRevokeAuditCount=Number((await database.query("SELECT count(*)::int AS count FROM audit_events WHERE action='guest-session.revoked' AND entity_id=$1",[sessionId])).rows[0]?.count??0)}finally{await databaseResource.dispose()}});

Then('both revocation requests succeed with one audit record',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.repeatedGuestSessionRevokeStatuses).toEqual([204,204]);expect(workflow.guestSessionRevokeAuditCount).toBe(1)});

Then('the device cannot be revoked through another guest',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.mismatchedGuestSessionRevokeStatus).toBe(404)});

Then("Luca's open guest view returns to access request without cached data",async({resources, guestDevice})=>{await expect(guestDevice.page).toHaveURL(/\/guest\/request$/,{timeout:10_000});await expect(guestDevice.page.getByText('Luca Rossi',{exact:true})).toHaveCount(0)});

When('the host renames Luca to {string}',async({resources, guestDevice, page},name:string)=>{const request=page.context().request;const guests=await (await request.get('/api/v1/guests')).json() as {data:{id:string;name:string;roomId:string;language:string;version:number}[]};const luca=guests.data.find((item)=>item.name==='Luca Rossi')!;expect((await request.patch(`/api/v1/guests/${luca.id}`,{headers:csrfHeaders,data:{name,roomId:luca.roomId,language:luca.language,expectedVersion:luca.version}})).status()).toBe(200)});

Then("Luca's open guest view shows {string}",async({resources, guestDevice},name:string)=>{await expect(guestDevice.page.getByRole('heading',{name})).toBeVisible({timeout:10_000})});

When('the guest opens a guest-scoped event stream while also authenticated as a host',async({resources, guestDevice, scenarioState, page})=>{const workflow=stateFor(scenarioState);
  expect((await guestDevice.page.context().request.post('/api/v1/auth/login',{data:{email:'admin@aerstello.test',password:'AerstelloTest123!'}})).status()).toBe(200);
  const guestPage=guestDevice.page;
  registerBrowserStream(resources,'guest-scoped event stream',async()=>{
    if(guestPage.isClosed())return;
    try{await guestPage.evaluate(()=>{
      (window as unknown as {__aerstelloGuestScopedStream?:EventSource}).__aerstelloGuestScopedStream?.close();
    })}catch(error){if(!guestPage.isClosed())throw error}
  });
  await guestPage.evaluate(()=>new Promise<void>((resolve,reject)=>{
    const received:{topic:string;payload:unknown}[]=[];
    Object.assign(window,{__aerstelloGuestScopedEvents:received});
    const events=new EventSource('/api/v1/events?scope=guest');
    Object.assign(window,{__aerstelloGuestScopedStream:events});
    for(const topic of ['orders.changed','bills.changed'])events.addEventListener(topic,(rawEvent)=>{
      const event=rawEvent as MessageEvent<string>;
      received.push({topic,payload:JSON.parse(event.data) as unknown});
    });
    events.addEventListener('open',()=>resolve(),{once:true});
    events.addEventListener('error',()=>{if(events.readyState===EventSource.CLOSED)reject(new Error('Guest-scoped test stream closed before opening'))},{once:true});
  }));
  const hostRequest=page.context().request;
  const ownGuest=await (await guestDevice.page.context().request.get('/api/v1/guest/me')).json() as {guest:{id:string}};
  const guests=await (await hostRequest.get('/api/v1/guests')).json() as {data:{id:string;name:string}[]};
  const otherGuest=guests.data.find(guest=>guest.id!==ownGuest.guest.id)!;
  const databaseResource=await connectDatabase(resources);const database=databaseResource.client;
  try{
    await database.query(
      `INSERT INTO realtime_events(topic,payload) VALUES
       ('orders.changed',$1),('orders.changed',$2),('bills.changed',$3)`,
      [JSON.stringify({guestId:ownGuest.guest.id,marker:'own'}),JSON.stringify({guestId:otherGuest.id,marker:'other'}),JSON.stringify({marker:'host-only'})],
    );
  }finally{await databaseResource.dispose()}
  await expect.poll(()=>guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloGuestScopedEvents:unknown[]}).__aerstelloGuestScopedEvents.length),{timeout:5_000}).toBe(1);
  await guestDevice.page.waitForTimeout(500);
  workflow.guestScopedEvents=await guestDevice.page.evaluate(()=>{
    const state=window as unknown as {__aerstelloGuestScopedEvents:{topic:string;payload:unknown}[];__aerstelloGuestScopedStream:EventSource};
    state.__aerstelloGuestScopedStream.close();
    return state.__aerstelloGuestScopedEvents;
  });
});

Then('the guest stream receives only its own payload-free order event',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.guestScopedEvents).toEqual([{topic:'orders.changed',payload:{}}])});
