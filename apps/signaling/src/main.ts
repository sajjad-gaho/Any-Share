import { createLogger, createRuntime, loadConfigOrExit } from '@remote-desktop/backend';
import { createSignalingServer } from './server';

const config = loadConfigOrExit();
const logger = createLogger({
  level: config.logLevel,
  pretty: config.prettyLogs,
  name: 'signaling',
});
const runtime = createRuntime(config, logger);

const server = createSignalingServer({
  services: runtime.services,
  limiters: runtime.limiters,
  logger,
  heartbeatIntervalMs: config.signaling.heartbeatIntervalMs,
  presenceFlushIntervalMs: config.signaling.presenceFlushIntervalMs,
  sessionConnectTimeoutSeconds: config.signaling.sessionConnectTimeoutSeconds,
  reconcileOnStart: true,
  peerDisconnectGraceMs: config.signaling.peerDisconnectGraceSeconds * 1000,
  ice: {
    stunUrls: config.webrtc.stunUrls,
    turnUrls: config.webrtc.turnUrls,
    turnSecret: config.webrtc.turnSecret,
    ttlSeconds: config.webrtc.turnCredentialTtlSeconds,
  },
  trustProxy: config.api.trustProxy,
  readinessCheck: async () => {
    await runtime.db.query('select 1');
  },
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  await server.close();
  await runtime.db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  const address = await server.listen(config.signaling.port, config.signaling.host);
  logger.info({ env: config.env, port: address.port }, 'Signaling listening on /ws');
} catch (error) {
  logger.fatal({ err: error }, 'Signaling failed to start (is the database reachable?)');
  process.exit(1);
}
