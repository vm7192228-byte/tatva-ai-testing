import { describe, expect, it } from "vitest";
import { detectComposerDocumentIntent } from "../../public/codeforge/chat-intents.js";

describe("explicit PDF output intent", () => {
  it.each([
    "Hello",
    "Hindi mein batao kya bola tumne",
    "हिंदी में बताओ क्या बोले तुम",
    "Translate your previous answer into Hindi",
    "Summarize this attached PDF",
    "What does this report say?",
    "I need help understanding this PDF",
    "Give me a summary of this PDF",
    "How do I create a PDF?",
    "How do I export a document to PDF?",
    "What is a PDF file?",
    "Explain the PDF format",
    "इस PDF में क्या लिखा है?",
    "पीडीएफ में क्या लिखा है?",
    "Please write a report about SQL joins",
    "Mujhe notes bana do",
    "Create a certificate template",
    "Create notes about SQL joins",
    "Prepare a report about Excel",
    "I want a detailed explanation of SQL joins",
  ])("keeps ordinary chat out of PDF mode: %s", (prompt) => {
    expect(detectComposerDocumentIntent(prompt)).toBeNull();
  });

  it.each([
    ["Create a PDF explaining Excel formulas", "pdf"],
    ["Turn this document into a PDF", "pdf"],
    ["Export this as PDF", "pdf"],
    ["Mujhe ek PDF chahiye", "pdf"],
    ["PDF de do", "pdf"],
    ["मुझे PDF में नोट्स चाहिए", "pdf"],
    ["PDF mein notes bana do", "pdf"],
    ["Send me a PDF", "pdf"],
    ["Can you create a PDF of these notes?", "pdf"],
    ["क्या आप PDF बना सकते हैं?", "pdf"],
  ])("detects an explicit PDF request: %s", (prompt, expected) => {
    expect(detectComposerDocumentIntent(prompt)).toBe(expected);
  });
});
