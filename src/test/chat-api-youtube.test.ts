import { describe, expect, it } from "vitest";
import { needsYouTubeAnalysis } from "../lib/chat-api.server";

describe("YouTube chat context detection", () => {
  it("detects an English request to analyze the user's connected channel", () => {
    expect(needsYouTubeAnalysis("Can you analyze my YouTube channel?")).toBe(true);
    expect(needsYouTubeAnalysis("Review the YouTube channel I connected")).toBe(true);
    expect(needsYouTubeAnalysis("Analyze my YouTube")).toBe(true);
    expect(needsYouTubeAnalysis("Mera YouTube ka analysis kar do")).toBe(true);
  });

  it("detects a Hindi/Hinglish request to analyze the user's channel", () => {
    expect(needsYouTubeAnalysis("Mere YouTube channel ka analysis kar do")).toBe(true);
    expect(needsYouTubeAnalysis("मेरे यूट्यूब चैनल का एनालिसिस कर सकते हो?")).toBe(true);
  });

  it("does not fetch private channel data for generic YouTube questions", () => {
    expect(needsYouTubeAnalysis("How do I upload a video to YouTube?")).toBe(false);
    expect(needsYouTubeAnalysis("Analyze a random YouTube channel")).toBe(false);
  });
});
