/**
 * Step: media-secrets — Register media API keys with OneCLI as generic
 * header-injection secrets.
 *
 * Usage:
 *   FAL_KEY=... OPENROUTER_API_KEY=... pnpm exec tsx setup/index.ts --step media-secrets
 *   pnpm exec tsx setup/index.ts --step media-secrets -- --dry-run
 *
 * Values are read from process.env first, then .env. Values are never logged.
 */
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

import { readEnvFile } from '../src/env.js';
import { log } from '../src/log.js';
import { emitStatus } from './status.js';

interface SecretSpec {
  name: string;
  envKey: 'FAL_KEY' | 'OPENROUTER_API_KEY';
  hostPattern: string;
  pathPattern?: string;
  headerName: string;
  valueFormat: string;
}

interface OnecliSecret {
  name: string;
}

const SPECS: SecretSpec[] = [
  {
    name: 'fal.ai fal.run',
    envKey: 'FAL_KEY',
    hostPattern: 'fal.run',
    headerName: 'Authorization',
    valueFormat: 'Key {value}',
  },
  {
    name: 'fal.ai queue.fal.run',
    envKey: 'FAL_KEY',
    hostPattern: 'queue.fal.run',
    headerName: 'Authorization',
    valueFormat: 'Key {value}',
  },
  {
    name: 'fal.ai api.fal.ai',
    envKey: 'FAL_KEY',
    hostPattern: 'api.fal.ai',
    headerName: 'Authorization',
    valueFormat: 'Key {value}',
  },
  {
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    hostPattern: 'openrouter.ai',
    pathPattern: '/api/*',
    headerName: 'Authorization',
    valueFormat: 'Bearer {value}',
  },
];

function childEnv(): NodeJS.ProcessEnv {
  const parts = [
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  if (process.env.PATH) parts.push(process.env.PATH);
  return { ...process.env, PATH: parts.join(path.delimiter) };
}

function listExistingSecretNames(): Set<string> {
  const out = execFileSync('onecli', ['secrets', 'list'], {
    encoding: 'utf-8',
    env: childEnv(),
  });
  const parsed = JSON.parse(out) as { data?: OnecliSecret[] };
  return new Set((parsed.data ?? []).map((s) => s.name));
}

function createSecret(spec: SecretSpec, value: string, dryRun: boolean): void {
  const args = [
    'secrets',
    'create',
    '--name',
    spec.name,
    '--type',
    'generic',
    '--value',
    value,
    '--host-pattern',
    spec.hostPattern,
    '--header-name',
    spec.headerName,
    '--value-format',
    spec.valueFormat,
  ];
  if (spec.pathPattern) args.push('--path-pattern', spec.pathPattern);
  if (dryRun) args.push('--dry-run');

  execFileSync('onecli', args, {
    encoding: 'utf-8',
    env: childEnv(),
    stdio: 'pipe',
  });
}

export async function run(args: string[]): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const envFile = readEnvFile(['FAL_KEY', 'OPENROUTER_API_KEY']);
  const values = {
    FAL_KEY: process.env.FAL_KEY || envFile.FAL_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || envFile.OPENROUTER_API_KEY,
  };

  const existing = dryRun ? new Set<string>() : listExistingSecretNames();
  let created = 0;
  let skippedMissing = 0;
  let skippedExisting = 0;

  for (const spec of SPECS) {
    const value = values[spec.envKey];
    if (!value) {
      skippedMissing += 1;
      continue;
    }
    if (existing.has(spec.name)) {
      skippedExisting += 1;
      continue;
    }
    createSecret(spec, value, dryRun);
    created += 1;
    log.info(dryRun ? 'Validated OneCLI media secret' : 'Created OneCLI media secret', {
      name: spec.name,
      envKey: spec.envKey,
      hostPattern: spec.hostPattern,
      pathPattern: spec.pathPattern || null,
    });
  }

  emitStatus('MEDIA_SECRETS', {
    DRY_RUN: dryRun,
    CREATED_OR_VALIDATED: created,
    SKIPPED_MISSING_VALUE: skippedMissing,
    SKIPPED_EXISTING: skippedExisting,
    STATUS: 'success',
  });
}
