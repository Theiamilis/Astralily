export type OverviewTheme = 'rose' | 'classic' | 'jarvis';

const STORAGE_KEY = 'lily_overview_theme';

export function readOverviewTheme(): OverviewTheme {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'classic' || saved === 'jarvis') return saved;
  } catch { /* Browser storage can be unavailable in private sessions. */ }
  return 'rose';
}

export function saveOverviewTheme(theme: OverviewTheme) {
  try { window.localStorage.setItem(STORAGE_KEY, theme); }
  catch { /* The current view still changes without persistence. */ }
}
