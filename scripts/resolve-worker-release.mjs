import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Read-only CLI contract:
//   node scripts/resolve-worker-release.mjs --source-sha <40-hex-sha> \
//     [--github-output <path>]
// GitHub outputs: action, source_sha, candidate_tag, deployment_mode,
// production_version_id/source_sha, candidate_version_id, and the currently
// staged candidate version/source identities (when present).

const execFileAsync = promisify(execFile);
const WRANGLER_CLI = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const SOURCE_SHA = /^[0-9a-f]{40}$/i;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANDIDATE_TAG_PREFIX = 'frank-sha-';
const SOURCE_TAG = /^frank-sha-([0-9a-f]{40})$/i;
const WRANGLER_OPTIONS = Object.freeze({
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 1024 * 1024,
});

function requireSourceSha(value) {
  if (typeof value !== 'string' || !SOURCE_SHA.test(value)) {
    throw new Error('Source SHA must be the exact 40-character Git commit SHA.');
  }
  return value.toLowerCase();
}

function requireVersionId(value, label) {
  if (typeof value !== 'string' || !VERSION_ID.test(value)) {
    throw new Error(`${label} has an invalid Worker version ID.`);
  }
  return value.toLowerCase();
}

export function candidateTagForSourceSha(sourceSha) {
  return `${CANDIDATE_TAG_PREFIX}${requireSourceSha(sourceSha)}`;
}

function normalizeDeploymentStatus(value) {
  const versions = value && typeof value === 'object' && Array.isArray(value.versions)
    ? value.versions
    : null;
  if (!versions || versions.length < 1 || versions.length > 2) {
    throw new Error(
      'Worker deployment must contain either one production version or production plus one zero-traffic candidate.',
    );
  }

  const normalized = versions.map((version, index) => {
    const versionId = requireVersionId(
      version?.version_id,
      `Worker deployment entry ${index + 1}`,
    );
    const percentage = Number(version?.percentage);
    if (!Number.isSafeInteger(percentage) || (percentage !== 0 && percentage !== 100)) {
      throw new Error('Worker deployment traffic must be an exact 100/0 release state.');
    }
    return { versionId, percentage };
  });

  if (new Set(normalized.map(({ versionId }) => versionId)).size !== normalized.length) {
    throw new Error('Worker deployment contains a duplicate version ID.');
  }

  const production = normalized.filter(({ percentage }) => percentage === 100);
  const candidates = normalized.filter(({ percentage }) => percentage === 0);
  if (production.length !== 1
    || candidates.length !== normalized.length - 1
    || (normalized.length === 1 && candidates.length !== 0)
    || (normalized.length === 2 && candidates.length !== 1)) {
    throw new Error('Worker deployment traffic must be an exact 100/0 release state.');
  }

  return Object.freeze({
    mode: candidates.length === 0 ? 'clean' : 'staged',
    productionVersionId: production[0].versionId,
    stagedCandidateVersionId: candidates[0]?.versionId ?? '',
  });
}

function deploymentFingerprint(value) {
  const deployment = normalizeDeploymentStatus(value);
  return [
    deployment.mode,
    deployment.productionVersionId,
    deployment.stagedCandidateVersionId,
  ].join(':');
}

function resolveTaggedCandidate(versionsList, candidateTag) {
  if (!Array.isArray(versionsList)) {
    throw new Error('Expected Wrangler versions list output to be an array.');
  }

  const matches = versionsList.filter(
    (version) => version?.annotations?.['workers/tag'] === candidateTag,
  );
  if (matches.length > 1) {
    throw new Error(`Candidate tag ${candidateTag} identifies more than one Worker version.`);
  }
  if (matches.length === 0) return '';
  return requireVersionId(matches[0]?.id, `Worker candidate tagged ${candidateTag}`);
}

function sourceShaForVersion(versionsList, versionId) {
  if (!Array.isArray(versionsList)) {
    throw new Error('Expected Wrangler versions list output to be an array.');
  }
  const matches = versionsList.filter((version) => version?.id === versionId);
  if (matches.length !== 1) {
    throw new Error(`Captured production version ${versionId} is missing or ambiguous.`);
  }
  const tag = matches[0]?.annotations?.['workers/tag'];
  if (typeof tag !== 'string') return '';
  const match = SOURCE_TAG.exec(tag);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Resolve the only safe next step without changing Worker traffic or uploading code.
 *
 * `replace-staged`: an older deterministic zero-traffic candidate must be
 * removed before this source can be uploaded or staged.
 * `upload`: no version exists for this source SHA.
 * `stage`: the immutable candidate exists but is not in the 100/0 deployment.
 * `warm`: the exact candidate is already staged at zero traffic.
 * `complete`: the exact candidate already serves all production traffic.
 */
export function resolveWorkerReleasePlan({
  sourceSha,
  deploymentStatus,
  versionsList,
} = {}) {
  const normalizedSha = requireSourceSha(sourceSha);
  const candidateTag = candidateTagForSourceSha(normalizedSha);
  const deployment = normalizeDeploymentStatus(deploymentStatus);
  const taggedCandidateVersionId = resolveTaggedCandidate(versionsList, candidateTag);
  const productionSourceSha = sourceShaForVersion(
    versionsList,
    deployment.productionVersionId,
  );

  let action;
  let candidateVersionId = taggedCandidateVersionId;
  let stagedCandidateVersionId = deployment.stagedCandidateVersionId;
  let stagedCandidateSourceSha = '';
  if (deployment.mode === 'staged') {
    stagedCandidateSourceSha = sourceShaForVersion(
      versionsList,
      deployment.stagedCandidateVersionId,
    );
    if (taggedCandidateVersionId === deployment.stagedCandidateVersionId) {
      action = 'warm';
    } else {
      if (!stagedCandidateSourceSha || stagedCandidateSourceSha === normalizedSha) {
        throw new Error(
          'The zero-traffic Worker version has no safe deterministic source identity.',
        );
      }
      action = 'replace-staged';
    }
  } else if (!taggedCandidateVersionId) {
    action = 'upload';
  } else if (taggedCandidateVersionId === deployment.productionVersionId) {
    action = 'complete';
  } else {
    action = 'stage';
  }

  if (action === 'upload') candidateVersionId = '';
  if (deployment.mode === 'clean') stagedCandidateVersionId = '';
  return Object.freeze({
    action,
    sourceSha: normalizedSha,
    candidateTag,
    deploymentMode: deployment.mode,
    productionVersionId: deployment.productionVersionId,
    productionSourceSha,
    candidateVersionId,
    stagedCandidateVersionId,
    stagedCandidateSourceSha,
  });
}

function parseWranglerJson(stdout, label) {
  if (typeof stdout !== 'string') {
    throw new Error(`${label} did not return text.`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
}

async function runWranglerJson(args, label, execFileImpl) {
  const result = await execFileImpl(
    process.execPath,
    [WRANGLER_CLI, ...args],
    WRANGLER_OPTIONS,
  );
  return parseWranglerJson(result?.stdout, label);
}

/**
 * Read-only, cross-platform inspection. The deployment is read twice so a
 * concurrent control-plane change cannot be mistaken for a resumable state.
 */
export async function inspectWorkerRelease({
  sourceSha,
  execFileImpl = execFileAsync,
} = {}) {
  const normalizedSha = requireSourceSha(sourceSha);
  if (typeof execFileImpl !== 'function') {
    throw new Error('Wrangler exec adapter must be a function.');
  }

  const deploymentBefore = await runWranglerJson(
    ['deployments', 'status', '--json'],
    'Wrangler deployment status',
    execFileImpl,
  );
  const versionsList = await runWranglerJson(
    ['versions', 'list', '--json'],
    'Wrangler versions list',
    execFileImpl,
  );
  const deploymentAfter = await runWranglerJson(
    ['deployments', 'status', '--json'],
    'Wrangler deployment status',
    execFileImpl,
  );

  if (deploymentFingerprint(deploymentBefore) !== deploymentFingerprint(deploymentAfter)) {
    throw new Error('Worker deployment changed during release inspection; retry from fresh state.');
  }
  return resolveWorkerReleasePlan({
    sourceSha: normalizedSha,
    deploymentStatus: deploymentAfter,
    versionsList,
  });
}

export function githubOutputForWorkerRelease(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('A resolved Worker release plan is required.');
  }
  return [
    `action=${plan.action}`,
    `source_sha=${plan.sourceSha}`,
    `candidate_tag=${plan.candidateTag}`,
    `deployment_mode=${plan.deploymentMode}`,
    `production_version_id=${plan.productionVersionId}`,
    `production_source_sha=${plan.productionSourceSha}`,
    `candidate_version_id=${plan.candidateVersionId}`,
    `staged_candidate_version_id=${plan.stagedCandidateVersionId}`,
    `staged_candidate_source_sha=${plan.stagedCandidateSourceSha}`,
    '',
  ].join('\n');
}

export function parseCliArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== '--source-sha' && option !== '--github-output') {
      throw new Error(
        'Usage: node scripts/resolve-worker-release.mjs --source-sha <40-hex-sha> [--github-output <path>]',
      );
    }
    if (values.has(option)
      || index + 1 >= argv.length
      || argv[index + 1].length === 0
      || argv[index + 1].startsWith('--')) {
      throw new Error(`Option ${option} requires exactly one value.`);
    }
    values.set(option, argv[index + 1]);
    index += 1;
  }

  const sourceSha = values.get('--source-sha');
  if (!sourceSha) {
    throw new Error(
      'Usage: node scripts/resolve-worker-release.mjs --source-sha <40-hex-sha> [--github-output <path>]',
    );
  }
  return {
    sourceSha: requireSourceSha(sourceSha),
    githubOutput: values.get('--github-output') ?? '',
  };
}

export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseCliArgs(argv);
  const plan = await inspectWorkerRelease({
    sourceSha: options.sourceSha,
    execFileImpl: dependencies.execFileImpl,
  });
  if (options.githubOutput) {
    const appendFileImpl = dependencies.appendFileImpl ?? appendFile;
    await appendFileImpl(options.githubOutput, githubOutputForWorkerRelease(plan), 'utf8');
  }
  process.stdout.write(`${JSON.stringify(plan)}\n`);
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : 'Worker release state could not be resolved.';
    console.error(`[release] ${message}`);
    process.exitCode = 1;
  });
}
