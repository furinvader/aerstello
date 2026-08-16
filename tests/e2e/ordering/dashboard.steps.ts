import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { emptyDashboardStats,openOrdersMetric,todayMetric } from '../ordering/order-ui';
import { connectDatabase } from '../support/database';
import { csrfHeaders,operationalData } from '../support/operational-api-data';
import { stateFor } from './dashboard.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('the host submits five items in one order line',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;
  expect((await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:5}]}})).status()).toBe(201);
  workflow.dashboardOpenItemCount=((await (await request.get('/api/v1/dashboard')).json()) as {openItemCount:number}).openItemCount;
});

Then('the dashboard reports five open items',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.dashboardOpenItemCount).toBe(5)});

When('the host has billed history and one current open item',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;const historical=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:3}]}})).json() as {tabId:string};expect((await request.post(`/api/v1/tabs/${historical.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:3,expectedTotalCents:product.priceCents*3,paymentMethod:'cash'}})).status()).toBe(200);expect((await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).status()).toBe(201);const dashboard=await (await request.get('/api/v1/dashboard')).json() as {openItemCount:number;openValueCents:number};workflow.dashboardCurrentItemCount=dashboard.openItemCount;workflow.dashboardCurrentValueCents=dashboard.openValueCents;workflow.dashboardExpectedValueCents=product.priceCents});

Then('the dashboard reports only the current item and value',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.dashboardCurrentItemCount).toBe(1);expect(workflow.dashboardCurrentValueCents).toBe(workflow.dashboardExpectedValueCents)});

When('the venue timezone changes after sales on adjacent snapshot days',async({resources, scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);
  const guest=guests.data.find(item=>item.name==='Anna Berger')!;
  const product=products.data.find(item=>item.name.de==='Helles')!;
  const venue=await (await request.get('/api/v1/venue')).json() as {name:string;defaultLanguage:string;version:number};
  const databaseResource=await connectDatabase(resources);
  const database=databaseResource.client;
  try {
    const zones=(await database.query<{snapshotTimezone:string;currentTimezone:string}>(
      `WITH starts AS (
         SELECT date_trunc('day',statement_timestamp() AT TIME ZONE 'Pacific/Kiritimati') AT TIME ZONE 'Pacific/Kiritimati' AS kiritimati,
                date_trunc('day',statement_timestamp() AT TIME ZONE 'Pacific/Pago_Pago') AT TIME ZONE 'Pacific/Pago_Pago' AS pago_pago
       ) SELECT CASE WHEN kiritimati<pago_pago THEN 'Pacific/Kiritimati' ELSE 'Pacific/Pago_Pago' END AS "snapshotTimezone",
                CASE WHEN kiritimati<pago_pago THEN 'Pacific/Pago_Pago' ELSE 'Pacific/Kiritimati' END AS "currentTimezone"
           FROM starts`,
    )).rows[0]!;
    const snapshotVenueResponse=await request.put('/api/v1/venue',{headers:csrfHeaders,data:{name:venue.name,language:venue.defaultLanguage,timezone:zones.snapshotTimezone,expectedVersion:venue.version}});
    expect(snapshotVenueResponse.status()).toBe(200);
    const snapshotVenue=await snapshotVenueResponse.json() as {version:number};
    const insertHistoricalBill=async(quantity:number,dayOffset:number)=>{
      await database.query(
        `WITH historical_tab AS (
           INSERT INTO order_tabs(guest_id,status,closed_at)
           VALUES ($1,'billed',clock_timestamp())
           RETURNING id
         )
         INSERT INTO bills(tab_id,guest_id,host_id,mutation_id,venue_name,venue_timezone,guest_name,room_name,host_name,total_cents,payment_method,settled_at)
         SELECT historical_tab.id,g.id,h.id,$3,v.name,v.timezone,g.name,r.name,h.name,$4,'cash',
                (date_trunc('day',statement_timestamp() AT TIME ZONE $5)-$6::integer*interval '1 day') AT TIME ZONE $5
           FROM historical_tab
           JOIN guests g ON g.id=$1
           JOIN rooms r ON r.id=g.room_id
           JOIN hosts h ON h.id=$2
          CROSS JOIN venue_settings v`,
        [guest.id,me.host.id,crypto.randomUUID(),product.priceCents*quantity,zones.snapshotTimezone,dayOffset],
      );
    };
    await insertHistoricalBill(1,0);
    await insertHistoricalBill(2,1);
    expect((await request.put('/api/v1/venue',{headers:csrfHeaders,data:{name:venue.name,language:venue.defaultLanguage,timezone:zones.currentTimezone,expectedVersion:snapshotVenue.version}})).status()).toBe(200);
  } finally { await databaseResource.dispose(); }
  const dashboard=await (await request.get('/api/v1/dashboard')).json() as {todaySalesCents:number};
  workflow.dashboardSnapshotSalesCents=dashboard.todaySalesCents;
  workflow.dashboardExpectedSnapshotSalesCents=product.priceCents;
});

Then('the dashboard reports sales from the current snapshotted day',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.dashboardSnapshotSalesCents).toBe(workflow.dashboardExpectedSnapshotSalesCents)});

When('the initial dashboard stats response is delayed',async({page})=>{
  await page.addInitScript(()=>{
    const fetch=window.fetch.bind(window);
    window.fetch=(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(new URL(url,window.location.href).pathname==='/api/v1/dashboard')return new Promise<Response>(()=>{});
      return fetch(input,init);
    };
  });
  await page.reload();
});

Then('the dashboard financial cards show loading without zero totals',async({page})=>{
  const openOrders=openOrdersMetric(page);const today=todayMetric(page);
  await expect(openOrders).toContainText(/Wird geladen|Caricamento|Loading/);
  await expect(today).toContainText(/Wird geladen|Caricamento|Loading/);
  await expect(openOrders).not.toContainText(/0[,.]00\s*€|\b0\s+(Artikel|Articoli|Items)\b/);
  await expect(today).not.toContainText(/0[,.]00\s*€/);
});

When('the initial dashboard stats request fails',async({page})=>{
  await page.addInitScript(()=>{
    const fetch=window.fetch.bind(window);
    window.fetch=(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(new URL(url,window.location.href).pathname==='/api/v1/dashboard')return Promise.reject(new TypeError('Simulated dashboard outage'));
      return fetch(input,init);
    };
  });
  await page.reload();
});

Then('the dashboard financial cards show a request failure without zero totals',async({page})=>{
  const unavailable=/Die Anfrage konnte nicht abgeschlossen werden|Impossibile completare la richiesta|The request could not be completed/;
  const openOrders=openOrdersMetric(page);const today=todayMetric(page);
  await expect(openOrders).toContainText(unavailable,{timeout:10_000});
  await expect(today).toContainText(unavailable);
  await expect(openOrders).not.toContainText(/0[,.]00\s*€|\b0\s+(Artikel|Articoli|Items)\b/);
  await expect(today).not.toContainText(/0[,.]00\s*€/);
});

When('the dashboard stats successfully report no activity',async({page})=>{
  await page.addInitScript((stats)=>{
    const fetch=window.fetch.bind(window);
    window.fetch=(input,init)=>{
      const url=input instanceof Request?input.url:input instanceof URL?input.href:String(input);
      if(new URL(url,window.location.href).pathname==='/api/v1/dashboard')return Promise.resolve(new Response(JSON.stringify(stats),{headers:{'Content-Type':'application/json'}}));
      return fetch(input,init);
    };
  },emptyDashboardStats);
  await page.reload();
});

Then('the dashboard financial cards show zero totals and zero open items',async({page})=>{
  const openOrders=openOrdersMetric(page);const today=todayMetric(page);
  await expect(openOrders).toContainText(/0[,.]00\s*€/);
  await expect(openOrders).toContainText(/\b0\s+(Artikel|Articoli|Items)\b/);
  await expect(today).toContainText(/0[,.]00\s*€/);
});
