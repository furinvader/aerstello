import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('ordering/order-entry',()=>({
    switchedGuestTabCount: 0
}));
