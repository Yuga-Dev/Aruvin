/**
 * ============================================================================
 * FILE: global-build.ts
 * LOCATION: backend/test/global-build.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Compile dist once before the routine suite so built-output specs can run.
 *
 * ROLE IN PROJECT:
 *    Specs that import or spawn dist/ (built assembly, bootstrap, telemetry,
 *    config-docs, bootstrap-auth) used to depend on a prior manual build, and
 *    bootstrap.spec rebuilt in its own beforeAll. nest build wipes dist, so that
 *    raced the other built specs running in parallel workers.
 *
 * KEY COMPONENTS:
 *    - setup: one serialized `nest build` with a scrubbed environment.
 * ============================================================================
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const backend = new URL('../', import.meta.url);

export async function setup(): Promise<void> {
  await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('node_modules/@nestjs/cli/bin/nest.js', backend)), 'build',
  ], {
    cwd: fileURLToPath(backend), timeout: 600_000, windowsHide: true,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP, TMP: process.env.TMP },
  });
}
