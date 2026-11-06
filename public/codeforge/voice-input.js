// Persistent microphone capture with software mute and silence-based turn detection.
export class PersistentVoiceInput {
  constructor({ onTranscript, onState, onError, uploadAudio, silenceMs = 1000, minSpeechMs = 350 } = {}) {
    this.onTranscript = onTranscript;
    this.onState = onState;
    this.onError = onError;
    this.uploadAudio = uploadAudio;
    this.silenceMs = silenceMs;
    this.minSpeechMs = minSpeechMs;
    this.stream = null;
    this.context = null;
    this.source = null;
    this.gain = null;
    this.destination = null;
    this.analyser = null;
    this.recorder = null;
    this.chunks = [];
    this.monitorId = null;
    this.speechStartedAt = 0;
    this.lastVoiceAt = 0;
    this.isAISpeaking = false;
    this.isActive = false;
    this.isRecording = false;
    this.isTranscribing = false;
    this.lastTranscriptAt = 0;
    this.sessionId = 0;
    this.startPromise = null;
    this.transcriptionController = null;
  }

  isCurrentSession(sessionId) {
    return this.isActive && sessionId === this.sessionId;
  }

  async start() {
    if (this.isActive && this.stream?.active) return;
    // A permission prompt can remain open while the user clicks repeatedly.
    // Reuse the in-flight start instead of opening duplicate microphone streams.
    if (this.startPromise) return this.startPromise;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !window.AudioContext) {
      throw new Error("This browser does not support audio streaming. Please use a recent version of Chrome or Edge.");
    }

    const sessionId = ++this.sessionId;
    const pending = this.startSession(sessionId);
    this.startPromise = pending;
    try {
      await pending;
    } finally {
      if (this.startPromise === pending) this.startPromise = null;
    }
  }

  async startSession(sessionId) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    // Stop a late permission grant if the user already ended this voice session.
    if (sessionId !== this.sessionId) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    this.stream = stream;
    try {
      this.context = new AudioContext();
      if (this.context.state === "suspended") await this.context.resume();
      if (sessionId !== this.sessionId) return;
      this.source = this.context.createMediaStreamSource(this.stream);
      this.gain = this.context.createGain();
      this.gain.gain.value = 1;
      this.destination = this.context.createMediaStreamDestination();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.source.connect(this.analyser);
      this.source.connect(this.gain);
      this.gain.connect(this.destination);
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type));
      this.recorder = mimeType ? new MediaRecorder(this.destination.stream, { mimeType }) : new MediaRecorder(this.destination.stream);
      this.recorder.addEventListener("dataavailable", event => {
        if (sessionId === this.sessionId && event.data?.size) this.chunks.push(event.data);
      });
      this.recorder.addEventListener("stop", () => { void this.finishRecording(sessionId); });
      this.isActive = true;
      this.onState?.("listening");
      this.monitor();
    } catch (error) {
      if (sessionId === this.sessionId) await this.stop();
      else stream.getTracks().forEach(track => track.stop());
      throw error;
    }
  }

  monitor() {
    if (!this.isActive || !this.analyser) return;
    const samples = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const value = (sample - 128) / 128;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / samples.length);
    const now = performance.now();
    const voiceDetected = rms > 0.035;

    if (!this.isAISpeaking && !this.isTranscribing && voiceDetected) {
      this.lastVoiceAt = now;
      if (!this.isRecording) this.beginRecording(now);
    } else if (this.isRecording && !this.isAISpeaking && now - this.lastVoiceAt >= this.silenceMs) {
      this.stopRecording();
    }

    this.monitorId = window.setTimeout(() => this.monitor(), 60);
  }

  beginRecording(now) {
    if (!this.isActive || this.isAISpeaking || !this.recorder || this.recorder.state !== "inactive") return;
    this.chunks = [];
    this.speechStartedAt = now;
    this.lastVoiceAt = now;
    this.isRecording = true;
    try {
      this.recorder.start();
      this.onState?.("recording");
    } catch (error) {
      this.isRecording = false;
      this.onError?.(error);
    }
  }

  stopRecording() {
    if (!this.isRecording) return;
    this.isRecording = false;
    if (this.recorder?.state === "recording") this.recorder.stop();
  }

  async finishRecording(sessionId = this.sessionId) {
    if (sessionId !== this.sessionId) return;
    const duration = performance.now() - this.speechStartedAt;
    const chunks = this.chunks;
    this.chunks = [];
    if (!this.isCurrentSession(sessionId) || this.isAISpeaking || duration < this.minSpeechMs || !chunks.length) {
      if (this.isCurrentSession(sessionId)) this.onState?.(this.isAISpeaking ? "speaking" : "listening");
      return;
    }
    const blob = new Blob(chunks, { type: this.recorder?.mimeType || "audio/webm" });
    if (!blob.size) return;
    const controller = new AbortController();
    this.transcriptionController = controller;
    this.isTranscribing = true;
    this.onState?.("transcribing");
    let uploadedAudio = null;
    try {
      let response;
      if (blob.size > 3 * 1024 * 1024) {
        if (typeof this.uploadAudio !== "function") {
          const error = new Error("This voice recording is over 3 MB. Sign in to upload larger voice turns securely.");
          error.status = 413;
          throw error;
        }
        uploadedAudio = await this.uploadAudio(blob, controller.signal);
        if (!uploadedAudio || typeof uploadedAudio.storagePath !== "string") {
          const error = new Error("This voice recording is too large for guest upload. Sign in to use secure direct uploads.");
          error.status = 413;
          throw error;
        }
        response = await fetch("/api/transcribe", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            storagePath: uploadedAudio.storagePath,
            mimeType: uploadedAudio.mimeType,
            size: uploadedAudio.size,
            language: "auto"
          }),
          signal: controller.signal,
        });
      } else {
        const form = new FormData();
        const extension = blob.type.includes("mp4") ? "m4a" : "webm";
        form.append("audio", blob, `voice-turn.${extension}`);
        form.append("language", "auto");
        response = await fetch("/api/transcribe", {
          method: "POST",
          credentials: "same-origin",
          body: form,
          signal: controller.signal,
        });
      }
      if (!this.isCurrentSession(sessionId) || controller.signal.aborted) return;
      const payload = await response.json().catch(() => ({}));
      if (!this.isCurrentSession(sessionId) || controller.signal.aborted) return;
      if (!response.ok) {
        const error = new Error(payload.message || "Speech transcription failed.");
        error.status = response.status;
        throw error;
      }
      const text = String(payload.text || "").trim();
      if (text && !this.isAISpeaking && Date.now() - this.lastTranscriptAt > 500) {
        this.lastTranscriptAt = Date.now();
        await this.onTranscript?.(text);
      }
    } catch (error) {
      if (this.isCurrentSession(sessionId) && !controller.signal.aborted) this.onError?.(error);
    } finally {
      try { await uploadedAudio?.cleanup?.(); } catch { /* Uploaded voice files are private and temporary. */ }
      if (this.transcriptionController === controller) this.transcriptionController = null;
      if (this.isCurrentSession(sessionId)) {
        this.isTranscribing = false;
        this.onState?.(this.isAISpeaking ? "speaking" : "listening");
      }
    }
  }

  setAISpeaking(speaking) {
    this.isAISpeaking = Boolean(speaking);
    if (this.gain && this.context) {
      const now = this.context.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setTargetAtTime(this.isAISpeaking ? 0 : 1, now, 0.02);
    }
    if (this.isAISpeaking && this.isRecording) this.stopRecording();
    this.onState?.(this.isAISpeaking ? "speaking" : "listening");
  }

  async stop() {
    // Invalidate every callback from this session before releasing the devices.
    this.sessionId += 1;
    this.isActive = false;
    this.transcriptionController?.abort(new DOMException("The voice session was stopped.", "AbortError"));
    this.transcriptionController = null;
    this.isTranscribing = false;
    if (this.monitorId !== null) window.clearTimeout(this.monitorId);
    this.monitorId = null;
    this.isRecording = false;
    if (this.recorder?.state === "recording") {
      this.recorder.onstop = null;
      try { this.recorder.stop(); } catch {}
    }
    this.stream?.getTracks().forEach(track => track.stop());
    this.source?.disconnect();
    this.gain?.disconnect();
    this.analyser?.disconnect();
    this.destination?.stream.getTracks().forEach(track => track.stop());
    if (this.context && this.context.state !== "closed") {
      try { await this.context.close(); } catch {}
    }
    this.stream = null;
    this.context = null;
    this.source = null;
    this.gain = null;
    this.analyser = null;
    this.destination = null;
    this.recorder = null;
    this.chunks = [];
    this.onState?.("stopped");
  }
}
