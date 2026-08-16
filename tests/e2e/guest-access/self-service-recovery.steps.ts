import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { csrfHeaders } from '../support/operational-api-data';
import { stateFor } from './self-service-recovery.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('the same guest item mutation is submitted concurrently',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);const request=guestDevice.page.context().request;const catalog=await (await request.get('/api/v1/guest/catalog')).json() as {data:{id:string;name:{de:string};priceCents:number;version:number}[]};const product=catalog.data.find(item=>item.name.de==='Mineralwasser')!;const data={mutationId:crypto.randomUUID(),productId:product.id,expectedPriceCents:product.priceCents,expectedProductVersion:product.version};const responses=await Promise.all([request.post('/api/v1/guest/items',{headers:csrfHeaders,data}),request.post('/api/v1/guest/items',{headers:csrfHeaders,data})]);workflow.concurrentGuestItemStatuses=responses.map(response=>response.status());workflow.concurrentGuestItemCount=((await (await request.get('/api/v1/guest/tab')).json()) as {itemCount:number}).itemCount});

Then('both concurrent guest item responses succeed',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.concurrentGuestItemStatuses).toEqual([201,201])});

Then('the concurrent guest item is stored only once',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.concurrentGuestItemCount).toBe(1)});

When('one self-service addition remains pending while another product is added',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  await guestDevice.page.evaluate(()=>{
    const originalFetch=window.fetch.bind(window);
    const control:{requestCount:number;firstReleased:boolean;secondStartedBeforeFirstRelease:boolean;releaseFirst?:()=>void;releaseSecond?:()=>void}={requestCount:0,firstReleased:false,secondStartedBeforeFirstRelease:false};
    Object.assign(window,{__aerstelloPendingGuestAddControl:control});
    window.fetch=async(input,init)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      if(url.endsWith('/api/v1/guest/items')&&init?.method==='POST'){
        const requestIndex=++control.requestCount;
        if(requestIndex===2)control.secondStartedBeforeFirstRelease=!control.firstReleased;
        const response=await originalFetch(input,init);
        await new Promise<void>((resolve)=>{
          const release=()=>{if(requestIndex===1)control.firstReleased=true;resolve()};
          if(requestIndex===1)control.releaseFirst=release;
          if(requestIndex===2)control.releaseSecond=release;
        });
        return response;
      }
      return originalFetch(input,init);
    };
  });
  const first=guestDevice.page.locator('.product-tile').filter({hasText:'Mineralwasser'});
  const second=guestDevice.page.locator('.product-tile').filter({hasText:'Hauskeks'});
  await first.click();
  await expect.poll(()=>guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloPendingGuestAddControl:{requestCount:number}}).__aerstelloPendingGuestAddControl.requestCount)).toBe(1);
  await expect(first).toBeDisabled();
  const firstDisabledWhilePending=await first.isDisabled();
  const secondEnabledBeforeStart=await second.isEnabled();
  await second.click();
  await expect.poll(()=>guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloPendingGuestAddControl:{requestCount:number}}).__aerstelloPendingGuestAddControl.requestCount)).toBe(2);
  await expect(first).toBeDisabled();await expect(second).toBeDisabled();
  const bothDisabled=await first.isDisabled()&&await second.isDisabled();
  await expect.poll(()=>guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloPendingGuestAddControl:{releaseSecond?:()=>void}}).__aerstelloPendingGuestAddControl.releaseSecond!==undefined)).toBe(true);
  const secondStartedBeforeFirstRelease=await guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloPendingGuestAddControl:{secondStartedBeforeFirstRelease:boolean}}).__aerstelloPendingGuestAddControl.secondStartedBeforeFirstRelease);
  await guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloPendingGuestAddControl:{releaseSecond:()=>void}}).__aerstelloPendingGuestAddControl.releaseSecond());
  await expect(second).toBeEnabled();await expect(first).toBeDisabled();
  const secondEnabledAfterOwnSettle=await second.isEnabled();
  const firstDisabledAfterSecondSettled=await first.isDisabled();
  await guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloPendingGuestAddControl:{releaseFirst:()=>void}}).__aerstelloPendingGuestAddControl.releaseFirst());
  await expect(first).toBeEnabled();
  workflow.pendingGuestAddResult={secondStartedBeforeFirstRelease,firstDisabledWhilePending,secondEnabledBeforeStart,bothDisabled,firstDisabledAfterSecondSettled,secondEnabledAfterOwnSettle,firstEnabledAfterOwnSettle:await first.isEnabled()};
});

Then('the other product request begins before the first response is released',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.pendingGuestAddResult?.secondStartedBeforeFirstRelease).toBe(true)});

Then('each product is disabled only while its own addition is pending',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.pendingGuestAddResult).toEqual({secondStartedBeforeFirstRelease:true,firstDisabledWhilePending:true,secondEnabledBeforeStart:true,bothDisabled:true,firstDisabledAfterSecondSettled:true,secondEnabledAfterOwnSettle:true,firstEnabledAfterOwnSettle:true})});

When('one guest product fails while another product remains pending',async({resources, guestDevice})=>{
  await guestDevice.page.evaluate(()=>{
    const originalFetch=window.fetch.bind(window);
    const control:{requestCount:number;failureReleased:boolean;successReleased:boolean;failureMessage?:string;releaseFailure?:()=>void;releaseSuccess?:()=>void}={requestCount:0,failureReleased:false,successReleased:false};
    Object.assign(window,{__aerstelloGuestAddErrorControl:control});
    window.fetch=async(input,init)=>{
      const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
      if(url.endsWith('/api/v1/guest/items')&&init?.method==='POST'){
        const requestIndex=++control.requestCount;
        const response=await originalFetch(input,init);
        await new Promise<void>((resolve)=>{
          if(requestIndex===1)control.releaseFailure=resolve;
          if(requestIndex===2)control.releaseSuccess=resolve;
        });
        if(requestIndex===1){control.failureReleased=true;throw new TypeError('Simulated lost response')}
        control.successReleased=true;
        return response;
      }
      return originalFetch(input,init);
    };
  });
  const failed=guestDevice.page.locator('.product-tile').filter({hasText:'Mineralwasser'});
  const pending=guestDevice.page.locator('.product-tile').filter({hasText:'Hauskeks'});
  await failed.click();
  await expect.poll(()=>guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloGuestAddErrorControl:{releaseFailure?:()=>void}}).__aerstelloGuestAddErrorControl.releaseFailure!==undefined)).toBe(true);
  await pending.click();
  await expect.poll(()=>guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloGuestAddErrorControl:{releaseSuccess?:()=>void}}).__aerstelloGuestAddErrorControl.releaseSuccess!==undefined)).toBe(true);
  await guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloGuestAddErrorControl:{releaseFailure:()=>void}}).__aerstelloGuestAddErrorControl.releaseFailure());
  await expect(guestDevice.page.locator('.notice--error')).toBeVisible();
  await expect(failed).toBeEnabled();
  await expect(pending).toBeDisabled();
  const failureMessage=await guestDevice.page.locator('.notice--error').innerText();
  await guestDevice.page.evaluate((message)=>{(window as unknown as {__aerstelloGuestAddErrorControl:{failureMessage:string}}).__aerstelloGuestAddErrorControl.failureMessage=message},failureMessage);
});

Then('the guest product failure is visible before the other product settles',async({resources, guestDevice})=>{
  const state=await guestDevice.page.evaluate(()=>{const control=(window as unknown as {__aerstelloGuestAddErrorControl:{failureReleased:boolean;successReleased:boolean;failureMessage:string}}).__aerstelloGuestAddErrorControl;return {failureReleased:control.failureReleased,successReleased:control.successReleased,failureMessage:control.failureMessage}});
  expect(state).toMatchObject({failureReleased:true,successReleased:false});
  await expect(guestDevice.page.locator('.notice--error')).toHaveText(state.failureMessage);
});

When('the pending guest product succeeds',async({resources, guestDevice})=>{
  await guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloGuestAddErrorControl:{releaseSuccess:()=>void}}).__aerstelloGuestAddErrorControl.releaseSuccess());
  await expect(guestDevice.page.locator('.product-tile').filter({hasText:'Hauskeks'})).toBeEnabled();
  await expect(guestDevice.page.locator('.undo-toast').filter({hasText:'Hauskeks'})).toBeVisible();
});

Then('the guest product failure remains visible',async({resources, guestDevice})=>{
  const state=await guestDevice.page.evaluate(()=>{const control=(window as unknown as {__aerstelloGuestAddErrorControl:{successReleased:boolean;failureMessage:string}}).__aerstelloGuestAddErrorControl;return {successReleased:control.successReleased,failureMessage:control.failureMessage}});
  expect(state.successReleased).toBe(true);
  await expect(guestDevice.page.locator('.notice--error')).toHaveText(state.failureMessage);
});

When('one guest addition loses its response before another product is added',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  await guestDevice.page.evaluate(()=>{
    const originalFetch=window.fetch.bind(window);let loseResponse=true;const entries:{productId:string;mutationId:string}[]=[];
    Object.assign(window,{__aerstelloGuestAddRetryEntries:entries});
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/guest/items')&&init?.method==='POST'){const body=JSON.parse(String(init.body)) as {productId:string;mutationId:string};entries.push(body);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)};
  });
  await guestDevice.page.locator('.product-tile').getByText('Mineralwasser',{exact:true}).click();await expect(guestDevice.page.locator('.notice--error')).toBeVisible();await expect(guestDevice.page.locator('.undo-toast')).toHaveCount(1);
  await guestDevice.page.locator('.product-tile').getByText('Hauskeks',{exact:true}).click();await expect(guestDevice.page.locator('.undo-toast')).toHaveCount(2);
  await guestDevice.page.locator('.product-tile').getByText('Mineralwasser',{exact:true}).click();await expect(guestDevice.page.locator('.undo-toast')).toHaveCount(2);
  const entries=await guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloGuestAddRetryEntries:{productId:string;mutationId:string}[]}).__aerstelloGuestAddRetryEntries);
  workflow.retriedGuestAddMutationIds=[entries[0]!.mutationId,entries[2]!.mutationId];
  const tab=await (await guestDevice.page.context().request.get('/api/v1/guest/tab')).json() as {items:{productName:{de:string};quantity:number}[]};
  workflow.uncertainGuestProductCounts=Object.fromEntries(tab.items.map((item)=>[item.productName.de,item.quantity]));
});

Then('retrying the uncertain product reuses its mutation identifier',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedGuestAddMutationIds).toHaveLength(2);expect(new Set(workflow.retriedGuestAddMutationIds).size).toBe(1)});

Then('each selected self-service product is stored once',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.uncertainGuestProductCounts).toEqual(expect.objectContaining({Mineralwasser:1,Hauskeks:1}))});

When('the guest retries an addition after a committed HTTP timeout',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);await guestDevice.page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let returnTimeout=true;const ids:string[]=[];Object.assign(window,{__aerstelloGuestAddRetryIds:ids});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/guest/items')&&init?.method==='POST'){ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);const response=await originalFetch(input,init);if(returnTimeout){returnTimeout=false;return new Response(JSON.stringify({error:{code:'REQUEST_TIMEOUT',message:'The upstream response timed out.'}}),{status:408,headers:{'content-type':'application/json'}})}return response}return originalFetch(input,init)}});const product=guestDevice.page.locator('.product-tile').filter({hasText:'Mineralwasser'});await product.click();await expect(guestDevice.page.locator('.notice--error')).toBeVisible();await product.click();await expect(guestDevice.page.getByRole('button',{name:'Rückgängig'})).toBeVisible();workflow.retriedGuestAddMutationIds=await guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloGuestAddRetryIds:string[]}).__aerstelloGuestAddRetryIds);workflow.timeoutGuestItemCount=((await (await guestDevice.page.context().request.get('/api/v1/guest/tab')).json()) as {itemCount:number}).itemCount});

Then('both timed-out guest additions use the same mutation identifier',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedGuestAddMutationIds).toHaveLength(2);expect(new Set(workflow.retriedGuestAddMutationIds).size).toBe(1)});

Then('the timed-out self-service product is stored once',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.timeoutGuestItemCount).toBe(1)});

When('the guest closes the app after a self-service response is lost',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);
  await guestDevice.page.evaluate(()=>{
    const originalFetch=window.fetch.bind(window);const ids:string[]=[];Object.assign(window,{__aerstelloClosingGuestAddIds:ids});
    window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/guest/items')&&init?.method==='POST'){ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);await originalFetch(input,init);throw new TypeError('Simulated lost response')}return originalFetch(input,init)};
  });
  await guestDevice.page.locator('.product-tile').getByText('Mineralwasser',{exact:true}).click();
  await expect(guestDevice.page.locator('.notice--error')).toBeVisible();
  workflow.reopenedGuestAddMutationIds=await guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloClosingGuestAddIds:string[]}).__aerstelloClosingGuestAddIds);
  const reopenedPage=await guestDevice.reopen('/guest');await expect(reopenedPage.getByRole('heading',{name:'Luca Rossi'})).toBeVisible();
  await guestDevice.page.evaluate(()=>{const originalFetch=window.fetch.bind(window);const ids:string[]=[];Object.assign(window,{__aerstelloReopenedGuestAddIds:ids});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/guest/items')&&init?.method==='POST')ids.push((JSON.parse(String(init.body)) as {mutationId:string}).mutationId);return originalFetch(input,init)}});
  await guestDevice.page.locator('.product-tile').getByText('Mineralwasser',{exact:true}).click();
  await expect(guestDevice.page.getByRole('button',{name:'Rückgängig'})).toBeVisible();
  workflow.reopenedGuestAddMutationIds.push(...await guestDevice.page.evaluate(()=>(window as unknown as {__aerstelloReopenedGuestAddIds:string[]}).__aerstelloReopenedGuestAddIds));
  workflow.reopenedGuestAddItemCount=((await (await guestDevice.page.context().request.get('/api/v1/guest/tab')).json()) as {itemCount:number}).itemCount;
});

Then('reopening and retrying reuses the original item mutation identifier',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.reopenedGuestAddMutationIds).toHaveLength(2);expect(new Set(workflow.reopenedGuestAddMutationIds).size).toBe(1)});

Then('the recovered self-service product is stored once',async({resources, guestDevice,  scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.reopenedGuestAddItemCount).toBe(1)});
