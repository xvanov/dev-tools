'use strict';

// The recall server: the assistant's store, exposed over MCP so every Claude
// Code session on this machine reads the same brain.
//
// This is what stops a dispatched session and an ad-hoc one from disagreeing
// about context. It is read-only by design — an MCP server that could dispatch
// runs or send mail would put those actions one prompt-injected email away, and
// the whole point of `pa send` being interactive is that it is not reachable
// from inside a model's turn.
//
// Uses the low-level Server rather than McpServer so tool schemas stay plain
// JSON Schema: one less dependency, and the schemas are readable as data.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { rows, one, close } = require('../db');
const { search } = require('../search');
const { brief } = require('../brief');
const { sourceLabel } = require('../dispatch/brief');

const TOOLS = [
  {
    name: 'brief_me',
    description:
      "What is on the user today: overdue and due commitments, meetings in the next day, GitLab work waiting, and dispatched runs. Call this when asked what to work on, what's outstanding, or for a status catch-up.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_context',
    description:
      'Hybrid full-text and semantic search over everything captured: email, Teams chats, calendar entries, GitLab issues and MRs, recorded conversations, and the user\'s own past Claude sessions. Use this when a task references something not in the current conversation — a decision, a person\'s request, a prior discussion.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in natural language or keywords.' },
        limit: { type: 'integer', minimum: 1, maximum: 40, default: 10 },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional filter: graph_mail, graph_chat, graph_event, gitlab_mr, gitlab_issue, gitlab_todo, audio, claude_session.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_thread',
    description:
      'Every captured message in one conversation, oldest first, given any item id from it. Use after search_context when one hit needs its surrounding discussion.',
    inputSchema: {
      type: 'object',
      properties: { item_id: { type: 'integer' } },
      required: ['item_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_commitments',
    description:
      'Distilled obligations: what the user owes people and what people owe the user, with due dates, requester, and target repo where known.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['owed_by_me', 'owed_to_me', 'both'], default: 'owed_by_me' },
        project: { type: 'string', description: 'Optional project name filter.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'who_is',
    description:
      'A person: their known identities across Outlook, Teams and GitLab, recent threads with them, and open commitments either way. Use before writing to or about a colleague.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Name, email, or handle.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'repo_state',
    description:
      'What the assistant knows about a project: its repo path, GitLab path, open MRs and issues, and recent dispatched runs.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      required: ['project'],
      additionalProperties: false,
    },
  },
];

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

async function handle(name, args = {}) {
  switch (name) {
    case 'brief_me':
      return text(await brief());

    case 'search_context': {
      const { results, lexicalOnly, embedError } = await search(args.query, {
        limit: args.limit ?? 10,
        sources: args.sources || null,
      });
      if (!results.length) return text(`No matches for "${args.query}".`);
      const lines = results.map(
        (r) =>
          `#${r.id} [${sourceLabel(r.source)}] ${new Date(r.occurred_at).toISOString().slice(0, 10)} — ${r.subject || '(no subject)'}\n    ${(r.snippet || '').replace(/\s+/g, ' ').trim()}`
      );
      if (lexicalOnly) {
        lines.push('', `(text search only — ${embedError || 'embeddings unavailable'} — paraphrased matches may be missed)`);
      }
      return text(lines.join('\n'));
    }

    case 'get_thread': {
      const seed = await one('select * from source_item where id = $1', [args.item_id]);
      if (!seed) return text(`No item #${args.item_id}.`);
      const thread = seed.thread_external_id
        ? await rows(
            'select * from source_item where source = $1 and thread_external_id = $2 order by occurred_at',
            [seed.source, seed.thread_external_id]
          )
        : [seed];
      return text(
        thread
          .map(
            (m) =>
              `--- ${new Date(m.occurred_at).toISOString()} ${m.author_identity || 'unknown'}\n${m.body_text}`
          )
          .join('\n\n')
      );
    }

    case 'open_commitments': {
      const direction = args.direction || 'owed_by_me';
      const list = await rows(
        `select c.id, c.summary, c.detail, c.direction, c.due_at, c.confidence,
                p.name as project, c.repo_path, per.display_name as who
           from commitment c
           left join project p on p.id = c.project_id
           left join person per on per.id = c.counterparty_person_id
          where c.status in ('open','dispatched') and c.superseded_by is null
            and ($1 = 'both' or c.direction = $1)
            and ($2::text is null or lower(p.name) = lower($2))
          order by c.due_at nulls last, c.extracted_at desc
          limit $3`,
        [direction, args.project || null, args.limit ?? 25]
      );
      return text(list);
    }

    case 'who_is': {
      const person = await one(
        `select * from person
          where lower(display_name) like lower($1) or lower(primary_email) like lower($1)
             or id = (select person_id from person_identity where lower(value) like lower($1) limit 1)
          limit 1`,
        [`%${args.name}%`]
      );
      if (!person) return text(`No one matching "${args.name}".`);
      const identities = await rows('select kind, value from person_identity where person_id = $1', [
        person.id,
      ]);
      const commitments = await rows(
        `select id, direction, summary, due_at from commitment
          where counterparty_person_id = $1 and status in ('open','dispatched')
          order by due_at nulls last limit 20`,
        [person.id]
      );
      const recent = await rows(
        `select si.id, si.source, si.subject, si.occurred_at from source_item si
          where si.author_identity in (select value from person_identity where person_id = $1)
             or si.author_identity = $2
          order by si.occurred_at desc limit 10`,
        [person.id, person.primary_email]
      );
      return text({ person, identities, commitments, recent });
    }

    case 'repo_state': {
      const project = await one(
        `select * from project
          where lower(name) = lower($1) or lower(gitlab_path) = lower($1)
             or id = (select project_id from project_alias where lower(alias) = lower($1) limit 1)`,
        [args.project]
      );
      if (!project) return text(`No project matching "${args.project}".`);
      const gitlabItems = await rows(
        `select source, subject, raw, occurred_at from source_item
          where source in ('gitlab_mr','gitlab_issue','gitlab_todo')
            and raw->>'project' = $1
          order by occurred_at desc limit 20`,
        [project.gitlab_path]
      );
      const runs = await rows(
        `select id, task, mode, status, branch, mr_url, started_at from run
          where repo_path = $1 order by started_at desc limit 10`,
        [project.repo_path]
      );
      return text({ project, gitlab: gitlabItems, runs });
    }

    default:
      throw new Error(`unknown tool ${name}`);
  }
}

async function main() {
  const server = new Server(
    { name: 'personal-assistant', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await handle(req.params.name, req.params.arguments || {});
    } catch (err) {
      // A tool error is data, not a transport failure: the model can read it
      // and try something else, which it cannot do with a dropped connection.
      return { ...text(`error: ${err.message}`), isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
}

module.exports = { TOOLS, handle };

if (require.main === module) {
  main().catch(async (err) => {
    process.stderr.write(`personal-assistant MCP server failed: ${err.stack}\n`);
    await close().catch(() => {});
    process.exit(1);
  });
}
