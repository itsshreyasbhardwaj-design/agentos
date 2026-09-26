'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { decideApproval } from '@/lib/actions';

/**
 * The human decision point.
 *
 * It shows exactly what will run — tool, arguments and the runtime's own
 * statement of impact — and lets the reviewer change the arguments before
 * approving. The edited values are what the runtime executes; the model's
 * original arguments are discarded.
 */
export function DecisionForm({
  approvalId,
  originalArguments,
}: {
  approvalId: string;
  originalArguments: unknown;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(() => JSON.stringify(originalArguments ?? {}, null, 2));
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const decide = (approve: boolean) => {
    startTransition(async () => {
      const response = await decideApproval(approvalId, approve, note, editing ? edited : null);
      setResult({ ok: response.ok, text: response.message });
      if (response.ok) router.refresh();
    });
  };

  return (
    <div className="border-t px-5 py-4" style={{ borderColor: 'var(--border)' }}>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`note-${approvalId}`} className="text-xs font-medium" style={{ color: 'var(--text-faint)' }}>
          Decision note (recorded in the audit log)
        </label>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="text-xs underline-offset-2 hover:underline"
          style={{ color: 'var(--accent)' }}
        >
          {editing ? 'Use the original arguments' : 'Edit arguments before approving'}
        </button>
      </div>

      <input
        id={`note-${approvalId}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Why are you approving or rejecting this?"
        className="mt-2 w-full rounded-md border px-3 py-1.5 text-sm outline-none"
        style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border)', color: 'var(--text)' }}
      />

      {editing ? (
        <div className="mt-3">
          <label htmlFor={`args-${approvalId}`} className="text-xs font-medium" style={{ color: 'var(--text-faint)' }}>
            Arguments the tool will actually receive (JSON)
          </label>
          <textarea
            id={`args-${approvalId}`}
            value={edited}
            onChange={(e) => setEdited(e.target.value)}
            rows={6}
            spellCheck={false}
            className="mt-1 w-full rounded-md border p-3 font-mono text-xs outline-none"
            style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border)', color: 'var(--text)' }}
          />
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => decide(true)}
          disabled={pending}
          className="rounded-md px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
          style={{ background: 'var(--ok)', color: 'var(--bg-raised)' }}
        >
          {pending ? 'Working…' : 'Approve'}
        </button>
        <button
          type="button"
          onClick={() => decide(false)}
          disabled={pending}
          className="rounded-md border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
        >
          Reject
        </button>
        {result ? (
          <p role="status" className="text-xs" style={{ color: result.ok ? 'var(--ok)' : 'var(--danger)' }}>
            {result.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
