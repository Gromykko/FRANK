import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './fonts.css'
import './index.css'
import App from './App.tsx'
import { LanguageProvider } from './i18n'
import ErrorBoundary from './components/ErrorBoundary.tsx'
import PixelSky from './components/PixelSky.tsx'

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
    const baseUrl = import.meta.env.BASE_URL;
    const workerUrl = new URL(`${baseUrl}sw.js`, window.location.origin);
    // Changing the script URL forces an update check for every production
    // build. The worker verifies this id against frank-precache.json before it
    // activates, so a partial deployment cannot replace the last good shell.
    workerUrl.searchParams.set('build', import.meta.env.VITE_APP_BUILD_ID);
    navigator.serviceWorker
      .register(workerUrl.toString(), { scope: baseUrl, updateViaCache: 'none' })
      .catch((err) => console.error('Service Worker registration failed:', err));
  });
}
