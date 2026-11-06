import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeUsageReservationStream, finalizeUsageReservationsResponse, finalizeUsageReservationsStream } from "@/lib/usage-limits.server";

const runtimeEnv = {
  SUPABASE_URL: "https://supabase.example",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
};
const userId = "11111111-1111-4111-8111-111111111111";
const reservationId = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFinalizer() {
  const actions: string[] = [];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { p_action: string };
    actions.push(body.p_action);
    return Response.json({
      ok: true,
      status: body.p_action === "commit" ? "committed" : "released",
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { actions, fetchMock };
}

describe("chat quota reservation stream lifecycle", () => {
  it("commits only after a successful CodeForge completion event", async () => {
    const { actions } = stubFinalizer();
    const payload = 'data: {"text":"Hello"}\n\n' + 'data: {"done":true,"model":"OpenAI"}\n\n';
    const response = new Response(payload, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });

    const wrapped = finalizeUsageReservationStream(response, runtimeEnv, userId, reservationId);
    expect(await wrapped.text()).toBe(payload);
    expect(actions).toEqual(["commit"]);
  });

  it("releases the reservation when the provider emits an error", async () => {
    const { actions } = stubFinalizer();
    const payload = 'data: {"error":"Provider is unavailable","done":true}\n\n';
    const response = new Response(payload, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });

    const wrapped = finalizeUsageReservationStream(response, runtimeEnv, userId, reservationId);
    expect(await wrapped.text()).toBe(payload);
    expect(actions).toEqual(["release"]);
  });

  it("releases an incomplete stream that closes without a done event", async () => {
    const { actions } = stubFinalizer();
    const payload = 'data: {"text":"Partial answer"}\n\n';
    const response = new Response(payload, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });

    const wrapped = finalizeUsageReservationStream(response, runtimeEnv, userId, reservationId);
    expect(await wrapped.text()).toBe(payload);
    expect(actions).toEqual(["release"]);
  });

  it("finalizes both file-analysis and paid-chat reservations on one successful stream", async () => {
    const { actions } = stubFinalizer();
    const payload = 'data: {"text":"File analyzed"}\n\n' + 'data: {"done":true,"model":"OpenAI"}\n\n';
    const response = new Response(payload, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });

    const chatReservation = finalizeUsageReservationsStream(response, runtimeEnv, [
      { userId, reservationId },
      { userId, reservationId: "33333333-3333-4333-8333-333333333333" },
    ]);

    expect(await chatReservation.text()).toBe(payload);
    expect(actions).toEqual(["commit", "commit"]);
  });

  it("releases both reservations when the browser cancels the shared stream", async () => {
    const { actions } = stubFinalizer();
    const source = new Response(new ReadableStream<Uint8Array>({
      start() {
        // Keep the provider stream open until the simulated client disconnects.
      },
    }), {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });

    const chatReservation = finalizeUsageReservationsStream(source, runtimeEnv, [
      { userId, reservationId },
      { userId, reservationId: "33333333-3333-4333-8333-333333333333" },
    ]);

    await chatReservation.body?.cancel("client disconnect");
    expect(actions).toEqual(["release", "release"]);
  });

  it("awaits release of all reservations before returning a non-streaming error", async () => {
    const { actions } = stubFinalizer();
    const body = JSON.stringify({ error: "provider failed" });
    const response = new Response(body, {
      status: 502,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

    const wrapped = await finalizeUsageReservationsResponse(response, runtimeEnv, [
      { userId, reservationId },
      { userId, reservationId: "33333333-3333-4333-8333-333333333333" },
    ]);

    expect(actions).toEqual(["release", "release"]);
    expect(await wrapped.text()).toBe(body);
    expect(wrapped.status).toBe(502);
  });

  it("does not alter responses when there is no reservation", async () => {
    const { fetchMock } = stubFinalizer();
    const response = new Response("ordinary response", { status: 502 });
    const wrapped = finalizeUsageReservationStream(response, runtimeEnv, userId, undefined);

    expect(await wrapped.text()).toBe("ordinary response");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
