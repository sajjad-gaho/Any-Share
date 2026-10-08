import {
  formatDeviceId,
  formatDuration,
  getSessionDurationMs,
  type Session,
} from '@remote-desktop/shared';
import { formatDateTime } from '@/lib/format';
import { SessionStatusBadge } from './StatusBadges';

export function SessionsTable({ sessions, caption }: { sessions: Session[]; caption: string }) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b bg-muted/50 text-xs text-muted-foreground uppercase">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              Device
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              User
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Started
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Ended
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Duration
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {sessions.map((session) => (
            <tr key={session.id} className="hover:bg-muted/40">
              <td className="px-4 py-3">
                <p className="font-medium">{session.deviceName}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {formatDeviceId(session.deviceId)}
                </p>
              </td>
              <td className="px-4 py-3">{session.user.displayName}</td>
              <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(session.startedAt)}</td>
              <td className="px-4 py-3 whitespace-nowrap">
                {session.endedAt ? formatDateTime(session.endedAt) : '—'}
              </td>
              <td className="px-4 py-3 font-mono tabular-nums">
                {session.status === 'ended' ? formatDuration(getSessionDurationMs(session)) : '—'}
              </td>
              <td className="px-4 py-3">
                <SessionStatusBadge status={session.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
