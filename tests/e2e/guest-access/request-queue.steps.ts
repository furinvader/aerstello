import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('the public bootstrap request remains pending',async({resources, guestDevice, page})=>{
  await page.addInitScript(()=>{
    const originalFetch=window.fetch.bind(window);
    const state=window as unknown as {__aerstelloBootstrapOutage:{active:boolean;attempts:number;release?:()=>void}};
    state.__aerstelloBootstrapOutage={active:true,attempts:0};
    window.fetch=async(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(new URL(url,window.location.href).pathname==='/api/v1/public/bootstrap'&&state.__aerstelloBootstrapOutage.active){
        state.__aerstelloBootstrapOutage.attempts+=1;
        await new Promise<void>((resolve)=>{state.__aerstelloBootstrapOutage.release=resolve});
        return new Response(JSON.stringify({error:{code:'SERVICE_UNAVAILABLE',message:'Simulated bootstrap outage'}}),{status:503,headers:{'content-type':'application/json'}});
      }
      if(new URL(url,window.location.href).pathname==='/api/v1/public/bootstrap')state.__aerstelloBootstrapOutage.attempts+=1;
      return originalFetch(input,init);
    };
  });
  await page.goto('/guest/request');
});

Then('bootstrap loading is shown without the access form',async({resources, guestDevice, page})=>{
  await expect(page.getByText(/Wird geladen|Caricamento|Loading/)).toBeVisible();
  await expect(page.getByLabel(/Name|Nome/)).toHaveCount(0);
  await expect(page.getByRole('button',{name:/Zugang anfragen|Richiedi accesso|Request access/})).toHaveCount(0);
});

When('the public bootstrap request fails',async({resources, guestDevice, page})=>{
  await page.evaluate(()=>{
    const release=(window as unknown as {__aerstelloBootstrapOutage:{release?:()=>void}}).__aerstelloBootstrapOutage.release;
    if(!release)throw new Error('Bootstrap request was not pending');
    release();
  });
});

Then('bootstrap failure is localized and still hides the access form',async({resources, guestDevice, page})=>{
  await expect(page.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/);
  await expect(page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();
  await expect(page.getByLabel(/Name|Nome/)).toHaveCount(0);
});

When('the guest retries public bootstrap',async({resources, guestDevice, page})=>{
  const retry=page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/});
  await retry.evaluate((button)=>button.addEventListener('click',()=>{
    (window as unknown as {__aerstelloBootstrapOutage:{active:boolean}}).__aerstelloBootstrapOutage.active=false;
  },{capture:true,once:true}));
  await retry.click();
});

Then('the access form appears after bootstrap recovery',async({resources, guestDevice, page})=>{
  await expect(page.getByLabel(/Name|Nome/)).toBeVisible();
  await expect(page.getByRole('button',{name:/Zugang anfragen|Richiedi accesso|Request access/})).toBeEnabled();
  expect(await page.evaluate(()=>(window as unknown as {__aerstelloBootstrapOutage:{attempts:number}}).__aerstelloBootstrapOutage.attempts)).toBe(2);
});

When('the initial request queue load fails transiently',async({resources, guestDevice, page})=>{
  const request=page.context().request;
  const bootstrap=await (await request.get('/api/v1/public/bootstrap')).json() as {rooms:{id:string;name:string}[]};
  const room=bootstrap.rooms.find(item=>item.name==='102')!;
  expect((await request.post('/api/v1/public/access-requests',{data:{mutationId:crypto.randomUUID(),name:'Retry Queue Guest',roomId:room.id,language:'de'}})).status()).toBe(201);
  await page.addInitScript(()=>{
    const originalFetch=window.fetch.bind(window);
    const state=window as unknown as {__aerstelloRequestQueueOutage:{active:boolean;attempts:number}};
    state.__aerstelloRequestQueueOutage={active:true,attempts:0};
    window.fetch=async(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(new URL(url,window.location.href).pathname==='/api/v1/access-requests'){
        state.__aerstelloRequestQueueOutage.attempts+=1;
        if(state.__aerstelloRequestQueueOutage.active)return new Response(JSON.stringify({error:{code:'SERVICE_UNAVAILABLE',message:'Simulated request queue outage'}}),{status:503,headers:{'content-type':'application/json'}});
      }
      return originalFetch(input,init);
    };
  });
  await page.goto('/app/requests');
});
