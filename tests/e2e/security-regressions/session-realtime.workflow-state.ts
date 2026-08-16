import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('security-regressions/session-realtime',()=>({
    revokedStreamEventCount: 0
}));
