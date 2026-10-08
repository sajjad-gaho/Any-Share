import { createLogger, createRuntime, loadConfigOrExit } from '@remote-desktop/backend';
import { buildApp } from './app';

const config = loadConfigOrExit();
const logger = createLogger({ level: config.logLevel, pretty: config.prettyLogs, name: 'api' });
const runtime = createRuntime(config, logger);

const app = await buildApp({
  services: runtime.services,
  limiters: runtime.limiters,
  db: runtime.db,
  logger,
  trustProxy: config.api.trustProxy,
  rateLimitMultiplier: config.rateLimitMultiplier,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  await app.close();
  await runtime.db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.api.host, port: config.api.port });
  logger.info({ env: config.env }, 'API listening');
} catch (error) {
  logger.fatal({ err: error }, 'API failed to start');
  process.exit(1);
}
