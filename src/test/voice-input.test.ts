import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistentVoiceInput } from "../../public/codeforge/voice-input.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PersistentVoiceInput session lifecycle", () => {
  it("shares one pending microphone permission request and stops a late stream grant", async () => {
    const pending = deferred<MediaStream>();
    const track = { stop: vi.fn() };
    const stream = {
      active: true,
      getTracks: () => [track],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn(() => pending.promise);

    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("window", {
      MediaRecorder: class FakeMediaRecorder {},
      AudioContext: class FakeAudioContext {},
      clearTimeout,
      setTimeout,
    });

    const voice = new PersistentVoiceInput();
    const firstStart = voice.start();
    const secondStart = voice.start();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await voice.stop();
    pending.resolve(stream);
    await Promise.all([firstStart, secondStart]);

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(voice.isActive).toBe(false);
    expect(voice.stream).toBeNull();
    expect(voice.context).toBeNull();
  });

  it("aborts an old transcription and ignores its late result after a new session begins", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => pending.promise);
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const onState = vi.fn();

    vi.stubGlobal("fetch", fetchMock);
    const voice = new PersistentVoiceInput({ onTranscript, onError, onState });
    voice.sessionId = 7;
    voice.isActive = true;
    voice.speechStartedAt = performance.now() - 1_000;
    voice.chunks = [new Blob(["audio sample"], { type: "audio/webm" })];
    voice.recorder = { mimeType: "audio/webm" } as unknown as MediaRecorder;

    const oldTranscription = voice.finishRecording(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const requestSignal = requestInit.signal as AbortSignal;

    await voice.stop();
    expect(requestSignal.aborted).toBe(true);

    // Model the next call starting before the old fetch settles.
    voice.sessionId += 1;
    voice.isActive = true;
    pending.resolve(new Response(JSON.stringify({ text: "old session transcript" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await oldTranscription;

    expect(onTranscript).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(voice.isTranscribing).toBe(false);
    expect(voice.isActive).toBe(true);
  });

  it("does not let an older transcription clear a newer session's controller", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => pending.promise);
    vi.stubGlobal("fetch", fetchMock);

    const voice = new PersistentVoiceInput();
    voice.sessionId = 2;
    voice.isActive = true;
    voice.speechStartedAt = performance.now() - 1_000;
    voice.chunks = [new Blob(["audio sample"], { type: "audio/webm" })];
    voice.recorder = { mimeType: "audio/webm" } as unknown as MediaRecorder;

    const oldTranscription = voice.finishRecording(2);
    const oldController = voice.transcriptionController;
    expect(oldController).toBeTruthy();

    await voice.stop();
    voice.sessionId += 1;
    voice.isActive = true;
    const newController = new AbortController();
    voice.transcriptionController = newController;
    voice.isTranscribing = true;

    pending.resolve(new Response(JSON.stringify({ text: "stale result" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await oldTranscription;

    expect(voice.transcriptionController).toBe(newController);
    expect(voice.isTranscribing).toBe(true);
  });

  it("mutes an active recording while assistant playback begins", () => {
    const cancelScheduledValues = vi.fn();
    const setTargetAtTime = vi.fn();
    const stop = vi.fn();
    const voice = new PersistentVoiceInput();
    voice.context = { currentTime: 4 } as unknown as AudioContext;
    voice.gain = {
      gain: { cancelScheduledValues, setTargetAtTime },
    } as unknown as GainNode;
    voice.recorder = { state: "recording", stop } as unknown as MediaRecorder;
    voice.isRecording = true;

    voice.setAISpeaking(true);

    expect(cancelScheduledValues).toHaveBeenCalledWith(4);
    expect(setTargetAtTime).toHaveBeenCalledWith(0, 4, 0.02);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(voice.isRecording).toBe(false);
    expect(voice.isAISpeaking).toBe(true);
  });

  it("restores the recording path only after assistant playback ends", () => {
    const cancelScheduledValues = vi.fn();
    const setTargetAtTime = vi.fn();
    const voice = new PersistentVoiceInput();
    voice.context = { currentTime: 7 } as unknown as AudioContext;
    voice.gain = {
      gain: { cancelScheduledValues, setTargetAtTime },
    } as unknown as GainNode;

    voice.setAISpeaking(true);
    voice.setAISpeaking(false);

    expect(cancelScheduledValues).toHaveBeenNthCalledWith(1, 7);
    expect(setTargetAtTime).toHaveBeenNthCalledWith(1, 0, 7, 0.02);
    expect(setTargetAtTime).toHaveBeenNthCalledWith(2, 1, 7, 0.02);
    expect(voice.isAISpeaking).toBe(false);
  });

  it("uses the private-upload callback for large voice turns and cleans up after transcription", async () => {
    const cleanup = vi.fn(async () => {});
    const uploadAudio = vi.fn(async (blob: Blob, signal: AbortSignal) => ({
      storagePath: "11111111-1111-4111-8111-111111111111/chat/22222222-2222-4222-8222-222222222222.webm",
      mimeType: "audio/webm",
      size: blob.size,
      cleanup,
      signal,
    }));
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(init?.headers).toMatchObject({ "content-type": "application/json" });
      expect(body).toMatchObject({
        storagePath: "11111111-1111-4111-8111-111111111111/chat/22222222-2222-4222-8222-222222222222.webm",
        mimeType: "audio/webm",
        language: "auto",
      });
      return new Response(JSON.stringify({ text: "A large voice turn." }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const voice = new PersistentVoiceInput({ uploadAudio, onTranscript, onError });
    voice.sessionId = 12;
    voice.isActive = true;
    voice.speechStartedAt = performance.now() - 1_000;
    voice.chunks = [new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: "audio/webm" })];
    voice.recorder = { mimeType: "audio/webm" } as unknown as MediaRecorder;

    await voice.finishRecording(12);

    expect(uploadAudio).toHaveBeenCalledOnce();
    expect(uploadAudio.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("A large voice turn.");
    expect(onError).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(voice.isTranscribing).toBe(false);
  });

  it("does not send oversized guest audio through the Vercel multipart endpoint", async () => {
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const voice = new PersistentVoiceInput({ onTranscript, onError });
    voice.sessionId = 13;
    voice.isActive = true;
    voice.speechStartedAt = performance.now() - 1_000;
    voice.chunks = [new Blob([new Uint8Array(3 * 1024 * 1024 + 1)], { type: "audio/webm" })];
    voice.recorder = { mimeType: "audio/webm" } as unknown as MediaRecorder;

    await voice.finishRecording(13);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ status: 413 });
  });

});
