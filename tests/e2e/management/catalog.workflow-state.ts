import { createScenarioState } from '../support/scenario-state';

export const stateFor=createScenarioState('management/catalog',()=>({
    archivedProductCount: 0,
    changedCategoryCreationReplayStatus: 0,
    changedProductCreationReplayStatus: 0,
    recoverableCategoryCount: 0,
    recoverableProductCount: 0,
    retriedCategoryMutationIds: [] as string[],
    retriedProductArchiveMutationIds: [] as string[],
    retriedProductMutationIds: [] as string[],
    staleProductArchiveFinalPrice: 0,
    staleProductArchiveStatus: 0,
    staleProductFinalPrice: 0,
    staleProductRetryRejected: false,
    uncertainCategoryFieldsLocked: false,
    uncertainProductArchiveFieldsLocked: false,
    uncertainProductFieldsLocked: false
}));
