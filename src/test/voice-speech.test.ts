import { describe, expect, it, vi } from "vitest";
import { createVoiceReplyPlayer, nextSentenceEnd } from "../../public/codeforge/voice-speech.js";
import type { VoiceReplyUtterance } from "../../public/codeforge/voice-speech.js";

describe("CodeForge voice transcript synchronization", () => {
  it("reveals text progressively as speech boundary events arrive", () => {
    const utterances: VoiceReplyUtterance[] = [];
    const rendered: string[] = [];
    const onDone = vi.fn();
    const synthesis = {
      speak: (utterance: VoiceReplyUtterance) => utterances.push(utterance),
      resume: vi.fn(),
      cancel: vi.fn(),
    };

    const player = createVoiceReplyPlayer({
      synthesis,
      createUtterance: (text: string) => ({ text } as VoiceReplyUtterance),
      voice: null,
      render: (text: string) => rendered.push(text),
      onDone,
      onError: vi.fn(),
      onSpeakingChange: vi.fn(),
      isCurrent: () => true,
    });

    player.append("Namaste, yeh ek test hai. ");
    player.flush(true);
    expect(utterances).toHaveLength(1);

    const utterance = utterances[0]!;
    expect(utterance.rate).toBe(1.05);
    expect(utterance.volume).toBe(1);
    utterance.onstart?.();
    expect(rendered.at(-1)).not.toBe("Namaste, yeh ek test hai. ");

    utterance.onboundary?.({ name: "word", charIndex: 0 });
    expect(rendered.at(-1)).toContain("Namaste");

    utterance.onend?.();
    expect(rendered.at(-1)).toBe("Namaste, yeh ek test hai. ");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("does not reveal a whole sentence early when word events are unavailable", () => {
    const utterances: VoiceReplyUtterance[] = [];
    const rendered: string[] = [];
    const synthesis = {
      speak: (utterance: VoiceReplyUtterance) => utterances.push(utterance),
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const player = createVoiceReplyPlayer({
      synthesis,
      createUtterance: (text: string) => ({ text } as VoiceReplyUtterance),
      voice: null,
      render: (text: string) => rendered.push(text),
      onDone: vi.fn(),
      onError: vi.fn(),
      onSpeakingChange: vi.fn(),
      isCurrent: () => true,
    });

    player.append("This is one sentence. ");
    player.flush(true);
    const utterance = utterances[0]!;
    utterance.onstart?.();

    expect(rendered.at(-1)).not.toBe("This is one sentence. ");
    utterance.onend?.();
    expect(rendered.at(-1)).toBe("This is one sentence. ");
  });

  it("keeps decimal points inside numbers while finding sentence boundaries", () => {
    expect(nextSentenceEnd("The value is 3.14 today. Next", false)).toBe(25);
  });
  it("pre-queues the next phrase to reduce gaps between spoken sentences", () => {
    const utterances: VoiceReplyUtterance[] = [];
    const synthesis = {
      speak: (utterance: VoiceReplyUtterance) => utterances.push(utterance),
      resume: vi.fn(),
      cancel: vi.fn(),
    };
    const player = createVoiceReplyPlayer({
      synthesis,
      createUtterance: (text: string) => ({ text } as VoiceReplyUtterance),
      voice: null,
      render: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
      onSpeakingChange: vi.fn(),
      isCurrent: () => true,
    });

    player.append("First sentence. ");
    player.append("Second sentence. ");
    player.append("Third sentence. ");
    player.flush(true);

    expect(utterances).toHaveLength(2);
    expect(utterances.map(item => item.text)).toEqual(["First sentence.", "Second sentence."]);

    utterances[0]!.onend?.();
    expect(utterances).toHaveLength(3);
    expect(utterances[2]!.text).toBe("Third sentence.");
  });

  it("starts speaking after a natural clause instead of waiting for a long sentence to finish", () => {
    const utterances: VoiceReplyUtterance[] = [];
    const synthesis = { speak: (utterance: VoiceReplyUtterance) => utterances.push(utterance), resume: vi.fn(), cancel: vi.fn() };
    const player = createVoiceReplyPlayer({
      synthesis, createUtterance: (text: string) => ({ text } as VoiceReplyUtterance), voice: null, render: vi.fn(),
      onDone: vi.fn(), onError: vi.fn(), onSpeakingChange: vi.fn(), isCurrent: () => true,
    });

    player.append("This opening phrase is deliberately long enough to form a complete spoken thought, and the remaining words continue the same sentence.");
    expect(utterances).toHaveLength(1);
    expect(utterances[0]!.text).toContain("spoken thought,");
  });

  it("does not wait for punctuation when a long response has a safe word boundary", () => {
    const utterances: VoiceReplyUtterance[] = [];
    const synthesis = { speak: (utterance: VoiceReplyUtterance) => utterances.push(utterance), resume: vi.fn(), cancel: vi.fn() };
    const player = createVoiceReplyPlayer({
      synthesis, createUtterance: (text: string) => ({ text } as VoiceReplyUtterance), voice: null, render: vi.fn(),
      onDone: vi.fn(), onError: vi.fn(), onSpeakingChange: vi.fn(), isCurrent: () => true,
    });

    player.append("A long spoken response with no punctuation ".repeat(4));
    expect(utterances.length).toBeGreaterThan(0);
  });

});
