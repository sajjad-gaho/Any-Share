import { Button, EmptyState, Skeleton } from '@remote-desktop/ui';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AsyncStatus } from '@/stores/collection-store';

interface CollectionStateProps {
  status: AsyncStatus;
  error: string | null;
  itemCount: number;
  onRetry: () => void;
  /** Shown when loading succeeded with zero items. */
  empty: ReactNode;
  /** Loading placeholder. Defaults to skeleton rows. */
  loading?: ReactNode;
  children: ReactNode;
}

/**
 * Renders the loading / error / empty / content states of a collection
 * consistently across pages. Content stays visible while a reload is in flight.
 */
export function CollectionState({
  status,
  error,
  itemCount,
  onRetry,
  empty,
  loading,
  children,
}: CollectionStateProps) {
  if (status === 'error') {
    return (
      <EmptyState
        role="alert"
        icon={<TriangleAlert />}
        title="Couldn't load this list"
        description={error ?? 'Something went wrong.'}
        action={
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            Try again
          </Button>
        }
      />
    );
  }

  if ((status === 'idle' || status === 'loading') && itemCount === 0) {
    return (
      <div role="status" aria-live="polite" aria-busy="true">
        <span className="sr-only">Loading…</span>
        {loading ?? <SkeletonRows />}
      </div>
    );
  }

  if (itemCount === 0) return <>{empty}</>;
  return <>{children}</>;
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}
