import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from './fixtures/test';
import { csrfHeaders } from './support/operational-api-data';
import { installQueryOutage,releaseQueryOutage,restoreQueryOutage,retryQueryOutage } from './support/query-outage';
import { stateFor } from './venue-workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('the administrator changes the venue name to {string}', async ({resources,  page }, name:string) => { await page.goto('/app/settings');await page.getByLabel('Name des Betriebs').fill(name);await page.getByRole('button',{name:'Speichern'}).click(); });

Then('the navigation shows the venue name {string}', async ({resources,  page }, name:string) => { await expect(page.locator('.brand strong')).toHaveText(name); });

When('the administrator opens venue settings', async ({resources,  page }) => { await page.goto('/app/settings'); });

Then('a venue QR code and room QR codes are shown', async ({resources,  page }) => { await expect(page.locator('.qr-code')).toHaveCount(4); });

When('the room QR directory remains pending',async({resources, page})=>{
  await page.addInitScript(()=>{Object.assign(window,{__aerstelloPrintCount:0});window.print=()=>{(window as unknown as {__aerstelloPrintCount:number}).__aerstelloPrintCount+=1}});
  await installQueryOutage(page,['/api/v1/rooms']);
  await page.goto('/app/settings');
});

Then('room QR loading hides empty cards and disables printing',async({resources, page})=>{
  await expect(page.getByRole('heading',{name:/Zimmer-QR-Codes|Codici QR delle camere|Room QR codes/})).toBeVisible();
  await expect(page.getByText(/Wird geladen|Caricamento|Loading/)).toBeVisible();
  await expect(page.locator('.qr-code')).toHaveCount(1);
  await expect(page.locator('.empty')).toHaveCount(0);
  await expect(page.getByRole('button',{name:/Drucken|Stampa|Print/})).toBeDisabled();
  await page.getByRole('button',{name:/Drucken|Stampa|Print/}).click({force:true});
  expect(await page.evaluate(()=>(window as unknown as {__aerstelloPrintCount:number}).__aerstelloPrintCount)).toBe(0);
});

When('the pending room QR directory fails',async({resources, page})=>{await releaseQueryOutage(page)});

Then('room QR failure and retry preserve venue controls and disable printing',async({resources, page})=>{
  await expect(page.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/);
  await expect(page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();
  await expect(page.getByLabel(/Name des Betriebs|Nome del locale|Venue name/)).toBeEnabled();
  await expect(page.getByRole('button',{name:/Speichern|Salva|Save/,exact:true})).toBeEnabled();
  await expect(page.locator('.qr-code')).toHaveCount(1);
  await expect(page.locator('.empty')).toHaveCount(0);
  await expect(page.getByRole('button',{name:/Drucken|Stampa|Print/})).toBeDisabled();
});

When('the administrator retries the room QR directory',async({resources, page})=>{
  await retryQueryOutage(page,page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}));
});

Then('room QR cards recover and printing is enabled',async({resources, page})=>{
  await expect(page.locator('.qr-code')).toHaveCount(4);
  await expect(page.getByRole('heading',{name:'101'})).toBeVisible();
  const print=page.getByRole('button',{name:/Drucken|Stampa|Print/});
  await expect(print).toBeEnabled();
  await print.click();
  expect(await page.evaluate(()=>(window as unknown as {__aerstelloPrintCount:number}).__aerstelloPrintCount)).toBe(1);
  await restoreQueryOutage(page);
});

When('venue settings loads a successful empty room QR directory',async({resources, page})=>{
  await page.addInitScript(()=>{Object.assign(window,{__aerstelloPrintCount:0});window.print=()=>{(window as unknown as {__aerstelloPrintCount:number}).__aerstelloPrintCount+=1}});
  await page.addInitScript(()=>{
    const originalFetch=window.fetch.bind(window);
    const state={restore:()=>{window.fetch=originalFetch}};
    Object.assign(window,{__aerstelloEmptyRooms:state});
    window.fetch=async(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(new URL(url,window.location.href).pathname==='/api/v1/rooms')return new Response(JSON.stringify({data:[]}),{status:200,headers:{'content-type':'application/json'}});
      return originalFetch(input,init);
    };
  });
  await page.goto('/app/settings');
});

Then('the room QR empty state appears without failure and printing is enabled',async({resources, page})=>{
  await expect(page.locator('.empty')).toContainText(/Noch keine Einträge|Nessun elemento|Nothing here yet/);
  await expect(page.locator('.notice--error')).toHaveCount(0);
  await expect(page.locator('.qr-code')).toHaveCount(1);
  const print=page.getByRole('button',{name:/Drucken|Stampa|Print/});
  await expect(print).toBeEnabled();
  await print.click();
  expect(await page.evaluate(()=>(window as unknown as {__aerstelloPrintCount:number}).__aerstelloPrintCount)).toBe(1);
  await page.evaluate(()=>{
    const state=(window as unknown as {__aerstelloEmptyRooms:{restore:()=>void}}).__aerstelloEmptyRooms;
    state.restore();
    delete (window as unknown as {__aerstelloEmptyRooms?:unknown}).__aerstelloEmptyRooms;
  });
});

Then('venue settings is available in the primary navigation', async ({resources,  page }) => { await expect(page.getByRole('link',{name:'Betrieb'})).toBeVisible(); });

When('the initial venue load fails transiently',async({resources, page})=>{
  await page.addInitScript(()=>{
    const originalFetch=window.fetch.bind(window);
    const state=window as unknown as {__aerstelloVenueLoadOutage:{active:boolean;attempts:number}};
    state.__aerstelloVenueLoadOutage={active:true,attempts:0};
    window.fetch=async(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(new URL(url,window.location.href).pathname==='/api/v1/venue'){
        state.__aerstelloVenueLoadOutage.attempts+=1;
        if(state.__aerstelloVenueLoadOutage.active)return new Response(JSON.stringify({error:{code:'SERVICE_UNAVAILABLE',message:'Simulated venue outage'}}),{status:503,headers:{'content-type':'application/json'}});
      }
      return originalFetch(input,init);
    };
  });
  await page.goto('/app/settings');
});

Then('venue settings shows a localized failure with retry',async({resources, page})=>{
  await expect(page.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/);
  await expect(page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();
  await expect(page.getByLabel(/Name des Betriebs|Nome del locale|Venue name/)).toHaveCount(0);
});

When('the administrator retries the venue load',async({resources, page})=>{
  const retry=page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/});
  await retry.evaluate((button)=>button.addEventListener('click',()=>{
    (window as unknown as {__aerstelloVenueLoadOutage:{active:boolean}}).__aerstelloVenueLoadOutage.active=false;
  },{capture:true,once:true}));
  await retry.click();
});

Then('editable venue settings appear after recovery',async({resources, page})=>{
  await expect(page.getByLabel(/Name des Betriebs|Nome del locale|Venue name/)).toHaveValue('Hotel Aurora');
  await expect(page.getByRole('button',{name:/Speichern|Salva|Save/,exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>(window as unknown as {__aerstelloVenueLoadOutage:{attempts:number}}).__aerstelloVenueLoadOutage.attempts)).toBeGreaterThanOrEqual(2);
});

When('a venue update response is lost before another administrator edits it',async({resources, scenarioState, page})=>{const workflow=stateFor(scenarioState);const request=page.context().request;const original=await (await request.get('/api/v1/venue')).json() as {name:string;defaultLanguage:string;timezone:string;version:number};const command={name:'First venue update',language:original.defaultLanguage,timezone:original.timezone,expectedVersion:original.version};const committed=await (await request.put('/api/v1/venue',{headers:csrfHeaders,data:command})).json() as {version:number};expect((await request.put('/api/v1/venue',{headers:csrfHeaders,data:{...command,name:'Newer venue update',expectedVersion:committed.version}})).status()).toBe(200);workflow.staleVenueUpdateStatus=(await request.put('/api/v1/venue',{headers:csrfHeaders,data:command})).status();workflow.staleVenueFinalName=((await (await request.get('/api/v1/venue')).json()) as {name:string}).name});

Then('retrying the stale venue update is rejected',async({resources,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleVenueUpdateStatus).toBe(409)});

Then('the newer venue name remains configured',async({resources,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleVenueFinalName).toBe('Newer venue update')});

When('the administrator submits an invalid venue time zone',async({resources, scenarioState, page})=>{const workflow=stateFor(scenarioState);const request=page.context().request;const before=await (await request.get('/api/v1/venue')).json() as {name:string;defaultLanguage:string;timezone:string};workflow.venueTimezoneBefore=before.timezone;await page.goto('/app/settings');await page.getByLabel(/Zeitzone|Fuso orario|Time zone/).fill('Europe/Definitely-Not-A-Zone');const response=page.waitForResponse(candidate=>candidate.url().endsWith('/api/v1/venue')&&candidate.request().method()==='PUT');await page.getByRole('button',{name:/Speichern|Salva|Save/,exact:true}).click();workflow.invalidTimezoneStatus=(await response).status();await expect(page.locator('.notice--error')).toBeVisible();workflow.venueTimezoneAfter=((await (await request.get('/api/v1/venue')).json()) as {timezone:string}).timezone});

Then('the venue time zone is rejected without changing the settings',async({resources, scenarioState, page})=>{const workflow=stateFor(scenarioState);expect(workflow.invalidTimezoneStatus).toBe(400);expect(workflow.venueTimezoneAfter).toBe(workflow.venueTimezoneBefore);await expect(page.locator('.notice--error')).toContainText(/Eingaben prüfen|dati inseriti|entered information/)});
