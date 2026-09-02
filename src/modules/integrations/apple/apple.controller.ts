import type { Request, Response } from 'express';
import { issueProviderSession } from '../../auth/auth.service.js';
import { verifyAppleIdentityToken } from './apple.service.js';

export async function loginApple(req: Request, res: Response) {
  const identity = await verifyAppleIdentityToken(req.body.identityToken);
  const { response } = await issueProviderSession({
    provider: 'apple',
    providerSubject: identity.subject,
    email: identity.email,
    emailVerified: identity.emailVerified,
    name: req.body.name ?? 'Apple User',
    metadata: { issuer: 'apple' }
  });

  res.json(response);
}
