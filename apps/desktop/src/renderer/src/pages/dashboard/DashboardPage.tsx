import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from '@remote-desktop/ui';
import { Activity, ArrowRight, History, Monitor, MonitorCheck, Wifi } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { CollectionState } from '@/components/CollectionState';
import { DeviceCard } from '@/components/DeviceCard';
import { PageHeader } from '@/components/PageHeader';
import { QuickConnectForm } from '@/components/QuickConnectForm';
import { SampleDataNotice } from '@/components/SampleDataNotice';
import { SessionsTable } from '@/components/SessionsTable';
import { StatCard } from '@/components/StatCard';
import { ThisDeviceCard } from '@/components/ThisDeviceCard';
import { devicesStore, sessionsStore } from '@/stores/app-stores';
import { useCollection, useEnsureLoaded } from '@/stores/collection-store';
import { useSettingsStore } from '@/stores/settings-store';

const RECENT_WINDOW_MS = 7 * 24 * 3600 * 1000;
const DASHBOARD_DEVICE_LIMIT = 6;
const DASHBOARD_SESSION_LIMIT = 5;

export function DashboardPage() {
  useEnsureLoaded(devicesStore);
  useEnsureLoaded(sessionsStore);

  const displayName = useSettingsStore((state) => state.displayName);
  const devices = useCollection(devicesStore, (state) => state.items);
  const devicesStatus = useCollection(devicesStore, (state) => state.status);
  const devicesError = useCollection(devicesStore, (state) => state.error);
  const sessions = useCollection(sessionsStore, (state) => state.items);
  const sessionsStatus = useCollection(sessionsStore, (state) => state.status);
  const sessionsError = useCollection(sessionsStore, (state) => state.error);

  const stats = useMemo(() => {
    const now = Date.now();
    return {
      total: devices.length,
      online: devices.filter((device) => device.status === 'online').length,
      active: sessions.filter((session) => session.status === 'active').length,
      recent: sessions.filter((session) => now - Date.parse(session.startedAt) <= RECENT_WINDOW_MS)
        .length,
    };
  }, [devices, sessions]);

  const devicesLoading = devicesStatus === 'idle' || devicesStatus === 'loading';
  const sessionsLoading = sessionsStatus === 'idle' || sessionsStatus === 'loading';

  return (
    <>
      <PageHeader
        title={displayName ? `Welcome back, ${displayName}` : 'Dashboard'}
        description="Connect to a device or pick up where you left off."
      />

      <SampleDataNotice />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Quick connect</CardTitle>
            <CardDescription>
              Enter the 9-digit ID shown on the device you want to reach.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <QuickConnectForm />
          </CardContent>
        </Card>

        <ThisDeviceCard />
      </div>

      <section aria-label="Statistics" className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard
          label="Total devices"
          value={stats.total}
          icon={Monitor}
          loading={devicesLoading}
        />
        <StatCard label="Online" value={stats.online} icon={Wifi} loading={devicesLoading} />
        <StatCard
          label="Active sessions"
          value={stats.active}
          icon={Activity}
          loading={sessionsLoading}
        />
        <StatCard
          label="Recent connections"
          value={stats.recent}
          icon={History}
          hint="Last 7 days"
          loading={sessionsLoading}
        />
      </section>

      <section aria-labelledby="my-devices-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="my-devices-heading" className="text-lg font-semibold">
            My devices
          </h2>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/devices">
              View all
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <CollectionState
          status={devicesStatus}
          error={devicesError}
          itemCount={devices.length}
          onRetry={() => void devicesStore.getState().load()}
          loading={
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="h-32" />
              ))}
            </div>
          }
          empty={
            <EmptyState
              icon={<MonitorCheck />}
              title="No devices yet"
              description="Devices linked to your account will appear here once device registration is available."
            />
          }
        >
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {devices.slice(0, DASHBOARD_DEVICE_LIMIT).map((device) => (
              <DeviceCard key={device.id} device={device} />
            ))}
          </div>
        </CollectionState>
      </section>

      <section aria-labelledby="recent-sessions-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="recent-sessions-heading" className="text-lg font-semibold">
            Recent sessions
          </h2>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/sessions">
              View all
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <CollectionState
          status={sessionsStatus}
          error={sessionsError}
          itemCount={sessions.length}
          onRetry={() => void sessionsStore.getState().load()}
          loading={<Skeleton className="h-48" />}
          empty={
            <EmptyState
              icon={<History />}
              title="No sessions yet"
              description="Your remote sessions will be listed here."
            />
          }
        >
          <SessionsTable
            sessions={sessions.slice(0, DASHBOARD_SESSION_LIMIT)}
            caption="Most recent remote sessions"
          />
        </CollectionState>
      </section>
    </>
  );
}
