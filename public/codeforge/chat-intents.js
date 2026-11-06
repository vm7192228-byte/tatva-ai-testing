/**
 * Detect only an explicit request for a downloadable PDF.
 * Notes, reports, certificates, and other long answers stay in normal chat
 * unless the user specifically asks for PDF output.
 */
const PDF_MENTION_PATTERN = /\bpdf\b|पीडीएफ/i;

const DIRECT_PDF_DELIVERY_PATTERN =
  /\b(?:give me|provide|send me|i need|i want|can i get)\s+(?:(?:a|an|the|some|my)\s+)?pdf\b|(?:mujhe\s+(?:ek\s+)?pdf\s+chahiye)|(?:pdf\s+(?:chahiye|de\s+do|bhej\s+do))|(?:मुझे\s+(?:एक\s+)?पीडीएफ\s+चाहिए)|(?:पीडीएफ\s+(?:चाहिए|दे दो|भेज दो))/i;

const DIRECT_PDF_ACTION_PATTERN =
  /\b(?:make|create|generate|prepare|build|export|download|save|convert|turn into)\b.{0,48}\bpdf\b|\b(?:as|into)\s+(?:a\s+)?pdf\b|\bin\s+(?:a\s+)?pdf\s+format\b|(?:पीडीएफ\s*(?:फॉर्मेट|फ़ॉर्मेट|फाइल|फ़ाइल|में).{0,28}(?:बना|बनाओ|बनाइए|बना दो|बनाकर|दे|दें|चाहिए|भेज|बदल|सेव|निर्यात))|(?:pdf\s*(?:mein|me|में|format|file).{0,28}(?:bana|banao|banaiye|bana do|de do|chahiye|चाहिए|bhej|save|export))/i;

const INFORMATIONAL_QUESTION_PATTERN =
  /^(?:(?:please\s+)?(?:how|what|why|explain|summari[sz]e|translate|read|review|analy[sz]e|inspect|describe|tell me|repeat|rephrase)\b|(?:can|could)\s+you\s+(?:explain|tell me|help me understand)\b|(?:कैसे|क्या|क्यों|बताओ|बताइए|समझाओ|समझाइए|अनुवाद))/i;

const ASKING_TO_CREATE_PDF_PATTERN =
  /^(?:(?:can|could|would)\s+you\s+(?:please\s+)?(?:make|create|generate|prepare|export|save|convert)\b.{0,48}\bpdf\b|क्या\s+(?:आप|तुम)\s*(?:भी\s*)?pdf\s*(?:बना|बनाओ|बना सकते|तैयार|दे))/i;

export function detectComposerDocumentIntent(prompt) {
  const text = String(prompt || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || !PDF_MENTION_PATTERN.test(text)) return null;

  const directDelivery = DIRECT_PDF_DELIVERY_PATTERN.test(text);
  const asksToCreate = ASKING_TO_CREATE_PDF_PATTERN.test(text);
  if (INFORMATIONAL_QUESTION_PATTERN.test(text) && !directDelivery && !asksToCreate) {
    return null;
  }

  return directDelivery || asksToCreate || DIRECT_PDF_ACTION_PATTERN.test(text)
    ? "pdf"
    : null;
}
