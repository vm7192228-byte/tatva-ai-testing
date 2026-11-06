// Build a stable transcript from the complete Web Speech API result list.
// Mobile speech services can occasionally repeat or overlap final result chunks.
// Merge by word-boundary overlap instead of blindly concatenating those chunks.
function tokenKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, "");
}

function collapseImmediateRepeatedPhrases(value) {
  const words = String(value || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  let changed = true;

  // Collapse an immediately repeated phrase of 3–12 words. This targets a
  // duplicated recognition segment without flattening normal single-word emphasis.
  while (changed) {
    changed = false;
    const maxPhraseLength = Math.min(12, Math.floor(words.length / 2));
    for (let size = maxPhraseLength; size >= 3 && !changed; size -= 1) {
      for (let start = 0; start + size * 2 <= words.length; start += 1) {
        let matches = true;
        for (let offset = 0; offset < size; offset += 1) {
          if (tokenKey(words[start + offset]) !== tokenKey(words[start + size + offset])) {
            matches = false;
            break;
          }
        }
        if (matches) {
          words.splice(start + size, size);
          changed = true;
          break;
        }
      }
    }
  }

  return words.join(" ");
}

function appendRecognitionSegment(existing, incoming) {
  const current = String(existing || "").replace(/\s+/g, " ").trim();
  const next = String(incoming || "").replace(/\s+/g, " ").trim();
  if (!current) return collapseImmediateRepeatedPhrases(next);
  if (!next) return collapseImmediateRepeatedPhrases(current);

  const currentWords = current.split(" ");
  const nextWords = next.split(" ");
  const currentKeys = currentWords.map(tokenKey);
  const nextKeys = nextWords.map(tokenKey);

  if (currentKeys.join(" ") === nextKeys.join(" ")) {
    return collapseImmediateRepeatedPhrases(current);
  }

  // Some speech engines revise an interim result by returning the full phrase
  // again with additional words. Prefer the longer cumulative version instead
  // of appending that whole phrase to itself.
  const currentIsPrefix = currentKeys.length < nextKeys.length &&
    currentKeys.every((word, index) => word && word === nextKeys[index]);
  if (currentIsPrefix) return collapseImmediateRepeatedPhrases(next);

  const nextIsPrefix = nextKeys.length < currentKeys.length &&
    nextKeys.every((word, index) => word && word === currentKeys[index]);
  if (nextIsPrefix) return collapseImmediateRepeatedPhrases(current);

  // Remove the largest overlap between the end of the existing transcript and
  // the beginning of the incoming segment (for example "how are" + "are you").
  const maxOverlap = Math.min(16, currentWords.length, nextWords.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const left = currentKeys.slice(-overlap);
    const right = nextKeys.slice(0, overlap);
    if (left.every((word, index) => word && word === right[index])) {
      const remainder = nextWords.slice(overlap).join(" ");
      return collapseImmediateRepeatedPhrases(
        remainder ? current + " " + remainder : current
      );
    }
  }

  return collapseImmediateRepeatedPhrases(current + " " + next);
}

export function readRecognitionTranscript(results) {
  let finalText = "";
  let interimText = "";

  for (let index = 0; index < (results?.length || 0); index += 1) {
    const result = results[index];
    const transcript = String(result?.[0]?.transcript || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!transcript) continue;

    if (result.isFinal) {
      finalText = appendRecognitionSegment(finalText, transcript);
    } else {
      interimText = appendRecognitionSegment(interimText, transcript);
    }
  }

  return { finalText, interimText };
}

export function combineRecognitionText(finalText, interimText) {
  return appendRecognitionSegment(finalText, interimText);
}
