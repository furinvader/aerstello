import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { ResourceRegistry, type ResourceRegistration } from './resource-registry.ts';

export interface ApiReplicaOptions {
  readonly port: number;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly execPath?: string;
  readonly stdio?: SpawnOptions['stdio'];
  readonly terminateTimeoutMs?: number;
  readonly killTimeoutMs?: number;
  readonly spawn?: typeof nodeSpawn;
}

export interface OwnedApiReplica {
  readonly child: ChildProcess;
  readonly baseURL: string;
  dispose(): Promise<void>;
}

export interface ChildTerminationOptions {
  readonly terminateTimeoutMs?: number;
  readonly killTimeoutMs?: number;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function finalExit(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      child.removeListener('exit', finish);
      child.removeListener('error', handleError);
      resolve();
    };
    const handleError = () => {
      // A spawn failure has no operating-system process to reap. Errors from a
      // signal sent to an existing process are not exit evidence, however.
      if (child.pid === undefined) finish();
    };
    child.once('exit', finish);
    child.on('error', handleError);
    if (hasExited(child)) finish();
  });
}

async function waitForExit(exit: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(resolve, timeoutMs, false);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function terminateChildProcess(
  child: ChildProcess,
  options: ChildTerminationOptions = {},
): Promise<void> {
  if (hasExited(child)) return;
  const exit = finalExit(child);

  let termSent = false;
  try {
    termSent = child.kill('SIGTERM');
  } catch {
    termSent = false;
  }
  if (termSent && await waitForExit(exit, options.terminateTimeoutMs ?? 5_000)) return;
  if (hasExited(child)) return;

  try {
    child.kill('SIGKILL');
  } catch {
    // The final bounded wait below remains authoritative for process exit.
  }
  if (await waitForExit(exit, options.killTimeoutMs ?? 5_000)) return;
  throw new Error('API replica did not exit after SIGKILL');
}

export async function startApiReplica(
  resources: ResourceRegistry,
  options: ApiReplicaOptions,
): Promise<OwnedApiReplica> {
  const spawn = options.spawn ?? nodeSpawn;
  const child = spawn(options.execPath ?? process.execPath, [...(options.args ?? ['apps/api/dist/index.js'])], {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env, PORT: String(options.port) },
    stdio: options.stdio ?? 'ignore',
  });

  let registration: ResourceRegistration<ChildProcess>;
  try {
    registration = resources.own(`API replica on port ${options.port}`, child, (ownedChild) => (
      terminateChildProcess(ownedChild, options)
    ));
  } catch (error) {
    await terminateChildProcess(child, options);
    throw error;
  }

  return {
    child,
    baseURL: `http://127.0.0.1:${options.port}`,
    dispose: () => registration.dispose(),
  };
}
