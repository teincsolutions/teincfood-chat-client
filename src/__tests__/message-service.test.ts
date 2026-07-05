import { describe, it, expect } from 'vitest';
import { generateLocalId, normalizeMessagePayload } from '../message-service.js';
import type { Message } from '../types.js';

describe('generateLocalId', () => {
  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateLocalId()));
    expect(ids.size).toBe(100);
  });

  it('starts with msg_ prefix', () => {
    expect(generateLocalId()).toMatch(/^msg_/);
  });
});

describe('normalizeMessagePayload', () => {
  it('handles full payload', () => {
    const result = normalizeMessagePayload(
      {
        id: 'server-1',
        sender_id: 'user-1',
        content: 'hello',
        conversation_id: 'conv-1',
        channel: 'app',
        message_type: 'text',
        status: 'sent',
        sent_at: '2024-01-01T00:00:00Z',
      },
      'conv-default',
    );
    expect(result.id).toBe('server-1');
    expect(result.senderId).toBe('user-1');
    expect(result.text).toBe('hello');
    expect(result.conversationId).toBe('conv-1');
    expect(result.status).toBe('sent');
  });

  it('falls back to user_id for senderId', () => {
    const result = normalizeMessagePayload(
      { user_id: 'user-2', content: 'hi' },
      'conv-2',
    );
    expect(result.senderId).toBe('user-2');
  });

  it('falls back to inserted_at for sentAt', () => {
    const result = normalizeMessagePayload(
      { inserted_at: '2024-06-01T00:00:00Z', content: 'hi' },
      'conv-3',
    );
    expect(result.sentAt).toBe('2024-06-01T00:00:00Z');
  });

  it('provides defaults for missing fields', () => {
    const result = normalizeMessagePayload({}, 'conv-4');
    expect(result.channel).toBe('app');
    expect(result.status).toBe('delivered');
    expect(result.senderId).toBe('');
    expect(result.text).toBe('');
  });
});
