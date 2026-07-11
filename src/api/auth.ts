import type { HttpClient } from "../http"
import type {
  AuthTokens,
  LoginParams,
  RegisterParams,
  OtpSendParams,
  OtpVerifyParams,
  OidcParams,
} from "../types"

function authResponse(res: { data: AuthTokens }): AuthTokens {
  return res.data
}

export function createAuthApi(http: HttpClient) {
  return {
    login: (params: LoginParams) =>
      http.post<{ data: AuthTokens }>("/auth/login", params).then(authResponse),

    register: (params: RegisterParams) =>
      http
        .post<{ data: AuthTokens }>("/auth/register", params)
        .then(authResponse),

    refresh: (refreshToken: string) =>
      http
        .post<{ data: AuthTokens }>("/auth/refresh", {
          refresh_token: refreshToken,
        })
        .then(authResponse),

    sendOtp: (params: OtpSendParams) =>
      http.post<{ success: boolean }>("/auth/otp/send", params),

    verifyOtp: (params: OtpVerifyParams) =>
      http
        .post<{ data: AuthTokens }>("/auth/otp/verify", params)
        .then(authResponse),

    oidc: (params: OidcParams) =>
      http
        .post<{ data: AuthTokens }>("/auth/oidc", params)
        .then(authResponse),
  }
}
