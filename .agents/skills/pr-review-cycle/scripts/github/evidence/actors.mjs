import { GitHubWorkflowError } from '../errors.mjs';

export const CANONICAL_LOGIN = 'chatgpt-codex-connector';
export const CANONICAL_URL = 'https://github.com/apps/chatgpt-codex-connector';

export function isCanonicalActor(actor) {
  const matches = actor?.__typename === 'Bot'
    && actor?.login === CANONICAL_LOGIN && actor?.url === CANONICAL_URL;
  if (matches && !actor.id) {
    throw new GitHubWorkflowError('Canonical Bot actor has no node ID', 'CANONICAL_ACTOR_INCOMPLETE');
  }
  return matches;
}

export function isViewerActor(actor, viewer) {
  const matches = actor?.login === viewer.login;
  if (matches && !actor.id) {
    throw new GitHubWorkflowError('Viewer actor has no node ID', 'CANONICAL_ACTOR_INCOMPLETE');
  }
  return matches && actor.id === viewer.id;
}

export function actorObservation(actor) {
  return {
    type: actor?.__typename ?? null,
    login: actor?.login ?? null,
    id: actor?.id ?? null,
    url: actor?.url ?? null,
  };
}
