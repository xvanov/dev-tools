'use strict';

// SUPERSEDED: the ruleset opencode 1.18.15 resolved from the chat's OLD
// opencode.json, whose bash rules allowed read-only pa commands by pattern —
// kept so the test proves checkBashShape() refuses that shape. Originally: the
// ruleset opencode 1.18.15 resolved for the PA chat's "pa" agent from the
// opencode.json src/chat/agent.js writes (`opencode debug agent pa` in pa-home),
// with the machine's skill folders dropped and pa's command replaced by __PA__.
// .js, not .json: the repo ignores *.json.

module.exports = [
 {
  "permission": "*",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "doom_loop",
  "action": "ask",
  "pattern": "*"
 },
 {
  "permission": "external_directory",
  "pattern": "*",
  "action": "ask"
 },
 {
  "permission": "question",
  "action": "deny",
  "pattern": "*"
 },
 {
  "permission": "plan_enter",
  "action": "deny",
  "pattern": "*"
 },
 {
  "permission": "plan_exit",
  "action": "deny",
  "pattern": "*"
 },
 {
  "permission": "read",
  "pattern": "*",
  "action": "allow"
 },
 {
  "permission": "read",
  "pattern": "*.env",
  "action": "ask"
 },
 {
  "permission": "read",
  "pattern": "*.env.*",
  "action": "ask"
 },
 {
  "permission": "read",
  "pattern": "*.env.example",
  "action": "allow"
 },
 {
  "permission": "*",
  "action": "ask",
  "pattern": "*"
 },
 {
  "permission": "read",
  "pattern": "*",
  "action": "allow"
 },
 {
  "permission": "read",
  "pattern": "*.env",
  "action": "ask"
 },
 {
  "permission": "read",
  "pattern": "*.env.*",
  "action": "ask"
 },
 {
  "permission": "glob",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "grep",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "list",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "todowrite",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "question",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "edit",
  "action": "ask",
  "pattern": "*"
 },
 {
  "permission": "webfetch",
  "action": "ask",
  "pattern": "*"
 },
 {
  "permission": "websearch",
  "action": "ask",
  "pattern": "*"
 },
 {
  "permission": "external_directory",
  "action": "ask",
  "pattern": "*"
 },
 {
  "permission": "task",
  "action": "deny",
  "pattern": "*"
 },
 {
  "permission": "bash",
  "pattern": "*",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ brief",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ brief *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ inbox",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ inbox *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ show",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ show *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ search",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ search *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ who",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ who *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ runs",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ runs *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ review",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ review *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ drafts",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ drafts *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ memory",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ memory *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ meeting",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ meeting *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ routine list",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ routine list *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ doctor",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ doctor *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ backup list",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ backup list *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ context",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ context *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ projects",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ projects *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify list",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify list *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify ack",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify ack *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify weights",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify weights *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify digest",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify digest *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ do",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ do *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ land",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ land *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ drop",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ drop *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ say",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ say *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ done",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ done *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ remember",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ remember *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ forget",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ forget *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ routine add",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ routine add *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify feedback",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify feedback *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "*>*",
  "action": "ask"
 },
 {
  "permission": "personal-assistant_recall",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "personal-assistant_memory_page",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "personal-assistant_brief_me",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "personal-assistant_open_commitments",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "personal-assistant_who_is",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "personal-assistant_get_thread",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "personal-assistant_search_context",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "personal-assistant_explain_claim",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "personal-assistant_repo_state",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "*",
  "action": "ask",
  "pattern": "*"
 },
 {
  "permission": "read",
  "pattern": "*",
  "action": "allow"
 },
 {
  "permission": "read",
  "pattern": "*.env",
  "action": "ask"
 },
 {
  "permission": "read",
  "pattern": "*.env.*",
  "action": "ask"
 },
 {
  "permission": "glob",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "grep",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "list",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "todowrite",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "question",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "edit",
  "action": "ask",
  "pattern": "*"
 },
 {
  "permission": "webfetch",
  "action": "ask",
  "pattern": "*"
 },
 {
  "permission": "websearch",
  "action": "ask",
  "pattern": "*"
 },
 {
  "permission": "external_directory",
  "action": "ask",
  "pattern": "*"
 },
 {
  "permission": "task",
  "action": "deny",
  "pattern": "*"
 },
 {
  "permission": "bash",
  "pattern": "*",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ brief",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ brief *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ inbox",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ inbox *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ show",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ show *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ search",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ search *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ who",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ who *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ runs",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ runs *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ review",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ review *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ drafts",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ drafts *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ memory",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ memory *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ meeting",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ meeting *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ routine list",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ routine list *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ doctor",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ doctor *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ backup list",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ backup list *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ context",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ context *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ projects",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ projects *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify list",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify list *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify ack",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify ack *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify weights",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify weights *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify digest",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify digest *",
  "action": "allow"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ do",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ do *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ land",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ land *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ drop",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ drop *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ say",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ say *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ done",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ done *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ remember",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ remember *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ forget",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ forget *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ routine add",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ routine add *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify feedback",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "__PA__ notify feedback *",
  "action": "ask"
 },
 {
  "permission": "bash",
  "pattern": "*>*",
  "action": "ask"
 },
 {
  "permission": "personal-assistant_recall",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "personal-assistant_memory_page",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "personal-assistant_brief_me",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "personal-assistant_open_commitments",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "personal-assistant_who_is",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "personal-assistant_get_thread",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "personal-assistant_search_context",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "personal-assistant_explain_claim",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "personal-assistant_repo_state",
  "action": "allow",
  "pattern": "*"
 }
];
