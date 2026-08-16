import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('guest-access/self-service-catalog',()=>({
    staleGuestMutationIds: [] as string[],
    staleGuestPriceItemCount: 0,
    staleGuestPriceRejected: false,
    staleGuestSnapshotItemCount: 0,
    staleGuestSnapshotRejected: false
}));
