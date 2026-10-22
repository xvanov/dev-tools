'use strict';

// `pa memory`, `pa remember`, `pa forget` — the memory layer's verbs. Kept in
// their own file so cli/index.js only has to wire them in.

const { flagInt, flagBool } = require('./parseArgs');

const HELP = `
  Memory
    pa memory [me|index]            the profile, or the map of who's who
    pa memory [person|project] <name>  a page
    pa memory claims <name> [--all] [--as-of date]   what is believed, with quotes
    pa memory explain <claim>       a claim, its evidence, and its history
    pa memory search <query...>     search claims
    pa memory run [extract|consolidate|pages|dream] [--limit n]   force a pass
    pa remember "<note>" [--about name] [--kind k]   save a fact now
    pa forget <claim> | item:<id>   retract a claim, or everything read from an item
`;

function day(v) {
  return v ? new Date(v).toISOString().slice(0, 10) : '';
}

function claimLine(c) {
  const flags = [];
  if (c.status !== 'active') flags.push(c.status);
  if (c.origin === 'explicit') flags.push('noted');
  const until = c.invalid_at ? `→${day(c.invalid_at)}` : '';
  return [
    `  #${c.id} [${c.kind}] ${c.text}${flags.length ? `  (${flags.join(', ')})` : ''}`,
    `      ${day(c.valid_at)}${until} · ${c.source_item_id ? `item ${c.source_item_id}` : c.source_kind || 'no source'} · conf ${Number(c.confidence).toFixed(2)}`,
    c.quote ? `      "${String(c.quote).replace(/\s+/g, ' ').slice(0, 220)}"` : null,
  ].filter(Boolean).join('\n');
}

function make(out, fail) {
  return {
    async memory(args, flags) {
      const memory = require('../memory');
      const sub = (args[0] || '').toLowerCase();

      if (!sub || sub === 'index' || sub === 'me') {
        const page = await memory.getPage(sub || 'index');
        if (!page) return out(`no ${sub || 'index'} page yet — the worker builds it (or \`pa memory run dream\`)`);
        return out(`${page.body}\n\n(generated ${day(page.generated_at)})`);
      }

      if (sub === 'claims') {
        const name = args.slice(1).join(' ');
        if (!name) return fail('usage: pa memory claims <name> [--all] [--as-of date]');
        const asOf = flags['as-of'] ? new Date(String(flags['as-of'])) : null;
        if (asOf && Number.isNaN(asOf.getTime())) return fail('--as-of wants a date');
        const { subject, claims } = await memory.claimsFor(name, { all: flagBool(flags, 'all'), asOf });
        out(`${subject.kind} ${subject.label}${subject.id != null ? ` (#${subject.id})` : ''} — ${claims.length} claim${claims.length === 1 ? '' : 's'}${asOf ? ` as of ${day(asOf)}` : ''}`);
        for (const c of claims) out(claimLine(c));
        return;
      }

      if (sub === 'explain') {
        const e = await memory.explain(args[1]);
        if (!e) return fail(`no claim #${args[1]}`);
        out(claimLine(e.claim));
        out(`  subject: ${e.claim.subject_kind} ${e.claim.subject_label} · origin ${e.claim.origin} · recorded ${day(e.claim.recorded_at)}${e.claim.expired_at ? ` · expired ${day(e.claim.expired_at)}` : ''}`);
        if (e.source) out(`  source: #${e.source.id} ${e.source.source} ${day(e.source.occurred_at)} ${e.source.subject || ''}${e.source.url ? `\n          ${e.source.url}` : ''}`);
        else if (e.sourceRemoved) out('  source: removed by retention — the quote above is what remains');
        if (e.consolidation) out(`  consolidation: ${e.consolidation.decision}${e.consolidation.target_id ? ` #${e.consolidation.target_id}` : ''}${e.consolidation.error ? ` (${e.consolidation.error})` : ''}`);
        if (e.supersedes) out(`  supersedes: #${e.supersedes.id} ${e.supersedes.text}`);
        for (const s of e.supersededBy) out(`  superseded by: #${s.id} ${s.text}`);
        for (const d of e.corroboratedBy) out(`  also seen: #${d.id} item ${d.source_item_id ?? '-'} ${day(d.valid_at)}`);
        return;
      }

      if (sub === 'search') {
        const q = args.slice(1).join(' ');
        if (!q) return fail('usage: pa memory search <query>');
        const { results, lexicalOnly } = await memory.searchClaims(q, {
          subject: flags.about ? String(flags.about) : null,
          asOf: flags['as-of'] ? String(flags['as-of']) : null,
          limit: flagInt(flags, 'n', 15),
        });
        if (!results.length) return out('no matching claims');
        for (const c of results) out(`${claimLine(c)}\n      about ${c.subject_kind} ${c.subject_label}`);
        if (lexicalOnly) out('\n(text search only — embeddings unavailable)');
        return;
      }

      if (sub === 'run') {
        const which = (args[1] || 'all').toLowerCase();
        const limit = flagInt(flags, 'limit', null);
        const llm = require('../llm');
        const t0 = Date.now();
        if (which === 'extract' || which === 'all') {
          const extract = require('../memory/extract');
          const r = await extract.run({ limit: limit || 40, concurrency: flagInt(flags, 'concurrency', 1) });
          out(`extract: ${r.items} items → ${r.claims} claims (${r.dropped} dropped for bad evidence)${r.errors ? `, ${r.errors} failed` : ''}; ${await extract.pendingCount()} items left`);
        }
        if (which === 'consolidate' || which === 'all') {
          const r = await require('../memory/consolidate').run({ limit: limit || 120 });
          const c = r.claims;
          out(`consolidate: ${c.claims} claims (add ${c.add}, supersede ${c.supersede}, duplicate ${c.duplicate}, noop ${c.noop}); commitments reviewed ${r.commitments.reviewed}, superseded ${r.commitments.superseded}`);
        }
        if (which === 'pages' || which === 'all') {
          const r = await require('../memory/pages').run({ limit: limit || 40 });
          out(`pages: ${r.written} written, ${r.unchanged} unchanged, ${r.skipped} skipped${r.errors ? `, ${r.errors} failed` : ''}`);
        }
        if (which === 'dream') {
          const r = await require('../memory/dream').run({ force: true });
          out(`dream: ${JSON.stringify(r)}`);
        }
        const spend = llm.spend();
        out(`(${Math.round((Date.now() - t0) / 1000)}s · ${spend.calls} model calls · $${spend.usd.toFixed(2)} reported)`);
        return;
      }

      if (sub === 'stats') {
        const s = await memory.stats();
        return out(`${s.claims} claims · ${s.active} active · ${s.superseded} superseded · ${s.retracted} retracted · ${s.pending_review} awaiting review · ${s.pages} pages`);
      }

      // pa memory [person|project] <name>
      const typed = sub === 'person' || sub === 'project';
      const name = (typed ? args.slice(1) : args).join(' ');
      if (!name) return fail('usage: pa memory [person|project] <name>');
      const subject = await memory.resolveSubject(typed ? `${sub}:${name}` : name);
      const page = await memory.getPage(subject);
      if (!page) {
        return out(
          subject.kind === 'topic'
            ? `no person or project called "${name}"`
            : `no page for ${subject.label} yet — \`pa memory claims ${name}\` shows what is known`
        );
      }
      out(`${page.body}\n\n(generated ${day(page.generated_at)} · \`pa memory claims ${name}\` for the evidence)`);
    },

    async remember(args, flags) {
      const text = args.join(' ');
      if (!text) return fail('usage: pa remember "<note>" [--about name] [--kind k]');
      const memory = require('../memory');
      const r = await memory.remember(text, {
        subject: flags.about ? String(flags.about) : null,
        kind: flags.kind ? String(flags.kind) : null,
      });
      const c = r.claim;
      out(`remembered #${c.id} about ${c.subject_kind} ${c.subject_label} [${c.kind}]: ${c.text}`);
      if (c.decision === 'supersede') out(`  replaces #${c.target_id}`);
      else if (c.decision === 'duplicate') out(`  already known as #${c.target_id}`);
    },

    async forget(args) {
      const arg = String(args[0] || '');
      const m = arg.match(/^item:(\d+)$/i);
      if (!m && !/^\d+$/.test(arg)) return fail('usage: pa forget <claim-id> | item:<source-item-id>');
      const memory = require('../memory');
      const r = await memory.forget(m ? { item: m[1] } : arg);
      if (!r.retracted) return out('nothing to forget');
      out(`retracted ${r.retracted} claim${r.retracted === 1 ? '' : 's'}${r.restored ? `, restored ${r.restored} it had replaced` : ''}; pages rebuilt`);
    },
  };
}

module.exports = { make, HELP };
