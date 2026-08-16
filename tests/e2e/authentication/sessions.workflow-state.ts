import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('authentication/sessions',()=>({
    replayedLogoutStatus: 0
}));
