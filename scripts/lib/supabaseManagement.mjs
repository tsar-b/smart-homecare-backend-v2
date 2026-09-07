import fs from 'node:fs';

export function readArguments(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith('--')) continue;
    const key = entry.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

export function resolveManagementCredentials(args = readArguments()) {
  const projectRef = String(args['project-ref'] ?? process.env.SUPABASE_PROJECT_REF ?? '').trim();
  if (!projectRef) throw new Error('SUPABASE_PROJECT_REF or --project-ref is required');

  let accessToken = process.env.SUPABASE_ACCESS_TOKEN?.trim();
  const secretsFile = String(args['secrets-file'] ?? process.env.SHC_SECRETS_FILE ?? '').trim();
  if (!accessToken && secretsFile) {
    const contents = fs.readFileSync(secretsFile, 'utf8');
    accessToken = contents.match(/Access Token\s*(?:[:=]|\n)\s*`?([^\s`]+)/i)?.[1];
  }
  if (!accessToken) {
    throw new Error('SUPABASE_ACCESS_TOKEN or a --secrets-file containing an Access Token is required');
  }

  return { accessToken, projectRef };
}

export async function managementRequest(path, options = {}, credentials = resolveManagementCredentials()) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${credentials.projectRef}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase Management API request failed (${response.status}): ${redact(body)}`);
  }
  return body ? JSON.parse(body) : null;
}

export function runDatabaseQuery(query, credentials = resolveManagementCredentials()) {
  return managementRequest('/database/query', {
    method: 'POST',
    body: JSON.stringify({ query })
  }, credentials);
}

function redact(value) {
  return value
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .slice(0, 2_000);
}
