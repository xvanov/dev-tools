'use strict';

// The Agents page (/agents, agents.html, agents.client.js): the settings of every agent in one
// place — each Build profile, the PA chat and the worker passes' models. Every write here has a
// chat tool and a `pa` verb doing the same through src/agentSettings.ts (BUILD-ENRICHMENT.md B;
// test/dashboardParity.test.js fails when a route here has neither).
//
//   GET  /api/agents                       { profiles, missingSeeds, chat, passes, options }
//   POST /api/agents/settings              { chatModel?, passModels?: {pass: model | null}, summaryEvery?, summaryLines? }   null clears an override
//   POST /api/agents/profiles/<name>       { model?, effort?, permissionMode?, prompt?, tools?, subagents?,
//                                            subagentModel?, costCapUsd?, wallCapMin?, idleAfterS?, repoPath?, description? }
//                                          create or change (only the fields sent change; null clears one)
//   POST /api/agents/profiles/<name>/delete
//   POST /api/agents/profiles/<name>/reset   a built-in profile back to what ships
//
// Mounted through server.ts jsonModule: loopback only, X-PA on every POST, a thrown error's status is the reply's.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Row = import('../repo/types.ts').Row;

async function route(method: string | undefined, url: URL, body: Row) {
  const A = require('../agentSettings.ts');
  const p = url.pathname;
  if (method === 'GET' && p === '/api/agents') return A.get();
  if (method !== 'POST') return undefined;
  if (p === '/api/agents/settings') return A.setAgents(body);
  const m = /^\/api\/agents\/profiles\/([^/]+)(?:\/(delete|reset))?$/.exec(p);
  if (!m) return undefined;
  const name = decodeURIComponent(m[1] as string);
  if (m[2] === 'delete') return A.deleteProfile(name);
  if (m[2] === 'reset') return A.resetProfile(name);
  return A.setProfile(name, body);
}

module.exports = { route };
