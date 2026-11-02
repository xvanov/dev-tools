'use strict';

// The ruleset opencode 1.18.15 resolved for the PA chat's "pa" agent from the
// opencode.json src/chat/agent.js writes since every shell command asks
// (`opencode debug agent pa` in a home holding only that file), with the
// machine's skill folders dropped. .js, not .json: the repo ignores *.json.

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
  "permission": "external_directory",
  "pattern": "~/.local/share/opencode/tool-output/*",
  "action": "allow"
 },
 {
  "permission": "external_directory",
  "pattern": "/tmp/opencode/*",
  "action": "allow"
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
  "action": "ask",
  "pattern": "*"
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
  "permission": "personal-assistant_pa",
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
  "action": "ask",
  "pattern": "*"
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
  "permission": "personal-assistant_pa",
  "action": "allow",
  "pattern": "*"
 },
 {
  "permission": "external_directory",
  "pattern": "~/.local/share/opencode/tool-output/*",
  "action": "allow"
 }
];
