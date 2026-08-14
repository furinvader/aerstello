import { withStateLock } from '../state.mjs';

const [cwd, prNumber, holdMilliseconds = '250'] = process.argv.slice(2);

try {
  withStateLock(cwd, Number(prNumber), () => {
    process.stdout.write('locked\n');
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      Number(holdMilliseconds),
    );
  });
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(`${error.code ?? error.name}: ${error.message}\n`);
  process.exitCode = 1;
}
