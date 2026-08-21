import { validateSpecialization } from '../../../aerstello-specialists/scripts/validate-registry.mjs';

import { sha256CanonicalContractJson } from './contract-identities.mjs';
import {
  findRawFields,
  isSha,
  isString,
  parseRepositoryPath,
  rejectUnknownFields,
  requireFields,
  validateStringList,
} from './primitives.mjs';
import { validateAffectedAreas, validateRequiredValidation } from './targeted-validation.mjs';

export function taskPacketDigest(packet) {
  return sha256CanonicalContractJson(packet);
}

export function validateTaskPacket(value) {
  const errors = [];
  const fields = [
    'schemaVersion',
    'taskId',
    'reviewedHeadSha',
    'specialization',
    'riskTags',
    'finding',
    'evidence',
    'affectedAreas',
    'decisionIds',
    'allowedPaths',
    'forbiddenPaths',
    'dependencies',
    'acceptanceCriteria',
    'requiredValidation',
  ];
  if (!requireFields(value, fields, '$', errors)) return errors;
  rejectUnknownFields(value, fields, '$', errors);
  if (value.schemaVersion !== 3) errors.push('$.schemaVersion must equal 3');
  if (!isString(value.taskId, { min: 1, max: 128 })) errors.push('$.taskId must be 1-128 characters');
  if (!isSha(value.reviewedHeadSha)) errors.push('$.reviewedHeadSha must be a full Git SHA');
  if (!isString(value.finding, { min: 1, max: 2000 })) errors.push('$.finding must be concise');
  if (!isString(value.evidence, { min: 1, max: 3000 })) errors.push('$.evidence must be concise');
  for (const field of ['decisionIds', 'riskTags', 'allowedPaths', 'forbiddenPaths', 'dependencies', 'acceptanceCriteria']) {
    validateStringList(value[field], `$.${field}`, errors);
  }
  validateAffectedAreas(value.affectedAreas, '$.affectedAreas', errors);
  const specializationHasValidShape = isString(value.specialization, { min: 1, max: 128 });
  if (!specializationHasValidShape) {
    errors.push('$.specialization must be a 1-128 character specialist profile ID');
  } else if (Array.isArray(value.affectedAreas) && Array.isArray(value.riskTags)) {
    errors.push(...validateSpecialization({
      specialization: value.specialization,
      affectedAreas: value.affectedAreas,
      riskTags: value.riskTags,
    }).map((error) => `$.specialization: ${error}`));
  }
  if (Array.isArray(value.allowedPaths) && value.allowedPaths.length === 0) errors.push('$.allowedPaths must not be empty');
  for (const field of ['allowedPaths', 'forbiddenPaths']) {
    if (Array.isArray(value[field])) value[field].forEach((path, index) => {
      if (!parseRepositoryPath(path, { allowOwnershipPattern: true })) {
        errors.push(`$.${field}[${index}] must be a safe repository-relative path or trailing /** pattern`);
      }
    });
  }
  validateRequiredValidation(value.requiredValidation, '$.requiredValidation', errors);
  findRawFields(value, '$', errors);
  return errors;
}
