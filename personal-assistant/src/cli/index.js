'use strict';

// The `pa` command surface.
//
// This is the primary interface, not a debugging aid for a web UI — you live in
// a terminal, so the terminal gets the real thing and OpenClaw drives these
// same commands through a skill. One implementation of every behaviour: when
// the chat surface and the CLI disagree about what `pa do` means, the bug is
// that there are two implementations.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { config } = require('../config');
const { parseArgs, flagInt, flagBool } = require('./parseArgs');
const db = require('../db');

const HELP = `pa — your context layer

  Knowing
    pa brief                        what's on you today
    pa inbox [-n 20] [--source s]   newly distilled commitments, newest first
    pa show <id> [--project name]   one commitment; --project corrects a guess and learns the phrase
    pa search <query...>            hybrid search over everything captured
    pa who <name...>                a person: identities, threads, open commitments
    pa projects [sync]              the project ↔ repo table

  Doing
    pa do <id> [--mode m] [--repo p] dispatch a commitment to a Claude Code session
    pa do --task "..." [--mode m] [--repo p]
    pa runs [--all]                 live and recent runs
    pa attach <run>                 print (and open) the termhub URL for a run
    pa say <run> <text...>          type at a running session without leaving the CLI
    pa review <run> [--diff]        what the session changed
    pa land <run>                   push, and open a draft MR if the mode allows
    pa drop <run> [--force]         kill the session and remove the worktree

  Replying
    pa draft <run> [--channel teams|email]
    pa drafts                       pending drafts
    pa send <draft>                 interactive, explicit, never implicit

  Plumbing
    pa login | whoami | logout      Microsoft sign-in (device code)
    pa sync [--source s]            force an ingest pass
    pa distill [--limit n]          force a distillation pass
    pa migrate                      apply database migrations
    pa mic status|pause <mins>|on   always-on capture control
    pa doctor                       what is configured, what is stale, what is broken
`;

function out(text) {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function fail(message) {
  process.stderr.write(`pa: ${message}\n`);
  process.exitCode = 1;
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function relative(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// ---------------------------------------------------------------- commands --

const commands = {
  async help() {
    out(HELP);
  },

  async migrate() {
    const { migrate } = require('../db/migrate');
    const result = await migrate();
    out(result.applied.length ? `applied: ${result.applied.join(', ')}` : 'schema already up to date');
  },

  async login() {
    const { login } = require('../auth/graphAuth');
    const { request } = require('../graph/client');
    const identity = require('../distill/identity');

    await login((response) => {
      out('');
      out(response.message);
      out('');
    });

    const me = await request('/me?$select=displayName,mail,userPrincipalName');
    const email = (me.mail || me.userPrincipalName || '').toLowerCase();
    await identity.setMe({ displayName: me.displayName, email });
    out(`signed in as ${me.displayName} <${email}>`);
    out(`scopes: ${config.graph.scopes.join(' ')}`);
  },

  async whoami() {
    const { whoAmI } = require('../auth/graphAuth');
    const who = await whoAmI();
    if (!who) return out('not signed in — run `pa login`');
    out(`${who.name || ''} <${who.username}>  tenant ${who.tenantId}`);
  },

  async logout() {
    require('../auth/tokenStore').clear();
    out('token cache cleared');
  },

  async sync(args, flags) {
    const ingest = require('../ingest');
    const only = flags.source ? [String(flags.source)] : null;
    const results = await ingest.runAll(only);
    for (const r of results) {
      out(`${r.source.padEnd(16)} ${r.error ? `ERROR ${r.error}` : `${r.changed} new/changed`} (${r.ms}ms)`);
    }
    if (flagBool(flags, 'distill', true)) {
      const distill = require('../distill');
      const d = await distill.run({ limit: flagInt(flags, 'limit', 40) });
      out(`distilled ${d.processed} items → ${d.commitments} commitments, ${d.facts} facts${d.errors ? `, ${d.errors} failed` : ''}`);
    }
  },

  async distill(args, flags) {
    const distill = require('../distill');
    const d = await distill.run({ limit: flagInt(flags, 'limit', 25) });
    out(`distilled ${d.processed} items → ${d.commitments} commitments, ${d.facts} facts${d.errors ? `, ${d.errors} failed` : ''}`);
    const left = await distill.pendingCount();
    if (left) out(`${left} still pending — run again or let the worker catch up`);
  },

  async brief() {
    const { brief } = require('../brief');
    out(await brief());
  },

  async inbox(args, flags) {
    const limit = flagInt(flags, 'n', 20);
    const list = await db.rows(
      `select c.id, c.summary, c.direction, c.due_at, c.confidence, c.project_confidence,
              p.name as project, per.display_name as who, si.source, si.occurred_at
         from commitment c
         left join project p on p.id = c.project_id
         left join person per on per.id = c.counterparty_person_id
         join source_item si on si.id = c.source_item_id
        where c.status in ('open','dispatched') and c.superseded_by is null
          and ($1::text is null or si.source = $1)
        order by c.extracted_at desc limit $2`,
      [flags.source ? String(flags.source) : null, limit]
    );
    if (!list.length) return out('nothing pending');
    for (const c of list) {
      const marks = [];
      if (c.project) marks.push(Number(c.project_confidence) < 0.6 ? `${c.project}?` : c.project);
      else marks.push('no-repo');
      if (Number(c.confidence) < 0.5) marks.push('unsure');
      out(
        `${String(c.id).padStart(5)}  ${c.direction === 'owed_by_me' ? '→' : '←'} ${c.summary}` +
          `\n        ${c.who || 'unknown'} · ${c.source} · ${relative(c.occurred_at)} · ${marks.join(' ')}`
      );
    }
  },

  async show(args, flags) {
    const id = Number(args[0]);
    if (!id) return fail('usage: pa show <commitment-id> [--project name]');

    if (flags.project) {
      const projects = require('../projects');
      const project = await projects.byName(String(flags.project));
      if (!project) return fail(`no project "${flags.project}" — try \`pa projects\``);

      const commitment = await db.one('select * from commitment where id = $1', [id]);
      if (!commitment) return fail(`no commitment #${id}`);
      const item = await db.one('select subject, body_text from source_item where id = $1', [
        commitment.source_item_id,
      ]);

      await db.query(
        `update commitment set project_id = $2, repo_path = $3, project_confidence = 1.0,
                               project_rationale = 'corrected by hand' where id = $1`,
        [id, project.id, project.repo_path]
      );

      // The correction is the lesson. Learn the phrase that was actually used,
      // so the next message worded that way resolves without asking.
      const learned = await learnAliases(project.id, commitment, item, id);
      out(`#${id} → ${project.name}${project.repo_path ? ` (${project.repo_path})` : ''}`);
      if (learned.length) out(`learned alias${learned.length > 1 ? 'es' : ''}: ${learned.join(', ')}`);
      return;
    }

    const c = await db.one(
      `select c.*, p.name as project, per.display_name as who, per.primary_email as who_email,
              si.source, si.subject, si.body_text, si.occurred_at, si.thread_external_id
         from commitment c
         left join project p on p.id = c.project_id
         left join person per on per.id = c.counterparty_person_id
         join source_item si on si.id = c.source_item_id
        where c.id = $1`,
      [id]
    );
    if (!c) return fail(`no commitment #${id}`);

    out(`#${c.id}  ${c.summary}`);
    out(`  ${c.direction === 'owed_by_me' ? 'you owe' : 'owed to you'}${c.who ? ` · ${c.who}${c.who_email ? ` <${c.who_email}>` : ''}` : ''}`);
    if (c.due_at) out(`  due ${new Date(c.due_at).toISOString().slice(0, 10)}`);
    out(`  project ${c.project || '(none)'}${c.project_confidence !== null ? ` · ${Math.round(c.project_confidence * 100)}% — ${c.project_rationale || ''}` : ''}`);
    out(`  status ${c.status} · confidence ${c.confidence !== null ? Math.round(c.confidence * 100) + '%' : '?'} · ${c.extracted_by}`);
    if (c.detail) out(`\n  ${c.detail}`);
    out(`\n  from ${c.source} · ${new Date(c.occurred_at).toISOString()}`);
    if (c.subject) out(`  ${c.subject}`);
    out('');
    out(
      (c.body_text || '')
        .split('\n')
        .slice(0, 40)
        .map((l) => '  | ' + l)
        .join('\n')
    );
  },

  async search(args, flags) {
    const q = args.join(' ');
    if (!q) return fail('usage: pa search <query>');
    const { search } = require('../search');
    const { results, lexicalOnly, embedError } = await search(q, { limit: flagInt(flags, 'n', 12) });
    if (!results.length) return out('no matches');
    for (const r of results) {
      out(`#${r.id} [${r.source}] ${new Date(r.occurred_at).toISOString().slice(0, 10)} ${r.subject || ''}`);
      out(`      ${(r.snippet || '').replace(/\s+/g, ' ').trim()}`);
    }
    if (lexicalOnly) out('\n(text search only — no embedding endpoint configured)');
  },

  async who(args) {
    const name = args.join(' ');
    if (!name) return fail('usage: pa who <name>');
    const { handle } = require('../mcp/server');
    const result = await handle('who_is', { name });
    out(result.content[0].text);
  },

  async projects(args, flags) {
    const projects = require('../projects');
    if (args[0] === 'sync') {
      const seen = await projects.sync({ includeGitlab: flagBool(flags, 'gitlab', true) });
      out(`${seen.length} projects seeded`);
      return;
    }
    const list = await projects.list();
    if (!list.length) return out('no projects yet — run `pa projects sync`');
    for (const p of list) {
      out(
        `${p.name.padEnd(28)} ${(p.gitlab_path || '').padEnd(34)} ${p.repo_path || ''}` +
          `\n    ${p.aliases} aliases · ${p.commitments} commitments`
      );
    }
  },

  async do(args, flags) {
    const dispatch = require('../dispatch');
    const commitmentId = args[0] ? Number(args[0]) : null;
    const task = flags.task && flags.task !== true ? String(flags.task) : null;
    if (!commitmentId && !task) return fail('usage: pa do <commitment-id> [--mode m] | pa do --task "..."');

    const result = await dispatch.start({
      commitmentId,
      task,
      mode: flags.mode && flags.mode !== true ? String(flags.mode) : undefined,
      repoPath: flags.repo && flags.repo !== true ? String(flags.repo) : null,
    });

    out(`run #${result.id} · ${result.mode} · ${result.repoPath || '(no repo)'}`);
    if (result.branch) out(`  branch   ${result.branch}`);
    if (result.worktreePath) out(`  worktree ${result.worktreePath}`);
    out(`  brief    ${result.briefPath}`);
    out(`  session  ${result.url}`);
  },

  async runs(args, flags) {
    const dispatch = require('../dispatch');
    await dispatch.reconcile().catch(() => {});
    const list = await dispatch.list({ all: flagBool(flags, 'all'), limit: flagInt(flags, 'n', 20) });
    if (!list.length) return out('no runs');
    for (const r of list) {
      out(
        `#${String(r.id).padEnd(4)} ${r.status.padEnd(9)} ${r.mode.padEnd(7)} ${r.task}` +
          `\n      ${r.branch || '(no branch)'} · ${relative(r.started_at)}${r.mr_url ? ` · ${r.mr_url}` : ''}`
      );
    }
  },

  async attach(args) {
    const dispatch = require('../dispatch');
    const termhub = require('../dispatch/termhub');
    const run = await dispatch.get(Number(args[0]));
    if (!run) return fail(`no run #${args[0]}`);
    if (!run.termhub_session_id) return fail(`run #${run.id} has no session`);
    const url = await termhub.sessionUrl(run.termhub_session_id);
    out(url);
    if (process.platform === 'win32') {
      require('child_process').spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    }
  },

  async say(args) {
    const dispatch = require('../dispatch');
    const id = Number(args[0]);
    const text = args.slice(1).join(' ');
    if (!id || !text) return fail('usage: pa say <run> <text...>');
    await dispatch.steer(id, text);
    out(`sent to run #${id}`);
  },

  async review(args, flags) {
    const dispatch = require('../dispatch');
    const id = Number(args[0]);
    if (!id) return fail('usage: pa review <run> [--diff]');

    if (flagBool(flags, 'diff')) {
      out((await dispatch.diff(id)) || '(no diff)');
      return;
    }

    const r = await dispatch.review(id);
    out(`run #${r.run.id} · ${r.run.status} · ${r.run.mode} · ${r.run.task}`);
    if (r.run.worktree_path) out(`worktree ${r.run.worktree_path}`);
    out('');
    out(r.commits ? `commits:\n${r.commits}` : 'no commits on this branch');
    out('');
    out(r.stat || 'no changes against the base branch');
    if (r.uncommitted) out(`\n${r.uncommitted} uncommitted file(s) — the session may still be working`);
    if (flagBool(flags, 'done')) {
      await dispatch.markDone(id, 'marked done by hand');
      out('\nmarked done');
    }
  },

  async land(args) {
    const dispatch = require('../dispatch');
    const id = Number(args[0]);
    if (!id) return fail('usage: pa land <run>');
    const result = await dispatch.land(id);
    out(`pushed ${result.branch}`);
    if (result.mrUrl) out(result.mrUrl);
  },

  async drop(args, flags) {
    const dispatch = require('../dispatch');
    const id = Number(args[0]);
    if (!id) return fail('usage: pa drop <run> [--force]');
    await dispatch.drop(id, { force: flagBool(flags, 'force') });
    out(`run #${id} dropped`);
  },

  async draft(args, flags) {
    const drafts = require('../draft');
    const id = Number(args[0]);
    if (!id) return fail('usage: pa draft <run> [--channel teams|email]');
    const { draft } = await drafts.compose(id, {
      channel: flags.channel && flags.channel !== true ? String(flags.channel) : null,
    });
    out(`draft #${draft.id} · ${draft.channel} · to ${draft.to_identity || '(unknown)'}`);
    if (draft.subject) out(`subject: ${draft.subject}`);
    out('');
    out(draft.body);
    out('');
    out(`Nothing has been sent. \`pa send ${draft.id}\` when you are happy with it.`);
  },

  async drafts() {
    const drafts = require('../draft');
    const list = await drafts.pending();
    if (!list.length) return out('no pending drafts');
    for (const d of list) {
      out(`#${d.id} · run ${d.run_id} · ${d.channel} · to ${d.to_identity || '?'} · ${d.status}`);
      out(`    ${d.body.split('\n')[0].slice(0, 100)}`);
    }
  },

  async send(args, flags) {
    const drafts = require('../draft');
    const id = Number(args[0]);
    if (!id) return fail('usage: pa send <draft>');
    const draft = await drafts.get(id);
    if (!draft) return fail(`no draft #${id}`);

    out(`to:      ${draft.to_identity}`);
    if (draft.subject) out(`subject: ${draft.subject}`);
    out(`channel: ${draft.channel}`);
    out('');
    out(draft.body);
    out('');

    if (!flagBool(flags, 'yes')) {
      const ok = await confirm('Send this? [y/N]');
      if (!ok) return out('not sent');
    }
    await drafts.send(id);
    out('sent');
  },

  async mic(args) {
    const action = args[0] || 'status';
    const pauseFile = config.audio.pauseFile;
    fs.mkdirSync(path.dirname(pauseFile), { recursive: true });

    if (action === 'pause') {
      const mins = Number(args[1]) || 30;
      const until = new Date(Date.now() + mins * 60_000).toISOString();
      fs.writeFileSync(pauseFile, until);
      return out(`capture paused until ${until}`);
    }
    if (action === 'on') {
      try {
        fs.unlinkSync(pauseFile);
      } catch {
        /* already on */
      }
      return out('capture on');
    }

    if (!fs.existsSync(pauseFile)) return out('capture: on');
    const until = fs.readFileSync(pauseFile, 'utf8').trim();
    if (until && new Date(until) < new Date()) return out(`capture: on (pause expired ${until})`);
    out(`capture: paused until ${until}`);
  },

  async doctor() {
    const lines = [];
    const mark = (ok, label, detail) =>
      lines.push(`${ok ? '  ok ' : ' !! '} ${label.padEnd(24)} ${detail}`);

    lines.push('personal-assistant doctor');
    lines.push('');

    // Database
    try {
      const probe = await db.probe();
      mark(true, 'postgres', `${config.databaseUrl.replace(/:[^:@/]*@/, ':***@')} · ${probe.db}`);
      mark(probe.has_vector, 'pgvector', probe.has_vector ? 'installed' : 'MISSING — run `pa migrate`');
      const migrations = await db
        .rows('select version from schema_migration order by version')
        .catch(() => []);
      mark(migrations.length > 0, 'migrations', migrations.length ? `${migrations.length} applied` : 'none — run `pa migrate`');
    } catch (err) {
      mark(false, 'postgres', err.message);
      out(lines.join('\n'));
      return;
    }

    // Microsoft
    const { whoAmI } = require('../auth/graphAuth');
    const who = await whoAmI().catch(() => null);
    mark(Boolean(config.graph.clientId), 'PA_GRAPH_CLIENT_ID', config.graph.clientId || 'not set');
    mark(Boolean(who), 'microsoft sign-in', who ? who.username : 'run `pa login`');
    lines.push(`       scopes                   ${config.graph.scopes.join(' ')}`);

    // GitLab, Anthropic, embeddings
    const gitlab = require('../ingest/gitlab');
    mark(gitlab.configured(), 'gitlab', gitlab.configured() ? config.gitlab.url : 'PA_GITLAB_TOKEN not set');
    mark(Boolean(config.anthropic.apiKey), 'anthropic', config.anthropic.apiKey ? `${config.anthropic.model} · effort ${config.anthropic.effort}` : 'ANTHROPIC_API_KEY not set — distillation cannot run');
    // Probed rather than assumed: a configured endpoint with the wrong
    // deployment name looks identical to a working one until a search quietly
    // returns half its results.
    const search = require('../search');
    if (!search.embeddingsConfigured()) {
      mark(false, 'embeddings', 'not configured — search is text-only');
    } else {
      const probe = await search.embed(['ping']).catch(() => null);
      mark(
        Boolean(probe),
        'embeddings',
        probe ? `${config.embeddings.deployment} · ${probe[0].length} dims` : search.lastEmbedError()
      );
    }

    // termhub
    const termhub = require('../dispatch/termhub');
    const hub = await termhub.reachable();
    mark(hub.ok, 'termhub', hub.ok ? config.termhub.url : `${config.termhub.url} — ${hub.error}`);

    // Cursors and backlog
    lines.push('');
    lines.push('  sources');
    const { cursors } = require('../ingest/store');
    for (const c of await cursors()) {
      lines.push(
        `    ${c.source.padEnd(22)} ${relative(c.last_run_at).padEnd(12)}` +
          `${c.last_error ? ` ERROR ${c.last_error.slice(0, 80)}` : ''}`
      );
    }

    const counts = await db.one(
      `select (select count(*) from source_item) as items,
              (select count(*) from commitment where status = 'open') as open_commitments,
              (select count(*) from run where status in ('running','waiting')) as live_runs,
              (select count(*) from draft where status = 'pending') as pending_drafts,
              (select count(*) from distillation where error is not null) as failed_items`
    );
    const distill = require('../distill');
    lines.push('');
    lines.push(`  ${counts.items} items · ${counts.open_commitments} open commitments · ${await distill.pendingCount()} awaiting distillation`);
    lines.push(`  ${counts.live_runs} live runs · ${counts.pending_drafts} pending drafts · ${counts.failed_items} items failed distillation`);

    // Audio
    const paused = fs.existsSync(config.audio.pauseFile);
    lines.push('');
    lines.push(`  audio ${config.audio.enabled ? (paused ? 'PAUSED' : 'on') : 'disabled'} · spool ${config.audioDir}`);

    out(lines.join('\n'));
  },
};

// Learns the phrases a corrected commitment was actually described with. Short
// noun phrases from the summary and subject, not the whole sentence — an alias
// that only matches one exact message is not an alias.
async function learnAliases(projectId, commitment, item, commitmentId) {
  const projects = require('../projects');
  const { normalise } = require('../projects/resolve');
  const learned = [];
  const sources = [commitment.summary, item?.subject].filter(Boolean);

  for (const source of sources) {
    const words = normalise(source).split(' ').filter((w) => w.length > 3);
    for (let n = 3; n >= 2; n--) {
      for (let i = 0; i + n <= words.length; i++) {
        const phrase = words.slice(i, i + n).join(' ');
        if (phrase.length < 8 || phrase.length > 40) continue;
        if (await projects.addAlias(projectId, phrase, 'corrected', commitmentId)) {
          learned.push(phrase);
        }
        if (learned.length >= 2) return learned;
      }
    }
  }
  return learned;
}

async function main(argv) {
  const { command, args, flags } = parseArgs(argv);
  const name = command || 'help';

  if (flags.help || name === 'help' || name === '--help') {
    out(HELP);
    return;
  }

  const handler = commands[name];
  if (!handler) {
    fail(`unknown command "${name}" — try \`pa help\``);
    return;
  }

  try {
    await handler(args, flags);
  } catch (err) {
    if (err.name === 'NeedsLogin') fail(`${err.message}`);
    else fail(err.message);
    if (process.env.PA_LOG_LEVEL === 'debug') process.stderr.write(err.stack + '\n');
  } finally {
    await db.close().catch(() => {});
  }
}

module.exports = { main, commands, HELP };
