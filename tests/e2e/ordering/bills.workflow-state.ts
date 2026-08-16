import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('ordering/bills',()=>({
    oldestBillNumber: '',
    oldestBillSearchId: '',
    recoverableBillId: '',
    recoverableBillNumber: '',
    snapshottedBillDate: '',
    snapshottedBillHostName: ''
}));
