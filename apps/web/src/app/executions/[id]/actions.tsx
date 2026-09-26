'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cancelExecution, pauseExecution, replayExecution, resumeExecution, retryExecution } from '@/lib/actions';

const TERMINAL = ['completed', 'failed', 'cancelled'];

function ActionButton({
  children,
  onClick,
  disabled,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45"
      style={{
        borderColor: 'var(--border-strong)',
        color: tone === 'danger' ? 'var(--danger)' : 'var(--text-muted)',
        background: 'var(--bg-raised)',
      }}
    >
      {children}
    </button>
  );
}

export function ExecutionActions({
  executionId,
  status,
  mode,
}: {
  executionId: string;
  status: string;
  mode: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const terminal = TERMINAL.includes(status);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => {
    startTransition(async () => {
      const result = await fn();
      setMessage({ ok: result.ok, text: result.message });
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap gap-1.5">
        <ActionButton onClick={() => run(() => pauseExecution(executionId))} disabled={pending || terminal || status === 'paused'}>
          Pause
        </ActionButton>
        <ActionButton
          onClick={() => run(() => resumeExecution(executionId))}
          disabled={pending || !(status === 'paused' || status === 'awaiting_approval')}
        >
          Resume
        </ActionButton>
        <ActionButton onClick={() => run(() => retryExecution(executionId))} disabled={pending || !terminal}>
          Retry
        </ActionButton>
        <ActionButton
          onClick={() => run(() => replayExecution(executionId))}
          disabled={pending || mode === 'replay'}
          {...(mode === 'replay' ? {} : {})}
        >
          Replay
        </ActionButton>
        <ActionButton onClick={() => run(() => cancelExecution(executionId))} disabled={pending || terminal} tone="danger">
          Cancel
        </ActionButton>
      </div>
      {message ? (
        <p role="status" className="max-w-sm text-right text-xs" style={{ color: message.ok ? 'var(--ok)' : 'var(--danger)' }}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
