'use strict';

// What test/dashboardParity.test.js checks the dashboard's mutating routes against.
//
//   routes     one entry per route the test finds, keyed `<file> <path>` exactly as the test prints it:
//                { tool, verb }   the chat tool (src/mcp) and the `pa` verb (src/cli) that do the same;
//                                 a name, or a list when one route covers several actions. A tool must be an
//                                 action tool (it asks); a verb must not be on the chat's read-only list.
//                { exception }    deliberately no parity, and why
//                { gap }          missing parity that was already there when the test was written: debt, not a
//                                 policy. maxGaps only goes down; a new route gets a tool and a verb instead.
//   exceptFiles  whole modules with no parity by design (their routes are not listed above)
//
// Adding a dashboard write? Give it a chat tool and a `pa` verb through src/agentSettings.ts-style shared code,
// then add the entry here. The Agents page (agents.ts) is held to that with no gaps and no exceptions.

module.exports = {
  exceptFiles: {
    'talk.ts': 'voice transport: audio in, speech out, the page talking to the chat or to the local voice service; there is no agent-side equivalent of a microphone',
    'auth.ts': 'passkey sign-in and sign-out: a session cookie belongs to a browser; `pa passkeys status|reset` is the terminal side of the same store',
  },
  routes: {
    // ---- the Agents page: everything it writes, from the chat and the terminal ----
    'agents.ts /api/agents/settings': { tool: 'agent_settings_set', verb: 'agents set' },
    'agents.ts /api/agents/profiles/:name[/{delete|reset}]': { tool: ['profile_set', 'profile_delete', 'profile_reset'], verb: ['profile set', 'profile delete', 'profile reset'] },

    // ---- Build ----
    'buildBoard.ts /api/build/runs': { tool: 'build_start', verb: 'do' },
    'buildBoard.ts /api/build/:id/{stop|reply|send}': { tool: ['build_stop', 'build_reply', 'build_send'], verb: ['run stop', 'run reply', 'run send'] },
    'server.ts /api/commitments/:id/dispatch': { tool: 'build_start', verb: 'do' },
    'server.ts /api/commitments/:id/build-settings': { gap: 'a card\'s own model, effort and caps: build_start and pa do take them per run, but nothing stores them per card' },

    // ---- the board ----
    'server.ts /api/tasks': { tool: 'task_add', verb: 'task add' },
    'server.ts /api/commitments/:id/status': { verb: 'done' },
    'server.ts /api/commitments/:id/edit': { tool: 'card_edit', verb: 'card edit' },
    'server.ts /api/commitments/:id/block': { gap: 'whether what someone owes you blocks a task of yours: no chat tool or pa verb' },
    'server.ts /api/commitments/:id/reply': { verb: 'reply' },
    'server.ts /api/cardplans/:id/{apply|discard}': { tool: 'card_plan_apply', verb: 'cardplan apply' },
    'server.ts /api/proposals/:id/{accept|reject}': { verb: 'answer' },
    'server.ts /api/ledger/evidence/:id/{accept|reject}': { verb: 'ledger looks-done' },
    'server.ts /api/notifications/:id/feedback': { verb: 'notify feedback' },
    'server.ts /api/drafts/:id/{edit|deliver|sent|discard}': { gap: 'pa send opens a draft; editing, discarding and marking one sent have no verb' },
    'server.ts /api/sessions/:id/open': { verb: 'attach' },

    // ---- memory, meetings, routines, repos ----
    'memory.ts /remember': { tool: 'remember', verb: 'remember' },
    'memory.ts /claims/:id/{forget|reject|approve}': { verb: 'forget' },
    'memory.ts /people/distinct': { gap: 'marking two people as different: no verb' },
    'memory.ts /people/merge': { gap: 'merging two people: no verb' },
    'meetings.ts /api/meetings/brief': { verb: 'meeting brief' },
    'debriefs.ts /api/debriefs/run': { verb: 'meeting debrief' },
    'debriefs.ts /api/debriefs/:id/undo': { verb: 'meeting undo' },
    'server.ts /api/debriefs/import': { verb: 'meeting import' },
    'routines.ts /api/routines/parse': { verb: 'routine add' },
    'routines.ts /api/routines/preview': { verb: 'routine add' },
    'routines.ts /api/routines': { verb: 'routine add' },
    'routines.ts /api/routines/suggest': { verb: 'routine suggest' },
    'routines.ts /api/routines/:id/{run|dry-run|pause|resume|accept|reject|delete}': { verb: ['routine run', 'routine pause', 'routine accept', 'routine delete'] },
    "repos.ts if (method === 'POST' && parts.length === 1 && parts[0] === 'sync') {": { verb: 'repos sync' },
    "repos.ts if (method === 'POST' && parts.length === 2 && (parts[1] === 'hide' || parts[1] === 'unhide')) {": { verb: 'repos hide' },

    // ---- settings elsewhere ----
    "workflowLimits.ts } else if (req.method === 'POST') {": { gap: 'the workflow cost ceilings on the Map page: no verb' },

    // ---- deliberate exceptions ----
    'server.ts /api/chat/open': { exception: 'starts the PA chat session in termhub from the dashboard button; the chat cannot start itself' },
    'server.ts /api/chat': { exception: 'types into the PA chat: the chat is the agent, this is the human talking to it' },
    'server.ts /api/chat/permission': { exception: 'answers the chat\'s own permission prompt: the chat must never approve itself (it needs the page token on top of X-PA)' },
    'server.ts /api/chat/doorbell': { exception: 'the worker ringing the chat\'s INBOX bell: internal, not a setting' },
    'server.ts /api/secrets/:id/{fulfil|decline|done}': { exception: 'a pasted secret goes from the browser to the vault and never through the chat or a transcript; pa secret set is the terminal path' },
    'meter.ts /api/telemetry': { exception: 'the browser\'s telemetry beacon (spans); not a setting or an action' },
  },
  // Routes above recorded as `gap`. Only goes down.
  maxGaps: 6,
};
