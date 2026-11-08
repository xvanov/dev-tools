'use strict';

// Contract: src/repo/memory.js (see test/repoContract.test.js).
//
// The vector and full-text methods use unique alphabetic tokens (`word`) so a
// case finds exactly its own rows in a store the other cases share.

const word = (uniq) => 'zq' + uniq('').replace(/[^0-9a-f]/g, '').replace(/[0-9]/g, (d) => 'ghijklmnop'[d]);
const vec = (i) => `[${Array.from({ length: 1536 }, (_, j) => (j === i ? 1 : 0)).join(',')}]`;
const ids = (list) => list.map((r) => Number(r.id));
const DAY = 86_400_000;
const ago = (ms) => new Date(Date.now() - ms);

const topic = (label) => ({ subjectKind: 'topic', subjectId: null, subjectLabel: label });
/** An explicit note (insertNote) with overrides. */
const note = (repos, o = {}) =>
  repos.memory.insertNote({ ...topic('contract topic'), kind: 'status', text: 'a note', quote: 'q', vector: null, confidence: 1, status: 'active', origin: 'explicit', ...o });
/** An extracted claim (insertExtractedClaim) on a source item; returns its id. */
async function extracted(repos, seed, o = {}) {
  const itemId = o.itemId || (await seed.sourceItem());
  await repos.memory.insertExtractedClaim({
    subjectKind: 'topic', subjectId: null, label: 'contract topic', kind: 'status', text: 'an extracted claim', quote: 'q',
    itemId, source: 'graph_mail', confidence: 0.8, validFrom: null, occurredAt: new Date(), validUntil: null, status: 'active',
    version: 'contract-v1', vector: null, ...o,
  });
  const mine = await repos.memory.liveClaimsByItem(itemId);
  return { itemId, id: Number(mine[mine.length - 1].id) };
}

module.exports = {
  // ------------------------------------------------------------- subjects

  'meId: the owner\'s person id': async ({ repos, seed, assert }) => {
    const id = await seed.memPerson({ isMe: true });
    assert.strictEqual(Number((await repos.memory.meId()).id), id);
  },

  'projectByNameOrAlias: by name or alias, any case; unknown is null': async ({ repos, seed, uniq, assert }) => {
    const name = uniq('proj');
    const alias = uniq('alias');
    const id = await seed.memProject({ name, alias });
    assert.deepStrictEqual(await repos.memory.projectByNameOrAlias(name.toUpperCase()), { id: String(id), name });
    assert.strictEqual(Number((await repos.memory.projectByNameOrAlias(alias.toUpperCase())).id), id);
    assert.strictEqual(await repos.memory.projectByNameOrAlias(uniq('nobody')), null);
  },

  'peopleExact: by name, email or identity value, never me': async ({ repos, seed, uniq, assert }) => {
    const w = uniq('exact');
    const id = await seed.memPerson({ name: `Pat ${w}`, email: `${w}@example.test` });
    await seed.memIdentity(id, 'github_username', `gh-${w}`);
    for (const key of [`pat ${w}`, `${w}@EXAMPLE.test`, `GH-${w}`]) {
      assert.deepStrictEqual(ids(await repos.memory.peopleExact(key)), [id], key);
    }
    assert.deepStrictEqual(await repos.memory.peopleExact(`nobody ${w}`), []);
    const me = await seed.memPerson({ isMe: true });
    const mine = await repos.memory.mePerson();
    assert.ok(!ids(await repos.memory.peopleExact(mine.display_name)).includes(me), 'me is never matched');
  },

  'peopleFuzzy: ilike over name and identity, at most two': async ({ repos, seed, uniq, assert }) => {
    const w = uniq('fuzzy');
    const a = await seed.memPerson({ name: `Ann ${w}` });
    const b = await seed.memPerson({ name: `Bob ${w}` });
    const c = await seed.memPerson({ name: `Cy ${w}` });
    const two = ids(await repos.memory.peopleFuzzy(`%${w}%`));
    assert.strictEqual(two.length, 2);
    assert.ok(two.every((x) => [a, b, c].includes(x)));
    const d = await seed.memPerson();
    await seed.memIdentity(d, 'smtp', `only-${w}-handle`);
    assert.deepStrictEqual(ids(await repos.memory.peopleFuzzy(`%only-${w}-%`)), [d]);
  },

  // --------------------------------------------------------------- writes

  'insertNote: an explicit claim; a vector literal is stored': async ({ repos, uniq, assert }) => {
    const label = uniq('note');
    const row = await note(repos, { subjectLabel: label, text: 'hello', quote: 'hello q', vector: vec(0), confidence: 0.5, status: 'pending_review', origin: 'agent' });
    assert.ok(row.id);
    assert.deepStrictEqual(
      [row.subject_kind, row.subject_id, row.subject_label, row.kind, row.text, row.quote, row.source_kind, row.confidence, row.status, row.origin, row.extracted_by],
      ['topic', null, label, 'status', 'hello', 'hello q', 'explicit', 0.5, 'pending_review', 'agent', 'remember']
    );
    assert.deepStrictEqual(ids(await repos.memory.claimsMissingEmbedding(100000)).includes(Number(row.id)), false, 'embedded');
    const bare = await note(repos, { subjectLabel: label });
    assert.deepStrictEqual(ids(await repos.memory.claimsMissingEmbedding(100000)).includes(Number(bare.id)), true, 'no vector, no embedding');
  },

  'claimWithDecision: the claim, with its decision once decided': async ({ repos, uniq, assert }) => {
    const row = await note(repos, { subjectLabel: uniq('dec') });
    const before = await repos.memory.claimWithDecision(row.id);
    assert.deepStrictEqual([before.id, before.decision, before.target_id], [row.id, null, null]);
    await repos.memory.recordDecision(row.id, 'add', null, 'contract', null);
    assert.strictEqual((await repos.memory.claimWithDecision(row.id)).decision, 'add');
    assert.strictEqual(await repos.memory.claimWithDecision('999999999'), null);
  },

  'liveClaimsByItem: every claim of an item that is not retracted': async ({ repos, seed, assert }) => {
    const a = await extracted(repos, seed);
    const b = await extracted(repos, seed, { itemId: a.itemId });
    const c = await extracted(repos, seed, { itemId: a.itemId });
    await repos.memory.retractClaims([c.id]);
    assert.deepStrictEqual(ids(await repos.memory.liveClaimsByItem(a.itemId)).sort(), [a.id, b.id].sort());
  },

  'liveClaimById: the claim unless retracted (a list of 0 or 1)': async ({ repos, uniq, assert }) => {
    const row = await note(repos, { subjectLabel: uniq('live') });
    assert.deepStrictEqual(ids(await repos.memory.liveClaimById(row.id)), [Number(row.id)]);
    await repos.memory.retractClaims([row.id]);
    assert.deepStrictEqual(await repos.memory.liveClaimById(row.id), []);
  },

  'retractClaims: status retracted and expired_at set, once': async ({ repos, uniq, assert }) => {
    const row = await note(repos, { subjectLabel: uniq('ret') });
    await repos.memory.retractClaims([row.id]);
    const first = await repos.memory.claimById(row.id);
    assert.strictEqual(first.status, 'retracted');
    assert.ok(first.expired_at instanceof Date);
    await repos.memory.retractClaims([row.id]);
    assert.strictEqual((await repos.memory.claimById(row.id)).expired_at.getTime(), first.expired_at.getTime(), 'expired_at is kept');
  },

  'restoreSuperseded: forgetting the correction gives the original its belief back': async ({ repos, uniq, assert }) => {
    const label = uniq('restore');
    const older = await note(repos, { subjectLabel: label, text: 'old' });
    const newer = await note(repos, { subjectLabel: label, text: 'new' });
    await repos.memory.supersedeTarget(older.id, new Date());
    await repos.memory.linkSupersedes(newer.id, older.id);
    assert.strictEqual((await repos.memory.claimById(older.id)).status, 'superseded');
    await repos.memory.retractClaims([newer.id]);
    assert.strictEqual(await repos.memory.restoreSuperseded([newer.id]), 1);
    const back = await repos.memory.claimById(older.id);
    assert.deepStrictEqual([back.status, back.expired_at, back.invalid_at], ['active', null, null]);
    assert.strictEqual(await repos.memory.restoreSuperseded([newer.id]), 0);
  },

  'approvePending: a pending claim becomes active at full confidence; once': async ({ repos, uniq, assert }) => {
    const row = await note(repos, { subjectLabel: uniq('appr'), status: 'pending_review', confidence: 0.4, origin: 'agent' });
    const done = await repos.memory.approvePending(row.id);
    assert.deepStrictEqual([done.status, done.confidence, done.expired_at], ['active', 1, null]);
    assert.strictEqual(await repos.memory.approvePending(row.id), null, 'no longer waiting');
  },

  'claimOutcome: status and subject, with the decision': async ({ repos, uniq, assert }) => {
    const row = await note(repos, { subjectLabel: uniq('out') });
    await repos.memory.recordDecision(row.id, 'noop', null, 'contract', 'meh');
    const o = await repos.memory.claimOutcome(row.id);
    assert.deepStrictEqual([o.id, o.status, o.subject_kind, o.subject_id, o.decision, o.target_id], [row.id, 'active', 'topic', null, 'noop', null]);
  },

  'noteUse: counts a use and stamps last_used_at': async ({ repos, uniq, assert }) => {
    const row = await note(repos, { subjectLabel: uniq('use') });
    assert.deepStrictEqual([row.use_count, row.last_used_at], [0, null]);
    await repos.memory.noteUse([row.id]);
    await repos.memory.noteUse([row.id]);
    const after = await repos.memory.claimById(row.id);
    assert.strictEqual(after.use_count, 2);
    assert.ok(after.last_used_at instanceof Date);
  },

  // ------------------------------------------------------- dashboard reads

  'reviewQueue: pending claims, newest first, limited': async ({ repos, seed, uniq, assert }) => {
    const item = await seed.sourceItem({ subject: 'review me' });
    const a = await note(repos, { subjectLabel: uniq('rq'), status: 'pending_review' });
    const b = await extracted(repos, seed, { itemId: item, status: 'pending_review' });
    const active = await note(repos, { subjectLabel: uniq('rq') });
    const all = await repos.memory.reviewQueue(1000);
    const got = ids(all);
    assert.ok(got.includes(Number(a.id)) && got.includes(b.id) && !got.includes(Number(active.id)));
    assert.ok(got.indexOf(b.id) < got.indexOf(Number(a.id)), 'newest first');
    const mine = all.find((r) => Number(r.id) === b.id);
    assert.deepStrictEqual([mine.source, mine.source_subject, mine.url, mine.link], ['graph_mail', 'review me', null, null]);
    assert.strictEqual((await repos.memory.reviewQueue(1)).length, 1);
  },

  'subjects: people and projects with claims, and topics': async ({ repos, seed, uniq, assert }) => {
    const pid = await seed.memPerson({ name: `Subj ${uniq('p')}` });
    const label = uniq('subjtopic');
    await note(repos, { subjectKind: 'person', subjectId: pid, subjectLabel: 'x' });
    await note(repos, { subjectKind: 'person', subjectId: pid, subjectLabel: 'x' });
    await note(repos, { subjectLabel: label });
    const all = await repos.memory.subjects();
    const person = all.find((r) => r.kind === 'person' && Number(r.id) === pid);
    assert.ok(person && person.claims === 2, 'the person, with two claims');
    const t = all.find((r) => r.kind === 'topic' && r.title === label);
    assert.ok(t && t.id === null && t.claims === 1, 'the topic');
  },

  'sourceItem: one item, for following a citation': async ({ repos, seed, assert }) => {
    const id = await seed.sourceItem({ subject: 'cited', body: 'the words' });
    const r = await repos.memory.sourceItem(id);
    assert.deepStrictEqual([Number(r.id), r.source, r.subject, r.body_text, r.url, r.link], [id, 'graph_mail', 'cited', 'the words', null, null]);
    assert.strictEqual(await repos.memory.sourceItem(999999999), null);
  },

  'peopleForMerge: people with identities and counts': async ({ repos, seed, uniq, assert }) => {
    const id = await seed.memPerson({ name: `Merge ${uniq('m')}`, email: 'm@example.test' });
    await seed.memIdentity(id, 'smtp', `${uniq('m')}@example.test`);
    await note(repos, { subjectKind: 'person', subjectId: id, subjectLabel: 'x' });
    await seed.memCommitment({ personId: id });
    await repos.memory.upsertPage({ kind: 'person', subjectId: id, title: 'Merge Page', body: 'b', hash: 'h', generatedBy: 'contract', vector: null });
    const r = (await repos.memory.peopleForMerge()).find((p) => Number(p.id) === id);
    assert.deepStrictEqual([r.primary_email, r.is_me, r.page_title, r.claims, r.commitments, r.identities.length], ['m@example.test', false, 'Merge Page', 1, 1, 1]);
    assert.deepStrictEqual(Object.keys(r.identities[0]).sort(), ['kind', 'value']);
  },

  'pageByKind: the me or index page': async ({ repos, uniq, assert }) => {
    const title = uniq('mepage');
    await repos.memory.upsertPage({ kind: 'me', subjectId: 0, title, body: 'about me', hash: 'h1', generatedBy: 'contract', vector: null });
    const p = await repos.memory.pageByKind('me');
    assert.deepStrictEqual([p.kind, Number(p.subject_id), p.title, p.body], ['me', 0, title, 'about me']);
    await repos.memory.deletePage('me', 0);
    assert.strictEqual(await repos.memory.pageByKind('me'), null);
  },

  'pageBySubject: the page of a person or project': async ({ repos, seed, assert }) => {
    const id = await seed.memPerson();
    assert.strictEqual(await repos.memory.pageBySubject('person', id), null);
    await repos.memory.upsertPage({ kind: 'person', subjectId: id, title: 'T', body: 'B', hash: 'h', generatedBy: 'contract', vector: null });
    const p = await repos.memory.pageBySubject('person', id);
    assert.deepStrictEqual([p.title, p.body, p.facts_hash, p.generated_by], ['T', 'B', 'h', 'contract']);
  },

  'claimsFor: a subject\'s claims, newest first; active only unless all/asOf': async ({ repos, seed, uniq, assert }) => {
    const label = uniq('cf');
    const s = { kind: 'topic', id: null, label };
    const a = await note(repos, { subjectLabel: label, text: 'first' });
    const b = await note(repos, { subjectLabel: label, text: 'second' });
    await repos.memory.retractClaims([a.id]);
    assert.deepStrictEqual(ids(await repos.memory.claimsFor(s)), [Number(b.id)]);
    assert.deepStrictEqual(ids(await repos.memory.claimsFor(s, { all: true })).sort(), [Number(a.id), Number(b.id)].sort());
    assert.strictEqual((await repos.memory.claimsFor(s, { asOf: new Date() })).length, 2);
    assert.strictEqual((await repos.memory.claimsFor(s, { all: true, limit: 1 })).length, 1);
    const pid = await seed.memPerson();
    const c = await note(repos, { subjectKind: 'person', subjectId: pid, subjectLabel: 'anything' });
    assert.deepStrictEqual(ids(await repos.memory.claimsFor({ kind: 'person', id: pid, label: 'other' })), [Number(c.id)], 'a person by id, not label');
    const joined = (await repos.memory.claimsFor(s))[0];
    assert.ok('source_occurred_at' in joined && 'source_subject' in joined);
  },

  'searchClaimsLexical: words, ranked; subject narrows; asOf lifts the status filter': async ({ repos, uniq, assert }) => {
    const w = word(uniq);
    const label = uniq('lex');
    const a = await note(repos, { subjectLabel: label, text: `the ${w} export` });
    const other = await note(repos, { subjectLabel: uniq('lex'), text: `another ${w} thing` });
    const found = await repos.memory.searchClaimsLexical(w, { limit: 10 });
    assert.deepStrictEqual(ids(found).sort(), [Number(a.id), Number(other.id)].sort());
    assert.ok(found.every((r) => r.rank > 0));
    const narrowed = await repos.memory.searchClaimsLexical(w, { subject: { kind: 'topic', id: null, label }, limit: 10 });
    assert.deepStrictEqual(ids(narrowed), [Number(a.id)]);
    await repos.memory.retractClaims([a.id]);
    assert.deepStrictEqual(ids(await repos.memory.searchClaimsLexical(w, { subject: { kind: 'topic', id: null, label }, limit: 10 })), []);
    assert.deepStrictEqual(ids(await repos.memory.searchClaimsLexical(w, { subject: { kind: 'topic', id: null, label }, asOf: new Date(), limit: 10 })), [Number(a.id)]);
  },

  'searchClaimsVector: nearest by meaning; subject narrows': async ({ repos, uniq, assert }) => {
    const label = uniq('vec');
    const near = await note(repos, { subjectLabel: label, text: 'near', vector: vec(11) });
    const far = await note(repos, { subjectLabel: label, text: 'far', vector: vec(12) });
    const res = await repos.memory.searchClaimsVector(vec(11), { subject: { kind: 'topic', id: null, label }, limit: 1 });
    assert.deepStrictEqual(ids(res).slice(0, 2), [Number(near.id), Number(far.id)]);
    assert.ok(Math.abs(res[0].rank - 1) < 1e-6 && Math.abs(res[1].rank) < 1e-6, 'cosine similarity as rank');
    await repos.memory.retractClaims([near.id]);
    assert.ok(!ids(await repos.memory.searchClaimsVector(vec(11), { subject: { kind: 'topic', id: null, label }, limit: 5 })).includes(Number(near.id)));
    assert.ok(ids(await repos.memory.searchClaimsVector(vec(11), { subject: { kind: 'topic', id: null, label }, asOf: new Date(), limit: 5 })).includes(Number(near.id)));
  },

  'claimById: every column, or null': async ({ repos, uniq, assert }) => {
    const row = await note(repos, { subjectLabel: uniq('byid'), text: 'whole' });
    const r = await repos.memory.claimById(row.id);
    assert.deepStrictEqual([r.id, r.text, r.status], [row.id, 'whole', 'active']);
    assert.strictEqual(await repos.memory.claimById('999999999'), null);
  },

  'sourceItemBrief: the item behind a claim': async ({ repos, seed, assert }) => {
    const id = await seed.sourceItem({ subject: 'brief' });
    const r = await repos.memory.sourceItemBrief(id);
    assert.deepStrictEqual([Number(r.id), r.source, r.subject, r.url, r.link], [id, 'graph_mail', 'brief', null, null]);
    assert.ok(r.occurred_at instanceof Date);
  },

  'supersededClaim: the replaced claim, briefly': async ({ repos, uniq, assert }) => {
    const row = await note(repos, { subjectLabel: uniq('sc'), text: 'was true' });
    const r = await repos.memory.supersededClaim(row.id);
    assert.deepStrictEqual(Object.keys(r).sort(), ['id', 'invalid_at', 'status', 'text', 'valid_at']);
    assert.deepStrictEqual([r.text, r.status], ['was true', 'active']);
  },

  'supersededBy: claims that replaced this one': async ({ repos, uniq, assert }) => {
    const label = uniq('sb');
    const older = await note(repos, { subjectLabel: label });
    const newer = await note(repos, { subjectLabel: label });
    assert.deepStrictEqual(await repos.memory.supersededBy(older.id), []);
    await repos.memory.linkSupersedes(newer.id, older.id);
    assert.deepStrictEqual(ids(await repos.memory.supersededBy(older.id)), [Number(newer.id)]);
  },

  'corroboratedBy: claims kept as duplicates of this one': async ({ repos, uniq, assert }) => {
    const label = uniq('cb');
    const kept = await note(repos, { subjectLabel: label });
    const dupe = await note(repos, { subjectLabel: label, quote: 'same thing' });
    await repos.memory.markDuplicate(dupe.id, kept.id);
    const r = await repos.memory.corroboratedBy(kept.id);
    assert.deepStrictEqual(r.map((x) => [Number(x.id), x.quote]), [[Number(dupe.id), 'same thing']]);
  },

  'consolidationOf: the decision for a claim, or null': async ({ repos, uniq, assert }) => {
    const row = await note(repos, { subjectLabel: uniq('co') });
    assert.strictEqual(await repos.memory.consolidationOf(row.id), null);
    await repos.memory.recordDecision(row.id, 'add', null, 'contract-by', 'because');
    const c = await repos.memory.consolidationOf(row.id);
    assert.deepStrictEqual([c.decision, c.target_id, c.decided_by, c.error], ['add', null, 'contract-by', 'because']);
  },

  'stats: counts by status and pages': async ({ repos, uniq, assert }) => {
    const before = await repos.memory.stats();
    const row = await note(repos, { subjectLabel: uniq('st'), status: 'pending_review' });
    await note(repos, { subjectLabel: uniq('st') });
    await repos.memory.retractClaims([(await note(repos, { subjectLabel: uniq('st') })).id]);
    const after = await repos.memory.stats();
    assert.deepStrictEqual(
      [after.claims - before.claims, after.active - before.active, after.pending_review - before.pending_review, after.retracted - before.retracted],
      [3, 1, 1, 1]
    );
    assert.ok(row && typeof after.pages === 'number');
  },

  // ------------------------------------------------------- pages inputs

  'eligiblePeople: enough interactions, a claim or commitment, not me, not a bot': async ({ repos, seed, uniq, assert }) => {
    const w = uniq('elig');
    const real = await seed.memPerson({ name: `Real ${w}` });
    const bot = await seed.memPerson({ name: `${w} [bot]` });
    const bare = await seed.memPerson({ name: `Bare ${w}` });
    for (const p of [real, bot]) await note(repos, { subjectKind: 'person', subjectId: p, subjectLabel: 'x' });
    await note(repos, { subjectKind: 'person', subjectId: real, subjectLabel: 'x' });
    await seed.memCommitment({ personId: real });
    const got = await repos.memory.eligiblePeople(1);
    const mine = got.find((r) => Number(r.id) === real);
    assert.deepStrictEqual([Number(mine.claims), Number(mine.commitments), Number(mine.interactions)], [2, 1, 3]);
    assert.ok(!ids(got).includes(bot) && !ids(got).includes(bare));
    assert.ok(!ids(await repos.memory.eligiblePeople(4)).includes(real));
    const me = await seed.memPerson({ isMe: true });
    await note(repos, { subjectKind: 'person', subjectId: me, subjectLabel: 'x' });
    assert.ok(!ids(await repos.memory.eligiblePeople(0)).includes(me));
  },

  'personById: the person row, or null': async ({ repos, seed, assert }) => {
    const id = await seed.memPerson({ name: 'By Id', email: 'byid@example.test' });
    const p = await repos.memory.personById(id);
    assert.deepStrictEqual([p.display_name, p.primary_email, p.is_me], ['By Id', 'byid@example.test', false]);
    assert.strictEqual(await repos.memory.personById(999999999), null);
  },

  'personIdentities: each identity with the handle author_identity uses': async ({ repos, seed, uniq, assert }) => {
    const w = uniq('h');
    const id = await seed.memPerson();
    await seed.memIdentity(id, 'github_username', `g${w}`);
    await seed.memIdentity(id, 'gitlab_username', `l${w}`);
    await seed.memIdentity(id, 'aad_oid', `a${w}`);
    await seed.memIdentity(id, 'smtp', `s${w}@example.test`);
    const got = (await repos.memory.personIdentities(id)).map((r) => [r.kind, r.handle]).sort();
    assert.deepStrictEqual(got, [
      ['aad_oid', `aad:a${w}`], ['github_username', `github:g${w}`], ['gitlab_username', `gitlab:l${w}`], ['smtp', `s${w}@example.test`],
    ]);
  },

  'personClaims: active and still valid claims about a person': async ({ repos, seed, assert }) => {
    const pid = await seed.memPerson();
    const live = await note(repos, { subjectKind: 'person', subjectId: pid, subjectLabel: 'x', text: 'live' });
    const lapsed = await extracted(repos, seed, { subjectKind: 'person', subjectId: pid, label: 'x', validUntil: new Date(Date.now() - DAY) });
    const retracted = await note(repos, { subjectKind: 'person', subjectId: pid, subjectLabel: 'x' });
    await repos.memory.retractClaims([retracted.id]);
    const got = await repos.memory.personClaims(pid);
    assert.deepStrictEqual(ids(got), [Number(live.id)]);
    assert.ok(!ids(got).includes(lapsed.id));
    assert.deepStrictEqual(Object.keys(got[0]).sort(), ['confidence', 'id', 'invalid_at', 'kind', 'quote', 'source_item_id', 'source_kind', 'status', 'text', 'valid_at']);
  },

  'personCommitments: open and dispatched, not folded, due first': async ({ repos, seed, assert }) => {
    const pid = await seed.memPerson();
    const later = await seed.memCommitment({ personId: pid, extractedAt: new Date(Date.now() - DAY) });
    const open = await seed.memCommitment({ personId: pid, status: 'dispatched' });
    const done = await seed.memCommitment({ personId: pid, status: 'done' });
    const folded = await seed.memCommitment({ personId: pid });
    await repos.memory.foldCommitment(folded, later);
    const got = ids(await repos.memory.personCommitments(pid));
    assert.deepStrictEqual(got.sort(), [later, open].sort());
    assert.ok(!got.includes(done));
  },

  'personItems: recent items a person authored or was a member of': async ({ repos, seed, db, uniq, assert }) => {
    const w = uniq('pi');
    const authored = await seed.sourceItem();
    await db.query('update source_item set author_identity = $2 where id = $1', [authored, `github:${w}`]);
    const member = await seed.sourceItem();
    await db.query(`update source_item set raw = $2::jsonb where id = $1`, [member, JSON.stringify({ memberEmails: [`${w}@example.test`] })]);
    const unrelated = await seed.sourceItem();
    const got = ids(await repos.memory.personItems([`github:${w}`], [`${w}@example.test`]));
    assert.deepStrictEqual(got.sort(), [authored, member].sort());
    assert.ok(!got.includes(unrelated));
    assert.deepStrictEqual(ids(await repos.memory.personItems([], ['-'])).includes(unrelated), false);
  },

  'projectById: the project row, or null': async ({ repos, seed, uniq, assert }) => {
    const name = uniq('pbyid');
    const id = await seed.memProject({ name });
    assert.strictEqual((await repos.memory.projectById(id)).name, name);
    assert.strictEqual(await repos.memory.projectById(999999999), null);
  },

  'projectClaims: active and still valid claims about a project': async ({ repos, seed, assert }) => {
    const pid = await seed.memProject();
    const live = await note(repos, { subjectKind: 'project', subjectId: pid, subjectLabel: 'p' });
    await extracted(repos, seed, { subjectKind: 'project', subjectId: pid, label: 'p', validUntil: new Date(Date.now() - DAY) });
    assert.deepStrictEqual(ids(await repos.memory.projectClaims(pid)), [Number(live.id)]);
  },

  'projectCommitments: open commitments with the counterparty as who': async ({ repos, seed, assert }) => {
    const project = await seed.memProject();
    const person = await seed.memPerson({ name: 'Who Dunnit' });
    const c = await seed.memCommitment({ projectId: project, personId: person });
    await seed.memCommitment({ projectId: project, status: 'done' });
    const got = await repos.memory.projectCommitments(project);
    assert.deepStrictEqual(got.map((r) => [Number(r.id), r.who]), [[c, 'Who Dunnit']]);
  },

  'projectPeople: names of people with commitments on a project': async ({ repos, seed, assert }) => {
    const project = await seed.memProject();
    const a = await seed.memPerson({ name: 'Ann People' });
    await seed.memCommitment({ projectId: project, personId: a });
    await seed.memCommitment({ projectId: project, personId: a });
    await seed.memCommitment({ projectId: project });
    assert.deepStrictEqual(await repos.memory.projectPeople(project), [{ display_name: 'Ann People' }]);
  },

  'upsertPage: inserts, replaces, and keeps the old embedding when given none': async ({ repos, seed, assert }) => {
    const id = await seed.memPerson();
    await repos.memory.upsertPage({ kind: 'person', subjectId: id, title: 'One', body: 'b1', hash: 'h1', generatedBy: 'v1', vector: vec(3) });
    await repos.memory.upsertPage({ kind: 'person', subjectId: id, title: 'Two', body: 'b2', hash: 'h2', generatedBy: 'v2', vector: null });
    const p = await repos.memory.pageBySubject('person', id);
    assert.deepStrictEqual([p.title, p.body, p.facts_hash, p.generated_by], ['Two', 'b2', 'h2', 'v2']);
    assert.ok(!ids(await repos.memory.pagesMissingEmbedding(100000)).includes(Number(p.id)), 'the first embedding survived');
  },

  'pagesMissingEmbedding: pages with no vector': async ({ repos, seed, assert }) => {
    const id = await seed.memPerson();
    await repos.memory.upsertPage({ kind: 'person', subjectId: id, title: 'No vec', body: 'b', hash: 'h', generatedBy: 'v', vector: null });
    const p = await repos.memory.pageBySubject('person', id);
    const got = (await repos.memory.pagesMissingEmbedding(100000)).find((r) => r.id === p.id);
    assert.deepStrictEqual([got.title, got.body], ['No vec', 'b']);
    assert.ok((await repos.memory.pagesMissingEmbedding(1)).length <= 1);
  },

  'setPageEmbedding: a page stops missing its vector': async ({ repos, seed, assert }) => {
    const id = await seed.memPerson();
    await repos.memory.upsertPage({ kind: 'person', subjectId: id, title: 'T', body: 'b', hash: 'h', generatedBy: 'v', vector: null });
    const p = await repos.memory.pageBySubject('person', id);
    await repos.memory.setPageEmbedding(p.id, vec(4));
    assert.ok(!ids(await repos.memory.pagesMissingEmbedding(100000)).includes(Number(p.id)));
  },

  'pageHash: the facts hash a page was written from, or null': async ({ repos, seed, assert }) => {
    const id = await seed.memPerson();
    assert.strictEqual(await repos.memory.pageHash('person', id), null);
    await repos.memory.upsertPage({ kind: 'person', subjectId: id, title: 'T', body: 'b', hash: 'abc123', generatedBy: 'v', vector: null });
    assert.strictEqual(await repos.memory.pageHash('person', id), 'abc123');
  },

  'mePerson: the owner row': async ({ repos, seed, assert }) => {
    const id = await seed.memPerson({ isMe: true });
    const me = await repos.memory.mePerson();
    assert.deepStrictEqual([Number(me.id), me.is_me], [id, true]);
  },

  'meClaims: active, valid claims about me, most confident first': async ({ repos, uniq, assert }) => {
    const w = uniq('me');
    const hi = await note(repos, { subjectKind: 'me', subjectLabel: 'me', text: `hi ${w}`, confidence: 1 });
    const lo = await note(repos, { subjectKind: 'me', subjectLabel: 'me', text: `lo ${w}`, confidence: 0.3 });
    const got = ids(await repos.memory.meClaims());
    assert.ok(got.indexOf(Number(hi.id)) >= 0 && got.indexOf(Number(hi.id)) < got.indexOf(Number(lo.id)));
  },

  'meCommitments: what I owe now, open, newest first': async ({ repos, seed, assert }) => {
    const mine = await seed.memCommitment({ direction: 'owed_by_me', summary: 'i owe this' });
    const theirs = await seed.memCommitment({ direction: 'owed_to_me' });
    const done = await seed.memCommitment({ direction: 'owed_by_me', status: 'done' });
    const got = ids(await repos.memory.meCommitments());
    assert.ok(got.includes(mine) && !got.includes(theirs) && !got.includes(done));
  },

  'activeProjectNames: projects with claims in the last 45 days': async ({ repos, seed, uniq, assert }) => {
    const name = uniq('active');
    const pid = await seed.memProject({ name });
    await note(repos, { subjectKind: 'project', subjectId: pid, subjectLabel: name });
    await note(repos, { subjectKind: 'project', subjectId: pid, subjectLabel: name });
    const got = (await repos.memory.activeProjectNames()).find((r) => r.name === name);
    assert.strictEqual(Number(got.n), 2);
  },

  'recentPersonPageTitles: titles of the newest person pages': async ({ repos, seed, uniq, assert }) => {
    const title = uniq('recent');
    const id = await seed.memPerson();
    await repos.memory.upsertPage({ kind: 'person', subjectId: id, title, body: 'b', hash: 'h', generatedBy: 'v', vector: null });
    assert.strictEqual((await repos.memory.recentPersonPageTitles())[0].title, title);
  },

  'personPages: person pages by title': async ({ repos, seed, uniq, assert }) => {
    const title = uniq('pp');
    const id = await seed.memPerson();
    await repos.memory.upsertPage({ kind: 'person', subjectId: id, title, body: 'b', hash: 'h', generatedBy: 'v', vector: null });
    const mine = (await repos.memory.personPages()).find((r) => Number(r.subject_id) === id);
    assert.strictEqual(mine.title, title);
  },

  'personIndexClaims: kind and text of a person\'s active claims, most confident first': async ({ repos, seed, assert }) => {
    const pid = await seed.memPerson();
    await note(repos, { subjectKind: 'person', subjectId: pid, subjectLabel: 'x', kind: 'role', text: 'lo', confidence: 0.2 });
    await note(repos, { subjectKind: 'person', subjectId: pid, subjectLabel: 'x', kind: 'expertise', text: 'hi', confidence: 0.9 });
    assert.deepStrictEqual(await repos.memory.personIndexClaims(pid), [{ kind: 'expertise', text: 'hi' }, { kind: 'role', text: 'lo' }]);
  },

  'indexProjects: projects with a claim in the last 60 days': async ({ repos, seed, uniq, assert }) => {
    const name = uniq('idxp');
    const withClaim = await seed.memProject({ name, touchedAt: new Date() });
    const without = await seed.memProject();
    await note(repos, { subjectKind: 'project', subjectId: withClaim, subjectLabel: name });
    const got = ids(await repos.memory.indexProjects());
    assert.ok(got.includes(withClaim) && !got.includes(without));
  },

  'projectIndexClaims: kind and text of a project\'s active claims': async ({ repos, seed, assert }) => {
    const pid = await seed.memProject();
    await note(repos, { subjectKind: 'project', subjectId: pid, subjectLabel: 'p', kind: 'decision', text: 'we chose' });
    assert.deepStrictEqual(await repos.memory.projectIndexClaims(pid), [{ kind: 'decision', text: 'we chose' }]);
  },

  'indexTopics: topics with at least two active claims lately': async ({ repos, uniq, assert }) => {
    const two = uniq('twice');
    const one = uniq('once');
    await note(repos, { subjectLabel: two });
    await note(repos, { subjectLabel: two });
    await note(repos, { subjectLabel: one });
    const got = await repos.memory.indexTopics();
    assert.strictEqual(Number(got.find((r) => r.label === two).n), 2);
    assert.ok(!got.some((r) => r.label === one));
  },

  'projectIdsWithClaims: projects with at least two active claims': async ({ repos, seed, assert }) => {
    const two = await seed.memProject();
    const one = await seed.memProject();
    for (const pid of [two, two, one]) await note(repos, { subjectKind: 'project', subjectId: pid, subjectLabel: 'p' });
    const got = ids(await repos.memory.projectIdsWithClaims());
    assert.ok(got.includes(two) && !got.includes(one));
  },

  'deletePage: removes a page': async ({ repos, seed, assert }) => {
    const id = await seed.memPerson();
    await repos.memory.upsertPage({ kind: 'person', subjectId: id, title: 'T', body: 'b', hash: 'h', generatedBy: 'v', vector: null });
    await repos.memory.deletePage('person', id);
    assert.strictEqual(await repos.memory.pageBySubject('person', id), null);
    await repos.memory.deletePage('person', id); // already gone: fine
  },

  // ------------------------------------------------------- consolidation

  'claimsMissingEmbedding: active and pending claims with no vector': async ({ repos, uniq, assert }) => {
    const bare = await note(repos, { subjectLabel: uniq('me1') });
    const pending = await note(repos, { subjectLabel: uniq('me2'), status: 'pending_review' });
    const embedded = await note(repos, { subjectLabel: uniq('me3'), vector: vec(7) });
    const retracted = await note(repos, { subjectLabel: uniq('me4') });
    await repos.memory.retractClaims([retracted.id]);
    const got = ids(await repos.memory.claimsMissingEmbedding(100000));
    assert.ok(got.includes(Number(bare.id)) && got.includes(Number(pending.id)));
    assert.ok(!got.includes(Number(embedded.id)) && !got.includes(Number(retracted.id)));
    assert.deepStrictEqual(Object.keys((await repos.memory.claimsMissingEmbedding(1))[0]).sort(), ['id', 'subject_label', 'text']);
  },

  'setClaimEmbedding: a claim stops missing its vector': async ({ repos, uniq, assert }) => {
    const row = await note(repos, { subjectLabel: uniq('sce') });
    await repos.memory.setClaimEmbedding(row.id, vec(8));
    assert.ok(!ids(await repos.memory.claimsMissingEmbedding(100000)).includes(Number(row.id)));
  },

  'candidatesByVector: earlier active claims of the same subject, nearest first': async ({ repos, uniq, assert }) => {
    const label = uniq('cv');
    const far = await note(repos, { subjectLabel: label, vector: vec(21) });
    const near = await note(repos, { subjectLabel: label, vector: vec(20) });
    const other = await note(repos, { subjectLabel: uniq('cv'), vector: vec(20) });
    const fresh = await note(repos, { subjectLabel: label, vector: vec(20) });
    const got = await repos.memory.candidatesByVector(fresh.id, 5);
    assert.deepStrictEqual(ids(got), [Number(near.id), Number(far.id)]);
    assert.ok(!ids(got).includes(Number(other.id)) && !ids(got).includes(Number(fresh.id)));
    assert.deepStrictEqual(Object.keys(got[0]).sort(), ['id', 'kind', 'text', 'valid_at']);
    assert.strictEqual((await repos.memory.candidatesByVector(fresh.id, 1)).length, 1);
  },

  'candidatesByText: earlier active claims of the same subject sharing words': async ({ repos, uniq, assert }) => {
    const w = word(uniq);
    const label = uniq('ct');
    const match = await note(repos, { subjectLabel: label, text: `deadline moved ${w}` });
    await note(repos, { subjectLabel: label, text: 'something else entirely' });
    const fresh = await note(repos, { subjectLabel: label, text: `the ${w} deadline` });
    assert.deepStrictEqual(ids(await repos.memory.candidatesByText(fresh.id, 5)), [Number(match.id)]);
  },

  'candidatesByKind: the two latest earlier claims of the same kind': async ({ repos, uniq, assert }) => {
    const label = uniq('ck');
    const a = await note(repos, { subjectLabel: label, kind: 'status', text: 'a' });
    const b = await note(repos, { subjectLabel: label, kind: 'status', text: 'b' });
    const c = await note(repos, { subjectLabel: label, kind: 'status', text: 'c' });
    await note(repos, { subjectLabel: label, kind: 'role', text: 'other kind' });
    const fresh = await note(repos, { subjectLabel: label, kind: 'status', text: 'd' });
    const got = ids(await repos.memory.candidatesByKind(fresh.id));
    assert.strictEqual(got.length, 2);
    assert.ok(got.includes(Number(c.id)) && got.includes(Number(b.id)) && !got.includes(Number(a.id)));
  },

  'supersedeTarget: closes an active claim\'s clocks, never a closed one': async ({ repos, uniq, assert }) => {
    const row = await note(repos, { subjectLabel: uniq('sup') });
    const at = new Date(Date.now() + DAY);
    await repos.memory.supersedeTarget(row.id, at);
    const r = await repos.memory.claimById(row.id);
    assert.strictEqual(r.status, 'superseded');
    assert.ok(r.expired_at instanceof Date);
    assert.strictEqual(r.invalid_at.getTime(), at.getTime(), 'invalid_at is when the new claim became true');
    const closed = r.expired_at.getTime();
    await repos.memory.supersedeTarget(row.id, new Date(at.getTime() + DAY));
    assert.strictEqual((await repos.memory.claimById(row.id)).expired_at.getTime(), closed);
  },

  'linkSupersedes: records which claim a claim replaced': async ({ repos, uniq, assert }) => {
    const label = uniq('lnk');
    const older = await note(repos, { subjectLabel: label });
    const newer = await note(repos, { subjectLabel: label });
    await repos.memory.linkSupersedes(newer.id, older.id);
    assert.strictEqual((await repos.memory.claimById(newer.id)).supersedes_id, older.id);
  },

  'markDuplicate: the claim stops counting and points at what it repeats': async ({ repos, uniq, assert }) => {
    const label = uniq('dup');
    const kept = await note(repos, { subjectLabel: label });
    const dupe = await note(repos, { subjectLabel: label });
    await repos.memory.markDuplicate(dupe.id, kept.id);
    const r = await repos.memory.claimById(dupe.id);
    assert.deepStrictEqual([r.status, r.duplicate_of], ['superseded', kept.id]);
    assert.ok(r.expired_at instanceof Date);
  },

  'raiseConfidence: +0.05 over the higher of the two, capped at 1': async ({ repos, uniq, assert }) => {
    const row = await note(repos, { subjectLabel: uniq('conf'), confidence: 0.5 });
    await repos.memory.raiseConfidence(row.id, 0.5);
    assert.ok(Math.abs((await repos.memory.claimById(row.id)).confidence - 0.55) < 1e-6);
    await repos.memory.raiseConfidence(row.id, 0.9);
    assert.ok(Math.abs((await repos.memory.claimById(row.id)).confidence - 0.95) < 1e-6);
    await repos.memory.raiseConfidence(row.id, 1);
    assert.strictEqual((await repos.memory.claimById(row.id)).confidence, 1);
  },

  'retireNoop: a claim too vague to keep is closed': async ({ repos, uniq, assert }) => {
    const row = await note(repos, { subjectLabel: uniq('noop') });
    await repos.memory.retireNoop(row.id);
    const r = await repos.memory.claimById(row.id);
    assert.strictEqual(r.status, 'superseded');
    assert.ok(r.expired_at instanceof Date);
  },

  'recordDecision: one decision per claim, re-recorded in place': async ({ repos, uniq, assert }) => {
    const label = uniq('rd');
    const a = await note(repos, { subjectLabel: label });
    const b = await note(repos, { subjectLabel: label });
    await repos.memory.recordDecision(b.id, 'add', null, 'v1', null);
    await repos.memory.recordDecision(b.id, 'supersede', a.id, 'v2', 'moved on');
    const c = await repos.memory.consolidationOf(b.id);
    assert.deepStrictEqual([c.decision, c.target_id, c.decided_by, c.error], ['supersede', a.id, 'v2', 'moved on']);
  },

  'unconsolidatedByIds: active claims among the ids with no decision': async ({ repos, uniq, assert }) => {
    const label = uniq('ubi');
    const open = await note(repos, { subjectLabel: label });
    const decided = await note(repos, { subjectLabel: label });
    const pending = await note(repos, { subjectLabel: label, status: 'pending_review' });
    await repos.memory.recordDecision(decided.id, 'add', null, 'c', null);
    const got = await repos.memory.unconsolidatedByIds([open.id, decided.id, pending.id]);
    assert.deepStrictEqual(ids(got), [Number(open.id)]);
    assert.ok(got[0].text && got[0].subject_label, 'the whole row');
  },

  'unconsolidatedOldest: the oldest undecided active claims first, limited': async ({ repos, uniq, assert }) => {
    const first = await note(repos, { subjectLabel: uniq('uo') });
    await note(repos, { subjectLabel: uniq('uo') });
    const got = ids(await repos.memory.unconsolidatedOldest(100000));
    assert.ok(got.includes(Number(first.id)));
    assert.deepStrictEqual(got, [...got].sort((x, y) => x - y));
    assert.strictEqual((await repos.memory.unconsolidatedOldest(1)).length, 1);
  },

  'unconsolidatedCount: how many active claims await a decision': async ({ repos, uniq, assert }) => {
    const before = await repos.memory.unconsolidatedCount();
    assert.strictEqual(typeof before, 'number');
    const a = await note(repos, { subjectLabel: uniq('uc') });
    await note(repos, { subjectLabel: uniq('uc') });
    assert.strictEqual(await repos.memory.unconsolidatedCount(), before + 2);
    await repos.memory.recordDecision(a.id, 'add', null, 'c', null);
    assert.strictEqual(await repos.memory.unconsolidatedCount(), before + 1);
  },

  'olderCommitments: older open asks in the same direction from the same item or person': async ({ repos, seed, db, assert }) => {
    const person = await seed.memPerson();
    const item = await seed.sourceItem();
    const older = await seed.memCommitment({ sourceItemId: item, personId: person, extractedAt: new Date(Date.now() - 2 * DAY), summary: 'older ask' });
    const byPerson = await seed.memCommitment({ personId: person, extractedAt: new Date(Date.now() - DAY) });
    await seed.memCommitment({ sourceItemId: item, personId: person, direction: 'owed_to_me', extractedAt: new Date(Date.now() - 3 * DAY) });
    await seed.memCommitment({ sourceItemId: item, personId: person, status: 'done', extractedAt: new Date(Date.now() - 3 * DAY) });
    await seed.memCommitment({ extractedAt: new Date(Date.now() - 3 * DAY) });
    const newer = await seed.memCommitment({ sourceItemId: item, personId: person });
    const row = await db.one('select id, direction, counterparty_person_id, extracted_at, source_item_id from commitment where id = $1', [newer]);
    const got = await repos.memory.olderCommitments({ ...row, thread_external_id: null });
    assert.deepStrictEqual(ids(got), [byPerson, older]);
    assert.deepStrictEqual([got[1].summary, got[1].acted], ['older ask', false]);
  },

  'foldCommitment: points the loser at the survivor, once, only while open': async ({ repos, seed, assert }) => {
    const keep = await seed.memCommitment();
    const drop = await seed.memCommitment();
    assert.strictEqual(await repos.memory.foldCommitment(drop, keep), true);
    assert.strictEqual(await repos.memory.foldCommitment(drop, keep), false, 'already folded');
    const closed = await seed.memCommitment({ status: 'done' });
    assert.strictEqual(await repos.memory.foldCommitment(closed, keep), false);
  },

  'commitmentsToReview: commitments with no review row, oldest first': async ({ repos, seed, assert }) => {
    const first = await seed.memCommitment({ extractedAt: new Date(Date.now() - 5 * DAY), summary: 'to review' });
    const second = await seed.memCommitment({ extractedAt: new Date(Date.now() - 4 * DAY) });
    const got = await repos.memory.commitmentsToReview(100000);
    assert.ok(ids(got).indexOf(first) >= 0 && ids(got).indexOf(first) < ids(got).indexOf(second));
    const mine = got.find((r) => Number(r.id) === first);
    assert.deepStrictEqual([mine.summary, mine.direction, mine.acted, mine.thread_external_id], ['to review', 'owed_by_me', false, null]);
    await repos.memory.markCommitmentReviewed(first, 'contract', null);
    assert.ok(!ids(await repos.memory.commitmentsToReview(100000)).includes(first));
    assert.strictEqual((await repos.memory.commitmentsToReview(1)).length, 1);
  },

  'markCommitmentReviewed: records a review, and a repeat is a no-op': async ({ repos, seed, assert }) => {
    const older = await seed.memCommitment();
    const c = await seed.memCommitment();
    await repos.memory.markCommitmentReviewed(c, 'contract', older);
    await repos.memory.markCommitmentReviewed(c, 'other', null);
    assert.ok(!ids(await repos.memory.commitmentsToReview(100000)).includes(c));
  },

  // ---------------------------------------------------------- extraction

  'pendingExtraction: items with no extraction at the version, long enough, not noise': async ({ repos, seed, assert }) => {
    const long = 'x'.repeat(60);
    const ok = await seed.sourceItem({ body: long });
    const short = await seed.sourceItem({ body: 'too short' });
    const invite = await seed.sourceItem({ body: long, subject: 'Accepted: standup' });
    const got = ids(await repos.memory.pendingExtraction('contract-v1', 100000, 40));
    assert.ok(got.includes(ok) && !got.includes(short) && !got.includes(invite));
    assert.ok(ids(await repos.memory.pendingExtraction('contract-v1', 100000, 5)).includes(short), 'the minimum is a parameter');
    await repos.memory.recordExtraction(ok, 'contract-v1', 0, 0);
    assert.ok(!ids(await repos.memory.pendingExtraction('contract-v1', 100000, 40)).includes(ok));
    assert.ok(ids(await repos.memory.pendingExtraction('contract-v2', 100000, 40)).includes(ok), 'a new version re-opens it');
    assert.strictEqual((await repos.memory.pendingExtraction('contract-v2', 1, 40)).length, 1);
  },

  'pendingExtractionCount: how many items await extraction at the version': async ({ repos, seed, assert }) => {
    const version = `count-${Date.now()}`;
    const before = await repos.memory.pendingExtractionCount(version, 40);
    const item = await seed.sourceItem({ body: 'y'.repeat(60) });
    await seed.sourceItem({ body: 'short' });
    assert.strictEqual(await repos.memory.pendingExtractionCount(version, 40), before + 1);
    await repos.memory.recordExtraction(item, version, 0, 0);
    assert.strictEqual(await repos.memory.pendingExtractionCount(version, 40), before);
  },

  'personDisplayName: the name, or null': async ({ repos, seed, assert }) => {
    const id = await seed.memPerson({ name: 'Display Name' });
    assert.deepStrictEqual(await repos.memory.personDisplayName(id), { display_name: 'Display Name' });
    assert.strictEqual(await repos.memory.personDisplayName(999999999), null);
  },

  'setPersonDisplayName: replaces the name': async ({ repos, seed, assert }) => {
    const id = await seed.memPerson({ name: 'github:someone' });
    await repos.memory.setPersonDisplayName(id, 'Some One');
    assert.strictEqual((await repos.memory.personDisplayName(id)).display_name, 'Some One');
  },

  'deleteUnconsolidatedClaims: replaces only what nobody has consolidated': async ({ repos, seed, assert }) => {
    const a = await extracted(repos, seed);
    const b = await extracted(repos, seed, { itemId: a.itemId });
    const other = await extracted(repos, seed, { version: 'contract-v2', itemId: a.itemId });
    const typed = await note(repos, { subjectLabel: 'untouched' });
    await repos.memory.recordDecision(b.id, 'add', null, 'c', null);
    await repos.memory.deleteUnconsolidatedClaims(a.itemId, 'contract-v1');
    const left = ids(await repos.memory.liveClaimsByItem(a.itemId));
    assert.deepStrictEqual(left.sort(), [b.id, other.id].sort());
    assert.strictEqual((await repos.memory.claimById(typed.id)).status, 'active');
  },

  'insertExtractedClaim: a distill claim with the item\'s clock and a vector': async ({ repos, seed, assert }) => {
    const occurred = new Date(Date.now() - 3 * DAY);
    const until = new Date(Date.now() + 3 * DAY);
    const { id, itemId } = await extracted(repos, seed, { occurredAt: occurred, validUntil: until, vector: vec(9), confidence: 0.4, status: 'pending_review', label: 'lbl', kind: 'blocker' });
    const r = await repos.memory.claimById(id);
    assert.deepStrictEqual(
      [r.subject_kind, r.subject_label, r.kind, r.source_item_id, r.source_kind, r.confidence, r.status, r.origin, r.extracted_by, r.valid_at.getTime(), r.invalid_at.getTime()],
      ['topic', 'lbl', 'blocker', String(itemId), 'graph_mail', 0.4, 'pending_review', 'distill', 'contract-v1', occurred.getTime(), until.getTime()]
    );
    assert.ok(!ids(await repos.memory.claimsMissingEmbedding(100000)).includes(id), 'the vector was stored');
    const stated = await extracted(repos, seed, { validFrom: new Date(Date.now() - 9 * DAY) });
    assert.ok((await repos.memory.claimById(stated.id)).valid_at.getTime() < occurred.getTime(), 'validFrom wins over the item\'s date');
  },

  'recordExtraction: marks the item done at the version, and re-marks it': async ({ repos, seed, assert }) => {
    const item = await seed.sourceItem({ body: 'z'.repeat(60) });
    await repos.memory.recordExtraction(item, 'contract-v1', 2, 1);
    await repos.memory.recordExtraction(item, 'contract-v3', 3, 0);
    assert.ok(!ids(await repos.memory.pendingExtraction('contract-v3', 100000, 40)).includes(item));
    assert.ok(ids(await repos.memory.pendingExtraction('contract-v1', 100000, 40)).includes(item), 'one row per item: the version moved');
  },

  'recordExtractionError: a failed item is marked at the version': async ({ repos, seed, assert }) => {
    const item = await seed.sourceItem({ body: 'e'.repeat(60) });
    await repos.memory.recordExtractionError(item, 'contract-v4', 'the model said no');
    assert.ok(!ids(await repos.memory.pendingExtraction('contract-v4', 100000, 40)).includes(item));
    await repos.memory.recordExtractionError(item, 'contract-v4', 'again');
  },

  // --------------------------------------------------------------- dream

  'dreamMarker: the stored marker, or null': async ({ repos, uniq, assert }) => {
    assert.strictEqual(await repos.memory.dreamMarker(uniq('nomarker')), null);
    const key = uniq('marker');
    await repos.memory.saveDreamMarker(key, { at: '2026-01-02T03:04:05.000Z', stats: { merged: 1 } });
    assert.deepStrictEqual((await repos.memory.dreamMarker(key)).value, { at: '2026-01-02T03:04:05.000Z', stats: { merged: 1 } });
  },

  'saveDreamMarker: upserts': async ({ repos, uniq, assert }) => {
    const key = uniq('save');
    await repos.memory.saveDreamMarker(key, { at: 'one' });
    await repos.memory.saveDreamMarker(key, { at: 'two' });
    assert.strictEqual((await repos.memory.dreamMarker(key)).value.at, 'two');
  },

  'dedupeSubjects: subjects with enough active claims and news since': async ({ repos, uniq, assert }) => {
    const label = uniq('DedupeSubj');
    for (let i = 0; i < 3; i++) await note(repos, { subjectLabel: label, text: `n${i}` });
    const found = (await repos.memory.dedupeSubjects(3, null)).find((r) => r.label === label.toLowerCase());
    assert.deepStrictEqual([found.subject_kind, found.subject_id, found.n], ['topic', null, 3]);
    assert.ok(!(await repos.memory.dedupeSubjects(4, null)).some((r) => r.label === label.toLowerCase()));
    assert.ok(!(await repos.memory.dedupeSubjects(3, new Date(Date.now() + DAY))).some((r) => r.label === label.toLowerCase()), 'nothing new since');
    assert.ok((await repos.memory.dedupeSubjects(3, new Date(Date.now() - DAY))).some((r) => r.label === label.toLowerCase()));
  },

  'subjectClaims: a subject\'s active claims, by id or by lower-cased label': async ({ repos, seed, uniq, assert }) => {
    const label = uniq('SubjClaims');
    const a = await note(repos, { subjectLabel: label });
    const b = await note(repos, { subjectLabel: label.toUpperCase() });
    const gone = await note(repos, { subjectLabel: label });
    await repos.memory.retractClaims([gone.id]);
    assert.deepStrictEqual(ids(await repos.memory.subjectClaims('topic', null, label.toLowerCase())), [Number(a.id), Number(b.id)]);
    const pid = await seed.memPerson();
    const c = await note(repos, { subjectKind: 'person', subjectId: pid, subjectLabel: 'any' });
    assert.deepStrictEqual(ids(await repos.memory.subjectClaims('person', pid, 'ignored')), [Number(c.id)]);
  },

  'mergeDuplicates: closes the dropped claims into the kept one': async ({ repos, uniq, assert }) => {
    const label = uniq('merge');
    const keep = await note(repos, { subjectLabel: label });
    const d1 = await note(repos, { subjectLabel: label });
    const d2 = await note(repos, { subjectLabel: label });
    assert.strictEqual(await repos.memory.mergeDuplicates([d1.id, d2.id], keep.id), 2);
    assert.deepStrictEqual((await repos.memory.claimById(d1.id)).duplicate_of, keep.id);
    assert.strictEqual((await repos.memory.claimById(keep.id)).status, 'active');
    assert.strictEqual(await repos.memory.mergeDuplicates([d1.id, d2.id], keep.id), 0, 'only active claims are closed');
  },

  'staleCandidates: active status/blocker claims and any with an end': async ({ repos, seed, uniq, assert }) => {
    const status = await note(repos, { subjectLabel: uniq('sc'), kind: 'status' });
    const role = await note(repos, { subjectLabel: uniq('sc'), kind: 'role' });
    const { id: ended } = await extracted(repos, seed, { kind: 'role', validUntil: new Date(Date.now() + DAY), label: uniq('sc') });
    const got = await repos.memory.staleCandidates();
    assert.ok(ids(got).includes(Number(status.id)) && !ids(got).includes(Number(role.id)));
    assert.ok(ids(got).includes(ended));
    assert.deepStrictEqual(Object.keys(got[0]).sort(), ['id', 'invalid_at', 'kind', 'recorded_at', 'status', 'valid_at']);
  },

  'expireClaims: closes active claims, ending validity now if unset': async ({ repos, uniq, assert }) => {
    const row = await note(repos, { subjectLabel: uniq('exp') });
    const already = await note(repos, { subjectLabel: uniq('exp') });
    await repos.memory.retractClaims([already.id]);
    assert.strictEqual(await repos.memory.expireClaims([row.id, already.id]), 1);
    const r = await repos.memory.claimById(row.id);
    assert.strictEqual(r.status, 'superseded');
    assert.ok(r.expired_at instanceof Date && r.invalid_at instanceof Date);
    assert.strictEqual((await repos.memory.claimById(already.id)).status, 'retracted');
  },

  // -------------------------------------------------------------- recall

  'searchPagesLexical: person and project pages by words': async ({ repos, seed, uniq, assert }) => {
    const w = word(uniq);
    const person = await seed.memPerson();
    const project = await seed.memProject();
    await repos.memory.upsertPage({ kind: 'person', subjectId: person, title: `About ${w}`, body: `works on the ${w} export`, hash: 'h', generatedBy: 'v', vector: null });
    await repos.memory.upsertPage({ kind: 'project', subjectId: project, title: 'Project page', body: `mentions ${w} too`, hash: 'h', generatedBy: 'v', vector: null });
    await repos.memory.upsertPage({ kind: 'index', subjectId: 0, title: `Index ${w}`, body: `index mentions ${w}`, hash: 'h', generatedBy: 'v', vector: null });
    const got = await repos.memory.searchPagesLexical(w, 10);
    assert.deepStrictEqual(got.map((r) => `${r.kind}:${r.subject_id}`).sort(), [`person:${person}`, `project:${project}`].sort());
    assert.ok(got.every((r) => r.rank > 0 && r.body.length <= 1500));
    assert.strictEqual((await repos.memory.searchPagesLexical(w, 1)).length, 1);
    await repos.memory.deletePage('index', 0);
  },

  'searchPagesVector: person and project pages by meaning': async ({ repos, seed, assert }) => {
    const near = await seed.memPerson();
    const far = await seed.memPerson();
    await repos.memory.upsertPage({ kind: 'person', subjectId: near, title: 'Near', body: 'b', hash: 'h', generatedBy: 'v', vector: vec(31) });
    await repos.memory.upsertPage({ kind: 'person', subjectId: far, title: 'Far', body: 'b', hash: 'h', generatedBy: 'v', vector: vec(32) });
    const got = await repos.memory.searchPagesVector(vec(31), 1000);
    assert.ok(got.findIndex((r) => Number(r.subject_id) === near) < got.findIndex((r) => Number(r.subject_id) === far));
    assert.strictEqual((await repos.memory.searchPagesVector(vec(31), 1)).length, 1);
  },

  // --- for meetings/index.js, meetings/debrief.js

  'activeBlockers: active blocker claims about me of the last 21 days, newest first': async ({ repos, seed, db, assert }) => {
    const mk = (o) => seed.claim({ subjectKind: 'me', kind: 'blocker', ...o });
    const newer = await mk({ text: 'newer blocker', validAt: ago(1 * 86400_000) });
    const older = await mk({ text: 'older blocker', validAt: ago(10 * 86400_000) });
    await mk({ text: 'too old', validAt: ago(40 * 86400_000) });
    await mk({ text: 'retracted', status: 'retracted', validAt: ago(86400_000) });
    await mk({ text: 'not a blocker', kind: 'status', validAt: ago(86400_000) });
    await seed.claim({ subjectKind: 'topic', kind: 'blocker', text: 'about a topic', validAt: ago(86400_000) });
    const closed = await mk({ text: 'closed', validAt: ago(86400_000) });
    await db.query('update claim set invalid_at = now() where id = $1', [closed]);
    const all = await repos.memory.activeBlockers(new Date());
    assert.ok(all.length <= 3);
    const got = all.map((r) => Number(r.id));
    assert.ok(got.indexOf(newer) < got.indexOf(older) || !got.includes(older), 'newest first');
    assert.ok(all.every((r) => !['too old', 'retracted', 'not a blocker', 'about a topic', 'closed'].includes(r.text)));
    assert.ok('quote' in all[0]);
  },

  'activeForPerson: a person\'s active claims, newest first': async ({ repos, seed, assert }) => {
    const p = await seed.personWith();
    const a = await seed.claim({ subjectKind: 'person', subjectId: p, kind: 'role', text: 'lead', validAt: ago(2 * 86400_000) });
    const b = await seed.claim({ subjectKind: 'person', subjectId: p, kind: 'role', text: 'owner', validAt: ago(86400_000) });
    await seed.claim({ subjectKind: 'person', subjectId: p, kind: 'role', text: 'old', status: 'superseded' });
    await seed.claim({ subjectKind: 'person', subjectId: await seed.personWith(), kind: 'role', text: 'someone else' });
    const got = await repos.memory.activeForPerson(p);
    assert.deepStrictEqual(got.map((r) => [Number(r.id), r.text]), [[b, 'owner'], [a, 'lead']]);
  },

  'insertTopicClaim: an audio claim about a topic, active, from a distill': async ({ repos, seed, db, assert }) => {
    const item = await seed.item({ source: 'audio' });
    const row = await repos.memory.insertTopicClaim({ label: 'weekly sync', kind: 'workflow', text: 'I get asked about X', quote: 'what about X', sourceItemId: item, validAt: '2099-01-01T10:00:00Z', extractedBy: 'meeting-learn-v1' });
    const r = await db.one('select * from claim where id = $1', [row.id]);
    assert.deepStrictEqual(
      [r.subject_kind, r.subject_id, r.subject_label, r.kind, r.text, r.quote, Number(r.source_item_id), r.source_kind, r.confidence, r.status, r.origin, r.extracted_by],
      ['topic', null, 'weekly sync', 'workflow', 'I get asked about X', 'what about X', item, 'audio', 0.8, 'active', 'distill', 'meeting-learn-v1']
    );
    assert.strictEqual(r.valid_at.toISOString(), '2099-01-01T10:00:00.000Z');
    const noItem = await repos.memory.insertTopicClaim({ label: 'l', kind: 'status', text: 't', quote: 'q', sourceItemId: null, validAt: '2099-01-01T10:00:00Z', extractedBy: 'v' });
    assert.ok(noItem.id);
  },

  'insertDebriefClaim: a claim about me or a topic from an audio item; returns its id': async ({ repos, seed, db, assert }) => {
    const item = await seed.item({ source: 'audio' });
    const p = await seed.personWith({ isMe: false });
    const id = await repos.memory.insertDebriefClaim({ subjectKind: 'me', subjectId: p, label: 'me', kind: 'status', text: 'I shipped it', quote: 'shipped', itemId: item, validAt: '2099-01-02T10:00:00Z', extractedBy: 'debrief-v1' });
    const r = await db.one('select * from claim where id = $1', [id]);
    assert.deepStrictEqual(
      [r.subject_kind, Number(r.subject_id), r.subject_label, r.kind, r.text, r.quote, Number(r.source_item_id), r.source_kind, r.status, r.origin, r.extracted_by],
      ['me', p, 'me', 'status', 'I shipped it', 'shipped', item, 'audio', 'active', 'distill', 'debrief-v1']
    );
    const topic = await repos.memory.insertDebriefClaim({ subjectKind: 'topic', label: 'a topic', kind: 'decision', text: 'we decided', quote: 'decided', itemId: item, validAt: '2099-01-02T10:00:00Z', extractedBy: 'debrief-v1' });
    assert.strictEqual((await db.one('select subject_id from claim where id = $1', [topic])).subject_id, null, 'subjectId defaults to null');
  },

  'retract: retracts a claim; a second call changes nothing': async ({ repos, seed, db, assert }) => {
    const id = await seed.claim({ text: 'to retract' });
    const other = await seed.claim({ text: 'stays' });
    await repos.memory.retract(id);
    const status = async (x) => (await db.one('select status from claim where id = $1', [x])).status;
    assert.deepStrictEqual([await status(id), await status(other)], ['retracted', 'active']);
    await repos.memory.retract(id);
    assert.strictEqual(await status(id), 'retracted');
  },

    // --- for src/distill/index.js

  'insertFact: a fact distilled from an item, with its payload': async ({ repos, seed, db, assert }) => {
    const item = await seed.sourceItem();
    const at = new Date(Date.now() - 3600_000);
    await repos.memory.insertFact(item, 'decision', 'we chose X', { detail: 'because' }, at, 'v1');
    const r = await db.one('select * from fact where source_item_id = $1', [item]);
    assert.deepStrictEqual([r.kind, r.summary, r.payload, r.extracted_by, r.occurred_at.getTime()], ['decision', 'we chose X', { detail: 'because' }, 'v1', at.getTime()]);
  },

  'deleteFactsOf: one item\'s facts at one prompt version only': async ({ repos, seed, db, assert }) => {
    const [item, other] = [await seed.sourceItem(), await seed.sourceItem()];
    const at = new Date();
    await repos.memory.insertFact(item, 'decision', 'v1 fact', {}, at, 'v1');
    await repos.memory.insertFact(item, 'decision', 'v2 fact', {}, at, 'v2');
    await repos.memory.insertFact(other, 'decision', 'other item', {}, at, 'v1');
    await repos.memory.deleteFactsOf(item, 'v1');
    const left = await db.rows('select summary from fact where source_item_id = any($1::bigint[]) order by summary', [[item, other]]);
    assert.deepStrictEqual(left.map((r) => r.summary), ['other item', 'v2 fact']);
  },

  // --- for src/distill/identity.js

  'repointClaimsToMe: claims about a person become claims about you': async ({ repos, seed, db, assert }) => {
    const [from, into, bystander] = [await seed.person(), await seed.person(), await seed.person()];
    const [a, b, c] = [await seed.claimAbout(from), await seed.claimAbout(from), await seed.claimAbout(bystander)];
    assert.strictEqual(await repos.memory.repointClaimsToMe(into, from), 2);
    const rows = await db.rows('select id, subject_kind, subject_id, subject_label from claim where id = any($1::bigint[]) order by id', [[a, b, c]]);
    assert.deepStrictEqual(rows.map((r) => [r.subject_kind, Number(r.subject_id), r.subject_label]), [['me', into, 'me'], ['me', into, 'me'], ['person', bystander, 'someone']]);
  },

  'repointClaims: claims about one person become claims about another, relabelled': async ({ repos, seed, db, assert }) => {
    const [from, into] = [await seed.person(), await seed.person()];
    const a = await seed.claimAbout(from);
    assert.strictEqual(await repos.memory.repointClaims(into, from, 'New Name'), 1);
    const r = await db.one('select subject_kind, subject_id, subject_label from claim where id = $1', [a]);
    assert.deepStrictEqual([r.subject_kind, Number(r.subject_id), r.subject_label], ['person', into, 'New Name']);
    assert.strictEqual(await repos.memory.repointClaims(into, from, 'x'), 0);
  },

  'deletePersonPage: removes that person\'s page only': async ({ repos, seed, db, assert }) => {
    const [a, b] = [await seed.person(), await seed.person()];
    const [pa, pb] = [await seed.personPage(a), await seed.personPage(b)];
    await repos.memory.deletePersonPage(a);
    const left = (await db.rows('select id from memory_page where id = any($1::bigint[])', [[pa, pb]])).map((r) => Number(r.id));
    assert.deepStrictEqual(left, [pb]);
  },
};