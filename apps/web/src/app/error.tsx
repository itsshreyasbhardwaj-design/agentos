'use client';

import { useEffect } from 'react';
import { Card, ErrorState } from '@/components/ui';

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="space-y-4">
      <ErrorState message={error.message} hint="This page failed to render. The detail above is what actually went wrong." />
      <Card className="px-5 py-4">
        <button type="button" onClick={reset} className="text-sm" style={{ color: 'var(--accent)' }}>
          Try again
        </button>
      </Card>
    </div>
  );
}
