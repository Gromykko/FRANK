import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './fonts.css'
import './index.css'
import App from './App.tsx'
import { LanguageProvider } from './i18n'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import PixelSky from './components/PixelSky.tsx'
import { startReleaseUpdateManager } from './pwa/releaseUpdate.ts'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <LanguageProvider>
        <PixelSky />
        <App />
      </LanguageProvider>
    </ErrorBoundary>
  </StrictMode>,
)

// Lives here rather than as an inline <script> in index.html: GitHub Pages
// can't send response headers, so a <meta> CSP is the only one available, and
// an inline script would force 'unsafe-inline' on script-src — which is most
// of what a CSP is for. Registration is not on the critical path anyway.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // The active app reads a cache-busted release descriptor rather than
    // accepting new HTML first. A complete candidate installs silently and
    // waits until the current app has closed before taking over.
    startReleaseUpdateManager()
  })
}
