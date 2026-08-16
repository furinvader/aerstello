import { test as bddTest } from 'playwright-bdd';

import { GuestDeviceDriver } from '../guest-access/guest-device-driver.ts';
import { ResourceRegistry } from '../support/resource-registry.ts';
import { executeDatabaseReset } from '../support/reset-command.ts';
import { ScenarioStateStore } from '../support/scenario-state.ts';

export interface AerstelloFixtures {
  readonly resources: ResourceRegistry;
  readonly scenarioState: ScenarioStateStore;
  readonly guestDevice: GuestDeviceDriver;
  readonly databaseReset: void;
}

export const test = bddTest.extend<AerstelloFixtures>({
  resources: [async ({}, use) => {
    const resources = new ResourceRegistry();
    try {
      await use(resources);
    } finally {
      await resources.disposeAll();
    }
  }, { auto: true }],

  scenarioState: async ({}, use) => {
    await use(new ScenarioStateStore());
  },

  guestDevice: async ({ browser, resources }, use) => {
    await use(new GuestDeviceDriver(resources, browser));
  },

  databaseReset: [async ({ resources }, use) => {
    void resources;
    await executeDatabaseReset();
    await use();
  }, { auto: true }],
});

export { expect } from '@playwright/test';
