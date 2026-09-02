import fs from 'node:fs';
import path from 'node:path';
import { readArguments, resolveManagementCredentials, managementRequest } from './lib/supabaseManagement.mjs';

const args = readArguments();
const credentials = resolveManagementCredentials(args);
const outputPath = path.resolve(String(args.output ?? '.env'));

if (fs.existsSync(outputPath) && !args.force) {
  throw new Error(`${outputPath} already exists; pass --force to replace it`);
}

const keys = await managementRequest('/api-keys', {}, credentials);
if (!Array.isArray(keys)) throw new Error('Supabase returned an unexpected API key response');

const publishableCandidates = [
  keys.find((key) => key.type === 'publishable'),
  keys.find((key) => key.name === 'anon')
].filter(Boolean);
const adminCandidates = [
  keys.find((key) => key.type === 'secret'),
  keys.find((key) => key.name === 'service_role')
].filter(Boolean);

const publishable = await firstWorkingKey(publishableCandidates, credentials.projectRef, '/auth/v1/settings');
const admin = await firstWorkingKey(adminCandidates, credentials.projectRef, '/rest/v1/users?select=id&limit=1');
if (!publishable?.api_key || !admin?.api_key) {
  throw new Error('A working Supabase public key and backend admin key were not both available');
}

const adminVariable = admin.type === 'secret' ? 'SUPABASE_SECRET_KEY' : 'SUPABASE_SERVICE_ROLE_KEY';

const contents = [
  'PORT=5050',
  'NODE_ENV=development',
  'PUBLIC_API_URL=http://localhost:5050',
  'CORS_ORIGINS=*',
  'TRUST_PROXY=false',
  'RATE_LIMIT_WINDOW_MS=60000',
  'RATE_LIMIT_MAX=120',
  'AUTH_RATE_LIMIT_MAX=20',
  'IDEMPOTENCY_TTL_MS=86400000',
  'APP_INITIALIZE_CACHE_TTL_MS=60000',
  'LOG_LEVEL=info',
  '',
  `SUPABASE_URL=https://${credentials.projectRef}.supabase.co`,
  `${publishable.type === 'publishable' ? 'SUPABASE_PUBLISHABLE_KEY' : 'SUPABASE_ANON_KEY'}=${publishable.api_key}`,
  `${adminVariable}=${admin.api_key}`,
  '',
  'AUTH_EMAIL_AUTO_CONFIRM=true',
  'OAUTH_SESSION_EMAIL_DOMAIN=auth.shc.invalid',
  'KAKAO_REST_API_KEY=',
  'KAKAO_ADMIN_KEY=',
  'APPLE_CLIENT_IDS=com.shc.appsmarthomecare',
  ''
].join('\n');

fs.writeFileSync(outputPath, contents, { encoding: 'utf8', mode: 0o600 });
fs.chmodSync(outputPath, 0o600);
console.log(`Wrote ignored local environment file: ${outputPath}`);
console.log('No credential values were printed.');

async function firstWorkingKey(candidates, projectRef, pathname) {
  for (const candidate of candidates) {
    if (!candidate?.api_key) continue;
    const response = await fetch(`https://${projectRef}.supabase.co${pathname}`, {
      headers: {
        apikey: candidate.api_key,
        Authorization: `Bearer ${candidate.api_key}`
      }
    });
    if (response.status !== 401 && response.status !== 403) return candidate;
  }
  return null;
}
