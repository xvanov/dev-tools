'use strict';

// Wake-word and command-parser tests. Plain node, no framework, no deps:
//   node test/voiceCommands.test.js
//
// This file exists because the wake word is the one piece of the voice loop
// whose failures are silent. A miss makes the user repeat themselves; a false
// positive swallows an instruction meant for Claude and nobody finds out. The
// near-miss table below is the real point of the suite — the accepted-variant
// table only proves the feature works at all.

const V = require('../web/voiceCommands');

let pass = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass += 1; return; }
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

function show(label, rows) {
  console.log(`\n${label}`);
  for (const r of rows) console.log('  ' + r);
}

// ---- 1. accepted wake-word variants -----------------------------------------
// Every one of these must produce the `wait` command.

const ACCEPTED = [
  'Sputnik wait',
  'sputnik wait',
  'Sputnik, wait.',
  'sputnick wait',
  'sputnic wait',
  'sputnix wait',
  'spudnik wait',
  'spudnick wait',
  'spootnik wait',
  'sputneek wait',
  'sput nik wait',
  'sput nick wait',
  'spud nik wait',
  'spud nick wait',
  'spot nick wait',      // weak variant, but a real command follows
  'Sputnik hold on',
  'Sputnik please wait',
];

{
  const rows = [];
  for (const utterance of ACCEPTED) {
    const got = V.parse(utterance);
    const ok = !!got && got.command === 'wait';
    check(`accept: ${utterance}`, ok, got ? `got ${got.command}` : 'no match');
    rows.push(`${ok ? 'OK  ' : 'FAIL'}  ${JSON.stringify(utterance).padEnd(26)} -> ${got ? got.command + ' (' + got.strength + ')' : 'dictation'}`);
  }
  show('accepted wake-word variants (all must be `wait`)', rows);
}

// ---- 2. near misses: ordinary dictation that must NOT trigger ---------------
// The expensive failure. Each of these has to come back as dictation (null),
// so the words reach the agent untouched.

const NEAR_MISSES = [
  'spot the bug in the nickname parser',
  "let's put Nick on it",
  'the sputtering build keeps failing',
  'we launched Sputnik in 1957',
  'the Sputnik launch was in October',
  'put Nick on the review',
  'spot check the nightly run',
  'sputtering',
  'nick, can you wait',
  'spot a pattern in the logs',
  'this is a hub and spoke architecture',
  "let's turn up the log level",
  'turn up the verbosity in the config',
  'wait for the build to finish',
  'send it to the staging bucket',
  'close this file and open the other one',
  'stop the deployment please',
  'read that again from the top',
  'switch to the feature branch',
  'clear the cache first',
  'never mind the failing test',
  'new terminal windows keep opening',
  'what is running on port 8080',
  'mute the notifications in slack',
];

{
  const rows = [];
  for (const utterance of NEAR_MISSES) {
    const got = V.parse(utterance);
    const ok = got === null;
    check(`reject: ${utterance}`, ok, got ? `fired ${got.command}` : '');
    rows.push(`${ok ? 'OK  ' : 'FAIL'}  ${JSON.stringify(utterance).padEnd(46)} -> ${got ? 'COMMAND ' + got.command : 'dictation'}`);
  }
  show('near misses (all must stay dictation)', rows);
}

// ---- 3. the wake word only counts at the start ------------------------------

{
  const rows = [];
  const midSentence = [
    'we launched Sputnik in 1957',
    'the satellite Sputnik wait no I mean Explorer',
    'call the service sputnik and wait for it',
    'rename it to sputnik',
  ];
  for (const utterance of midSentence) {
    const got = V.parse(utterance);
    const ok = got === null;
    check(`mid-sentence: ${utterance}`, ok, got ? `fired ${got.command}` : '');
    rows.push(`${ok ? 'OK  ' : 'FAIL'}  ${JSON.stringify(utterance).padEnd(50)} -> ${got ? 'COMMAND ' + got.command : 'dictation'}`);
  }
  show('wake word mid-utterance (must stay dictation)', rows);
}

// ---- 4. a strong wake word with an unparseable tail -------------------------
// Must NOT become dictation: "Sputnik frobnicate the widget" landing in the
// prompt is the outcome the wake word exists to prevent.

{
  const rows = [];
  for (const utterance of ['Sputnik frobnicate the widget', 'sputnik', 'Sputnik asdf qwer']) {
    const got = V.parse(utterance);
    const ok = !!got && got.command === 'unknown';
    check(`unknown: ${utterance}`, ok, got ? got.command : 'became dictation');
    rows.push(`${ok ? 'OK  ' : 'FAIL'}  ${JSON.stringify(utterance).padEnd(34)} -> ${got ? got.command : 'dictation'}`);
  }
  // …whereas a WEAK variant with an unparseable tail is just speech.
  const weak = V.parse('spot nick the difference');
  check('weak + gibberish stays dictation', weak === null, weak ? weak.command : '');
  rows.push(`${weak === null ? 'OK  ' : 'FAIL'}  ${JSON.stringify('spot nick the difference').padEnd(34)} -> ${weak ? weak.command : 'dictation'}`);
  show('strong wake + unrecognised tail (must be `unknown`, never dictation)', rows);
}

// ---- 5. every command in every group ----------------------------------------

const COMMAND_CASES = [
  ['Sputnik wait', 'wait', ''],
  ['Sputnik hold on', 'wait', ''],
  ['Sputnik send it', 'send', ''],
  ['Sputnik send that', 'send', ''],
  ['Sputnik scratch that', 'scratch', ''],
  ['Sputnik clear', 'scratch', ''],
  ['Sputnik never mind', 'nevermind', ''],
  ['Sputnik switch to sw factory', 'switch', 'sw factory'],
  ['Sputnik go to dev tools', 'switch', 'dev tools'],
  ["Sputnik what's running", 'list', ''],
  ['Sputnik list sessions', 'list', ''],
  ['Sputnik new terminal in dev tools', 'new', 'dev tools'],
  // Punctuation is normalised away, so a dictated path arrives as words. That
  // is fine and intended: the client fuzzy-matches the words against /api/recents
  // and /api/dirs rather than trying to reconstruct a literal path — nobody
  // successfully dictates slashes.
  ['Sputnik new session in /home/k/src', 'new', 'home k src'],
  ['Sputnik close this session', 'close', ''],
  ['Sputnik stop this session', 'stop', ''],
  ['Sputnik mute', 'mute', ''],
  ['Sputnik quiet', 'mute', ''],
  ['Sputnik unmute', 'unmute', ''],
  ['Sputnik read that again', 'again', ''],
  ['Sputnik read the last message in full', 'full', ''],
  ['Sputnik louder', 'louder', ''],
  ['Sputnik quieter', 'quieter', ''],
  ['Sputnik slower', 'slower', ''],
  ['Sputnik faster', 'faster', ''],
];

{
  const rows = [];
  for (const [utterance, command, arg] of COMMAND_CASES) {
    const got = V.parse(utterance);
    const ok = !!got && got.command === command && got.arg === arg;
    check(`command: ${utterance}`, ok, got ? `${got.command}/${JSON.stringify(got.arg)}` : 'no match');
    rows.push(`${ok ? 'OK  ' : 'FAIL'}  ${JSON.stringify(utterance).padEnd(42)} -> ${got ? got.command + (got.arg ? ' [' + got.arg + ']' : '') : 'dictation'}`);
  }
  show('command coverage', rows);
}

// ---- 6. "read the last message in full" must not be eaten by "read again" ---

{
  const full = V.parse('Sputnik read the last message in full');
  check('full beats again', full && full.command === 'full', full && full.command);
  const again = V.parse('Sputnik read that again');
  check('again still works', again && again.command === 'again', again && again.command);
}

// ---- 7. confirmations --------------------------------------------------------

{
  const rows = [];
  const yes = ['yes', 'Yes.', 'yeah', 'yep', 'do it', 'go ahead', 'confirm', 'please do it'];
  const no = ['no', 'nope', 'wait', 'not that one', 'cancel', 'yes but not that one', '', 'hmm'];
  for (const t of yes) {
    const ok = V.isAffirmative(t);
    check(`yes: ${t}`, ok);
    rows.push(`${ok ? 'OK  ' : 'FAIL'}  yes  ${JSON.stringify(t)}`);
  }
  for (const t of no) {
    const ok = !V.isAffirmative(t);
    check(`not-yes: ${t}`, ok);
    rows.push(`${ok ? 'OK  ' : 'FAIL'}  no   ${JSON.stringify(t)}`);
  }
  show('confirmation words (anything not clearly yes must cancel)', rows);
}

// ---- 8. fuzzy session matching -----------------------------------------------

{
  const sessions = [
    { id: 's1', title: 'sw-factory' },
    { id: 's2', title: 'dev-tools' },
    { id: 's3', title: 'termhub-voice' },
    { id: 's4', title: 'notes' },
  ];
  const rows = [];
  const cases = [
    ['sw factory', 'match', 's1'],
    ['s w factory', 'match', 's1'],
    ['swfactory', 'match', 's1'],
    ['dev tools', 'match', 's2'],
    ['devtools', 'match', 's2'],
    ['notes', 'match', 's4'],
    ['termhub voice', 'match', 's3'],
    ['voice', 'match', 's3'],
    ['completely unrelated thing', 'none', null],
  ];
  for (const [spoken, kind, id] of cases) {
    const got = V.matchSession(spoken, sessions);
    const ok = got.kind === kind && (kind !== 'match' || got.session.id === id);
    check(`session: ${spoken}`, ok, `${got.kind}${got.session ? ' ' + got.session.title : ''}`);
    rows.push(`${ok ? 'OK  ' : 'FAIL'}  ${JSON.stringify(spoken).padEnd(30)} -> ${got.kind}${got.session ? ': ' + got.session.title : ''}`);
  }

  // Two sessions with near-identical names must produce a question, not a coin flip.
  const twins = [{ id: 'a', title: 'api-server' }, { id: 'b', title: 'api-worker' }];
  const amb = V.matchSession('api', twins);
  check('ambiguous titles ask rather than guess', amb.kind === 'ambiguous' && amb.sessions.length === 2, amb.kind);
  rows.push(`${amb.kind === 'ambiguous' ? 'OK  ' : 'FAIL'}  ${JSON.stringify('api').padEnd(30)} -> ${amb.kind}${amb.sessions ? ': ' + amb.sessions.map((s) => s.title).join(', ') : ''}`);
  show('session title matching', rows);
}

// ---- 9. configurability -------------------------------------------------------

{
  V.configure({ wakeWord: 'jupiter' });
  const on = V.parse('jupiter send it');
  check('configured wake word fires', !!on && on.command === 'send', on && on.command);
  const off = V.parse('sputnik send it');
  check('old wake word stops firing', off === null, off && off.command);
  V.configure({ wakeWord: '' });   // back to the default
  check('empty config restores default', V.wakeWord() === V.DEFAULT_WAKE_WORD, V.wakeWord());
  const back = V.parse('sputnik send it');
  check('default restored', !!back && back.command === 'send', back && back.command);
  show('configurable wake word', [
    `OK    TERMHUB_WAKE_WORD=jupiter -> "jupiter send it" = ${on && on.command}, "sputnik send it" = ${off ? off.command : 'dictation'}`,
    `OK    default restored -> ${V.wakeWord()}`,
  ]);
}

// ---- 10. interim freeze detection ---------------------------------------------
// startsWithWake() drives the send-timer pause, so it must fire on a partial
// utterance the parser can't yet resolve.

{
  const rows = [];
  const partials = [['Sputnik', true], ['Sputnik sw', true], ['sput nik', true], ['spot nick', true],
    ['spot the', false], ['we launched', false], ['turn up the', false]];
  for (const [t, want] of partials) {
    const got = V.startsWithWake(t);
    check(`interim freeze: ${t}`, got === want, `${got}`);
    rows.push(`${got === want ? 'OK  ' : 'FAIL'}  ${JSON.stringify(t).padEnd(20)} -> freeze=${got}`);
  }
  show('interim wake detection (freezes the pending send timer)', rows);
}

// ---- summary ------------------------------------------------------------------

console.log(`\n${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length ? 1 : 0);
