import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error The browser upload helper is a plain JavaScript module under public/.
import { uploadResumableTus } from "../../public/codeforge/tus-upload.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("signed resumable TUS uploads", () => {
  it("reconciles the final PATCH when Storage accepted it but the response was lost", async () => {
    const file = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
    const filePath = "11111111-1111-4111-8111-111111111111/chat/22222222-2222-4222-8222-222222222222.png";
    const endpoint = "https://workbench.storage.supabase.co/storage/v1/upload/resumable";
    let patchAttempts = 0;
    let serverOffset = 0;

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        return new Response(null, {
          status: 201,
          headers: { location: "/storage/v1/upload/resumable/session-1", "upload-offset": "0" },
        });
      }
      if (method === "PATCH") {
        patchAttempts += 1;
        if (patchAttempts === 4) serverOffset = file.size;
        throw new TypeError("The network dropped the PATCH response.");
      }
      if (method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "upload-offset": String(serverOffset) },
        });
      }
      throw new Error("Unexpected TUS method: " + method);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadResumableTus(
      file,
      filePath,
      "image/png",
      endpoint,
      "one-time-signed-token",
      undefined,
      [0, 0, 0],
    )).resolves.toBeUndefined();

    expect(patchAttempts).toBe(4);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "HEAD")).toHaveLength(4);
  });

  it.each([
    "http://workbench.storage.supabase.co/storage/v1/upload/resumable",
    "https://attacker.example/storage/v1/upload/resumable",
    "https://workbench.storage.supabase.co/unexpected/path",
    "https://user:password@workbench.storage.supabase.co/storage/v1/upload/resumable",
  ])("rejects an untrusted TUS endpoint before sending the signed token: %s", async endpoint => {
    const file = new Blob([new Uint8Array([1])], { type: "image/png" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadResumableTus(
      file,
      "11111111-1111-4111-8111-111111111111/chat/22222222-2222-4222-8222-222222222222.png",
      "image/png",
      endpoint,
      "one-time-signed-token",
    )).rejects.toThrow("unexpected resumable upload endpoint");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a same-origin TUS session URL outside the resumable upload path", async () => {
    const file = new Blob([new Uint8Array([1])], { type: "image/png" });
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 201,
      headers: {
        location: "/storage/v1/unexpected/session",
        "upload-offset": "0",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadResumableTus(
      file,
      "11111111-1111-4111-8111-111111111111/chat/22222222-2222-4222-8222-222222222222.png",
      "image/png",
      "https://workbench.storage.supabase.co/storage/v1/upload/resumable",
      "one-time-signed-token",
    )).rejects.toThrow("unexpected upload address");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a TUS upload URL that points to another origin", async () => {
    const file = new Blob([new Uint8Array([1])], { type: "image/png" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 201,
      headers: {
        location: "https://attacker.example/upload/session",
        "upload-offset": "0",
      },
    })));

    await expect(uploadResumableTus(
      file,
      "11111111-1111-4111-8111-111111111111/chat/22222222-2222-4222-8222-222222222222.png",
      "image/png",
      "https://workbench.storage.supabase.co/storage/v1/upload/resumable",
      "one-time-signed-token",
    )).rejects.toThrow("unexpected upload address");
  });
});
