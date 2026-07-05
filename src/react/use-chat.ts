import { useEffect, useState, useCallback, useRef } from 'react';
import type { ChatClientConfig, Message, ConnectionState, SendResult, TypingData, OutboundMessage, JoinResult, ChatMessagePayload } from '../types.js';
import { ChatClient } from '../chat-client.js';
import { getChatTopic } from '../topics.js';

export interface UseChatOptions {
  conversationId: string;
}

export interface UserProfile {
  id: string;
  fullName: string;
  avatarUrl?: string;
  phone?: string;
}

export interface UseChatReturn {
  client: ChatClient;
  currentUserId?: string;
  chatTopic: string;
  conversationId: string;
  user: UserProfile | null;
  initialMessages: ChatMessagePayload[];
  storedMessages: Message[];
  sendMessage: (text: string, metadata?: Record<string, unknown>) => Promise<SendResult>;
  setTyping: (isTyping: boolean) => void;
  isTyping: boolean;
  isReady: boolean;
  connectionState: ConnectionState;
  loadOlderMessages: () => Promise<Message[]>;
  loadingOlder: boolean;
  getOutbox: () => OutboundMessage[];
  joinResult: JoinResult | null;
  markRead: () => void;
  otherUserTyping: boolean;
}

const CLIENT_KEY = '__teincfood_chat_client__';

function getGlobalClient(): ChatClient | undefined {
  return (globalThis as Record<string, unknown>)[CLIENT_KEY] as ChatClient | undefined;
}

function setGlobalClient(client: ChatClient): void {
  (globalThis as Record<string, unknown>)[CLIENT_KEY] = client;
}

export function useChat(config: ChatClientConfig, options: UseChatOptions): UseChatReturn {
  const { conversationId } = options;

  const clientRef = useRef<ChatClient | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [isReady, setIsReady] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [joinResult, setJoinResult] = useState<JoinResult | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [otherUserTyping, setOtherUserTyping] = useState(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [storedMessages, setStoredMessages] = useState<Message[]>([]);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [initialMessages, setInitialMessages] = useState<ChatMessagePayload[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const chatTopic = getChatTopic(conversationId);

  // ── Client init ──────────────────────────────────────────────────────────

  useEffect(() => {
    let client = getGlobalClient();
    if (!client) {
      client = new ChatClient(config);
      setGlobalClient(client);
    }
    clientRef.current = client;

    return () => {
      clientRef.current = null;
    };
  }, [config.wsBaseUrl, config.apiBaseUrl]);

  // ── WebSocket connection ─────────────────────────────────────────────────

  useEffect(() => {
    const client = clientRef.current ?? getGlobalClient();
    if (!client) return;

    client.connect().catch(() => {});

    const unsub = client.on('connection', (state: unknown) => {
      setConnectionState(state as ConnectionState);
    });

    return () => {
      unsub();
    };
  }, []);

  // ── Join channel ─────────────────────────────────────────────────────────

  useEffect(() => {
    const client = clientRef.current ?? getGlobalClient();
    if (!client) return;

    let cancelled = false;

    (async () => {
      try {
        const result = await client.joinConversation(conversationId);
        if (cancelled) return;
        setJoinResult(result);
        setIsReady(true);
      } catch (e) {
        console.error('[Chat] Channel join failed:', conversationId, e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // ── Subscribe to events that trigger message refresh ─────────────────────

  useEffect(() => {
    const client = clientRef.current ?? getGlobalClient();
    if (!client) return;

    const refresh = () => setRefreshKey((k: number) => k + 1);

    const unsubMessage = client.on('message', refresh);
    const unsubConnection = client.on('connection', () => refresh());
    const unsubJoin = client.on('join', refresh);

    return () => {
      unsubMessage();
      unsubConnection();
      unsubJoin();
    };
  }, []);

  // ── Load messages from store ─────────────────────────────────────────────

  useEffect(() => {
    const client = clientRef.current ?? getGlobalClient();
    if (!client) return;

    client.getStoredMessagesFallback(chatTopic, conversationId).then((msgs: Message[]) => {
      setStoredMessages(msgs);
    });
  }, [conversationId, chatTopic, refreshKey]);

  // ── Fetch initial messages from REST ─────────────────────────────────────

  useEffect(() => {
    const client = clientRef.current ?? getGlobalClient();
    if (!client) return;

    client.rest.fetchMessages(conversationId, 0, 50).then(setInitialMessages).catch((e: unknown) => {
      console.error('[Chat] Failed to fetch initial messages:', conversationId, e);
    });
  }, [conversationId]);

  // ── Send message ────────────────────────────────────────────────────────

  const sendMessage = useCallback(
    async (text: string, metadata?: Record<string, unknown>): Promise<SendResult> => {
      const client = clientRef.current ?? getGlobalClient();
      if (!client || !chatTopic) {
        return { localId: '', status: 'failed' };
      }
      const result = await client.sendMessage(chatTopic, text, metadata ? { metadata } : undefined);
      setRefreshKey((k: number) => k + 1);
      return result;
    },
    [chatTopic],
  );

  // ── Typing ──────────────────────────────────────────────────────────────

  const setTyping = useCallback(
    (typing: boolean) => {
      const client = clientRef.current ?? getGlobalClient();
      if (!client || !chatTopic) return;
      client.sendTyping(chatTopic, typing);
    },
    [chatTopic],
  );

  useEffect(() => {
    const client = clientRef.current ?? getGlobalClient();
    if (!client) return;

    const unsub = client.on('typing', (data: unknown) => {
      const td = data as TypingData;
      setIsTyping(td.isTyping);
      setOtherUserTyping(td.isTyping);
      if (td.isTyping) {
        if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
        typingTimerRef.current = setTimeout(() => {
          setIsTyping(false);
          setOtherUserTyping(false);
        }, 3000);
      }
    });

    return () => {
      unsub();
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, []);

  // ── Load older messages ──────────────────────────────────────────────────

  const loadOlderMessages = useCallback(async (): Promise<Message[]> => {
    const client = clientRef.current ?? getGlobalClient();
    if (!client || !chatTopic || loadingOlder) return [];

    setLoadingOlder(true);
    try {
      const offset = storedMessages.length;
      const older = await client.loadHistory(chatTopic, 50, offset);
      if (older.length > 0) {
        setStoredMessages((prev: Message[]) => {
          const ids = new Set(prev.map((m: Message) => m.id));
          const newMsgs = older.filter((m: Message) => !ids.has(m.id));
          return [...newMsgs, ...prev];
        });
      }
      return older;
    } finally {
      setLoadingOlder(false);
    }
  }, [chatTopic, loadingOlder, storedMessages.length]);

  const getOutbox = useCallback((): OutboundMessage[] => {
    const client = clientRef.current ?? getGlobalClient();
    return client?.getPendingOutbox() ?? [];
  }, []);

  const markRead = useCallback(() => {
    const client = clientRef.current ?? getGlobalClient();
    if (!client || !chatTopic) return;
    client.markRead(chatTopic);
  }, [chatTopic]);

  return {
    client: clientRef.current ?? getGlobalClient()!,
    chatTopic,
    conversationId,
    user,
    initialMessages,
    storedMessages,
    sendMessage,
    setTyping,
    isTyping,
    isReady: isReady && connectionState === 'connected',
    connectionState,
    loadOlderMessages,
    loadingOlder,
    getOutbox,
    joinResult,
    markRead,
    otherUserTyping,
  };
}
