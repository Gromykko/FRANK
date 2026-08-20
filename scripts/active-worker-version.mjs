import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    const raw = await readFile(0, 'utf8');
    const versionId = requireActiveWorkerVersion(JSON.parse(raw));
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
