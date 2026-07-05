/**
 * ⚠️ STALE — This test uses the old `chat:pair:<order>_<user1>_<user2>` topic pattern.
 * The backend now uses `chat:<conversationId>` via REST-created conversations.
 * Keeping for reference until rewritten.
 *
 * Tests: connect, join, send, receive, typing, read receipts, delivery, presence
 */
import WebSocket from 'ws';

const WS_URL = process.env.WS_URL ?? 'ws://localhost:4000/ws/websocket';
const BUYER_TOKEN = process.env.BUYER_TOKEN ?? '';
const RIDER_TOKEN = process.env.RIDER_TOKEN ?? '';
const CONVERSATION_ID = process.env.CONVERSATION_ID ?? '';

function decodeToken(t: string) { return JSON.parse(Buffer.from(t.split('.')[1] + '==', 'base64url').toString()); }
const chatTopic = `chat:${CONVERSATION_ID}`;

const results: string[] = [];
function log(s: string) { results.push(s); console.log(s); }
function pass(name: string, detail = '') { log(`  PASS: ${name} ${detail}`); }
function fail(name: string, detail = '') { log(`  FAIL: ${name} ${detail}`); }

function connectWs(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}&vsn=2.0.0`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('Connect timeout')); }, 5000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function send(ws: WebSocket, frame: unknown[]) { ws.send(JSON.stringify(frame)); }

function waitFor(ws: WebSocket, match: (frame: any[]) => boolean, timeout = 5000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
    const h = (data: WebSocket.Data) => {
      try {
        const f = JSON.parse(data.toString());
        if (match(f)) { clearTimeout(timer); ws.removeListener('message', h); resolve(f); }
      } catch {}
    };
    ws.on('message', h);
  });
}

async function main() {
  const buyerClaims = decodeToken(BUYER_TOKEN);
  const riderClaims = decodeToken(RIDER_TOKEN);
  log(`\nConversation: ${CONVERSATION_ID}`);
  log(`Buyer: ${buyerClaims.email}`);
  log(`Rider: ${riderClaims.email}`);
  log(`Topic: ${chatTopic}`);

  // --- 1. Connect ---
  log('\n=== 1. Connect Both Users ===');
  let buyer: WebSocket, rider: WebSocket;
  [buyer, rider] = await Promise.all([connectWs(BUYER_TOKEN), connectWs(RIDER_TOKEN)]);
  pass('Both connected');
  // Wait a moment for WebSocket protocol handshake
  await new Promise(r => setTimeout(r, 500));

  if (!CONVERSATION_ID) {
    log('\n❌ CONVERSATION_ID env var required');
    process.exit(1);
  }

  // --- 2. Join conversation ---
  log('\n=== 2. Join Conversation ===');
  send(buyer, ['1', 'b1', chatTopic, 'phx_join', { conversation_id: CONVERSATION_ID }]);
  send(rider, ['2', 'r1', chatTopic, 'phx_join', { conversation_id: CONVERSATION_ID }]);

  let buyerConvId: string | null = null;
  let riderConvId: string | null = null;

  const [buyerResult, riderResult] = await Promise.allSettled([
    waitFor(buyer, (f: any[]) => f[3] === 'phx_reply' && f[1] === 'b1', 10000),
    waitFor(rider, (f: any[]) => f[3] === 'phx_reply' && f[1] === 'r1', 10000),
  ]);

  if (buyerResult.status === 'fulfilled' && buyerResult.value[4]?.status === 'ok') {
    buyerConvId = buyerResult.value[4]?.response?.conversation_id ?? null;
    pass('Buyer joined', `conv=${buyerConvId}`);
  } else {
    fail('Buyer join', buyerResult.status === 'rejected' ? 'timeout' : JSON.stringify(buyerResult.value?.[4]));
  }

  if (riderResult.status === 'fulfilled' && riderResult.value[4]?.status === 'ok') {
    riderConvId = riderResult.value[4]?.response?.conversation_id ?? null;
    pass('Rider joined', `conv=${riderConvId}`);
  } else {
    fail('Rider join', riderResult.status === 'rejected' ? 'timeout' : JSON.stringify(riderResult.value?.[4]));
  }

  if (!buyerConvId || !riderConvId) {
    log('\nWARN: One or both joins failed, but continuing with available connections');
  }

  // Wait for presence/delivery after join
  await new Promise(r => setTimeout(r, 500));

  // --- 3. Delivery receipts on join ---
  log('\n=== 3. Delivery Receipts on Join ===');
  const deliveryFrames: any[][] = [];
  const buyerMsgH = (data: WebSocket.Data) => {
    try {
      const f = JSON.parse(data.toString());
      if (f[3] === 'messages_delivered') deliveryFrames.push(f);
    } catch {}
  };
  buyer.on('message', buyerMsgH);
  await new Promise(r => setTimeout(r, 3000));
  buyer.removeListener('message', buyerMsgH);

  if (deliveryFrames.length > 0) {
    pass('Delivery receipt received', `by buyer (${deliveryFrames.length} frames)`);
  } else {
    fail('No delivery receipt received by buyer');
  }

  // --- 4. Presence ---
  log('\n=== 4. Presence ===');
  const presenceFrames: any[][] = [];
  const presenceH = (data: WebSocket.Data) => {
    try {
      const f = JSON.parse(data.toString());
      if (f[3] === 'presence_state' || f[3] === 'presence_diff') presenceFrames.push(f);
    } catch {}
  };
  [buyer, rider].forEach(w => w.on('message', presenceH));
  await new Promise(r => setTimeout(r, 2000));
  [buyer, rider].forEach(w => w.removeListener('message', presenceH));

  if (presenceFrames.length > 0) {
    const events = presenceFrames.map(f => f[3]);
    pass('Presence events received', `events: ${events.join(', ')}`);
  } else {
    log('  WARN: No presence events (may be timing)');
  }

  // --- 5. Send message (buyer -> rider) ---
  log('\n=== 5. Buyer -> Rider: Send Message ===');
  send(buyer, [null, 'b2', chatTopic, 'new_message', {
    body: 'Hey rider, how is the delivery?',
    message: 'Hey rider, how is the delivery?',
  }]);

  let buyerMsgId: string | null = null;
  try {
    const f = await waitFor(buyer, (f: any[]) => f[3] === 'phx_reply' && f[1] === 'b2', 10000);
    if (f[4]?.status === 'ok') {
      buyerMsgId = f[4]?.response?.id ?? null;
      pass('Buyer message sent', `id=${buyerMsgId}`);
    } else {
      fail('Buyer send', JSON.stringify(f[4]));
    }
  } catch {
    fail('Buyer send', 'timeout');
  }

  // --- 6. Rider receives message ---
  log('\n=== 6. Rider Receives Message ===');
  try {
    const f = await waitFor(rider, (f: any[]) => f[3] === 'new_message', 10000);
    const p = f[4] as any;
    if (p) {
      pass('Rider got message', `text="${p.content || p.text}" from=${p.sender_id}`);
    } else {
      fail('Rider receive - no payload');
    }
  } catch {
    fail('Rider receive', 'timeout');
  }

  // --- 7. Rider replies ---
  log('\n=== 7. Rider -> Buyer: Reply ===');
  send(rider, [null, 'r2', chatTopic, 'new_message', {
    body: 'On my way! ETA 15 mins',
    message: 'On my way! ETA 15 mins',
  }]);

  try {
    const f = await waitFor(rider, (f: any[]) => f[3] === 'phx_reply' && f[1] === 'r2', 10000);
    if (f[4]?.status === 'ok') {
      pass('Rider reply sent', `id=${f[4]?.response?.id}`);
    } else {
      fail('Rider reply', JSON.stringify(f[4]));
    }
  } catch {
    fail('Rider reply', 'timeout');
  }

  // --- 8. Buyer receives reply ---
  log('\n=== 8. Buyer Receives Reply ===');
  try {
    const f = await waitFor(buyer, (f: any[]) => f[3] === 'new_message', 10000);
    const p = f[4] as any;
    if (p) {
      pass('Buyer got reply', `text="${p.content || p.text}"`);
    } else {
      fail('Buyer receive - no payload');
    }
  } catch {
    fail('Buyer receive', 'timeout');
  }

  // --- 9. Typing ---
  log('\n=== 9. Typing Indicator ===');
  send(buyer, [null, null, chatTopic, 'typing', { is_typing: true }]);
  try {
    const f = await waitFor(rider, (f: any[]) => f[3] === 'typing', 5000);
    pass('Typing received by rider', `sender=${(f[4] as any)?.sender_id}`);
  } catch {
    fail('Typing not received by rider');
  }

  // --- 10. Mark read ---
  log('\n=== 10. Read Receipts ===');
  send(rider, [null, 'r3', chatTopic, 'mark_read', {}]);
  try {
    const f = await waitFor(buyer, (f: any[]) => f[3] === 'messages_read', 10000);
    const p = f[4] as any;
    pass('Read receipt received by buyer', `reader=${p?.reader_id}`);
  } catch {
    fail('Read receipt not received by buyer');
  }

  // --- 11. Get messages ---
  log('\n=== 11. Get Message History ===');
  send(buyer, [null, 'b4', chatTopic, 'get_messages', { limit: 10 }]);
  try {
    const f = await waitFor(buyer, (f: any[]) => f[3] === 'phx_reply' && f[1] === 'b4', 10000);
    const msgs = f[4]?.response?.messages ?? [];
    if (msgs.length >= 2) {
      pass('Got message history', `${msgs.length} messages`);
    } else {
      fail('Message history', `only ${msgs.length} messages`);
    }
  } catch {
    fail('Message history', 'timeout');
  }

  // --- Summary ---
  const passed = results.filter(r => r.includes('PASS:')).length;
  const failed = results.filter(r => r.includes('FAIL:')).length;
  log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);

  [buyer, rider].forEach(w => w.close());
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Crashed:', e); process.exit(1); });
