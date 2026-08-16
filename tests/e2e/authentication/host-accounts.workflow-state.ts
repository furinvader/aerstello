import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('authentication/host-accounts',()=>({
    hostSessionRequestsBeforeDirectoryRetry: 0,
    recoverableHostCount: 0,
    reopenedHostSessionStatus: 0,
    retriedHostCreationMutationIds: [] as string[],
    roleChangedHostPage: undefined as import('@playwright/test').Page | undefined,
    staleHostFinalActive: false,
    staleHostUpdateStatus: 0,
    uncertainHostFieldsLocked: false
}));
