export interface AuthBootstrapResponse {
  ok: boolean;
  status: number;
}

export interface AuthBootstrapPayload {
  error?: string;
  user?: unknown;
}

export interface SubscriptionStatusSnapshot {
  loaded: boolean;
  paid: boolean;
  planCode: string | null;
  expiresAt: string | null;
}

export function classifyAuthBootstrap(
  response: AuthBootstrapResponse | null,
  payload?: AuthBootstrapPayload | null,
): "authenticated" | "signed-out" | "unavailable";

export function preserveSubscriptionStatus(
  response: Pick<Response, "ok" | "status"> | null,
  payload: { error?: string; paid?: boolean; planCode?: string | null; expiresAt?: string | null } | null,
  current: SubscriptionStatusSnapshot,
): SubscriptionStatusSnapshot;

export function shouldOpenAuthWelcome(user: unknown, authUnavailable: boolean): boolean;
