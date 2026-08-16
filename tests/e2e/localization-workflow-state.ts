import { createScenarioState } from './support/scenario-state';

export const stateFor=createScenarioState('localization/workflow',()=>({
    freshGuestPage: undefined as import('@playwright/test').Page | undefined,
}));
