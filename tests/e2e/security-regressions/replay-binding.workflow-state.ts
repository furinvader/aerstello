import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('security-regressions/replay-binding',()=>({
    changedBillVoidReplayStatus: 0,
    changedItemVoidReplayStatus: 0,
    changedItemVoidVersionReplayStatus: 0,
    changedSettlementReplayStatus: 0,
    concurrentOrderItemCount: 0,
    concurrentOrderStatuses: [] as number[],
    repeatedBillVoidStatuses: [] as number[],
    repeatedVoidStatuses: [] as number[],
    restoredBillItemCount: 0
}));
