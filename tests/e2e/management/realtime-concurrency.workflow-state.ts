import type { ResourceRegistration } from '../support/resource-registry';
import { createScenarioState } from '../support/scenario-state';

interface RealtimeConcurrencyWorkflowState {
  commitOrderedRealtimeIds: string[];
  laterRealtimeInsertWaited: boolean;
  relayedCommitOrderedEvents: {id:string;marker:string}[];
  replicaRoomEventStreamResource?: ResourceRegistration<void>;
  transactionalGuestEditStatus: number;
  transactionalGuestFinalName: string;
}

export const stateFor=createScenarioState<RealtimeConcurrencyWorkflowState>('management/realtime-concurrency',()=>({
    commitOrderedRealtimeIds: [] as string[],
    laterRealtimeInsertWaited: false,
    relayedCommitOrderedEvents: [] as {id:string;marker:string}[],
    transactionalGuestEditStatus: 0,
    transactionalGuestFinalName: ''
}));
