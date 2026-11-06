// AudioWorklet half of web/voiceCapture.js: copy the mic's samples off the
// audio thread in ~1024-sample batches (8 render quanta — ~21 ms at 48 kHz),
// so the main thread gets a few dozen messages a second instead of hundreds.
// Mono: channel 0 only; the capture asks getUserMedia for one channel anyway.
class TermhubMicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf);
          this.buf = new Float32Array(1024);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('termhub-mic', TermhubMicProcessor);
