import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('management/rooms',()=>({
    archivedRoomCount: 0,
    archivedRoomGuestStatus: 0,
    changedRoomCreationReplayStatus: 0,
    concurrentRoomOrderStatuses: [] as number[],
    expectedRoomOrderFinalIds: [] as string[],
    pendingRoomArchiveStatus: 0,
    pendingRoomRequestCount: 0,
    recoverableRoomCount: 0,
    retriedRoomArchiveMutationIds: [] as string[],
    retriedRoomMutationIds: [] as string[],
    staleRoomArchiveFinalName: '',
    staleRoomArchiveStatus: 0,
    staleRoomFinalName: '',
    staleRoomOrderFinalIds: [] as string[],
    staleRoomOrderStatus: 0,
    staleRoomUpdateStatus: 0,
    uncertainRoomFieldsLocked: false
}));
