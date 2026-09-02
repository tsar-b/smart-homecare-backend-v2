import fs from 'node:fs';
import path from 'node:path';
import { readArguments, resolveManagementCredentials, runDatabaseQuery } from './lib/supabaseManagement.mjs';

const args = readArguments();
const file = String(args.file ?? '').trim();
if (!file) throw new Error('--file is required');

const absoluteFile = path.resolve(file);
const migration = fs.readFileSync(absoluteFile, 'utf8');
const dryRun = Boolean(args['dry-run']);
const query = dryRun ? `begin;\n${migration}\nrollback;` : migration;

await runDatabaseQuery(query, resolveManagementCredentials(args));
console.log(`${dryRun ? 'Dry-run passed' : 'Migration applied'}: ${path.basename(absoluteFile)}`);
