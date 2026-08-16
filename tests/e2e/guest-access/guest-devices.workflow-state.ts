import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('guest-access/guest-devices',()=>({
    guestScopedEvents: [] as {topic:string;payload:unknown}[],
    guestSessionRevokeAuditCount: 0,
    mismatchedGuestSessionRevokeStatus: 0,
    repeatedGuestSessionRevokeStatuses: [] as number[],
    replayedGuestLogoutStatus: 0,
    transientGuestPendingState: ''
}));
