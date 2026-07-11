/**
 * Integration tests for the event-driven chat client.
 *
 * These tests connect to localhost:4000 and verify that all data flows
 * through WebSocket events — no REST polling, no manual data invalidation.
 *
 * Usage: npx vitest run src/integration.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest"
import { ChatClient } from "./client"
import type { ChatStorage, Message, PresencePayload, MessagesReadPayload } from "./types"

// ─── Config ──────────────────────────────────────────────────

const BASE_URL = "http://localhost:4000/api/v1"
const WS_URL = "ws://localhost:4000/ws"

// @ts-ignore - `process` is available in vitest environment
const ENV = typeof process !== "undefined" ? process.env : {}

const RIDER_TOKEN =
  (ENV.RIDER_TOKEN as string) ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImVyaWMubTQ1MTFAZ21haWwuY29tIiwiZXhwIjoxNzgzNDMyOTM2LCJpYXQiOjE3ODMzNDY1MzYsImlzX3N1cGVyX2FkbWluIjpmYWxzZSwianRpIjoiZDE0ZGM3ZjI2MTNiODU1N2JiZWRiYWQwN2JhN2JiZGMiLCJsb2dpbl9tZXRob2QiOiJlbWFpbF9wYXNzd29yZCIsInN1YiI6IjA0ZDAwNjhlLThlM2QtNDczMS04NmM4LTQ1NmMxOTU3NzNhMiIsInR5cGUiOiJhY2Nlc3MiLCJ1c2VyX3R5cGUiOiJwdWJsaWMifQ.J-o6YBE_nCkuEjdQT7lD7fMaWb6Z-v6WV75D2Xug6bQ"

const BUSINESS_TOKEN =
  (ENV.BUSINESS_TOKEN as string) ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImVyZWNveC5jZW9AZ21haWwuY29tIiwiZXhwIjoxNzgzNDMwNjQ2LCJpYXQiOjE3ODMzNDQyNDYsImlzX3N1cGVyX2FkbWluIjpmYWxzZSwianRpIjoiNTVmNzFiMTcwMWIxMGZiM2FlYTNiNWIxMTllNWQxOTIiLCJsb2dpbl9tZXRob2QiOiJlbWFpbF9wYXNzd29yZCIsInN1YiI6ImZkZGVhNTljLTA0ZDItNGUxOS04M2NmLTE5MzNmNWI3OTQzMCIsInR5cGUiOiJhY2Nlc3MiLCJ1c2VyX3R5cGUiOiJwdWJsaWMifQ._kOMrA_fOTXEnsqNXH8DTxG3jfPtKh9UJdL4W0863V8"

const RIDER_USER_ID = "04d0068e-8e3d-4731-86c8-456c195773a2"
const BUSINESS_USER_ID = "fddea59c-04d2-4e19-83cf-1933f5b79430"

// ─── In-memory storage adapter ────────────────────────────────

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

// ─── Event helper ────────────────────────────────────────────

function waitForEvent<T>(
  client: ChatClient,
  event: string,
  timeoutMs = 8000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for event "${event}"`))
    }, timeoutMs)
    const unsub = client.on(event as any, (payload: T) => {
      clearTimeout(timer)
      unsub()
      resolve(payload)
    })
  })
}

// ─── Shared helpers ──────────────────────────────────────────

function makeClient() {
  return new ChatClient({
    baseUrl: BASE_URL,
    wsUrl: WS_URL,
    storage: new MapStorage(),
  })
}

// ─── Test suite ──────────────────────────────────────────────

let riderClient: ChatClient
let businessClient: ChatClient
let convId: string

describe("teincfood-chat-client (event-driven)", () => {
  beforeAll(async () => {
    // Initialize both clients
    riderClient = makeClient()
    riderClient.setCurrentUserId(RIDER_USER_ID)
    await riderClient.start({
      access_token: RIDER_TOKEN,
      refresh_token: RIDER_TOKEN,
    })

    businessClient = makeClient()
    businessClient.setCurrentUserId(BUSINESS_USER_ID)
    await businessClient.start({
      access_token: BUSINESS_TOKEN,
      refresh_token: BUSINESS_TOKEN,
    })

    // Find or create a conversation between these two users
    const riderInbox = await riderClient.conversations.getInbox()
    const sharedConv = riderInbox.find((c) =>
      c.participants?.some((p: { user_id: string }) => p.user_id === BUSINESS_USER_ID),
    )

    if (sharedConv) {
      convId = sharedConv.id
    } else {
      const start = await riderClient.conversations.startChat({
        contact_type: "user",
        contact_id: BUSINESS_USER_ID,
      })
      convId = start.id
    }
    console.log(`[setup] conversation: ${convId}`)
  })

  // ─── Live event tests ─────────────────────────────

  it("both clients join the conversation and receive presence", async () => {
    const riderPresence = waitForEvent<PresencePayload>(riderClient, "presence")
    const bizPresence = waitForEvent<PresencePayload>(businessClient, "presence")

    await riderClient.joinConversation(convId)
    await businessClient.joinConversation(convId)

    const rp = await riderPresence
    expect(rp.conversationId).toBe(convId)
    expect(rp.users.length).toBeGreaterThan(0)
    console.log(`[live] rider received presence: ${rp.users.length} users`)

    const bp = await bizPresence
    expect(bp.conversationId).toBe(convId)
    console.log(`[live] business received presence: ${bp.users.length} users`)
  })

  it("rider sends message and receives message:sent confirmation", async () => {
    const promise = waitForEvent<Message>(riderClient, "message:sent")

    riderClient.sendMessage(convId, "Hello from event-driven test!")

    const confirmed = await promise
    expect(confirmed).toBeDefined()
    expect(confirmed.content).toContain("Hello from event-driven test!")
    expect(confirmed.conversation_id).toBe(convId)
    console.log(`[live] message sent: id=${confirmed.id?.slice(0, 8)} status=${confirmed.status}`)
  })

  it("business receives the message via WebSocket event", async () => {
    // Listen for ANY incoming message, skip stale events
    const promise = new Promise<Message>((resolve) => {
      const unsub = businessClient.on("message:received", (msg: Message) => {
        if (msg.content.includes("Second message")) {
          unsub()
          resolve(msg)
        }
      })
    })

    riderClient.sendMessage(convId, "Second message — live delivery check")

    const received = await promise
    expect(received.content).toContain("Second message")
    expect(received.conversation_id).toBe(convId)
    console.log(`[live] business received: "${received.content.slice(0, 60)}"`)
  })

  it("auto-mark-read notifies the sender", async () => {
    // Business is already joined from previous test, so auto-mark-read
    // fires on join. For this test, have rider send then business re-joins.
    const promise = waitForEvent<MessagesReadPayload>(riderClient, "messages_read")

    riderClient.sendMessage(convId, "Read receipt test message")
    // Wait for send to complete
    await waitForEvent<Message>(riderClient, "message:sent")
    // Business leaves and re-joins to trigger auto-mark-read
    businessClient.leaveConversation(convId)
    await businessClient.joinConversation(convId)

    const receipt = await promise
    expect(receipt.conversationId).toBe(convId)
    expect(receipt.userId).toBe(BUSINESS_USER_ID)
    expect(receipt.readAt).toBeTruthy()
    console.log(`[live] rider received read receipt from business at ${receipt.readAt}`)
  })

  // ─── Error handling ───────────────────────────────

  it("returns auth:expired for an invalid token", async () => {
    const badClient = makeClient()
    badClient.setCurrentUserId("00000000-0000-0000-0000-000000000000")

    const promise = waitForEvent<void>(badClient, "auth:expired", 5000)
    await badClient.start({
      access_token: "bad_token",
      refresh_token: "bad_token",
    })
    // Try an operation that triggers an auth check
    try {
      await badClient.loadInbox()
    } catch {
      // Expected
    }
    const result = await promise
    expect(result).toBeUndefined()
    console.log("[error] auth:expired fired correctly")
  })

  it("handles errors gracefully", async () => {
    try {
      await riderClient.conversations.getConversation(
        "00000000-0000-0000-0000-000000000000",
      )
    } catch (e: unknown) {
      const err = e as { status?: number; message?: string }
      expect(err.status).toBe(404)
      console.log(`[error] 404 handled: ${err.message}`)
    }
  })
})
