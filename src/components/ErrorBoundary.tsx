import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

// A render throw anywhere below this boundary must never leave a paddler
// staring at a blank page, unable to tell whether the forecast was good or
// bad. Catch it, say plainly that the verdict is unavailable, and offer the
// two escapes that actually recover: reload, and clear the stored settings
// (a corrupt/incompatible saved profile is the one failure a reload alone
// can't fix). Deliberately a class — React has no hook equivalent.
interface Props {
  children: ReactNode;
  // Supplied when the boundary wraps one optional panel rather than the whole
  // app: that panel degrades on its own and the rest of the page stays up.
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
  // Reset wipes a profile the user may have spent time tuning, so the button
  // asks once before doing it. A two-click confirm, not window.confirm — a
  // modal dialog on a crash screen is one more thing that can go wrong.
  confirmingReset: boolean;
}

// Same key the i18n provider writes; read directly because the provider may
// itself be the thing that crashed.
function readLanguage(): 'da' | 'en' {
  try {
    return localStorage.getItem('ffkajak_lang') === 'en' ? 'en' : 'da';
  } catch {
    return 'da';
  }
}

const EN = {
  title: 'FRANK could not show the forecast',
  body: 'Something went wrong on this page, so there is no safety verdict to show. Do not treat this as an all-clear — check the conditions another way before going out.',
  reload: 'Reload',
  reset: 'Reset saved settings',
  resetConfirm: 'Tap again to erase your limits',
};

const DA = {
  title: 'FRANK kunne ikke vise prognosen',
  body: 'Noget gik galt på denne side, så der er ingen sikkerhedsvurdering at vise. Opfat det ikke som en godkendelse — tjek forholdene på anden vis, før du tager ud.',
  reload: 'Genindlæs',
  reset: 'Nulstil gemte indstillinger',
  resetConfirm: 'Tryk igen for at slette dine grænser',
};

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, confirmingReset: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('FRANK crashed while rendering:', error, info.componentStack);
  }

  // Wipe this app's own keys only, then reload. Never clears the whole origin.
  private resetAndReload = () => {
    if (!this.state.confirmingReset) {
      this.setState({ confirmingReset: true });
      return;
    }
    try {
      for (const key of Object.keys(localStorage)) {
        // Scoped to what the button actually promises ("erase your limits").
        // The broader `frank_` prefix also owned `frank_location` and
        // `frank_weather_data_v2`, so a Vejle paddler who tapped reset after a
        // crash silently landed back on Horsens — a different fjord with
        // different sector caps — AND lost the offline forecast, at the
        // shoreline, on a bad connection. Theme is cosmetic and safe to clear.
        // The language choice is spared too: it shares the ffkajak_ prefix
        // but is not a limit, and wiping it flipped English users to Danish.
        if ((key.startsWith('ffkajak_') && key !== 'ffkajak_lang') || key === 'frank_theme_mode') {
          localStorage.removeItem(key);
        }
      }
    } catch {
      // Storage blocked — the reload below is still worth attempting.
    }
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    // This boundary sits ABOVE LanguageProvider (a crash inside the provider
    // must still render something), so t() is not available. Danish is the
    // app's default language, so read the stored choice directly rather than
    // showing every Danish user an English crash screen.
    const copy = readLanguage() === 'en' ? EN : DA;

    return (
      <div className="loader-container error-screen" role="alert">
        <h2 className="error-screen-title">{copy.title}</h2>
        <p className="error-screen-text">{copy.body}</p>
        <div className="error-screen-actions">
          <button type="button" className="btn-control" onClick={() => window.location.reload()}>
            {copy.reload}
          </button>
          <button type="button" className="btn-control" onClick={this.resetAndReload}>
            {this.state.confirmingReset ? copy.resetConfirm : copy.reset}
          </button>
        </div>
      </div>
    );
  }
}
