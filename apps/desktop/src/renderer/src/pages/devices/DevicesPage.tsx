import {
  OS_FAMILIES,
  formatDeviceId,
  formatRelativeTime,
  searchQuerySchema,
  type DeviceStatus,
  type OsFamily,
} from '@remote-desktop/shared';
import { Button, EmptyState, Input, Label, NativeSelect } from '@remote-desktop/ui';
import { MonitorCheck, RefreshCw, Search, SearchX } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { CollectionState } from '@/components/CollectionState';
import { ConnectButton } from '@/components/ConnectButton';
import { OsIcon } from '@/components/OsIcon';
import { PageHeader } from '@/components/PageHeader';
import { SampleDataNotice } from '@/components/SampleDataNotice';
import { DeviceStatusBadge } from '@/components/StatusBadges';
import {
  DEFAULT_DEVICE_FILTERS,
  filterDevices,
  hasActiveFilters,
  type DeviceFilters,
} from '@/lib/filter-devices';
import { OS_LABELS } from '@/lib/format';
import { devicesStore } from '@/stores/app-stores';
import { useCollection, useEnsureLoaded } from '@/stores/collection-store';

const STATUS_OPTIONS = ['all', 'online', 'offline'] as const;

export function DevicesPage() {
  useEnsureLoaded(devicesStore);
  const devices = useCollection(devicesStore, (state) => state.items);
  const status = useCollection(devicesStore, (state) => state.status);
  const error = useCollection(devicesStore, (state) => state.error);
  const [filters, setFilters] = useState<DeviceFilters>(DEFAULT_DEVICE_FILTERS);
  const searchId = useId();
  const statusId = useId();
  const osId = useId();

  const visible = useMemo(() => filterDevices(devices, filters), [devices, filters]);
  const reload = () => void devicesStore.getState().load();

  return (
    <>
      <PageHeader
        title="Devices"
        description="Computers and phones you can connect to."
        actions={
          <Button variant="outline" size="sm" onClick={reload} disabled={status === 'loading'}>
            <RefreshCw
              aria-hidden="true"
              className={status === 'loading' ? 'animate-spin' : undefined}
            />
            Refresh
          </Button>
        }
      />

      <SampleDataNotice />

      <div role="search" className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label htmlFor={searchId}>Search</Label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id={searchId}
              type="search"
              placeholder="Name, ID, OS or tag"
              className="pl-9"
              value={filters.query}
              maxLength={100}
              onChange={(event) => {
                const parsed = searchQuerySchema.safeParse(event.target.value);
                if (parsed.success)
                  setFilters((current) => ({ ...current, query: event.target.value }));
              }}
            />
          </div>
        </div>
        <div className="w-36 space-y-1.5">
          <Label htmlFor={statusId}>Status</Label>
          <NativeSelect
            id={statusId}
            value={filters.status}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                status: event.target.value as 'all' | DeviceStatus,
              }))
            }
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === 'all' ? 'All statuses' : option === 'online' ? 'Online' : 'Offline'}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="w-40 space-y-1.5">
          <Label htmlFor={osId}>Operating system</Label>
          <NativeSelect
            id={osId}
            value={filters.os}
            onChange={(event) =>
              setFilters((current) => ({ ...current, os: event.target.value as 'all' | OsFamily }))
            }
          >
            <option value="all">All systems</option>
            {OS_FAMILIES.map((family) => (
              <option key={family} value={family}>
                {OS_LABELS[family]}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      <CollectionState
        status={status}
        error={error}
        itemCount={devices.length}
        onRetry={reload}
        empty={
          <EmptyState
            icon={<MonitorCheck />}
            title="No devices yet"
            description="Devices linked to your account will appear here once device registration is available. You can still connect to any device by ID from the dashboard."
          />
        }
      >
        {visible.length === 0 ? (
          <EmptyState
            icon={<SearchX />}
            title="No matching devices"
            description="Try a different search or clear the filters."
            action={
              hasActiveFilters(filters) ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setFilters(DEFAULT_DEVICE_FILTERS)}
                >
                  Clear filters
                </Button>
              ) : null
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Devices ({visible.length} of {devices.length})
              </caption>
              <thead className="border-b bg-muted/50 text-xs text-muted-foreground uppercase">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Device
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Device ID
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Operating system
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Last seen
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {visible.map((device) => (
                  <tr key={device.id} className="hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <OsIcon family={device.os.family} className="size-8" />
                        <span className="font-medium">{device.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono whitespace-nowrap">
                      {formatDeviceId(device.id)}
                    </td>
                    <td className="px-4 py-3">
                      <DeviceStatusBadge status={device.status} />
                    </td>
                    <td className="px-4 py-3">
                      <p>{OS_LABELS[device.os.family]}</p>
                      <p className="text-xs text-muted-foreground">{device.os.version}</p>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {device.status === 'online' ? 'Now' : formatRelativeTime(device.lastSeenAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ConnectButton
                        deviceId={device.id}
                        deviceName={device.name}
                        status={device.status}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Showing {visible.length} of {devices.length} devices
        </p>
      </CollectionState>
    </>
  );
}
