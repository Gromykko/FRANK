const RELEASE_SCHEMA_VERSION = 1
const CHECK_THROTTLE_MS = 30_000
export const RELEASE_CHECK_TIMEOUT_MS = 10_000

interface ReleaseDescriptor {
  schemaVersion: 1
  buildId: string
  builtAt: string
  baseUrl: string
  serviceWorkerUrl: string
  shellUrl: string
  precacheManifestUrl: string
  staticShellUrls: string[]
}

interface ReleaseUpdateManager {
  checkNow: () => Promise<void>
  stop: () => void
}

let activePreparedReleaseCheck: (() => Promise<void>) | null = null

// The visible refresh control refreshes the whole product: forecast data is
// re-read by the forecast hook, while this discovers a fully prepared app
// shell. Discovery is silent and transactional; it never swaps the currently
// running document or exposes a partially downloaded release.
export function requestPreparedAppReleaseCheck(): Promise<void> {
  return activePreparedReleaseCheck?.() ?? Promise.resolve()
}

function scopedUrl(value: unknown, expectedPath: string, origin: string, baseUrl: string) {
  if (typeof value !== 'string') throw new Error('Release descriptor URL is missing')
  const url = new URL(value, origin)
  const expected = new URL(`${baseUrl}${expectedPath}`, origin)
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new Error('Release descriptor URL escaped the app scope')
  }
  return url
}

function parseReleaseDescriptor(value: unknown, origin: string, baseUrl: string): ReleaseDescriptor {
  if (!value || typeof value !== 'object') throw new Error('Release descriptor is not an object')
  const candidate = value as Partial<ReleaseDescriptor>
  if (candidate.schemaVersion !== RELEASE_SCHEMA_VERSION) {
    throw new Error('Unsupported release descriptor schema')
  }
  if (
    typeof candidate.buildId !== 'string'
    || candidate.buildId.length === 0
    || candidate.buildId.length > 256
    || [...candidate.buildId].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 31 || codePoint === 127
    })
  ) {
    throw new Error('Release descriptor has an invalid build id')
  }
  if (typeof candidate.builtAt !== 'string' || !Number.isFinite(Date.parse(candidate.builtAt))) {
    throw new Error('Release descriptor has an invalid build time')
  }

  const expectedBase = new URL(baseUrl, origin)
  const descriptorBase = scopedUrl(candidate.baseUrl, '', origin, baseUrl)
  if (descriptorBase.toString() !== expectedBase.toString()) {
    throw new Error('Release descriptor has the wrong app base URL')
  }

  const serviceWorkerUrl = scopedUrl(candidate.serviceWorkerUrl, 'sw.js', origin, baseUrl)
  const shellUrl = scopedUrl(candidate.shellUrl, 'index.html', origin, baseUrl)
  const precacheManifestUrl = scopedUrl(candidate.precacheManifestUrl, 'frank-precache.json', origin, baseUrl)
  if (
    serviceWorkerUrl.searchParams.get('build') !== candidate.buildId
    || shellUrl.searchParams.get('frank-build') !== candidate.buildId
    || precacheManifestUrl.searchParams.get('frank-build') !== candidate.buildId
  ) {
    throw new Error('Release descriptor URLs do not match its build')
  }
  if (!Array.isArray(candidate.staticShellUrls) || candidate.staticShellUrls.some((item) => typeof item !== 'string')) {
    throw new Error('Release descriptor has an invalid static shell')
  }

  return {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    buildId: candidate.buildId,
    builtAt: candidate.builtAt,
    baseUrl: descriptorBase.pathname,
    serviceWorkerUrl: serviceWorkerUrl.toString(),
    shellUrl: shellUrl.toString(),
    precacheManifestUrl: precacheManifestUrl.toString(),
    staticShellUrls: candidate.staticShellUrls,
  }
}

function cacheBuster() {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  return `${Date.now()}-${random}`
}

async function fetchCurrentRelease(baseUrl: string) {
  const descriptorUrl = new URL(`${baseUrl}frank-release.json`, window.location.origin)
  descriptorUrl.searchParams.set('check', cacheBuster())
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), RELEASE_CHECK_TIMEOUT_MS)
  try {
    const response = await fetch(descriptorUrl, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Release check failed with ${response.status}`)
    return parseReleaseDescriptor(await response.json(), window.location.origin, baseUrl)
  } finally {
    // A stalled descriptor must release the manager's single-flight slot so a
    // later focus/manual check can recover without reloading the whole app.
    window.clearTimeout(timeoutId)
  }
}

function workerBuildId(worker: ServiceWorker | null) {
  if (!worker) return null
  return new URL(worker.scriptURL).searchParams.get('build')
}

export function startReleaseUpdateManager(baseUrl = import.meta.env.BASE_URL): ReleaseUpdateManager {
  let stopped = false
  let inFlight: Promise<void> | null = null
  let lastCheckAt = 0
  let latestRegistration: ServiceWorkerRegistration | null = null
  let latestBuildId: string | null = null

  const check = async (force = false) => {
    if (stopped) return
    const now = Date.now()
    if (!force && now - lastCheckAt < CHECK_THROTTLE_MS) return
    if (inFlight) return inFlight
    lastCheckAt = now

    inFlight = (async () => {
      const release = await fetchCurrentRelease(baseUrl)
      if (stopped) return
      latestBuildId = release.buildId

      const current = await navigator.serviceWorker.getRegistration(baseUrl)
      if (current?.waiting && workerBuildId(current.waiting) === release.buildId) {
        latestRegistration = current
        return
      }
      if (current?.installing && workerBuildId(current.installing) === release.buildId) {
        latestRegistration = current
        return
      }
      if (current?.active && workerBuildId(current.active) === release.buildId) {
        latestRegistration = current
        return
      }

      latestRegistration = await navigator.serviceWorker.register(release.serviceWorkerUrl, {
        scope: baseUrl,
        updateViaCache: 'none',
      })
    })()
      .catch((error: unknown) => {
        // Updating the shell is opportunistic. A failed/partial release must
        // leave the already verified app fully usable and quiet for the user.
        console.error('FRANK app update check failed:', error)
      })
      .finally(() => {
        inFlight = null
      })

    return inFlight
  }

  const onFocus = (event: Event) => {
    if (document.visibilityState === 'visible') void check(event.type === 'focus')
  }
  const onPageHide = () => {
    const waiting = latestRegistration?.waiting
    if (!waiting || workerBuildId(waiting) !== latestBuildId) return
    // The waiting worker rechecks that no FRANK windows remain before it calls
    // skipWaiting(). It gives up after two seconds and never reloads this page.
    waiting.postMessage({ type: 'FRANK_ACTIVATE_WHEN_IDLE', buildId: latestBuildId })
  }

  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onFocus)
  window.addEventListener('pagehide', onPageHide)
  void check(true)

  const checkNow = () => check(true)
  activePreparedReleaseCheck = checkNow

  return {
    checkNow,
    stop() {
      stopped = true
      if (activePreparedReleaseCheck === checkNow) activePreparedReleaseCheck = null
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('pagehide', onPageHide)
    },
  }
}
