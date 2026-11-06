import { describe, expect, it } from "vitest";
import type { SpeechVoiceLike } from "../../public/codeforge/voice-options.js";
import {
  SPEECH_VOICE_SLOTS,
  selectSpeechVoiceOptions,
  speechVoiceForText,
} from "../../public/codeforge/voice-options.js";

function voice(name: string, lang: string, extra: Partial<SpeechVoiceLike> = {}): SpeechVoiceLike {
  return {
    name,
    lang,
    voiceURI: name + "-" + lang,
    localService: false,
    ...extra,
  };
}

describe("Dhwani AI speech voice options", () => {
  it("uses Dhwani AI in every spoken voice preview", () => {
    const previews = SPEECH_VOICE_SLOTS.map(option => option.preview).join(" ");
    expect(previews).toContain("ध्वनि AI");
    expect(previews).toContain("Dhwani AI");
    expect(previews).not.toContain("CodeForge");
  });

  const voices = [
    voice("Google Hindi Male Natural", "hi-IN"),
    voice("Microsoft Hemant", "hi-IN"),
    voice("Google Hindi Female Natural", "hi-IN"),
    voice("Microsoft Swara", "hi-IN"),
    voice("Microsoft David", "en-US"),
    voice("Microsoft Zira", "en-US"),
    voice("Google English Female Neural", "en-IN"),
  ];

  it("offers one male and one female option for each language", () => {
    const options = selectSpeechVoiceOptions(voices);
    expect(options.map(option => option.label)).toEqual([
      "Male · Hindi",
      "Female · Hindi",
      "Male · English",
      "Female · English",
    ]);
    expect(new Set(options.map(option => option.voice.voiceURI)).size).toBe(4);
  });

  it("prefers the higher quality compatible voice for each slot", () => {
    const options = selectSpeechVoiceOptions(voices);
    expect(options[0]!.voice.name).toBe("Google Hindi Male Natural");
    expect(options[1]!.voice.name).toBe("Google Hindi Female Natural");
  });

  it("keeps the exact selected voice across Hindi and English turns", () => {
    const options = selectSpeechVoiceOptions(voices);
    const selected = options[0]!.voice;
    const englishVoice = speechVoiceForText(selected, voices, "Hello, how can I help?");
    const hindiVoice = speechVoiceForText(selected, voices, "नमस्ते, कैसे मदद करूँ?");
    expect(englishVoice!.voiceURI).toBe(selected.voiceURI);
    expect(hindiVoice!.voiceURI).toBe(selected.voiceURI);
  });

  it("falls back by spoken language only when the selected voice is no longer available", () => {
    const selected = voices[0];
    const remaining = [
      voice("Google English Female Neural", "en-IN"),
      voice("Microsoft Zira", "en-US"),
    ];
    expect(speechVoiceForText(selected, remaining, "Hello there.")?.name).toBe("Google English Female Neural");
    expect(speechVoiceForText(selected, remaining, "नमस्ते।")).toBeNull();
  });

  it("keeps a comparable same-language selected voice", () => {
    const englishVoices = [
      voice("Google English Male Natural", "en-IN"),
      voice("Google English Female Natural", "en-IN"),
    ];
    const selected = englishVoices[0]!;
    expect(speechVoiceForText(selected, englishVoices, "Hello there.")?.name).toBe(selected.name);
  });

  it("does not invent a gender or duplicate a slot when the device lacks a matching voice", () => {
    const limited = selectSpeechVoiceOptions([
      voice("Google Hindi", "hi-IN"),
      voice("Microsoft Zira", "en-US"),
    ]);
    expect(limited.map(option => option.label)).toEqual(["Hindi · Device Voice 1", "Female · English"]);
  });
});
