export type SpeechVoiceLike = {
  name?: string;
  lang?: string;
  voiceURI?: string;
  localService?: boolean;
  default?: boolean;
};

export type SpeechVoiceOption = {
  id: string;
  language: "hi" | "en";
  gender: "male" | "female";
  label: string;
  preview: string;
  voice: SpeechVoiceLike;
  genderKnown: boolean;
};

export function speechVoiceGender(voice: SpeechVoiceLike | null | undefined): "male" | "female" | "unknown";
export function speechVoiceLanguage(voice: SpeechVoiceLike | null | undefined): "hi" | "en" | "unknown";
export function speechVoiceQuality(voice: SpeechVoiceLike | null | undefined): number;
export const SPEECH_VOICE_SLOTS: readonly {
  id: string;
  language: "hi" | "en";
  gender: "male" | "female";
  label: string;
  preview: string;
}[];
export function selectSpeechVoiceOptions(voices: SpeechVoiceLike[]): SpeechVoiceOption[];
export function speechVoiceForText(
  selectedVoice: SpeechVoiceLike | null | undefined,
  voices: SpeechVoiceLike[],
  text: string,
): SpeechVoiceLike | null;
