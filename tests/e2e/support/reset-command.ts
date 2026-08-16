import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DATABASE_RESET_ARGS = Object.freeze([
  'run',
  'db:seed',
  '-w',
  '@aerstello/api',
] as const);

export interface DatabaseResetCommand {
  readonly file: 'npm';
  readonly args: readonly string[];
  readonly options: {
    readonly cwd: string;
    readonly env: Readonly<NodeJS.ProcessEnv>;
    readonly stdio: 'pipe';
  };
}

export interface DatabaseResetCommandInput {
  readonly cwd?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
}

export type DatabaseResetRunner = (command: DatabaseResetCommand) => void | Promise<void>;

export function createDatabaseResetCommand(
  input: DatabaseResetCommandInput = {},
): DatabaseResetCommand {
  const env = Object.freeze({
    ...(input.env ?? process.env),
    E2E_RESET: 'true',
    SEED_ADMIN_PASSWORD: 'AerstelloTest123!',
  });
  const options = Object.freeze({
    cwd: input.cwd ?? process.cwd(),
    env,
    stdio: 'pipe' as const,
  });

  return Object.freeze({
    file: 'npm' as const,
    args: DATABASE_RESET_ARGS,
    options,
  });
}

export const defaultDatabaseResetRunner: DatabaseResetRunner = async ({ file, args, options }) => {
  await execFileAsync(file, [...args], options);
};

export async function executeDatabaseReset(
  input: DatabaseResetCommandInput = {},
  runner: DatabaseResetRunner = defaultDatabaseResetRunner,
): Promise<void> {
  await runner(createDatabaseResetCommand(input));
}
