export type PersistentVoiceInputOptions = {
  onTranscript?: (transcript: string) => void | Promise<void>;
  onState?: (state: "listening" | "recording" | "transcribing" | "speaking" | "stopped") => void;
  onError?: (error: unknown) => void;
  uploadAudio?: (
    blob: Blob,
    signal: AbortSignal,
  ) => Promise<{
    storagePath: string;
    mimeType: string;
    size: number;
    cleanup?: () => void | Promise<void>;
  } | null>;
  silenceMs?: number;
  minSpeechMs?: number;
};

export class PersistentVoiceInput {
  constructor(options?: PersistentVoiceInputOptions);
  onTranscript?: PersistentVoiceInputOptions["onTranscript"];
  onState?: PersistentVoiceInputOptions["onState"];
  onError?: PersistentVoiceInputOptions["onError"];
  silenceMs: number;
  minSpeechMs: number;
  stream: MediaStream | null;
  context: AudioContext | null;
  source: MediaStreamAudioSourceNode | null;
  gain: GainNode | null;
  destination: MediaStreamAudioDestinationNode | null;
  analyser: AnalyserNode | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  monitorId: number | null;
  speechStartedAt: number;
  lastVoiceAt: number;
  isAISpeaking: boolean;
  isActive: boolean;
  isRecording: boolean;
  isTranscribing: boolean;
  lastTranscriptAt: number;
  sessionId: number;
  startPromise: Promise<void> | null;
  transcriptionController: AbortController | null;
  isCurrentSession(sessionId: number): boolean;
  start(): Promise<void>;
  startSession(sessionId: number): Promise<void>;
  monitor(): void;
  beginRecording(now: number): void;
  stopRecording(): void;
  finishRecording(sessionId?: number): Promise<void>;
  setAISpeaking(speaking: boolean): void;
  stop(): Promise<void>;
}
