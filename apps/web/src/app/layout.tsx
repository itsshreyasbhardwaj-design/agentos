import type { Metadata } from 'next';
import Link from 'next/link';
import { CommandPalette, type Command } from '@/components/command-palette';
import { NAV } from '@/components/nav';
import { Sidebar } from '@/components/sidebar';
import { ThemeToggle } from '@/components/theme-toggle';
import { Kbd } from '@/components/ui';
import { api, load } from '@/lib/api';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentOS',
  description: 'Runtime and control plane for AI agents',
};

export const dynamic = 'force-dynamic';

/** Applied before first paint so the theme never flashes. */
const THEME_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('agentos-theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var dark = stored ? stored === 'dark' : prefersDark;
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {
    document.documentElement.classList.add('dark');
  }
})();
`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const approvals = await load(() => api().approvals.listPending({ limit: 50 }));
  const agents = await load(() => api().agents.list({ limit: 50 }));

  const commands: Command[] = [
    ...NAV.map((item) => ({ id: `nav-${item.href}`, label: item.label, href: item.href, group: 'Navigate' })),
    ...(agents.data?.items ?? []).map((agent) => ({
      id: `agent-${agent.id}`,
      label: agent.name,
      href: `/agents/${agent.slug}`,
      group: 'Agent',
    })),
  ];

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:px-3 focus:py-2"
          style={{ background: 'var(--bg-raised)', border: '1px solid var(--border-strong)' }}
        >
          Skip to content
        </a>

        <div className="flex min-h-screen">
          <aside
            className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r lg:flex"
            style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border)' }}
          >
            <div className="flex h-14 items-center gap-2 border-b px-4" style={{ borderColor: 'var(--border)' }}>
              <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
                <span
                  aria-hidden
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md font-mono text-[11px] font-bold"
                  style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
                >
                  A
                </span>
                AgentOS
              </Link>
            </div>
            <div className="flex-1 overflow-y-auto">
              <Sidebar pendingApprovals={approvals.data?.items.length ?? 0} />
            </div>
            <div className="border-t px-4 py-3 text-[11px]" style={{ borderColor: 'var(--border)', color: 'var(--text-faint)' }}>
              <div className="flex items-center gap-1.5">
                <Kbd>⌘</Kbd>
                <Kbd>K</Kbd>
                <span>to jump</span>
              </div>
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <header
              className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b px-4 backdrop-blur lg:px-8"
              style={{ background: 'color-mix(in srgb, var(--bg) 85%, transparent)', borderColor: 'var(--border)' }}
            >
              <nav aria-label="Sections" className="flex gap-1 overflow-x-auto lg:hidden">
                {NAV.slice(0, 5).map((item) => (
                  <Link key={item.href} href={item.href} className="rounded-md px-2 py-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {item.label}
                  </Link>
                ))}
              </nav>
              <div className="hidden lg:block" />
              <div className="flex items-center gap-2">
                <span className="hidden text-xs sm:inline" style={{ color: 'var(--text-faint)' }}>
                  {process.env.AGENTOS_URL ?? 'http://127.0.0.1:8787'}
                </span>
                <ThemeToggle />
              </div>
            </header>

            <main id="main" className="flex-1 px-4 py-6 lg:px-8 lg:py-8">
              <div className="mx-auto max-w-[1200px]">{children}</div>
            </main>
          </div>
        </div>

        <CommandPalette commands={commands} />
      </body>
    </html>
  );
}
