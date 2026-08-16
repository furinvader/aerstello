import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { csrfHeaders } from '../support/operational-api-data';
import { installQueryOutage,releaseQueryOutage,restoreQueryOutage,retryQueryOutage } from '../support/query-outage';
import { stateFor } from './catalog.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('catalog administration remains pending',async({page})=>{
  await installQueryOutage(page,['/api/v1/products','/api/v1/categories']);
  await page.goto('/app/products');
});

Then('catalog loading hides empty and mutation controls',async({page})=>{
  await expect(page.getByText(/Wird geladen|Caricamento|Loading/)).toBeVisible();
  await expect(page.locator('.empty,.catalog-admin,.inline-form,.product-admin-list')).toHaveCount(0);
  await expect(page.getByRole('button',{name:/Hinzufügen|Aggiungi|Add/})).toHaveCount(0);
});

When('the pending catalog administration request fails',async({page})=>{await releaseQueryOutage(page)});

Then('catalog failure and retry are localized without mutation controls',async({page})=>{
  await expect(page.locator('.notice--error')).toContainText(/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/);
  await expect(page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/})).toBeVisible();
  await expect(page.locator('.empty,.catalog-admin,.inline-form,.product-admin-list')).toHaveCount(0);
});

When('the administrator retries catalog administration',async({page})=>{
  await retryQueryOutage(page,page.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}));
});

Then('recovered catalog names, counts, rows, and creation controls appear',async({page})=>{
  await expect(page.getByText('Helles',{exact:true})).toBeVisible();
  const category=page.locator('.category-list>div').filter({hasText:'Getränke'});
  await expect(category).toBeVisible();
  await expect(category.locator('span')).toHaveText('2');
  await expect(page.getByPlaceholder(/Deutscher Name|Nome tedesco|German name/)).toBeEnabled();
  await expect(page.getByRole('button',{name:/Hinzufügen|Aggiungi|Add/})).toBeEnabled();
  await restoreQueryOutage(page);
});

When('the administrator retries category creation after its first response is lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await page.goto('/app/products');await page.getByPlaceholder(/Deutscher Name|Nome tedesco|German name/).fill('Recoverable category');await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let loseResponse=true;const commands:Record<string,unknown>[]=[];Object.assign(window,{__aerstelloCategoryCreateCommands:commands});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/categories')&&init?.method==='POST'){commands.push(JSON.parse(String(init.body)) as Record<string,unknown>);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)}});const form=page.locator('.inline-form');await form.getByRole('button').click();await expect(page.locator('.notice--error')).toBeVisible();workflow.uncertainCategoryFieldsLocked=await form.locator('input').isDisabled();await form.getByRole('button').click();await expect(page.getByText('Recoverable category',{exact:true})).toBeVisible();const commands=await page.evaluate(()=>(window as unknown as {__aerstelloCategoryCreateCommands:Array<Record<string,unknown>>}).__aerstelloCategoryCreateCommands);workflow.retriedCategoryMutationIds=commands.map(command=>String(command.mutationId));const categories=await (await page.context().request.get('/api/v1/categories')).json() as {data:{name:{de:string}}[]};workflow.recoverableCategoryCount=categories.data.filter(category=>category.name.de==='Recoverable category').length;workflow.changedCategoryCreationReplayStatus=(await page.context().request.post('/api/v1/categories',{headers:csrfHeaders,data:{...commands[0]!,name:{de:'Changed recoverable category',it:'',en:''}}})).status()});

Then('both category creation attempts use the same mutation identifier',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedCategoryMutationIds).toHaveLength(2);expect(new Set(workflow.retriedCategoryMutationIds).size).toBe(1)});

Then('the uncertain category name stays locked for retry',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.uncertainCategoryFieldsLocked).toBe(true)});

Then('only one recoverable category exists',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.recoverableCategoryCount).toBe(1)});

Then('changing the replayed category creation is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.changedCategoryCreationReplayStatus).toBe(409)});

When('the administrator creates the self-service product {string} priced {string}',async({page},name:string,price:string)=>{await page.goto('/app/products');await page.getByRole('button',{name:/Hinzufügen/}).first().click();await page.getByLabel('Name · DE').fill(name);await page.getByLabel(/Preis · EUR|Prezzo · EUR|Price · EUR/).fill(price);await page.locator('.modal').getByText(/Selbstbedienung|Self-service/,{exact:true}).click();await page.locator('.modal').getByRole('button',{name:'Speichern'}).click()});

Then('product {string} is listed as self-service',async({page},name:string)=>{const row=page.locator('.product-admin-list>button').filter({hasText:name});await expect(row).toContainText('Selbstbedienung')});

When('the administrator retries product creation after its first response is lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await page.goto('/app/products');await page.getByRole('button',{name:/Hinzufügen|Aggiungi|Add/}).first().click();await page.getByLabel('Name · DE').fill('Recoverable product');await page.getByLabel(/Preis · EUR|Prezzo · EUR|Price · EUR/).fill('4.20');await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let loseResponse=true;const commands:Record<string,unknown>[]=[];Object.assign(window,{__aerstelloProductCreateCommands:commands});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.endsWith('/api/v1/products')&&init?.method==='POST'){commands.push(JSON.parse(String(init.body)) as Record<string,unknown>);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)}});await page.locator('.modal').getByRole('button',{name:/Speichern|Salva|Save/}).click();await expect(page.locator('.modal .notice--error')).toBeVisible();workflow.uncertainProductFieldsLocked=await page.locator('.modal input,.modal select').evaluateAll(fields=>fields.every(field=>(field as HTMLInputElement).disabled));await page.locator('.modal').getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();await expect(page.locator('.modal')).toHaveCount(0);const commands=await page.evaluate(()=>(window as unknown as {__aerstelloProductCreateCommands:Array<Record<string,unknown>>}).__aerstelloProductCreateCommands);workflow.retriedProductMutationIds=commands.map(command=>String(command.mutationId));const products=await (await page.context().request.get('/api/v1/products')).json() as {data:{name:{de:string}}[]};workflow.recoverableProductCount=products.data.filter(product=>product.name.de==='Recoverable product').length;workflow.changedProductCreationReplayStatus=(await page.context().request.post('/api/v1/products',{headers:csrfHeaders,data:{...commands[0]!,name:{de:'Changed recoverable product',it:'',en:''}}})).status()});

Then('both product creation attempts use the same mutation identifier',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedProductMutationIds).toHaveLength(2);expect(new Set(workflow.retriedProductMutationIds).size).toBe(1)});

Then('the uncertain product fields stay locked for retry',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.uncertainProductFieldsLocked).toBe(true)});

Then('only one recoverable product exists',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.recoverableProductCount).toBe(1)});

Then('changing the replayed product creation is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.changedProductCreationReplayStatus).toBe(409)});

When('a product update response is lost before another administrator edits it',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await page.goto('/app/products');await page.getByText('Helles',{exact:true}).click();const modal=page.locator('.modal');await modal.getByLabel(/Preis · EUR|Prezzo · EUR|Price · EUR/).fill('5.00');await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let loseResponse=true;window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/products/')&&init?.method==='PATCH'&&loseResponse){loseResponse=false;await originalFetch(input,init);throw new TypeError('Simulated lost response')}return originalFetch(input,init)}});await modal.getByRole('button',{name:/Speichern|Salva|Save/}).click();await expect(modal.locator('.notice--error')).toBeVisible();const request=page.context().request;const products=await (await request.get('/api/v1/products')).json() as {data:{id:string;name:{de:string;it:string;en:string};description?:{de:string;it:string;en:string};priceCents:number;categoryId:string;enabled:boolean;selfServiceOnly:boolean;version:number}[]};const current=products.data.find(item=>item.name.de==='Helles')!;workflow.staleProductFinalPrice=current.priceCents+321;expect((await request.patch(`/api/v1/products/${current.id}`,{headers:csrfHeaders,data:{name:current.name,...(current.description?{description:current.description}:{}),priceCents:workflow.staleProductFinalPrice,categoryId:current.categoryId,enabled:current.enabled,selfServiceOnly:current.selfServiceOnly,expectedVersion:current.version}})).status()).toBe(200);const response=page.waitForResponse(candidate=>candidate.url().endsWith(`/api/v1/products/${current.id}`)&&candidate.request().method()==='PATCH');await modal.getByRole('button',{name:/Speichern|Salva|Save/}).click();workflow.staleProductRetryRejected=(await response).status()===409;await expect(modal.locator('.notice--error')).toContainText(/zwischenzeitlich geändert|modificato nel frattempo|changed in the meantime/);const finalProducts=await (await request.get('/api/v1/products')).json() as {data:{id:string;priceCents:number}[]};workflow.staleProductFinalPrice=finalProducts.data.find(item=>item.id===current.id)!.priceCents});

Then('retrying the stale product update is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleProductRetryRejected).toBe(true)});

Then('the newer product price remains configured',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleProductFinalPrice).toBe(821)});

When('the administrator retries product archival after its response is lost',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);await page.goto('/app/products');await page.getByText('Hauskeks',{exact:true}).click();const modal=page.locator('.modal');await page.evaluate(()=>{const originalFetch=window.fetch.bind(window);let loseResponse=true;const commands:Record<string,unknown>[]=[];Object.assign(window,{__aerstelloProductArchiveCommands:commands});window.fetch=async(input,init)=>{const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;if(url.includes('/api/v1/products/')&&init?.method==='DELETE'){commands.push(JSON.parse(String(init.body)) as Record<string,unknown>);const response=await originalFetch(input,init);if(loseResponse){loseResponse=false;throw new TypeError('Simulated lost response')}return response}return originalFetch(input,init)}});await modal.getByRole('button',{name:/Archiv|Archivia|Archive/}).click();await expect(modal.locator('.notice--error')).toBeVisible();workflow.uncertainProductArchiveFieldsLocked=await modal.locator('input,select').evaluateAll(fields=>fields.every(field=>(field as HTMLInputElement).disabled));await modal.getByRole('button',{name:/Erneut versuchen|Riprova|Retry/}).click();await expect(modal).toHaveCount(0);workflow.retriedProductArchiveMutationIds=(await page.evaluate(()=>(window as unknown as {__aerstelloProductArchiveCommands:Array<Record<string,unknown>>}).__aerstelloProductArchiveCommands)).map(command=>String(command.mutationId));const products=await (await page.context().request.get('/api/v1/products')).json() as {data:{name:{de:string}}[]};workflow.archivedProductCount=products.data.filter(product=>product.name.de==='Hauskeks').length});

Then('both product archival attempts use the same mutation identifier',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.retriedProductArchiveMutationIds).toHaveLength(2);expect(new Set(workflow.retriedProductArchiveMutationIds).size).toBe(1)});

Then('the uncertain product fields stay locked for archival retry',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.uncertainProductArchiveFieldsLocked).toBe(true)});

Then('the product is archived only once',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.archivedProductCount).toBe(0)});

When('another administrator edits a product before a stale archival arrives',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);const request=page.context().request;const products=await (await request.get('/api/v1/products')).json() as {data:{id:string;name:{de:string;it:string;en:string};description?:{de:string;it:string;en:string};priceCents:number;categoryId:string;enabled:boolean;selfServiceOnly:boolean;version:number}[]};const product=products.data.find(item=>item.name.de==='Helles')!;workflow.staleProductArchiveFinalPrice=product.priceCents+77;expect((await request.patch(`/api/v1/products/${product.id}`,{headers:csrfHeaders,data:{name:product.name,...(product.description?{description:product.description}:{}),priceCents:workflow.staleProductArchiveFinalPrice,categoryId:product.categoryId,enabled:product.enabled,selfServiceOnly:product.selfServiceOnly,expectedVersion:product.version}})).status()).toBe(200);workflow.staleProductArchiveStatus=(await request.delete(`/api/v1/products/${product.id}`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedVersion:product.version}})).status();const final=await (await request.get('/api/v1/products')).json() as {data:{id:string;priceCents:number}[]};workflow.staleProductArchiveFinalPrice=final.data.find(item=>item.id===product.id)?.priceCents??-1});

Then('the stale product archival is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleProductArchiveStatus).toBe(409)});

Then("the product's newer edit remains configured",async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.staleProductArchiveFinalPrice).toBe(497)});

When('the administrator tries to create product {string} priced {string}',async({page},name:string,price:string)=>{await page.goto('/app/products');await page.getByRole('button',{name:/Hinzufügen/}).first().click();await page.getByLabel('Name · DE').fill(name);await page.getByLabel(/Preis · EUR|Prezzo · EUR|Price · EUR/).fill(price);await page.locator('.modal').getByRole('button',{name:'Speichern'}).click()});

Then('the product price is rejected before submission',async({page})=>{const price=page.getByLabel(/Preis · EUR|Prezzo · EUR|Price · EUR/);await expect(price).toBeVisible();expect(await price.evaluate((input:HTMLInputElement)=>input.validity.valid)).toBe(false)});
