import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RELEASE_CHECK_TIMEOUT_MS,
  requestPreparedAppReleaseCheck,
  startReleaseUpdateManager,
} from '../../src/pwa/releaseUpdate'

const BASE_URL = '/FRANK/'
const BUILD_A = 'build-a'
const BUILD_B = 'build-b'

function descriptor(buildId = BUILD_B) {
  const query = encodeURIComponent(buildId)
  return {
    schemaVersion: 1,
    buildId,
    builtAt: '2026-08-20T12:00:00.000Z',
    baseUrl: BASE_URL,
    serviceWorkerUrl: `${BASE_URL}sw.js?build=${query}`,
    shellUrl: `${BASE_URL}index.html?frank-build=${query}`,
    precacheManifestUrl: `${BASE_URL}frank-precache.json?frank-build=${query}`,
    staticShellUrls: [`${BASE_URL}manifest.json?frank-build=${query}`],
  }
}

function worker(buildId: string, postMessage = vi.fn()) {
  return {
    scriptURL: `${window.location.origin}${BASE_URL}sw.js?build=${encodeURIComponent(buildId)}`,
    postMessage,
  } as unknown as ServiceWorker
}

function installServiceWorkerMock(registration: Partial<ServiceWorkerRegistration> | null = null) {
  const register = vi.fn(async () => registration as ServiceWorkerRegistration)
  const getRegistration = vi.fn(async () => registration as ServiceWorkerRegistration | undefined)
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { register, getRegistration },
  })
  return { getRegistration, register }
}

function mockReleaseFetch(value: unknown = descriptor()) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'serviceWorker')
})

describe('release update discovery', () => {
  it('fetches a cache-busted descriptor and registers its exact worker without HTTP cache reuse', async () => {
    const registration = { active: worker(BUILD_A), waiting: null, installing: null }
    const serviceWorker = installServiceWorkerMock(registration)
    const fetchMock = mockReleaseFetch()
    const manager = startReleaseUpdateManager(BASE_URL)

    await manager.checkNow()
    manager.stop()

    expect(fetchMock).toHaveBeenCalled()
    const [requestUrl, options] = fetchMock.mock.calls.at(-1)!
    const url = new URL(requestUrl instanceof Request ? requestUrl.url : requestUrl)
    expect(url.pathname).toBe(`${BASE_URL}frank-release.json`)
    expect(url.searchParams.get('check')).toBeTruthy()
    expect(options).toMatchObject({ cache: 'no-store', credentials: 'same-origin' })
    expect(serviceWorker.register).toHaveBeenCalledWith(
      `${window.location.origin}${BASE_URL}sw.js?build=${BUILD_B}`,
      { scope: BASE_URL, updateViaCache: 'none' },
    )
  })

  it('does not restart an already complete waiting candidate', async () => {
    const registration = { active: worker(BUILD_A), waiting: worker(BUILD_B), installing: null }
    const serviceWorker = installServiceWorkerMock(registration)
    mockReleaseFetch()
    const manager = startReleaseUpdateManager(BASE_URL)

    await manager.checkNow()
    manager.stop()

    expect(serviceWorker.register).not.toHaveBeenCalled()
  })

  it('lets the product refresh control request prepared shell discovery', async () => {
    const registration = { active: worker(BUILD_A), waiting: null, installing: null }
    const serviceWorker = installServiceWorkerMock(registration)
    mockReleaseFetch()
    const manager = startReleaseUpdateManager(BASE_URL)

    await requestPreparedAppReleaseCheck()
    manager.stop()

    expect(serviceWorker.register).toHaveBeenCalledWith(
      `${window.location.origin}${BASE_URL}sw.js?build=${BUILD_B}`,
      { scope: BASE_URL, updateViaCache: 'none' },
    )
  })

  it('times out a stalled descriptor and releases inFlight for the next check', async () => {
    vi.useFakeTimers()
    const registration = { active: worker(BUILD_A), waiting: null, installing: null }
    const serviceWorker = installServiceWorkerMock(registration)
    let requestCount = 0
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requestCount += 1
      if (requestCount === 1) {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal
          if (!signal) {
            reject(new Error('release fetch had no abort signal'))
            return
          }
          const abort = () => reject(new DOMException('Release check timed out', 'AbortError'))
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        })
      }
      return Promise.resolve(new Response(JSON.stringify(descriptor()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const manager = startReleaseUpdateManager(BASE_URL)

    const stalledCheck = manager.checkNow()
    await vi.advanceTimersByTimeAsync(RELEASE_CHECK_TIMEOUT_MS)
    await stalledCheck

    const firstOptions = fetchMock.mock.calls[0]?.[1]
    expect(firstOptions?.signal?.aborted).toBe(true)
    await manager.checkNow()
    manager.stop()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(serviceWorker.register).toHaveBeenCalledWith(
      `${window.location.origin}${BASE_URL}sw.js?build=${BUILD_B}`,
      { scope: BASE_URL, updateViaCache: 'none' },
    )
  })

  it('asks the waiting worker to activate only as the page closes and never reloads', async () => {
    const postMessage = vi.fn()
    const registration = {
      active: worker(BUILD_A),
      waiting: worker(BUILD_B, postMessage),
      installing: null,
    }
    installServiceWorkerMock(registration)
    mockReleaseFetch()
    const manager = startReleaseUpdateManager(BASE_URL)
    await manager.checkNow()

    window.dispatchEvent(new Event('pagehide'))
    manager.stop()

    expect(postMessage).toHaveBeenCalledWith({
      type: 'FRANK_ACTIVATE_WHEN_IDLE',
      buildId: BUILD_B,
    })
  })

  it('rejects a descriptor that points its worker outside the app scope', async () => {
    const serviceWorker = installServiceWorkerMock({ active: worker(BUILD_A) })
    mockReleaseFetch({ ...descriptor(), serviceWorkerUrl: 'https://attacker.test/sw.js?build=build-b' })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const manager = startReleaseUpdateManager(BASE_URL)

    await manager.checkNow()
    manager.stop()

    expect(serviceWorker.register).not.toHaveBeenCalled()
  })
})
