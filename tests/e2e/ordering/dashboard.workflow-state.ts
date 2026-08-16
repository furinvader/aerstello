import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('ordering/dashboard',()=>({
    dashboardCurrentItemCount: 0,
    dashboardCurrentValueCents: 0,
    dashboardExpectedSnapshotSalesCents: 0,
    dashboardExpectedValueCents: 0,
    dashboardOpenItemCount: 0,
    dashboardSnapshotSalesCents: 0
}));
