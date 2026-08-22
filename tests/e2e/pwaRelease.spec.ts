import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, relative, resolve, sep } from 'node:path'
import { expect, test } from 'playwright/test'
import { buildForecastFixture } from './forecastFixture'

interface BuiltRelease {
  buildId: string
  assets: string[]
  staticShellPaths: string[]
}

interface ReleaseDescriptor {
  buildId: string
  staticShellUrls: string[]
}

interface PrecacheManifest {
  buildId: string
  assets: string[]
}

interface SwitchableServer {
  origin: string
  useBuild: (directory: string) => void
  close: () => Promise<void>
}

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

async function buildSnapshot(directory: string): Promise<BuiltRelease> {
  const viteCli = resolve(process.cwd(), 'node_modules/vite/bin/vite.js')
  execFileSync(process.execPath, [viteCli, 'build', '--outDir', directory, '--emptyOutDir'], {
    cwd: process.cwd(),
    stdio: 'ignore',
  })
  const release = JSON.parse(
    await readFile(join(directory, 'frank-release.json'), 'utf8'),
  ) as ReleaseDescriptor
  const manifest = JSON.parse(
    await readFile(join(directory, 'frank-precache.json'), 'utf8'),
  ) as PrecacheManifest
  const staticShellPaths = release.staticShellUrls.map((url) => (
    new URL(url, 'https://frank.invalid').pathname.replace('/FRANK/', '')
  ))
  return { buildId: release.buildId, assets: manifest.assets, staticShellPaths }
}

async function startSwitchableServer(initialDirectory: string): Promise<SwitchableServer> {
  let activeDirectory = resolve(initialDirectory)
  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/probe.html') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end('<!doctype html><title>FRANK release probe</title>')
        return
      }
      if (!url.pathname.startsWith('/FRANK/')) {
        response.writeHead(404).end()
        return
      }

      const requested = decodeURIComponent(url.pathname.slice('/FRANK/'.length)) || 'index.html'
      const filePath = resolve(activeDirectory, requested)
      const relativePath = relative(activeDirectory, filePath)
      if (relativePath.startsWith(`..${sep}`) || relativePath === '..') {
        response.writeHead(404).end()
        return
      }
      if (!(await stat(filePath)).isFile()) {
        response.writeHead(404).end()
        return
      }

      response.writeHead(200, {
        'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
        // Deliberately emulate a static host whose freshness headers cannot be
        // tuned. FRANK's descriptor query + no-store request must defeat this.
        'cache-control': 'public, max-age=600',
      })
      response.end(await readFile(filePath))
    } catch {
      response.writeHead(404).end()
    }
  })

  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListening)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port')

  return {
    origin: `http://127.0.0.1:${address.port}`,
    useBuild(directory) {
      activeDirectory = resolve(directory)
    },
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose())
    }),
  }
}

test('a complete B waits behind A, then opens as one coherent offline shell', async ({ context, page }, testInfo) => {
  test.skip(testInfo.project.name !== 'service-worker-chromium')
  test.slow()

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'frank-pwa-release-'))
  const buildAPath = join(temporaryRoot, 'a')
  const buildBPath = join(temporaryRoot, 'b')
  let server: SwitchableServer | undefined

  try {
    const buildA = await buildSnapshot(buildAPath)
    const buildB = await buildSnapshot(buildBPath)
    expect(buildB.buildId).not.toBe(buildA.buildId)
    server = await startSwitchableServer(buildAPath)

    const forecast = buildForecastFixture('horsens')
    await context.addInitScript((payload) => {
      const browserFetch = window.fetch.bind(window)
      window.fetch = (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input : input.url,
          window.location.href,
        )
        if (url.pathname.includes('/forecast/')) {
          return Promise.resolve(new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
          }))
        }
        return browserFetch(input, init)
      }
    }, forecast)

    const appUrl = `${server.origin}/FRANK/`
    await page.goto(appUrl)
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    await page.reload()
    await expect(page.locator('meta[name="frank-build-id"]')).toHaveAttribute('content', buildA.buildId)

    const secondTab = await context.newPage()
    await secondTab.goto(appUrl)
    await expect(secondTab.locator('meta[name="frank-build-id"]')).toHaveAttribute('content', buildA.buildId)

    server.useBuild(buildBPath)
    await page.bringToFront()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(() => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/FRANK/')
      return registration?.waiting?.scriptURL ?? ''
    }), { timeout: 15_000 }).toContain(encodeURIComponent(buildB.buildId))

    // B is complete but both open documents stay on A.
    await expect(page.locator('meta[name="frank-build-id"]')).toHaveAttribute('content', buildA.buildId)
    await expect(secondTab.locator('meta[name="frank-build-id"]')).toHaveAttribute('content', buildA.buildId)
    await page.close()
    await expect.poll(() => secondTab.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/FRANK/')
      return {
        active: registration?.active?.scriptURL ?? '',
        waiting: registration?.waiting?.scriptURL ?? '',
      }
    })).toMatchObject({
      active: expect.stringContaining(encodeURIComponent(buildA.buildId)),
      waiting: expect.stringContaining(encodeURIComponent(buildB.buildId)),
    })

    await secondTab.close()
    const probe = await context.newPage()
    await probe.goto(`${server.origin}/probe.html`)
    await expect.poll(() => probe.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/FRANK/')
      return registration?.active?.scriptURL ?? ''
    }), { timeout: 10_000 }).toContain(encodeURIComponent(buildB.buildId))

    const aOnlyAsset = buildA.assets.find((asset) => !buildB.assets.includes(asset))
    expect(aOnlyAsset).toBeTruthy()
    await context.setOffline(true)
    try {
      const offlineB = await context.newPage()
      await offlineB.goto(appUrl)
      await expect(offlineB.locator('meta[name="frank-build-id"]')).toHaveAttribute('content', buildB.buildId)

      const documentAssets = await offlineB.locator('script[src], link[href*="/assets/"]').evaluateAll((nodes) => (
        nodes.map((node) => new URL(
          node instanceof HTMLScriptElement ? node.src : (node as HTMLLinkElement).href,
        ).pathname.replace('/FRANK/', ''))
      ))
      expect(documentAssets.length).toBeGreaterThan(0)
      const buildBResources = new Set([...buildB.assets, ...buildB.staticShellPaths])
      expect(documentAssets.every((asset) => buildBResources.has(asset))).toBe(true)

      const retainedA = await offlineB.evaluate(async (asset) => (await fetch(asset)).text(), aOnlyAsset!)
      expect(retainedA.length).toBeGreaterThan(0)
    } finally {
      await context.setOffline(false)
    }
  } finally {
    if (server) await server.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
