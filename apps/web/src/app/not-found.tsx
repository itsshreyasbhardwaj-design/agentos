import Link from 'next/link';
import { Card, EmptyState } from '@/components/ui';

export default function NotFound() {
  return (
    <Card>
      <EmptyState
        title="Not found"
        body="That resource does not exist, or it belongs to another organisation."
        action={
          <Link href="/" className="mt-2 text-sm" style={{ color: 'var(--accent)' }}>
            Back to overview
          </Link>
        }
      />
    </Card>
  );
}
