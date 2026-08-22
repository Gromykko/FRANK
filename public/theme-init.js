// Apply an explicit saved theme before CSS paints the app. This classic,
// same-origin head script stays tiny and blocking on purpose: running it after
// the React bundle would flash the OS theme whenever the saved choice differs.
try {
  const savedTheme = localStorage.getItem('frank_theme_mode');
  if (savedTheme === 'light' || savedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', savedTheme);
    document.documentElement.setAttribute('data-theme-source', 'saved');
  }
} catch {
  // Storage can be blocked; the CSS prefers-color-scheme fallback remains.
}
