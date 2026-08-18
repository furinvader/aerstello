import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { planRelatedE2E, KNOWN_PROJECTS } from '../../../../../scripts/run-related-e2e.mjs';
import { checkReleasedMigrations } from '../../../../../scripts/lib/release-state.mjs';
import { digestJson } from '../contracts/contracts.mjs';
import { implementationTaskDigest, parseImplementationValidationCommand,
  validateImplementationResultAgainstTask, validateImplementationTaskStructure,
} from '../implementation/contracts.mjs';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default;
const addFormats = require('ajv-formats').default;
const schemaDirectory = new URL('../../schemas/', import.meta.url);
const schemaFiles = Object.freeze({
  validationPlan: 'development-validation-plan.schema.json',
  validationResult: 'development-validation-result.schema.json',
  specialistResult: 'development-specialist-result.schema.json',
  verifierContext: 'development-verifier-context.schema.json',
  verificationResult: 'development-verification-result.schema.json',
  findingDisposition: 'development-finding-disposition.schema.json',
});

export const verificationSchemas = Object.freeze(Object.fromEntries(Object.entries(schemaFiles)
  .map(([key, file]) => [key, JSON.parse(readFileSync(new URL(file, schemaDirectory), 'utf8'))])));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validators = Object.freeze(Object.fromEntries(Object.entries(verificationSchemas)
  .map(([key, schema]) => [key, ajv.compile(schema)])));

const AREA_COMMANDS = Object.freeze(new Map([
  ['api', ['npm run check:api']],
  ['web', ['npm run check:web']],
  ['shared', ['npm run check:shared', 'npm run check:api', 'npm run check:web']],
  ['workflow', ['npm run check:workflow']],
  ['documentation', []],
  ['release', ['npm run check:release-state', 'npm run check:released-migrations']],
  ['migration', ['npm run check:release-state', 'npm run check:released-migrations']],
]));
const AREA_ORDER = Object.freeze([...AREA_COMMANDS.keys()]);
const PROJECT_ORDER = Object.freeze([...KNOWN_PROJECTS]);
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

function schemaErrors(validator, value) {
  if (validator(value)) return [];
  return validator.errors.map(({ instancePath, message }) => `${instancePath || '$'} ${message}`);
}

export function validateVerificationContract(kind, value) {
  if (!Object.hasOwn(validators, kind)) throw new TypeError(`unknown verification contract: ${kind}`);
  const errors = schemaErrors(validators[kind], value);
  if (errors.length > 0) return errors;
  if (kind === 'validationPlan') {
    if (new Set(value.tasks.map(({ taskId }) => taskId)).size !== value.tasks.length) errors.push('$.tasks contains duplicate task IDs');
    if (new Set(value.commands.map(({ id }) => id)).size !== value.commands.length) errors.push('$.commands contains duplicate command IDs');
    if (new Set(value.commands.map(({ argv }) => JSON.stringify(argv))).size !== value.commands.length) errors.push('$.commands contains duplicate argv');
    if (value.commands.some(({ id, argv }) => id !== commandId(argv))) errors.push('$.commands IDs must equal their canonical argv identities');
    if (value.taskSetDigest !== digestJson(taskSetProjection(value.tasks))) errors.push('$.taskSetDigest must equal the exact task identity set');
    if (value.releaseEvidence !== null && value.releaseEvidence.headSha !== value.headSha) errors.push('$.releaseEvidence.headSha must equal headSha');
  }
  if (kind === 'validationResult') {
    if (value.status === 'passed' && (value.exitCode !== 0 || value.signal !== null)) errors.push('$ passed result requires exitCode 0 and no signal');
    if (value.status === 'failed' && value.exitCode === 0 && value.signal === null) errors.push('$ failed result requires a nonzero exit or signal');
  }
  if (['specialistResult', 'verificationResult'].includes(kind)
      && new Set(value.findings.map(({ id }) => id)).size !== value.findings.length) errors.push('$.findings contains duplicate IDs');
  if (kind === 'findingDisposition'
      && ((value.sourceKind === 'verifier') !== (value.sourceRole === 'development_integration_verifier'))) {
    errors.push('$.sourceKind and sourceRole must identify the same workflow role category');
  }
  if (kind === 'verifierContext' && Buffer.byteLength(JSON.stringify(value), 'utf8') > 256 * 1024) errors.push('$ verifier context exceeds 256 KiB');
  return errors;
}

const unique = (values) => [...new Set(values)];
const commandText = (argv) => argv.join(' ');
const commandId = (argv) => `command-${createHash('sha256').update(JSON.stringify(argv)).digest('hex').slice(0, 24)}`;
const taskSetProjection = (tasks) => tasks.map(({ taskId, binding, packetDigest, resultDigest, provenanceDigest,
  terminalStatus, integratedCommit, integrationReceiptDigest }) => ({ taskId, binding, packetDigest, resultDigest,
  provenanceDigest, terminalStatus, integratedCommit, integrationReceiptDigest }));
function normalizeSelector(value) {
  const raw = value.startsWith('@') ? value.slice(1) : value;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(raw)) throw new TypeError(`unsafe related E2E selector: ${value}`);
  return `@${raw}`;
}
function sortedProjects(projects) {
  const result = unique(projects);
  if (result.some((project) => !PROJECT_ORDER.includes(project))) throw new TypeError('unknown related E2E project');
  return result.sort((left, right) => PROJECT_ORDER.indexOf(left) - PROJECT_ORDER.indexOf(right));
}

export function canonicalizeValidationEntry(entry, { featureDirectory } = {}) {
  if (!entry || typeof entry.command !== 'string' || typeof entry.reason !== 'string') throw new TypeError('validation entry requires command and reason');
  const argv = parseImplementationValidationCommand(entry.command);
  if (!argv) throw new TypeError(`unsafe, broad, or unsupported validation command: ${entry.command}`);
  if (argv.includes('check:full') || argv.includes('test:e2e:full')) throw new TypeError('full-suite validation is forbidden');
  let selectors = []; let projects = [];
  if (argv[0] === 'npm' && argv[1] === 'run' && argv[2] === 'test:e2e:related') {
    const separator = argv.indexOf('--');
    if (separator < 0) throw new TypeError('related E2E command requires an explicit -- argument boundary');
    const planned = planRelatedE2E(argv.slice(separator + 1), featureDirectory);
    selectors = planned.selectors.map(normalizeSelector).sort(); projects = sortedProjects(planned.projects);
    const canonicalArgs = [...selectors.flatMap((selector) => ['--tag', selector]),
      ...projects.flatMap((project) => ['--project', project])];
    argv.splice(0, argv.length, 'npm', 'run', 'test:e2e:related', '--', ...canonicalArgs);
  } else if ((entry.selectors?.length ?? 0) > 0 || (entry.projects?.length ?? 0) > 0) {
    throw new TypeError('selector and project metadata is allowed only for related E2E');
  }
  return { argv, selectors, projects };
}

function assertEvidence(entry, index, { changeId, effectivePlanDigest }) {
  if (!entry || !Number.isInteger(entry.binding) || entry.binding < 1) throw new TypeError(`task evidence ${index} has invalid binding`);
  for (const [label, value] of [['packetDigest', entry.packetDigest], ['resultDigest', entry.resultDigest], ['provenanceDigest', entry.provenanceDigest]]) {
    if (!DIGEST.test(value ?? '')) throw new TypeError(`task evidence ${index} has invalid ${label}`);
  }
  const packetErrors = validateImplementationTaskStructure(entry.packet);
  if (packetErrors.length > 0) throw new TypeError(`task evidence ${index} packet is invalid: ${packetErrors.join('; ')}`);
  if (implementationTaskDigest(entry.packet) !== entry.packetDigest) throw new TypeError(`task evidence ${index} packet receipt does not match`);
  if (entry.packet.changeId !== changeId) throw new TypeError(`task evidence ${index} changeId does not match`);
  if (entry.packet.planDigest !== effectivePlanDigest) throw new TypeError(`task evidence ${index} effective plan does not match`);
  const resultErrors = validateImplementationResultAgainstTask(entry.packet, entry.result,
    entry.result.status === 'implemented' ? entry.result.changedPaths : undefined);
  if (resultErrors.length > 0) throw new TypeError(`task evidence ${index} result is invalid: ${resultErrors.join('; ')}`);
  if (digestJson(entry.result) !== entry.resultDigest || digestJson(entry.provenance) !== entry.provenanceDigest) throw new TypeError(`task evidence ${index} receipt does not match`);
  if (!['integrated', 'no-change'].includes(entry.terminalStatus)) throw new TypeError(`task evidence ${index} is not terminal`);
  if ((entry.terminalStatus === 'no-change') !== (entry.result.status === 'no-change')) throw new TypeError(`task evidence ${index} terminal status conflicts with result`);
  if (entry.terminalStatus === 'integrated') {
    if (!SHA.test(entry.integratedCommit ?? '') || !DIGEST.test(entry.integrationReceiptDigest ?? '') || !entry.integrationReceipt) throw new TypeError(`task evidence ${index} lacks integrated commit or receipt identity`);
    if (digestJson(entry.integrationReceipt) !== entry.integrationReceiptDigest) throw new TypeError(`task evidence ${index} integration receipt does not match`);
  } else if (entry.integratedCommit !== null || entry.integrationReceipt !== null || entry.integrationReceiptDigest !== null) {
    throw new TypeError(`task evidence ${index} no-change identity must not claim integration`);
  }
}

function addCommand(byArgv, ordered, candidate) {
  const key = JSON.stringify(candidate.argv); const existing = byArgv.get(key);
  if (!existing) {
    const command = { id: commandId(candidate.argv), kind: candidate.kind, argv: candidate.argv,
      reasons: unique(candidate.reasons), taskIds: unique(candidate.taskIds), selectors: candidate.selectors, projects: candidate.projects };
    byArgv.set(key, command); ordered.push(command); return;
  }
  if (existing.kind !== candidate.kind || JSON.stringify(existing.selectors) !== JSON.stringify(candidate.selectors)
      || JSON.stringify(existing.projects) !== JSON.stringify(candidate.projects)) {
    throw new TypeError(`conflicting validation metadata for ${commandText(candidate.argv)}`);
  }
  existing.reasons = unique([...existing.reasons, ...candidate.reasons]);
  existing.taskIds = unique([...existing.taskIds, ...candidate.taskIds]);
}

export function deriveValidationPlan({ changeId, effectivePlanDigest, headSha, taskEvidence, createdAt,
  featureDirectory, releaseEvidence = null } = {}) {
  if (!SHA.test(headSha ?? '')) throw new TypeError('headSha must be an exact commit');
  if (!DIGEST.test(effectivePlanDigest ?? '')) throw new TypeError('effectivePlanDigest must be canonical');
  if (!Array.isArray(taskEvidence) || taskEvidence.length === 0) throw new TypeError('taskEvidence must be nonempty');
  taskEvidence.forEach((entry, index) => assertEvidence(entry, index, { changeId, effectivePlanDigest }));
  const taskIds = taskEvidence.map(({ packet }) => packet.taskId);
  if (new Set(taskIds).size !== taskIds.length) throw new TypeError('task evidence contains duplicate task IDs');
  const ordered = []; const byArgv = new Map();
  for (const evidence of taskEvidence) for (const kind of ['unit', 'system']) for (const entry of evidence.packet.requiredValidation[kind]) {
    const normalized = canonicalizeValidationEntry(entry, { featureDirectory });
    addCommand(byArgv, ordered, { ...normalized, kind, reasons: [entry.reason], taskIds: [evidence.packet.taskId] });
  }
  const affected = new Set(taskEvidence.flatMap(({ packet }) => packet.affectedAreas));
  for (const area of AREA_ORDER) if (affected.has(area)) for (const command of AREA_COMMANDS.get(area)) {
    const normalized = canonicalizeValidationEntry({ command, reason: `Integrated affected-area check: ${area}.` });
    addCommand(byArgv, ordered, { ...normalized, kind: 'unit', reasons: [`Integrated affected-area check: ${area}.`],
      taskIds: taskEvidence.filter(({ packet }) => packet.affectedAreas.includes(area)).map(({ packet }) => packet.taskId) });
  }
  const needsRelease = affected.has('release') || affected.has('migration');
  if (needsRelease !== (releaseEvidence !== null)) throw new TypeError(needsRelease
    ? 'release or migration validation requires resolved release evidence' : 'release evidence is not relevant to this validation plan');
  if (releaseEvidence !== null && releaseEvidence.headSha !== headSha) throw new TypeError('release evidence must be bound to the validation HEAD');
  const tasks = taskEvidence.map(({ packet, binding, packetDigest, resultDigest, provenanceDigest, terminalStatus, integratedCommit, integrationReceiptDigest }) => ({ taskId: packet.taskId, binding, packetDigest, resultDigest, provenanceDigest, terminalStatus, integratedCommit, integrationReceiptDigest }));
  const plan = { schemaVersion: 1, changeId, effectivePlanDigest, headSha, createdAt,
    taskSetDigest: digestJson(taskSetProjection(tasks)), tasks, commands: ordered, releaseEvidence };
  const errors = validateVerificationContract('validationPlan', plan);
  if (errors.length > 0) throw new TypeError(`derived validation plan is invalid: ${errors.join('; ')}`);
  return plan;
}

export function captureReleaseEvidence({ cwd = process.cwd(), base = 'HEAD', head = 'HEAD', releaseRef = 'origin/main' } = {}) {
  const result = checkReleasedMigrations({ cwd, base, head, releaseRef });
  if (!result.ok || result.releaseState.status === 'inconsistent') throw new TypeError(`release or migration evidence is inconsistent: ${result.violations.map(({ code }) => code).join(', ')}`);
  const state = result.releaseState;
  return { schemaVersion: 1, baseSha: state.baseSha, headSha: state.headSha, releaseRef: state.releaseRef,
    releaseRefSha: state.releaseRefSha, status: state.status, latestRelease: state.latestRelease?.tag ?? null,
    frozenMigrationCount: state.frozenMigrations.length, evidenceDigest: digestJson({ releaseState: state, violations: result.violations }) };
}

export function validationPlanDigest(plan) {
  const errors = validateVerificationContract('validationPlan', plan);
  if (errors.length > 0) throw new TypeError(`invalid validation plan: ${errors.join('; ')}`);
  const { createdAt: _createdAt, ...semanticIdentity } = plan;
  return digestJson(semanticIdentity);
}

export function validationPlanReceiptDigest(plan) {
  const errors = validateVerificationContract('validationPlan', plan);
  if (errors.length > 0) throw new TypeError(`invalid validation plan: ${errors.join('; ')}`);
  return digestJson(plan);
}

export function findingFingerprint({ sourceKind, sourceRole, finding }) {
  const roles = ['development_integration_verifier', 'security_reviewer', 'offline_realtime_reviewer'];
  if (!['specialist', 'verifier'].includes(sourceKind) || !roles.includes(sourceRole) || !finding) throw new TypeError('finding fingerprint requires source kind, source role, and finding');
  if ((sourceKind === 'verifier') !== (sourceRole === 'development_integration_verifier')) throw new TypeError('finding source kind and role conflict');
  return digestJson({ sourceKind, sourceRole, id: finding.id, priority: finding.priority,
    criterionIds: [...finding.criterionIds].sort(), invariantIds: [...finding.invariantIds].sort(),
    affectedAreas: [...(finding.affectedAreas ?? [])].sort(),
    riskTags: [...(finding.riskTags ?? [])].sort(), recommendedSpecialization: finding.recommendedSpecialization ?? null });
}

export const affectedAreaCommands = AREA_COMMANDS;
