'use strict';

// SQLite twin of src/repo/memory.js (memory_page, claim, claim_extraction,
// consolidation; reads person, person_identity, project, project_alias,
// commitment, commitment_review, source_item, setting).
//
// What differs from the Postgres SQL, method by method:
//   - Full text: claim_fts / memory_page_fts (FTS5, porter; sql-sqlite/002)
//     instead of tsv @@ plainto_tsquery / websearch_to_tsquery. The query is
//     tokenised here (ftsQuery), English stop words dropped as the 'english'
//     config does, every term quoted; rank is -bm25() (higher is better, > 0),
//     where Postgres has ts_rank. A query of only stop words finds nothing.
//   - Vectors: embedding is a float32 BLOB; the '[...]' literal callers pass
//     goes through pa_vector(); `<=>` is vec_distance_cosine(). An embedding
//     read back (select *) is turned into the same '[...]' text pg returns.
//   - jsonb ->> / ? / ?| : json_extract / json_type / json_each.
//   - Regexes (~*, !~*): LIKE on lower(...) with the same alternatives.
//   - greatest/least skip nulls in pg; max()/min() do not, so nulls are
//     coalesced first.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;
type Row = import('../types.ts').Row;
type Subject = { kind?: unknown; id?: unknown; label?: unknown };

const { NOW, DAY, sinceMs, atLeastChars } = require('./_sql.ts');
const { hammingSql } = require('../../db/sqlite.ts');

const HANDLE_SQL = `case pi.kind when 'github_username' then 'github:' || pi.value
                                 when 'gitlab_username' then 'gitlab:' || pi.value
                                 when 'aad_oid' then 'aad:' || pi.value
                                 else pi.value end`;

const ACTED = (a: unknown) => `(${a}.status = 'dispatched' or ${a}.touched_at is not null
   or exists (select 1 from draft d where d.commitment_id = ${a}.id)
   or exists (select 1 from run r where r.commitment_id = ${a}.id)
   or exists (select 1 from ledger_transition t where t.commitment_id = ${a}.id)
   or exists (select 1 from ledger_evidence e where e.commitment_id = ${a}.id)
   or exists (select 1 from reply_close rc where rc.commitment_id = ${a}.id))`;

function sameSubjectSql(alias: string = 'o') {
  return `${alias}.subject_kind = n.subject_kind
      and (case when n.subject_id is not null then ${alias}.subject_id = n.subject_id
                else ${alias}.subject_id is null and lower(${alias}.subject_label) = lower(n.subject_label) end)`;
}

function subjectWhere(s: Subject, startAt: number = 1, alias: string = '') {
  const p = alias ? `${alias}.` : '';
  if (s.kind === 'topic' || s.id == null) {
    return { sql: `${p}subject_kind = $${startAt} and ${p}subject_id is null and lower(${p}subject_label) = lower($${startAt + 1})`, params: [s.kind, s.label] };
  }
  return { sql: `${p}subject_kind = $${startAt} and ${p}subject_id = $${startAt + 1}`, params: [s.kind, s.id] };
}

// pg's ~* '^(accepted|declined|tentative|canceled|cancelled)( |:)' on the subject.
const INVITE_REPLY = ['accepted', 'declined', 'tentative', 'canceled', 'cancelled']
  .map((w) => `lower(si.subject) like '${w} %' or lower(si.subject) like '${w}:%'`)
  .join(' or ');

// Items not yet extracted at version $1. The terms run in this order, cheapest
// first: the extraction lookup, then the body's length from the record header,
// the thread lookups (indexes only), and raw last, which sits behind the body
// on overflow pages (5k notifications made reading it 0.2 s a pass).
const pendingWhere = (minBodyChars: unknown) => `
  not exists (select 1 from claim_extraction ce where ce.source_item_id = si.id and ce.extracted_by = $1)
  and ${atLeastChars('si.body_text', Number(minBodyChars))}
  and not (si.source = 'github_notification' and (
        exists (select 1 from source_item p
                 where p.source = 'github_pr' and p.thread_external_id = si.thread_external_id)
     or exists (select 1 from source_item n
                 where n.source = 'github_notification' and n.thread_external_id = si.thread_external_id
                   and n.occurred_at > si.occurred_at)
     or coalesce(json_extract(si.raw, '$.action'), '') in ('ci_activity','approval_requested')))
  and not (si.source = 'graph_mail' and (${INVITE_REPLY}))`;

// Postgres's 'english' stop words (snowball): dropped from a full-text query,
// as to_tsquery('english', ...) drops them.
const STOP = new Set(
  ('i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers herself it its itself ' +
    'they them their theirs themselves what which who whom this that these those am is are was were be been being have has had having ' +
    'do does did doing a an the and but if or because as until while of at by for with about against between into through during ' +
    'before after above below to from up down in out on off over under again further then once here there when where why how all any ' +
    'both each few more most other some such no nor not only own same so than too very s t can will just don should now').split(' ')
);

const terms = (s: unknown) => (String(s || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []).filter((w) => !STOP.has(w));
const quote = (w: string) => `"${w.replace(/"/g, '""')}"`;

/** plainto_tsquery: every non-stop word, ANDed. null when nothing is left. */
function ftsQuery(text: string) {
  const t = terms(text);
  return t.length ? t.map(quote).join(' AND ') : null;
}

/**
 * websearch_to_tsquery: words ANDed, "quoted phrases", `or` between
 * alternatives, -word excluded. null when nothing positive is left.
 */
function ftsWebQuery(text: string) {
  const groups: string[][] = [[]]; // OR of ANDs
  const not: string[] = [];
  const re = /(-?)"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    if (m[3] && m[3].toLowerCase() === 'or') {
      if (groups[groups.length - 1]?.length) groups.push([]);
      continue;
    }
    const neg = m[1] === '-' || (m[3] && m[3].startsWith('-'));
    const words = terms(m[2] != null ? m[2] : m[3]);
    if (!words.length) continue;
    const expr = words.length > 1 ? quote(words.join(' ')) : quote(words[0] ?? '');
    if (neg) not.push(expr);
    else groups[groups.length - 1]?.push(expr);
  }
  const ors = groups.filter((g) => g.length).map((g) => (g.length > 1 ? `(${g.join(' AND ')})` : g[0]));
  if (!ors.length) return null;
  let q = ors.length > 1 ? `(${ors.join(' OR ')})` : ors[0];
  for (const n of not) q += ` NOT ${n}`;
  return q;
}

/** A Float32Array embedding as pgvector's text form, as pg returns it. */
const vecText = (v: unknown) => (v instanceof Float32Array ? `[${Array.from(v).join(',')}]` : v);
function pgRow(r: Row | null) {
  if (r && r.embedding != null) r.embedding = vecText(r.embedding);
  return r;
}
const pgRows = (list: Row[]) => list.map(pgRow);

const jsonText = (v: unknown) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));

function create(db: Db) {
  return {
    // ------------------------------------------------ subjects (memory/index)

    async meId() {
      return db.one('select id from person where is_me limit 1');
    },

    async projectByNameOrAlias(name: string) {
      return db.one(
        `select id, name from project where lower(name) = lower($1)
          or id = (select project_id from project_alias where lower(alias) = lower($1) limit 1) limit 1`,
        [name]
      );
    },

    async peopleExact(name: string) {
      return db.rows(
        `select distinct p.id, p.display_name from person p left join person_identity pi on pi.person_id = p.id
        where not p.is_me and (lower(p.display_name) = lower($1) or lower(p.primary_email) = lower($1)
           or lower(pi.value) = lower($1))
        limit 2`,
        [name]
      );
    },

    /** ilike: SQLite's LIKE is case-insensitive (ASCII). */
    async peopleFuzzy(pattern: unknown) {
      return db.rows(
        `select distinct p.id, p.display_name from person p left join person_identity pi on pi.person_id = p.id
            where not p.is_me and (p.display_name like $1 or pi.value like $1) limit 2`,
        [pattern]
      );
    },

    // ---------------------------------------------------------------- writes

    async insertNote({ subjectKind, subjectId, subjectLabel, kind, text, quote: q, vector, confidence, status, origin }: { subjectKind?: unknown; subjectId?: number | string | null; subjectLabel?: unknown; kind?: string | null; text?: string | null; quote?: string | null; vector?: unknown; confidence?: number; status?: string | null; origin?: string | null }) {
      return pgRow(
        await db.one(
          `insert into claim (subject_kind, subject_id, subject_label, kind, text, quote, source_kind, confidence,
                        status, origin, extracted_by, embedding)
     values ($1,$2,$3,$4,$5,$6,'explicit',$8,$9,$10,'remember',pa_vector($7))
     returning *`,
          [subjectKind, subjectId, subjectLabel, kind, text, q, vector, confidence, status, origin]
        )
      );
    },

    async claimWithDecision(id: number | string) {
      return pgRow(await db.one(`select c.*, k.decision, k.target_id from claim c left join consolidation k on k.claim_id = c.id where c.id = $1`, [id]));
    },

    async liveClaimsByItem(itemId: number | string) {
      return pgRows(await db.rows(`select * from claim where source_item_id = $1 and status <> 'retracted'`, [itemId]));
    },

    async liveClaimById(id: number | string) {
      return pgRows(await db.rows(`select * from claim where id = $1 and status <> 'retracted'`, [id]));
    },

    async retractClaims(ids: unknown[]) {
      await db.query(`update claim set status = 'retracted', expired_at = coalesce(expired_at, ${NOW}) where id in (select value from json_each($1))`, [
        (ids || []).map(Number),
      ]);
    },

    async restoreSuperseded(ids: unknown[]) {
      const r = await db.query(
        `update claim set status = 'active', expired_at = null, invalid_at = null
      where status = 'superseded'
        and id in (select n.supersedes_id from claim n where n.id in (select value from json_each($1)))`,
        [(ids || []).map(Number)]
      );
      return r.rowCount;
    },

    async approvePending(claimId: number | string) {
      return pgRow(await db.one(`update claim set status = 'active', expired_at = null, confidence = 1 where id = $1 and status = 'pending_review' returning *`, [claimId]));
    },

    async claimOutcome(claimId: number | string) {
      return db.one(
        `select c.id, c.status, c.subject_kind, c.subject_id, k.decision, k.target_id
       from claim c left join consolidation k on k.claim_id = c.id where c.id = $1`,
        [claimId]
      );
    },

    async noteUse(ids: unknown[]) {
      await db.query(`update claim set use_count = use_count + 1, last_used_at = ${NOW} where id in (select value from json_each($1))`, [(ids || []).map(Number)]);
    },

    // ----------------------------------------------------- the dashboard reads

    async reviewQueue(limit: number) {
      return db.rows(
        `select c.id, c.status, c.subject_kind, c.subject_id, c.subject_label, c.kind, c.text, c.quote, c.origin, c.source_kind,
            c.confidence, c.valid_at, c.recorded_at, c.source_item_id, si.source, si.subject as source_subject,
            json_extract(si.raw, '$.webUrl') as url, json_extract(si.raw, '$.webLink') as link
       from claim c left join source_item si on si.id = c.source_item_id
      where c.status = 'pending_review'
      order by c.recorded_at desc, c.id desc limit $1`,
        [limit]
      );
    },

    async subjects() {
      const rows = await db.rows(
        `with active as (
       select subject_kind, subject_id, lower(subject_label) as label, count(*) as claims,
              max(subject_label) as any_label, max(valid_at) as latest
         from claim where status = 'active' group by 1, 2, 3
     ), named as (
       select subject_kind as kind, subject_id as id, sum(claims) as claims, max(latest) as latest,
              max(any_label) as label
         from active where subject_kind in ('person','project') and subject_id is not null group by 1, 2
     )
     select coalesce(mp.kind, n.kind) as kind, coalesce(mp.subject_id, n.id) as id,
            coalesce(mp.title, per.display_name, pr.name, n.label) as title,
            mp.body, mp.generated_at, coalesce(n.claims, 0) as claims, n.latest
       from memory_page mp
       full join named n on n.kind = mp.kind and n.id = mp.subject_id
       left join person per on per.id = coalesce(mp.subject_id, n.id) and coalesce(mp.kind, n.kind) = 'person'
       left join project pr on pr.id = coalesce(mp.subject_id, n.id) and coalesce(mp.kind, n.kind) = 'project'
      where coalesce(mp.kind, n.kind) in ('person','project')
     union all
     select 'topic', null, any_label, null, null, claims, latest
       from active where subject_kind = 'topic'
     order by 1, 3`
      );
      // A union loses the declared types: give back what pg does.
      return rows.map((r) => ({ ...r, generated_at: r.generated_at == null ? null : new Date(r.generated_at as string), latest: r.latest == null ? null : new Date(r.latest as string) }));
    },

    async sourceItem(id: number | string) {
      return db.one(
        `select id, source, subject, occurred_at, author_identity, body_text,
            json_extract(raw, '$.webUrl') as url, json_extract(raw, '$.webLink') as link
       from source_item where id = $1`,
        [id]
      );
    },

    async peopleForMerge() {
      const rows = await db.rows(
        `select p.id, p.display_name, p.primary_email, p.is_me, mp.title as page_title,
            (select json_group_array(json_object('kind', pi.kind, 'value', pi.value))
               from person_identity pi where pi.person_id = p.id) as identities,
            (select count(*) from claim c where c.subject_kind = 'person' and c.subject_id = p.id
                                         and c.status = 'active') as claims,
            (select count(*) from commitment c where c.counterparty_person_id = p.id) as commitments
       from person p left join memory_page mp on mp.kind = 'person' and mp.subject_id = p.id
      order by p.id`
      );
      return rows.map((r) => ({ ...r, identities: r.identities ? JSON.parse(String(r.identities)) : [] }));
    },

    async pageByKind(kind: string) {
      return pgRow(await db.one('select * from memory_page where kind = $1 and subject_id = 0', [kind]));
    },

    async pageBySubject(kind: string, subjectId: number | string) {
      return pgRow(await db.one('select * from memory_page where kind = $1 and subject_id = $2', [kind, subjectId]));
    },

    async claimsFor(subject: Subject, { all = false, asOf = null, limit = 200 }: { all?: boolean; asOf?: Date | string | number | null; limit?: number } = {}) {
      const w = subjectWhere(subject, 1, 'c');
      return pgRows(
        await db.rows(
          `select c.*, si.occurred_at as source_occurred_at, si.subject as source_subject
       from claim c left join source_item si on si.id = c.source_item_id
      where ${w.sql} ${all || asOf ? '' : "and c.status = 'active'"}
      order by c.valid_at desc, c.id desc limit ${Number(limit) || 200}`,
          w.params
        )
      );
    },

    async searchClaimsLexical(q: string, { subject = null, asOf = null, limit }: { subject?: Subject | null; asOf?: Date | string | number | null; limit?: number }) {
      const match = ftsQuery(q);
      if (!match) return [];
      const w = subject ? subjectWhere(subject, 3, 'c') : null;
      const statusSql = asOf ? '' : "and c.status = 'active'";
      return pgRows(
        await db.rows(
          `select c.*, -bm25(claim_fts) as rank from claim_fts join claim c on c.id = claim_fts.rowid
      where claim_fts match $1 ${statusSql} ${w ? `and ${w.sql}` : ''}
      order by rank desc limit $2`,
          [match, Number(limit) * 3, ...(w ? w.params : [])]
        )
      );
    },

    async searchClaimsVector(vector: unknown, { subject = null, asOf = null, limit }: { subject?: Subject | null; asOf?: Date | string | number | null; limit?: number }) {
      const w = subject ? subjectWhere(subject, 3, 'c') : null;
      const statusSql = asOf ? '' : "and c.status = 'active'";
      // Hamming on the sign bits first (sql-sqlite/007), then exact cosine on the best few hundred.
      const params = [vector, Number(limit) * 3, ...(w ? w.params : [])];
      params.push(vector, Math.max(400, Number(limit) * 30));
      const at = params.length - 1;
      return pgRows(
        await db.rows(
          `select c.*, 1 - vec_distance_cosine(c.embedding, pa_vector($1)) as rank
         from (select b.id from claim_bits b join claim c on c.id = b.id
                where 1 = 1 ${statusSql} ${w ? `and ${w.sql}` : ''}
                order by ${hammingSql('b.bits', `pa_bits(pa_vector($${at}))`)} limit $${at + 1}) k
         join claim c on c.id = k.id
        order by vec_distance_cosine(c.embedding, pa_vector($1)) limit $2`,
          params
        )
      );
    },

    async claimById(id: number | string) {
      return pgRow(await db.one('select * from claim where id = $1', [id]));
    },

    async sourceItemBrief(id: number | string) {
      return db.one(
        `select id, source, subject, occurred_at, author_identity, json_extract(raw, '$.webUrl') as url,
                json_extract(raw, '$.webLink') as link from source_item where id = $1`,
        [id]
      );
    },

    async supersededClaim(id: number | string) {
      return db.one('select id, text, status, valid_at, invalid_at from claim where id = $1', [id]);
    },

    async supersededBy(claimId: number | string) {
      return db.rows('select id, text, status, valid_at from claim where supersedes_id = $1 order by id', [claimId]);
    },

    async corroboratedBy(claimId: number | string) {
      return db.rows(`select c.id, c.quote, c.source_item_id, c.valid_at from claim c where c.duplicate_of = $1 order by c.id`, [claimId]);
    },

    async consolidationOf(claimId: number | string) {
      return db.one('select * from consolidation where claim_id = $1', [claimId]);
    },

    async stats() {
      const r = await db.one(
        `select (select count(*) from claim) as claims,
            (select count(*) from claim where status = 'active') as active,
            (select count(*) from claim where status = 'superseded') as superseded,
            (select count(*) from claim where status = 'retracted') as retracted,
            (select count(*) from claim where status = 'pending_review') as pending_review,
            (select count(*) from memory_page) as pages,
            (select max(generated_at) from memory_page) as last_page`
      );
      if (r) r.last_page = r.last_page == null ? null : new Date(r.last_page as string);
      return r;
    },

    // ----------------------------------------------------- pages (memory/pages)

    async eligiblePeople(minInteractions: unknown) {
      return db.rows(
        // Each table is read once and joined, not once per person: per person, the
        // member-email check parsed every item's JSON again (69 s on the work
        // stack's 106 people and 6.8k items, all of it blocking the event loop).
        `with h as materialized (select pi.person_id, ${HANDLE_SQL} as handle, pi.kind, pi.value from person_identity pi),
          authored as (
            select h.person_id, count(distinct si.id) as n from source_item si join h on si.author_identity = h.handle group by 1
          ),
          members as materialized (
            select si.id as item, m.value as email from source_item si, json_each(si.raw, '$.memberEmails') m
             where json_type(si.raw, '$.memberEmails') is not null
          ),
          shared as (
            select h.person_id, count(distinct mb.item) as n from members mb join h on h.kind = 'smtp' and lower(h.value) = mb.email group by 1
          ),
          commitments as (select counterparty_person_id as pid, count(*) as n from commitment group by 1),
          claims as (select subject_id as pid, count(*) as n from claim where subject_kind = 'person' and status = 'active' group by 1),
          stats as (
            select p.id, p.display_name,
                   coalesce(a.n, 0) as authored, coalesce(s.n, 0) as shared,
                   coalesce(cm.n, 0) as commitments, coalesce(cl.n, 0) as claims
              from person p
              left join authored a on a.person_id = p.id
              left join shared s on s.person_id = p.id
              left join commitments cm on cm.pid = p.id
              left join claims cl on cl.pid = p.id
             where not p.is_me
               and not (lower(p.display_name) like '%[bot]%' or lower(p.display_name) like 'github:dependabot%'
                        or lower(p.display_name) like '%coderabbit%')
          )
     select *, authored + shared + commitments + claims as interactions
       from stats
      where authored + shared + commitments + claims >= $1
        and (claims > 0 or commitments > 0)
      order by interactions desc`,
        [minInteractions]
      );
    },

    async personById(personId: number | string) {
      return db.one('select * from person where id = $1', [personId]);
    },

    async personIdentities(personId: number | string) {
      return db.rows(`select ${HANDLE_SQL} as handle, pi.kind, pi.value from person_identity pi where pi.person_id = $1`, [personId]);
    },

    async personClaims(personId: number | string) {
      return db.rows(
        `select id, kind, text, quote, source_item_id, source_kind, valid_at, invalid_at, confidence, status
       from claim where subject_kind = 'person' and subject_id = $1 and status = 'active'
        and (invalid_at is null or invalid_at > ${NOW})
      order by valid_at desc limit 60`,
        [personId]
      );
    },

    async personCommitments(personId: number | string) {
      return db.rows(
        `select id, direction, summary, due_at, status, source_item_id, extracted_at
       from commitment where counterparty_person_id = $1 and status in ('open','dispatched')
        and superseded_by is null
      order by due_at nulls last, extracted_at desc limit 20`,
        [personId]
      );
    },

    async personItems(handles: unknown, emails: unknown[]) {
      // The ids from the author index and the member-listing items
      // (source_item_members_idx, sql-sqlite/008) first: as one `or` the
      // planner walked the items newest first, reading each one's raw to test
      // it (0.2-0.5 s a person, ~20 people a pages pass).
      return db.rows(
        `with k as materialized (
         select a.id from source_item a where a.author_identity in (select value from json_each($1))
         union
         select m.id from source_item m indexed by source_item_members_idx
          where json_type(m.raw, '$.memberEmails') is not null
            and exists (select 1 from json_each(m.raw, '$.memberEmails') e where e.value in (select value from json_each($2)))
       ), top as (
         select k.id from k join source_item s on s.id = k.id order by s.occurred_at desc limit 14
       )
     select si.id, si.source, si.subject, si.occurred_at, json_extract(si.raw, '$.webUrl') as url
       from top t join source_item si on si.id = t.id
      order by si.occurred_at desc`,
        [handles || [], emails || []]
      );
    },

    async projectById(projectId: number | string) {
      return db.one('select * from project where id = $1', [projectId]);
    },

    async projectClaims(projectId: number | string) {
      return db.rows(
        `select id, kind, text, quote, source_item_id, source_kind, valid_at, confidence, status
       from claim where subject_kind = 'project' and subject_id = $1 and status = 'active'
        and (invalid_at is null or invalid_at > ${NOW})
      order by valid_at desc limit 60`,
        [projectId]
      );
    },

    async projectCommitments(projectId: number | string) {
      return db.rows(
        `select c.id, c.direction, c.summary, c.due_at, c.status, c.source_item_id, per.display_name as who
       from commitment c left join person per on per.id = c.counterparty_person_id
      where c.project_id = $1 and c.status in ('open','dispatched') and c.superseded_by is null
      order by c.due_at nulls last, c.extracted_at desc limit 20`,
        [projectId]
      );
    },

    async projectPeople(projectId: number | string) {
      return db.rows(
        `select distinct per.display_name from commitment c join person per on per.id = c.counterparty_person_id
      where c.project_id = $1 limit 12`,
        [projectId]
      );
    },

    async upsertPage({ kind, subjectId, title, body, hash, generatedBy, vector }: { kind?: string | null; subjectId?: number | string | null; title?: string | null; body?: string | null; hash?: string | null; generatedBy?: unknown; vector?: unknown }) {
      await db.query(
        `insert into memory_page (kind, subject_id, title, body, facts_hash, generated_by, embedding)
     values ($1,$2,$3,$4,$5,$6,pa_vector($7))
     on conflict (kind, subject_id) do update set title = excluded.title, body = excluded.body,
       facts_hash = excluded.facts_hash, generated_at = ${NOW}, generated_by = excluded.generated_by,
       embedding = coalesce(excluded.embedding, memory_page.embedding)`,
        [kind, subjectId, title, body, hash, generatedBy, vector]
      );
    },

    async pagesMissingEmbedding(limit: number) {
      return db.rows('select id, title, body from memory_page where embedding is null limit $1', [limit]);
    },

    async setPageEmbedding(id: number | string, vector: unknown) {
      await db.query('update memory_page set embedding = pa_vector($2) where id = $1', [id, vector]);
    },

    async pageHash(kind: string, subjectId: number | string) {
      const r = await db.one('select facts_hash from memory_page where kind = $1 and subject_id = $2', [kind, subjectId]);
      return r?.facts_hash || null;
    },

    async mePerson() {
      return db.one('select * from person where is_me limit 1');
    },

    async meClaims() {
      return db.rows(
        `select id, kind, text, quote, source_item_id, source_kind, valid_at, invalid_at, confidence, status
       from claim where subject_kind = 'me' and status = 'active' and (invalid_at is null or invalid_at > ${NOW})
      order by confidence desc, valid_at desc limit 120`
      );
    },

    async meCommitments() {
      return db.rows(
        `select c.id, c.direction, c.summary, c.due_at, c.status, c.source_item_id, per.display_name as who
       from commitment c left join person per on per.id = c.counterparty_person_id
      where c.status in ('open','dispatched') and c.superseded_by is null and c.direction = 'owed_by_me'
      order by c.extracted_at desc limit 15`
      );
    },

    async activeProjectNames() {
      return db.rows(
        `select p.name, count(*) as n from claim c join project p on p.id = c.subject_id
      where c.subject_kind = 'project' and c.status = 'active' and c.valid_at > $1
      group by p.name order by n desc limit 8`,
        [sinceMs(45 * DAY)]
      );
    },

    async recentPersonPageTitles() {
      return db.rows(`select title from memory_page where kind = 'person' order by generated_at desc, id desc limit 15`);
    },

    async personPages() {
      return db.rows(`select subject_id, title from memory_page where kind = 'person' order by title`);
    },

    async personIndexClaims(personId: number | string) {
      return db.rows(
        `select kind, text from claim where subject_kind = 'person' and subject_id = $1 and status = 'active'
          and (invalid_at is null or invalid_at > ${NOW}) order by confidence desc, valid_at desc limit 20`,
        [personId]
      );
    },

    async indexProjects() {
      return db.rows(
        `select p.id, p.name from project p
      where exists (select 1 from claim c where c.subject_kind = 'project' and c.subject_id = p.id
                      and c.status = 'active' and c.valid_at > $1)
      order by p.last_touched_at desc nulls last, p.name limit 20`,
        [sinceMs(60 * DAY)]
      );
    },

    async projectIndexClaims(projectId: number | string) {
      return db.rows(
        `select kind, text from claim where subject_kind = 'project' and subject_id = $1 and status = 'active'
          and (invalid_at is null or invalid_at > ${NOW}) order by valid_at desc limit 10`,
        [projectId]
      );
    },

    async indexTopics() {
      return db.rows(
        `select subject_label as label, count(*) as n from claim
      where subject_kind = 'topic' and status = 'active' and valid_at > $1
      group by subject_label having count(*) >= 2 order by n desc limit 12`,
        [sinceMs(30 * DAY)]
      );
    },

    async projectIdsWithClaims() {
      return db.rows(
        `select subject_id as id from claim where subject_kind = 'project' and status = 'active'
      group by subject_id having count(*) >= 2`
      );
    },

    async deletePage(kind: string, subjectId: number | string) {
      await db.query('delete from memory_page where kind = $1 and subject_id = $2', [kind, subjectId]);
    },

    // ------------------------------------------- consolidation (memory/consolidate)

    async claimsMissingEmbedding(limit: number) {
      // Named (sql-sqlite/008), as the planner otherwise starts from the status
      // and reads every active claim's vector to test it (0.3 s).
      return db.rows(
        `select id, subject_label, text from claim indexed by claim_unembedded_idx where embedding is null
        and status in ('active','pending_review') order by id limit $1`,
        [limit]
      );
    },

    async setClaimEmbedding(id: number | string, vector: unknown) {
      await db.query('update claim set embedding = pa_vector($2) where id = $1', [id, vector]);
    },

    async candidatesByVector(claimId: number | string, limit: number) {
      return db.rows(
        `select o.id, o.kind, o.text, o.valid_at
       from claim n join claim o on ${sameSubjectSql('o')}
      where n.id = $1 and o.id < n.id and o.status = 'active'
        and n.embedding is not null and o.embedding is not null
      order by vec_distance_cosine(o.embedding, n.embedding)
      limit $2`,
        [claimId, limit]
      );
    },

    async candidatesByText(claimId: number | string, limit: number) {
      const n = await db.one('select text from claim where id = $1', [claimId]);
      const match = n && ftsQuery(String(n.text));
      if (!match) return [];
      return db.rows(
        `select o.id, o.kind, o.text, o.valid_at
       from claim_fts join claim o on o.id = claim_fts.rowid
       join claim n on n.id = $1 and ${sameSubjectSql('o')}
      where claim_fts match $3 and o.id < n.id and o.status = 'active'
      order by bm25(claim_fts)
      limit $2`,
        [claimId, limit, match]
      );
    },

    async candidatesByKind(claimId: number | string) {
      return db.rows(
        `select o.id, o.kind, o.text, o.valid_at
       from claim n join claim o on ${sameSubjectSql('o')} and o.kind = n.kind
      where n.id = $1 and o.id < n.id and o.status = 'active'
      order by o.valid_at desc, o.id desc
      limit 2`,
        [claimId]
      );
    },

    async supersedeTarget(target: unknown, validAt: unknown) {
      await db.query(
        `update claim set status = 'superseded', expired_at = ${NOW},
                invalid_at = coalesce(invalid_at, max(valid_at, coalesce($2, valid_at)))
          where id = $1 and status = 'active'`,
        [target, validAt]
      );
    },

    async linkSupersedes(claimId: number | string, target: unknown) {
      await db.query('update claim set supersedes_id = $2 where id = $1', [claimId, target]);
    },

    async markDuplicate(claimId: number | string, target: unknown) {
      await db.query(`update claim set status = 'superseded', expired_at = ${NOW}, duplicate_of = $2 where id = $1`, [claimId, target]);
    },

    async raiseConfidence(target: unknown, confidence: number) {
      await db.query(`update claim set confidence = min(1, max(confidence, coalesce($2, confidence)) + 0.05) where id = $1`, [target, confidence]);
    },

    async retireNoop(claimId: number | string) {
      await db.query(`update claim set status = 'superseded', expired_at = ${NOW} where id = $1`, [claimId]);
    },

    async recordDecision(claimId: number | string, decision: string, targetId: number | string, decidedBy: unknown, reason: string) {
      await db.query(
        `insert into consolidation (claim_id, decision, target_id, decided_by, error)
       values ($1,$2,$3,$4,$5)
       on conflict (claim_id) do update set decision = excluded.decision, target_id = excluded.target_id,
         decided_by = excluded.decided_by, decided_at = ${NOW}, error = excluded.error`,
        [claimId, decision, targetId, decidedBy, reason]
      );
    },

    async unconsolidatedByIds(ids: unknown[]) {
      return pgRows(
        await db.rows(
          `select c.* from claim c left join consolidation k on k.claim_id = c.id
          where c.id in (select value from json_each($1)) and k.claim_id is null and c.status = 'active' order by c.id`,
          [(ids || []).map(Number)]
        )
      );
    },

    async unconsolidatedOldest(limit: number) {
      // Ids from the active claims' index first, then the rows: in id order the
      // planner scans the table, reading every claim's vector (0.4 s).
      return pgRows(
        await db.rows(
          `select c.* from (
             select a.id from claim a indexed by claim_subject_active_idx left join consolidation k on k.claim_id = a.id
              where k.claim_id is null and a.status = 'active' order by a.id limit $1
           ) t join claim c on c.id = t.id
          order by c.id`,
          [limit]
        )
      );
    },

    async unconsolidatedCount() {
      const r = await db.one(
        `select count(*) as n from claim c left join consolidation k on k.claim_id = c.id
      where k.claim_id is null and c.status = 'active'`
      );
      return r?.n ?? 0;
    },

    async olderCommitments(c: Row) {
      const rows = await db.rows(
        `select o.id, o.summary, o.due_at, ${ACTED('o')} as acted
       from commitment o join source_item si on si.id = o.source_item_id
      where o.direction = $2 and o.id <> $3
        and o.status in ('open','dispatched') and o.superseded_by is null
        and (o.extracted_at, o.id) < ($4, $3)
        and (o.source_item_id = $5
             or ($6 is not null and si.thread_external_id = $6)
             or ($1 is not null and o.counterparty_person_id = $1))
      order by o.extracted_at desc limit 80`,
        [c.counterparty_person_id, c.direction, c.id, c.extracted_at, c.source_item_id, c.thread_external_id]
      );
      return rows.map((r) => ({ ...r, acted: Boolean(r.acted) }));
    },

    async foldCommitment(dropId: number | string, keepId: number | string) {
      const r = await db.query(
        `update commitment set superseded_by = $2 where id = $1 and superseded_by is null and status in ('open','dispatched')`,
        [dropId, keepId]
      );
      return (r.rowCount ?? 0) > 0;
    },

    async commitmentsToReview(limit: number) {
      const rows = await db.rows(
        `select c.id, c.summary, c.detail, c.direction, c.counterparty_person_id, c.due_at, c.extracted_at,
            c.source_item_id, si.thread_external_id, ${ACTED('c')} as acted
       from commitment c left join commitment_review r on r.commitment_id = c.id
       join source_item si on si.id = c.source_item_id
      where r.commitment_id is null
      order by c.extracted_at, c.id
      limit $1`,
        [limit]
      );
      return rows.map((r) => ({ ...r, acted: Boolean(r.acted) }));
    },

    async markCommitmentReviewed(id: number | string, reviewedBy: unknown, supersedes: unknown) {
      await db.query(
        `insert into commitment_review (commitment_id, reviewed_by, supersedes) values ($1,$2,$3)
     on conflict (commitment_id) do nothing`,
        [id, reviewedBy, supersedes]
      );
    },

    // -------------------------------------------------- extraction (memory/extract)

    async pendingExtraction(version: string, limit: number, minBodyChars: unknown) {
      return db.rows(
        `select si.* from source_item si
      where ${pendingWhere(minBodyChars)}
      order by si.occurred_at desc
      limit $2`,
        [version, limit]
      );
    },

    async pendingExtractionCount(version: string, minBodyChars: unknown) {
      const r = await db.one(
        `select count(*) as n from source_item si
      where ${pendingWhere(minBodyChars)}`,
        [version]
      );
      return r?.n ?? 0;
    },

    async personDisplayName(personId: number | string) {
      return db.one('select display_name from person where id = $1', [personId]);
    },

    async setPersonDisplayName(personId: number | string, name: string) {
      await db.query('update person set display_name = $2 where id = $1', [personId, name]);
    },

    async deleteUnconsolidatedClaims(itemId: number | string, version: string) {
      await db.query(
        `delete from claim where source_item_id = $1 and extracted_by = $2 and origin = 'distill'
          and not exists (select 1 from consolidation k where k.claim_id = claim.id)`,
        [itemId, version]
      );
    },

    async insertExtractedClaim(c: Row) {
      await db.query(
        `insert into claim (subject_kind, subject_id, subject_label, kind, text, quote, source_item_id,
                            source_kind, confidence, valid_at, invalid_at, status, origin, extracted_by, embedding)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10,$11),$12,$13,'distill',$14,pa_vector($15))`,
        [
          c.subjectKind, c.subjectId, c.label, c.kind, c.text, c.quote, c.itemId, c.source,
          c.confidence, c.validFrom, c.occurredAt, c.validUntil, c.status, c.version, c.vector,
        ]
      );
    },

    async recordExtraction(itemId: number | string, version: string, claims: unknown, dropped: unknown) {
      await db.query(
        `insert into claim_extraction (source_item_id, extracted_by, claims, dropped, error)
       values ($1,$2,$3,$4,null)
       on conflict (source_item_id) do update set extracted_by = excluded.extracted_by,
         extracted_at = ${NOW}, claims = excluded.claims, dropped = excluded.dropped, error = null`,
        [itemId, version, claims, dropped]
      );
    },

    async recordExtractionError(itemId: number | string, version: string, message: string) {
      await db.query(
        `insert into claim_extraction (source_item_id, extracted_by, error) values ($1,$2,$3)
       on conflict (source_item_id) do update set extracted_by = excluded.extracted_by,
         extracted_at = ${NOW}, error = excluded.error`,
        [itemId, version, message]
      );
    },

    // ----------------------------------------------------------- dream (memory/dream)

    async dreamMarker(key: number | string) {
      return db.one('select value from setting where key = $1', [key]);
    },

    async saveDreamMarker(key: number | string, value: string) {
      await db.query(
        `insert into setting (key, value, updated_at) values ($1,$2,${NOW})
     on conflict (key) do update set value = excluded.value, updated_at = ${NOW}`,
        [key, jsonText(value)]
      );
    },

    async dedupeSubjects(minClaims: unknown, since: Date | string | number) {
      return db.rows(
        `select subject_kind, subject_id, lower(subject_label) as label, count(*) as n
       from claim where status = 'active'
      group by subject_kind, subject_id, lower(subject_label)
     having count(*) >= $1 and ($2 is null or max(recorded_at) > $2)
      order by n desc limit 60`,
        [minClaims, since]
      );
    },

    async subjectClaims(subjectKind: unknown, subjectId: number | string, label: string) {
      return db.rows(
        `select id, kind, text, confidence, valid_at from claim
        where status = 'active' and subject_kind = $1
          and (case when $2 is not null then subject_id = $2 else subject_id is null and lower(subject_label) = $3 end)
        order by id limit 120`,
        [subjectKind, subjectId, label]
      );
    },

    async mergeDuplicates(dropIds: unknown[], keepId: number | string) {
      const r = await db.query(
        `update claim set status = 'superseded', expired_at = ${NOW}, duplicate_of = $2
          where id in (select value from json_each($1)) and status = 'active'`,
        [(dropIds || []).map(Number), keepId]
      );
      return r.rowCount;
    },

    async staleCandidates() {
      return db.rows(
        `select id, kind, status, valid_at, invalid_at, recorded_at from claim
      where status = 'active' and (kind in ('status','blocker') or invalid_at is not null)`
      );
    },

    async expireClaims(ids: unknown[]) {
      const r = await db.query(
        `update claim set status = 'superseded', expired_at = ${NOW}, invalid_at = coalesce(invalid_at, ${NOW})
      where id in (select value from json_each($1)) and status = 'active'`,
        [(ids || []).map(Number)]
      );
      return r.rowCount;
    },

    // ----------------------------------------------------------- recall

    async searchPagesLexical(q: string, limit: number) {
      const match = ftsWebQuery(q);
      if (!match) return [];
      return db.rows(
        `select p.id, p.kind, p.subject_id, p.title, substr(p.body, 1, 1500) as body, -bm25(memory_page_fts) as rank
       from memory_page_fts join memory_page p on p.id = memory_page_fts.rowid
      where memory_page_fts match $1 and p.kind in ('person','project')
      order by rank desc limit $2`,
        [match, limit]
      );
    },

    async searchPagesVector(vector: unknown, limit: number) {
      return db.rows(
        `select id, kind, subject_id, title, substr(body, 1, 1500) as body
           from memory_page where kind in ('person','project') and embedding is not null
          order by vec_distance_cosine(embedding, pa_vector($1)) limit $2`,
        [vector, limit]
      );
    },

    // --- for meetings/index.js, meetings/debrief.js

    async activeBlockers(now: Date | string | number) {
      return db.rows(
        `select id, text, quote from claim
      where status = 'active' and kind = 'blocker' and subject_kind = 'me'
        and valid_at > $1 and invalid_at is null
      order by valid_at desc, id desc limit 3`,
        [sinceMs(21 * DAY, now)]
      );
    },

    async activeForPerson(personId: number | string) {
      return db.rows(
        `select id, text from claim where subject_kind = 'person' and subject_id = $1 and status = 'active'
      order by valid_at desc, id desc limit 5`,
        [personId]
      );
    },

    async insertTopicClaim({ label, kind, text, quote: q, sourceItemId, validAt, extractedBy }: { label?: string | null; kind?: string | null; text?: string | null; quote?: string | null; sourceItemId?: number | string | null; validAt?: unknown; extractedBy?: string | null }) {
      return db.one(
        `insert into claim (subject_kind, subject_id, subject_label, kind, text, quote, source_item_id, source_kind,
                          confidence, valid_at, status, origin, extracted_by)
       values ('topic', null, $1, $2, $3, $4, $5, 'audio', 0.8, $6, 'active', 'distill', $7) returning id`,
        [label, kind, text, q, sourceItemId, validAt, extractedBy]
      );
    },

    async insertDebriefClaim({ subjectKind, subjectId = null, label, kind, text, quote: q, itemId, validAt, extractedBy }: { subjectKind?: unknown; subjectId?: number | string | null; label?: string | null; kind?: string | null; text?: string | null; quote?: string | null; itemId?: number | string | null; validAt?: unknown; extractedBy?: string | null }) {
      const r = await db.one(
        `insert into claim (subject_kind, subject_id, subject_label, kind, text, quote, source_item_id, source_kind,
                        confidence, valid_at, status, origin, extracted_by)
     values ($1,$2,$3,$4,$5,$6,$7,'audio',0.8,$8,'active','distill',$9) returning id`,
        [subjectKind, subjectId, label, kind, text, q, itemId, validAt, extractedBy]
      );
      return r?.id;
    },

    async retract(id: number | string) {
      await db.query(`update claim set status = 'retracted' where id = $1 and status <> 'retracted'`, [id]);
    },

    // --- for src/distill/index.js

    async deleteFactsOf(itemId: number | string, version: string) {
      await db.query('delete from fact where source_item_id = $1 and extracted_by = $2', [itemId, version]);
    },

    async insertFact(itemId: number | string, kind: string, summary: string, payload: Row, occurredAt: Date | string | number, version: string) {
      await db.query(
        `insert into fact (source_item_id, kind, summary, payload, occurred_at, extracted_by)
         values ($1,$2,$3,$4,$5,$6)`,
        [itemId, kind, summary, jsonText(payload), occurredAt, version]
      );
    },

    // --- for src/distill/identity.js

    async repointClaimsToMe(intoId: number | string, fromId: number | string) {
      const r = await db.query(
        `update claim set subject_kind = 'me', subject_id = $1, subject_label = 'me'
            where subject_kind = 'person' and subject_id = $2`,
        [intoId, fromId]
      );
      return r.rowCount;
    },

    async repointClaims(intoId: number | string, fromId: number | string, name: string) {
      const r = await db.query(`update claim set subject_id = $1, subject_label = $3 where subject_kind = 'person' and subject_id = $2`, [intoId, fromId, name]);
      return r.rowCount;
    },

    async deletePersonPage(personId: number | string) {
      await db.query(`delete from memory_page where kind = 'person' and subject_id = $1`, [personId]);
    },

    /** How many claims wait for a human to vouch for them. */
    async pendingReviewCount() {
      const r = await db.one(`select count(*) as n from claim where status = 'pending_review'`);
      return r?.n;
    },
  };
}

module.exports = { create, ftsQuery, ftsWebQuery };
