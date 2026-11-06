import { getWritable } from "workflow";
import { handleChatApiRequest } from "../lib/chat-api.server";
import {
  appendChatGenerationEvent,
  finishChatGeneration,
  getOwnedChatGeneration,
  getSavedTextMessagesForGeneration,
} from "../lib/chat-generations.server";

type WorkflowEvent = {
  error?: string;
  code?: string;
  cancelled?: boolean;
  done: true;
};

function sseEvent(payload: Record<string, unknown>): string {
  return "data: " + JSON.stringify(payload) + "\n\n";
}

/**
 * Vercel Workflow entrypoint for signed-in, saved, text-only chat.
 * Only stable IDs cross the workflow boundary; prompts stay in Supabase and
 * are loaded inside the provider step so conversation text is not copied into
 * the Workflow run input/event log.
 */
export async function runDurableChatGeneration(
  generationId: string,
  userId: string,
): Promise<void> {
  "use workflow";

  try {
    await executeChatGeneration(generationId, userId);
  } catch {
    const event: WorkflowEvent = {
      error: "The durable chat worker stopped before the response completed. Reopen this conversation to restore saved text, then retry if needed.",
      code: "GENERATION_WORKFLOW_FAILED",
      done: true,
    };

    try {
      await finalizeWorkflowFailure(generationId, userId, event);
    } catch {
      // A database outage can prevent finalization. The Workflow run still
      // records its own failure, and the generation's expiry is the fallback.
    }
    await writeWorkflowEvent(event);
  } finally {
    await closeWorkflowStream();
  }
}

async function executeChatGeneration(generationId: string, userId: string): Promise<void> {
  "use step";

  const writer = getWritable<string>().getWriter();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const decoder = new TextDecoder();

  try {
    const generation = await getOwnedChatGeneration(process.env, userId, generationId);
    if (!generation) {
      throw new Error("GENERATION_NOT_FOUND");
    }

    if (generation.status === "cancelled") {
      await writer.write(sseEvent({
        error: "Generation stopped by you.",
        code: "GENERATION_CANCELLED",
        cancelled: true,
        done: true,
      }));
      return;
    }

    if (generation.status !== "running") {
      await writer.write(sseEvent({
        error: "This saved generation is no longer running. Reopen the conversation to restore its saved events.",
        code: "GENERATION_NOT_RUNNING",
        done: true,
      }));
      return;
    }

    // Provider claims are atomic in Supabase. If a duplicate Workflow run was
    // enqueued, it must not call a paid model a second time.
    if (generation.provider_started_at) {
      await writer.write(sseEvent({
        error: "This response has already started in another worker. Reopen the conversation to restore its saved events.",
        code: "GENERATION_ALREADY_STARTED",
        done: true,
      }));
      return;
    }

    const messages = await getSavedTextMessagesForGeneration(
      process.env,
      userId,
      generation.conversation_id,
    );

    const request = new Request("https://tatv.internal/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": generation.idempotency_key,
      },
      body: JSON.stringify({
        messages,
        provider: generation.provider,
        generationId: generation.id,
        conversationId: generation.conversation_id,
      }),
    });

    // Reuse Tatv's existing provider adapters, tool authorization,
    // quota reservations, stream finalization and Supabase event persistence.
    // This trusted identity override is only passed by this server-side step.
    const response = await handleChatApiRequest(
      request,
      process.env,
      undefined,
      { trustedUserId: userId, workflowExecution: true },
    );

    if (!response) {
      throw new Error("CHAT_HANDLER_NOT_FOUND");
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!response.body || !contentType.includes("text/event-stream")) {
      const payload = await response.clone().json().catch(() => ({})) as {
        error?: unknown;
        message?: unknown;
      };

      if (payload.error === "GENERATION_ALREADY_STARTED") {
        await writer.write(sseEvent({
          error: typeof payload.message === "string"
            ? payload.message
            : "This response is already running. Reopen the conversation to restore it.",
          code: "GENERATION_ALREADY_STARTED",
          done: true,
        }));
        return;
      }

      throw new Error(
        typeof payload.error === "string"
          ? payload.error
          : "CHAT_PROVIDER_DID_NOT_START",
      );
    }

    reader = response.body.getReader();
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const text = decoder.decode(result.value, { stream: true });
      if (text) await writer.write(text);
    }
    const trailingText = decoder.decode();
    if (trailingText) await writer.write(trailingText);
  } finally {
    try {
      await reader?.releaseLock();
    } catch {
      // The reader may already have been released by a failed stream.
    }
    writer.releaseLock();
  }
}

// Model/provider calls are not generally idempotent. The Supabase claim is
// the single-use guard; a crashed in-flight provider step must not be retried.
executeChatGeneration.maxRetries = 0;

async function finalizeWorkflowFailure(
  generationId: string,
  userId: string,
  event: WorkflowEvent,
): Promise<void> {
  "use step";

  const current = await getOwnedChatGeneration(process.env, userId, generationId);
  if (!current || current.status !== "running") return;

  try {
    await appendChatGenerationEvent(process.env, userId, generationId, event);
  } catch {
    const latest = await getOwnedChatGeneration(process.env, userId, generationId).catch(() => null);
    if (!latest || latest.status !== "running") return;
  }

  await finishChatGeneration(
    process.env,
    userId,
    generationId,
    "failed",
    event.error ?? "The durable chat worker did not complete.",
  );
}

async function writeWorkflowEvent(event: WorkflowEvent): Promise<void> {
  "use step";

  const writer = getWritable<string>().getWriter();
  try {
    await writer.write(sseEvent(event));
  } finally {
    writer.releaseLock();
  }
}

async function closeWorkflowStream(): Promise<void> {
  "use step";

  const writer = getWritable<string>().getWriter();
  try {
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}
