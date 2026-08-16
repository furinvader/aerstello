import { createScenarioState } from './support/scenario-state';

export const stateFor=createScenarioState('venue/workflow',()=>({
    invalidTimezoneStatus: 0,
    staleVenueFinalName: '',
    staleVenueUpdateStatus: 0,
    venueTimezoneAfter: '',
    venueTimezoneBefore: '',
}));
