import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
export const skillDirectory = dirname(scriptsDirectory);
export const profilesDirectory = join(skillDirectory, 'profiles');
export const referencesDirectory = join(skillDirectory, 'references');
export const schemasDirectory = join(skillDirectory, 'schemas');
export const registryPath = join(skillDirectory, 'registry.json');
export const registrySchemaPath = join(schemasDirectory, 'registry.schema.json');

export function repositoryRoot(startDirectory = skillDirectory) {
  let current = resolve(startDirectory);
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`cannot find repository root from ${startDirectory}`);
    current = parent;
  }
}

export function repositoryPath(...segments) {
  return join(repositoryRoot(), ...segments);
}

export function skillPath(...segments) {
  return join(skillDirectory, ...segments);
}
