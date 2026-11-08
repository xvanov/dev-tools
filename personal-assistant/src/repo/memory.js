'use strict';

// Aggregate: memory. Tables: memory_page, claim, claim_extraction,
// consolidation, and (read-only, for the memory pass's own inputs) person,
// person_identity, project, project_alias, commitment, commitment_review,
// source_item, setting.
// Callers: src/memory (index, pages, consolidate, extract, dream), src/recall.
//
// Vector and full-text queries (pgvector `<=>`, tsvector `@@`, ts_rank) are
// kept whole, one per method, so phase 3 can reimplement each for SQLite.
// Embeddings travel as the '[0.1,0.2,...]' literal callers format.

/**
 * @typedef {object} ClaimRow  a row of `claim` (see sql/*.sql); embedding and
 * tsv are present on `select *` and stripped by callers that return it.
 * @property {number|string} id
 * @property {string} subject_kind  me | person | project | topic
 * @property {number|string|null} subject_id
 * @property {string} subject_label
 * @property {string} kind
 * @property {string} text
 * @property {string|null} quote
 * @property {string} status  active | pending_review | superseded | retracted
 * @property {number} confidence
 * @property {Date} valid_at
 * @property {Date|null} invalid_at
 */

// The handle forms source_item.author_identity uses for each identity kind.
const HANDLE_SQL = `case pi.kind when 'github_username' then 'github:' || pi.value
                                 when 'gitlab_username' then 'gitlab:' || pi.value
                                 when 'aad_oid' then 'aad:' || pi.value
                                 else pi.value end`;

// Whether anything has acted on a commitment — the same test re-distillation
// uses (distill/index.js) to decide what it may replace.
const ACTED = (a) => `(${a}.status = 'dispatched' or ${a}.touched_at is not null
   or exists (select 1 from draft d where d.commitment_id = ${a}.id)
   or exists (select 1 from run r where r.commitment_id = ${a}.id)
   or exists (select 1 from ledger_transition t where t.commitment_id = ${a}.id)
   or exists (select 1 from ledger_evidence e where e.commitment_id = ${a}.id)
   or exists (select 1 from reply_close rc where rc.commitment_id = ${a}.id))`;

function sameSubjectSql(alias = 'o') {
  return `${alias}.subject_kind = n.subject_kind
      and (case when n.subject_id is not null then ${alias}.subject_id = n.subject_id
                else ${alias}.subject_id is null and lower(${alias}.subject_label) = lower(n.subject_label) end)`;
}

// Claims for one resolved subject {kind, id, label}: a WHERE fragment and its
// params, numbered from `startAt`.
function subjectWhere(s, startAt = 1) {
  if (s.kind === 'topic' || s.id == null) {
    return { sql: `subject_kind = $${startAt} and subject_id is null and lower(subject_label) = lower($${startAt + 1})`, params: [s.kind, s.label] };
  }
  return { sql: `subject_kind = $${startAt} and subject_id = $${startAt + 1}`, params: [s.kind, s.id] };
}

// Source items the claims pass has not yet read, minus machine noise and items
// another item already covers (a review-request notification for a PR that is
// ingested itself).
const pendingWhere = (minBodyChars) => `
  ce.source_item_id is null
  and length(si.body_text) >= ${Number(minBodyChars)}
  and not (si.source = 'github_notification' and (
        coalesce(si.raw->>'action','') in ('ci_activity','approval_requested')
     or exists (select 1 from source_item p
                 where p.source = 'github_pr' and p.thread_external_id = si.thread_external_id)
     or exists (select 1 from source_item n
                 where n.source = 'github_notification' and n.thread_external_id = si.thread_external_id
                   and n.occurred_at > si.occurred_at)))
  and not (si.source = 'graph_mail' and si.subject ~* '^(accepted|declined|tentative|canceled|cancelled)( |:)')`;

function create(db) {
  return {
    // ------------------------------------------------ subjects (memory/index)

    /** The owner's person id, as {id} (null when no person is_me yet). */
    async meId() {
      return db.one('select id from person where is_me limit 1');
    },

    /** A project by name or alias (case-insensitive). @returns {Promise<{id, name}|null>} */
    async projectByNameOrAlias(name) {
      return db.one(
        `select id, name from project where lower(name) = lower($1)
          or id = (select project_id from project_alias where lower(alias) = lower($1) limit 1) limit 1`,
        [name]
      );
    },

    /** Up to two people (not me) whose name, email or identity equals `name`. */
    async peopleExact(name) {
      return db.rows(
        `select distinct p.id, p.display_name from person p left join person_identity pi on pi.person_id = p.id
        where not p.is_me and (lower(p.display_name) = lower($1) or lower(p.primary_email) = lower($1)
           or lower(pi.value) = lower($1))
        limit 2`,
        [name]
      );
    },

    /** Up to two people (not me) whose name or an identity matches the ilike `pattern`. */
    async peopleFuzzy(pattern) {
      return db.rows(
        `select distinct p.id, p.display_name from person p left join person_identity pi on pi.person_id = p.id
            where not p.is_me and (p.display_name ilike $1 or pi.value ilike $1) limit 2`,
        [pattern]
      );
    },

    // ---------------------------------------------------------------- writes

    /**
     * Inserts one claim from `remember` (source_kind 'explicit'); returns the row.
     * @param {object} c  {subjectKind, subjectId, subjectLabel, kind, text, quote, vector (literal|null), confidence, status, origin}
     * @returns {Promise<ClaimRow>}
     */
    async insertNote({ subjectKind, subjectId, subjectLabel, kind, text, quote, vector, confidence, status, origin }) {
      return db.one(
        `insert into claim (subject_kind, subject_id, subject_label, kind, text, quote, source_kind, confidence,
                        status, origin, extracted_by, embedding)
     values ($1,$2,$3,$4,$5,$6,'explicit',$8,$9,$10,'remember',$7::vector)
     returning *`,
        [subjectKind, subjectId, subjectLabel, kind, text, quote, vector, confidence, status, origin]
      );
    },

    /** A claim with its consolidation decision (decision, target_id), or null. */
    async claimWithDecision(id) {
      return db.one(
        `select c.*, k.decision, k.target_id from claim c left join consolidation k on k.claim_id = c.id where c.id = $1`,
        [id]
      );
    },

    /** Every non-retracted claim read from a source item. @returns {Promise<ClaimRow[]>} */
    async liveClaimsByItem(itemId) {
      return db.rows(`select * from claim where source_item_id = $1 and status <> 'retracted'`, [itemId]);
    },

    /** The claim with this id unless retracted (a 0/1-row list). @returns {Promise<ClaimRow[]>} */
    async liveClaimById(id) {
      return db.rows(`select * from claim where id = $1 and status <> 'retracted'`, [id]);
    },

    /** Marks claims retracted (and expired now, if not already). */
    async retractClaims(ids) {
      await db.query(
        `update claim set status = 'retracted', expired_at = coalesce(expired_at, now()) where id = any($1::bigint[])`,
        [ids]
      );
    },

    /**
     * Gives back their belief to superseded claims whose superseding claim is in
     * `ids` (forgetting a correction un-forgets the original). @returns {Promise<number>} rows restored
     */
    async restoreSuperseded(ids) {
      const r = await db.query(
        `update claim o set status = 'active', expired_at = null, invalid_at = null
       from claim n
      where n.id = any($1::bigint[]) and n.supersedes_id = o.id and o.status = 'superseded'`,
        [ids]
      );
      return r.rowCount;
    },

    /** Human-confirmed: pending_review -> active at full confidence. @returns {Promise<ClaimRow|null>} null when not pending */
    async approvePending(claimId) {
      return db.one(
        // Human-confirmed now, so believed as fully as a typed note.
        `update claim set status = 'active', expired_at = null, confidence = 1
      where id = $1 and status = 'pending_review' returning *`,
        [claimId]
      );
    },

    /** A claim's status and subject with its consolidation decision. */
    async claimOutcome(claimId) {
      return db.one(
        `select c.id, c.status, c.subject_kind, c.subject_id, k.decision, k.target_id
       from claim c left join consolidation k on k.claim_id = c.id where c.id = $1`,
        [claimId]
      );
    },

    /** Bumps use_count and last_used_at on claims a search returned. */
    async noteUse(ids) {
      await db.query(
        'update claim set use_count = use_count + 1, last_used_at = now() where id = any($1::bigint[])',
        [ids]
      );
    },

    // ----------------------------------------------------- the dashboard reads

    /** Claims waiting for a human, newest first. */
    async reviewQueue(limit) {
      return db.rows(
        `select c.id, c.status, c.subject_kind, c.subject_id, c.subject_label, c.kind, c.text, c.quote, c.origin, c.source_kind,
            c.confidence, c.valid_at, c.recorded_at, c.source_item_id, si.source, si.subject as source_subject,
            si.raw->>'webUrl' as url, si.raw->>'webLink' as link
       from claim c left join source_item si on si.id = c.source_item_id
      where c.status = 'pending_review'
      order by c.recorded_at desc, c.id desc limit $1`,
        [limit]
      );
    },

    /** People and projects with a page or active claims, and topics with active claims. */
    async subjects() {
      return db.rows(
        `with active as (
       select subject_kind, subject_id, lower(subject_label) as label, count(*)::int as claims,
              max(subject_label) as any_label, max(valid_at) as latest
         from claim where status = 'active' group by 1, 2, 3
     ), named as (
       select subject_kind as kind, subject_id as id, sum(claims)::int as claims, max(latest) as latest,
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
    },

    /** One source item, for following a [#id] citation. */
    async sourceItem(id) {
      return db.one(
        `select id, source, subject, occurred_at, author_identity, body_text,
            raw->>'webUrl' as url, raw->>'webLink' as link
       from source_item where id = $1`,
        [id]
      );
    },

    /** People with what duplicate detection needs to compare them. */
    async peopleForMerge() {
      return db.rows(
        `select p.id, p.display_name, p.primary_email, p.is_me, mp.title as page_title,
            coalesce((select json_agg(json_build_object('kind', pi.kind, 'value', pi.value))
                        from person_identity pi where pi.person_id = p.id), '[]') as identities,
            (select count(*)::int from claim c where c.subject_kind = 'person' and c.subject_id = p.id
                                                and c.status = 'active') as claims,
            (select count(*)::int from commitment c where c.counterparty_person_id = p.id) as commitments
       from person p left join memory_page mp on mp.kind = 'person' and mp.subject_id = p.id
      order by p.id`
      );
    },

    /** The `me` or `index` page (subject_id 0). */
    async pageByKind(kind) {
      return db.one('select * from memory_page where kind = $1 and subject_id = 0', [kind]);
    },

    /** The page of a person or project. */
    async pageBySubject(kind, subjectId) {
      return db.one('select * from memory_page where kind = $1 and subject_id = $2', [kind, subjectId]);
    },

    /**
     * Claims about a subject, newest first. `all`/`asOf` skip the active-only filter.
     * @param {{kind, id, label}} subject  resolved
     * @param {{all?: boolean, asOf?: any, limit?: number}} o
     */
    async claimsFor(subject, { all = false, asOf = null, limit = 200 } = {}) {
      const w = subjectWhere(subject);
      return db.rows(
        `select c.*, si.occurred_at as source_occurred_at, si.subject as source_subject
       from claim c left join source_item si on si.id = c.source_item_id
      where ${w.sql} ${all || asOf ? '' : "and c.status = 'active'"}
      order by c.valid_at desc, c.id desc limit ${Number(limit) || 200}`,
        w.params
      );
    },

    /**
     * Full-text leg of claim search. `subject` (resolved, or null) narrows it.
     * @returns {Promise<(ClaimRow & {rank: number})[]>}
     */
    async searchClaimsLexical(q, { subject = null, asOf = null, limit }) {
      const w = subject ? subjectWhere(subject, 3) : null;
      const statusSql = asOf ? '' : "and c.status = 'active'";
      const params = [q, limit * 3, ...(w ? w.params : [])];
      return db.rows(
        `select c.*, ts_rank(c.tsv, plainto_tsquery('english', $1)) as rank from claim c
      where c.tsv @@ plainto_tsquery('english', $1) ${statusSql} ${w ? `and ${w.sql}` : ''}
      order by rank desc limit $2`,
        params
      );
    },

    /**
     * Vector leg of claim search (pgvector cosine). `vector` is the query's literal.
     * @returns {Promise<(ClaimRow & {rank: number})[]>}
     */
    async searchClaimsVector(vector, { subject = null, asOf = null, limit }) {
      const w = subject ? subjectWhere(subject, 3) : null;
      const statusSql = asOf ? '' : "and c.status = 'active'";
      return db.rows(
        `select c.*, 1 - (c.embedding <=> $1::vector) as rank from claim c
        where c.embedding is not null ${statusSql} ${w ? `and ${w.sql}` : ''}
        order by c.embedding <=> $1::vector limit $2`,
        [vector, limit * 3, ...(w ? w.params : [])]
      );
    },

    /** A claim by id, every column. @returns {Promise<ClaimRow|null>} */
    async claimById(id) {
      return db.one('select * from claim where id = $1', [id]);
    },

    /** The source item behind a claim, for `explain`. */
    async sourceItemBrief(id) {
      return db.one(
        `select id, source, subject, occurred_at, author_identity, raw->>'webUrl' as url,
                raw->>'webLink' as link from source_item where id = $1`,
        [id]
      );
    },

    /** The claim an older claim was replaced by, for `explain`. */
    async supersededClaim(id) {
      return db.one('select id, text, status, valid_at, invalid_at from claim where id = $1', [id]);
    },

    /** Claims that superseded this one. */
    async supersededBy(claimId) {
      return db.rows('select id, text, status, valid_at from claim where supersedes_id = $1 order by id', [claimId]);
    },

    /** Claims kept as corroboration (duplicate_of) of this one. */
    async corroboratedBy(claimId) {
      return db.rows(
        `select c.id, c.quote, c.source_item_id, c.valid_at from claim c where c.duplicate_of = $1 order by c.id`,
        [claimId]
      );
    },

    /** The consolidation row for a claim, or null. */
    async consolidationOf(claimId) {
      return db.one('select * from consolidation where claim_id = $1', [claimId]);
    },

    /** Counts of claims by status, and of pages. */
    async stats() {
      return db.one(
        `select (select count(*) from claim)::int as claims,
            (select count(*) from claim where status = 'active')::int as active,
            (select count(*) from claim where status = 'superseded')::int as superseded,
            (select count(*) from claim where status = 'retracted')::int as retracted,
            (select count(*) from claim where status = 'pending_review')::int as pending_review,
            (select count(*) from memory_page)::int as pages,
            (select max(generated_at) from memory_page) as last_page`
      );
    },

    // ----------------------------------------------------- pages (memory/pages)

    /** People worth a page: enough items, commitments and claims, not me, not a bot. */
    async eligiblePeople(minInteractions) {
      return db.rows(
        `with h as (select pi.person_id, ${HANDLE_SQL} as handle, pi.kind, pi.value from person_identity pi),
          stats as (
            select p.id, p.display_name,
                   (select count(*) from source_item si
                     where si.author_identity in (select handle from h where h.person_id = p.id)) as authored,
                   (select count(*) from source_item si
                     where si.raw ? 'memberEmails'
                       and si.raw->'memberEmails' ?| coalesce((select array_agg(lower(value)) from h
                                                              where h.person_id = p.id and h.kind = 'smtp'), '{}')) as shared,
                   (select count(*) from commitment c where c.counterparty_person_id = p.id) as commitments,
                   (select count(*) from claim c where c.subject_kind = 'person' and c.subject_id = p.id
                                                   and c.status = 'active') as claims
              from person p
             where not p.is_me
               and p.display_name !~* '\\[bot\\]|^github:dependabot|coderabbit'
          )
     select *, authored + shared + commitments + claims as interactions
       from stats
      where authored + shared + commitments + claims >= $1
        and (claims > 0 or commitments > 0)
      order by interactions desc`,
        [minInteractions]
      );
    },

    /** A person row, every column. */
    async personById(personId) {
      return db.one('select * from person where id = $1', [personId]);
    },

    /** A person's identities with the author_identity handle each one appears as. */
    async personIdentities(personId) {
      return db.rows(
        `select ${HANDLE_SQL} as handle, pi.kind, pi.value from person_identity pi where pi.person_id = $1`,
        [personId]
      );
    },

    /** Active, still-valid claims about a person (page input). */
    async personClaims(personId) {
      return db.rows(
        `select id, kind, text, quote, source_item_id, source_kind, valid_at, invalid_at, confidence, status
       from claim where subject_kind = 'person' and subject_id = $1 and status = 'active'
        and (invalid_at is null or invalid_at > now())
      order by valid_at desc limit 60`,
        [personId]
      );
    },

    /** Open commitments with a person as counterparty (page input). */
    async personCommitments(personId) {
      return db.rows(
        `select id, direction, summary, due_at, status, source_item_id, extracted_at
       from commitment where counterparty_person_id = $1 and status in ('open','dispatched')
        and superseded_by is null
      order by due_at nulls last, extracted_at desc limit 20`,
        [personId]
      );
    },

    /** Recent items a person authored or was a member of. `emails` is never empty (callers pass ['-']). */
    async personItems(handles, emails) {
      return db.rows(
        `select id, source, subject, occurred_at, raw->>'webUrl' as url
       from source_item si
      where si.author_identity = any($1::text[])
         or (si.raw ? 'memberEmails' and si.raw->'memberEmails' ?| $2::text[])
      order by occurred_at desc limit 14`,
        [handles, emails]
      );
    },

    /** A project row, every column. */
    async projectById(projectId) {
      return db.one('select * from project where id = $1', [projectId]);
    },

    /** Active, still-valid claims about a project (page input). */
    async projectClaims(projectId) {
      return db.rows(
        `select id, kind, text, quote, source_item_id, source_kind, valid_at, confidence, status
       from claim where subject_kind = 'project' and subject_id = $1 and status = 'active'
        and (invalid_at is null or invalid_at > now())
      order by valid_at desc limit 60`,
        [projectId]
      );
    },

    /** Open commitments on a project, with the counterparty's name as `who`. */
    async projectCommitments(projectId) {
      return db.rows(
        `select c.id, c.direction, c.summary, c.due_at, c.status, c.source_item_id, per.display_name as who
       from commitment c left join person per on per.id = c.counterparty_person_id
      where c.project_id = $1 and c.status in ('open','dispatched') and c.superseded_by is null
      order by c.due_at nulls last, c.extracted_at desc limit 20`,
        [projectId]
      );
    },

    /** Names of people with commitments on a project. */
    async projectPeople(projectId) {
      return db.rows(
        `select distinct per.display_name from commitment c join person per on per.id = c.counterparty_person_id
      where c.project_id = $1 limit 12`,
        [projectId]
      );
    },

    /** Inserts or replaces a page (keeps the old embedding when `vector` is null). */
    async upsertPage({ kind, subjectId, title, body, hash, generatedBy, vector }) {
      await db.query(
        `insert into memory_page (kind, subject_id, title, body, facts_hash, generated_by, embedding)
     values ($1,$2,$3,$4,$5,$6,$7::vector)
     on conflict (kind, subject_id) do update set title = excluded.title, body = excluded.body,
       facts_hash = excluded.facts_hash, generated_at = now(), generated_by = excluded.generated_by,
       embedding = coalesce(excluded.embedding, memory_page.embedding)`,
        [kind, subjectId, title, body, hash, generatedBy, vector]
      );
    },

    /** Pages with no embedding yet. */
    async pagesMissingEmbedding(limit) {
      return db.rows('select id, title, body from memory_page where embedding is null limit $1', [limit]);
    },

    /** Sets a page's embedding. */
    async setPageEmbedding(id, vector) {
      await db.query('update memory_page set embedding = $2::vector where id = $1', [id, vector]);
    },

    /** The facts hash a page was last written from, or null. */
    async pageHash(kind, subjectId) {
      const r = await db.one('select facts_hash from memory_page where kind = $1 and subject_id = $2', [kind, subjectId]);
      return r?.facts_hash || null;
    },

    /** The owner's person row, every column. */
    async mePerson() {
      return db.one('select * from person where is_me limit 1');
    },

    /** Active claims about me (page input). */
    async meClaims() {
      return db.rows(
        `select id, kind, text, quote, source_item_id, source_kind, valid_at, invalid_at, confidence, status
       from claim where subject_kind = 'me' and status = 'active' and (invalid_at is null or invalid_at > now())
      order by confidence desc, valid_at desc limit 120`
      );
    },

    /** What I owe now (page input). */
    async meCommitments() {
      return db.rows(
        `select c.id, c.direction, c.summary, c.due_at, c.status, c.source_item_id, per.display_name as who
       from commitment c left join person per on per.id = c.counterparty_person_id
      where c.status in ('open','dispatched') and c.superseded_by is null and c.direction = 'owed_by_me'
      order by c.extracted_at desc limit 15`
      );
    },

    /** Projects with the most claims in the last 45 days. */
    async activeProjectNames() {
      return db.rows(
        `select p.name, count(*) as n from claim c join project p on p.id = c.subject_id
      where c.subject_kind = 'project' and c.status = 'active' and c.valid_at > now() - interval '45 days'
      group by p.name order by n desc limit 8`
      );
    },

    /** Titles of the most recently generated person pages. */
    async recentPersonPageTitles() {
      return db.rows(`select title from memory_page where kind = 'person' order by generated_at desc limit 15`);
    },

    /** Person pages, for the index. */
    async personPages() {
      return db.rows(`select subject_id, title from memory_page where kind = 'person' order by title`);
    },

    /** Active claims about a person, for the index. */
    async personIndexClaims(personId) {
      return db.rows(
        `select kind, text from claim where subject_kind = 'person' and subject_id = $1 and status = 'active'
          and (invalid_at is null or invalid_at > now()) order by confidence desc, valid_at desc limit 20`,
        [personId]
      );
    },

    /** Projects with an active claim in the last 60 days, for the index. */
    async indexProjects() {
      return db.rows(
        `select p.id, p.name from project p
      where exists (select 1 from claim c where c.subject_kind = 'project' and c.subject_id = p.id
                      and c.status = 'active' and c.valid_at > now() - interval '60 days')
      order by p.last_touched_at desc nulls last, p.name limit 20`
      );
    },

    /** Active claims about a project, for the index. */
    async projectIndexClaims(projectId) {
      return db.rows(
        `select kind, text from claim where subject_kind = 'project' and subject_id = $1 and status = 'active'
          and (invalid_at is null or invalid_at > now()) order by valid_at desc limit 10`,
        [projectId]
      );
    },

    /** Topics with at least two active claims in the last 30 days, for the index. */
    async indexTopics() {
      return db.rows(
        `select subject_label as label, count(*) as n from claim
      where subject_kind = 'topic' and status = 'active' and valid_at > now() - interval '30 days'
      group by subject_label having count(*) >= 2 order by n desc limit 12`
      );
    },

    /** Ids of projects with at least two active claims. */
    async projectIdsWithClaims() {
      return db.rows(
        `select subject_id as id from claim where subject_kind = 'project' and status = 'active'
      group by subject_id having count(*) >= 2`
      );
    },

    /** Deletes a page (after a forget left nothing to say). */
    async deletePage(kind, subjectId) {
      await db.query('delete from memory_page where kind = $1 and subject_id = $2', [kind, subjectId]);
    },

    // ------------------------------------------- consolidation (memory/consolidate)

    /** Active/pending claims with no embedding yet. */
    async claimsMissingEmbedding(limit) {
      return db.rows(
        `select id, subject_label, text from claim where embedding is null
        and status in ('active','pending_review') order by id limit $1`,
        [limit]
      );
    },

    /** Sets a claim's embedding. */
    async setClaimEmbedding(id, vector) {
      await db.query('update claim set embedding = $2::vector where id = $1', [id, vector]);
    },

    /** Candidates by meaning: earlier active claims about the same subject, nearest first. */
    async candidatesByVector(claimId, limit) {
      return db.rows(
        `select o.id, o.kind, o.text, o.valid_at
       from claim n join claim o on ${sameSubjectSql('o')}
      where n.id = $1 and o.id < n.id and o.status = 'active'
        and n.embedding is not null and o.embedding is not null
      order by o.embedding <=> n.embedding
      limit $2`,
        [claimId, limit]
      );
    },

    /** Candidates by words: earlier active claims about the same subject, best text match first. */
    async candidatesByText(claimId, limit) {
      return db.rows(
        `select o.id, o.kind, o.text, o.valid_at
       from claim n join claim o on ${sameSubjectSql('o')}
      where n.id = $1 and o.id < n.id and o.status = 'active'
        and o.tsv @@ plainto_tsquery('english', n.text)
      order by ts_rank(o.tsv, plainto_tsquery('english', n.text)) desc
      limit $2`,
        [claimId, limit]
      );
    },

    /** The two most recent earlier active claims of the same kind about the same subject. */
    async candidatesByKind(claimId) {
      return db.rows(
        `select o.id, o.kind, o.text, o.valid_at
       from claim n join claim o on ${sameSubjectSql('o')} and o.kind = n.kind
      where n.id = $1 and o.id < n.id and o.status = 'active'
      order by o.valid_at desc
      limit 2`,
        [claimId]
      );
    },

    /** SUPERSEDE: closes the target's clocks (only while it is active). */
    async supersedeTarget(target, validAt) {
      await db.query(
        `update claim set status = 'superseded', expired_at = now(),
                invalid_at = coalesce(invalid_at, greatest(valid_at, $2::timestamptz))
          where id = $1 and status = 'active'`,
        [target, validAt]
      );
    },

    /** Records that a claim supersedes `target`. */
    async linkSupersedes(claimId, target) {
      await db.query('update claim set supersedes_id = $2 where id = $1', [claimId, target]);
    },

    /** DUPLICATE: keeps the claim as corroboration of `target`. */
    async markDuplicate(claimId, target) {
      await db.query(
        `update claim set status = 'superseded', expired_at = now(), duplicate_of = $2 where id = $1`,
        [claimId, target]
      );
    },

    /** Corroboration raises confidence in what was already believed. */
    async raiseConfidence(target, confidence) {
      await db.query(
        `update claim set confidence = least(1, greatest(confidence, $2) + 0.05) where id = $1`,
        [target, confidence]
      );
    },

    /** NOOP: retires a claim too vague to remember. */
    async retireNoop(claimId) {
      await db.query(`update claim set status = 'superseded', expired_at = now() where id = $1`, [claimId]);
    },

    /** Records (or re-records) the decision for a claim. */
    async recordDecision(claimId, decision, targetId, decidedBy, reason) {
      await db.query(
        `insert into consolidation (claim_id, decision, target_id, decided_by, error)
       values ($1,$2,$3,$4,$5)
       on conflict (claim_id) do update set decision = excluded.decision, target_id = excluded.target_id,
         decided_by = excluded.decided_by, decided_at = now(), error = excluded.error`,
        [claimId, decision, targetId, decidedBy, reason]
      );
    },

    /** Active claims among `ids` with no consolidation row. @returns {Promise<ClaimRow[]>} */
    async unconsolidatedByIds(ids) {
      return db.rows(
        `select c.* from claim c left join consolidation k on k.claim_id = c.id
          where c.id = any($1::bigint[]) and k.claim_id is null and c.status = 'active' order by c.id`,
        [ids]
      );
    },

    /** The oldest active claims with no consolidation row. @returns {Promise<ClaimRow[]>} */
    async unconsolidatedOldest(limit) {
      return db.rows(
        `select c.* from claim c left join consolidation k on k.claim_id = c.id
          where k.claim_id is null and c.status = 'active' order by c.id limit $1`,
        [limit]
      );
    },

    /** How many active claims await consolidation. */
    async unconsolidatedCount() {
      const r = await db.one(
        `select count(*)::int as n from claim c left join consolidation k on k.claim_id = c.id
      where k.claim_id is null and c.status = 'active'`
      );
      return r?.n ?? 0;
    },

    /**
     * Older open commitments in the same direction from the same item, thread or
     * person as `c` (a wide net; commitments/dupes.js narrows it).
     * @param {{counterparty_person_id, direction, id, extracted_at, source_item_id, thread_external_id}} c
     */
    async olderCommitments(c) {
      return db.rows(
        `select o.id, o.summary, o.due_at, ${ACTED('o')} as acted
       from commitment o join source_item si on si.id = o.source_item_id
      where o.direction = $2 and o.id <> $3
        and o.status in ('open','dispatched') and o.superseded_by is null
        and (o.extracted_at, o.id) < ($4::timestamptz, $3)
        and (o.source_item_id = $5
             or ($6::text is not null and si.thread_external_id = $6)
             or ($1::bigint is not null and o.counterparty_person_id = $1))
      order by o.extracted_at desc limit 80`,
        [c.counterparty_person_id, c.direction, c.id, c.extracted_at, c.source_item_id, c.thread_external_id]
      );
    },

    /** Folds a duplicate commitment into its survivor. @returns {Promise<boolean>} whether a row changed */
    async foldCommitment(dropId, keepId) {
      const r = await db.query(
        `update commitment set superseded_by = $2 where id = $1 and superseded_by is null and status in ('open','dispatched')`,
        [dropId, keepId]
      );
      return r.rowCount > 0;
    },

    /** Commitments not yet reviewed for restatements, oldest first. */
    async commitmentsToReview(limit) {
      return db.rows(
        `select c.id, c.summary, c.detail, c.direction, c.counterparty_person_id, c.due_at, c.extracted_at,
            c.source_item_id, si.thread_external_id, ${ACTED('c')} as acted
       from commitment c left join commitment_review r on r.commitment_id = c.id
       join source_item si on si.id = c.source_item_id
      where r.commitment_id is null
      order by c.extracted_at, c.id
      limit $1`,
        [limit]
      );
    },

    /** Marks a commitment reviewed (a no-op when it already is). */
    async markCommitmentReviewed(id, reviewedBy, supersedes) {
      await db.query(
        `insert into commitment_review (commitment_id, reviewed_by, supersedes) values ($1,$2,$3)
     on conflict (commitment_id) do nothing`,
        [id, reviewedBy, supersedes]
      );
    },

    // -------------------------------------------------- extraction (memory/extract)

    /** Source items with no claim_extraction at `version`, newest first. */
    async pendingExtraction(version, limit, minBodyChars) {
      return db.rows(
        `select si.* from source_item si
       left join claim_extraction ce on ce.source_item_id = si.id and ce.extracted_by = $1
      where ${pendingWhere(minBodyChars)}
      order by si.occurred_at desc
      limit $2`,
        [version, limit]
      );
    },

    /** How many source items await claim extraction at `version`. */
    async pendingExtractionCount(version, minBodyChars) {
      const r = await db.one(
        `select count(*)::int as n from source_item si
       left join claim_extraction ce on ce.source_item_id = si.id and ce.extracted_by = $1
      where ${pendingWhere(minBodyChars)}`,
        [version]
      );
      return r?.n ?? 0;
    },

    /** A person's display name, or null. */
    async personDisplayName(personId) {
      return db.one('select display_name from person where id = $1', [personId]);
    },

    /** Replaces a handle-ish display name with a real one. */
    async setPersonDisplayName(personId, name) {
      await db.query('update person set display_name = $2 where id = $1', [personId, name]);
    },

    /** Re-running an item replaces only claims nobody has consolidated yet. */
    async deleteUnconsolidatedClaims(itemId, version) {
      await db.query(
        `delete from claim where source_item_id = $1 and extracted_by = $2 and origin = 'distill'
          and not exists (select 1 from consolidation k where k.claim_id = claim.id)`,
        [itemId, version]
      );
    },

    /**
     * Inserts one claim extracted from a source item (origin 'distill').
     * @param {object} c  {subjectKind, subjectId, label, kind, text, quote, itemId, source, confidence, validFrom, occurredAt, validUntil, status, version, vector (literal|null)}
     */
    async insertExtractedClaim(c) {
      await db.query(
        `insert into claim (subject_kind, subject_id, subject_label, kind, text, quote, source_item_id,
                            source_kind, confidence, valid_at, invalid_at, status, origin, extracted_by, embedding)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz,$11::timestamptz),$12,$13,'distill',$14,$15::vector)`,
        [
          c.subjectKind, c.subjectId, c.label, c.kind, c.text, c.quote, c.itemId, c.source,
          c.confidence, c.validFrom, c.occurredAt, c.validUntil, c.status, c.version, c.vector,
        ]
      );
    },

    /** Records a successful extraction for an item. */
    async recordExtraction(itemId, version, claims, dropped) {
      await db.query(
        `insert into claim_extraction (source_item_id, extracted_by, claims, dropped, error)
       values ($1,$2,$3,$4,null)
       on conflict (source_item_id) do update set extracted_by = excluded.extracted_by,
         extracted_at = now(), claims = excluded.claims, dropped = excluded.dropped, error = null`,
        [itemId, version, claims, dropped]
      );
    },

    /** Records a failed extraction (retried next pass). */
    async recordExtractionError(itemId, version, message) {
      await db.query(
        `insert into claim_extraction (source_item_id, extracted_by, error) values ($1,$2,$3)
       on conflict (source_item_id) do update set extracted_by = excluded.extracted_by,
         extracted_at = now(), error = excluded.error`,
        [itemId, version, message]
      );
    },

    // ----------------------------------------------------------- dream (memory/dream)

    /** The stored value of a dream marker (a `setting` row), or null. @returns {Promise<{value: any}|null>} */
    async dreamMarker(key) {
      return db.one('select value from setting where key = $1', [key]);
    },

    /** Upserts a dream marker. */
    async saveDreamMarker(key, value) {
      await db.query(
        `insert into setting (key, value, updated_at) values ($1,$2,now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, value]
      );
    },

    /** Subjects with enough active claims and something new since `since` (null = all). */
    async dedupeSubjects(minClaims, since) {
      return db.rows(
        `select subject_kind, subject_id, lower(subject_label) as label, count(*)::int as n
       from claim where status = 'active'
      group by subject_kind, subject_id, lower(subject_label)
     having count(*) >= $1 and ($2::timestamptz is null or max(recorded_at) > $2::timestamptz)
      order by n desc limit 60`,
        [minClaims, since]
      );
    },

    /** Up to 120 active claims of one subject (`label` already lower-cased). */
    async subjectClaims(subjectKind, subjectId, label) {
      return db.rows(
        `select id, kind, text, confidence, valid_at from claim
        where status = 'active' and subject_kind = $1
          and (case when $2::bigint is not null then subject_id = $2 else subject_id is null and lower(subject_label) = $3 end)
        order by id limit 120`,
        [subjectKind, subjectId, label]
      );
    },

    /** Folds duplicates into `keepId`. @returns {Promise<number>} claims closed */
    async mergeDuplicates(dropIds, keepId) {
      const r = await db.query(
        `update claim set status = 'superseded', expired_at = now(), duplicate_of = $2
          where id = any($1::bigint[]) and status = 'active'`,
        [dropIds, keepId]
      );
      return r.rowCount;
    },

    /** Active claims that might have gone stale (status/blocker kinds, or with an end). */
    async staleCandidates() {
      return db.rows(
        `select id, kind, status, valid_at, invalid_at, recorded_at from claim
      where status = 'active' and (kind in ('status','blocker') or invalid_at is not null)`
      );
    },

    /** Closes claims that outlived what they described. @returns {Promise<number>} claims closed */
    async expireClaims(ids) {
      const r = await db.query(
        `update claim set status = 'superseded', expired_at = now(), invalid_at = coalesce(invalid_at, now())
      where id = any($1::bigint[]) and status = 'active'`,
        [ids]
      );
      return r.rowCount;
    },

    // ----------------------------------------------------------- recall

    /** Full-text page search (person/project pages). */
    async searchPagesLexical(q, limit) {
      return db.rows(
        `select id, kind, subject_id, title, left(body, 1500) as body,
            ts_rank(tsv, websearch_to_tsquery('english', $1)) as rank
       from memory_page where kind in ('person','project') and tsv @@ websearch_to_tsquery('english', $1)
      order by rank desc limit $2`,
        [q, limit]
      );
    },

    /** Vector page search (pgvector cosine); `vector` is the query's literal. */
    async searchPagesVector(vector, limit) {
      return db.rows(
        `select id, kind, subject_id, title, left(body, 1500) as body
           from memory_page where kind in ('person','project') and embedding is not null
          order by embedding <=> $1::vector limit $2`,
        [vector, limit]
      );
    },

    // --- for meetings/index.js, meetings/debrief.js

    /**
     * Active blocker claims about me from the 21 days before `now` (3, newest first).
     * @param {Date} now
     * @returns {Promise<{id: number|string, text: string, quote: string|null}[]>}
     */
    async activeBlockers(now) {
      return db.rows(
        `select id, text, quote from claim
      where status = 'active' and kind = 'blocker' and subject_kind = 'me'
        and valid_at > $1::timestamptz - interval '21 days' and invalid_at is null
      order by valid_at desc limit 3`,
        [now]
      );
    },

    /**
     * A person's active claims, newest first (5).
     * @param {number|string} personId
     * @returns {Promise<{id: number|string, text: string}[]>}
     */
    async activeForPerson(personId) {
      return db.rows(
        `select id, text from claim where subject_kind = 'person' and subject_id = $1 and status = 'active'
      order by valid_at desc limit 5`,
        [personId]
      );
    },

    /**
     * A claim learned from a meeting transcript, about a topic (series).
     * @param {{label: string, kind: string, text: string, quote: string, sourceItemId: number|string|null,
     *   validAt: string, extractedBy: string}} c
     * @returns {Promise<{id: number|string}>}
     */
    async insertTopicClaim({ label, kind, text, quote, sourceItemId, validAt, extractedBy }) {
      return db.one(
        `insert into claim (subject_kind, subject_id, subject_label, kind, text, quote, source_item_id, source_kind,
                          confidence, valid_at, status, origin, extracted_by)
       values ('topic', null, $1, $2, $3, $4, $5, 'audio', 0.8, $6, 'active', 'distill', $7) returning id`,
        [label, kind, text, quote, sourceItemId, validAt, extractedBy]
      );
    },

    /**
     * A claim a debrief wrote (about me, or a topic), from an audio item.
     * @param {{subjectKind: string, subjectId: number|string|null, label: string, kind: string, text: string,
     *   quote: string, itemId: number|string, validAt: string, extractedBy: string}} c
     * @returns {Promise<number|string>} the claim id
     */
    async insertDebriefClaim({ subjectKind, subjectId = null, label, kind, text, quote, itemId, validAt, extractedBy }) {
      const r = await db.one(
        `insert into claim (subject_kind, subject_id, subject_label, kind, text, quote, source_item_id, source_kind,
                        confidence, valid_at, status, origin, extracted_by)
     values ($1,$2,$3,$4,$5,$6,$7,'audio',0.8,$8,'active','distill',$9) returning id`,
        [subjectKind, subjectId, label, kind, text, quote, itemId, validAt, extractedBy]
      );
      return r.id;
    },

    /** Retracts a claim (once). */
    async retract(id) {
      await db.query(`update claim set status = 'retracted' where id = $1 and status <> 'retracted'`, [id]);
    },

    // --- for src/distill/index.js

    /** Deletes the facts one item gave at one prompt version (a re-distillation replaces them). */
    async deleteFactsOf(itemId, version) {
      await db.query('delete from fact where source_item_id = $1 and extracted_by = $2', [itemId, version]);
    },

    /** Inserts one fact distilled from an item. `payload` is stored as jsonb. */
    async insertFact(itemId, kind, summary, payload, occurredAt, version) {
      await db.query(
        `insert into fact (source_item_id, kind, summary, payload, occurred_at, extracted_by)
         values ($1,$2,$3,$4,$5,$6)`,
        [itemId, kind, summary, payload, occurredAt, version]
      );
    },

    // --- for src/distill/identity.js (a person merge; run inside repo.withTx)

    /**
     * Makes claims about `fromId` claims about you (`me`).
     * @returns {Promise<number>} claims moved
     */
    async repointClaimsToMe(intoId, fromId) {
      const r = await db.query(
        `update claim set subject_kind = 'me', subject_id = $1, subject_label = 'me'
            where subject_kind = 'person' and subject_id = $2`,
        [intoId, fromId]
      );
      return r.rowCount;
    },

    /**
     * Makes claims about person `fromId` claims about person `intoId`, labelled `name`.
     * @returns {Promise<number>} claims moved
     */
    async repointClaims(intoId, fromId, name) {
      const r = await db.query(
        `update claim set subject_id = $1, subject_label = $3 where subject_kind = 'person' and subject_id = $2`,
        [intoId, fromId, name]
      );
      return r.rowCount;
    },

    /** Deletes a person's memory page (derived; the caller regenerates the survivor's). */
    async deletePersonPage(personId) {
      await db.query(`delete from memory_page where kind = 'person' and subject_id = $1`, [personId]);
    },

    // --- for dashboard/server.js

    /** How many claims wait for a human to vouch for them. */
    async pendingReviewCount() {
      const r = await db.one(`select count(*)::int as n from claim where status = 'pending_review'`);
      return r.n;
    },
  };
}

module.exports = { create };