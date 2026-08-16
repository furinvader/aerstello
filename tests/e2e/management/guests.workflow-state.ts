import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('management/guests',()=>({
    archivedGuestCount: 0,
    changedGuestCreationReplayStatus: 0,
    guestArchiveRaceStatuses: [] as [number, number][],
    recoverableGuestCount: 0,
    retriedGuestArchiveMutationIds: [] as string[],
    retriedGuestCreationMutationIds: [] as string[],
    staleGuestArchiveFinalName: '',
    staleGuestArchiveStatus: 0,
    staleGuestFinalName: '',
    staleGuestUpdateStatus: 0,
    uncertainGuestArchiveStayedOpen: false,
    uncertainGuestCreationStayedOpen: false,
    uncertainGuestFieldsLocked: false
}));
