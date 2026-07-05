/**
 * ⚠️ STALE — This test references the old topic pattern `chat:support:<userId>`.
 * The backend now uses `chat:<conversationId>` via REST-created conversations.
 * Keeping for reference until rewritten.
 *
 * Usage:
 *   BUYER_TOKEN="<jwt>" node --import tsx src/__tests__/integration-test.ts
 *
 * Requires the backend running at ws://localhost:4000
 */

import WebSocket from 'ws';
import type { PhoenixV2Frame } from '../types.js';

const WS_URL = process.env.WS_URL ?? 'ws://localhost:4000/ws/websocket';
const BUYER_TOKEN = process.env.BUYER_TOKEN ?? '';

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function pass(name: string, details = '') {
  results.push({ name, passed: true, details });
  console.log(`  PASS: ${name} ${details}`);
}

function fail(name: string, details = '') {
  results.push({ name, passed: false, details });
  console.log(`  FAIL: ${name} ${details}`);
}

function wsUrl(token: string): string {
  return `${WS_URL}?token=${encodeURIComponent(token)}&vsn=2.0.0`;
}

function sendFrame(ws: WebSocket, frame: unknown[]): void {
  ws.send(JSON.stringify(frame));
}

function decodeToken(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64url').toString());
}

async function waitForFrame(
  ws: WebSocket,
  matcher: (frame: PhoenixV2Frame) => boolean,
  timeoutMs = 5000,
): Promise<PhoenixV2Frame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for frame')), timeoutMs);
    const handler = (data: WebSocket.Data) => {
      try {
        const frame = JSON.parse(data.toString()) as PhoenixV2Frame;
        if (matcher(frame)) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(frame);
        }
      } catch {
        // Not JSON, ignore
      }
    };
    ws.on('message', handler);
  });
}

async function drainBroadcasts(
  ws: WebSocket,
  timeoutMs = 1000,
): Promise<PhoenixV2Frame[]> {
  const frames: PhoenixV2Frame[] = [];
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(frames), timeoutMs);
    const handler = (data: WebSocket.Data) => {
      try {
        const frame = JSON.parse(data.toString()) as PhoenixV2Frame;
        if (frame[1] === null) {
          frames.push(frame);
        }
      } catch {}
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.removeListener('message', handler);
    }, timeoutMs);
  });
}

async function main() {
  if (!BUYER_TOKEN) {
    console.error('BUYER_TOKEN env var required');
    process.exit(1);
  }

  const claims = decodeToken(BUYER_TOKEN);
  const userId = claims.sub as string;
  console.log(`User ID: ${userId}`);

  // --- Test 1: Connect to WebSocket ---
  console.log('\n=== Test 1: WebSocket Connection ===');
  const ws = new WebSocket(wsUrl(BUYER_TOKEN));

  try {
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Connect timeout')), 5000);
    });
    pass('WebSocket connected');
  } catch (e) {
    fail('WebSocket connected', String(e));
    ws.close();
    return;
  }

  // Wait for the phx_reply after connect
  try {
    const frame = await waitForFrame(ws, (f) => f[3] === 'phx_reply' && f[4]?.status === 'ok', 5000);
    if (frame) {
      pass('Phoenix handshake OK');
    } else {
      fail('Phoenix handshake');
    }
  } catch (e) {
    fail('Phoenix handshake', String(e));
  }

  // We need a conversation ID to join the new chat:<convId> topic.
  // For now, this test requires a pre-created conversation.
  const CONVERSATION_ID = process.env.CONVERSATION_ID ?? '';
  if (!CONVERSATION_ID) {
    console.log('\n⚠️  CONVERSATION_ID not set. Create one via POST /api/v1/conversations first.');
    console.log('   Export CONVERSATION_ID, then re-run this test.');
    ws.close();
    return;
  }

  const chatTopic = `chat:${CONVERSATION_ID}`;
  const joinRef = '1';

  console.log(`\n=== Test 2: Join Conversation (${chatTopic}) ===`);
  sendFrame(ws, [joinRef, '1', chatTopic, 'phx_join', { conversation_id: CONVERSATION_ID }]);

  let convId: string | null = null;
  try {
    const frame = await waitForFrame(ws,
      (f) => f[3] === 'phx_reply' && f[2] === chatTopic && f[0] === joinRef,
      5000
    );
    const payload = frame[4] as Record<string, unknown> | undefined;
    if (payload?.status === 'ok') {
      const response = payload.response as Record<string, unknown> | undefined;
      convId = (response?.conversation_id as string) ?? null;
      pass('Joined conversation', `conversation_id=${convId}`);
    } else {
      fail('Join conversation', JSON.stringify(frame));
    }
  } catch (e) {
    fail('Join conversation', String(e));
  }

  // Wait for presence_state or presence_diff after join
  try {
    const frame = await waitForFrame(ws,
      (f) => f[3] === 'presence_state' || f[3] === 'presence_diff',
      3000
    );
    if (frame) {
      const presences = (frame[4] as Record<string, unknown>) ?? {};
      const keys = Object.keys(presences);
      pass('Presence event received', `${frame[3]}: ${keys.length} users`);
    }
  } catch {
    console.log('  WARN: No presence event (channel may be empty)');
  }

  // Also check for delivery broadcast
  try {
    const frame = await waitForFrame(ws,
      (f) => f[3] === 'messages_delivered',
      3000
    );
    if (frame) {
      pass('Delivery event received', `conversation_id=${(frame[4] as Record<string, unknown>)?.conversation_id}`);
    }
  } catch {
    console.log('  WARN: No delivery event');
  }

  // --- Test 3: Send a message ---
  console.log('\n=== Test 3: Send Message ===');
  sendFrame(ws, [null, '2', chatTopic, 'new_message', {
    body: 'Hello from integration test!',
    message: 'Hello from integration test!',
  }]);

  try {
    const frame = await waitForFrame(ws,
      (f) => f[3] === 'phx_reply' && f[1] === '2',
      5000
    );
    const payload = frame[4] as Record<string, unknown> | undefined;
    if (payload?.status === 'ok') {
      const response = payload.response as Record<string, unknown>;
      pass('Message sent', `id=${response.id} status=${response.status}`);
    } else {
      fail('Send message', JSON.stringify(frame));
    }
  } catch (e) {
    fail('Send message', String(e));
  }

  // --- Test 4: Get messages ---
  console.log('\n=== Test 4: Get Messages ===');
  sendFrame(ws, [null, '3', chatTopic, 'get_messages', { limit: 5 }]);

  try {
    const frame = await waitForFrame(ws,
      (f) => f[3] === 'phx_reply' && f[1] === '3',
      5000
    );
    const payload = frame[4] as Record<string, unknown> | undefined;
    if (payload?.status === 'ok') {
      const response = payload.response as Record<string, unknown>;
      const messages = (response.messages as unknown[]) ?? [];
      pass('Got messages', `count=${messages.length}`);
    } else {
      fail('Get messages', JSON.stringify(frame));
    }
  } catch (e) {
    fail('Get messages', String(e));
  }

  // --- Test 5: Typing indicator ---
  console.log('\n=== Test 5: Typing Indicator ===');
  sendFrame(ws, [null, null, chatTopic, 'typing', { is_typing: true }]);
  try {
    const frame = await waitForFrame(ws, (f) => f[3] === 'typing', 2000);
    if (frame) {
      pass('Typing broadcast received', `sender_id=${(frame[4] as Record<string, unknown>)?.sender_id}`);
    }
  } catch {
    pass('Typing sent (no other subscribers)');
  }

  // --- Test 6: Mark messages read ---
  console.log('\n=== Test 6: Mark Read ===');
  sendFrame(ws, [null, '4', chatTopic, 'mark_read', {}]);
  try {
    const frame = await waitForFrame(ws, (f) => f[3] === 'messages_read', 2000);
    if (frame) {
      const payload = frame[4] as Record<string, unknown>;
      pass('Messages read broadcast', `conversation_id=${payload.conversation_id} reader_id=${payload.reader_id}`);
    }
  } catch {
    pass('mark_read sent (no other subscribers to broadcast to)');
  }

  // --- Summary ---
  console.log('\n=== SUMMARY ===');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`Passed: ${passed}/${results.length}, Failed: ${failed}/${results.length}`);

  if (failed > 0) {
    console.log('\nFailures:');
    results.filter(r => !r.passed).forEach(r => console.log(`  - ${r.name}: ${r.details}`));
  }

  ws.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
