import type { HttpClient } from "../http"
import type { Conversation, PaginationMeta } from "../types"

/**
 * All contact_type values that can appear in contacts API responses.
 * The chat API only accepts "user" | "business" | "support", so we
 * normalize the broader set before sending.
 */
export type ContactTypeRaw =
  | "user"
  | "business"
  | "support"
  | "member"
  | "rider"
  | "buyer"

export interface StartChatParams {
  contact_type?: ContactTypeRaw
  contact_id?: string | null
  order_id?: string | null
}

/** Map contacts-API contact_type values to chat-API values. */
function normalizeContactType(raw?: ContactTypeRaw): string | undefined {
  switch (raw) {
    case "member":
    case "rider":
    case "buyer":
    case "user":
      return "user"
    case "business":
      return "business"
    case "support":
      return "support"
    default:
      return raw
  }
}

export function createConversationsApi(http: HttpClient) {
  return {
    getInbox: () =>
      http
        .get<{ data: Conversation[] }>("/inbox")
        .then((r) => r.data),

    getConversation: (id: string) =>
      http
        .get<{ data: Conversation }>(`/conversations/${id}`)
        .then((r) => r.data),

    startChat: (params: StartChatParams) => {
      const normalized = normalizeContactType(params.contact_type)
      return http
        .post<{ data: Conversation }>("/chats", {
          ...params,
          contact_type: normalized,
        })
        .then((r) => r.data)
    },

    startSupportChat: () =>
      http
        .post<{ data: Conversation }>("/chats/support")
        .then((r) => r.data),

    close: (id: string) =>
      http
        .patch<{ data: { success: boolean } }>(`/conversations/${id}/close`)
        .then((r) => r.data),

    listSupportConversations: (page = 1, pageSize = 20) =>
      http.get<{
        data: Conversation[]
        pagination: PaginationMeta
      }>(`/chats?page=${page}&page_size=${pageSize}`),
  }
}
