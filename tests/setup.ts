import { beforeEach } from 'vitest';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// CURRENT_LOCATION is resolved at MODULE LOAD from localStorage
// (config/locations.ts), and almost every safety test imports it for its wind
// sectors. A stray `frank_location` key would silently point the whole suite
// at a different fjord's geometry, and the settings tests write real
// `ffkajak_*` profiles. Start every test from an empty store.
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // Some environments run without a DOM; nothing to clear there.
  }
});
