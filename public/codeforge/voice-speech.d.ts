export type VoiceReplyUtterance = {
  text: string;
  lang?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  voice?: SpeechSynthesisVoice | null;
  onstart?: (() => void) | null;
  onboundary?: ((event: { name?: string; charIndex: number }) => void) | null;
  onend?: (() => void) | null;
  onerror?: ((event: { error?: string }) => void) | null;
};

export type VoiceReplySynthesis = {
  speak(utterance: VoiceReplyUtterance): void;
  resume?(): void;
  cancel(): void;
};

export function cleanSpokenText(value: string): string;
export function nextSentenceEnd(text: string, final?: boolean): number;
export function createVoiceReplyPlayer(options: {
  synthesis: VoiceReplySynthesis;
  createUtterance(text: string): VoiceReplyUtterance;
  voice: SpeechSynthesisVoice | null | ((text: string) => SpeechSynthesisVoice | null);
  render(text: string): void;
  onDone(): void;
  onError(error: string): void;
  onSpeakingChange?(speaking: boolean): void;
  isCurrent(): boolean;
}): {
  append(text: string): void;
  flush(final: boolean): void;
  cancel(): void;
  readonly stopped: boolean;
};
