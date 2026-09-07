import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../../../core/env.js';
import { HttpError } from '../../../core/errors.js';

const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

export async function verifyAppleIdentityToken(identityToken: string) {
  const audiences = (env.APPLE_CLIENT_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!audiences.length) {
    throw new HttpError(503, 'Apple client IDs are not configured', 'APPLE_NOT_CONFIGURED');
  }

  try {
    const { payload } = await jwtVerify(identityToken, appleJwks, {
      issuer: 'https://appleid.apple.com',
      audience: audiences
    });

    if (!payload.sub) throw new Error('Apple subject is missing');
    return {
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : null,
      emailVerified: payload.email_verified === true || payload.email_verified === 'true'
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, 'Apple identity token is invalid', 'APPLE_TOKEN_INVALID');
  }
}
