const FEMALE_HINTS = /female|woman|zira|heera|priya|lekha|aditi|samantha|veena|susan|aria|jenny|sara|shimmer|nova|sonia|karen|kalpana|neerja|swara|raveena|hazel|eva|serena|tessa|moira/i;
const MALE_HINTS = /(^|[\s_-])(male|man)([\s_-]|$)|ravi|hemant|madhur|david|mark|guy|daniel|james|aarav|prabhat|microsoft.*(david|mark|guy)|google.*male|alex|fred|jorge|thomas|oliver/i;

export function speechVoiceGender(voice) {
  const name = String(voice?.name || "");
  if (FEMALE_HINTS.test(name)) return "female";
  if (MALE_HINTS.test(name)) return "male";
  return "unknown";
}

export function speechVoiceLanguage(voice) {
  const name = String(voice?.name || "");
  const lang = String(voice?.lang || "").toLowerCase();
  if (/^hi(?:-|$)/i.test(lang) || /hindi|हिन्दी|हिंदी/i.test(name)) return "hi";
  if (/^en(?:-|$)/i.test(lang) || /english/i.test(name)) return "en";
  return "unknown";
}

export function speechVoiceQuality(voice) {
  const name = String(voice?.name || "");
  const lang = String(voice?.lang || "");
  let score = 0;
  if (/natural|neural|online|premium|enhanced|multilingual/i.test(name)) score += 60;
  if (/google/i.test(name)) score += 28;
  if (/microsoft/i.test(name)) score += 16;
  if (voice?.localService === false) score += 12;
  if (/^hi-in$/i.test(lang)) score += 5;
  if (/^en-in$/i.test(lang)) score += 5;
  if (voice?.default) score += 2;
  return score;
}

export const SPEECH_VOICE_SLOTS = [
  { id: "hi-male", language: "hi", gender: "male", label: "Male · Hindi", preview: "नमस्ते! मैं तत्व AI हूँ। आज मैं आपकी किस तरह मदद कर सकता हूँ?" },
  { id: "hi-female", language: "hi", gender: "female", label: "Female · Hindi", preview: "नमस्ते! मैं तत्व AI हूँ। आज मैं आपकी किस तरह मदद कर सकती हूँ?" },
  { id: "en-male", language: "en", gender: "male", label: "Male · English", preview: "Hello! I’m Dhwani AI. How can I help you today?" },
  { id: "en-female", language: "en", gender: "female", label: "Female · English", preview: "Hello! I’m Dhwani AI. How can I help you today?" },
];

export function selectSpeechVoiceOptions(voices) {
  const available = Array.isArray(voices) ? voices : [];
  const used = new Set();
  const unknownByLanguage = { hi: 0, en: 0 };
  return SPEECH_VOICE_SLOTS.flatMap(slot => {
    const unused = available.filter(voice =>
      voice && speechVoiceLanguage(voice) === slot.language &&
      voice.voiceURI && !used.has(voice.voiceURI)
    );
    const exact = unused
      .filter(voice => speechVoiceGender(voice) === slot.gender)
      .sort((a, b) => speechVoiceQuality(b) - speechVoiceQuality(a));
    const candidates = exact.length
      ? exact
      : unused
          .filter(voice => speechVoiceGender(voice) === "unknown")
          .sort((a, b) => speechVoiceQuality(b) - speechVoiceQuality(a));
    const voice = candidates[0];
    if (!voice) return [];
    used.add(voice.voiceURI);
    const genderKnown = speechVoiceGender(voice) !== "unknown";
    const label = genderKnown
      ? slot.label
      : (slot.language === "hi" ? "Hindi" : "English") + " · Device Voice " + (++unknownByLanguage[slot.language]);
    return [{ ...slot, label, voice, genderKnown }];
  });
}

export function speechVoiceForText(selectedVoice, voices, text) {
  const available = Array.isArray(voices) ? voices.filter(Boolean) : [];

  // A user's explicit voice choice is a preference, not a suggestion. Keep the
  // same voice across Hindi/English turns for the whole conversation.
  if (selectedVoice?.voiceURI) {
    const pinned = available.find(voice => voice.voiceURI === selectedVoice.voiceURI);
    if (pinned) return pinned;
  }

  // Only choose by language when no explicitly selected voice is available.
  const targetLanguage = /[\u0900-\u097F]/.test(String(text || "")) ? "hi" : "en";
  return available
    .filter(voice => speechVoiceLanguage(voice) === targetLanguage)
    .sort((a, b) => speechVoiceQuality(b) - speechVoiceQuality(a))[0] || null;
}
