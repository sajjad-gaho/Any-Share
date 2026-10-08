import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

/**
 * Anything that could carry a credential or user content. Pino replaces the
 * value with "[REDACTED]" wherever these paths appear in a log object.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  '*.password',
  '*.newPassword',
  '*.accessPassword',
  '*.accessToken',
  '*.refreshToken',
  '*.token',
  '*.secret',
  '*.secretHash',
  '*.secret_hash',
  '*.privateKey',
  '*.signature',
  '*.sdp',
  '*.candidate',
  '*.clipboard',
  '*.content',
  'password',
  'accessToken',
  'refreshToken',
  'token',
];

export function createLogger(options: { level: string; pretty?: boolean; name?: string }): Logger {
  const config: LoggerOptions = {
    name: options.name,
    level: options.level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    base: { service: options.name },
  };
  if (options.pretty) {
    config.transport = { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } };
  }
  return pino(config);
}

export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
