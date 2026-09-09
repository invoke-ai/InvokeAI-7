/**
 * The `vite preview` server the browser-driving scripts measure against.
 *
 * Three scripts need it — the architecture performance measurement, the accessibility journeys and
 * the project-file journey — and each needs the same two things: start a preview server on a fixed
 * port, and take it down again along with anything it spawned. Both halves are platform-sensitive
 * in ways that are easy to get subtly wrong, so they live here once.
 *
 * Starting it as `pnpm exec vite preview` does not work on Windows: `pnpm` there is a `.cmd` shim,
 * and Node refuses to exec one without `shell: true`. Adding a shell would start it, but it also
 * puts `cmd.exe` between the script and vite — teardown signals the process it spawned, which would
 * then be the shell rather than the server, leaving the port bound and the next run failing on
 * `--strictPort`. Running vite's own entry under this same Node keeps the child a plain process
 * everywhere and needs no shell at all.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';

const isWindows = process.platform === 'win32';

// Resolved through `package.json` rather than `vite/bin/vite.js` directly: vite's `exports` map
// does not expose the bin path, so asking for it by subpath throws ERR_PACKAGE_PATH_NOT_EXPORTED.
const viteBin = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');

/**
 * Start a preview server on `port`, bound to loopback and refusing to drift to another port.
 *
 * Every option other than `port` is passed through to `spawn`, so callers keep control of `cwd`,
 * `env` and `stdio` — they differ between the three scripts.
 */
export const spawnPreview = ({ port, ...options }) =>
  spawn(process.execPath, [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    // What puts the child in its own process group, so `killPreview` can signal the whole tree.
    // Windows has no process groups, and `detached` there means "own console window" instead —
    // not useful, and it flashes one up on every run.
    detached: !isWindows,
    ...options,
  });

/**
 * Stop a preview server started by `spawnPreview`, including any child processes of its own.
 *
 * Throws the way `process.kill` does — notably `ESRCH` when the server has already exited, which
 * callers distinguish from a real failure.
 */
export const killPreview = (pid, signal) => {
  if (!isWindows) {
    process.kill(-pid, signal);
    return;
  }

  // No process groups here, so the tree walk is taskkill's `/T`. `/F` because the signal argument
  // has no Windows equivalent: a graceful stop would need a console control event, which cannot be
  // sent to a process that does not share this one's console.
  const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });

  // taskkill reports 128 for "no such process", which is what ESRCH means to every caller here.
  if (result.status === 128) {
    throw Object.assign(new Error(`No such process: ${pid}`), { code: 'ESRCH' });
  }

  if (result.error) {
    throw result.error;
  }
};
