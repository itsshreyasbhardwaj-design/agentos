'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IconSearch } from './icons';
import { Kbd } from './ui';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  href: string;
  group: string;
}

/**
 * Command palette (⌘K / Ctrl+K).
 *
 * Hand-rolled rather than pulled from a component kit so the focus trap, roving
 * selection and `aria-activedescendant` wiring are explicit and auditable — a
 * palette that traps focus badly is worse than no palette for keyboard users.
 */
export function CommandPalette({ commands }: { commands: Command[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(needle) || c.group.toLowerCase().includes(needle) || c.href.includes(needle),
    );
  }, [commands, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActive(0);
    previouslyFocused.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        previouslyFocused.current = document.activeElement as HTMLElement;
        setOpen((v) => !v);
      }
      if (event.key === 'Escape' && open) close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  const go = (href: string) => {
    close();
    router.push(href);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = results[active];
      if (target) go(target.href);
    } else if (event.key === 'Tab') {
      // Trap focus: the palette has exactly one focusable control.
      event.preventDefault();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]"
      style={{ background: 'rgb(0 0 0 / 0.45)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-xl overflow-hidden rounded-xl border"
        style={{ background: 'var(--bg-raised)', borderColor: 'var(--border-strong)', boxShadow: '0 16px 48px rgb(0 0 0 / 0.35)' }}
      >
        <div className="flex items-center gap-3 border-b px-4" style={{ borderColor: 'var(--border)' }}>
          <IconSearch style={{ color: 'var(--text-faint)' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to…"
            aria-label="Search commands"
            aria-controls="command-results"
            aria-activedescendant={results[active] ? `command-${results[active].id}` : undefined}
            className="h-12 flex-1 bg-transparent text-sm outline-none"
            style={{ color: 'var(--text)' }}
          />
          <Kbd>esc</Kbd>
        </div>

        <ul id="command-results" ref={listRef} role="listbox" aria-label="Commands" className="max-h-80 overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
              Nothing matches “{query}”.
            </li>
          ) : (
            results.map((command, index) => (
              <li key={command.id} id={`command-${command.id}`} role="option" aria-selected={index === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => go(command.href)}
                  className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm"
                  style={{ background: index === active ? 'var(--bg-hover)' : 'transparent' }}
                >
                  <span className="truncate">{command.label}</span>
                  <span className="shrink-0 text-xs" style={{ color: 'var(--text-faint)' }}>
                    {command.group}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
