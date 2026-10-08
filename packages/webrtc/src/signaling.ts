/**
 * Signaling protocol (apps/signaling).
 *
 * Every frame is JSON. Client frames are validated with `clientMessageSchema`;
 * all object schemas are strict, so a client cannot smuggle identity fields
 * (`userId`, `fromDeviceId`, `permissions` on relay messages, ...) past the
 * server. Identity always comes from the authenticated socket, and every
 * `sessionId` / `requestId` a client names is checked against the database.
 */
import {
  connectionMessageSchema,
  accessPasswordSchema,
  deviceIdSchema,
  sessionPermissionSchema,
  sessionPermissionSetSchema,
  sessionStateSchema,
} from '@remote-desktop/shared';
import { z } from 'zod';

export const SIGNALING_PROTOCOL_VERSION = 1;

/** Hard cap on one WebSocket frame. SDP is the largest legitimate payload. */
export const MAX_SIGNALING_FRAME_BYTES = 64 * 1024;
export const MAX_SDP_LENGTH = 32 * 1024;
export const MAX_ICE_CANDIDATE_LENGTH = 1024;

const uuid = z.uuid();
/** Client-chosen correlation id, echoed in `ack` / `error`. Never used for authorization. */
const correlationId = z.string().min(1).max(64);

function clientMessage<TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  return z.object({ type: z.literal(type), id: correlationId, payload }).strict();
}

// ---------------------------------------------------------------------------
// Authentication handshake
// ---------------------------------------------------------------------------

/**
 * The exact bytes a device signs with its Ed25519 private key to prove it holds
 * the key registered for `deviceId`. The nonce is single-use and issued by the
 * server for this socket, so a captured signature cannot be replayed.
 */
export function deviceAuthMessage(nonce: string, deviceId: string): string {
  return `kestrel-signaling-auth:v${SIGNALING_PROTOCOL_VERSION}:${nonce}:${deviceId}`;
}

export const authMessageSchema = clientMessage(
  'auth',
  z
    .object({
      /** Supabase access token (JWT). Verified server-side; never logged. */
      accessToken: z.string().min(16).max(8192),
      /** Present when this socket represents a registered device (required to receive requests). */
      device: z
        .object({
          deviceId: uuid,
          /** base64 Ed25519 signature over `deviceAuthMessage(nonce, deviceId)`. */
          signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
        })
        .strict()
        .optional(),
    })
    .strict(),
);

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const iceCandidateSchema = z
  .object({
    candidate: z.string().max(MAX_ICE_CANDIDATE_LENGTH),
    sdpMid: z.string().max(64).nullable(),
    sdpMLineIndex: z.number().int().min(0).max(255).nullable(),
  })
  .strict();

export const clientMessageSchema = z.discriminatedUnion('type', [
  authMessageSchema,
  clientMessage(
    'connection.request',
    z
      .object({
        targetDeviceCode: deviceIdSchema,
        permissions: sessionPermissionSetSchema,
        message: connectionMessageSchema.optional(),
        accessPassword: accessPasswordSchema.optional(),
      })
      .strict(),
  ),
  clientMessage(
    'connection.approve',
    z
      .object({
        requestId: uuid,
        /** Optionally approve fewer permissions than were requested. Never more. */
        permissions: sessionPermissionSetSchema.optional(),
      })
      .strict(),
  ),
  clientMessage(
    'connection.reject',
    z.object({ requestId: uuid, reason: z.string().trim().max(200).optional() }).strict(),
  ),
  clientMessage(
    'webrtc.offer',
    z.object({ sessionId: uuid, sdp: z.string().min(1).max(MAX_SDP_LENGTH) }).strict(),
  ),
  clientMessage(
    'webrtc.answer',
    z.object({ sessionId: uuid, sdp: z.string().min(1).max(MAX_SDP_LENGTH) }).strict(),
  ),
  clientMessage(
    'webrtc.ice_candidate',
    z.object({ sessionId: uuid, candidate: iceCandidateSchema }).strict(),
  ),
  clientMessage(
    'session.permission_update',
    z.object({ sessionId: uuid, permissions: sessionPermissionSetSchema }).strict(),
  ),
  clientMessage(
    'session.end',
    z.object({ sessionId: uuid, reason: z.string().trim().max(200).optional() }).strict(),
  ),
  /**
   * Periodic re-authorization by a participant (the host every 30 s). The
   * server re-reads the session and the controller's access from the
   * database and answers with the current permissions, or ends the session.
   */
  clientMessage('session.verify', z.object({ sessionId: uuid }).strict()),
  /** Connection progress, reported by the controller. */
  clientMessage(
    'session.report',
    z
      .object({
        sessionId: uuid,
        state: z.enum(['CONNECTING', 'CONNECTED', 'RECONNECTING', 'FAILED']),
        reason: z.string().trim().max(200).optional(),
      })
      .strict(),
  ),
  /**
   * Audit events for actions that happen peer-to-peer (file and clipboard
   * transfers). Metadata is fixed-shape: no file names, no contents.
   */
  clientMessage(
    'session.audit',
    z
      .object({
        sessionId: uuid,
        event: z.enum([
          'FILE_TRANSFER_STARTED',
          'FILE_TRANSFER_COMPLETED',
          'FILE_TRANSFER_CANCELLED',
          'CLIPBOARD_TRANSFERRED',
        ]),
        direction: z.enum(['controller_to_host', 'host_to_controller']),
        bytes: z
          .number()
          .int()
          .min(0)
          .max(1024 * 1024 * 1024),
        sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
      })
      .strict(),
  ),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ClientMessageType = ClientMessage['type'];
export type ClientMessageOf<T extends ClientMessageType> = Extract<ClientMessage, { type: T }>;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

const sessionPermissions = z.array(sessionPermissionSchema);

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('auth.challenge'),
    payload: z.object({ nonce: z.string(), protocolVersion: z.number() }),
  }),
  z.object({
    type: z.literal('auth.ok'),
    payload: z.object({
      userId: uuid,
      deviceId: uuid.nullable(),
      deviceCode: z.string().nullable(),
    }),
  }),
  z.object({
    type: z.literal('ack'),
    id: correlationId,
    payload: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('error'),
    id: correlationId.nullable(),
    payload: z.object({ code: z.string(), message: z.string() }),
  }),
  z.object({
    type: z.literal('connection.request'),
    payload: z.object({
      requestId: uuid,
      sessionId: uuid,
      controller: z.object({
        userId: uuid,
        displayName: z.string().nullable(),
        deviceCode: z.string().nullable(),
      }),
      permissions: sessionPermissions,
      message: z.string().nullable(),
      expiresAt: z.string(),
    }),
  }),
  z.object({
    type: z.literal('connection.approve'),
    payload: z.object({
      requestId: uuid,
      sessionId: uuid,
      permissions: sessionPermissions,
      /** Present when sent to the remote device of an auto-approved session. */
      controller: z
        .object({
          userId: uuid,
          displayName: z.string().nullable(),
          deviceCode: z.string().nullable(),
        })
        .optional(),
    }),
  }),
  z.object({
    type: z.literal('connection.reject'),
    payload: z.object({ requestId: uuid, sessionId: uuid, reason: z.string().nullable() }),
  }),
  z.object({
    type: z.literal('webrtc.offer'),
    payload: z.object({ sessionId: uuid, sdp: z.string() }),
  }),
  z.object({
    type: z.literal('webrtc.answer'),
    payload: z.object({ sessionId: uuid, sdp: z.string() }),
  }),
  z.object({
    type: z.literal('webrtc.ice_candidate'),
    payload: z.object({ sessionId: uuid, candidate: iceCandidateSchema }),
  }),
  z.object({
    type: z.literal('session.permission_update'),
    payload: z.object({ sessionId: uuid, permissions: sessionPermissions }),
  }),
  z.object({
    type: z.literal('session.end'),
    payload: z.object({
      sessionId: uuid,
      state: sessionStateSchema,
      reason: z.string().nullable(),
    }),
  }),
  /**
   * STUN/TURN servers for one session, sent only to its authorized
   * participants. TURN credentials are HMAC-derived and expire.
   */
  z.object({
    type: z.literal('session.ice_config'),
    payload: z.object({
      sessionId: uuid,
      iceServers: z.array(
        z.object({
          urls: z.union([z.string(), z.array(z.string())]),
          username: z.string().optional(),
          credential: z.string().optional(),
        }),
      ),
      expiresAt: z.string(),
    }),
  }),
  z.object({
    type: z.literal('device.online'),
    payload: z.object({ deviceId: uuid, deviceCode: z.string() }),
  }),
  z.object({
    type: z.literal('device.offline'),
    payload: z.object({ deviceId: uuid, deviceCode: z.string(), lastSeenAt: z.string() }),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ServerMessageType = ServerMessage['type'];
export type ServerMessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;

/** WebSocket close codes used by the signaling service (4000-4999 is application space). */
export const SIGNALING_CLOSE_CODES = {
  authTimeout: 4001,
  authFailed: 4003,
  rateLimited: 4008,
  protocolError: 4002,
  replaced: 4009,
  serverShutdown: 1001,
} as const;

/**
 * Parses one raw frame. Returns the validation problem instead of throwing so
 * the server can answer with a structured error.
 */
export function parseClientMessage(
  raw: string,
): { ok: true; message: ClientMessage } | { ok: false; id: string | null; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, id: null, error: 'Frame is not valid JSON' };
  }
  const result = clientMessageSchema.safeParse(json);
  if (result.success) return { ok: true, message: result.data };
  const maybeId = correlationId.safeParse(
    typeof json === 'object' && json !== null ? (json as Record<string, unknown>)['id'] : null,
  );
  const issue = result.error.issues[0];
  return {
    ok: false,
    id: maybeId.success ? maybeId.data : null,
    error: issue ? `${issue.path.join('.') || 'message'}: ${issue.message}` : 'Invalid message',
  };
}
