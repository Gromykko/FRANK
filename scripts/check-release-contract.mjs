import { pathToFileURL } from 'node:url';
import { loadReleaseContract } from './warm-worker.mjs';

export async function checkReleaseContract() {
  const contract = await loadReleaseContract();
  return {
    apiSchemaVersion: contract.release.apiSchemaVersion,
    dataGenerationId: contract.release.dataGenerationId,
    locationCount: contract.locationIds.length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkReleaseContract()
    .then(({ apiSchemaVersion, dataGenerationId, locationCount }) => {
      process.stdout.write(
        `release contract valid: api v${apiSchemaVersion}, ${dataGenerationId}, ${locationCount} locations`,
      );
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : 'Release contract is invalid.';
      console.error(`[release] ${message}`);
      process.exitCode = 1;
    });
}
