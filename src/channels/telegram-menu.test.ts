import { afterEach, describe, expect, it, vi } from 'vitest';

import { installTelegramCommandMenu } from './telegram.js';
import { closeDb, createMessagingGroup, initTestDb, runMigrations } from '../db/index.js';
import { getDb } from '../db/connection.js';

function now(): string {
  return new Date().toISOString();
}

afterEach(() => {
  closeDb();
});

describe('Telegram command menu', () => {
  it('registers Bot API commands best-effort', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    await installTelegramCommandMenu('token-123', fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bottoken-123/setMyCommands');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { commands: Array<{ command: string; description: string }> };
    expect(body.commands).toContainEqual({ command: 'help', description: 'Show available commands.' });
    expect(body.commands).not.toContainEqual({
      command: 'clear',
      description: 'Start a fresh Claude Code session for this chat.',
    });
  });

  it('registers admin commands for Telegram admin private chats', async () => {
    const db = initTestDb();
    runMigrations(db);
    getDb()
      .prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
      .run('telegram:12345', 'telegram', 'Admin', now());
    getDb()
      .prepare('INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)')
      .run('telegram:12345', 'owner', null, null, now());
    createMessagingGroup({
      id: 'mg-admin',
      channel_type: 'telegram',
      platform_id: 'telegram:12345',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    await installTelegramCommandMenu('token-123', fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const adminBody = JSON.parse(fetchMock.mock.calls[1][1].body as string) as {
      commands: Array<{ command: string; description: string }>;
      scope: { type: string; chat_id: string };
    };
    expect(adminBody.scope).toEqual({ type: 'chat', chat_id: '12345' });
    expect(adminBody.commands).toContainEqual({
      command: 'clear',
      description: 'Start a fresh Claude Code session for this chat.',
    });
    expect(adminBody.commands).toContainEqual({
      command: 'compact',
      description: 'Ask Claude Code to compact the current conversation context.',
    });
  });

  it('does not throw when Telegram rejects setMyCommands', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(
      installTelegramCommandMenu('token-123', fetchMock as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });
});
