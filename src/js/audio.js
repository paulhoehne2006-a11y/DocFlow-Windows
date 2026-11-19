// Lecture Audio Recording & Playback with stroke-level audioOffsetMs sync.
// Plays both existing Android `.m4a` recordings and new Windows `.webm` recordings stored
// inside the `.docflownote` ZIP under `audio/`.

export class StudioAudioController {
  constructor({ onStateChange, onError } = {}) {
    this.onStateChange = onStateChange || (() => {});
    this.onError = onError || (() => {});

    this.notebook = null;
    this.mediaRecorder = null;
    this.mediaStream = null;
    this.chunks = [];
    this.recordingStartedAt = 0;
    this.recordingPageIndex = 0;
    this.isRecording = false;

    this.audioEl = new Audio();
    this.activeEntryName = null;
    this.activeUrl = null;
    this.isPlaying = false;
    this.playbackRate = 1;
    this.jumpMode = false;
    this.tickTimer = null;

    this.audioEl.addEventListener('ended', () => {
      this.isPlaying = false;
      this.stopTick();
      this.emit();
    });
    this.audioEl.addEventListener('pause', () => {
      this.isPlaying = false;
      this.stopTick();
      this.emit();
    });
    this.audioEl.addEventListener('play', () => {
      this.isPlaying = true;
      this.startTick();
      this.emit();
    });
  }

  attachNotebook(notebook) {
    if (this.isRecording) this.stopRecording().catch(() => {});
    this.stopPlayback();
    this.notebook = notebook;
    const list = notebook ? notebook.listAudioEntries() : [];
    this.activeEntryName = list[0]?.entryName ?? null;
    this.activeIndex = list.length ? 0 : -1;
    this.emit();
  }

  /**
   * Selects the [index]-th bookmark of `listAudioEntries()`. Android bookmarks can point into the
   * middle of a recording (`offsetMs`), so the playhead is moved there without starting playback.
   */
  selectBookmark(index) {
    const entries = this.notebook ? this.notebook.listAudioEntries() : [];
    const bookmark = entries[index];
    if (!bookmark) return;
    this.activeIndex = index;
    this.selectEntry(bookmark.entryName);
    this.setPositionMs(bookmarkOffsetMs(bookmark));
    this.emit();
  }

  /** Moves the playhead to [offsetMs] once the media metadata is available. */
  setPositionMs(offsetMs) {
    const targetSec = Math.max(0, (Number(offsetMs) || 0) / 1000);
    const apply = () => {
      const dur = this.audioEl.duration;
      this.audioEl.currentTime = Number.isFinite(dur) && dur > 0 ? Math.min(dur, targetSec) : targetSec;
    };
    if (this.audioEl.readyState >= 1) apply();
    else this.audioEl.addEventListener('loadedmetadata', apply, { once: true });
  }

  get currentOffsetMs() {
    if (this.isRecording) return Math.max(0, Date.now() - this.recordingStartedAt);
    if (this.audioEl && Number.isFinite(this.audioEl.currentTime)) return Math.round(this.audioEl.currentTime * 1000);
    return 0;
  }

  get durationMs() {
    if (this.audioEl && Number.isFinite(this.audioEl.duration)) return Math.round(this.audioEl.duration * 1000);
    const entry = this.notebook?.listAudioEntries().find((e) => e.entryName === this.activeEntryName);
    return entry?.durationMs || 0;
  }

  startTick() {
    this.stopTick();
    this.tickTimer = setInterval(() => this.emit(), 150);
  }

  stopTick() {
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  emit() {
    this.onStateChange({
      isRecording: this.isRecording,
      isPlaying: this.isPlaying,
      offsetMs: this.currentOffsetMs,
      durationMs: this.durationMs,
      playbackRate: this.playbackRate,
      activeEntryName: this.activeEntryName,
      activeIndex: this.activeIndex ?? -1,
      jumpMode: this.jumpMode,
      entries: this.notebook ? this.notebook.listAudioEntries() : [],
    });
  }

  async startRecording(pageIndex = 0) {
    if (!this.notebook || this.isRecording) return false;
    this.stopPlayback();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      this.onError('audioMicDenied');
      return false;
    }
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
      this.chunks = [];
      this.mediaRecorder = mimeType ? new MediaRecorder(this.mediaStream, { mimeType }) : new MediaRecorder(this.mediaStream);
      this.mediaRecorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
      };
      this.recordingStartedAt = Date.now();
      this.recordingPageIndex = pageIndex;
      this.isRecording = true;
      this.mediaRecorder.start(250);
      this.startTick();
      this.emit();
      return true;
    } catch {
      this.cleanupStream();
      this.onError('audioMicDenied');
      return false;
    }
  }

  async stopRecording() {
    if (!this.isRecording || !this.mediaRecorder) return null;
    const durationMs = Math.max(0, Date.now() - this.recordingStartedAt);
    const recorder = this.mediaRecorder;
    this.isRecording = false;
    this.stopTick();
    const blob = await new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' }));
      try { recorder.stop(); } catch { resolve(new Blob(this.chunks)); }
    });
    this.cleanupStream();
    this.mediaRecorder = null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.length || !this.notebook) {
      this.emit();
      return null;
    }
    const ext = (recorder.mimeType || '').includes('mp4') ? 'm4a' : 'webm';
    const bookmark = this.notebook.addAudioEntry(bytes, {
      ext,
      pageIndex: this.recordingPageIndex,
      durationMs,
    });
    this.activeEntryName = bookmark.entryName;
    this.activeIndex = this.notebook.listAudioEntries().findIndex((e) => e.entryName === bookmark.entryName);
    this.emit();
    return bookmark;
  }

  cleanupStream() {
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
  }

  selectEntry(entryName) {
    if (!this.notebook?.entries[entryName]) return;
    if (this.activeEntryName === entryName && this.activeUrl) return;
    this.stopPlayback();
    this.activeEntryName = entryName;
    const bytes = this.notebook.entries[entryName];
    const mime = entryName.endsWith('.m4a') ? 'audio/mp4'
      : entryName.endsWith('.mp3') ? 'audio/mpeg'
      : entryName.endsWith('.wav') ? 'audio/wav'
      : 'audio/webm';
    this.activeUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    this.audioEl.src = this.activeUrl;
    this.audioEl.playbackRate = this.playbackRate;
    this.emit();
  }

  async togglePlay() {
    if (!this.notebook) return;
    const entries = this.notebook.listAudioEntries();
    if (!entries.length) return;
    if (!this.activeEntryName || !this.notebook.entries[this.activeEntryName]) {
      this.activeEntryName = entries[0].entryName;
      this.activeIndex = 0;
    }
    if (!this.activeUrl) {
      this.selectEntry(this.activeEntryName);
      const bookmark = entries[this.activeIndex] ?? entries.find((e) => e.entryName === this.activeEntryName);
      if (bookmark) this.setPositionMs(bookmarkOffsetMs(bookmark));
    }
    if (this.isPlaying) {
      this.audioEl.pause();
    } else {
      try { await this.audioEl.play(); } catch { /* autoplay blocked */ }
    }
  }

  async seekToMs(offsetMs) {
    if (!this.notebook) return;
    const entries = this.notebook.listAudioEntries();
    if (!entries.length) return;
    if (!this.activeEntryName) this.activeEntryName = entries[0].entryName;
    if (!this.activeUrl) this.selectEntry(this.activeEntryName);
    const targetSec = Math.max(0, offsetMs / 1000);
    if (this.audioEl.readyState >= 1) {
      this.audioEl.currentTime = Math.min(this.audioEl.duration || targetSec, targetSec);
    } else {
      this.audioEl.addEventListener('loadedmetadata', () => {
        this.audioEl.currentTime = Math.min(this.audioEl.duration || targetSec, targetSec);
      }, { once: true });
    }
    try { await this.audioEl.play(); } catch { /* ignore */ }
    this.emit();
  }

  setPlaybackRate(rate) {
    this.playbackRate = rate;
    this.audioEl.playbackRate = rate;
    this.emit();
  }

  setJumpMode(enabled) {
    this.jumpMode = !!enabled;
    this.emit();
  }

  stopPlayback() {
    this.audioEl.pause();
    this.audioEl.removeAttribute('src');
    if (this.activeUrl) URL.revokeObjectURL(this.activeUrl);
    this.activeUrl = null;
    this.isPlaying = false;
    this.stopTick();
  }

  dispose() {
    this.cleanupStream();
    this.stopPlayback();
  }
}

/** Start position of a bookmark inside its recording; Windows recordings always start at 0. */
export function bookmarkOffsetMs(bookmark) {
  const v = Number(bookmark?.offsetMs);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

export function formatAudioTime(ms) {
  const sec = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
