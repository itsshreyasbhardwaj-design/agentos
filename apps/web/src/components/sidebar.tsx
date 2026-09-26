'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV } from './nav';

export function Sidebar({ pendingApprovals }: { pendingApprovals: number }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className="flex h-full flex-col gap-0.5 p-3">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors"
            style={{
              background: active ? 'var(--bg-hover)' : 'transparent',
              color: active ? 'var(--text)' : 'var(--text-muted)',
              fontWeight: active ? 500 : 400,
            }}
          >
            <span className="shrink-0" style={{ color: active ? 'var(--accent)' : 'var(--text-faint)' }}>
              <Icon />
            </span>
            <span className="truncate">{label}</span>
            {href === '/approvals' && pendingApprovals > 0 ? (
              <span
                className="tabular ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                style={{ background: 'var(--warn-bg)', color: 'var(--warn)' }}
                aria-label={`${pendingApprovals} pending`}
              >
                {pendingApprovals}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
