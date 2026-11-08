'use strict';

// Aggregate: people. Tables: person, person_identity.
// Owner while plan 1.2 is converting: chunk C (commitments). Not converted yet.

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
  };
}

module.exports = { create };
