import { describe, expect, it } from "vitest";
import { combineRecognitionText, readRecognitionTranscript } from "../../public/codeforge/voice-recognition.js";
import type { SpeechRecognitionResultLike } from "../../public/codeforge/voice-recognition.js";

function speechResult(transcript: string, isFinal: boolean): SpeechRecognitionResultLike {
  const result = [{ transcript }] as SpeechRecognitionResultLike;
  result.isFinal = isFinal;
  return result;
}

describe("CodeForge live voice recognition transcript", () => {
  it("shows final and interim words together while a person is speaking", () => {
    const results = [
      speechResult("मुझे", true),
      speechResult("एक SQL query समझाओ", false),
    ];

    const transcript = readRecognitionTranscript(results);
    expect(transcript.finalText).toBe("मुझे");
    expect(transcript.interimText).toBe("एक SQL query समझाओ");
    expect(combineRecognitionText(transcript.finalText, transcript.interimText))
      .toBe("मुझे एक SQL query समझाओ");
  });

  it("does not duplicate the same interim result when the browser sends another update", () => {
    const results = [
      speechResult("मुझे", true),
      speechResult("एक SQL query", false),
    ];

    const firstTranscript = readRecognitionTranscript(results);
    const secondTranscript = readRecognitionTranscript(results);
    const firstUpdate = combineRecognitionText(firstTranscript.finalText, firstTranscript.interimText);
    const secondUpdate = combineRecognitionText(secondTranscript.finalText, secondTranscript.interimText);

    expect(firstUpdate).toBe("मुझे एक SQL query");
    expect(secondUpdate).toBe(firstUpdate);
  });

  it("replaces an interim segment with its final version instead of appending it twice", () => {
    const results = [
      speechResult("मुझे", true),
      speechResult("एक SQL query समझाओ", false),
    ];
    results[1] = speechResult("एक SQL query अच्छी तरह समझाओ", true);

    const transcript = readRecognitionTranscript(results);
    expect(combineRecognitionText(transcript.finalText, transcript.interimText))
      .toBe("मुझे एक SQL query अच्छी तरह समझाओ");
  });

  it("removes identical consecutive final chunks emitted by a mobile recognizer", () => {
    const transcript = readRecognitionTranscript([
      speechResult("भाई क्या हाल है", true),
      speechResult("भाई क्या हाल है", true),
    ]);

    expect(transcript.finalText).toBe("भाई क्या हाल है");
  });

  it("merges overlapping final chunks without repeating the shared words", () => {
    const transcript = readRecognitionTranscript([
      speechResult("भाई क्या हाल है", true),
      speechResult("क्या हाल है सब ठीक", true),
    ]);

    expect(transcript.finalText).toBe("भाई क्या हाल है सब ठीक");
  });

  it("collapses a duplicated full phrase returned inside one recognition chunk", () => {
    const transcript = readRecognitionTranscript([
      speechResult("भाई क्या हाल है भाई क्या हाल है", true),
    ]);

    expect(transcript.finalText).toBe("भाई क्या हाल है");
  });

  it("replaces a cumulative browser update instead of duplicating the whole phrase", () => {
    expect(combineRecognitionText(
      "मैं Meta में login नहीं कर पा रहा",
      "मैं Meta में login नहीं कर पा रहा हूँ, क्या करूँ"
    )).toBe("मैं Meta में login नहीं कर पा रहा हूँ, क्या करूँ");
  });

  it("keeps the longer transcript when a delayed browser update is only a stale prefix", () => {
    expect(combineRecognitionText(
      "मैं Meta में login नहीं कर पा रहा हूँ",
      "मैं Meta में login"
    )).toBe("मैं Meta में login नहीं कर पा रहा हूँ");
  });

  it("does not repeat text already present in the input when a turn is submitted", () => {
    expect(combineRecognitionText("भाई क्या हाल है", "भाई क्या हाल है"))
      .toBe("भाई क्या हाल है");
  });
});
