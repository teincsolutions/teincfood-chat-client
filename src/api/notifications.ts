import type { HttpClient } from "../http"
import type { AppNotification } from "../types"

export function createNotificationsApi(http: HttpClient) {
  return {
    list: (page = 1, pageSize = 20) =>
      http.get<{
        data: AppNotification[]
        pagination: { page: number; page_size: number; total_entries: number; total_pages: number }
      }>(`/notifications?page=${page}&page_size=${pageSize}`),

    unreadCount: () =>
      http
        .get<{ data: { count: number } }>("/notifications/unread-count")
        .then((r) => r.data.count),
  }
}
