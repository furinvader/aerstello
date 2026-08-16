import { createScenarioState } from '../support/scenario-state';

export type SettlementRecoveryRecord = {
  hostId:string;tabId:string;guestId:string;guestName:string;roomName:string;
  command:{mutationId:string;expectedItemCount:number;expectedTotalCents:number;paymentMethod:string;note?:string};
};

export const stateFor=createScenarioState('ordering/settlement',()=>({
    aggregateSettlementStatus: 0,
    billVoidLockTiming: undefined as {
  releaseFloor: Date;
  voidedAt: Date;
  auditCreatedAt: Date;
  auditCount: number;
  billBefore: unknown;
  billAfter: unknown;
  linesBefore: unknown[];
  linesAfter: unknown[];
} | undefined,
    concurrentSettlementBillCount: 0,
    concurrentSettlementStatuses: [] as number[],
    excessiveOrderStatus: 0,
    refreshedSettlementBillCount: 0,
    refreshedSettlementItemCount: 0,
    reloadedSettlementBillCount: 0,
    reloadedSettlementRequests: [] as {path:string;body:SettlementRecoveryRecord['command']}[],
    reloadedSettlementStorageCount: 0,
    retriedSettlementMutationIds: [] as string[],
    settlementRecoveryAfterReload: undefined as SettlementRecoveryRecord | undefined,
    settlementRecoveryBeforeReload: undefined as SettlementRecoveryRecord | undefined,
    settlementTimestampAgeMs: Number.POSITIVE_INFINITY,
    settlementUndoClockResult: undefined as {
  immediateStatus:number;
  immediateCode:string;
  startedBeforeExpiry:boolean;
  expiredBeforeRelease:boolean;
  settlementStatus:number;
  billLineCount:number;
  billCount:number;
  itemStatus:string;
} | undefined,
    staleSettlementBillCount: 0,
    tabTotalAfterExcess: 0,
    tabTotalBeforeExcess: 0,
    uncertainSettlementDetailsLocked: false
}));
