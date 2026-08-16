import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('guest-access/grant-exchange',()=>({
    databaseClockApprovalResult: undefined as {
  validStatus:number;validRequestStatus:string;expiredStatus:number;expiredCode:string;expiredRequestStatus:string;expiredGuestCount:number;
}|undefined,
    databaseClockGrantResult: undefined as {granted:boolean;guestStatus:number}|undefined,
    differentGrantStatus: 0,
    expiredGrantGuestStatus: 0,
    expiredGrantResult: undefined as { status: string; granted: boolean } | undefined,
    recoveredGrantStatus: 0,
    rotatedCapabilityPollResult: undefined as {statuses:number[];sameToken:boolean;states:string[]} | undefined,
    rotatedGrantRecoveryStatus: 0,
    rotatedHostSessionStatus: 0,
    serializedApprovalResult: undefined as {status:number;code:string;requestStatus:string;guestCount:number}|undefined,
    serializedGrantResult: undefined as {
  status:string;granted:boolean;guestStatus:number;sessionCount:number;consumedAt:Date|null;
}|undefined
}));
