import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { consumeSharedRateLimit } from "@/lib/shared-rate-limit.server";

const runtimeEnv = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shared database-backed rate limits", () => {
  it("stores only a scoped SHA-256 subject hash and returns the shared decision", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const sentBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ allowed: false, attempts: 16, retryAfterSeconds: 42 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await consumeSharedRateLimit(runtimeEnv, "chat", "user:private-user-id", 15, 60);

    expect(result).toEqual({ allowed: false, attempts: 16, retryAfterSeconds: 42 });
    expect(sentBodies[0]?.["p_subject_hash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(sentBodies[0])).not.toContain("private-user-id");
    expect(sentBodies[0]).toMatchObject({ p_max_attempts: 15, p_window_seconds: 60 });
  });

  it("separates scopes so chat, auth and transcription do not share counters", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const hashes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { p_subject_hash: string };
      hashes.push(body.p_subject_hash);
      return Response.json({ allowed: true, attempts: 1, retryAfterSeconds: 60 });
    }));

    await consumeSharedRateLimit(runtimeEnv, "chat", "user:123", 15, 60);
    await consumeSharedRateLimit(runtimeEnv, "auth", "user:123", 12, 60);
    await consumeSharedRateLimit(runtimeEnv, "transcription", "user:123", 8, 60);

    expect(new Set(hashes).size).toBe(3);
  });

  it("rejects malformed limiter responses instead of silently allowing requests", async () => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ allowed: "yes" })));

    await expect(consumeSharedRateLimit(runtimeEnv, "chat", "guest:ip", 6, 60))
      .rejects.toThrow("SHARED_RATE_LIMIT_INVALID_RESPONSE");
  });

  it("rejects invalid scopes and limits before making a database request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(consumeSharedRateLimit(runtimeEnv, "bad scope", "user:123", 15, 60))
      .rejects.toThrow("INVALID_SHARED_RATE_LIMIT_REQUEST");
    await expect(consumeSharedRateLimit(runtimeEnv, "chat", "user:123", 101, 60))
      .rejects.toThrow("INVALID_SHARED_RATE_LIMIT_REQUEST");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
