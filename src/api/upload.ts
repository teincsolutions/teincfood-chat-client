import type { HttpClient } from "../http"
import type { UploadUrlResult } from "../types"

export function createUploadApi(http: HttpClient) {
  return {
    getUploadUrl: (
      fileName: string,
      contentType: string,
      purpose: "chat" | "avatar" | "kyc" = "chat",
    ) =>
      http
        .post<{ data: UploadUrlResult }>("/upload", {
          file_name: fileName,
          content_type: contentType,
          purpose,
        })
        .then((r) => r.data),
  }
}
