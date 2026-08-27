// Light is FRANK's first-visit theme. Apply it before CSS paints, then replace
// it with an explicit saved choice when one exists. This classic, same-origin
// head script stays tiny and blocking on purpose: running it after the React
// bundle would flash the wrong theme.
document.documentElement.setAttribute('data-theme', 'light');
try {
  const savedTheme = localStorage.getItem('frank_theme_mode');
  if (savedTheme === 'light' || savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', savedTheme);
    document.documentElement.setAttribute('data-theme-source', 'saved');
  }
} catch {
  // Storage can be blocked; the explicit light default above still holds.
}
