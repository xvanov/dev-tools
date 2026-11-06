'use strict';

// What a Web Speech `onerror` code means for the person holding the phone.
//
// The mic loop used to collapse every code into two messages: "microphone
// blocked for this site" (for both `not-allowed` AND `service-not-allowed`) and,
// after five failures of anything else, "speech recognition keeps failing". On
// iOS those are the wrong words for the commonest real causes — Dictation turned
// off, the mic held by another tab (the PA's /pa/talk page keeps a getUserMedia
// stream open), or Apple's speech service unreachable — and the user reported
// "weird errors" with no way to tell which. Each code now names its cause and
// the one thing to do about it, and the raw code stays in the text so a
// screenshot is a diagnosis.
//
// Pure (no DOM, no state) so test/speechErrors.test.js can pin it. Loads as a
// plain <script> (`window.SpeechErrors`) and as a CommonJS module in node, like
// voiceCommands.js.

(function (root) {
  // Codes that are the loop's ordinary rhythm, not failures (see AGENT.md,
  // "Things that are easy to get wrong here").
  const BENIGN = new Set(['aborted', 'no-speech']);

  // Terminal: retrying cannot help until the user changes a setting.
  const TERMINAL = new Set(['not-allowed', 'service-not-allowed']);

  // `ctx` = { ios, standalone } — both change the advice, never the category.
  function describe(code, ctx = {}) {
    const c = String(code || 'unknown');
    const ios = !!ctx.ios;
    const standalone = !!ctx.standalone;
    switch (c) {
      case 'not-allowed':
        return ios
          ? 'Microphone blocked for this site — in Safari tap aA › Website Settings › Microphone › Allow, then tap 🎤 (not-allowed)'
          : 'Microphone blocked for this site — allow it from the lock icon in the address bar, then tap 🎤 (not-allowed)';
      case 'service-not-allowed':
        // Not a site permission at all. On iOS this is Dictation/Siri being off
        // or restricted, and historically the home-screen (standalone) mode.
        if (ios && standalone) {
          return 'Speech recognition is not available in the home-screen app — open termhub in Safari, or turn on Settings › General › Keyboard › Enable Dictation (service-not-allowed)';
        }
        return ios
          ? 'Speech recognition is turned off on this iPhone — turn on Settings › General › Keyboard › Enable Dictation (and Siri), then tap 🎤 (service-not-allowed)'
          : 'This browser refused its speech service — check that speech recognition is enabled, then tap 🎤 (service-not-allowed)';
      case 'audio-capture':
        return 'Could not get the microphone — another tab or app is using it (the PA talk page, a call, a recorder). Close it and tap 🎤 (audio-capture)';
      case 'network':
        return ios
          ? 'Apple\'s speech service is unreachable — dictation needs the phone\'s internet, not just the tailnet (network)'
          : 'The browser\'s speech service is unreachable — recognition runs in the cloud and needs internet (network)';
      case 'language-not-supported':
        return 'Speech recognition does not support this language — switching to English (language-not-supported)';
      case 'bad-grammar':
        return 'Speech recognition rejected its settings (bad-grammar)';
      default:
        return `Speech recognition failed (${c}) — tap 🎤 to retry`;
    }
  }

  const api = {
    describe,
    isBenign: (code) => BENIGN.has(code),
    isTerminal: (code) => TERMINAL.has(code),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpeechErrors = api;
}(typeof self !== 'undefined' ? self : this));
