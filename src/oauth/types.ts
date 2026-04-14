export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
  idToken?: string;
  accountId?: string;
}

export interface OAuthCredentials {
  type: "oauth";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  idToken?: string;
  accountId?: string;
}
