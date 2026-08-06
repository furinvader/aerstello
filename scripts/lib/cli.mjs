export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export function parseOptions(argv, { booleans = [], values = [], aliases = {} } = {}) {
  const booleanSet = new Set(booleans);
  const valueSet = new Set(values);
  const result = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === '--') {
      result._.push(...argv.slice(index + 1));
      break;
    }
    if (!raw.startsWith('--')) {
      result._.push(raw);
      continue;
    }

    const equals = raw.indexOf('=');
    const rawName = raw.slice(2, equals < 0 ? undefined : equals);
    const name = aliases[rawName] ?? rawName;
    if (booleanSet.has(name)) {
      if (equals >= 0) throw new UsageError(`--${rawName} does not accept a value`);
      result[name] = true;
      continue;
    }
    if (!valueSet.has(name)) throw new UsageError(`Unknown option --${rawName}`);
    const value = equals >= 0 ? raw.slice(equals + 1) : argv[index + 1];
    if (value === undefined || (equals < 0 && value.startsWith('--'))) {
      throw new UsageError(`--${rawName} requires a value`);
    }
    result[name] = value;
    if (equals < 0) index += 1;
  }

  return result;
}

export function writeJson(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}
