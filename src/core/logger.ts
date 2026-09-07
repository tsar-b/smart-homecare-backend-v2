import pino from 'pino';
import { env } from './env.js';

export const LOGGER_REDACTIONS = [
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
    '*.password',
    '*.password_hash',
    '*.token',
    'token',
    '*.*.token',
    '*.accessToken',
    '*.access_token',
    '*.refreshToken',
    '*.refresh_token',
    '*.signedUrl',
    'signedUrl',
    '*.*.signedUrl',
    '*.signed_url',
    '*.*.signed_url',
    '*.uploadToken',
    'uploadToken',
    '*.*.uploadToken',
    '*.upload_token',
    '*.*.upload_token',
    '*.storageApiKey',
    'storageApiKey',
    '*.*.storageApiKey',
    '*.storage_api_key',
    '*.*.storage_api_key',
    '*.downloadUrl',
    'downloadUrl',
    '*.*.downloadUrl',
    '*.download_url',
    '*.*.download_url',
    '*.xSignature',
    'xSignature',
    '*.*.xSignature',
    '*.x_signature',
    '*.*.x_signature',
    'req.headers["x-signature"]',
    '*.identityToken',
    '*.authorizationCode',
    '*.SUPABASE_SECRET_KEY',
    '*.SUPABASE_SERVICE_ROLE_KEY',
    '*.KAKAO_ADMIN_KEY',
    '*.KAKAO_REST_API_KEY'
  ];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: LOGGER_REDACTIONS,
  transport:
    env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            singleLine: true,
            ignore: 'pid,hostname'
          }
        }
      : undefined
});
