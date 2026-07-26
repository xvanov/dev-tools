'use strict';

// Voice commands: turning a speech-recognition transcript into an instruction
// for termhub itself, rather than dictation for the agent in the terminal.
//
// This file is pure — no DOM, no state, no side effects — because the wake word
// is the one part of the voice loop that has to be RIGHT and the only way to
// know it is to test it. It loads as a plain <script> in the browser (exporting
// `window.VoiceCommands`) and as a CommonJS module in node, which is how
// test/voiceCommands.test.js exercises it.
//
// THE WAKE WORD IS "SPUTNIK", AND THAT CHOICE IS THE DESIGN.
//
// An invented word ("termhub", the first attempt) is the worst possible wake
// word: the recogniser has never heard it, so it guesses, and it guesses
// differently every time — "term hub", "turn hub", "thermo". Catching that
// needs fuzzy matching, and fuzzy matching on a short target is exactly what
// starts eating ordinary speech. "Sputnik" is a proper noun already in iOS's
// vocabulary, distinctive, and in nobody's engineering dictation. It comes back
// clean, so it is matched EXACTLY, against a short deliberate list of the few
// ways it could still be split or slurred. There is no edit-distance fallback
// here on purpose — with a word this unusual it would buy nothing and cost
// false positives.
//
// Of the two failure modes, only one is expensive:
//
//   MISS        The user says it again. Annoying, recoverable, visible.
//   FALSE FIRE  An instruction meant for Claude is swallowed as a command and
//               silently never sent. Not recoverable, and not even noticed.
//
// So the bias is tight, and three rules enforce it:
//   1. PREFIX-ANCHORED. "we launched Sputnik in 1957" is text; only an
//      utterance that OPENS with the wake word is an instruction.
//   2. Variants that could plausibly be ordinary speech ("spot nick") are
//      AMBIGUOUS: they wake termhub only when a recognised command follows.
//      Clean hits are STRONG and wake it even when what follows is gibberish,
//      so a half-heard command is dropped rather than typed at the agent.
//   3. A leading function word ("the Sputnik launch") disqualifies the match.
//      Nobody addresses a machine as "the Sputnik".
//
// The word itself is CONFIGURABLE in exactly one place — DEFAULT_WAKE_WORD
// below, overridable at runtime by the server's TERMHUB_WAKE_WORD (it arrives
// on the /ws/voice `hello` and drives configure()). Changing it should never be
// a diff scattered across a matcher.

(function (root) {
  // ---- normalisation ---------------------------------------------------------

  // Speech recognition punctuates ("term-hub, wait."), capitalises, and
  // occasionally emits unicode quotes. None of it is signal.
  function normalize(text) {
    return String(text == null ? '' : text)
      .toLowerCase()
      .replace(/[‘’“”]/g, "'")
      .replace(/[^a-z0-9']+/g, ' ')
      .replace(/'/g, '')          // "what's" -> "whats", so one spelling matches
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Levenshtein, iterative, two rows. Short strings only — this runs on every
  // utterance on a phone.
  function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    let cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      const swap = prev; prev = cur; cur = swap;
    }
    return prev[b.length];
  }

  // ---- the wake word ---------------------------------------------------------

  // THE one place the wake word is chosen. The server may override it at
  // runtime with TERMHUB_WAKE_WORD (see configure()); this is the fallback and
  // the documented default.
  const DEFAULT_WAKE_WORD = 'sputnik';

  // Known mishearings, per wake word. Two tiers:
  //   strong  not words anybody dictates — safe to wake on alone.
  //   weak    could be a real phrase — only wakes when a command follows.
  // Add to this table as real mishearings are observed on the device; do not
  // reach for fuzzy matching instead. A curated list stays explainable, and
  // every entry here is one somebody actually heard.
  const KNOWN_VARIANTS = {
    sputnik: {
      strong: [
        'sputnik', 'sputnick', 'sputnic', 'sputnix', 'spudnik', 'spudnick',
        'spootnik', 'sputneek', 'sput nik', 'sput nick', 'spud nik', 'spud nick',
      ],
      // "spot nick" is the one split that is also pronounceable English, so it
      // needs a command behind it before it counts.
      weak: ['spot nick', 'spot nik', 'spotnik'],
    },
  };

  // Nobody addresses a machine as "the Sputnik". A leading function word means
  // this is a sentence about the word, not an instruction that starts with it.
  const LEADING_STOPWORDS = new Set([
    'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'our', 'your',
    'its', 'his', 'her', 'their', 'is', 'was', 'are', 'and', 'or', 'but', 'so',
    'to', 'in', 'on', 'at', 'of', 'for', 'with', 'from', 'it', 'he', 'she',
    'they', 'we', 'you', 'i', 'lets', 'let', 'please', 'can', 'could', 'would',
    'should', 'dont', 'do', 'did', 'go', 'just', 'now', 'then', 'if', 'when',
  ]);

  // Mutable so the server's TERMHUB_WAKE_WORD can win, rebuilt by configure().
  let WAKE = DEFAULT_WAKE_WORD;
  let STRONG = new Set();
  let AMBIGUOUS = new Set();
  let MAX_WAKE_TOKENS = 1;

  // Point the matcher at a different wake word. Unknown words get the word
  // itself (and its spaces-removed form) and nothing else — a curated variant
  // list can only be curated for a word somebody has actually tested.
  function configure(opts) {
    const word = normalize((opts && opts.wakeWord) || '') || DEFAULT_WAKE_WORD;
    WAKE = word;
    const known = KNOWN_VARIANTS[word] || { strong: [], weak: [] };
    STRONG = new Set([word, word.replace(/ /g, ''), ...known.strong].map(normalize).filter(Boolean));
    AMBIGUOUS = new Set((known.weak || []).map(normalize).filter(Boolean));
    // Longest variant decides how many leading tokens are worth testing, so a
    // two-token mishearing ("sput nik send it") is consumed whole.
    MAX_WAKE_TOKENS = 1;
    for (const v of [...STRONG, ...AMBIGUOUS]) {
      MAX_WAKE_TOKENS = Math.max(MAX_WAKE_TOKENS, v.split(' ').length);
    }
    return WAKE;
  }
  configure({ wakeWord: DEFAULT_WAKE_WORD });

  function wakeWord() { return WAKE; }

  // 'strong' | 'weak' | null for a candidate prefix, already normalised.
  function wakeStrength(candidate) {
    if (!candidate) return null;
    if (LEADING_STOPWORDS.has(candidate.split(' ')[0])) return null;
    if (STRONG.has(candidate)) return 'strong';
    if (AMBIGUOUS.has(candidate)) return 'weak';
    // A split variant may also arrive glued together, and vice versa.
    const joined = candidate.replace(/ /g, '');
    if (STRONG.has(joined)) return 'strong';
    if (AMBIGUOUS.has(joined)) return 'weak';
    return null;
  }

  // Split a normalised utterance into {strength, wake, rest}, or null if it
  // doesn't open with anything wake-like.
  function splitWake(normalized) {
    if (!normalized) return null;
    const tokens = normalized.split(' ');
    for (let n = Math.min(MAX_WAKE_TOKENS, tokens.length); n >= 1; n--) {
      const candidate = tokens.slice(0, n).join(' ');
      const strength = wakeStrength(candidate);
      if (strength) return { strength, wake: candidate, rest: tokens.slice(n).join(' ') };
    }
    return null;
  }

  // Does this (possibly interim, possibly half-finished) transcript look like
  // it is becoming a command? Used to freeze the pending send timer the moment
  // an interim starts with the wake word — see the note in web/app.js. Weak
  // wake words deliberately count here: pausing a timer costs nothing and is
  // undone the instant the final turns out to be dictation.
  function startsWithWake(text) {
    return !!splitWake(normalize(text));
  }

  // ---- the command table -----------------------------------------------------
  //
  // Ordered, and matched as a PREFIX of what follows the wake word, so
  // "send it now" and "send it, please" both land on `send`. Longer phrases
  // come first within a group so "read the last message in full" isn't eaten by
  // "read". `arg: true` means everything after the phrase is the argument.

  const COMMANDS = [
    // --- turn control ---------------------------------------------------------
    { id: 'wait', phrases: ['hold on a moment', 'hold on a sec', 'wait a moment', 'wait a second', 'hold that', 'hold on', 'hold up', 'hang on', 'one moment', 'one second', 'one sec', 'wait', 'hold'] },
    { id: 'send', phrases: ['send it now', 'send that now', 'send it', 'send that', 'send this', 'send now', 'submit that', 'submit it', 'submit', 'send'] },
    { id: 'scratch', phrases: ['scratch that', 'scratch all that', 'clear that', 'clear it', 'start over', 'start again', 'forget that', 'delete that', 'scratch', 'clear'] },
    { id: 'nevermind', phrases: ['never mind', 'nevermind', 'forget it', 'cancel that', 'cancel', 'stop listening', 'were done', 'im done', 'done'] },

    // --- announcements (before switching: "read the last message in full"
    //     must not be mistaken for anything with an argument) ------------------
    { id: 'full', phrases: ['read the last message in full', 'read the last message', 'read the whole message', 'read the full message', 'read that in full', 'read it in full', 'read it all', 'in full', 'full message', 'the whole thing'] },
    { id: 'again', phrases: ['read that again', 'say that again', 'read it again', 'repeat that', 'repeat it', 'say again', 'read again', 'repeat', 'again'] },
    { id: 'mute', phrases: ['be quiet', 'stop talking', 'stop announcing', 'shut up', 'mute', 'quiet', 'hush'] },
    { id: 'unmute', phrases: ['unmute yourself', 'start talking', 'talk to me', 'announce again', 'unmute'] },
    { id: 'louder', phrases: ['volume up', 'turn it up', 'turn up the volume', 'louder'] },
    { id: 'quieter', phrases: ['volume down', 'turn it down', 'turn down the volume', 'quieter', 'softer'] },
    { id: 'slower', phrases: ['slow down', 'slow it down', 'slower'] },
    { id: 'faster', phrases: ['speed up', 'speed it up', 'faster'] },

    // --- session lifecycle (before switching, so "new terminal in foo" isn't
    //     read as switching to a session called "terminal in foo") -------------
    { id: 'new', phrases: ['new terminal in', 'new session in', 'new terminal', 'new session', 'open a terminal in', 'open a terminal', 'start a session in'], arg: true },
    { id: 'close', phrases: ['close this session', 'close this terminal', 'close the session', 'close this', 'close session', 'close it', 'close'] },
    { id: 'stop', phrases: ['stop this session', 'stop this terminal', 'interrupt this session', 'stop what youre doing', 'stop this', 'interrupt this', 'interrupt'] },

    // --- session switching ----------------------------------------------------
    { id: 'list', phrases: ['whats running', 'what is running', 'list sessions', 'list the sessions', 'list all sessions', 'whats open', 'what sessions are there', 'which sessions are running', 'sessions'] },
    { id: 'switch', phrases: ['switch to the', 'switch to', 'switch over to', 'go to the', 'go to', 'jump to', 'take me to', 'open the session', 'talk to', 'switch'], arg: true },
  ];

  // Words a command phrase may be padded with and still match, so "termhub
  // please send it" works. Stripped after the wake word, before matching.
  const FILLERS = new Set(['please', 'could', 'you', 'can', 'would', 'just', 'now', 'ok', 'okay', 'um', 'uh']);

  function stripFillers(rest) {
    const tokens = rest.split(' ').filter(Boolean);
    while (tokens.length && FILLERS.has(tokens[0])) tokens.shift();
    return tokens.join(' ');
  }

  function matchCommand(rest) {
    const body = stripFillers(rest);
    if (!body) return null;
    for (const cmd of COMMANDS) {
      for (const phrase of cmd.phrases) {
        if (body === phrase) return { command: cmd.id, arg: '' };
        if (body.startsWith(phrase + ' ')) {
          const tail = body.slice(phrase.length + 1).trim();
          // A phrase with no argument still matches when trailing words follow
          // ("send it, thanks"); it just ignores them.
          return { command: cmd.id, arg: cmd.arg ? tail : '' };
        }
      }
    }
    return null;
  }

  // ---- the one entry point ---------------------------------------------------

  // Returns null for dictation, or:
  //   {command, arg, wake, rest, strength}   a command to run
  //   {command: 'unknown', ...}              the wake word, then something we
  //                                          couldn't parse — acknowledge it and
  //                                          drop it, but NEVER pass it to the
  //                                          agent: a stray "Sputnik" in a
  //                                          prompt is worse than a lost
  //                                          sentence the user can repeat.
  function parse(text) {
    const split = splitWake(normalize(text));
    if (!split) return null;
    const hit = matchCommand(split.rest);
    if (hit) return { command: hit.command, arg: hit.arg, wake: split.wake, rest: split.rest, strength: split.strength };
    // A weak wake word with nothing recognisable behind it was never a command:
    // it was someone saying "spot Nick's change in the diff".
    if (split.strength !== 'strong') return null;
    return { command: 'unknown', arg: '', wake: split.wake, rest: split.rest, strength: split.strength };
  }

  // ---- confirmations ---------------------------------------------------------

  // Destructive commands wait for a spoken yes. Anything that is not clearly
  // affirmative cancels — the cost of a missed "yes" is saying it again; the
  // cost of a generous "yes" is a killed Claude session.
  const YES = new Set([
    'yes', 'yeah', 'yep', 'yup', 'yes please', 'yes do it', 'do it', 'go ahead',
    'confirm', 'confirmed', 'affirmative', 'correct', 'thats right', 'sure',
    'ok do it', 'yes go ahead', 'yes kill it', 'kill it',
  ]);

  function isAffirmative(text) {
    const n = stripFillers(normalize(text));
    return YES.has(n);
  }

  // ---- fuzzy session matching -------------------------------------------------

  // Sidebar titles are things like "sw-factory" and "dev-tools", which speech
  // recognition returns as "s w factory" or "dev tools". So compare on the
  // spaces-removed forms as well as token by token, and never guess between two
  // plausible answers — the caller reads the candidates back instead.

  const MATCH_FLOOR = 0.45;   // below this, we don't have a match at all
  const AMBIGUOUS_GAP = 0.12; // two candidates this close are a question, not an answer

  function scoreTitle(spoken, title) {
    const a = normalize(spoken);
    const b = normalize(title);
    if (!a || !b) return 0;
    const aj = a.replace(/ /g, '');
    const bj = b.replace(/ /g, '');
    if (a === b || aj === bj) return 1;
    if (bj.startsWith(aj) || aj.startsWith(bj)) return 0.9;
    if (bj.includes(aj) || aj.includes(bj)) return 0.8;

    const at = a.split(' ');
    const bt = b.split(' ');
    let hits = 0;
    for (const tok of at) {
      if (bt.some((x) => x === tok || (tok.length > 3 && x.includes(tok)) || (x.length > 3 && tok.includes(x)))) hits += 1;
    }
    const overlap = hits / at.length;

    // Similarity on the joined forms catches a title heard slightly wrong
    // ("swift factory" for "sw-factory") that shares no whole token.
    const dist = editDistance(aj, bj);
    const sim = 1 - dist / Math.max(aj.length, bj.length);

    return Math.max(overlap * 0.75, sim > 0.6 ? sim * 0.75 : 0);
  }

  // sessions: [{id, title, ...}]. Returns
  //   {kind:'match', session}  |  {kind:'ambiguous', sessions}  |  {kind:'none'}
  function matchSession(spoken, sessions) {
    const list = (sessions || []).filter((s) => s && s.title);
    if (!spoken || !list.length) return { kind: 'none' };
    const scored = list
      .map((s) => ({ session: s, score: scoreTitle(spoken, s.title) }))
      .sort((x, y) => y.score - x.score);
    if (!scored.length || scored[0].score < MATCH_FLOOR) return { kind: 'none' };
    const close = scored.filter((x) => x.score >= MATCH_FLOOR && scored[0].score - x.score <= AMBIGUOUS_GAP);
    if (close.length > 1) return { kind: 'ambiguous', sessions: close.map((x) => x.session) };
    return { kind: 'match', session: scored[0].session };
  }

  const api = {
    normalize, editDistance, parse, startsWithWake, splitWake, wakeStrength,
    isAffirmative, matchSession, scoreTitle, configure, wakeWord, COMMANDS,
    DEFAULT_WAKE_WORD,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoiceCommands = api;
}(typeof self !== 'undefined' ? self : this));
