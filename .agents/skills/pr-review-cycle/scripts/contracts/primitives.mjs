const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const RAW_FIELD_PATTERN = /^(?:raw[_-]?(?:log|diff|output)|logs?|full[_-]?(?:diff|review|transcript)|stack(?:trace)?|transcript)$/iu;
const SAFE_REPOSITORY_SEGMENT_PATTERN = /^[^/\\\0*?\[\]{}]+$/u;

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isString(value, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

export function isSha(value, nullable = false) {
  return nullable && value === null ? true : typeof value === 'string' && SHA_PATTERN.test(value);
}

export function isDateTime(value, nullable = false) {
  return nullable && value === null
    ? true
    : typeof value === 'string' && DATE_TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

export function isHttpsUrl(value) {
  if (!isString(value, { min: 1, max: 2000 })) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

export function requireFields(value, fields, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  for (const field of fields) {
    if (!(field in value)) errors.push(`${path}.${field} is required`);
  }
  return true;
}

export function rejectUnknownFields(value, fields, path, errors) {
  if (!isObject(value)) return;
  const allowed = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${path}.${field} is not supported`);
  }
}

export function findRawFields(value, path = '$', errors = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findRawFields(item, `${path}[${index}]`, errors));
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (RAW_FIELD_PATTERN.test(key)) errors.push(`${path}.${key} is not allowed in active state`);
      findRawFields(item, `${path}.${key}`, errors);
    }
  }
  return errors;
}

export function validateValidationEntry(entry, path, errors) {
  if (!requireFields(entry, ['command', 'result', 'summary'], path, errors)) return;
  if (!isString(entry.command, { min: 1, max: 500 })) errors.push(`${path}.command must be 1-500 characters`);
  if (!['passed', 'failed', 'skipped'].includes(entry.result)) errors.push(`${path}.result is invalid`);
  if (!isString(entry.summary, { min: 1, max: 1000 })) errors.push(`${path}.summary must be 1-1000 characters`);
}

export function parseRepositoryPath(value, { allowOwnershipPattern = false } = {}) {
  if (!isString(value, { min: 1, max: 500 }) || value.startsWith('/') || value.endsWith('/')
      || value.includes('\\') || value.includes('//')) return null;
  const suffix = allowOwnershipPattern && value.endsWith('/**') ? '/**' : '';
  const path = suffix ? value.slice(0, -suffix.length) : value;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..'
      || !SAFE_REPOSITORY_SEGMENT_PATTERN.test(segment))) return null;
  return { path, recursive: suffix !== '' };
}

export function pathMatchesOwnership(changedPath, ownershipPattern) {
  const changed = parseRepositoryPath(changedPath);
  const ownership = parseRepositoryPath(ownershipPattern, { allowOwnershipPattern: true });
  if (!changed || !ownership) return false;
  return changed.path === ownership.path
    || (ownership.recursive && changed.path.startsWith(`${ownership.path}/`));
}

export function validateStringList(value, path, errors, max = 1000) {
  if (!Array.isArray(value) || value.some((item) => !isString(item, { min: 1, max }))) {
    errors.push(`${path} is invalid`);
    return;
  }
  if (new Set(value).size !== value.length) errors.push(`${path} contains duplicates`);
}
