import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from './fixtures/test';
import { chooseOrder } from './ordering/order-ui';
import { stateFor } from './responsive-pwa-workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('the PWA manifest is requested',async({resources, guestDevice, scenarioState, request})=>{const workflow=stateFor(scenarioState);const response=await request.get('/manifest.webmanifest');expect(response.ok()).toBeTruthy();workflow.manifestPayload=await response.json()});

Then('it names the software {string} and provides application icons',async({resources, guestDevice, scenarioState},name:string)=>{const workflow=stateFor(scenarioState);expect(workflow.manifestPayload?.name).toBe(name);expect(workflow.manifestPayload?.icons?.length).toBeGreaterThanOrEqual(2)});

When('the guest launches the app from the manifest start URL',async({resources, guestDevice})=>{const manifest=await (await guestDevice.page.context().request.get('/manifest.webmanifest')).json() as {start_url:string};expect(manifest.start_url).toBe('/');await guestDevice.page.goto(manifest.start_url)});

Then("the launch opens Luca's active guest view",async({resources, guestDevice})=>{await expect(guestDevice.page).toHaveURL(/\/guest$/);await expect(guestDevice.page.getByRole('heading',{name:'Luca Rossi'})).toBeVisible()});

Then('Take Orders navigation is visually prominent',async({resources, guestDevice, page})=>{await expect(page.locator('.nav-primary')).toHaveCSS('background-color','rgb(66, 189, 255)')});

When('the host opens the bills screen',async({resources, guestDevice, page})=>{await page.goto('/app/bills')});

Then('only Bills is active in the primary navigation',async({resources, guestDevice, page})=>{await expect(page.locator('.sidebar nav a.active')).toHaveCount(1);await expect(page.locator('.sidebar nav a.active')).toHaveAttribute('href','/app/bills')});

When('the host stages a mobile order for {string}',async({resources, guestDevice, page},guest:string)=>{await page.setViewportSize({width:390,height:844});await chooseOrder(page,'Helles',guest,'101')});

Then('both quantity stepper buttons are at least 44 by 44 pixels',async({resources, guestDevice, page})=>{
  const buttons=page.locator('.cart-lines .stepper button');
  await expect(buttons).toHaveCount(2);
  const sizes=await buttons.evaluateAll(elements=>elements.map(element=>{const box=element.getBoundingClientRect();return {width:box.width,height:box.height}}));
  for(const size of sizes){expect(size.width).toBeGreaterThanOrEqual(44);expect(size.height).toBeGreaterThanOrEqual(44)}
});
