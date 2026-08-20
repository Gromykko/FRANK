import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WRANGLER_CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const execFileAsync = promisify(execFile);

export function requireActiveWorkerVersion(value) {
  const versions = value && typeof value === 'object' && Array.isArray(value.versions)
    ? value.versions
    : [];
  const active = versions.filter((version) => Number(version?.percentage) === 100);
  const versionId = active.length === 1 ? active[0]?.version_id : null;

  if (typeof versionId !== 'string' || !VERSION_ID.test(versionId)) {
    throw new Error('Expected exactly one valid Worker version serving 100% of production traffic.');
  }
  return versionId;
}

export async function runCli() {
  try {
    // Invoke the repository-pinned Wrangler directly. The previous shell pipe
    // relied on readFile(0), which is not a portable way to consume piped stdin
    // on Windows and made the documented local release flow fail before deploy.
    const { stdout } = await execFileAsync(
      process.execPath,
      [WRANGLER_CLI, 'deployments', 'status', '--json'],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const versionId = requireActiveWorkerVersion(JSON.parse(stdout));
    process.stdout.write(versionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Active Worker version could not be read.';
    console.error(`[release] ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
