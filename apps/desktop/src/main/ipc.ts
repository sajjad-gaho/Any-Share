import { isAllowedNavigation } from '@remote-desktop/security';
import {
  BRAND,
  accessPasswordSchema,
  deviceIdSchema,
  deviceNameSchema,
  deviceRecordSchema,
  emailSchema,
  loginInputSchema,
  passwordResetConfirmSchema,
  registerInputSchema,
  sessionPermissionSetSchema,
  sessionRecordSchema,
} from '@remote-desktop/shared';
import {
  FILE_CHUNK_BYTES,
  MAX_CLIPBOARD_TEXT_BYTES,
  MAX_FILE_BYTES,
  MAX_FILE_NAME_LENGTH,
  MAX_SDP_LENGTH,
  iceCandidateSchema,
  inputMessageSchema,
  monitorSelectionSchema,
} from '@remote-desktop/webrtc';
import { app, ipcMain, nativeTheme, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS, THEME_SOURCES, type AppInfo, type IpcResult } from '../shared/ipc';
import type { Backend } from './backend';
import { ApiError } from './backend/http';
import { HelperError } from './native/helper-client';
import { getRendererUrl } from './renderer-url';
import { FileTransferError, SessionError, type SessionCoordinator } from './session/coordinator';
import { SignalingError } from './session/signaling-client';

const themeSourceSchema = z.enum(THEME_SOURCES);

/** Rejects IPC from any frame that is not our own top-level renderer. */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null || !isAllowedNavigation(frame.url, getRendererUrl())) {
    throw new Error('IPC call rejected: untrusted sender');
  }
}

/**
 * Wraps a handler so every channel gets sender validation and argument parsing.
 * Handlers receive already-validated input and never see the raw event.
 */
function handle<TSchema extends z.ZodType, TResult>(
  channel: string,
  schema: TSchema,
  handler: (input: z.output<TSchema>, sender: WebContents) => TResult | Promise<TResult>,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    assertTrustedSender(event);
    return handler(schema.parse(args), event.sender);
  });
}

/** Converts failures into data with a safe message; unexpected errors stay generic. */
async function result<T>(work: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (
      error instanceof ApiError ||
      error instanceof SessionError ||
      error instanceof SignalingError ||
      error instanceof HelperError ||
      error instanceof FileTransferError
    ) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    console.error('IPC handler failed', error);
    return { ok: false, error: { code: 'internal', message: 'Something went wrong.' } };
  }
}

const sessionId = z.uuid();
const clipboardText = z
  .string()
  .refine(
    (text) => Buffer.byteLength(text) <= MAX_CLIPBOARD_TEXT_BYTES,
    'Clipboard text too large',
  );
const signalSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.enum(['offer', 'answer']), sdp: z.string().min(1).max(MAX_SDP_LENGTH) })
    .strict(),
  z.object({ kind: z.literal('ice'), candidate: iceCandidateSchema }).strict(),
]);
const startSchema = z
  .object({
    deviceCode: deviceIdSchema,
    permissions: sessionPermissionSetSchema,
    accessPassword: accessPasswordSchema.optional(),
  })
  .strict();
const fileOfferSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
    size: z.number().int().min(0).max(MAX_FILE_BYTES),
  })
  .strict();
const chunkSchema = z.custom<Uint8Array>(
  (value) =>
    value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= FILE_CHUNK_BYTES,
  'Invalid chunk',
);
const nativeCaptureSchema = z
  .object({
    monitorId: z.string().min(1).max(64),
    maxFps: z.number().int().min(1).max(60),
    maxWidth: z.number().int().min(320).max(7680),
  })
  .strict();

export function registerIpcHandlers(backend: Backend, sessions: SessionCoordinator): void {
  const { auth, device } = backend;

  handle(IPC_CHANNELS.appGetInfo, z.tuple([]), (): AppInfo => ({
    name: BRAND.productName,
    version: app.getVersion(),
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    isPackaged: app.isPackaged,
  }));

  handle(IPC_CHANNELS.themeSetSource, z.tuple([themeSourceSchema]), ([source]) => {
    nativeTheme.themeSource = source;
  });

  // --- Authentication (tokens stay in this process) ---
  handle(IPC_CHANNELS.authGetState, z.tuple([]), () => auth.restore());
  handle(IPC_CHANNELS.authLogin, z.tuple([loginInputSchema]), ([input]) =>
    result(() => auth.login(input)),
  );
  handle(IPC_CHANNELS.authRegister, z.tuple([registerInputSchema]), ([input]) =>
    result(() => auth.register(input)),
  );
  handle(IPC_CHANNELS.authLogout, z.tuple([]), () => result(() => auth.logout()));
  handle(IPC_CHANNELS.authRequestPasswordReset, z.tuple([emailSchema]), ([email]) =>
    result(() => auth.requestPasswordReset(email)),
  );
  handle(IPC_CHANNELS.authConfirmPasswordReset, z.tuple([passwordResetConfirmSchema]), ([input]) =>
    result(() => auth.confirmPasswordReset(input)),
  );

  // --- Data (authorised server-side; the renderer cannot choose whose data) ---
  handle(IPC_CHANNELS.devicesList, z.tuple([]), () =>
    result(() =>
      auth.authorized({
        method: 'GET',
        path: '/api/v1/devices',
        schema: z.array(deviceRecordSchema),
      }),
    ),
  );
  handle(IPC_CHANNELS.sessionsList, z.tuple([]), () =>
    result(() =>
      auth.authorized({
        method: 'GET',
        path: '/api/v1/sessions',
        schema: z.array(sessionRecordSchema),
      }),
    ),
  );

  // --- This device ---
  handle(IPC_CHANNELS.thisDeviceGet, z.tuple([]), () => device.get());
  handle(IPC_CHANNELS.thisDeviceRegister, z.tuple([deviceNameSchema]), ([name]) =>
    result(async () => {
      const registered = await device.register(name);
      sessions.onDeviceRegistered();
      return registered;
    }),
  );

  // --- Remote sessions (owner window checked by the coordinator) ---
  handle(IPC_CHANNELS.sessionStart, z.tuple([startSchema]), ([input], sender) =>
    result(() => sessions.start(sender, input)),
  );
  handle(IPC_CHANNELS.sessionReady, z.tuple([sessionId]), ([id], sender) =>
    result(async () => sessions.ready(sender, id)),
  );
  handle(IPC_CHANNELS.sessionSignal, z.tuple([sessionId, signalSchema]), ([id, signal], sender) =>
    result(() => sessions.signal(sender, id, signal)),
  );
  handle(
    IPC_CHANNELS.sessionReport,
    z.tuple([sessionId, z.enum(['CONNECTING', 'CONNECTED', 'RECONNECTING', 'FAILED'])]),
    ([id, state], sender) => result(() => sessions.report(sender, id, state)),
  );
  handle(
    IPC_CHANNELS.sessionEnd,
    z.tuple([sessionId, z.string().trim().max(200).optional()]),
    ([id, reason], sender) => result(() => sessions.end(sender, id, reason)),
  );
  handle(
    IPC_CHANNELS.sessionSetPermissions,
    z.tuple([sessionId, sessionPermissionSetSchema]),
    ([id, permissions], sender) => result(() => sessions.setPermissions(sender, id, permissions)),
  );
  handle(IPC_CHANNELS.signalingStatus, z.tuple([]), (_args, sender) => {
    sessions.subscribeStatus(sender);
    return sessions.signalingStatus();
  });

  // --- Host role: native operations, authorized in the coordinator ---
  handle(
    IPC_CHANNELS.hostInput,
    z.tuple([sessionId, inputMessageSchema]),
    ([id, message], sender) => result(() => sessions.input(sender, id, message)),
  );
  handle(IPC_CHANNELS.hostReadClipboard, z.tuple([sessionId]), ([id], sender) =>
    result(() => sessions.readHostClipboard(sender, id)),
  );
  handle(
    IPC_CHANNELS.hostWriteClipboard,
    z.tuple([sessionId, clipboardText]),
    ([id, text], sender) => result(() => sessions.writeHostClipboard(sender, id, text)),
  );
  handle(IPC_CHANNELS.hostMonitors, z.tuple([sessionId]), ([id], sender) =>
    result(() => sessions.monitors(sender, id)),
  );
  handle(
    IPC_CHANNELS.hostSelectMonitor,
    z.tuple([sessionId, monitorSelectionSchema]),
    ([id, selection], sender) =>
      result(async () => ({ captures: await sessions.selectMonitor(sender, id, selection) })),
  );
  handle(IPC_CHANNELS.hostSetFollow, z.tuple([sessionId, z.boolean()]), ([id, enabled], sender) =>
    result(async () => sessions.setFollow(sender, id, enabled)),
  );
  handle(
    IPC_CHANNELS.hostStartNativeCapture,
    z.tuple([sessionId, nativeCaptureSchema]),
    ([id, options], sender) => result(() => sessions.startNativeCapture(sender, id, options)),
  );
  handle(IPC_CHANNELS.hostStopNativeCapture, z.tuple([sessionId]), ([id], sender) =>
    result(() => sessions.stopNativeCapture(sender, id)),
  );

  // --- Controller role: the controller's own clipboard ---
  handle(IPC_CHANNELS.controllerReadClipboard, z.tuple([sessionId]), ([id], sender) =>
    result(() => sessions.readLocalClipboard(sender, id)),
  );
  handle(
    IPC_CHANNELS.controllerWriteClipboard,
    z.tuple([sessionId, clipboardText]),
    ([id, text], sender) => result(() => sessions.writeLocalClipboard(sender, id, text)),
  );

  // --- Files: receiving side ---
  handle(IPC_CHANNELS.filesBegin, z.tuple([sessionId, fileOfferSchema]), ([id, offer], sender) =>
    result(() => sessions.fileBegin(sender, id, offer)),
  );
  handle(
    IPC_CHANNELS.filesChunk,
    z.tuple([sessionId, z.uuid(), chunkSchema]),
    ([id, transfer, data], sender) => result(() => sessions.fileChunk(sender, id, transfer, data)),
  );
  handle(
    IPC_CHANNELS.filesFinish,
    z.tuple([sessionId, z.uuid(), z.string().regex(/^[0-9a-f]{64}$/)]),
    ([id, transfer, sha256], sender) =>
      result(() => sessions.fileFinish(sender, id, transfer, sha256)),
  );
  handle(IPC_CHANNELS.filesCancel, z.tuple([sessionId, z.uuid()]), ([id, transfer], sender) =>
    result(() => sessions.fileCancel(sender, id, transfer)),
  );
  handle(IPC_CHANNELS.filesOpenFolder, z.tuple([]), () =>
    result(() => sessions.openDownloadFolder()),
  );
}
