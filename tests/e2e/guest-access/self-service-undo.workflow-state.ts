import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('guest-access/self-service-undo',()=>({
    guestUndoRemainingMs: 0,
    retriedGuestUndoMutationIds: [] as string[],
    serializedGuestUndoResult: undefined as {startedBeforeExpiry:boolean;status:number;code:string;itemCount:number;itemStatus:string}|undefined
}));
