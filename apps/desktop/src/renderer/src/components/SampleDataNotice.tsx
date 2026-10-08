import { Info } from 'lucide-react';
import { Link } from 'react-router';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';

/** Shown on every page that renders preview data, so sample content is never mistaken for real data. */
export function SampleDataNotice() {
  const showSampleData = useSettingsStore((state) => state.showSampleData);
  const signedIn = useAuthStore((state) => state.status === 'signed-in');
  // Signed in, pages show real data from the server instead.
  if (!showSampleData || signedIn) return null;
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
    >
      <Info
        className="mt-0.5 size-4 shrink-0 text-warning-foreground dark:text-warning"
        aria-hidden="true"
      />
      <p>
        <span className="font-medium">Showing sample data.</span>{' '}
        <span className="text-muted-foreground">
          You are not signed in, so devices and sessions are examples only.{' '}
          <Link to="/account" className="font-medium text-foreground underline underline-offset-4">
            Sign in
          </Link>{' '}
          or{' '}
          <Link
            to="/settings/general"
            className="font-medium text-foreground underline underline-offset-4"
          >
            turn off sample data
          </Link>
        </span>
      </p>
    </div>
  );
}
