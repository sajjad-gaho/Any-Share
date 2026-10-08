import {
  PERMISSION_LABELS,
  formatDeviceId,
  formatDuration,
  type SessionPermission,
} from '@remote-desktop/shared';
import { Button } from '@remote-desktop/ui';
import type { MonitorInfo, MonitorSelection } from '@remote-desktop/webrtc';
import { FolderOpen, FolderUp, PhoneOff, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { getDesktopApi } from '@/lib/desktop-api';
import type { TransferProgress } from '@/webrtc/file-transfer';
import { HostSession, type HostPhase } from '@/webrtc/host-session';
import { describeEnd } from '@/webrtc/controller-session';

/** Grouped toggles the remote user can switch off (or back on) at any time. */
const TOGGLES: { label: string; permissions: SessionPermission[] }[] = [
  { label: 'Mouse and keyboard', permissions: ['remote_control', 'mouse', 'keyboard'] },
  { label: 'Clipboard', permissions: ['clipboard'] },
  { label: 'File transfer', permissions: ['file_transfer'] },
];

const PHASE_TEXT: Record<HostPhase, string> = {
  waiting: 'Waiting for the connection…',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Connection interrupted, reconnecting…',
  ended: 'Session ended',
};

/**
 * The "REMOTE SESSION ACTIVE" indicator on the remote computer. Always on top,
 * cannot be minimised, and ending the session is always one click away.
 */
export function HostSessionPage() {
  const { sessionId = '' } = useParams();
  const sessionRef = useRef<HostSession | null>(null);
  const [phase, setPhase] = useState<HostPhase>('waiting');
  const [endReason, setEndReason] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<SessionPermission[]>([]);
  const [peer, setPeer] = useState<{ name: string; device: string | null } | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [activity, setActivity] = useState<string[]>([]);
  const [transfers, setTransfers] = useState<TransferProgress[]>([]);
  const [monitor, setMonitor] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const api = getDesktopApi();
    if (!api || !/^[0-9a-f-]{36}$/.test(sessionId)) return;
    const session = new HostSession(api, sessionId, {
      onPhase: (next, detail) => {
        setPhase(next);
        if (next === 'connected') setStartedAt((at) => at ?? Date.now());
        if (next === 'ended') setEndReason(detail ?? null);
      },
      onPermissions: setPermissions,
      onActivity: (text) => setActivity((list) => [...list.slice(-4), text]),
      onTransfer: (progress) =>
        setTransfers((list) => [...list.filter((t) => t.id !== progress.id), progress].slice(-3)),
      onStats: () => undefined,
      onMonitor: (current: MonitorSelection, monitors: MonitorInfo[]) =>
        setMonitor(
          current === 'all' ? 'All monitors' : (monitors.find((m) => m.id === current)?.name ?? ''),
        ),
    });
    sessionRef.current = session;
    void session.start().then(() => {
      if (session.peer) {
        setPeer({
          name: session.peer.displayName ?? 'Unknown user',
          device: session.peer.deviceCode,
        });
      }
    });
    return () => session.close();
  }, [sessionId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const toggle = async (group: SessionPermission[], enabled: boolean) => {
    const next = enabled
      ? [...new Set([...permissions, ...group])]
      : permissions.filter((p) => !group.includes(p));
    setError(await (sessionRef.current?.setPermissions(next) ?? Promise.resolve(null)));
  };

  const ended = phase === 'ended';

  return (
    <div
      className="flex h-full flex-col bg-red-950 text-red-50"
      role="region"
      aria-label="Remote session indicator"
    >
      <header className="flex items-center gap-2 bg-red-700 px-4 py-2.5">
        <span
          className={`size-2.5 rounded-full bg-white ${ended ? '' : 'animate-pulse'}`}
          aria-hidden="true"
        />
        <h1 className="text-sm font-bold tracking-wide">
          {ended ? 'REMOTE SESSION ENDED' : 'REMOTE SESSION ACTIVE'}
        </h1>
        <span
          className="ml-auto font-mono text-sm tabular-nums"
          role="timer"
          aria-label="Session duration"
        >
          {startedAt ? formatDuration(now - startedAt) : '--:--'}
        </span>
      </header>

      <div className="flex-1 space-y-3 overflow-auto px-4 py-3 text-sm">
        <div>
          <p className="text-red-200/80">Connected user</p>
          <p className="font-semibold">
            {peer?.name ?? '…'}
            {peer?.device ? (
              <span className="font-mono font-normal text-red-200/80">
                {' '}
                · {formatDeviceId(peer.device)}
              </span>
            ) : null}
          </p>
          <p className="text-xs text-red-200/80" role="status">
            {ended ? describeEnd(endReason ?? 'ended') : PHASE_TEXT[phase]}
            {monitor && !ended ? ` · sharing ${monitor}` : ''}
          </p>
        </div>

        {!ended ? (
          <fieldset>
            <legend className="mb-1 text-red-200/80">They can</legend>
            <p className="text-xs">✓ {PERMISSION_LABELS.screen_view}</p>
            {TOGGLES.map((toggleDef) => {
              const enabled = toggleDef.permissions.every((p) => permissions.includes(p));
              return (
                <label key={toggleDef.label} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => void toggle(toggleDef.permissions, e.target.checked)}
                  />
                  {toggleDef.label}
                </label>
              );
            })}
            {error ? (
              <p role="alert" className="mt-1 text-xs text-yellow-200">
                {error}
              </p>
            ) : null}
          </fieldset>
        ) : null}

        {transfers.length > 0 ? (
          <ul aria-label="File transfers" className="space-y-1 text-xs">
            {transfers.map((t) => (
              <li key={t.id}>
                {t.direction === 'send' ? '↑' : '↓'} {t.name} — {t.status}
                {t.size > 0 ? ` (${Math.round((t.transferred / t.size) * 100)}%)` : ''}
              </li>
            ))}
          </ul>
        ) : null}

        {activity.length > 0 ? (
          <ul aria-label="Session activity" className="space-y-1 text-xs text-red-200/90">
            {activity.map((text, i) => (
              <li key={i} className="flex gap-1">
                <ShieldAlert className="size-3.5 shrink-0" aria-hidden="true" />
                {text}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <footer className="flex items-center gap-2 border-t border-red-800 px-4 py-3">
        {!ended && permissions.includes('file_transfer') ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()}>
              <FolderUp aria-hidden="true" />
              Send file
            </Button>
            <input
              ref={fileInput}
              type="file"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void sessionRef.current?.sendFile(file);
                event.target.value = '';
              }}
            />
          </>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="text-red-50"
          onClick={() => void getDesktopApi()?.files.openFolder()}
        >
          <FolderOpen aria-hidden="true" />
          Received files
        </Button>
        {!ended ? (
          <Button
            size="sm"
            variant="destructive"
            className="ml-auto bg-white text-red-800 hover:bg-red-100"
            onClick={() => void sessionRef.current?.end()}
          >
            <PhoneOff aria-hidden="true" />
            End session
          </Button>
        ) : null}
      </footer>
    </div>
  );
}
