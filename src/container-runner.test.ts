import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  buildMediaCredentialContainerConfig,
  GOOGLE_OAUTH_CREDS_CONTAINER_PATH,
  MEDIA_CREDENTIAL_PLACEHOLDERS,
  resolveProviderName,
} from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('buildMediaCredentialContainerConfig', () => {
  it('passes placeholder env vars for OneCLI-injected media API keys', () => {
    const contribution = buildMediaCredentialContainerConfig('');

    expect(contribution.env).toEqual(MEDIA_CREDENTIAL_PLACEHOLDERS);
    expect(Object.values(contribution.env ?? {})).not.toContain(process.env.FAL_KEY);
    expect(Object.values(contribution.env ?? {})).not.toContain(process.env.OPENROUTER_API_KEY);
    expect(contribution.mounts).toEqual([]);
  });

  it('adds a writable Google OAuth token mount only when configured', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-oauth-'));
    const oauthPath = path.join(dir, 'google-oauth.json');
    try {
      fs.writeFileSync(oauthPath, '{}');

      const contribution = buildMediaCredentialContainerConfig(oauthPath);

      expect(contribution.env).toMatchObject({
        ...MEDIA_CREDENTIAL_PLACEHOLDERS,
        GOOGLE_APPLICATION_CREDENTIALS: GOOGLE_OAUTH_CREDS_CONTAINER_PATH,
      });
      expect(contribution.mounts).toEqual([
        {
          hostPath: oauthPath,
          containerPath: GOOGLE_OAUTH_CREDS_CONTAINER_PATH,
          readonly: false,
        },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
