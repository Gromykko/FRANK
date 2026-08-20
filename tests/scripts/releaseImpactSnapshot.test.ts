// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildReleaseImpactSnapshot,
  parseReleaseImpactSnapshotArguments,
  runReleaseImpactSnapshotCli,
} from '../../scripts/release-impact-snapshot.mjs';
import { classifyReleaseImpact } from '../../scripts/release-impact.mjs';

const BASE_SHA = 'a'.repeat(40);
const CANDIDATE_SHA = 'b'.repeat(40);

function digest(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

const RELEASE_CONTRACT = `
export const API = 1;
export const MODEL = 7;
export const ASSEMBLED = 1;
export const MARINE = 1;
export const GENERATION = 'api1-model7';
export const PAYLOAD = 7;
export const SUPPORTED_FORECAST_API_SCHEMA_VERSIONS = [API] as const;
export const CURRENT_RELEASE = Object.freeze({
  apiSchemaVersion: API,
  modelRevision: MODEL,
  assembledCacheSchema: ASSEMBLED,
  marineCacheSchema: MARINE,
  dataGenerationId: GENERATION,
  payloadVersion: PAYLOAD,
});
export const AUDITED_PREVIOUS_FORECAST_GENERATIONS = Object.freeze([]);
`;

const LOCATIONS = JSON.stringify([
  {
    id: 'vejle',
    forecastConfigRevision: 1,
    name: 'Vejle',
    areaName: 'Vejle Fjord',
    timezone: 'Europe/Copenhagen',
    coordinate: { latitude: 55.7, longitude: 9.55 },
    dmiCollections: { water: ['dkss_idw'], waves: ['wam_nsb'] },
    emmaId: 'DK004',
    kommuneAliases: ['Vejle'],
  },
  {
    id: 'horsens',
    forecastConfigRevision: 1,
    name: 'Horsens',
    areaName: 'Horsens Fjord',
    timezone: 'Europe/Copenhagen',
    coordinate: { latitude: 55.86, longitude: 9.91 },
    dmiCollections: { water: ['dkss_idw'], waves: ['wam_nsb'] },
  },
]);

const PACKAGE_JSON = JSON.stringify({
  name: 'frank-fixture',
  version: '1.0.0',
  engines: { node: '>=22' },
  scripts: {
    build: 'vite build',
    'worker:upload-version': 'wrangler versions upload',
    'worker:deploy-versions': 'wrangler versions deploy',
    'worker:dry-run': 'wrangler versions upload --dry-run',
    'worker:warm': 'node scripts/warm-worker.mjs',
    'release:check-contract': 'node scripts/check-release-contract.mjs',
  },
  dependencies: { react: '1.0.0' },
  devDependencies: {
    '@vitejs/plugin-react': '1.0.0',
    typescript: '1.0.0',
    vite: '1.0.0',
    wrangler: '1.0.0',
  },
});

const PACKAGE_LOCK = JSON.stringify({
  name: 'frank-fixture',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: {
    '': {
      name: 'frank-fixture',
      version: '1.0.0',
      dependencies: { react: '1.0.0' },
      devDependencies: {
        '@vitejs/plugin-react': '1.0.0',
        typescript: '1.0.0',
        vite: '1.0.0',
        wrangler: '1.0.0',
      },
    },
    'node_modules/@vitejs/plugin-react': { version: '1.0.0' },
    'node_modules/react': { version: '1.0.0' },
    'node_modules/typescript': { version: '1.0.0' },
    'node_modules/vite': { version: '1.0.0' },
    'node_modules/wrangler': { version: '1.0.0' },
  },
});

function repositoryFiles(overrides: Record<string, string> = {}) {
  return {
    'index.html': '<main id="root"></main>',
    'vite.config.ts': "import react from '@vitejs/plugin-react'; import { defineConfig } from 'vite'; export default defineConfig({ plugins: [react()] });",
    'tsconfig.json': '{}',
    'tsconfig.app.json': '{}',
    'tsconfig.node.json': '{}',
    'tsconfig.worker.json': '{}',
    'wrangler.jsonc': '{}',
    'package.json': PACKAGE_JSON,
    'package-lock.json': PACKAGE_LOCK,
    'public/manifest.json': '{"name":"FRANK"}',
    'public/sw.js': 'self.addEventListener("fetch", () => {});',
    'src/main.tsx': "import React from 'react'; import './app'; import './styles.css'; void React;",
    'src/app.ts': "import locations from './config/locations.json'; export default locations;",
    'src/styles.css': "@import './theme.css';",
    'src/theme.css': ':root { color: blue; }',
    'src/config/locations.json': LOCATIONS,
    'src/features/forecast/releaseContract.ts': RELEASE_CONTRACT,
    'worker/index.ts': "import './model'; import '../src/config/locations.json'; import '../src/features/forecast/releaseContract';",
    'worker/model.ts': 'export const model = 7;',
    'scripts/forecast-model-contract.mjs': "export const FORECAST_SEMANTIC_INPUT_FILES = Object.freeze(['worker/model.ts']);",
    'scripts/release-impact.mjs': 'export const classifier = 1;',
    'scripts/release-impact-snapshot.mjs': 'export const builder = 1;',
    'scripts/coordinated-release.mjs': 'export const releaseJournal = 1;',
    'scripts/warm-worker.mjs': 'export const warm = 1;',
    'scripts/check-release-contract.mjs': 'export const check = 1;',
    'release/forecast-model-baseline.json': '{}',
    '.github/workflows/deploy-worker.yml': 'name: deploy',
    '.github/workflows/deploy.yml': 'name: validate',
    'README.md': 'fixture documentation',
    ...overrides,
  };
}

interface FakeGitOptions {
  head?: string;
  dirty?: boolean;
}

function fakeGit(
  commits: Record<string, Record<string, string | Buffer>>,
  { head = CANDIDATE_SHA, dirty = false }: FakeGitOptions = {},
) {
  const commands: string[][] = [];
  const objects = new Map<string, Buffer>();
  const trees = new Map<string, string>();
  for (const [sha, files] of Object.entries(commits)) {
    const records = Object.entries(files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([fileName, source]) => {
        const value = Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8');
        const objectId = digest(value);
        objects.set(objectId, value);
        return `100644 blob ${objectId}\t${fileName}\0`;
      });
    trees.set(sha, records.join(''));
  }

  const gitImpl = vi.fn(async (args: string[]) => {
    commands.push([...args]);
    if (args[0] === 'rev-parse') {
      const revision = args.at(-1)!;
      if (revision === 'HEAD^{commit}') return Buffer.from(`${head}\n`);
      const sha = revision.replace(/\^\{commit\}$/, '');
      if (!trees.has(sha)) throw new Error('unknown revision');
      return Buffer.from(`${sha}\n`);
    }
    if (args[0] === 'ls-tree') {
      const sha = args.at(-1)!;
      const tree = trees.get(sha);
      if (tree === undefined) throw new Error('unknown tree');
      return Buffer.from(tree);
    }
    if (args[0] === 'cat-file' && args[1] === 'blob') {
      const value = objects.get(args[2]);
      if (!value) throw new Error('unknown blob');
      return value;
    }
    if (args[0] === 'status') return dirty ? Buffer.from('?? src/new.ts\0') : Buffer.alloc(0);
    throw new Error(`unexpected git command: ${args.join(' ')}`);
  });
  return { gitImpl, commands };
}

async function build(
  sourceSha: string,
  provenance: 'candidate' | 'attested-production',
  gitImpl: (args: string[]) => Promise<Buffer>,
) {
  return buildReleaseImpactSnapshot({
    sourceSha,
    provenance,
    repositoryRoot: 'C:/fixture',
    gitImpl,
  });
}

describe('deterministic release-impact snapshots', () => {
  it('builds canonical identities from Git blobs without executing base code', async () => {
    delete (globalThis as Record<string, unknown>).__BASE_CODE_EXECUTED__;
    const maliciousButUnexecuted = `${RELEASE_CONTRACT}\nglobalThis.__BASE_CODE_EXECUTED__ = true;`;
    const { gitImpl, commands } = fakeGit({
      [BASE_SHA]: repositoryFiles({
        'src/features/forecast/releaseContract.ts': maliciousButUnexecuted,
      }),
    });

    const first = await build(BASE_SHA, 'attested-production', gitImpl);
    const second = await build(BASE_SHA, 'attested-production', gitImpl);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 1,
      sourceSha: BASE_SHA,
      provenance: 'attested-production',
      release: {
        apiSchemaVersion: 1,
        modelRevision: 7,
        dataGenerationId: 'api1-model7',
      },
      supportedApiSchemaVersions: [1],
      auditedPreviousReleases: [],
    });
    expect(first.pagesBuildId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.workerRuntimeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.locations.map(({ id }) => id)).toEqual(['horsens', 'vejle']);
    expect(globalThis).not.toHaveProperty('__BASE_CODE_EXECUTED__');
    expect(commands.some(([command]) => command === 'show')).toBe(false);
    expect(commands.filter(([command]) => command === 'cat-file')
      .every((args) => args.length === 3 && /^[a-f0-9]{64}$/.test(args[2]))).toBe(true);
  });

  it('leaves both fingerprints stable for a docs-only commit', async () => {
    const { gitImpl } = fakeGit({
      [BASE_SHA]: repositoryFiles(),
      [CANDIDATE_SHA]: repositoryFiles({ 'README.md': 'new docs only' }),
    });
    const baseSnapshot = await build(BASE_SHA, 'attested-production', gitImpl);
    const candidate = await build(CANDIDATE_SHA, 'candidate', gitImpl);
    expect(candidate.pagesBuildId).toBe(baseSnapshot.pagesBuildId);
    expect(candidate.workerRuntimeHash).toBe(baseSnapshot.workerRuntimeHash);
    expect(candidate.semanticInputs).toEqual(baseSnapshot.semanticInputs);
    expect(classifyReleaseImpact({
      trustedBase: baseSnapshot,
      candidate,
      trustedBaseSha: BASE_SHA,
      candidateSha: CANDIDATE_SHA,
    }).impact).toBe('none');
  });

  it('separates Pages-only, Worker-only, and forecast-semantic inputs', async () => {
    const baseFiles = repositoryFiles();
    const scenarios = [
      {
        override: { 'src/app.ts': 'export default "new UI";' },
        pagesChanged: true,
        workerChanged: false,
        semanticChanged: false,
      },
      {
        override: { 'worker/index.ts': "// health-only change\nimport './model'; import '../src/config/locations.json'; import '../src/features/forecast/releaseContract';" },
        pagesChanged: false,
        workerChanged: true,
        semanticChanged: false,
      },
      {
        override: { 'worker/model.ts': 'export const model = 8;' },
        pagesChanged: false,
        workerChanged: true,
        semanticChanged: true,
      },
    ];

    for (const scenario of scenarios) {
      const { gitImpl } = fakeGit({
        [BASE_SHA]: baseFiles,
        [CANDIDATE_SHA]: repositoryFiles(scenario.override),
      });
      const baseSnapshot = await build(BASE_SHA, 'attested-production', gitImpl);
      const candidate = await build(CANDIDATE_SHA, 'candidate', gitImpl);
      expect(candidate.pagesBuildId !== baseSnapshot.pagesBuildId).toBe(scenario.pagesChanged);
      expect(candidate.workerRuntimeHash !== baseSnapshot.workerRuntimeHash).toBe(scenario.workerChanged);
      expect(JSON.stringify(candidate.semanticInputs) !== JSON.stringify(baseSnapshot.semanticInputs))
        .toBe(scenario.semanticChanged);
    }
  });

  it('treats release-control tooling changes as Worker release-policy impact', async () => {
    const { gitImpl } = fakeGit({
      [BASE_SHA]: repositoryFiles(),
      [CANDIDATE_SHA]: repositoryFiles({
        'scripts/coordinated-release.mjs': 'export const releaseJournal = 2;',
      }),
    });
    const baseSnapshot = await build(BASE_SHA, 'attested-production', gitImpl);
    const candidate = await build(CANDIDATE_SHA, 'candidate', gitImpl);
    expect(candidate.pagesBuildId).toBe(baseSnapshot.pagesBuildId);
    expect(candidate.workerRuntimeHash).not.toBe(baseSnapshot.workerRuntimeHash);
    expect(classifyReleaseImpact({
      trustedBase: baseSnapshot,
      candidate,
      trustedBaseSha: BASE_SHA,
      candidateSha: CANDIDATE_SHA,
    }).impact).toBe('worker-nonsemantic');
  });

  it('fails closed on a nonexistent SHA or a dirty/non-HEAD candidate', async () => {
    const repository = { [CANDIDATE_SHA]: repositoryFiles() };
    const missing = fakeGit(repository);
    await expect(build(BASE_SHA, 'attested-production', missing.gitImpl))
      .rejects.toThrow('does not identify an existing commit');

    const dirty = fakeGit(repository, { dirty: true });
    await expect(build(CANDIDATE_SHA, 'candidate', dirty.gitImpl))
      .rejects.toThrow('dirty or untracked');

    const wrongHead = fakeGit(repository, { head: BASE_SHA });
    await expect(build(CANDIDATE_SHA, 'candidate', wrongHead.gitImpl))
      .rejects.toThrow('must equal the repository HEAD');
  });

  it('fails closed on malformed release and location contracts', async () => {
    const malformedRelease = fakeGit({
      [BASE_SHA]: repositoryFiles({
        'src/features/forecast/releaseContract.ts': 'export const CURRENT_RELEASE = (() => process.exit(1))();',
      }),
    });
    await expect(build(BASE_SHA, 'attested-production', malformedRelease.gitImpl))
      .rejects.toThrow(/missing|executable|unsupported/);

    const malformedLocations = fakeGit({
      [BASE_SHA]: repositoryFiles({ 'src/config/locations.json': '{not-json' }),
    });
    await expect(build(BASE_SHA, 'attested-production', malformedLocations.gitImpl))
      .rejects.toThrow('not valid JSON');
  });
});

describe('release-impact snapshot CLI', () => {
  it('requires an exact SHA and provenance contract', () => {
    expect(() => parseReleaseImpactSnapshotArguments(['--source-sha', BASE_SHA]))
      .toThrow('Missing required option: --provenance');
    expect(() => parseReleaseImpactSnapshotArguments(['--unknown', 'value']))
      .toThrow('Unknown snapshot-builder option');
  });

  it('writes deterministic JSON to stdout or the requested file', async () => {
    const built = {
      schemaVersion: 1,
      sourceSha: CANDIDATE_SHA,
      provenance: 'candidate',
      pagesBuildId: digest('pages'),
      workerRuntimeHash: digest('worker'),
      release: { apiSchemaVersion: 1 },
      supportedApiSchemaVersions: [1],
      auditedPreviousReleases: [],
      semanticInputs: {},
      locations: [],
    };
    const buildImpl = vi.fn(async () => built);
    const stdout = { write: vi.fn() };
    const writeFileImpl = vi.fn(async () => undefined);

    await runReleaseImpactSnapshotCli([
      '--source-sha', CANDIDATE_SHA,
      '--provenance', 'candidate',
    ], { buildImpl, stdout, writeFileImpl });
    expect(stdout.write).toHaveBeenCalledWith(`${JSON.stringify(built, null, 2)}\n`);
    expect(writeFileImpl).not.toHaveBeenCalled();

    await runReleaseImpactSnapshotCli([
      '--source-sha', CANDIDATE_SHA,
      '--provenance', 'candidate',
      '--output', 'snapshot.json',
    ], { buildImpl, stdout, writeFileImpl });
    expect(writeFileImpl).toHaveBeenCalledWith(
      expect.stringMatching(/snapshot\.json$/),
      `${JSON.stringify(built, null, 2)}\n`,
      'utf8',
    );
  });
});
