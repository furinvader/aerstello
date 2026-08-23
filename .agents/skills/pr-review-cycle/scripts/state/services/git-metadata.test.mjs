import {
  assert, commit, init, loadState, repo, test,
} from '../test-support/state-harness.mjs';
import { checkpointGitMetadata } from './git-metadata.mjs';

test('git metadata service returns structured skip, no-change, and checkpoint results', () => {
  const cwd = repo();
  const initial = init(cwd, { orchestratorSessionId: 'session-a' });
  const wrongSession = checkpointGitMetadata({ cwd, sessionId: 'session-b' });
  assert.equal(wrongSession.checkpointed, false);
  assert.equal(wrongSession.warning, 'Skipped checkpoint for a different session');
  assert.equal(loadState(cwd).revision, initial.revision);

  const stable = checkpointGitMetadata({ cwd, sessionId: 'session-a', backup: true });
  assert.equal(stable.checkpointed, false);
  assert.equal(stable.warning, null);
  assert.equal(stable.state.revision, initial.revision);

  const advancedHead = commit(cwd, { 'scripts/git-service-test.mjs': 'export const value = true;\n' }, 'advance head');
  const advanced = checkpointGitMetadata({ cwd, sessionId: 'session-a' });
  assert.equal(advanced.checkpointed, true);
  assert.equal(advanced.state.currentIntegrationHeadSha, advancedHead);
  assert.equal(advanced.state.revision, initial.revision + 1);
});
