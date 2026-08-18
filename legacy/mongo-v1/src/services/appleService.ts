// src/services/appleService.ts

import { jwtVerify, createRemoteJWKSet, JWTPayload } from 'jose';

const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');

export async function verifyAppleIdentityToken(idToken: string, expectedAudience?: string) {
  const jwks = createRemoteJWKSet(APPLE_JWKS_URL);

  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: 'https://appleid.apple.com',
    audience: expectedAudience ?? process.env.APPLE_SERVICE_ID,
  });

  return payload as JWTPayload & { sub: string; email?: string };
}
