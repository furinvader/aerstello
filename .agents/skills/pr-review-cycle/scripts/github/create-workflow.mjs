import { createRequestReviewUnlocked } from './mutations/draft-review-request.mjs';
import { createAdvanceUseCase } from './workflow/advance.mjs';
import { createCollectCiUseCase } from './workflow/collect-ci.mjs';
import { createCollectUseCase } from './workflow/collect.mjs';
import { createCompletionUseCases } from './workflow/complete.mjs';
import { createWorkflowContext } from './workflow/context.mjs';
import { createRefreshThreadsUseCase } from './workflow/refresh-threads.mjs';
import { createRequestUseCase } from './workflow/request.mjs';
import { createResolveUseCases } from './workflow/resolve.mjs';
import { createStatusUseCase } from './workflow/status.mjs';

export function createGitHubReviewWorkflow(adapters) {
  const context = createWorkflowContext(adapters);
  const status = createStatusUseCase(context);
  const refreshThreads = createRefreshThreadsUseCase(context);
  const { replyResolve, verifyResolve } = createResolveUseCases(context);
  const requestReviewUnlocked = createRequestReviewUnlocked(context);
  const request = createRequestUseCase(context, requestReviewUnlocked);
  const collect = createCollectUseCase(context);
  const collectCi = createCollectCiUseCase(context);
  const completion = createCompletionUseCases(context);
  const { complete } = completion;
  const advance = createAdvanceUseCase(context, {
    collect,
    collectCi,
    complete,
    assertFindingsLiveEvidence: completion.assertFindingsLiveEvidence,
    revalidateCompletedState: completion.revalidateCompletedState,
  });
  return { status, refreshThreads, replyResolve, verifyResolve, request, collect, collectCi, complete, advance };
}
