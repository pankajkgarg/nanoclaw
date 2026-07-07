/**
 * WhatsApp channel adapter (v2) — native Baileys v7 implementation.
 *
 * Implements ChannelAdapter directly (no Chat SDK bridge) using
 * @whiskeysockets/baileys v7. Ports proven v1 infrastructure:
 * getMessage fallback, outgoing queue, group metadata cache, LID mapping,
 * reconnection with backoff.
 *
 * Auth credentials persist in store/auth/. On first run:
 * - If WHATSAPP_PHONE_NUMBER is set → pairing code (printed to log)
 * - Otherwise → QR code (printed to log)
 * Subsequent restarts reuse the saved session automatically.
 */
import fs from 'fs';
import path from 'path';
// Named import (not default) — pino's .d.ts under NodeNext resolution
// exports `{ pino as default, pino }`, but the namespace/function merge at
// `declare namespace pino` + `declare function pino` makes the default
// resolve to `typeof pino` (the namespace type), which isn't callable.
// The named export resolves to the callable function.
import { pino } from 'pino';

import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  proto,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import type { GroupMetadata, WAMessageKey, WAMessage, WASocket } from '@whiskeysockets/baileys';

import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import type { ChannelAdapter, ChannelSetup, ConversationInfo, InboundMessage, OutboundMessage } from './adapter.js';

// 'error' surfaces decryption failures (the cause of silently lost inbound
// messages); raise to 'silent' only if it gets too noisy.
const baileysLogger = pino({ level: 'error' });

const AUTH_DIR = path.join(process.cwd(), 'store', 'auth');
const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const GROUP_METADATA_CACHE_TTL_MS = 60_000; // 1 min for outbound sends
const SENT_MESSAGE_CACHE_MAX = 512;
const SENT_MESSAGE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SENT_MESSAGE_CACHE_FILE = path.join(process.cwd(), 'store', 'whatsapp-sent-cache.json');
const RECONNECT_DELAY_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 5 * 60 * 1000;
const PENDING_QUESTIONS_MAX = 64;
const WA_VERSION_FETCH_TIMEOUT_MS = 5000;
const FIRST_OPEN_TIMEOUT_MS = 30_000;

function hasRegisteredWhatsAppAuth(authDir: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(authDir, 'creds.json'), 'utf-8');
    const creds = JSON.parse(raw) as { registered?: boolean };
    return creds.registered === true;
  } catch {
    return false;
  }
}

function timeoutPromise<T>(ms: number, message: string): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

/** Normalize an option label to a slash command: "Approve" → "/approve" */
function optionToCommand(option: string): string {
  return '/' + option.toLowerCase().replace(/\s+/g, '-');
}

// --- Markdown → WhatsApp formatting ---

interface TextSegment {
  content: string;
  isProtected: boolean;
}

/** Split text into code-block-protected and unprotected regions. */
function splitProtectedRegions(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const codeBlockRegex = /```[\s\S]*?```|`[^`\n]+`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ content: text.slice(lastIndex, match.index), isProtected: false });
    }
    segments.push({ content: match[0], isProtected: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ content: text.slice(lastIndex), isProtected: false });
  }

  return segments;
}

/** Apply WhatsApp-native formatting to an unprotected text segment. */
function transformForWhatsApp(text: string): string {
  // Order matters: italic before bold to avoid **bold** → *bold* → _bold_
  // 1. Italic: *text* (not **) → _text_
  text = text.replace(/(?<!\*)\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g, '_$1_');
  // 2. Bold: **text** → *text*
  text = text.replace(/\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*/g, '*$1*');
  // 3. Headings: ## Title → *Title*
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  // 4. Links: [text](url) → text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // 5. Horizontal rules: --- / *** / ___ → stripped
  text = text.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '');
  return text;
}

/** Convert Claude's markdown to WhatsApp-native formatting. */
function formatWhatsApp(text: string): string {
  const segments = splitProtectedRegions(text);
  return segments.map(({ content, isProtected }) => (isProtected ? content : transformForWhatsApp(content))).join('');
}

/** Map file extension to Baileys media message type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildMediaMessage(data: Buffer, filename: string, ext: string, caption?: string): any {
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv'];
  const audioExts = ['.mp3', '.ogg', '.m4a', '.wav', '.aac', '.opus'];

  if (imageExts.includes(ext)) {
    return { image: data, caption, mimetype: `image/${ext.slice(1) === 'jpg' ? 'jpeg' : ext.slice(1)}` };
  }
  if (videoExts.includes(ext)) {
    return { video: data, caption, mimetype: `video/${ext.slice(1)}` };
  }
  if (audioExts.includes(ext)) {
    return { audio: data, mimetype: `audio/${ext.slice(1) === 'mp3' ? 'mpeg' : ext.slice(1)}` };
  }
  // Default: send as document
  return { document: data, fileName: filename, caption, mimetype: 'application/octet-stream' };
}

registerChannelAdapter('whatsapp', {
  factory: () => {
    const env = readEnvFile(['WHATSAPP_PHONE_NUMBER', 'WHATSAPP_ENABLED', 'WHATSAPP_LID_MAP']);
    const phoneNumber = env.WHATSAPP_PHONE_NUMBER;
    const authDir = AUTH_DIR;

    // Skip if no existing auth, no phone number for pairing, and not explicitly enabled (QR mode)
    const hasAuth = hasRegisteredWhatsAppAuth(authDir);
    if (!hasAuth && !phoneNumber && !env.WHATSAPP_ENABLED) return null;

    fs.mkdirSync(authDir, { recursive: true });

    // State
    let sock: WASocket;
    let connected = false;
    let setupConfig: ChannelSetup;

    // LID → phone JID mapping (WhatsApp's new ID system)
    const lidToPhoneMap: Record<string, string> = {};
    let botLidUser: string | undefined;
    let botPhoneUser: string | undefined;

    // Outgoing queue for messages sent while disconnected
    const outgoingQueue: Array<{ jid: string; text: string }> = [];
    let flushing = false;

    // Sent message cache for retry/re-encrypt requests. Disk-backed: retry
    // receipts can arrive hours after the send (or after a service restart),
    // and a retry we cannot serve leaves that recipient permanently on
    // "Waiting for this message".
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sentMessageCache = new Map<string, { message: any; ts: number }>();
    let persistSentCacheTimer: NodeJS.Timeout | undefined;

    try {
      const raw = JSON.parse(fs.readFileSync(SENT_MESSAGE_CACHE_FILE, 'utf-8')) as {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        entries?: Record<string, { message: any; ts: number }>;
      };
      const loaded = Object.entries(raw.entries ?? {})
        .filter(([, v]) => v && typeof v.ts === 'number' && Date.now() - v.ts < SENT_MESSAGE_CACHE_TTL_MS)
        .sort(([, a], [, b]) => a.ts - b.ts);
      for (const [id, v] of loaded) sentMessageCache.set(id, v);
      if (sentMessageCache.size > 0) {
        log.info('Loaded WhatsApp sent-message cache', { size: sentMessageCache.size });
      }
    } catch {
      // Missing or unreadable cache file — start empty.
    }

    function persistSentCacheSoon(): void {
      if (persistSentCacheTimer) return;
      persistSentCacheTimer = setTimeout(() => {
        persistSentCacheTimer = undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entries: Record<string, { message: any; ts: number }> = {};
        for (const [id, v] of sentMessageCache) entries[id] = v;
        fs.promises
          .writeFile(SENT_MESSAGE_CACHE_FILE, JSON.stringify({ entries }), 'utf-8')
          .catch((err) => log.debug('Failed to persist WhatsApp sent-message cache', { err }));
      }, 1000);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function cacheSentMessage(sent: { key?: { id?: string | null } | null; message?: any } | undefined): void {
      if (!sent?.key?.id || !sent.message) return;
      sentMessageCache.set(sent.key.id, { message: sent.message, ts: Date.now() });
      while (sentMessageCache.size > SENT_MESSAGE_CACHE_MAX) {
        const oldest = sentMessageCache.keys().next().value!;
        sentMessageCache.delete(oldest);
      }
      persistSentCacheSoon();
    }

    // Group metadata cache with TTL
    const groupMetadataCache = new Map<string, { metadata: GroupMetadata; expiresAt: number }>();

    // Pending questions: chatJid → { questionId, options }
    // User replies with /approve, /reject, etc. to answer
    const pendingQuestions = new Map<
      string,
      {
        questionId: string;
        options: NormalizedOption[];
      }
    >();

    // Group sync tracking
    let lastGroupSync = 0;
    let groupSyncTimerStarted = false;

    // First-connect promise
    let resolveFirstOpen: (() => void) | undefined;
    let rejectFirstOpen: ((err: Error) => void) | undefined;

    // Pairing code file for the setup skill to poll
    const pairingCodeFile = path.join(process.cwd(), 'store', 'pairing-code.txt');

    // --- Helpers ---

    function setLidPhoneMapping(lidUser: string, phoneJid: string): void {
      if (lidToPhoneMap[lidUser] === phoneJid) return;
      lidToPhoneMap[lidUser] = phoneJid;
      // Cached group metadata depends on participant IDs — invalidate
      groupMetadataCache.clear();
    }

    function normalizePhoneJid(jidOrPhone: string): string {
      return `${jidOrPhone.split('@')[0].split(':')[0]}@s.whatsapp.net`;
    }

    function normalizeLidJid(jidOrLid: string): string {
      return `${jidOrLid.split('@')[0].split(':')[0]}@lid`;
    }

    async function rememberLidPhoneMapping(lidJidOrUser: string, phoneJidOrUser: string): Promise<void> {
      const lidJid = normalizeLidJid(lidJidOrUser);
      const phoneJid = normalizePhoneJid(phoneJidOrUser);
      setLidPhoneMapping(lidJid.split('@')[0], phoneJid);
      try {
        await sock?.signalRepository?.lidMapping?.storeLIDPNMappings([{ lid: lidJid, pn: phoneJid }]);
      } catch (err) {
        log.debug('Failed to persist WhatsApp LID mapping', { lidJid, phoneJid, err });
      }
    }

    async function persistKnownLidMappings(): Promise<void> {
      const pairs = Object.entries(lidToPhoneMap).map(([lidUser, phoneJid]) => ({
        lid: `${lidUser}@lid`,
        pn: phoneJid,
      }));
      if (pairs.length === 0) return;
      try {
        await sock?.signalRepository?.lidMapping?.storeLIDPNMappings(pairs);
      } catch (err) {
        log.debug('Failed to persist configured WhatsApp LID mappings', { count: pairs.length, err });
      }
    }

    async function rememberGroupLidMappings(metadata: GroupMetadata): Promise<void> {
      const tasks: Array<Promise<void>> = [];
      for (const participant of metadata.participants) {
        if (participant.id?.endsWith('@lid') && participant.phoneNumber?.endsWith('@s.whatsapp.net')) {
          tasks.push(rememberLidPhoneMapping(participant.id, participant.phoneNumber));
        } else if (participant.id?.endsWith('@s.whatsapp.net') && participant.lid?.endsWith('@lid')) {
          tasks.push(rememberLidPhoneMapping(participant.lid, participant.id));
        }
      }
      if (metadata.owner?.endsWith('@lid') && metadata.ownerPn?.endsWith('@s.whatsapp.net')) {
        tasks.push(rememberLidPhoneMapping(metadata.owner, metadata.ownerPn));
      }
      await Promise.all(tasks);
    }

    for (const entry of (env.WHATSAPP_LID_MAP ?? '').split(',')) {
      const [lid, phone] = entry
        .split(':')
        .map((s) => s?.trim())
        .filter(Boolean);
      if (lid && phone) setLidPhoneMapping(normalizeLidJid(lid).split('@')[0], normalizePhoneJid(phone));
    }

    async function translateJid(jid: string): Promise<string> {
      if (!jid.endsWith('@lid')) return jid;
      const lidUser = jid.split('@')[0].split(':')[0];

      const cached = lidToPhoneMap[lidUser];
      if (cached) return cached;

      // Query Baileys' signal repository
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pn = await (sock.signalRepository as any)?.lidMapping?.getPNForLID(jid);
        if (pn) {
          const phoneJid = normalizePhoneJid(pn);
          await rememberLidPhoneMapping(jid, phoneJid);
          log.info('Translated LID to phone JID', { lidJid: jid, phoneJid });
          return phoneJid;
        }
      } catch (err) {
        log.debug('Failed to resolve LID via signalRepository', { jid, err });
      }

      return jid;
    }

    async function getNormalizedGroupMetadata(jid: string): Promise<GroupMetadata | undefined> {
      if (!jid.endsWith('@g.us')) return undefined;

      const cached = groupMetadataCache.get(jid);
      if (cached && cached.expiresAt > Date.now()) return cached.metadata;

      const normalized = await sock.groupMetadata(jid);
      await rememberGroupLidMappings(normalized);
      groupMetadataCache.set(jid, {
        metadata: normalized,
        expiresAt: Date.now() + GROUP_METADATA_CACHE_TTL_MS,
      });
      return normalized;
    }

    async function syncGroupMetadata(force = false): Promise<void> {
      if (!force && lastGroupSync && Date.now() - lastGroupSync < GROUP_SYNC_INTERVAL_MS) {
        return;
      }
      try {
        log.info('Syncing group metadata from WhatsApp...');
        const groups = await sock.groupFetchAllParticipating();
        let count = 0;
        for (const [jid, metadata] of Object.entries(groups)) {
          await rememberGroupLidMappings(metadata);
          if (metadata.subject) {
            setupConfig.onMetadata(jid, metadata.subject, true);
            count++;
          }
        }
        lastGroupSync = Date.now();
        log.info('Group metadata synced', { count });
      } catch (err) {
        log.error('Failed to sync group metadata', { err });
      }
    }

    async function flushOutgoingQueue(): Promise<void> {
      if (flushing || outgoingQueue.length === 0) return;
      flushing = true;
      try {
        log.info('Flushing outgoing message queue', { count: outgoingQueue.length });
        while (outgoingQueue.length > 0) {
          const item = outgoingQueue.shift()!;
          const sent = await sock.sendMessage(item.jid, { text: item.text }, { useCachedGroupMetadata: false });
          cacheSentMessage(sent);
        }
      } finally {
        flushing = false;
      }
    }

    /** Download media from an inbound message, save to /workspace/attachments/. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function downloadInboundMedia(
      msg: WAMessage,
      normalized: any,
    ): Promise<Array<{ type: string; name: string; localPath: string }>> {
      const mediaTypes: Array<{ key: string; type: string; ext: string }> = [
        { key: 'imageMessage', type: 'image', ext: '.jpg' },
        { key: 'videoMessage', type: 'video', ext: '.mp4' },
        { key: 'audioMessage', type: 'audio', ext: '.ogg' },
        { key: 'documentMessage', type: 'document', ext: '' },
      ];
      const results: Array<{ type: string; name: string; localPath: string }> = [];
      for (const { key, type, ext } of mediaTypes) {
        if (!normalized[key]) continue;
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const docFilename = normalized[key].fileName;
          const filename = docFilename || `${type}-${Date.now()}${ext}`;
          const attachDir = path.join(DATA_DIR, 'attachments');
          fs.mkdirSync(attachDir, { recursive: true });
          const filePath = path.join(attachDir, filename);
          fs.writeFileSync(filePath, buffer);
          results.push({ type, name: filename, localPath: `attachments/${filename}` });
          log.info('Media downloaded', { type, filename });
        } catch (err) {
          log.warn('Failed to download media', { type, err });
        }
      }
      return results;
    }

    async function sendRawMessage(jid: string, text: string): Promise<string | undefined> {
      if (!connected) {
        outgoingQueue.push({ jid, text });
        log.info('WA disconnected, message queued', { jid, queueSize: outgoingQueue.length });
        return;
      }
      try {
        const sent = await sock.sendMessage(jid, { text }, { useCachedGroupMetadata: false });
        cacheSentMessage(sent);
        return sent?.key?.id ?? undefined;
      } catch (err) {
        outgoingQueue.push({ jid, text });
        log.warn('Failed to send, message queued', { jid, err, queueSize: outgoingQueue.length });
        return undefined;
      }
    }

    // --- Socket creation ---

    // Single auth state + signal key cache shared across reconnects.
    // Re-creating these per reconnect leaves the old socket's cache still
    // flushing writes while the new one reads a stale snapshot of the same
    // files — lost ratchet updates that surface days later as Bad MAC
    // decrypt failures and "Waiting for this message" on peers.
    let authState: Awaited<ReturnType<typeof useMultiFileAuthState>> | undefined;
    let sharedKeyStore: ReturnType<typeof makeCacheableSignalKeyStore> | undefined;

    // Reconnect must be single-flight with backoff. Reconnecting directly
    // from every close event multiplies sockets: N parallel sockets each
    // emit close and each spawns a replacement, so one bad night of 408
    // timeouts compounds into a hot loop (observed: 50k+ reconnect attempts
    // overnight) with dozens of sockets sharing one Signal key store.
    let reconnectTimer: NodeJS.Timeout | undefined;
    let reconnectDelayMs = 0;

    function scheduleReconnect(): void {
      if (reconnectTimer) return;
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(Math.max(reconnectDelayMs * 2, RECONNECT_DELAY_MS), RECONNECT_MAX_DELAY_MS);
      log.info('Scheduling WhatsApp reconnect', { delayMs: delay });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connectSocket().catch((err) => {
          log.error('WhatsApp reconnect failed', { err });
          scheduleReconnect();
        });
      }, delay);
    }

    async function connectSocket(): Promise<void> {
      if (!authState) {
        authState = await useMultiFileAuthState(authDir);
        sharedKeyStore = makeCacheableSignalKeyStore(authState.state.keys, baileysLogger);
      }
      const { state, saveCreds } = authState;

      const { version } = await Promise.race([
        fetchLatestWaWebVersion({}),
        timeoutPromise<{ version: undefined }>(WA_VERSION_FETCH_TIMEOUT_MS, 'Timed out fetching WA Web version'),
      ]).catch((err) => {
        log.warn('Failed to fetch latest WA Web version, using default', { err });
        return { version: undefined };
      });

      sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: sharedKeyStore!,
        },
        printQRInTerminal: false,
        logger: baileysLogger,
        browser: Browsers.macOS('Chrome'),
        cachedGroupMetadata: async (jid: string) => getNormalizedGroupMetadata(jid),
        getMessage: async (key: WAMessageKey) => {
          const cached = sentMessageCache.get(key.id || '');
          if (cached) {
            log.info('WhatsApp retry: serving cached sent message', {
              messageId: key.id,
              remoteJid: key.remoteJid,
              ageMs: Date.now() - cached.ts,
            });
            // fromObject passes proto instances through and revives plain
            // objects loaded from the disk cache.
            return proto.Message.fromObject(cached.message);
          }
          // Never return an empty message here: Baileys would mark the retry
          // successful and resend a BLANK with the same id, leaving the
          // recipient permanently on "Waiting for this message". Returning
          // undefined skips the resend but keeps the session-heal side
          // effects of the retry receipt.
          log.warn('WhatsApp retry: sent message not in cache, skipping resend', {
            messageId: key.id,
            remoteJid: key.remoteJid,
            cacheSize: sentMessageCache.size,
          });
          return undefined;
        },
      });

      // Request pairing code if phone number is set and not yet registered
      if (phoneNumber && !state.creds.registered) {
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(phoneNumber);
            log.info(`WhatsApp pairing code: ${code}`);
            log.info('Enter in WhatsApp > Linked Devices > Link with phone number');
            fs.writeFileSync(pairingCodeFile, code, 'utf-8');
          } catch (err) {
            log.error('Failed to request pairing code', { err });
          }
        }, 3000);
      }

      const thisSock = sock;
      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // A newer socket has replaced this one — its lifecycle events must
        // not flip adapter state or trigger another reconnect.
        if (sock !== thisSock) {
          if (connection) log.debug('Ignoring stale WhatsApp socket event', { connection });
          return;
        }

        if (qr && !phoneNumber) {
          // QR code auth — print to terminal
          (async () => {
            try {
              const QRCode = await import('qrcode');
              const qrText = await QRCode.toString(qr, { type: 'terminal' });
              log.info('WhatsApp QR code — scan with WhatsApp > Linked Devices:\n' + qrText);
            } catch {
              log.info('WhatsApp QR code (raw)', { qr });
            }
          })();
        }

        if (connection === 'close') {
          connected = false;
          const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
          const shouldReconnect = reason !== DisconnectReason.loggedOut;

          log.info('WhatsApp connection closed', { reason, shouldReconnect });

          if (shouldReconnect) {
            scheduleReconnect();
          } else {
            log.info('WhatsApp logged out');
            if (rejectFirstOpen) {
              rejectFirstOpen(new Error('WhatsApp logged out'));
              rejectFirstOpen = undefined;
              resolveFirstOpen = undefined;
            }
          }
        } else if (connection === 'open') {
          connected = true;
          reconnectDelayMs = 0;
          log.info('Connected to WhatsApp');

          // Clean up pairing code file after successful connection
          try {
            if (fs.existsSync(pairingCodeFile)) fs.unlinkSync(pairingCodeFile);
          } catch {
            /* ignore */
          }

          // Announce availability for presence updates
          sock.sendPresenceUpdate('available').catch((err) => {
            log.warn('Failed to send presence update', { err });
          });

          // Build LID → phone mapping from auth state
          if (sock.user) {
            const phoneUser = sock.user.id.split(':')[0];
            const lidUser = sock.user.lid?.split(':')[0];
            if (phoneUser) {
              botPhoneUser = phoneUser;
            }
            if (lidUser && phoneUser) {
              setLidPhoneMapping(lidUser, `${phoneUser}@s.whatsapp.net`);
              botLidUser = lidUser;
            }
          }
          persistKnownLidMappings().catch((err) => log.debug('Failed to store known LID mappings', { err }));

          // Flush queued messages
          flushOutgoingQueue().catch((err) => log.error('Failed to flush outgoing queue', { err }));

          // Group sync
          syncGroupMetadata().catch((err) => log.error('Initial group sync failed', { err }));
          if (!groupSyncTimerStarted) {
            groupSyncTimerStarted = true;
            setInterval(() => {
              syncGroupMetadata().catch((err) => log.error('Periodic group sync failed', { err }));
            }, GROUP_SYNC_INTERVAL_MS);
          }

          // Signal first open
          if (resolveFirstOpen) {
            resolveFirstOpen();
            resolveFirstOpen = undefined;
            rejectFirstOpen = undefined;
          }
        }
      });

      sock.ev.on('creds.update', saveCreds);

      // LID mapping events — keep local cache aligned with Baileys' Signal store.
      sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
        rememberLidPhoneMapping(lid, pn).catch((err) => {
          log.debug('Failed to remember WhatsApp LID mapping update', { lid, pn, err });
        });
      });

      // Inbound messages
      sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
          try {
            if (!msg.message) {
              log.info('WhatsApp inbound skipped: no payload (undecryptable or stub)', {
                remoteJid: msg.key.remoteJid,
                messageId: msg.key.id,
                fromMe: msg.key.fromMe || false,
                stubType: msg.messageStubType,
                stubParams: msg.messageStubParameters,
              });
              continue;
            }
            const normalized = normalizeMessageContent(msg.message);
            if (!normalized) {
              log.info('WhatsApp inbound skipped: unnormalizable payload', {
                remoteJid: msg.key.remoteJid,
                messageId: msg.key.id,
                messageTypes: Object.keys(msg.message),
              });
              continue;
            }
            const rawJid = msg.key.remoteJid;
            if (!rawJid || rawJid === 'status@broadcast') continue;
            if (msg.key.participantAlt && msg.key.participant?.endsWith('@lid')) {
              await rememberLidPhoneMapping(msg.key.participant, msg.key.participantAlt);
            }
            if (msg.key.remoteJidAlt && rawJid.endsWith('@lid')) {
              await rememberLidPhoneMapping(rawJid, msg.key.remoteJidAlt);
            }

            // Translate LID → phone JID
            let chatJid = await translateJid(rawJid);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (chatJid.endsWith('@lid') && (msg.key as any).senderPn) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const pn = (msg.key as any).senderPn as string;
              const phoneJid = normalizePhoneJid(pn);
              await rememberLidPhoneMapping(rawJid, phoneJid);
              chatJid = phoneJid;
            }

            const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();
            const isGroup = chatJid.endsWith('@g.us');

            // Notify metadata for group discovery
            setupConfig.onMetadata(chatJid, undefined, isGroup);

            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              '';

            // Normalize bot LID mention → assistant name for trigger matching
            if (botLidUser && content.includes(`@${botLidUser}`)) {
              content = content.replace(`@${botLidUser}`, `@${ASSISTANT_NAME}`);
            }
            if (botPhoneUser && content.includes(`@${botPhoneUser}`)) {
              content = content.replace(`@${botPhoneUser}`, `@${ASSISTANT_NAME}`);
            }
            const isMention = !isGroup || content.includes(`@${ASSISTANT_NAME}`);

            // Download media attachments (images, video, audio, documents)
            const attachments = await downloadInboundMedia(msg, normalized);

            // Skip empty protocol messages (no text and no attachments)
            if (!content && attachments.length === 0) {
              log.info('WhatsApp inbound skipped: no text or attachments', {
                chatJid,
                messageId: msg.key.id,
                fromMe: msg.key.fromMe || false,
                messageTypes: Object.keys(normalized),
                protocolType: normalized.protocolMessage?.type,
                peerOpType: normalized.protocolMessage?.peerDataOperationRequestMessage?.peerDataOperationRequestType,
              });
              continue;
            }

            const sender = msg.key.participant || msg.key.remoteJid || '';
            const senderName = msg.pushName || sender.split('@')[0];
            const isBotMessage = ASSISTANT_HAS_OWN_NUMBER ? false : content.startsWith(`${ASSISTANT_NAME}:`);
            const fromMe = msg.key.fromMe || false;
            // Dedicated number: fromMe events are normally the bot's own echoes.
            // Exception: the assistant's own-number self-chat — user-typed
            // linked-device messages and bot replies both arrive as fromMe, so
            // use the sent-message cache to suppress only the bot's echoes.
            if (fromMe) {
              const isSelfChat = botPhoneUser ? chatJid === normalizePhoneJid(botPhoneUser) : false;
              if (ASSISTANT_HAS_OWN_NUMBER) {
                const cachedBotEcho = sentMessageCache.has(msg.key.id || '');
                if (!isSelfChat || cachedBotEcho) {
                  log.info('WhatsApp inbound skipped: fromMe gate', {
                    chatJid,
                    messageId: msg.key.id,
                    isSelfChat,
                    cachedBotEcho,
                    botPhoneUser,
                  });
                  continue;
                }
              } else if (isBotMessage) {
                log.info('WhatsApp inbound skipped: assistant-prefixed echo', {
                  chatJid,
                  messageId: msg.key.id,
                });
                continue;
              }
            }

            // Check if this reply answers a pending question via slash command
            const pending = pendingQuestions.get(chatJid);
            if (pending && content.startsWith('/')) {
              const cmd = content.trim().toLowerCase();
              const matched = pending.options.find((o) => optionToCommand(o.label) === cmd);
              if (matched) {
                const voterName = msg.pushName || sender.split('@')[0];
                setupConfig.onAction(pending.questionId, matched.value, sender);
                pendingQuestions.delete(chatJid);
                await sendRawMessage(chatJid, `${matched.selectedLabel} by ${voterName}`);
                log.info('Question answered', {
                  questionId: pending.questionId,
                  value: matched.value,
                  voterName,
                });
                continue; // Don't forward this reply to the agent
              }
            }

            const inbound: InboundMessage = {
              id: msg.key.id || `wa-${Date.now()}`,
              kind: 'chat',
              content: {
                text: content,
                sender,
                senderName,
                ...(attachments.length > 0 && { attachments }),
                fromMe,
                isBotMessage,
                isGroup,
                chatJid,
              },
              timestamp,
              isMention,
              isGroup,
            };

            // WhatsApp doesn't use threads — threadId is null
            setupConfig.onInbound(chatJid, null, inbound);
          } catch (err) {
            log.error('Error processing incoming WhatsApp message', {
              err,
              remoteJid: msg.key?.remoteJid,
            });
          }
        }
      });
    }

    // --- ChannelAdapter implementation ---

    const adapter: ChannelAdapter = {
      name: 'whatsapp',
      channelType: 'whatsapp',
      supportsThreads: false,

      async setup(hostConfig: ChannelSetup) {
        setupConfig = hostConfig;

        // Connect and wait for first open
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            resolveFirstOpen = resolve;
            rejectFirstOpen = reject;
            connectSocket().catch(reject);
          }),
          timeoutPromise<void>(FIRST_OPEN_TIMEOUT_MS, 'Timed out waiting for WhatsApp first open'),
        ]).catch((err) => {
          log.warn('WhatsApp first open not ready; continuing startup', { err });
        });

        if (!resolveFirstOpen && !rejectFirstOpen) {
          log.info('WhatsApp adapter initialized');
          return;
        }

        log.info('WhatsApp adapter initialized; connection still pending');
      },

      async deliver(
        platformId: string,
        _threadId: string | null,
        message: OutboundMessage,
      ): Promise<string | undefined> {
        const content = message.content as Record<string, unknown>;

        // Ask question → text with slash command replies
        if (content.type === 'ask_question' && content.questionId && content.options) {
          const questionId = content.questionId as string;
          const title = content.title as string;
          const question = content.question as string;
          if (!title) {
            log.error('ask_question missing required title — skipping delivery', { questionId });
            return;
          }
          const options: NormalizedOption[] = normalizeOptions(content.options as never);

          const optionLines = options.map((o) => `  ${optionToCommand(o.label)}`).join('\n');
          const text = `*${title}*\n\n${question}\n\nReply with:\n${optionLines}`;
          const msgId = await sendRawMessage(platformId, text);
          if (msgId) {
            pendingQuestions.set(platformId, { questionId, options });
            if (pendingQuestions.size > PENDING_QUESTIONS_MAX) {
              const oldest = pendingQuestions.keys().next().value!;
              pendingQuestions.delete(oldest);
            }
          }
          return msgId;
        }

        // Reaction → emoji on a message
        if (content.operation === 'reaction' && content.messageId && content.emoji) {
          try {
            await sock.sendMessage(platformId, {
              react: {
                text: content.emoji as string,
                key: { remoteJid: platformId, id: content.messageId as string, fromMe: false },
              },
            });
          } catch (err) {
            log.debug('Failed to send reaction', { platformId, err });
          }
          return;
        }

        // Normal message (with optional file attachments)
        const text = (content.markdown as string) || (content.text as string);
        const hasFiles = message.files && message.files.length > 0;

        if (!text && !hasFiles) return;

        // Send file attachments (first file gets the caption, rest are captionless)
        if (hasFiles) {
          let captionUsed = false;
          for (const file of message.files!) {
            try {
              const ext = path.extname(file.filename).toLowerCase();
              const caption = !captionUsed ? text : undefined;
              const mediaMsg = buildMediaMessage(file.data, file.filename, ext, caption);
              const sent = await sock.sendMessage(platformId, mediaMsg, { useCachedGroupMetadata: false });
              cacheSentMessage(sent);
              if (caption) captionUsed = true;
            } catch (err) {
              log.error('Failed to send file', { platformId, filename: file.filename, err });
            }
          }
          if (captionUsed) return; // Text was sent as caption
        }

        if (text) {
          const formatted = formatWhatsApp(text);
          const prefixed = ASSISTANT_HAS_OWN_NUMBER ? formatted : `${ASSISTANT_NAME}: ${formatted}`;
          return sendRawMessage(platformId, prefixed);
        }
      },

      async setTyping(platformId: string) {
        try {
          await sock.sendPresenceUpdate('composing', platformId);
        } catch (err) {
          log.debug('Failed to update typing status', { jid: platformId, err });
        }
      },

      async teardown() {
        connected = false;
        sock?.end(undefined);
        log.info('WhatsApp adapter shut down');
      },

      isConnected() {
        return connected;
      },

      async syncConversations(): Promise<ConversationInfo[]> {
        try {
          const groups = await sock.groupFetchAllParticipating();
          return Object.entries(groups)
            .filter(([, m]) => m.subject)
            .map(([jid, m]) => ({
              platformId: jid,
              name: m.subject,
              isGroup: true,
            }));
        } catch (err) {
          log.error('Failed to sync WhatsApp conversations', { err });
          return [];
        }
      },
    };

    return adapter;
  },
});
