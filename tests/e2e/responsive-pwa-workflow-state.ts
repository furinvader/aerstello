import { createScenarioState } from './support/scenario-state';

export const stateFor=createScenarioState('responsive-pwa/workflow',()=>({
    manifestPayload: undefined as { name?: string; icons?: unknown[]; start_url?: string } | undefined,
}));
