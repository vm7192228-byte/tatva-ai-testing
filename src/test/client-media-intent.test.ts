import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(process.cwd(), "public/codeforge/app.js"), "utf8");
const detectorStart = appSource.indexOf("function detectComposerMediaIntent(prompt) {");
const detectorEnd = appSource.indexOf("\nfunction getRequestedMediaDuration", detectorStart);

if (detectorStart < 0 || detectorEnd < 0) {
  throw new Error("Could not locate the client media intent classifier in public/codeforge/app.js");
}

const detectComposerMediaIntent = runInNewContext(
  "(" + appSource.slice(detectorStart, detectorEnd) + ")",
) as (prompt: string) => "image" | "video" | null;


const zipEditStart = appSource.indexOf("function wantsUploadedZipEdit(prompt, attachments) {");
const zipEditEnd = appSource.indexOf("\nfunction detectComposerVideoKitIntent", zipEditStart);
const videoKitStart = zipEditEnd + 1;
const videoKitEnd = appSource.indexOf("\nfunction isCodeOrProjectFile", videoKitStart);
if (zipEditStart < 0 || zipEditEnd < 0 || videoKitEnd < 0) {
  throw new Error("Could not locate ZIP editing and video creative intent helpers.");
}
const wantsUploadedZipEdit = runInNewContext(
  "(" + appSource.slice(zipEditStart, zipEditEnd) + ")",
) as (prompt: string, attachments: Array<Record<string, unknown>>) => boolean;
const detectComposerVideoKitIntent = runInNewContext(
  "(" + appSource.slice(videoKitStart, videoKitEnd) + ")",
  { detectComposerMediaIntent },
) as (prompt: string) => boolean;

describe("client media intent routing", () => {
  it.each([
    "Create a video script about the solar system.",
    "Generate a prompt for an image of a mountain landscape.",
    "Create a photo editing app that organizes images.",
    "Create an app for editing photos.",
    "Create a logo prompt for a neighborhood coffee shop.",
    "video ki script bana do",
    "photo editing app banao",
    "write a script for a video about the solar system",
    "Create a script for a video about the solar system.",
    "Create an image description for a mountain landscape.",
    "Mere video ke liye do templates aur prompt likh do.",
    "Write two prompts for a video about photosynthesis.",
    "मेरे वीडियो के लिए दो टेम्पलेट्स और प्रॉम्प्ट लिख दो.",
    "Write two templates and prompts for my video.",
    "Give me two video templates about space.",
    "Give me two templates for a video about space.",
    "video ke liye do template de do",
    "मेरे वीडियो के लिए दो टेम्पलेट दे दो.",
  ])("keeps text and software deliverables on normal chat: %s", prompt => {
    expect(detectComposerMediaIntent(prompt)).toBeNull();
  });

  it.each([
    ["Create an image of a mountain at sunrise.", "image"],
    ["Create a poster for our school science exhibition.", "image"],
    ["Create a short video about the solar system.", "video"],
    ["Create a video showing a script being written on paper.", "video"],
    ["Mere liye ek video bana do.", "video"],
    ["मेरे लिए एक वीडियो बना दो.", "video"],
  ] as const)("preserves explicit visual deliverables: %s", (prompt, expected) => {
    expect(detectComposerMediaIntent(prompt)).toBe(expected);
  });
  it("recognizes a video creative kit request without starting a video render", () => {
    expect(detectComposerVideoKitIntent("Mere video ke liye do templates aur prompt likh do.")).toBe(true);
    expect(detectComposerVideoKitIntent("Write a storyboard and voiceover for my video.")).toBe(true);
    expect(detectComposerVideoKitIntent("Give me two video templates about space.")).toBe(true);
    expect(detectComposerVideoKitIntent("Give me two templates for a video about space.")).toBe(true);
    expect(detectComposerVideoKitIntent("video ke liye do template de do")).toBe(true);
    expect(detectComposerVideoKitIntent("मेरे वीडियो के लिए दो टेम्पलेट दे दो.")).toBe(true);
    expect(detectComposerVideoKitIntent("मेरे वीडियो के लिए दो टेम्पलेट्स और प्रॉम्प्ट लिख दो.")).toBe(true);
    expect(detectComposerVideoKitIntent("How do I write a prompt for a video?")).toBe(false);
    expect(detectComposerVideoKitIntent("Create a short video about the solar system.")).toBe(false);
  });

  it("detects edit requests for exactly one readable uploaded ZIP", () => {
    const uploaded = [{ name: "records.zip", mimeType: "application/zip", rawFile: { arrayBuffer() {} } }];
    expect(wantsUploadedZipEdit("Is record mein naya status likh do.", uploaded)).toBe(true);
    expect(wantsUploadedZipEdit("Update the matching CSV record in this archive.", uploaded)).toBe(true);
    expect(wantsUploadedZipEdit("How do I edit a ZIP file?", uploaded)).toBe(false);
    expect(wantsUploadedZipEdit("Update this file.", [])).toBe(false);
    expect(wantsUploadedZipEdit("Write in this record.", [...uploaded, { ...uploaded[0], name: "other.zip" }])).toBe(false);
  });

});
