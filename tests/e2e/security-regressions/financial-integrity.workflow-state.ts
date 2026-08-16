import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('security-regressions/financial-integrity',()=>({
    archivedGuestBillVoidStatus: 0,
    archivedGuestCorrectionId: '',
    archivedGuestCorrectionName: '',
    archivedGuestRestoredItemCount: 0,
    billArchiveRaceStatuses: [] as [number, number][],
    historicalEvidenceResult: undefined as {
  errors:Record<string,string>;
  auditBefore:unknown;
  auditAfter:unknown;
  productVersionBefore:unknown;
  productVersionAfter:unknown;
  auditTruncateTriggerEnabled:boolean;
  productVersionsTruncateTriggerEnabled:boolean;
  voidStatus:number;
  voidAuditCount:number;
  productUpdateStatus:number;
  productVersionCountBefore:number;
  productVersionCountAfter:number;
} | undefined,
    immutableFinancialResult: undefined as {
  billUpdateError:string;
  billDeleteError:string;
  incompleteBillVoidError:string;
  unauditedBillVoidError:string;
  mismatchedBillVoidAuditError:string;
  mismatchedBillVoidAuditReachedCommit:boolean;
  repeatedBillVoidError:string;
  orderItemUpdateError:string;
  orderItemDeleteError:string;
  orderItemReopenError:string;
  settledTabReopenError:string;
  incompleteAuditedVoidError:string;
  incompleteAuditedVoidReachedCommit:boolean;
  billLineUpdateError:string;
  billLineDeleteError:string;
  billsTruncateError:string;
  orderItemsTruncateError:string;
  billItemsTruncateError:string;
  billsTruncateTriggerEnabled:boolean;
  orderItemsTruncateTriggerEnabled:boolean;
  billItemsTruncateTriggerEnabled:boolean;
  billBefore:unknown;
  billAfter:unknown;
  orderItemBefore:unknown;
  orderItemAfter:unknown;
  billLineBefore:unknown;
  billLineAfter:unknown;
  settlementStatus:number;
  voidStatus:number;
  voidAuditCount:number;
  restoredItemCount:number;
  restoredOrderItemState:{status:string;billId:string|null;billingVersion:number};
} | undefined,
    invalidBillingVersionChangeError: '',
    missingBillingIncrementError: '',
    overflowBillTabItemCount: 0,
    overflowBillVoidStatus: 0,
    overflowOverviewStatuses: [] as number[],
    overflowPostCorrectionOrderStatus: 0,
    strictBillingVersions: [] as number[],
    strictBillingVoidConflict: undefined as {status:number;code:string}|undefined
}));
