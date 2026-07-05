import type { Conversation, Message, RawMessagePayload, ChatClientConfig, InboxConversation, ChatMessagePayload, CreateConversationParams, Contact } from './types.js';
import { MESSAGE_PAGE_SIZE } from './types.js';
import { normalizeMessagePayload } from './message-service.js';

export class ConversationService {
  private apiBaseUrl: string;
  private getAccessToken: () => Promise<string>;

  constructor(config: ChatClientConfig) {
    this.apiBaseUrl = config.apiBaseUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
    this.getAccessToken = config.getAccessToken;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const token = await this.getAccessToken();
    const url = `${this.apiBaseUrl}/api/v1${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers as Record<string, string>),
    };

    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      throw new Error(
        `API error ${response.status}: ${response.statusText} for ${path}`,
      );
    }

    const body = await response.json();
    return body.data as T;
  }

  async getConversations(): Promise<Conversation[]> {
    return this.request<Conversation[]>('/conversations');
  }

  async getConversation(id: string): Promise<Conversation> {
    return this.request<Conversation>(`/conversations/${id}`);
  }

  async getMessages(
    conversationId: string,
    offset = 0,
    limit = MESSAGE_PAGE_SIZE,
  ): Promise<Message[]> {
    const raw = await this.request<RawMessagePayload[]>(
      `/conversations/${conversationId}/messages?limit=${limit}&offset=${offset}`,
    );
    return raw.map((r) => normalizeMessagePayload(r as Record<string, unknown>, conversationId));
  }

  async createSupportConversation(): Promise<Conversation> {
    return this.request<Conversation>('/conversations/support', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async createConversation(params: CreateConversationParams): Promise<Conversation> {
    return this.request<Conversation>('/conversations', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getContacts(): Promise<Contact[]> {
    return this.request<Contact[]>('/contacts');
  }

  async assignConversation(
    conversationId: string,
    agentId: string,
  ): Promise<Conversation> {
    return this.request<Conversation>(`/conversations/${conversationId}/assign`, {
      method: 'PATCH',
      body: JSON.stringify({ agent_id: agentId }),
    });
  }

  async closeConversation(conversationId: string): Promise<void> {
    await this.request(`/conversations/${conversationId}/close`, {
      method: 'PATCH',
    });
  }

  isComplete(conversation: Conversation): boolean {
    return conversation.status === 'closed';
  }

  async archiveConversation(conversationId: string): Promise<void> {
    await this.request(`/conversations/${conversationId}/archive`, {
      method: 'PATCH',
    });
  }

  async markConversationRead(conversationId: string): Promise<void> {
    await this.request(`/conversations/${conversationId}/read`, {
      method: 'PATCH',
    });
  }

  async markNotificationRead(notificationId: string): Promise<void> {
    await this.request(`/notifications/${notificationId}/read`, {
      method: 'PATCH',
    });
  }

  async markAllNotificationsRead(): Promise<void> {
    await this.request('/notifications/read-all', {
      method: 'PATCH',
    });
  }

  // ── Inbox ──────────────────────────────────────

  async getInboxConversations(currentUserId?: string): Promise<InboxConversation[]> {
    const raw = await this.request<any[]>('/conversations');
    return raw.map((c: Record<string, unknown>) => {
      const participants = c.participants as Array<Record<string, unknown>> | undefined;
      const messages = c.messages as Array<Record<string, unknown>> | undefined;
      const lastMsg = messages?.[0];
      const otherParticipant = participants?.find(
        (p: Record<string, unknown>) => p.user_id !== currentUserId,
      );
      return {
        id: String(c.id ?? ''),
        name: c.type === 'support' ? 'TeincFood Support' : 'Conversation',
        avatar: undefined,
        lastMessage: lastMsg?.content
          ? String(lastMsg.content).length > 80
            ? String(lastMsg.content).slice(0, 80) + '...'
            : String(lastMsg.content)
          : c.type === 'support'
            ? 'Talk to our support team'
            : 'No messages yet',
        unreadCount: (c.unread_count as number) ?? 0,
        time: formatConversationTime(c.updated_at as string | undefined),
        type: c.type as string | undefined,
        participantUserId: otherParticipant?.user_id as string | undefined,
        orderId: c.order_id as string | undefined,
      };
    });
  }

  // ── User profile ────────────────────────────────

  async getUser(userId: string): Promise<{ id: string; fullName: string; avatarUrl?: string; phone?: string }> {
    if (userId === 'support') {
      return { id: 'support', fullName: 'TeincFood Support', avatarUrl: undefined, phone: undefined };
    }
    const res = await this.request<Record<string, unknown>>(`/users/${userId}`);
    return {
      id: String(res.id ?? ''),
      fullName: String(res.full_name ?? res.fullName ?? ''),
      avatarUrl: (res.avatar_url ?? res.avatarUrl) as string | undefined,
      phone: res.phone as string | undefined,
    };
  }

  // ── Messages ────────────────────────────────────

  async fetchMessages(conversationId: string, offset = 0, limit = MESSAGE_PAGE_SIZE): Promise<ChatMessagePayload[]> {
    const raw = await this.request<Record<string, unknown>[]>(
      `/conversations/${conversationId}/messages?limit=${limit}&offset=${offset}`,
    );
    return raw.map((item: Record<string, unknown>) => {
      const text = String(item.content ?? item.text ?? '');
      const insertedAt = String(item.inserted_at ?? item.sent_at ?? new Date().toISOString());
      return {
        id: String(item.id ?? ''),
        sender_id: String(item.sender_id ?? item.user_id ?? ''),
        text,
        content: text,
        conversation_id: String(item.conversation_id ?? ''),
        direction: item.direction as ChatMessagePayload['direction'],
        channel: item.channel as ChatMessagePayload['channel'],
        message_type: item.message_type as string | undefined,
        status: item.status as string | undefined,
        sent_at: String(item.sent_at ?? insertedAt),
        inserted_at: insertedAt,
      };
    });
  }
}

export function formatConversationTime(timestamp?: string) {
  if (!timestamp) return '';
  try {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}
