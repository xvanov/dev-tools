'use strict';

// SQLite twin of src/repo/ledger.js (ledger_transition, ledger_evidence, and
// the commitment's status columns). The reconciler's dirty set uses a window
// function where Postgres uses a lateral join; the repo-folder match on
// another machine's cwd compares path segments with LIKE instead of arrays.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;
type Row = import('../types.ts').Row;

const { STATUS_COLUMNS, WINDOW_DAYS } = require('../ledger.ts');
const { NOW, sinceMs, atLeastChars } = require('./_sql.ts');

const SESSION_SETTLE_MINUTES = 10;

/** Text instants an expression column returned (no declared type to decode by) as Dates. */
function dates(row: Row | null, ...cols: string[]) {
  if (row) for (const c of cols) { const v = row[c]; if (typeof v === 'string') row[c] = new Date(v); }
  return row;
}

// Author forms of a person's identities, for `person_id = <expr>` (as Postgres).
const FORMS_OF = (personExpr: unknown) => `(select case pi.kind when 'smtp' then lower(pi.value)
                       when 'aad_oid' then 'aad:' || lower(pi.value)
                       when 'github_username' then 'github:' || lower(pi.value) end
         from person_identity pi where pi.person_id = ${personExpr})`;

// A path with backslashes as slashes, lower-cased; and its last segment.
const SLASHED = (x: unknown) => `lower(replace(${x}, char(92), '/'))`;
const BASENAME = (x: unknown) => `substr(${SLASHED(x)}, length(rtrim(${SLASHED(x)}, replace(${SLASHED(x)}, '/', ''))) + 1)`;

// $1 = my author forms, $2 = max commitments, $3 = max items per commitment,
// $4 = only these commitment ids (null: all), $5 = sessions settled before,
// $6 = "fresh" evidence after. See src/repo/ledger.js DIRTY for the why of each rule.
// Used for commitments never checked (ledger_checked_at is null): their window
// is the occurred_at index (sql-sqlite/008). A checked commitment does not use
// this. Walking every ask's 30-day window on source_item_window_idx was
// 120-230 ms idle and 250-480 ms with new items, every minute, on the loop.
// dirty() instead reads items fetched since the oldest check (source_item_fresh_idx,
// sql-sqlite/011) and matches them in process. An idle pass is one index seek.
const DIRTY = `
  with o as (
    select c.id, c.direction, c.summary, c.detail, c.counterparty_person_id, c.ledger_checked_at,
           si.id as item_id, si.source, si.thread_external_id, si.occurred_at as asked_at,
           si.body_text as ask_text, per.display_name as counterparty,
           pr.gitlab_path, pr.repo_path, ${BASENAME('pr.repo_path')} as repo_base
      from commitment c
      join source_item si on si.id = c.source_item_id
      left join person per on per.id = c.counterparty_person_id
      left join project pr on pr.id = c.project_id and pr.active
     where c.status = 'open' and c.superseded_by is null
       and ($4 is null or c.id in (select value from json_each($4)))
  ),
  cand as (
    select o.id as cid, r.id, r.fetched_at,
           row_number() over (
             partition by o.id
             order by (o.thread_external_id is not null and r.source = o.source and r.thread_external_id = o.thread_external_id) desc, r.fetched_at, r.id
           ) as n
      from o join source_item r
        on r.id in (select w.id from source_item w indexed by source_item_window_idx
                     where w.occurred_at > o.asked_at
                       and w.occurred_at < strftime('%Y-%m-%dT%H:%M:%fZ', o.asked_at, '+${WINDOW_DAYS} days')
                       and w.fetched_at > coalesce(o.ledger_checked_at, '')
                    union all select o.item_id)
       and (r.id <> o.item_id or r.raw->>'repaired' is not null)
       and (r.occurred_at > o.asked_at or r.id = o.item_id)
       and r.occurred_at < strftime('%Y-%m-%dT%H:%M:%fZ', o.asked_at, '+${WINDOW_DAYS} days')
       and r.fetched_at > coalesce(o.ledger_checked_at, '')
       and r.source <> 'graph_event'
       and (r.source <> 'claude_session' or r.fetched_at < $5)
       and ${atLeastChars('r.body_text', 8)}
       and (
         r.id = o.item_id
         or (o.thread_external_id is not null and r.source = o.source and r.thread_external_id = o.thread_external_id)
         or (o.direction = 'owed_to_me' and o.counterparty_person_id is not null
             and lower(coalesce(r.author_identity, '')) in ${FORMS_OF('o.counterparty_person_id')}
             and (r.source in ('graph_chat', 'graph_mail')
                  or (o.gitlab_path is not null and r.source like 'github%' and lower(r.raw->>'project') = lower(o.gitlab_path))))
         or (lower(coalesce(r.author_identity, '')) in (select value from json_each($1)) and (
               (o.gitlab_path is not null and r.source like 'github%' and lower(r.raw->>'project') = lower(o.gitlab_path))
               or (o.repo_path is not null and r.source = 'claude_session'
                   and (lower(r.raw->>'cwd') like lower(o.repo_path) || '%'
                        or (r.raw->>'machine' is not null and o.repo_base <> ''
                            and '/' || ${SLASHED("r.raw->>'cwd'")} || '/' like '%/' || o.repo_base || '/%')))))
       )
  )
  select o.id, o.direction, o.summary, o.detail, o.counterparty, o.asked_at, o.ask_text, o.source,
         json_group_array(cand.id order by cand.fetched_at, cand.id) as item_ids, max(cand.fetched_at) as through
    from o join cand on cand.cid = o.id and cand.n <= $3
   group by o.id
   order by (max(cand.fetched_at) > $6) desc,
            coalesce(o.ledger_checked_at, ''),
            max(cand.fetched_at) desc
   limit $2`;

// Open commitments, without the ask's body (loaded only for the rows returned).
// Times stay text: a JS Date drops the microseconds fetched_at keeps, and a
// truncated check is older than the item it covered, so the ask stays dirty.
const OPEN = `
  select c.id, c.direction, c.summary, c.detail, c.counterparty_person_id,
         cast(coalesce(c.ledger_checked_at, '') as text) as ledger_checked_at,
         si.id as item_id, si.source, si.thread_external_id, cast(si.occurred_at as text) as asked_at,
         per.display_name as counterparty,
         pr.gitlab_path, pr.repo_path, ${BASENAME('pr.repo_path')} as repo_base,
         strftime('%Y-%m-%dT%H:%M:%fZ', si.occurred_at, '+${WINDOW_DAYS} days') as window_end
    from commitment c
    join source_item si on si.id = c.source_item_id
    left join person per on per.id = c.counterparty_person_id
    left join project pr on pr.id = c.project_id and pr.active
   where c.status = 'open' and c.superseded_by is null
     and ($1 is null or c.id in (select value from json_each($1)))`;

// Items fetched after $1. $1 is ' ' || the oldest check, and substr drops the
// space: a bound ISO string would be re-encoded and lose its microseconds.
// $2 = sessions settled before this (a live Claude session is not evidence yet).
const FRESH = `
  select id, cast(fetched_at as text) as fetched_at, cast(occurred_at as text) as occurred_at, source, thread_external_id, author_identity,
         case when json_type(raw, '$.repaired') is not null then 1 else 0 end as repaired,
         json_extract(raw, '$.project') as project,
         json_extract(raw, '$.cwd') as cwd,
         json_extract(raw, '$.machine') as machine
    from source_item indexed by source_item_fresh_idx
   where fetched_at > substr($1, 2)
     and source <> 'graph_event'
     and (source <> 'claude_session' or fetched_at < $2)
     and ${atLeastChars('body_text', 8)}`;

const FORMS = `
  select person_id,
         case kind when 'smtp' then lower(value)
                   when 'aad_oid' then 'aad:' || lower(value)
                   when 'github_username' then 'github:' || lower(value) end as form
    from person_identity
   where person_id in (select value from json_each($1))`;

/** SQLite LIKE, both sides already lower-cased: % and _ in the pattern are wildcards. */
function like(text: string, pattern: string) {
  let re = '';
  for (const ch of pattern) {
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$').test(text);
}

function sameThread(c: Row, item: Row) {
  return c.thread_external_id != null && c.thread_external_id !== '' && item.source === c.source && item.thread_external_id === c.thread_external_id;
}

function pushMap(map: Map<string, Row[]>, key: string, item: Row) {
  let list = map.get(key);
  if (!list) map.set(key, list = []);
  list.push(item);
}

/**
 * Which fresh items belong to each checked commitment. The rules are DIRTY's
 * (src/repo/ledger.js); the scan is one read of the fresh items, not one
 * window per commitment.
 */
function matchChecked(commitments: Row[], items: Row[], { mine, forms, perCommitment }: { mine: Set<string>; forms: Map<string, Set<string>>; perCommitment: number }) {
  const byThread = new Map<string, Row[]>();
  const chatByAuthor = new Map<string, Row[]>();
  const githubByAuthor = new Map<string, Row[]>();
  const sessions: Row[] = [];
  const byId = new Map<number, Row>();
  for (const item of items) {
    byId.set(Number(item.id), item);
    if (item.thread_external_id) pushMap(byThread, `${item.source}\0${item.thread_external_id}`, item);
    const author = String(item.author_identity || '').toLowerCase();
    if (item.source === 'graph_chat' || item.source === 'graph_mail') pushMap(chatByAuthor, author, item);
    else if (/^github/i.test(String(item.source))) pushMap(githubByAuthor, author, item);
    else if (item.source === 'claude_session') sessions.push(item);
  }
  const out: Row[] = [];
  for (const c of commitments) {
    const cand = new Map<number, Row>();
    const add = (item: Row | undefined) => {
      if (!item || !related(c, item, mine, forms)) return;
      cand.set(Number(item.id), item);
    };
    if (c.thread_external_id) for (const item of byThread.get(`${c.source}\0${c.thread_external_id}`) || []) add(item);
    // Owed to me: what they wrote in chat, mail, or this ask's repo. My own
    // chat only counts in the thread (above); elsewhere only my GitHub and
    // sessions do, matching DIRTY.
    if (c.direction === 'owed_to_me' && c.counterparty_person_id != null) {
      for (const a of forms.get(String(c.counterparty_person_id)) || []) {
        for (const item of chatByAuthor.get(a) || []) add(item);
        for (const item of githubByAuthor.get(a) || []) add(item);
      }
    }
    for (const a of mine) for (const item of githubByAuthor.get(a) || []) add(item);
    for (const item of sessions) if (mine.has(String(item.author_identity || '').toLowerCase())) add(item);
    add(byId.get(Number(c.item_id)));
    if (!cand.size) continue;
    const ranked = [...cand.values()].sort((a, b) => {
      const as = sameThread(c, a) ? 1 : 0;
      const bs = sameThread(c, b) ? 1 : 0;
      if (as !== bs) return bs - as;
      const af = String(a.fetched_at);
      const bf = String(b.fetched_at);
      if (af < bf) return -1;
      if (af > bf) return 1;
      return Number(a.id) - Number(b.id);
    });
    const kept = ranked.slice(0, perCommitment);
    kept.sort((a, b) => {
      const af = String(a.fetched_at);
      const bf = String(b.fetched_at);
      return af < bf ? -1 : af > bf ? 1 : Number(a.id) - Number(b.id);
    });
    let through = String(kept[0]?.fetched_at ?? '');
    for (const item of kept) if (String(item.fetched_at) > through) through = String(item.fetched_at);
    out.push({
      id: c.id,
      direction: c.direction,
      summary: c.summary,
      detail: c.detail,
      counterparty: c.counterparty,
      asked_at: c.asked_at,
      source: c.source,
      item_id: c.item_id,
      item_ids: kept.map((i) => Number(i.id)),
      through,
      ledger_checked_at: c.ledger_checked_at || '',
    });
  }
  return out;
}

function related(c: Row, item: Row, mine: Set<string>, forms: Map<string, Set<string>>) {
  if (!(String(item.fetched_at) > String(c.ledger_checked_at))) return false;
  const self = Number(item.id) === Number(c.item_id);
  if (!(String(item.occurred_at) > String(c.asked_at) || self)) return false;
  if (!(String(item.occurred_at) < String(c.window_end))) return false;
  // The ask itself counts only once its text arrived later (raw.repaired).
  // Its own thread would otherwise match it on every pass.
  if (self && !item.repaired) return false;
  if (self || sameThread(c, item)) return true;
  const author = String(item.author_identity || '').toLowerCase();
  const project = String(item.project || '').toLowerCase() === String(c.gitlab_path || '').toLowerCase();
  const github = /^github/i.test(String(item.source)) && c.gitlab_path && project;
  if (c.direction === 'owed_to_me' && c.counterparty_person_id != null) {
    const set = forms.get(String(c.counterparty_person_id));
    if (set && set.has(author) && (item.source === 'graph_chat' || item.source === 'graph_mail' || github)) return true;
  }
  if (mine.has(author)) {
    if (github) return true;
    if (c.repo_path && item.source === 'claude_session') {
      const cwd = String(item.cwd || '').toLowerCase();
      const repo = String(c.repo_path).toLowerCase();
      if (like(cwd, `${repo}%`)) return true;
      if (item.machine && c.repo_base && like(`/${cwd.replace(/\\/g, '/')}/`, `%/${c.repo_base}/%`)) return true;
    }
  }
  return false;
}

function stamp(v: unknown) {
  if (v instanceof Date) return v.toISOString();
  return String(v || '');
}

function setClause(cols: string[]) {
  for (const k of cols) if (!STATUS_COLUMNS.includes(k)) throw new Error(`a transition does not write commitment.${k}`);
  return cols.map((k, i) => `${k} = $${i + 2}`).join(', ');
}

function create(db: Db) {
  return {
    /** A commitment's status columns (inside withTx the transaction holds the write lock), or null. */
    async lockCommitment(commitmentId: number | string) {
      return db.one('select id, status, closed_at, closed_reason, touched_at from commitment where id = $1', [commitmentId]);
    },

    /** Writes a commitment's status columns (`set`: STATUS_COLUMNS only). */
    async setCommitment(commitmentId: number | string, set: Row) {
      const cols = Object.keys(set);
      await db.query(`update commitment set ${setClause(cols)} where id = $1`, [commitmentId, ...cols.map((k) => set[k])]);
    },

    /** Records one change. Resolves the transition id. */
    async insertTransition({ commitmentId, from, to, actor, reason, evidenceId, before, at }: { commitmentId?: number | string | null; from?: Date | string | number | null; to?: string | null; actor?: string | null; reason?: string | null; evidenceId?: number | string | null; before?: Row | null; at?: Date | string | number | null }) {
      const t = await db.one(
        `insert into ledger_transition (commitment_id, from_status, to_status, actor, reason, evidence_id, before, at)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [commitmentId, from, to, actor, reason, evidenceId, before, at]
      );
      return Number(t?.id);
    },

    /** One transition (inside withTx), or null. */
    async lockTransition(transitionId: number | string) {
      return db.one('select * from ledger_transition where id = $1', [transitionId]);
    },

    /** Marks a transition undone, with what the undo did (`result`). */
    async markUndone(transitionId: number | string, result: string) {
      await db.query(`update ledger_transition set undone_at = ${NOW}, undo = $2 where id = $1`, [transitionId, result]);
    },

    /** The newest change of a commitment that is not undone, or null. */
    async latest(commitmentId: number | string) {
      const list = await db.rows(
        'select * from ledger_transition where commitment_id = $1 and undone_at is null order by at desc, id desc limit 1',
        [commitmentId]
      );
      return list[0] || null;
    },

    /** Every change of a commitment, newest first, with its evidence's quote, item and confidence. */
    async history(commitmentId: number | string) {
      return db.rows(
        `select t.*, e.quote, e.source_item_id, e.confidence
       from ledger_transition t left join ledger_evidence e on e.id = t.evidence_id
      where t.commitment_id = $1 order by t.at desc, t.id desc`,
        [commitmentId]
      );
    },

    /** The reconciler's "progresses" quotes for commitments, newest first. */
    async progressQuotes(commitmentIds: unknown[]) {
      return db.rows(
        `select commitment_id, quote from ledger_evidence
        where commitment_id in (select value from json_each($1)) and effect = 'progresses' and quote is not null
        order by created_at desc, id desc`,
        [(commitmentIds || []).map(Number)]
      );
    },

    /** Open asks with items the judge has not seen (see src/repo/ledger.js). */
    async dirty({ myForms, limit, perCommitment, ids = null }: { myForms?: unknown[] | null; limit?: number | null; perCommitment?: number | null; ids?: unknown[] | null }) {
      const idList = ids && ids.length ? ids.map(Number) : null;
      const open = await db.rows(OPEN, [idList]);
      if (!open.length) return [];
      const cap = limit == null ? open.length : Number(limit);
      const per = perCommitment == null ? 10 : Number(perCommitment);
      const freshAfter = sinceMs(15 * 60_000);
      const settledBefore = sinceMs(SESSION_SETTLE_MINUTES * 60_000);
      const unchecked = open.filter((c: Row) => !c.ledger_checked_at);
      const checked = open.filter((c: Row) => c.ledger_checked_at);
      const parts: Row[] = [];
      if (unchecked.length) {
        // Never-checked asks still walk their window. There are few of them
        // (a new ask), and they sort ahead of a checked ask with nothing fresh.
        const rows = await db.rows(DIRTY, [myForms || [], cap, per, unchecked.map((c: Row) => Number(c.id)), settledBefore, freshAfter]);
        for (const r of rows) {
          r.item_ids = JSON.parse(String(r.item_ids));
          r.ledger_checked_at = '';
          parts.push(r);
        }
      }
      if (checked.length) {
        let oldest = String(checked[0]?.ledger_checked_at ?? '');
        for (const c of checked) if (String(c.ledger_checked_at) < oldest) oldest = String(c.ledger_checked_at);
        // Idle: nothing fetched since every open ask was checked. One seek.
        const hit = await db.one(
          'select 1 as x from source_item indexed by source_item_fresh_idx where fetched_at > substr($1, 2) limit 1',
          [' ' + oldest]
        );
        if (hit) {
          const items = await db.rows(FRESH, [' ' + oldest, settledBefore]);
          const people = [...new Set(checked.filter((c: Row) => c.direction === 'owed_to_me' && c.counterparty_person_id != null).map((c: Row) => Number(c.counterparty_person_id)))];
          const forms = new Map<string, Set<string>>();
          if (people.length) {
            for (const r of await db.rows(FORMS, [people])) {
              if (!r.form) continue;
              const id = String(r.person_id);
              let set = forms.get(id);
              if (!set) forms.set(id, set = new Set());
              set.add(String(r.form));
            }
          }
          const mine = new Set((myForms || []).map((s) => String(s)));
          parts.push(...matchChecked(checked, items, { mine, forms, perCommitment: per }));
        }
      }
      parts.sort((a, b) => {
        const fa = stamp(a.through) > freshAfter ? 0 : 1;
        const fb = stamp(b.through) > freshAfter ? 0 : 1;
        if (fa !== fb) return fa - fb;
        const ca = stamp(a.ledger_checked_at);
        const cb = stamp(b.ledger_checked_at);
        if (ca < cb) return -1;
        if (ca > cb) return 1;
        const ta = stamp(a.through);
        const tb = stamp(b.through);
        if (ta < tb) return 1;
        if (ta > tb) return -1;
        return Number(a.id) - Number(b.id);
      });
      const out = parts.slice(0, cap);
      const need = out.filter((r) => r.ask_text == null && r.item_id != null);
      if (need.length) {
        const bodies = new Map((await db.rows('select id, body_text from source_item where id in (select value from json_each($1))', [need.map((r) => Number(r.item_id))])).map((r: Row) => [Number(r.id), r.body_text]));
        for (const r of need) r.ask_text = bodies.get(Number(r.item_id)) ?? null;
      }
      for (const r of out) {
        delete r.ledger_checked_at;
        delete r.item_id;
        dates(r, 'through', 'asked_at');
      }
      return out;
    },

    /** Which of these commitments you reopened yourself (and did not undo): their ids, as strings. */
    async reopenedByYou(ids: unknown[]) {
      const list = await db.rows(
        `select distinct commitment_id from ledger_transition
      where commitment_id in (select value from json_each($1)) and actor = 'you' and to_status = 'open' and from_status <> to_status and undone_at is null`,
        [(ids || []).map(Number)]
      );
      return new Set(list.map((r) => String(r.commitment_id)));
    },

    /** The judge's evidence for one (commitment, item, judge version): inserted or updated in place. Resolves its id. */
    async upsertEvidence({ commitmentId, sourceItemId, effect, quote, confidence, extractedBy }: { commitmentId?: number | string | null; sourceItemId?: number | string | null; effect?: string | null; quote?: string | null; confidence?: number | null; extractedBy?: string | null }) {
      const ev = await db.one(
        `insert into ledger_evidence (commitment_id, source_item_id, effect, quote, confidence, method, extracted_by, applied)
         values ($1,$2,$3,$4,$5,'llm',$6,0)
         on conflict (commitment_id, source_item_id, extracted_by) do update
            set effect = excluded.effect, quote = excluded.quote, confidence = excluded.confidence, created_at = ${NOW}
         returning id`,
        [commitmentId, sourceItemId, effect, quote, confidence, extractedBy]
      );
      return Number(ev?.id);
    },

    /** Marks evidence as applied (its close went through). */
    async markEvidenceApplied(evidenceId: number | string) {
      await db.query('update ledger_evidence set applied = 1 where id = $1', [evidenceId]);
    },

    /** The judge saw these items: ledger_checked_at moves to the newest of their fetched_at, never backwards. */
    async markChecked(commitmentId: number | string, itemIds: unknown[]) {
      await db.query(
        `update commitment set ledger_checked_at = max(coalesce(ledger_checked_at, t.through), t.through)
             from (select max(fetched_at) as through from source_item where id in (select value from json_each($2))) t
            where commitment.id = $1 and t.through is not null`,
        [commitmentId, (itemIds || []).map(Number)]
      );
    },

    /** Closes the judge proposed, newest per open commitment, shown on the survivor of a duplicate group. */
    async proposals({ limit, minConfidence }: { limit?: number | null; minConfidence?: number | null }) {
      return db.rows(
        `select id, commitment_id, effect, quote, confidence, created_at, summary, direction, source, author_identity, url
       from (
         select e.id, c.id as commitment_id, e.effect, e.quote, e.confidence, e.created_at,
                c.summary, c.direction, si.source, si.author_identity, coalesce(si.raw->>'webUrl', si.raw->>'url') as url,
                row_number() over (partition by c.id order by e.created_at desc, e.id desc) as n
           from ledger_evidence e
           join commitment o on o.id = e.commitment_id
           join commitment c on c.id = coalesce(o.superseded_by, o.id) and c.status = 'open' and c.superseded_by is null
           left join source_item si on si.id = e.source_item_id
          where e.effect in ('closes','moot') and not e.applied and e.decision is null and e.confidence >= $2)
      where n = 1
      order by commitment_id
      limit $1`,
        [limit, minConfidence]
      );
    },

    /** One evidence row, or null. */
    async evidenceById(evidenceId: number | string) {
      return db.one('select * from ledger_evidence where id = $1', [evidenceId]);
    },

    /** Your answer to a proposal: `decision` accepted | rejected, and whether its close applied. */
    async decideEvidence(evidenceId: number | string, decision: string, applied: boolean) {
      await db.query(`update ledger_evidence set decision = $2, decided_at = ${NOW}, applied = $3 where id = $1`, [evidenceId, decision, Boolean(applied)]);
    },

    /** The reconciler's record: {closed, reopened (by you after it closed), proposed, last (newest evidence)}. */
    async reconcileStats() {
      return dates(
        await db.one(
          `select (select count(*) from ledger_transition where actor = 'reconciler' and undone_at is null) as closed,
            (select count(*) from ledger_transition t where actor = 'reconciler'
               and exists (select 1 from ledger_transition u where u.commitment_id = t.commitment_id
                            and u.actor = 'you' and u.to_status = 'open' and u.at > t.at)) as reopened,
            (select count(*) from ledger_evidence where effect in ('closes','moot') and not applied and decision is null) as proposed,
            (select max(created_at) from ledger_evidence) as last`
        ),
        'last'
      );
    },

    /** Pending (unapplied, undecided) evidence that a commitment is done or moot, newest first, at most two. */
    async pendingEvidenceFor(commitmentId: number | string) {
      return db.rows(
        `select effect, quote, confidence from ledger_evidence
      where commitment_id = $1 and effect in ('closes','moot') and not applied and decision is null
      order by created_at desc, id desc limit 2`,
        [commitmentId]
      );
    },

    /** The id of the newest not yet undone transition the reply-close pass made on a commitment. */
    async latestReplyCloseTransition(commitmentId: number | string) {
      return db.one(
        `select id from ledger_transition where commitment_id = $1 and actor = 'reply-close' and undone_at is null
      order by at desc, id desc limit 1`,
        [commitmentId]
      );
    },

    /** The source items evidence rows point at, for a "looks done" card. */
    async evidenceItems(evidenceIds: unknown[]) {
      const rows = await db.rows(
        `select e.id as evidence_id, si.id, si.source, si.external_id, si.thread_external_id, si.subject, si.occurred_at,
                  json_remove(si.raw, '$.members', '$.memberEmails', '$.audioPaths') as raw
             from ledger_evidence e join source_item si on si.id = e.source_item_id
            where e.id in (select value from json_each($1))`,
        [(evidenceIds || []).map(Number)]
      );
      for (const r of rows) if (typeof r.raw === 'string') r.raw = JSON.parse(r.raw);
      return rows;
    },
  };
}

module.exports = { create, STATUS_COLUMNS, DIRTY, WINDOW_DAYS };
