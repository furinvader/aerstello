import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('ordering/offline-recovery',()=>({
    capturedExpectedTotalCents: 0,
    capturedUncertainTotal: '',
    changedOrderReplayItemCount: 0,
    changedOrderReplayStatus: 0,
    closedOrderItemCount: 0,
    closedOrderMutationIds: [] as string[],
    closedOrderPreReopenTransmissionCount: 0,
    conflictGuestId: '',
    correctedLifecycleItemCount: 0,
    itemBillingConflictResult: undefined as {status:number;code:string}|undefined,
    lifecycleGuestId: '',
    refreshedLifecycleVoidStatus: 0,
    reloadedOrderItemCount: 0,
    reloadedOrderMutationIds: [] as string[],
    reloadedVoidItemCount: 0,
    reloadedVoidPendingCount: 0,
    reloadedVoidRequests: [] as {mutationId:string;reason:string;expectedBillingVersion:number}[],
    retriedOrderItemCount: 0,
    retriedOrderMutationIds: [] as string[],
    retriedVoidReasons: [] as string[],
    transientReplayAttempts: 0,
    uncertainOrderControlsLocked: false,
    uncertainVoidReasonLocked: false
}));
