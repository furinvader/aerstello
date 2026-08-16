import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('guest-access/self-service-recovery',()=>({
    concurrentGuestItemCount: 0,
    concurrentGuestItemStatuses: [] as number[],
    pendingGuestAddResult: undefined as {
  secondStartedBeforeFirstRelease:boolean;
  firstDisabledWhilePending:boolean;
  secondEnabledBeforeStart:boolean;
  bothDisabled:boolean;
  firstDisabledAfterSecondSettled:boolean;
  secondEnabledAfterOwnSettle:boolean;
  firstEnabledAfterOwnSettle:boolean;
} | undefined,
    reopenedGuestAddItemCount: 0,
    reopenedGuestAddMutationIds: [] as string[],
    retriedGuestAddMutationIds: [] as string[],
    timeoutGuestItemCount: 0,
    uncertainGuestProductCounts: {} as Record<string,number>
}));
