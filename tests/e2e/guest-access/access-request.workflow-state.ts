import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('guest-access/access-request',()=>({
    approvalDefaultLifetimeHours: 0,
    approvedGuestIdentityCount: 0,
    deniedPollCounts: [0, 0] as [number, number],
    deniedRequestCount: 0,
    retriedAccessRequestMutationIds: [] as string[],
    retriedApprovalMutationIds: [] as string[],
    retriedDenialMutationIds: [] as string[],
    uncertainAccessRequestFieldsLocked: false,
    uncertainApprovalFieldsLocked: false
}));
