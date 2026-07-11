/**
 * Unit tests for the chat client library.
 *
 * Tests store mutations, events channel handling, auto-mark-read,
 * and push notification handling without a live server.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Message, Conversation, ChatStorage } from "./types"
import { ChatStore } from "./store"
import { TypedEventEmitter } from "./events"
import { OptimisticEngine } from "./optimistic"
import { PhoenixChatSocket, toMessage, toConversation } from "./socket"
import { ChatClient } from "./client"

// ─── Mock storage ──────────────────────────────────────────

class MapStorage implements ChatStorage {
  private map = new Map<string, string>()
  async getItem<T>(key: string): Promise<T | null> {
    const v = this.map.get(key)
    return v ? (JSON.parse(v) as T) : null
  }
  async setItem<T>(key: string, value: T): Promise<void> {
    this.map.set(key, JSON.stringify(value))
  }
  async removeItem(key: string): Promise<void> {
    this.map.delete(key)
  }
  async clear(): Promise<void> {
    this.map.clear()
  }
}

// ─── Helpers ───────────────────────────────────────────────

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    content: "Hello",
    sender_id: "user-a",
    conversation_id: "conv-1",
    direction: "inbound",
    channel: "app",
    message_type: "text",
    status: "sent",
    external_id: null,
    metadata: null,
    replied_by_id: null,
    read: false,
    sent_at: "2026-01-01T00:00:00Z",
    inserted_at: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function makeConv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv-1",
    status: "active",
    order_id: null,
    business_id: null,
    business: null,
    participants: [],
    messages: [],
    inserted_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

// ─── Store tests ───────────────────────────────────────────

describe("ChatStore", () => {
  let store: ChatStore

  beforeEach(() => {
    store = new ChatStore(new MapStorage())
  })

  it("upsertConversation adds a new conversation", () => {
    const conv = makeConv()
    store.upsertConversation(conv)
    expect(store.getConversation("conv-1")).toBeDefined()
    expect(store.getConversations()).toHaveLength(1)
  })

  it("upsertConversation updates an existing conversation", () => {
    const conv = makeConv({ status: "active" })
    store.upsertConversation(conv)
    const updated = makeConv({ status: "closed" })
    store.upsertConversation(updated)
    expect(store.getConversation("conv-1")?.status).toBe("closed")
  })

  it("markConversationRead marks messages as read for non-reader", () => {
    const msg = makeMsg({ sender_id: "user-a", status: "sent", read: false })
    store.upsertMessage("conv-1", msg)
    store.markConversationRead("conv-1", "user-b")
    const msgs = store.getMessages("conv-1")
    expect(msgs[0].read).toBe(true)
    expect(msgs[0].status).toBe("read")
  })

  it("markConversationRead does not modify sender's own messages", () => {
    const msg = makeMsg({ sender_id: "user-a", status: "sent", read: false })
    store.upsertMessage("conv-1", msg)
    store.markConversationRead("conv-1", "user-a")
    const msgs = store.getMessages("conv-1")
    expect(msgs[0].read).toBe(false)
    expect(msgs[0].status).toBe("sent")
  })

  it("setUnreadCount sets unread_count on an existing conversation", () => {
    const conv = makeConv()
    store.upsertConversation(conv)
    store.setUnreadCount("conv-1", 5)
    expect((store.getConversation("conv-1") as any).unread_count).toBe(5)
  })

  it("removeConversation removes conversation and its messages", () => {
    store.upsertConversation(makeConv())
    store.upsertMessage("conv-1", makeMsg())
    store.removeConversation("conv-1")
    expect(store.getConversation("conv-1")).toBeUndefined()
    expect(store.getMessages("conv-1")).toHaveLength(0)
  })
})

// ─── Events channel unit tests ─────────────────────────────

describe("PhoenixChatSocket — events channel", () => {
  const WS_URL = "ws://localhost:4000/ws"
  let emitter: TypedEventEmitter
  let optimistic: OptimisticEngine
  let store: ChatStore
  let socket: PhoenixChatSocket

  beforeEach(() => {
    emitter = new TypedEventEmitter()
    store = new ChatStore(new MapStorage())
    optimistic = new OptimisticEngine(emitter)
    socket = new PhoenixChatSocket(WS_URL, emitter, optimistic, store)
  })

  it("has no last sequence initially", () => {
    expect(socket.getLastSequence()).toBe(0)
  })

  it("setLastSequence updates the tracked sequence", () => {
    socket.setLastSequence(42)
    expect(socket.getLastSequence()).toBe(42)
  })

  it("setLastSequence does not decrease sequence", () => {
    socket.setLastSequence(42)
    socket.setLastSequence(10)
    expect(socket.getLastSequence()).toBe(42)
  })

  it("isEventsJoined returns false before joining", () => {
    expect(socket.isEventsJoined()).toBe(false)
  })

  it("leaveEventsChannel is safe when not joined", () => {
    expect(() => socket.leaveEventsChannel()).not.toThrow()
  })

  it("toMessage parses a raw message payload", () => {
    const raw = {
      id: "m1",
      content: "test",
      sender_id: "u1",
      conversation_id: "c1",
      direction: "inbound",
      channel: "app",
      message_type: "text",
      status: "sent",
      external_id: null,
      metadata: null,
      replied_by_id: null,
      read: false,
      sent_at: "2026-01-01T00:00:00Z",
      inserted_at: "2026-01-01T00:00:00Z",
    }
    const msg = toMessage(raw)
    expect(msg.id).toBe("m1")
    expect(msg.content).toBe("test")
    expect(msg.sender_id).toBe("u1")
  })

  it("toConversation parses a raw conversation payload", () => {
    const raw = {
      id: "c1",
      status: "active",
      order_id: null,
      business_id: null,
      business: null,
      participants: [],
      messages: [],
      inserted_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    }
    const conv = toConversation(raw)
    expect(conv.id).toBe("c1")
    expect(conv.status).toBe("active")
  })
})

// ─── handlePushPayload tests ───────────────────────────────

describe("ChatClient — handlePushPayload", () => {
  let client: ChatClient

  beforeEach(() => {
    client = new ChatClient({
      baseUrl: "http://localhost:4000/api/v1",
      wsUrl: "ws://localhost:4000/ws",
      storage: new MapStorage(),
    })
    client.setCurrentUserId("user-1")
  })

  it("returns handled:false for unknown event type", () => {
    const result = client.handlePushPayload({ event: "unknown_event" })
    expect(result.handled).toBe(false)
  })

  it("returns handled:false for payload without event field", () => {
    const result = client.handlePushPayload({ foo: "bar" })
    expect(result.handled).toBe(false)
  })

  it("handles new_message event and emits message:received", () => {
    const events: string[] = []
    client.on("message:received", () => events.push("message:received"))

    const result = client.handlePushPayload({
      event: "new_message",
      message: {
        id: "m1",
        content: "push test",
        sender_id: "u2",
        conversation_id: "conv-1",
        direction: "inbound",
        channel: "app",
        message_type: "text",
        status: "sent",
        external_id: null,
        metadata: null,
        replied_by_id: null,
        read: false,
        sent_at: "2026-01-01T00:00:00Z",
        inserted_at: "2026-01-01T00:00:00Z",
      },
      _sequence: 1,
    })

    expect(result.handled).toBe(true)
    expect(result.event).toBe("message:received")
    expect(result.sequence).toBe(1)
    expect(events).toContain("message:received")
    expect(client.store.getMessages("conv-1")).toHaveLength(1)
  })

  it("handles conversation:created event", () => {
    const events: string[] = []
    client.on("conversation:created", () => events.push("conversation:created"))

    const result = client.handlePushPayload({
      event: "conversation:created",
      conversation: makeConv(),
    })

    expect(result.handled).toBe(true)
    expect(result.event).toBe("conversation:created")
    expect(events).toContain("conversation:created")
    expect(client.store.getConversation("conv-1")).toBeDefined()
  })

  it("handles conversation:updated event", () => {
    const events: string[] = []
    client.on("conversation:updated", () => events.push("conversation:updated"))

    const result = client.handlePushPayload({
      event: "conversation:updated",
      conversation: makeConv({ status: "closed" }),
    })

    expect(result.handled).toBe(true)
    expect(result.event).toBe("conversation:updated")
    expect(events).toContain("conversation:updated")
    expect(client.store.getConversation("conv-1")?.status).toBe("closed")
  })

  it("handles messages_read event", () => {
    // First add a message
    client.store.upsertMessage("conv-1", makeMsg({ sender_id: "u2" }))
    const events: string[] = []
    client.on("messages_read", () => events.push("messages_read"))

    const result = client.handlePushPayload({
      event: "messages_read",
      conversation_id: "conv-1",
      reader_id: "user-1",
      read_at: "2026-01-01T00:01:00Z",
    })

    expect(result.handled).toBe(true)
    expect(result.event).toBe("messages_read")
    expect(events).toContain("messages_read")
    const msgs = client.store.getMessages("conv-1")
    expect(msgs[0].read).toBe(true)
  })

  it("handles unread_count event", () => {
    client.store.upsertConversation(makeConv())
    const events: string[] = []
    client.on("unread_count", () => events.push("unread_count"))

    const result = client.handlePushPayload({
      event: "unread_count",
      conversation_id: "conv-1",
      unread_count: 3,
    })

    expect(result.handled).toBe(true)
    expect(result.event).toBe("unread_count")
    expect(events).toContain("unread_count")
  })

  it("handles messages_delivered event", () => {
    const events: string[] = []
    client.on("messages_delivered", () => events.push("messages_delivered"))

    const result = client.handlePushPayload({
      event: "messages_delivered",
      conversation_id: "conv-1",
      user_id: "u2",
    })

    expect(result.handled).toBe(true)
    expect(result.event).toBe("messages_delivered")
    expect(events).toContain("messages_delivered")
  })

  it("tracks sequence number on socket", () => {
    const spy = vi.spyOn((client as any).socket, "setLastSequence")

    const result = client.handlePushPayload({
      event: "new_message",
      message: makeMsg(),
      _sequence: 42,
    })

    expect(spy).toHaveBeenCalledWith(42)
    expect(result.sequence).toBe(42)
  })
})

// ─── OptimisticEngine unit tests ───────────────────────────

describe("OptimisticEngine", () => {
  let emitter: TypedEventEmitter
  let optimistic: OptimisticEngine

  beforeEach(() => {
    emitter = new TypedEventEmitter()
    optimistic = new OptimisticEngine(emitter)
  })

  it("creates an optimistic message with a client ID", () => {
    const temp = optimistic.create("conv-1", "user-a", "Hello")
    expect(temp._clientId).toBeTruthy()
    expect(temp.content).toBe("Hello")
    expect(temp.status).toBe("sending")
    expect(temp.conversation_id).toBe("conv-1")
  })

  it("sets status to sending for initial creation", () => {
    const temp = optimistic.create("conv-1", "user-a", "Hi")
    expect(temp.status).toBe("sending")
  })

  it("getPending returns messages for a conversation", () => {
    optimistic.create("conv-1", "user-a", "Msg 1")
    optimistic.create("conv-1", "user-a", "Msg 2")
    expect(optimistic.getPending("conv-1")).toHaveLength(2)
    expect(optimistic.getPending("conv-2")).toHaveLength(0)
  })

  it("reconcile matches by content and conversation within 10s window", () => {
    const temp = optimistic.create("conv-1", "user-a", "Match me")
    const serverMsg: Message = {
      id: "server-1",
      content: "Match me",
      sender_id: "user-a",
      conversation_id: "conv-1",
      direction: "outbound",
      channel: "app",
      message_type: "text",
      status: "sent",
      external_id: null,
      metadata: null,
      replied_by_id: null,
      read: false,
      sent_at: new Date().toISOString(),
      inserted_at: new Date().toISOString(),
    }
    const clientId = optimistic.reconcile(serverMsg)
    expect(clientId).toBe(temp._clientId)
    expect(optimistic.getPending("conv-1")).toHaveLength(0)
  })

  it("reconcile returns null for non-matching messages", () => {
    optimistic.create("conv-1", "user-a", "Original")
    const serverMsg: Message = {
      id: "server-1",
      content: "Different content",
      sender_id: "user-a",
      conversation_id: "conv-1",
      direction: "outbound",
      channel: "app",
      message_type: "text",
      status: "sent",
      external_id: null,
      metadata: null,
      replied_by_id: null,
      read: false,
      sent_at: new Date().toISOString(),
      inserted_at: new Date().toISOString(),
    }
    const clientId = optimistic.reconcile(serverMsg)
    expect(clientId).toBeNull()
    expect(optimistic.getPending("conv-1")).toHaveLength(1)
  })
})

// ─── TypedEventEmitter tests ───────────────────────────────

describe("TypedEventEmitter", () => {
  let emitter: TypedEventEmitter

  beforeEach(() => {
    emitter = new TypedEventEmitter()
  })

  it("on registers a listener and returns an unsubscribe function", () => {
    const fn = vi.fn()
    const unsub = emitter.on("message:received" as any, fn)
    expect(unsub).toBeTypeOf("function")
  })

  it("emit invokes registered listeners", () => {
    const fn = vi.fn()
    emitter.on("message:received" as any, fn)
    emitter.emit("message:received" as any, { id: "m1" })
    expect(fn).toHaveBeenCalledWith({ id: "m1" })
  })

  it("unsub removes the listener", () => {
    const fn = vi.fn()
    const unsub = emitter.on("message:received" as any, fn)
    unsub()
    emitter.emit("message:received" as any, { id: "m1" })
    expect(fn).not.toHaveBeenCalled()
  })

  it("removeAllListeners clears all listeners", () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    emitter.on("message:received" as any, fn1)
    emitter.on("message:sent" as any, fn2)
    emitter.removeAllListeners()
    emitter.emit("message:received" as any, { id: "m1" })
    emitter.emit("message:sent" as any, { id: "m2" })
    expect(fn1).not.toHaveBeenCalled()
    expect(fn2).not.toHaveBeenCalled()
  })

  it("off removes a specific listener", () => {
    const fn = vi.fn()
    emitter.on("message:received" as any, fn)
    emitter.off("message:received" as any, fn)
    emitter.emit("message:received" as any, { id: "m1" })
    expect(fn).not.toHaveBeenCalled()
  })
})
