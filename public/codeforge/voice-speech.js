// Browser-safe speech logic, also imported directly by the unit tests.
export function cleanSpokenText(value) {
  return String(value || "")
    .replace(/\[\[PRODUCT_CARD\|[^\]]+\]\]/g, " ")
    .replace(new RegExp("\\x60{3}[\\s\\S]*?(?:\\x60{3}|$)", "g"), " कोड चैट में दिखाया गया है। ")
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " लिंक ")
    .replace(/^[ \t]*\d+[.)][ \t]+/gm, "")
    .replace(/\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|[\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}\s,.!?;:।॥]/gu, " ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+([,.!?;:।॥])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Consume complete sentences while the server streams the response.
export function nextSentenceEnd(text, final = false) {
  let inFence = false;
  for (let i = 0; i < text.length; i++) {
    if (text.slice(i, i + 3) === String.fromCharCode(96, 96, 96)) { inFence = !inFence; i += 2; continue; }
    if (inFence) continue;
    const sentenceEnd = /[.!?।॥\n]/.test(text[i]);
    const clauseEnd = /[,;:،؛]/.test(text[i]) && i >= 56;
    const softWordEnd = /\s/.test(text[i]) && i >= 104;
    if (!sentenceEnd && !clauseEnd && !softWordEnd) continue;
    if (text[i] === "." && /(?:^|\n)[ \t]*\d+$/.test(text.slice(0, i))) continue;
    if (text[i] === "." && /\d/.test(text[i - 1] || "") && /\d/.test(text[i + 1] || "")) continue;
    let end = i + 1;
    while (end < text.length && /[.!?।॥*_\s]/.test(text[end])) end++;
    if (end < text.length || final || /[!?।॥\n]/.test(text[i])) return end;
  }
  return final ? text.length : 0;
}

export function createVoiceReplyPlayer({ synthesis, createUtterance, voice, render, onDone, onError, onSpeakingChange, isCurrent }) {
  let source = "", consumed = 0, revealed = 0;
  let ended = false, stopped = false, completed = false;
  const queue = [];
  // Keep two utterances in the native queue to reduce audible gaps.
  const inFlight = new Set();
  const reveal = end => {
    if (stopped || !isCurrent()) return;
    revealed = Math.max(revealed, end);
    render(source.slice(0, revealed));
  };
  const finish = () => {
    if (!ended || inFlight.size || queue.length || completed || stopped) return;
    completed = true;
    onSpeakingChange?.(false);
    reveal(source.length);
    onDone();
  };
  const pump = () => {
    if (stopped || !isCurrent()) return;
    while (queue.length && inFlight.size < 2) {
      const chunk = queue.shift();
      const spoken = cleanSpokenText(chunk.raw);
      if (!spoken) { reveal(chunk.end); continue; }
      const utterance = createUtterance(spoken);
      inFlight.add(utterance);
      const selectedVoice = typeof voice === "function" ? voice(spoken) : voice;
      const spokenLanguage = /[\u0900-\u097F]/.test(spoken) ? "hi-IN" : "en-IN";
      utterance.lang = spokenLanguage;
      if (selectedVoice) utterance.voice = selectedVoice;
      utterance.rate = 1.05;
      utterance.pitch = 1.02;
      utterance.volume = 1;

      const words = [...spoken.matchAll(/[\p{L}\p{M}\p{N}]+/gu)];
      let cursor = 0;
      const offsets = words.map(word => {
        const pos = chunk.raw.indexOf(word[0], cursor);
        if (pos >= 0) cursor = pos + word[0].length;
        return { spoken: word.index, raw: chunk.start + cursor };
      });
      utterance.onstart = () => {
        if (!inFlight.has(utterance) || stopped) return;
        onSpeakingChange?.(true);
        reveal(offsets[0]?.raw || chunk.start);
      };
      utterance.onboundary = event => {
        if (!inFlight.has(utterance) || stopped || event.name !== "word") return;
        const word = offsets.find(item => item.spoken >= event.charIndex);
        if (word) reveal(word.raw);
      };
      utterance.onend = () => {
        if (!inFlight.has(utterance) || stopped) return;
        inFlight.delete(utterance);
        reveal(chunk.end);
        pump();
      };
      utterance.onerror = event => {
        if (!inFlight.has(utterance) || stopped) return;
        player.cancel();
        onError(event.error || "speech-failed");
      };
      try { synthesis.resume?.(); } catch { /* Some speech engines do not expose resume. */ }
      synthesis.speak(utterance);
    }
    finish();
  };
  const player = {
    append(text) {
      if (stopped || ended) return;
      source += text;
      player.flush(false);
    },
    flush(final) {
      if (stopped) return;
      ended ||= final;
      let length;
      while ((length = nextSentenceEnd(source.slice(consumed), ended)) > 0) {
        const start = consumed;
        consumed += length;
        const raw = source.slice(start, consumed);
        const previous = queue[queue.length - 1];
        if (previous && previous.raw.length + raw.length <= 220) {
          previous.raw += raw;
          previous.end = consumed;
        } else {
          queue.push({ raw, start, end: consumed });
        }
      }
      pump();
    },
    cancel() {
      if (stopped) return;
      if (isCurrent()) render(source);
      stopped = true;
      onSpeakingChange?.(false);
      inFlight.clear();
      queue.length = 0;
      synthesis.cancel();
    },
    get stopped() { return stopped; },
  };
  return player;
}
