import type { HttpClient } from "../http"
import type { Conversation, PaginationMeta } from "../types"

export interface StartChatParams {
  contact_type?: "user" | "business" | "support"
  contact_id?: string | null
  order_id?: string | null
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

    startChat: (params: StartChatParams) =>
      http
        .post<{ data: Conversation }>("/chats", params)
        .then((r) => r.data),

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
