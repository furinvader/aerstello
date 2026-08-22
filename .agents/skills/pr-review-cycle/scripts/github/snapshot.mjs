import { isCanonicalActor } from './evidence/actors.mjs';
import { readLiveSnapshot as readPullRequestLiveSnapshot } from './graphql/pull-request-reader.mjs';

export async function readLiveSnapshot(client, state, { reactionsFor = null } = {}) {
  return readPullRequestLiveSnapshot(client, state, { reactionsFor, isCanonicalActor });
}
