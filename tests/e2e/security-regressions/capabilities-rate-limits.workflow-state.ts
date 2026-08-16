import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('security-regressions/capabilities-rate-limits',()=>({
    firstGuestAccessStatus: 0,
    grantExchangeRequest: undefined as { method: string; url: string; body: unknown } | undefined,
    independentAddressRateStatuses: undefined as {statusFirst:number[];ordinary:number[];statusLast:number[]}|undefined,
    malformedJsonResult: undefined as {status:number;code:string}|undefined,
    rotatingCapabilityStatuses: [] as number[],
    secondGuestAccessStatus: 0,
    sharedNetworkPollStatuses: [] as number[],
    sharedReplicaRateStatuses: [] as number[]
}));
