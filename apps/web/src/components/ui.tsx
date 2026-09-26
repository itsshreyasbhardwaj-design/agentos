import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={clsx('rounded-lg border', className)}
      style={{ background: 'var(--bg-raised)', borderColor: 'var(--border)', boxShadow: 'var(--shadow)' }}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {subtitle ? (
          <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
            {subtitle}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';

const TONE_STYLE: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: 'var(--bg-sunken)', fg: 'var(--text-muted)' },
  ok: { bg: 'var(--ok-bg)', fg: 'var(--ok)' },
  warn: { bg: 'var(--warn-bg)', fg: 'var(--warn)' },
  danger: { bg: 'var(--danger-bg)', fg: 'var(--danger)' },
  info: { bg: 'var(--info-bg)', fg: 'var(--info)' },
  accent: { bg: 'color-mix(in srgb, var(--accent) 14%, transparent)', fg: 'var(--accent)' },
};

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: Tone; title?: string }) {
  const style = TONE_STYLE[tone];
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{ background: style.bg, color: style.fg }}
    >
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  completed: 'ok',
  running: 'info',
  queued: 'neutral',
  awaiting_approval: 'warn',
  paused: 'warn',
  failed: 'danger',
  cancelled: 'neutral',
  blocked: 'neutral',
  created: 'neutral',
  pending: 'warn',
  approved: 'ok',
  rejected: 'danger',
  expired: 'neutral',
  ok: 'ok',
  error: 'danger',
  denied: 'danger',
  waiting: 'warn',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{status.replace(/_/g, ' ')}</Badge>;
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <Card className="px-5 py-4">
      <div className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
        {label}
      </div>
      <div
        className="tabular mt-2 text-2xl font-semibold tracking-tight"
        style={{ color: tone === 'neutral' ? 'var(--text)' : TONE_STYLE[tone].fg }}
      >
        {value}
      </div>
      {hint ? (
        <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </div>
      ) : null}
    </Card>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-sm" style={{ color: 'var(--text-muted)' }}>
        {body}
      </p>
      {action}
    </div>
  );
}

/**
 * Shown when the control plane could not be reached. It states the failure
 * plainly rather than rendering an empty dashboard that looks like "no activity".
 */
export function ErrorState({ message, hint }: { message: string; hint?: string }) {
  return (
    <Card className="px-5 py-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: 'var(--danger)' }}
        />
        <div className="min-w-0">
          <p className="text-sm font-medium" style={{ color: 'var(--danger)' }}>
            Could not load live data
          </p>
          <p className="mt-1 text-sm break-words" style={{ color: 'var(--text-muted)' }}>
            {message}
          </p>
          {hint ? (
            <p className="mt-2 text-xs" style={{ color: 'var(--text-faint)' }}>
              {hint}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

export function Table({ children, caption }: { children: ReactNode; caption?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </div>
  );
}

interface CellProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

export function Th({ children, className, style }: CellProps) {
  return (
    <th
      scope="col"
      className={clsx('px-5 py-2.5 text-left text-xs font-medium uppercase tracking-wide', className)}
      style={{ color: 'var(--text-faint)', ...style }}
    >
      {children}
    </th>
  );
}

export function Td({ children, className, style, title }: CellProps) {
  return (
    <td
      className={clsx('border-t px-5 py-3 align-middle', className)}
      style={{ borderColor: 'var(--border)', ...style }}
      title={title}
    >
      {children}
    </td>
  );
}

export function Mono({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <code className={clsx('font-mono text-xs', className)} style={{ color: 'var(--text-muted)', ...style }}>
      {children}
    </code>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      className="rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium"
      style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}
    >
      {children}
    </kbd>
  );
}

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/** Horizontal proportion bar. Values are absolute; the widths are derived. */
export function BarList({ items }: { items: Array<{ label: string; value: number; display: string }> }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2 px-5 py-4">
      {items.map((item) => (
        <li key={item.label}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-mono text-xs">{item.label}</span>
            <span className="tabular text-xs" style={{ color: 'var(--text-muted)' }}>
              {item.display}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--bg-sunken)' }}>
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(2, (item.value / max) * 100)}%`, background: 'var(--accent)' }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
