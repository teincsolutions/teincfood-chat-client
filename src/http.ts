import type { AuthTokens } from "./types"
import { TypedEventEmitter } from "./events"

export interface HttpOptions {
  baseUrl: string
  getTokens: () => AuthTokens | null
  setTokens: (tokens: AuthTokens | null) => void
  onTokenExpired?: () => Promise<AuthTokens | null>
  emitter: TypedEventEmitter
}

export class HttpClient {
  private opts: HttpOptions

  constructor(opts: HttpOptions) {
    this.opts = opts
  }

  private get base(): string {
    if (!this.opts.baseUrl) {
      throw new Error(
        "API base URL is not configured. Pass a valid `baseUrl` to ChatClientOptions.",
      )
    }
    return this.opts.baseUrl.replace(/\/+$/, "")
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.base}${path}`
    if (url.startsWith("/")) {
      console.error("[HttpClient] BUG: url is relative!", { baseUrl: this.opts.baseUrl, path, url })
      throw new Error(`Invalid URL: ${url} (base="${this.opts.baseUrl}")`)
    }
    const tokens = this.opts.getTokens()

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    }

    if (tokens?.access_token) {
      headers["Authorization"] = `Bearer ${tokens.access_token}`
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    })

    if (res.status === 401) {
      if (this.opts.onTokenExpired) {
        const newTokens = await this.opts.onTokenExpired()
        if (newTokens) {
          this.opts.setTokens(newTokens)
          headers["Authorization"] = `Bearer ${newTokens.access_token}`
          const retryRes = await fetch(url, {
            method,
            headers,
            body: body != null ? JSON.stringify(body) : undefined,
          })
          if (!retryRes.ok) {
            console.error(`[HttpClient] RETRY ${method} ${url} returned ${retryRes.status}`, await retryRes.clone().json().catch(() => retryRes.statusText))
            throw await toHttpError(retryRes)
          }
          return retryRes.json()
        }
      }
      this.opts.emitter.emit("auth:expired")
    }

    if (!res.ok) {
      console.error(`[HttpClient] ${method} ${url} returned ${res.status}`, await res.clone().json().catch(() => res.statusText))
      throw await toHttpError(res)
    }

    return res.json()
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path)
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body)
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body)
  }

  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("DELETE", path, body)
  }
}

async function toHttpError(res: Response): Promise<HttpError> {
  let detail: unknown
  try {
    detail = await res.json()
  } catch {
    detail = await res.text().catch(() => null)
  }
  return new HttpError(res.status, res.statusText, detail)
}

export class HttpError extends Error {
  status: number
  detail: unknown

  constructor(status: number, statusText: string, detail: unknown) {
    super(`${status} ${statusText}`)
    this.name = "HttpError"
    this.status = status
    this.detail = detail
  }
}
