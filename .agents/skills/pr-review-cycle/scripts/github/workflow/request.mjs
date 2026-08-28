import { GitHubWorkflowError } from '../errors.mjs';
import { assertMutationReady } from '../mutation-readiness.mjs';
import { readLiveSnapshot } from '../snapshot.mjs';
import { lookupOptionalMutationJournalIntent } from '../mutations/draft-review-request.mjs';

export function createRequestUseCase(context, requestReviewUnlocked) {
  const { client, git, journal, load, assertScopeCurrent } = context;

  return async function request(prNumber, kind) {
    if (!journal?.withRequestOwner) return requestReviewUnlocked(prNumber, kind);
    let requestOwnerEntered = false;
    try {
      return await journal.withRequestOwner(() => {
        requestOwnerEntered = true;
        return requestReviewUnlocked(prNumber, kind);
      });
    } catch (error) {
      if (error?.code !== 'STATE_LOCK_TIMEOUT' || requestOwnerEntered) throw error;
      const active = await load(prNumber);
      const live = await readLiveSnapshot(client, active);
      if (live.metadata.state !== 'OPEN') throw new GitHubWorkflowError('Pull request is closed or merged', 'PR_NOT_OPEN');
      await assertMutationReady({ state: active, git }, live, { requireReady: false });
      await assertScopeCurrent(active, live.metadata.headRefOid);
      if (live.metadata.isDraft) {
        return { requested: false, recovered: false, waiting: true,
          nextAction: `Wait, then rerun npm run review:github -- request --pr ${prNumber}.` };
      }
      const readyOperationId = `ready:${prNumber}:${live.metadata.id}:${active.currentIntegrationHeadSha}`;
      const readyIntent = await lookupOptionalMutationJournalIntent(journal, 'ready', readyOperationId);
      return { requested: false, recovered: false, waiting: true,
        pullRequestReadiness: readyIntent ? 'recovered-ready' : 'already-ready',
        nextAction: `Wait, then rerun npm run review:github -- request --pr ${prNumber}.` };
    }
  };
}
