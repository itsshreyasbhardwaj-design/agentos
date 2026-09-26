'use client';

import { useEffect, useState } from 'react';
import { IconMoon, IconSun } from './icons';

type Theme = 'light' | 'dark';

/**
 * Theme toggle. The initial class is applied by a blocking inline script in the
 * document head, so there is no flash of the wrong theme before hydration; this
 * component only reflects and changes it.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', next === 'dark');
    try {
      localStorage.setItem('agentos-theme', next);
    } catch {
      // Private browsing can refuse storage; the toggle still works for this visit.
    }
    setTheme(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors"
      style={{ color: 'var(--text-muted)' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {theme === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  );
}
