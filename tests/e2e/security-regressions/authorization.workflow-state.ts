import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('security-regressions/authorization',()=>({
    approvalMoveRaceStatuses: [] as [number, number][],
    archivedGrantGuestStatus: 0,
    crossRoomApprovalStatus: 0,
    disabledCatalogOrderStatus: 0,
    mismatchedHostOrderStatus: 0
}));
