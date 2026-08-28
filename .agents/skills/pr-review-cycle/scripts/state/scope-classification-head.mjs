const CLASSIFICATION_PHASES = new Set(['task', 'integrated-head', 'review-finding']);

export function resolveScopeClassificationHead({
  phase,
  reviewedHeadSha,
  currentIntegrationHeadSha,
}) {
  if (!CLASSIFICATION_PHASES.has(phase)) {
    throw new TypeError(`Unsupported scope classification phase: ${String(phase)}`);
  }
  return phase === 'integrated-head'
    ? currentIntegrationHeadSha
    : reviewedHeadSha ?? currentIntegrationHeadSha;
}
