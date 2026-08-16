import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('authentication/account-profile',()=>({
    currentDeviceAfterPasswordChangeStatus: 0,
    expectedItalianSessionTimestamp: '',
    finalProfileName: '',
    newPasswordLoginStatus: 0,
    otherDeviceAfterPasswordChangeStatus: 0,
    retriedProfileMutationIds: [] as string[],
    uncertainProfileFieldsLocked: false
}));
