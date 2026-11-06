export type SpeechRecognitionResultLike = Array<{ transcript?: string }> & {
  isFinal: boolean;
};

export function readRecognitionTranscript(results: SpeechRecognitionResultLike[]): {
  finalText: string;
  interimText: string;
};
export function combineRecognitionText(finalText: string, interimText: string): string;
