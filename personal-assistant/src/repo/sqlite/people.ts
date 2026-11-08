'use strict';

// SQLite twin of src/repo/people.js (person, person_identity). lower() is
// ASCII-only in SQLite (pg folds Unicode); LIKE takes '\' as its escape, as pg.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

type Db = import('../types.ts').Db;
type Row = import('../types.ts').Row;

function create(db: Db) {
  return {
    /** The person that is you. */
    async me() {
      return db.one('select id, display_name, primary_email from person where is_me limit 1');
    },

    /** A person's identities (smtp addresses, github usernames, ...). */
    async identitiesOf(personId: number | string) {
      return db.rows('select kind, value from person_identity where person_id = $1', [personId]);
    },

    /** Someone other than you by lowercased email (primary or smtp identity). */
    async otherByEmail(email: string) {
      return db.one(
        `select p.id, p.display_name from person p
      where not p.is_me and (lower(p.primary_email) = $1
         or p.id in (select person_id from person_identity where kind = 'smtp' and value = $1))
      limit 1`,
        [email]
      );
    },

    /** Display names for lowercased addresses (those the store knows). */
    async namesForEmails(emails: unknown[]) {
      return db.rows(
        `select lower(coalesce(pi.value, p.primary_email)) as email, p.display_name
       from person p left join person_identity pi on pi.person_id = p.id and pi.kind = 'smtp'
      where lower(p.primary_email) in (select value from json_each($1)) or pi.value in (select value from json_each($1))`,
        [emails || []]
      );
    },

    /** My identities (the person marked is_me): [{kind, value}]. */
    async myIdentities() {
      return db.rows('select pi.kind, pi.value from person_identity pi join person p on p.id = pi.person_id where p.is_me');
    },

    /** The person row that is you, or null before sign-in. */
    async meRow() {
      return db.one('select * from person where is_me limit 1');
    },

    /** Your display name (lowest id when several are flagged), or null. */
    async meName() {
      return db.one('select display_name from person where is_me order by id limit 1');
    },

    /** Your own handle of one identity kind (e.g. github_username). */
    async myHandle(kind: string) {
      return db.one(
        `select pi.value from person_identity pi join person p on p.id = pi.person_id
      where p.is_me and pi.kind = $1 order by pi.value limit 1`,
        [kind]
      );
    },

    /** Renames the person and sets their primary email. */
    async setNames(id: number | string, displayName: unknown, primaryEmail: unknown) {
      await db.query('update person set display_name = $2, primary_email = $3 where id = $1', [id, displayName, primaryEmail]);
    },

    /** Inserts the is_me person and returns it. */
    async insertMe(displayName: unknown, primaryEmail: unknown) {
      return db.one('insert into person (display_name, primary_email, is_me) values ($1,$2,1) returning id', [displayName, primaryEmail]);
    },

    /** Files an identity (kind, value) under a person; one already filed is left as it is. */
    async addIdentity(personId: number | string, kind: string, value: string) {
      await db.query('insert into person_identity (person_id, kind, value) values ($1,$2,$3) on conflict (kind, value) do nothing', [personId, kind, value]);
    },

    /** Up to two people with this display name (case-insensitive); two means ambiguous. */
    async byDisplayName(name: string) {
      return (await db.query('select id from person where lower(display_name) = lower($1) limit 2', [name])).rows;
    },

    /** The identity row of (kind, value): who owns it. */
    async identityOwner(kind: string, value: string) {
      return db.one('select person_id from person_identity where kind = $1 and value = $2', [kind, value]);
    },

    /** The person whose primary_email is `email` (lower case). */
    async byPrimaryEmail(email: string) {
      return db.one('select id from person where lower(primary_email) = $1', [email]);
    },

    /** Inserts a person (not you) and returns it. */
    async insert(displayName: unknown, primaryEmail: unknown) {
      return db.one('insert into person (display_name, primary_email) values ($1,$2) returning id', [displayName, primaryEmail]);
    },

    /** Others (not you) whose display name equals `name`, case-insensitive; at most two. */
    async othersByExactName(name: string) {
      return db.rows('select id, display_name from person where not is_me and lower(display_name) = lower($1) limit 2', [name]);
    },

    /** Others whose display name starts with `escapedPrefix` (LIKE-escaped by the caller); at most two. */
    async othersByNamePrefix(escapedPrefix: unknown) {
      return db.rows(`select id from person where not is_me and lower(display_name) like lower($1) || '%' escape '\\' limit 2`, [escapedPrefix]);
    },

    // --- merge (src/distill/identity.js), meant to run inside repo.withTx

    /** Both rows of a merge (person rows), by id. */
    async pair(intoId: number | string, fromId: number | string) {
      return (await db.query('select * from person where id in (select value from json_each($1))', [[Number(intoId), Number(fromId)]])).rows;
    },

    /** Moves every identity from one person to another. */
    async moveIdentities(intoId: number | string, fromId: number | string) {
      await db.query('update person_identity set person_id = $1 where person_id = $2', [intoId, fromId]);
    },

    /** Deletes a person. */
    async deleteById(id: number | string) {
      await db.query('delete from person where id = $1', [id]);
    },

    /** My primary email ({primary_email}) when set, else null. */
    async myPrimaryEmail() {
      return db.one('select primary_email from person where is_me and primary_email is not null limit 1');
    },

    /** The address of each person with one of these AAD object ids: {oid, email}. */
    async emailsByAadOid(oids: unknown[]) {
      return db.rows(
        `select pi.value as oid,
              coalesce(p.primary_email,
                       (select value from person_identity s where s.person_id = p.id and s.kind = 'smtp' limit 1)) as email
         from person_identity pi join person p on p.id = pi.person_id
        where pi.kind = 'aad_oid' and pi.value in (select value from json_each($1))`,
        [oids || []]
      );
    },

    /** Sets the display name and fills primary_email when empty. */
    async renameKeepingEmail(id: number | string, displayName: unknown, fallbackEmail: unknown) {
      await db.query('update person set display_name = $2, primary_email = coalesce(primary_email, $3) where id = $1', [id, displayName, fallbackEmail]);
    },
    /** One person row by id, or null. */
    async rowById(id: number | string) {
      return db.one('select * from person where id = $1', [id]);
    },

    /** The first person whose name or email, or an identity, matches a like pattern (caseless); null when none. */
    async findLoose(pattern: unknown) {
      return db.one(
        `select * from person
          where lower(display_name) like lower($1) or lower(primary_email) like lower($1)
             or id = (select person_id from person_identity where lower(value) like lower($1) limit 1)
          limit 1`,
        [pattern]
      );
    },
  };
}

module.exports = { create };
