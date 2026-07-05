import { describe, it, expect, beforeEach } from 'vitest';
import { ChatStore } from '../store/store.js';
import { createInMemoryStorage } from '../store/storage.js';
import type { Message, OutboundMessage } from '../types.js';

function makeMsg(overrides: Partial<Message> = {}): Message {
  const id = overrides.id ?? `msg_${Date.now()}`;
  return {
    id,
    localId: overrides.localId ?? id,
    conversationId: overrides.conversationId ?? 'conv-1',
    senderId: overrides.senderId ?? 'user-1',
    text: overrides.text ?? 'hello',
    status: overrides.status ?? 'sent',
    channel: 'app',
    messageType: 'text',
    sentAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ChatStore', () => {
  let store: ChatStore;

  beforeEach(async () => {
    store = new ChatStore(createInMemoryStorage());
    await store.load();
  });

  describe('messages', () => {
    it('stores and retrieves messages', async () => {
      const msg = makeMsg();
      await store.upsertMessage('conv-1', msg);
      const msgs = await store.getMessages('conv-1');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].id).toBe(msg.id);
    });

    it('upserts by localId', async () => {
      const msg = makeMsg({ localId: 'local-1', text: 'first' });
      await store.upsertMessage('conv-1', msg);
      const updated = makeMsg({ localId: 'local-1', text: 'updated' });
      await store.upsertMessage('conv-1', updated);
      const msgs = await store.getMessages('conv-1');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].text).toBe('updated');
    });

    it('adds multiple messages without duplicates', async () => {
      const msg1 = makeMsg({ id: 'a' });
      const msg2 = makeMsg({ id: 'b' });
      const msg3 = makeMsg({ id: 'a' });
      await store.upsertMessage('conv-1', msg1);
      await store.addMessages('conv-1', [msg2, msg3]);
      const msgs = await store.getMessages('conv-1');
      expect(msgs).toHaveLength(2);
    });

    it('updates message status', async () => {
      const msg = makeMsg({ localId: 'local-1', status: 'sending' });
      await store.upsertMessage('conv-1', msg);
      await store.updateMessageStatus('conv-1', 'local-1', 'sent', 'server-1');
      const msgs = await store.getMessages('conv-1');
      expect(msgs[0].status).toBe('sent');
      expect(msgs[0].id).toBe('server-1');
    });

    it('clears conversation', async () => {
      await store.upsertMessage('conv-1', makeMsg());
      await store.clearConversation('conv-1');
      const msgs = await store.getMessages('conv-1');
      expect(msgs).toHaveLength(0);
    });
  });

  describe('outbox', () => {
    it('manages outbox entries', async () => {
      const out: OutboundMessage = {
        id: 'out-1',
        topic: 'chat:pair:order_1_a_b',
        conversationId: 'conv-1',
        text: 'hello',
        status: 'queued',
        queuedAt: Date.now(),
      };
      await store.addToOutbox(out);
      const pending = store.getPendingOutbox();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('out-1');

      await store.updateOutboxStatus('out-1', 'sent');
      const empty = store.getPendingOutbox();
      expect(empty).toHaveLength(0);
    });
  });

  describe('topic cache', () => {
    it('caches conversation ID by topic', async () => {
      expect(store.getConversationId('chat:pair:order_1_a_b')).toBeUndefined();
      await store.cacheConversationId('chat:pair:order_1_a_b', 'conv-uuid');
      expect(store.getConversationId('chat:pair:order_1_a_b')).toBe('conv-uuid');
    });
  });

  describe('persistence', () => {
    it('persists outbox across instances with shared storage', async () => {
      const sharedStorage = createInMemoryStorage();
      const s1 = new ChatStore(sharedStorage);
      await s1.load();

      const out: OutboundMessage = {
        id: 'out-1',
        topic: 'topic',
        conversationId: 'conv-1',
        text: 'test',
        status: 'queued',
        queuedAt: Date.now(),
      };
      await s1.addToOutbox(out);

      const s2 = new ChatStore(sharedStorage);
      await s2.load();
      const pending = s2.getPendingOutbox();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('out-1');
    });
  });
});
