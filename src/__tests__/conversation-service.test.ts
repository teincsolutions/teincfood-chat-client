import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConversationService, formatConversationTime } from '../conversation-service.js';
import type { ChatClientConfig } from '../types.js';

const TEST_CONFIG: ChatClientConfig = {
  wsBaseUrl: '',
  apiBaseUrl: 'http://localhost:4000',
  getAccessToken: () => Promise.resolve('test-token'),
  storage: {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    getAllKeys: () => Promise.resolve([]),
  },
};

const MOCK_HEADERS = {
  'Content-Type': 'application/json',
  Authorization: 'Bearer test-token',
};

function mockFetch(data: unknown, status = 200) {
  return vi.mocked(global.fetch).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({ data }),
  } as Response);
}

describe('ConversationService', () => {
  let service: ConversationService;

  beforeEach(() => {
    vi.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response()),
    );
    service = new ConversationService(TEST_CONFIG);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createConversation', () => {
    it('creates a direct conversation', async () => {
      const conv = { id: 'conv-1', type: 'direct', status: 'active', inserted_at: '', updated_at: '' };
      mockFetch(conv);

      const result = await service.createConversation({ type: 'direct', otherUserId: 'user-2' });

      expect(result.id).toBe('conv-1');
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/conversations',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ type: 'direct', otherUserId: 'user-2' }),
        }),
      );
    });

    it('creates a business group conversation', async () => {
      const conv = { id: 'conv-2', type: 'business_group', businessId: 'biz-1', status: 'active', inserted_at: '', updated_at: '' };
      mockFetch(conv);

      const result = await service.createConversation({ type: 'business_group', businessId: 'biz-1' });

      expect(result.id).toBe('conv-2');
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/conversations',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ type: 'business_group', businessId: 'biz-1' }),
        }),
      );
    });

    it('creates a support conversation', async () => {
      const conv = { id: 'conv-3', type: 'support', status: 'active', inserted_at: '', updated_at: '' };
      mockFetch(conv);

      const result = await service.createConversation({ type: 'support' });

      expect(result.id).toBe('conv-3');
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/conversations',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ type: 'support' }),
        }),
      );
    });

    it('includes orderId when provided', async () => {
      const conv = { id: 'conv-4', type: 'direct', orderId: 'order-1', status: 'active', inserted_at: '', updated_at: '' };
      mockFetch(conv);

      await service.createConversation({ type: 'direct', otherUserId: 'user-2', orderId: 'order-1' });

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/conversations',
        expect.objectContaining({
          body: JSON.stringify({ type: 'direct', otherUserId: 'user-2', orderId: 'order-1' }),
        }),
      );
    });

    it('includes businessId when provided', async () => {
      mockFetch({ id: 'conv-5', type: 'business_group', businessId: 'biz-1', orderId: 'order-1', status: 'active', inserted_at: '', updated_at: '' });

      await service.createConversation({ type: 'business_group', businessId: 'biz-1', orderId: 'order-1' });

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/conversations',
        expect.objectContaining({
          body: JSON.stringify({ type: 'business_group', businessId: 'biz-1', orderId: 'order-1' }),
        }),
      );
    });

    it('throws on API error', async () => {
      mockFetch({ error: 'unauthorized' }, 401);

      await expect(
        service.createConversation({ type: 'support' }),
      ).rejects.toThrow('API error 401');
    });

    it('strips trailing slashes from apiBaseUrl', async () => {
      const svc = new ConversationService({
        ...TEST_CONFIG,
        apiBaseUrl: 'http://localhost:4000//',
      });
      mockFetch({ id: 'x', type: 'direct', status: 'active', inserted_at: '', updated_at: '' });

      await svc.createConversation({ type: 'direct', otherUserId: 'u1' });

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/conversations',
        expect.anything(),
      );
    });

    it('strips /api/v1 suffix from apiBaseUrl', async () => {
      const svc = new ConversationService({
        ...TEST_CONFIG,
        apiBaseUrl: 'http://localhost:4000/api/v1',
      });
      mockFetch({ id: 'x', type: 'direct', status: 'active', inserted_at: '', updated_at: '' });

      await svc.createConversation({ type: 'direct', otherUserId: 'u1' });

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/conversations',
        expect.anything(),
      );
    });
  });

  describe('getContacts', () => {
    it('returns contact list', async () => {
      const contacts = [
        { id: 'u1', fullName: 'Alice', avatarUrl: 'https://example.com/alice.jpg', phone: '+233501234567' },
        { id: 'u2', fullName: 'Bob' },
      ];
      mockFetch(contacts);

      const result = await service.getContacts();

      expect(result).toHaveLength(2);
      expect(result[0].fullName).toBe('Alice');
      expect(result[0].phone).toBe('+233501234567');
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/contacts',
        expect.anything(),
      );
    });

    it('returns empty array when no contacts', async () => {
      mockFetch([]);

      const result = await service.getContacts();

      expect(result).toEqual([]);
    });
  });

  describe('getConversations', () => {
    it('returns conversation list', async () => {
      const conversations = [
        { id: 'c1', type: 'direct', status: 'active', inserted_at: '', updated_at: '' },
        { id: 'c2', type: 'support', status: 'active', inserted_at: '', updated_at: '' },
      ];
      mockFetch(conversations);

      const result = await service.getConversations();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('c1');
      expect(result[1].type).toBe('support');
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/conversations',
        expect.anything(),
      );
    });
  });

  describe('getConversation', () => {
    it('returns a single conversation', async () => {
      const conv = { id: 'c1', type: 'direct', status: 'active', participants: [{ id: 'p1', user_id: 'u1' }], inserted_at: '', updated_at: '' };
      mockFetch(conv);

      const result = await service.getConversation('c1');

      expect(result.id).toBe('c1');
      expect(result.participants).toHaveLength(1);
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/conversations/c1',
        expect.anything(),
      );
    });
  });

  describe('getMessages', () => {
    it('fetches messages with default pagination', async () => {
      const rawMessages = [
        { id: 'm1', content: 'Hello', sender_id: 'u1', conversation_id: 'c1', channel: 'app', message_type: 'text', status: 'sent', sent_at: '2024-01-01T00:00:00Z' },
      ];
      mockFetch(rawMessages);

      const result = await service.getMessages('c1');

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('Hello');
      expect(result[0].senderId).toBe('u1');
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/conversations/c1/messages?limit=50&offset=0',
        expect.anything(),
      );
    });

    it('fetches messages with custom pagination', async () => {
      mockFetch([]);

      await service.getMessages('c1', 10, 20);

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/conversations/c1/messages?limit=20&offset=10',
        expect.anything(),
      );
    });
  });

  describe('getUser', () => {
    it('returns support user without API call', async () => {
      const result = await service.getUser('support');

      expect(result.fullName).toBe('TeincFood Support');
      expect(result.id).toBe('support');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('fetches regular user profile', async () => {
      const userData = { id: 'u1', full_name: 'Alice Wonderland', avatar_url: 'https://example.com/avatar.jpg', phone: '+233501234567' };
      mockFetch(userData);

      const result = await service.getUser('u1');

      expect(result.fullName).toBe('Alice Wonderland');
      expect(result.avatarUrl).toBe('https://example.com/avatar.jpg');
      expect(result.phone).toBe('+233501234567');
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/users/u1',
        expect.anything(),
      );
    });

    it('handles camelCase keys in user response', async () => {
      const userData = { id: 'u1', fullName: 'Bob', avatarUrl: null, phone: null };
      mockFetch(userData);

      const result = await service.getUser('u1');

      expect(result.fullName).toBe('Bob');
    });
  });

  describe('getInboxConversations', () => {
    it('maps raw conversations to inbox format', async () => {
      const raw = [
        {
          id: 'c1',
          type: 'support',
          participants: [],
          messages: [{ id: 'm1', content: 'Need help', sender_id: 'u1', inserted_at: '2024-01-01T12:00:00Z' }],
          unread_count: 2,
          updated_at: '2024-01-01T12:00:00Z',
        },
      ];
      mockFetch(raw);

      const result = await service.getInboxConversations('current-user');

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('TeincFood Support');
      expect(result[0].lastMessage).toBe('Need help');
      expect(result[0].unreadCount).toBe(2);
      expect(result[0].type).toBe('support');
    });

    it('truncates long messages', async () => {
      const longText = 'a'.repeat(100);
      const raw = [{
        id: 'c1',
        type: 'direct',
        participants: [{ id: 'p1', user_id: 'other-user' }],
        messages: [{ id: 'm1', content: longText, sender_id: 'other-user', inserted_at: '2024-01-01T12:00:00Z' }],
        unread_count: 0,
        updated_at: '2024-01-01T12:00:00Z',
      }];
      mockFetch(raw);

      const result = await service.getInboxConversations('current-user');

      expect(result[0].lastMessage.length).toBe(83);
      expect(result[0].lastMessage.endsWith('...')).toBe(true);
      expect(result[0].participantUserId).toBe('other-user');
    });

    it('handles empty conversations', async () => {
      mockFetch([]);

      const result = await service.getInboxConversations('current-user');

      expect(result).toEqual([]);
    });
  });

  describe('conversation management', () => {
    it('archives a conversation', async () => {
      mockFetch({ success: true });

      await service.archiveConversation('c1');

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/conversations/c1/archive',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    it('closes a conversation', async () => {
      mockFetch({ success: true });

      await service.closeConversation('c1');

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/conversations/c1/close',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    it('assigns a conversation', async () => {
      const conv = { id: 'c1', type: 'support', status: 'active', assignedAgentId: 'agent-1', inserted_at: '', updated_at: '' };
      mockFetch(conv);

      const result = await service.assignConversation('c1', 'agent-1');

      expect(result.assignedAgentId).toBe('agent-1');
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/conversations/c1/assign',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ agent_id: 'agent-1' }),
        }),
      );
    });

    it('marks conversation read', async () => {
      mockFetch({ success: true });

      await service.markConversationRead('c1');

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/conversations/c1/read',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    it('checks if conversation is complete', () => {
      expect(service.isComplete({ id: 'c1', type: 'direct', status: 'closed', inserted_at: '', updated_at: '' })).toBe(true);
      expect(service.isComplete({ id: 'c2', type: 'direct', status: 'active', inserted_at: '', updated_at: '' })).toBe(false);
    });
  });

  describe('notifications', () => {
    it('marks notification read', async () => {
      mockFetch({ success: true });

      await service.markNotificationRead('n1');

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/notifications/n1/read',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    it('marks all notifications read', async () => {
      mockFetch({ success: true });

      await service.markAllNotificationsRead();

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:4000/api/v1/notifications/read-all',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
  });
});

describe('formatConversationTime', () => {
  it('formats a valid timestamp', () => {
    const result = formatConversationTime('2024-01-01T12:30:00Z');
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('returns empty string for undefined', () => {
    expect(formatConversationTime(undefined)).toBe('');
  });

  it('returns empty string for invalid date', () => {
    expect(formatConversationTime('not-a-date')).toBe('');
  });
});
