// Pick the theme before CSS paints. Running this after the React bundle would
// flash the wrong one, so it stays a tiny blocking classic script.
//
// Order matters: an explicit saved choice wins, otherwise follow the OS. A
// first visit that ignores a phone set to dark is not a neutral default - it
// is an app that looks broken at night, and on an installed PWA it puts a
// light document under a dark system status bar.
(function () {
  var root = document.documentElement;
  var mode = 'light';
  try {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) mode = 'dark';
  } catch (error) {
    // No matchMedia: light is the documented fallback.
  }
  try {
    var saved = localStorage.getItem('frank_theme_mode');
    if (saved === 'light' || saved === 'dark') {
      mode = saved;
      root.setAttribute('data-theme-source', 'saved');
    }
  } catch (error) {
    // Storage can be blocked; the OS preference above still holds.
  }
  root.setAttribute('data-theme', mode);
})();
