import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('authentication/login-bootstrap',()=>({
    credentialRaceActiveSessions: 0,
    credentialRaceLoginStatuses: [] as number[],
    loginFailureResults: [] as { status: number; body: unknown }[],
    recoveredDeviceStatus: 0
}));
