import {
  PERMISSION_LABELS,
  deviceIdSchema,
  formatDeviceId,
  formatDuration,
  type DeviceId,
  type SessionPermission,
} from '@remote-desktop/shared';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Label,
  Separator,
  Tooltip,
} from '@remote-desktop/ui';
import type {
  ConnectionStatus,
  MonitorInfo,
  MonitorSelection,
  QualityPreset,
  SpecialCombo,
} from '@remote-desktop/webrtc';
import {
  ArrowLeft,
  ClipboardCopy,
  ClipboardPaste,
  Command,
  FolderUp,
  Gauge,
  Keyboard,
  Maximize,
  Minimize,
  Monitor,
  MonitorOff,
  Mouse,
  PhoneOff,
  Plug,
  Scaling,
  TriangleAlert,
  Volume2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ConnectionStatusBadge } from '@/components/StatusBadges';
import { getDesktopApi } from '@/lib/desktop-api';
import { useAddressBookStore } from '@/stores/address-book-store';
import { devicesStore } from '@/stores/app-stores';
import { useAuthStore } from '@/stores/auth-store';
import { useCollection } from '@/stores/collection-store';
import { useSettingsStore } from '@/stores/settings-store';
import { ControllerSession, type ViewerPhase } from '@/webrtc/controller-session';
import type { TransferProgress } from '@/webrtc/file-transfer';
import { keyMessage, mouseButton, normalizePointer, wheelToRemote } from '@/webrtc/input-mapping';
import type { SessionStats } from '@/webrtc/stats';
import { ViewerToolbarButton } from './ViewerToolbarButton';

function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(() => document.fullscreenElement !== null);
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggle = () => {
    const action = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    action.catch((error: unknown) => console.error('Fullscreen request failed', error));
  };
  return { isFullscreen, toggle };
}

function SessionTimer({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return (
    <span
      role="timer"
      aria-label="Session duration"
      className="font-mono text-sm text-viewer-foreground/80 tabular-nums"
    >
      {startedAt ? formatDuration(now - startedAt) : '--:--'}
    </span>
  );
}

function useDeviceName(deviceId: DeviceId | null): string | null {
  const devices = useCollection(devicesStore, (state) => state.items);
  const contacts = useAddressBookStore((state) => state.contacts);
  if (!deviceId) return null;
  return (
    devices.find((device) => device.id === deviceId)?.name ??
    contacts.find((contact) => contact.deviceId === deviceId)?.alias ??
    null
  );
}

const PHASE_STATUS: Record<ViewerPhase, ConnectionStatus> = {
  requesting: 'connecting',
  'awaiting-approval': 'connecting',
  connecting: 'connecting',
  connected: 'connected',
  reconnecting: 'reconnecting',
  ended: 'disconnected',
  failed: 'failed',
};

const COMBOS: { combo: SpecialCombo; label: string }[] = [
  { combo: 'win', label: 'Windows key' },
  { combo: 'alt_tab', label: 'Alt + Tab' },
  { combo: 'ctrl_esc', label: 'Ctrl + Esc (Start menu)' },
  { combo: 'ctrl_shift_esc', label: 'Ctrl + Shift + Esc (Task Manager)' },
  { combo: 'print_screen', label: 'Print Screen' },
];

/** Permissions a controller can ask for. Screen view is always included. */
const REQUESTABLE: {
  key: 'control' | 'clipboard' | 'file_transfer';
  label: string;
  grants: SessionPermission[];
}[] = [
  {
    key: 'control',
    label: 'Mouse and keyboard control',
    grants: ['remote_control', 'mouse', 'keyboard'],
  },
  { key: 'clipboard', label: 'Clipboard transfer', grants: ['clipboard'] },
  { key: 'file_transfer', label: 'File transfer', grants: ['file_transfer'] },
];

function ConnectPanel({
  deviceId,
  onConnect,
  error,
  busy,
}: {
  deviceId: DeviceId;
  onConnect: (permissions: SessionPermission[], accessPassword: string) => void;
  error: string | null;
  busy: boolean;
}) {
  // Starts from Settings > Remote Access; changes here apply to this request only.
  const [selected, setSelected] = useState<Record<string, boolean>>(() => {
    const defaults = useSettingsStore.getState().connectDefaults;
    return {
      control: defaults.control,
      clipboard: defaults.clipboard,
      file_transfer: defaults.fileTransfer,
    };
  });
  const [password, setPassword] = useState('');
  const passwordId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const permissions: SessionPermission[] = ['screen_view'];
    for (const option of REQUESTABLE) if (selected[option.key]) permissions.push(...option.grants);
    onConnect(permissions, password);
  };
  return (
    <form
      onSubmit={submit}
      className="mx-auto w-full max-w-md space-y-5 rounded-lg border border-white/15 bg-black/30 p-6"
    >
      <div>
        <h2 className="text-lg font-semibold">Connect to {formatDeviceId(deviceId)}</h2>
        <p className="text-sm text-viewer-foreground/70">
          The remote user must approve, unless this is your own device or you were given unattended
          access. They will see that a session is active and can end it at any time.
        </p>
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">Request permission for</legend>
        <label className="flex items-center gap-2 text-sm text-viewer-foreground/70">
          <input type="checkbox" checked disabled /> View screen (always)
        </label>
        {REQUESTABLE.map((option) => (
          <label key={option.key} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected[option.key] ?? false}
              onChange={(event) =>
                setSelected((s) => ({ ...s, [option.key]: event.target.checked }))
              }
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <div className="space-y-1.5">
        <Label htmlFor={passwordId}>Device access password (only if the device has one)</Label>
        <Input
          id={passwordId}
          type="password"
          autoComplete="off"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="bg-black/30"
        />
      </div>
      <p role="alert" className="min-h-5 text-sm text-red-300">
        {error ?? ''}
      </p>
      <Button type="submit" disabled={busy} className="w-full">
        <Plug aria-hidden="true" />
        {busy ? 'Requesting…' : 'Request connection'}
      </Button>
    </form>
  );
}

function TransferList({
  transfers,
  onCancel,
}: {
  transfers: TransferProgress[];
  onCancel: (id: string) => void;
}) {
  if (transfers.length === 0) return null;
  return (
    <ul aria-label="File transfers" className="absolute right-3 bottom-3 z-10 w-72 space-y-2">
      {transfers.slice(-4).map((t) => (
        <li key={t.id} className="rounded-md border border-white/15 bg-black/80 p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">
              {t.direction === 'send' ? '↑' : '↓'} {t.name}
            </span>
            {t.status === 'transferring' || t.status === 'waiting' ? (
              <button type="button" aria-label={`Cancel ${t.name}`} onClick={() => onCancel(t.id)}>
                <X className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <progress className="mt-1 h-1.5 w-full" max={Math.max(t.size, 1)} value={t.transferred} />
          <span className="text-viewer-foreground/70">
            {t.status}
            {t.message ? ` · ${t.message}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ViewerPage() {
  const params = useParams();
  const parsed = deviceIdSchema.safeParse(params['deviceId'] ?? '');
  const deviceId = parsed.success ? parsed.data : null;
  const navigate = useNavigate();
  const deviceName = useDeviceName(deviceId);
  const signedIn = useAuthStore((s) => s.status === 'signed-in');
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen();

  const sessionRef = useRef<ControllerSession | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<ViewerPhase | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [permissions, setPermissions] = useState<SessionPermission[]>([]);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [currentMonitor, setCurrentMonitor] = useState<MonitorSelection | null>(null);
  const [follow, setFollow] = useState(false);
  const [fit, setFit] = useState(true);
  const [control, setControl] = useState(false);
  const [preset, setPreset] = useState<QualityPreset>(
    () => useSettingsStore.getState().defaultQuality,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<TransferProgress[]>([]);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const leave = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    void sessionRef.current?.end();
    sessionRef.current = null;
    void navigate('/');
  }, [navigate]);

  // End the session if the page goes away.
  useEffect(() => () => void sessionRef.current?.end('viewer_closed'), []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const connect = async (requested: SessionPermission[], accessPassword: string) => {
    const api = getDesktopApi();
    if (!api || !deviceId) return;
    setConnectError(null);
    // A fresh session: forget everything from the previous one.
    setConnectedAt(null);
    setStats(null);
    setPermissions([]);
    setMonitors([]);
    setCurrentMonitor(null);
    setControl(false);
    setTransfers([]);
    if (videoRef.current) videoRef.current.srcObject = null;
    try {
      sessionRef.current = await ControllerSession.start(
        api,
        {
          deviceCode: deviceId,
          permissions: requested,
          accessPassword: accessPassword || undefined,
        },
        preset,
        {
          onPhase: (next, info) => {
            setPhase(next);
            setDetail(info ?? null);
            if (next === 'connected') setConnectedAt((at) => at ?? Date.now());
          },
          onStream: (stream) => {
            if (videoRef.current) videoRef.current.srcObject = stream;
          },
          onStats: setStats,
          onMonitors: (list, current, following) => {
            setMonitors(list);
            setCurrentMonitor(current);
            setFollow(following);
          },
          onPermissions: setPermissions,
          onTransfer: (progress) =>
            setTransfers((list) => [...list.filter((t) => t.id !== progress.id), progress]),
          onQuality: () => undefined,
          onNotice: setNotice,
        },
      );
    } catch (error) {
      setPhase(null);
      setConnectError((error as Error).message);
    }
  };

  const session = sessionRef.current;
  const live = phase === 'connected' || phase === 'reconnecting';
  const canControl = permissions.includes('remote_control');
  const sendingInput = live && control && canControl;

  // --- input capture over the video ------------------------------------------------
  const pointer = (event: React.PointerEvent<HTMLVideoElement>) => {
    const video = videoRef.current;
    if (!sendingInput || !video) return null;
    return normalizePointer(
      event.clientX,
      event.clientY,
      video.getBoundingClientRect(),
      video.videoWidth,
      video.videoHeight,
    );
  };
  const lastMove = useRef(0);
  const onPointerMove = (event: React.PointerEvent<HTMLVideoElement>) => {
    const now = performance.now();
    if (now - lastMove.current < 8) return; // ~120 Hz cap
    lastMove.current = now;
    const position = pointer(event);
    if (position) session?.sendInput({ t: 'mm', ...position });
  };
  const onPointerButton = (event: React.PointerEvent<HTMLVideoElement>, down: boolean) => {
    const position = pointer(event);
    const button = mouseButton(event.button);
    if (!position || !button) return;
    event.preventDefault();
    if (down) (event.target as HTMLElement).focus();
    session?.sendInput({ t: 'mm', ...position });
    session?.sendInput({ t: down ? 'md' : 'mu', b: button });
  };
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onWheel = (event: WheelEvent) => {
      if (!sendingInput) return;
      event.preventDefault();
      const { dx, dy } = wheelToRemote(event.deltaX, event.deltaY, event.deltaMode);
      if (dx || dy) session?.sendInput({ t: 'ms', dx, dy });
    };
    video.addEventListener('wheel', onWheel, { passive: false });
    return () => video.removeEventListener('wheel', onWheel);
  }, [sendingInput, session]);
  const onKey = (event: React.KeyboardEvent, down: boolean) => {
    if (!sendingInput) return;
    const message = keyMessage(event.code, down);
    if (!message) return;
    event.preventDefault();
    session?.sendInput(message);
  };
  const releaseAll = () => session?.sendInput({ t: 'release' });

  const sendFiles = async (files: FileList | null) => {
    if (!files || !session) return;
    for (const file of Array.from(files)) await session.sendFile(file);
  };

  if (!deviceId) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-8">
        <EmptyState
          role="alert"
          icon={<TriangleAlert />}
          title="Invalid device ID"
          description={
            parsed.error?.issues[0]?.message ?? 'The device ID in this link is not valid.'
          }
          action={
            <Button asChild variant="outline" size="sm">
              <Link to="/">Back to dashboard</Link>
            </Button>
          }
          className="max-w-lg"
        />
      </div>
    );
  }

  const title = deviceName ?? 'Remote device';
  const currentName =
    currentMonitor === 'all'
      ? 'All monitors'
      : (monitors.find((m) => m.id === currentMonitor)?.name ?? '—');
  const status: ConnectionStatus = phase ? PHASE_STATUS[phase] : 'not-connected';

  return (
    <div className="dark flex h-full flex-col bg-viewer text-viewer-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-white/10 px-3">
        <Tooltip content="Back to dashboard (ends the session)">
          <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={leave}>
            <ArrowLeft aria-hidden="true" />
          </Button>
        </Tooltip>
        <Separator orientation="vertical" className="h-6 bg-white/10" />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          <p className="font-mono text-[11px] text-viewer-foreground/60">
            {formatDeviceId(deviceId)}
          </p>
        </div>
        <ConnectionStatusBadge status={status} />
        <SessionTimer startedAt={connectedAt} />
        {live && stats ? (
          <div
            className="hidden items-center gap-2 text-xs text-viewer-foreground/70 md:flex"
            aria-label="Connection quality"
          >
            <span>{stats.rttMs !== null ? `${stats.rttMs} ms` : '— ms'}</span>
            <span>{stats.fps !== null ? `${Math.round(stats.fps)} fps` : ''}</span>
            <span>
              {stats.bitrateKbps !== null ? `${(stats.bitrateKbps / 1000).toFixed(1)} Mbps` : ''}
            </span>
            <span>
              {stats.lossRate !== null ? `${(stats.lossRate * 100).toFixed(1)}% loss` : ''}
            </span>
            {stats.width ? <span>{`${stats.width}×${stats.height}`}</span> : null}
            {stats.candidateType === 'relay' ? <Badge variant="outline">TURN relay</Badge> : null}
          </div>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          {live ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label={`Monitor: ${currentName}`}>
                  <Monitor aria-hidden="true" />
                  <span className="hidden lg:inline">{currentName}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Remote monitor</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={currentMonitor ?? ''}
                  onValueChange={(value) =>
                    session?.sendControl({ t: 'monitor.select', monitor: value })
                  }
                >
                  {monitors.map((m) => (
                    <DropdownMenuRadioItem key={m.id} value={m.id}>
                      {m.name} · {m.width}×{m.height}
                      {m.primary ? ' (primary)' : ''}
                    </DropdownMenuRadioItem>
                  ))}
                  {monitors.length > 1 ? (
                    <DropdownMenuRadioItem value="all">All monitors</DropdownMenuRadioItem>
                  ) : null}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => session?.sendControl({ t: 'monitor.follow', enabled: !follow })}
                >
                  {follow ? '✓ ' : ''}Follow active monitor
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Tooltip content={fit ? 'Actual size (1:1)' : 'Fit to window'}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-pressed={!fit}
              aria-label="Toggle fit to window"
              onClick={() => setFit((f) => !f)}
            >
              <Scaling aria-hidden="true" />
            </Button>
          </Tooltip>
          <Tooltip content={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              aria-pressed={isFullscreen}
              onClick={toggleFullscreen}
            >
              {isFullscreen ? <Minimize aria-hidden="true" /> : <Maximize aria-hidden="true" />}
            </Button>
          </Tooltip>
          {phase ? (
            <Button variant="destructive" size="sm" className="ml-2" onClick={leave}>
              <PhoneOff aria-hidden="true" />
              End session
            </Button>
          ) : null}
        </div>
      </header>

      <main
        className={`relative flex min-h-0 flex-1 ${fit ? 'items-center justify-center' : 'overflow-auto'} p-2`}
      >
        {!signedIn ? (
          <EmptyState
            icon={<Plug />}
            title="Sign in to connect"
            description="Remote sessions require an account."
            action={
              <Button asChild size="sm">
                <Link to="/account">Sign in</Link>
              </Button>
            }
          />
        ) : !phase ? (
          <ConnectPanel
            deviceId={deviceId}
            onConnect={(p, pw) => void connect(p, pw)}
            error={connectError}
            busy={false}
          />
        ) : null}

        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          tabIndex={0}
          aria-label="Remote screen"
          hidden={!live}
          onPointerMove={onPointerMove}
          onPointerDown={(e) => onPointerButton(e, true)}
          onPointerUp={(e) => onPointerButton(e, false)}
          onContextMenu={(e) => sendingInput && e.preventDefault()}
          onKeyDown={(e) => onKey(e, true)}
          onKeyUp={(e) => onKey(e, false)}
          onBlur={releaseAll}
          className={`${fit ? 'max-h-full max-w-full object-contain' : ''} bg-black outline-none ${sendingInput ? 'cursor-none' : ''} focus-visible:ring-2 focus-visible:ring-primary`}
        />

        {phase && !live ? (
          <div role="status" className="flex max-w-md flex-col items-center gap-3 text-center">
            <MonitorOff className="size-10 text-viewer-foreground/40" aria-hidden="true" />
            <p className="text-lg font-semibold">
              {phase === 'requesting' && 'Sending request…'}
              {phase === 'awaiting-approval' && 'Waiting for the remote user to approve…'}
              {phase === 'connecting' && 'Connecting…'}
              {phase === 'ended' && 'Session ended'}
              {phase === 'failed' && 'Session failed'}
            </p>
            {detail ? <p className="text-sm text-viewer-foreground/70">{detail}</p> : null}
            {phase === 'ended' || phase === 'failed' ? (
              <Button variant="outline" size="sm" onClick={() => setPhase(null)}>
                Connect again
              </Button>
            ) : null}
          </div>
        ) : null}

        <TransferList transfers={transfers} onCancel={(id) => session?.cancelTransfer(id)} />
        {notice ? (
          <p
            role="status"
            className="absolute top-3 left-1/2 -translate-x-1/2 rounded-md bg-black/80 px-3 py-1.5 text-sm"
          >
            {notice}
          </p>
        ) : null}
      </main>

      {live ? (
        <footer className="flex shrink-0 flex-wrap items-center justify-center gap-1 border-t border-white/10 px-3 py-2">
          <div className="mr-2 flex flex-wrap gap-1" aria-label="Granted permissions">
            {permissions.map((p) => (
              <Badge key={p} variant="outline" className="text-[10px]">
                {PERMISSION_LABELS[p]}
              </Badge>
            ))}
          </div>
          <Tooltip
            content={
              canControl
                ? control
                  ? 'Stop controlling (view only)'
                  : 'Control mouse and keyboard'
                : 'Control was not granted'
            }
          >
            <Button
              variant={control ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={control}
              disabled={!canControl}
              onClick={() => {
                if (control) releaseAll();
                setControl((c) => !c);
                videoRef.current?.focus();
              }}
              className="h-auto flex-col gap-1 px-3 py-1.5 text-[11px]"
            >
              <span className="flex gap-1">
                <Mouse aria-hidden="true" />
                <Keyboard aria-hidden="true" />
              </span>
              {control ? 'Controlling' : 'Control'}
            </Button>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={!sendingInput}
                className="h-auto flex-col gap-1 px-3 py-1.5 text-[11px]"
              >
                <Command aria-hidden="true" />
                Keys
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Send special keys</DropdownMenuLabel>
              {COMBOS.map(({ combo, label }) => (
                <DropdownMenuItem
                  key={combo}
                  onSelect={() => session?.sendInput({ t: 'combo', combo })}
                >
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip content="Copy this computer's clipboard text to the remote computer">
            <Button
              variant="ghost"
              size="sm"
              disabled={!permissions.includes('clipboard')}
              onClick={() => void session?.sendClipboard().then(setNotice)}
              className="h-auto flex-col gap-1 px-3 py-1.5 text-[11px]"
            >
              <ClipboardPaste aria-hidden="true" />
              Send clipboard
            </Button>
          </Tooltip>
          <Tooltip content="Copy the remote clipboard text to this computer">
            <Button
              variant="ghost"
              size="sm"
              disabled={!permissions.includes('clipboard')}
              onClick={() => void session?.fetchClipboard().then(setNotice)}
              className="h-auto flex-col gap-1 px-3 py-1.5 text-[11px]"
            >
              <ClipboardCopy aria-hidden="true" />
              Get clipboard
            </Button>
          </Tooltip>
          <Tooltip
            content={
              permissions.includes('file_transfer')
                ? 'Send files (saved to the remote Downloads\\Kestrel Remote folder)'
                : 'File transfer was not granted'
            }
          >
            <Button
              variant="ghost"
              size="sm"
              disabled={!permissions.includes('file_transfer')}
              onClick={() => fileInput.current?.click()}
              className="h-auto flex-col gap-1 px-3 py-1.5 text-[11px]"
            >
              <FolderUp aria-hidden="true" />
              Send files
            </Button>
          </Tooltip>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              void sendFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto flex-col gap-1 px-3 py-1.5 text-[11px]"
              >
                <Gauge aria-hidden="true" />
                Quality: {preset}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuRadioGroup
                value={preset}
                onValueChange={(value) => {
                  const next = value as QualityPreset;
                  setPreset(next);
                  session?.sendControl({ t: 'quality.preset', preset: next });
                }}
              >
                <DropdownMenuRadioItem value="auto">Auto (adaptive)</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="quality">Best quality</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="balanced">Balanced</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="speed">Fastest</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <ViewerToolbarButton icon={Volume2} label="Audio" feature="audio" />
          <Separator orientation="vertical" className="mx-2 h-8 bg-white/10" />
          <Button variant="destructive" size="sm" onClick={leave}>
            <PhoneOff aria-hidden="true" />
            End session
          </Button>
        </footer>
      ) : null}
    </div>
  );
}
