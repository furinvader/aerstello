import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from './fixtures/test';
import { stateFor } from './localization-workflow-state';
import { createBrowserContext } from './support/browser-context';
import { connectDatabase } from './support/database';
import { csrfHeaders } from './support/operational-api-data';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('the host changes their language to Italian',async({resources, guestDevice, page})=>{await page.goto('/app/account');await page.getByLabel(/Sprache|Language/).selectOption('it');await page.getByRole('button',{name:/Speichern|Save/}).click()});

Then('the navigation is shown in Italian',async({resources, guestDevice, page})=>{await expect(page.getByText('Panoramica')).toBeVisible()});

When('the host changes their language to Italian and opens the product editor',async({resources, guestDevice, page})=>{await page.goto('/app/account');await page.getByLabel(/Sprache|Language/).selectOption('it');await page.getByRole('button',{name:/Speichern|Save/}).click();await expect(page.getByText('Panoramica')).toBeVisible();await page.goto('/app/products');await page.getByRole('button',{name:/Aggiungi/}).first().click()});

Then('the product name label is shown in Italian',async({resources, guestDevice, page})=>{await expect(page.getByLabel('Nome · DE')).toBeVisible()});

Then('the product category options are shown in Italian',async({resources, guestDevice, page})=>{await expect(page.getByLabel('Categoria').locator('option').first()).toHaveText('Bevande')});

When('the guest selects Italian',async({resources, guestDevice})=>{await guestDevice.page.getByLabel(/Sprache|Lingua|Language/).selectOption('it')});

Then('untranslated product content falls back to German',async({resources, guestDevice})=>{await expect(guestDevice.page.getByText('Hauskeks',{exact:true})).toBeVisible()});

When('the saved guest language conflicts with local language on launch',async({resources, guestDevice, page})=>{
  const request=page.context().request;
  const guests=await (await request.get('/api/v1/guests')).json() as {data:{id:string;name:string;roomId:string;language:string;version:number}[]};
  const guest=guests.data.find(item=>item.name==='Luca Rossi')!;
  expect((await request.patch(`/api/v1/guests/${guest.id}`,{headers:csrfHeaders,data:{name:guest.name,roomId:guest.roomId,language:'it',expectedVersion:guest.version}})).status()).toBe(200);
  await guestDevice.page.addInitScript(()=>{
    localStorage.setItem('aerstello-language','en');
    const state=window as unknown as {__aerstelloFirstGuestShellLanguage?:string};
    new MutationObserver(()=>{
      if(!state.__aerstelloFirstGuestShellLanguage&&document.querySelector('.guest-shell'))state.__aerstelloFirstGuestShellLanguage=document.documentElement.lang;
    }).observe(document,{childList:true,subtree:true});
  });
  await guestDevice.page.reload();
});

Then('the authenticated guest shell uses the saved language',async({resources, guestDevice})=>{
  await expect(guestDevice.page.getByLabel('Lingua')).toHaveValue('it');
  await expect(guestDevice.page.getByRole('heading',{name:'Ordini aperti'})).toBeVisible();
  expect(await guestDevice.page.evaluate(()=>localStorage.getItem('aerstello-language'))).toBe('it');
  expect(await guestDevice.page.evaluate(()=>document.documentElement.lang)).toBe('it');
  expect(await guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloFirstGuestShellLanguage?:string}).__aerstelloFirstGuestShellLanguage)).toBe('it');
});

When('the guest manually changes language before an unchanged identity refetch',async({resources, guestDevice, page})=>{
  await guestDevice.page.getByLabel('Lingua').selectOption('en');
  const identityRefetch=guestDevice.page.waitForResponse(response=>response.url().endsWith('/api/v1/guest/me')&&response.request().method()==='GET');
  const request=page.context().request;
  const guests=await (await request.get('/api/v1/guests')).json() as {data:{id:string;name:string;roomId:string;language:string;version:number}[]};
  const guest=guests.data.find(item=>item.name==='Luca Rossi')!;
  expect(guest.language).toBe('it');
  expect((await request.patch(`/api/v1/guests/${guest.id}`,{headers:csrfHeaders,data:{name:guest.name,roomId:guest.roomId,language:guest.language,expectedVersion:guest.version}})).status()).toBe(200);
  await identityRefetch;
});

Then('the manual guest language remains selected',async({resources, guestDevice})=>{
  await expect(guestDevice.page.getByLabel('Language')).toHaveValue('en');
  await expect(guestDevice.page.getByRole('heading',{name:'Open orders'})).toBeVisible();
  expect(await guestDevice.page.evaluate(()=>localStorage.getItem('aerstello-language'))).toBe('en');
  expect(await guestDevice.page.evaluate(()=>document.documentElement.lang)).toBe('en');
});

When('the venue default language is Italian',async({resources, guestDevice, scenarioState, page,browser})=>{const workflow=stateFor(scenarioState);const request=page.context().request;const venue=await (await request.get('/api/v1/venue')).json() as {name:string;timezone:string;version:number};expect((await request.put('/api/v1/venue',{headers:csrfHeaders,data:{name:venue.name,timezone:venue.timezone,language:'it',expectedVersion:venue.version}})).status()).toBe(200);const context=await createBrowserContext(resources,browser,{baseURL:e2eBaseURL,locale:'en-US'});workflow.freshGuestPage=await context.newPage();await workflow.freshGuestPage.goto('/guest/request')});

Then('a fresh English guest device starts in Italian',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);await expect(workflow.freshGuestPage!.getByRole('heading',{name:'Accesso ospite'})).toBeVisible()});

When('a fresh guest selects Italian on the access form',async({resources, guestDevice, page})=>{await page.goto('/guest/request');await page.locator('form select').nth(1).selectOption('it')});

Then('the guest name field is labeled in Italian',async({resources, guestDevice, page})=>{await expect(page.getByLabel('Nome')).toBeVisible()});

When('an Italian administrator opens first-time venue setup',async({resources, guestDevice, page})=>{const databaseResource=await connectDatabase(resources);const database=databaseResource.client;try{await database.query("UPDATE hosts SET language='it' WHERE lower(email)='admin@aerstello.test'");await database.query("UPDATE venue_settings SET name='' WHERE id=1")}finally{await databaseResource.dispose()}await page.goto('/app/settings');await expect(page.getByRole('heading',{name:'Locale',exact:true})).toBeVisible()});

Then('the empty venue label is shown in Italian',async({resources, guestDevice, page})=>{await expect(page.locator('.brand strong')).toHaveText('Configura locale')});
