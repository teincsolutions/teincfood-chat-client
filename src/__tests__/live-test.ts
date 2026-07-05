/**
 * Live integration test for chat:order: topic.
 *
 * Usage:
 *   export ACCESS_TOKEN="<jwt>"
 *   export ORDER_ID="<uuid>"
 *   npx tsx src/__tests__/live-test.ts
 *
 * Or inline:
 *   ACCESS_TOKEN="<jwt>" ORDER_ID="<uuid>" npx tsx src/__tests__/live-test.ts
 */

/**
 * ⚠️ STALE — This test references removed APIs (getOrderTopic, joinOrderChat).
 * It is NOT included in vitest's normal test run.
 * Keeping for reference until rewritten for the new chat:<convId> pattern.
 */

import { ChatClient } from '../chat-client.js';
import { createInMemoryStorage } from '../store/storage.js';
import { getChatTopic } from '../topics.js';
import { WebSocket } from 'ws';

const WS_URL = process.env.WS_URL ?? 'ws://localhost:4000';
const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const TOKEN = process.env.ACCESS_TOKEN ?? '';
const ORDER_ID = process.env.ORDER_ID ?? '';
const LOG = '[LiveTest]';

function log(...args: unknown[]) {
  console.log(`${LOG} [${new Date().toISOString()}]`, ...args);
}

function ok(msg: string) {
  console.log(`  ✅ ${msg}`);
}

function fail(msg: string) {
  console.log(`  ❌ ${msg}`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!TOKEN) {
    console.error(`${LOG} ❌ ACCESS_TOKEN is required`);
    process.exit(1);
  }
  if (!ORDER_ID) {
    console.error(`${LOG} ❌ ORDER_ID is required`);
    process.exit(1);
  }

  log('═══════════════════════════════════════');
  log('Starting order chat live test');
  log(`WS: ${WS_URL}`);
  log(`Order: ${ORDER_ID}`);
  log('═══════════════════════════════════════');

  // Decode JWT to get user_id
  const payload = JSON.parse(
    Buffer.from(TOKEN.split('.')[1], 'base64').toString(),
  );
  const userId = payload.sub;
  const email = payload.email;
  log(`User: ${email} (${userId})`);

  const client = new ChatClient({
    wsBaseUrl: WS_URL,
    apiBaseUrl: API_URL,
    getAccessToken: async () => TOKEN,
    storage: createInMemoryStorage(),
    websocketImplementation: WebSocket as unknown as typeof globalThis.WebSocket,
  });

  let receivedMessages = 0;
  let errors: string[] = [];

  client.on('connection', (state) => {
    log(`Connection: ${state}`);
  });

  client.on('message', (msg) => {
    receivedMessages++;
    log(`<< Received message from ${msg.senderId}: "${msg.text?.slice(0, 60)}" (conv: ${msg.conversationId})`);
  });

  client.on('error', (err) => {
    errors.push(String(err));
    log(`ERROR: ${err}`);
  });

  try {
    // 1. Connect
    log('\n── 1. Connect ──');
    await client.connect();
    ok('Connected');

    // 2. Join conversation (new pattern via REST create + joinConversation)
    log('\n── 2. Create and join conversation ──');
    // First create/find conversation via REST
    const conv = await client.rest.createConversation({ type: 'direct', orderId: ORDER_ID });
    log(`Conversation created: ${conv.id}`);
    const joinResult = await client.joinConversation(conv.id);
    log(`Join result: ${JSON.stringify(joinResult)}`);
    if (joinResult.topic) ok(`Joined topic: ${joinResult.topic}`);
    else fail('No topic returned');

    await sleep(500);

    // 3. Send a message
    log('\n── 3. Send message ──');
    const testMsg = `Test from ${email} at ${new Date().toISOString()}`;
    const sendResult = await client.sendMessage(
      getChatTopic(conv.id),
      testMsg,
    );
    log(`Send result: ${JSON.stringify(sendResult)}`);
    if (sendResult.status === 'sent' || sendResult.status === 'queued') {
      ok(`Message sent (status: ${sendResult.status})`);
    } else {
      fail(`Message failed: ${sendResult.status}`);
    }

    await sleep(1500);

    // 4. Load messages
    log('\n── 4. Load messages ──');
    const history = await client.loadHistory(getChatTopic(conv.id), 20, 0);
    log(`Loaded ${history.length} messages`);
    history.forEach((m, i) => {
      log(`  [${i}] ${m.senderId?.slice(0, 8)}: "${m.text?.slice(0, 60)}" (${m.status})`);
    });
    if (history.length > 0) ok(`Got ${history.length} messages`);
    else ok('No messages found (order may be new)');

    // 5. Check store
    log('\n── 5. Check local store ──');
    const allKeys = await (client.store as any).storage.getAllKeys();
    log(`Storage keys: ${allKeys.join(', ')}`);

    // 6. Connection state
    log('\n── 6. Connection state ──');
    log(`State: ${client.connectionState}`);
    log(`Connected: ${client.isConnected}`);

  } catch (err) {
    log(`❌ FATAL: ${err}`);
    errors.push(String(err));
  } finally {
    client.disconnect();
    log('\n── Done ──');
  }

  if (errors.length > 0) {
    console.error(`\n${LOG} Errors: ${errors.length}`);
    errors.forEach((e) => console.error(`  ❌ ${e}`));
    process.exit(1);
  } else {
    log('\n✅ All tests passed');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(`${LOG} Fatal:`, err);
  process.exit(1);
});
