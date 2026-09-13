/**
 * `killPreview` has to report an already-dead process the same way on every platform.
 *
 * The project-file journey tears the preview down in two steps — SIGTERM, wait, SIGKILL — and lets
 * `ESRCH` through as "it already exited" while rethrowing anything else. On POSIX that code comes
 * from `process.kill`. On Windows there is no process group to signal, so the tree kill is
 * `taskkill /T`, and its "no such process" exit status is translated by hand. A hand-written
 * translation is exactly the kind of thing that stops matching when the tool changes, and the
 * symptom would be a journey that fails during cleanup after passing.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

import { killPreview, spawnPreview } from './preview-server.mjs';

/** A process that exits immediately, so its pid is real but reaped by the time we signal it. */
const spawnExited = async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => {
    child.once('exit', resolve);
  });
  return child.pid;
};

test('reports an already-exited process as ESRCH', async () => {
  const pid = await spawnExited();

  assert.throws(() => killPreview(pid, 'SIGTERM'), { code: 'ESRCH' });
});

test('starts a preview server without a shell and stops it again', async (t) => {
  // Deliberately not one of the three ports the journeys bind, so running this beside them cannot
  // make either fail on `--strictPort`.
  const port = 4199;
  // `import.meta.dirname`, not a URL pathname: on Windows the latter is '/D:/...', which is not
  // a directory any process can start in.
  const preview = spawnPreview({
    cwd: resolve(import.meta.dirname, '..'),
    port,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  t.after(() => {
    try {
      killPreview(preview.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw error;
      }
    }
  });

  // The point of the assertion: a `.cmd` shim spawned without a shell fails here with ENOENT, which
  // is what this module exists to avoid, and a shell wrapper would make `preview.pid` the shell's.
  const spawned = await new Promise((resolve) => {
    preview.once('spawn', () => resolve(true));
    preview.once('error', () => resolve(false));
  });

  assert.equal(spawned, true, 'the preview server could not be spawned');
  assert.ok(preview.pid, 'the preview server has no pid');
});
