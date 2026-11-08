'use strict';

// Aggregate: people. Tables: person, person_identity.
// Owner while plan 1.2 is converting: chunk C (commitments).

function create(db) {
  return {
    // --- for meetings/index.js, meetings/debrief.js

    /**
     * The person that is you.
     * @returns {Promise<{id: number|string, display_name: string, primary_email: string|null}|null>}
     */
    async me() {
      return db.one('select id, display_name, primary_email from person where is_me limit 1');
    },

    /**
     * A person's identities (smtp addresses, github usernames, ...).
     * @param {number|string} personId
     * @returns {Promise<{kind: string, value: string}[]>}
     */
    async identitiesOf(personId) {
      return db.rows(`select kind, value from person_identity where person_id = $1`, [personId]);
    },

    /**
     * Someone other than you by lowercased email (primary or smtp identity).
     * @param {string} email
     * @returns {Promise<{id: number|string, display_name: string}|null>}
     */
    async otherByEmail(email) {
      return db.one(
        `select p.id, p.display_name from person p
      where not p.is_me and (lower(p.primary_email) = $1
         or p.id in (select person_id from person_identity where kind = 'smtp' and value = $1))
      limit 1`,
        [email]
      );
    },

    /**
     * Display names for lowercased addresses (those the store knows).
     * @param {string[]} emails
     * @returns {Promise<{email: string, display_name: string}[]>}
     */
    async namesForEmails(emails) {
      return db.rows(
        `select lower(coalesce(pi.value, p.primary_email)) as email, p.display_name
       from person p left join person_identity pi on pi.person_id = p.id and pi.kind = 'smtp'
      where lower(p.primary_email) = any($1::text[]) or pi.value = any($1::text[])`,
        [emails]
      );
    },

    // --- for ledger/reconcile.js

    /** My identities (the person marked is_me): [{kind, value}]. */
    async myIdentities() {
      return db.rows(`select pi.kind, pi.value from person_identity pi join person p on p.id = pi.person_id where p.is_me`);
    },

    /** The person row that is you, or null before sign-in. */
    async meRow() {
      return db.one('select * from person where is_me limit 1');
    },

    /** Your display name (lowest id when several are flagged), or null. @returns {Promise<{display_name}|null>} */
    async meName() {
      return db.one('select display_name from person where is_me order by id limit 1');
    },

    /**
     * Your own handle of one identity kind (e.g. github_username).
     * @returns {Promise<{value: string}|null>}
     */
    async myHandle(kind) {
      return db.one(
        `select pi.value from person_identity pi join person p on p.id = pi.person_id
      where p.is_me and pi.kind = $1 order by pi.value limit 1`,
        [kind]
      );
    },

    /** Renames the person and sets their primary email. */
    async setNames(id, displayName, primaryEmail) {
      await db.query('update person set display_name = $2, primary_email = $3 where id = $1', [id, displayName, primaryEmail]);
    },

    /** Inserts the is_me person and returns it. @returns {Promise<{id}>} */
    async insertMe(displayName, primaryEmail) {
      return db.one('insert into person (display_name, primary_email, is_me) values ($1,$2,true) returning id', [displayName, primaryEmail]);
    },

    /** Files an identity (kind, value) under a person; one already filed is left as it is. */
    async addIdentity(personId, kind, value) {
      await db.query(
        'insert into person_identity (person_id, kind, value) values ($1,$2,$3) ' + 'on conflict (kind, value) do nothing',
        [personId, kind, value]
      );
    },

    /**
     * Up to two people with this display name (case-insensitive); two means ambiguous.
     * @returns {Promise<Array<{id}>>}
     */
    async byDisplayName(name) {
      return (await db.query('select id from person where lower(display_name) = lower($1) limit 2', [name])).rows;
    },

    /** The identity row of (kind, value): who owns it. @returns {Promise<{person_id}|null>} */
    async identityOwner(kind, value) {
      return db.one('select person_id from person_identity where kind = $1 and value = $2', [kind, value]);
    },

    /** The person whose primary_email is `email` (lower case). @returns {Promise<{id}|null>} */
    async byPrimaryEmail(email) {
      return db.one('select id from person where lower(primary_email) = $1', [email]);
    },

    /** Inserts a person (not you) and returns it. @returns {Promise<{id}>} */
    async insert(displayName, primaryEmail) {
      return db.one('insert into person (display_name, primary_email) values ($1,$2) returning id', [displayName, primaryEmail]);
    },

    /**
     * Others (not you) whose display name equals `name`, case-insensitive; at most two.
     * @returns {Promise<Array<{id, display_name}>>}
     */
    async othersByExactName(name) {
      return db.rows('select id, display_name from person where not is_me and lower(display_name) = lower($1) limit 2', [name]);
    },

    /**
     * Others whose display name starts with `escapedPrefix` (LIKE-escaped by
     * the caller), case-insensitive; at most two.
     * @returns {Promise<Array<{id}>>}
     */
    async othersByNamePrefix(escapedPrefix) {
      return db.rows(`select id from person where not is_me and lower(display_name) like lower($1) || '%' limit 2`, [escapedPrefix]);
    },

    // --- merge (src/distill/identity.js), meant to run inside repo.withTx

    /** Both rows of a merge (person rows), by id. @returns {Promise<object[]>} */
    async pair(intoId, fromId) {
      return (await db.query('select * from person where id = any($1::bigint[])', [[intoId, fromId]])).rows;
    },

    /** Moves every identity from one person to another. */
    async moveIdentities(intoId, fromId) {
      await db.query('update person_identity set person_id = $1 where person_id = $2', [intoId, fromId]);
    },

    /** Deletes a person. */
    async deleteById(id) {
      await db.query('delete from person where id = $1', [id]);
    },

    /**
     * Sets the display name and fills primary_email when empty. After the
     * delete of the other person: primary_email is unique and they may share it.
     */
    async renameKeepingEmail(id, displayName, fallbackEmail) {
      await db.query('update person set display_name = $2, primary_email = coalesce(primary_email, $3) where id = $1', [id, displayName, fallbackEmail]);
    },
  };
}

module.exports = { create };