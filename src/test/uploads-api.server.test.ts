import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthenticatedSession: vi.fn(),
  consumeSharedRateLimit: vi.fn(),
}));

vi.mock("../lib/auth-api.server", () => ({
  getAuthenticatedSession: mocks.getAuthenticatedSession,
}));
vi.mock("../lib/shared-rate-limit.server", () => ({
  consumeSharedRateLimit: mocks.consumeSharedRateLimit,
}));

import { handleUploadsApiRequest, isOwnedChatUploadPath, readOwnedChatUpload } from "../lib/uploads-api.server";

const userId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const uploadId = "33333333-3333-4333-8333-333333333333";
const serviceKey = "server-only-storage-key";
const runtimeEnv = {
  SUPABASE_URL: "https://workbench.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: serviceKey,
};

function signedInSession() {
  return {
    configured: true,
    user: { id: userId, email: "creator@example.com", displayName: "Creator", avatarUrl: "" },
    cookies: [],
  };
}

function request(body: unknown) {
  return new Request("https://codeforge.example/api/uploads", {
    method: "POST",
    headers: {
      origin: "https://codeforge.example",
      "content-type": "application/json",
      cookie: "cf_access=valid-test-session",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.getAuthenticatedSession.mockResolvedValue(signedInSession());
  mocks.consumeSharedRateLimit.mockResolvedValue({ allowed: true, attempts: 1, retryAfterSeconds: 0 });
});

afterEach(() => {
  mocks.getAuthenticatedSession.mockReset();
  mocks.consumeSharedRateLimit.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("private chat upload API", () => {
  it("creates an owner-scoped single-use signed URL without returning the service-role key", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(uploadId);
    const signedPath = userId + "/chat/" + uploadId + ".png";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://workbench.supabase.co/storage/v1/object/upload/sign/tatv-private-uploads/" + signedPath,
      );
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("apikey")).toBe(serviceKey);
      expect(headers.get("authorization")).toBe("Bearer " + serviceKey);
      return Response.json({ url: "/object/upload/sign/tatv-private-uploads/" + signedPath + "?token=one-time-token" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleUploadsApiRequest(request({
      operation: "sign",
      name: "picture.png",
      mimeType: "image/png",
      size: 2048,
    }), runtimeEnv);
    const payload = await response!.json();

    expect(response!.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.path).toBe(signedPath);
    expect(payload.signedUploadToken).toBe("one-time-token");
    expect(payload.tusEndpoint).toBe("https://workbench.storage.supabase.co/storage/v1/upload/resumable");
    expect(payload.signedUrl).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(serviceKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.consumeSharedRateLimit).toHaveBeenCalledWith(runtimeEnv, "uploads", userId, 30, 60);
  });

  it("rejects an unauthenticated request before contacting private storage", async () => {
    mocks.getAuthenticatedSession.mockResolvedValue({ configured: true, user: null, cookies: [] });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleUploadsApiRequest(request({
      operation: "sign",
      name: "picture.png",
      mimeType: "image/png",
      size: 2048,
    }), runtimeEnv);

    expect(response!.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects signed-upload requests when persistent upload rate limiting is unavailable", async () => {
    mocks.consumeSharedRateLimit.mockRejectedValue(new Error("database unavailable"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleUploadsApiRequest(request({
      operation: "sign",
      name: "picture.png",
      mimeType: "image/png",
      size: 2048,
    }), runtimeEnv);
    const payload = await response!.json();

    expect(response!.status).toBe(503);
    expect(payload.error).toBe("UPLOAD_RATE_LIMIT_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects files above the bucket's 10 MB limit", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleUploadsApiRequest(request({
      operation: "sign",
      name: "large.pdf",
      mimeType: "application/pdf",
      size: 10 * 1024 * 1024 + 1,
    }), runtimeEnv);
    const payload = await response!.json();

    expect(response!.status).toBe(400);
    expect(payload.error).toBe("INVALID_UPLOAD");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to delete a storage path belonging to a different user", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleUploadsApiRequest(request({
      operation: "delete",
      paths: [otherUserId + "/chat/" + uploadId + ".pdf"],
    }), runtimeEnv);
    const payload = await response!.json();

    expect(response!.status).toBe(400);
    expect(payload.error).toBe("INVALID_UPLOAD_PATH");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes only owner-scoped upload paths", async () => {
    const path = userId + "/chat/" + uploadId + ".pdf";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://workbench.supabase.co/storage/v1/object/tatv-private-uploads");
      expect(init?.method).toBe("DELETE");
      expect(JSON.parse(String(init?.body))).toEqual({ prefixes: [path] });
      return Response.json({ message: "Successfully deleted" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await handleUploadsApiRequest(request({ operation: "delete", paths: [path] }), runtimeEnv);
    const payload = await response!.json();

    expect(response!.status).toBe(200);
    expect(payload).toEqual({ ok: true, deleted: 1 });
  });

  it("validates that upload object paths remain under the authenticated user's chat folder", () => {
    expect(isOwnedChatUploadPath(userId, userId + "/chat/" + uploadId + ".png")).toBe(true);
    expect(isOwnedChatUploadPath(userId, otherUserId + "/chat/" + uploadId + ".png")).toBe(false);
    expect(isOwnedChatUploadPath(userId, userId + "/chat/../other-user/private.png")).toBe(false);
    expect(isOwnedChatUploadPath(userId, userId + "/avatars/" + uploadId + ".png")).toBe(false);
  });
});


describe("private chat upload reads", () => {
  it("checks the owner path before contacting Supabase Storage", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await readOwnedChatUpload(
      runtimeEnv,
      userId,
      otherUserId + "/chat/" + uploadId + ".png",
      "image/png",
      2048,
    );

    expect(result).toMatchObject({ ok: false, status: 403, error: "UPLOAD_OWNER_MISMATCH" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams only up to the configured size limit before returning bytes", async () => {
    const path = userId + "/chat/" + uploadId + ".png";
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1025));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await readOwnedChatUpload(runtimeEnv, userId, path, "image/png", 1024, 1024);

    expect(result).toMatchObject({ ok: false, status: 413, error: "UPLOAD_SIZE_INVALID" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a stored object whose response MIME type differs from the signed metadata", async () => {
    const path = userId + "/chat/" + uploadId + ".png";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    })));

    const result = await readOwnedChatUpload(runtimeEnv, userId, path, "image/png", 3);

    expect(result).toMatchObject({ ok: false, status: 422, error: "UPLOAD_TYPE_MISMATCH" });
  });

  it("reads an authenticated audio/webm upload and returns only its bounded bytes", async () => {
    const path = userId + "/chat/" + uploadId + ".webm";
    const bytes = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { "content-type": "audio/webm", "content-length": String(bytes.byteLength) },
    })));

    const result = await readOwnedChatUpload(runtimeEnv, userId, path, "audio/webm", bytes.byteLength);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mimeType).toBe("audio/webm");
      expect(Array.from(result.bytes)).toEqual(Array.from(bytes));
    }
  });
});
