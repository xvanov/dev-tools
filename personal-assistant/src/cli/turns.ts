'use strict';

// `pa turns`: the turn log (src/chat/turnLog.ts, table turn_log), what was said
// to Jarvis and what it answered, newest first.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

/** JSON read or built key by key (src/types.ts): loose until its producer is TypeScript. */
type Json = import('../types.ts').Json;

const HELP = `
  Turn log (every thing said to Jarvis, and its answer; PA_TURN_LOG, PA_TURN_LOG_DAYS)
    pa turns [--limit 20] [--voice|--typed|--doorbell] [--route answer|handoff] [--grep "words"] [--days N]
                                       newest first: the words, how the fast lane routed them (p, signals),
                                       what it said, and the PA chat's answer and tools
    pa turns show <id>                 one turn whole, with the snapshot the router saw
    pa turns --json                    the rows as JSON (with show too)
    pa turns --eval [--out file.json]  voice turns as router eval cases (src/eval/router-cases.json's
                                       shape, labelled from what happened: review every label before use)
`;

const one = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function pLine(t: Json): string {
  if (!t.route) return '';
  const p = t.p ? ` p ${['answer_here', 'hand_off', 'action'].map((k) => (t.p[k] == null ? null : `${k.split('_')[0]} ${Number(t.p[k]).toFixed(2)}`)).filter(Boolean).join(' / ')}` : '';
  const s = t.signals ? ` · tool ${t.signals.tool ?? '?'} · effort ${t.signals.effort ?? '?'}${t.signals.actsOutside != null ? ` · outside ${Number(t.signals.actsOutside).toFixed(2)}` : ''}` : '';
  return `${t.route}${t.overridden ? ' (guard)' : ''} by ${t.router || '?'}${t.decisionMs != null ? ` in ${t.decisionMs} ms` : ''}${p}${s}${t.fellBack ? ' · fell back' : ''}`;
}

function print(out: (s: string) => void, t: Json, full = false) {
  const when = String(t.at || '').replace('T', ' ').slice(0, 19);
  out(`#${t.id} · ${when} · ${t.channel} · ${t.status}${t.replyMs != null ? ` · chat ${(t.replyMs / 1000).toFixed(1)} s` : ''}`);
  out(`  you:    ${full ? t.text : one(t.text, 160)}`);
  const route = pLine(t);
  if (route) out(`  route:  ${route}`);
  if (t.fastSay) out(`  jarvis: ${full ? t.fastSay : one(t.fastSay, 160)}`);
  if (t.tools?.length) out(`  tools:  ${t.tools.join(', ')}`);
  if (t.reply) out(`  chat:   ${full ? t.reply.replace(/\n/g, '\n          ') : one(t.reply, 200)}`);
  if (t.error) out(`  error:  ${t.error}${t.handoffError ? ` (${t.handoffError})` : ''}`);
  if (full) {
    if (t.reason) out(`  reason: ${t.reason}`);
    for (const h of t.history || []) out(`  before: ${h.type}: ${one(h.text, 200)}`);
    if (t.context) out(`  snapshot:\n    ${String(t.context).replace(/\n/g, '\n    ')}`);
  }
}

function make(out: (s: string) => void, fail: (s: string) => void) {
  return {
    async turns(args: any, flags: any) {
      const L = require('../chat/turnLog.ts');
      if (String(args[0] || '') === 'show') {
        const id = Number(args[1]);
        if (!id) return fail('usage: pa turns show <id>');
        const row = await require('../repo').turns.byId(id);
        if (!row) return fail(`no turn #${id}`);
        const t = L.view(row);
        if (flags.json) return out(JSON.stringify(t, null, 2));
        return print(out, t, true);
      }
      const channel = flags.voice ? 'voice' : flags.typed ? 'typed' : flags.doorbell ? 'doorbell' : null;
      const days = Number(flags.days) || null;
      const filter = {
        limit: Number(flags.limit) || (flags.eval ? 1000 : 20),
        channel: flags.eval ? 'voice' : channel,
        route: typeof flags.route === 'string' ? flags.route : null,
        q: typeof flags.grep === 'string' ? flags.grep : null,
        since: days ? new Date(Date.now() - days * 86_400_000).toISOString() : null,
      };
      const rows: Json[] = await L.list(filter);
      if (flags.eval) {
        const cases = rows.map(L.evalCase).filter(Boolean).reverse();
        const doc = JSON.stringify({ about: 'Voice turns from the turn log (pa turns --eval). Each label is what happened, not what should have: review every one before adding it to src/eval/router-cases.json.', cases }, null, 2);
        if (typeof flags.out === 'string') {
          require('fs').writeFileSync(flags.out, `${doc}\n`, 'utf8');
          return out(`${cases.length} cases written to ${flags.out}`);
        }
        return out(doc);
      }
      if (flags.json) return out(JSON.stringify(rows, null, 2));
      if (!rows.length) return out(L.enabled() ? 'no turns logged yet' : 'no turns: the turn log is off (PA_TURN_LOG=off)');
      for (const t of rows.reverse()) print(out, t);
    },
  };
}

module.exports = { make, HELP, pLine };
