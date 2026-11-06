import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readOwnedChatUpload: vi.fn(),
}));

vi.mock("../lib/uploads-api.server", () => ({
  MAX_CHAT_UPLOAD_BYTES: 10 * 1024 * 1024,
  readOwnedChatUpload: mocks.readOwnedChatUpload,
}));

import { hydrateStorageAttachments } from "../lib/chat-api.server";

const userId = "11111111-1111-4111-8111-111111111111";
const storagePath = userId + "/chat/22222222-2222-4222-8222-222222222222.pdf";
const runtimeEnv = {
  SUPABASE_URL: "https://workbench.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "server-only-test-key",
};

beforeEach(() => {
  mocks.readOwnedChatUpload.mockReset();
});

describe("chat attachment private storage hydration", () => {
  it("leaves ordinary inline and text attachments untouched", async () => {
    const messages = [{
      role: "user" as const,
      content: "Read this note.",
      attachments: [{ name: "note.txt", mimeType: "text/plain", size: 12, textContent: "Hello" }],
    }];

    const result = await hydrateStorageAttachments(messages, userId, runtimeEnv);

    expect(result).toEqual({ ok: true });
    expect(mocks.readOwnedChatUpload).not.toHaveBeenCalled();
  });

  it("hydrates only an authenticated user's private storage object into provider data", async () => {
    const messages = [{
      role: "user" as const,
      content: "Read this PDF.",
      attachments: [{
        name: "report.pdf",
        mimeType: "application/pdf",
        size: 4,
        storagePath,
      }],
    }];
    const bytes = new Uint8Array([1, 2, 3, 4]);
    mocks.readOwnedChatUpload.mockResolvedValue({
      ok: true,
      bytes,
      mimeType: "application/pdf",
    });

    const result = await hydrateStorageAttachments(messages, userId, runtimeEnv);

    expect(result).toEqual({ ok: true });
    expect(mocks.readOwnedChatUpload).toHaveBeenCalledWith(
      runtimeEnv,
      userId,
      storagePath,
      "application/pdf",
      4,
      10 * 1024 * 1024,
      undefined,
    );
    expect(messages[0]!.attachments![0]).toMatchObject({
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 4,
      data: Buffer.from(bytes).toString("base64"),
    });
    expect(messages[0]!.attachments![0]!.storagePath).toBeUndefined();
  });

  it("fails closed when the storage reader refuses the owner or object", async () => {
    const messages = [{
      role: "user" as const,
      content: "Read this PDF.",
      attachments: [{ name: "report.pdf", mimeType: "application/pdf", size: 4, storagePath }],
    }];
    mocks.readOwnedChatUpload.mockResolvedValue({
      ok: false,
      status: 403,
      error: "UPLOAD_OWNER_MISMATCH",
      message: "This file does not belong to your signed-in account.",
    });

    const result = await hydrateStorageAttachments(messages, userId, runtimeEnv);

    expect(result).toMatchObject({ ok: false, status: 403, error: "UPLOAD_OWNER_MISMATCH" });
    expect((messages[0]!.attachments![0] as { data?: string }).data).toBeUndefined();
  });

  it("enforces the combined 10 MB binary limit across multiple objects", async () => {
    const messages = [{
      role: "user" as const,
      content: "Read these files.",
      attachments: [
        { name: "one.pdf", mimeType: "application/pdf", size: 6 * 1024 * 1024, storagePath },
        {
          name: "two.pdf",
          mimeType: "application/pdf",
          size: 5 * 1024 * 1024,
          storagePath: userId + "/chat/33333333-3333-4333-8333-333333333333.pdf",
        },
      ],
    }];
    mocks.readOwnedChatUpload
      .mockResolvedValueOnce({ ok: true, bytes: new Uint8Array(6 * 1024 * 1024), mimeType: "application/pdf" })
      .mockResolvedValueOnce({ ok: true, bytes: new Uint8Array(5 * 1024 * 1024), mimeType: "application/pdf" });

    const result = await hydrateStorageAttachments(messages, userId, runtimeEnv);

    expect(result).toMatchObject({ ok: false, status: 413, error: "UPLOAD_TOTAL_TOO_LARGE" });
    expect(mocks.readOwnedChatUpload).toHaveBeenCalledTimes(2);
    expect(mocks.readOwnedChatUpload).toHaveBeenNthCalledWith(
      2,
      runtimeEnv,
      userId,
      messages[0]!.attachments![1]!.storagePath,
      "application/pdf",
      5 * 1024 * 1024,
      4 * 1024 * 1024,
      undefined,
    );
  });
});
