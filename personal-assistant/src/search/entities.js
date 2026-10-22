'use strict';

// The third retrieval leg: people named in the query.
//
// "what did Brannoc ask for" has one strong signal and it is not a topic —
// it is a person. Neither full text (the name is often only in the header) nor
// embeddings (names carry little meaning) find "everything from or to them"
// reliably, so a query that names someone also pulls that person's recent
// items, and the reranker decides which of them answer the question.
//
// Matching is deliberately strict, mirroring identity resolution: a full
// display name, or a first name that only one known person has. A common first
// name shared by three colleagues pulls nobody rather than the wrong one.

function words(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// people: [{id, display_name, is_me}] → ids named in the query.
function mentionedPeople(query, people) {
  const q = ` ${words(query).join(' ')} `;
  if (q.trim() === '') return [];

  const firstCounts = new Map();
  for (const p of people) {
    const first = words(p.display_name)[0];
    if (first) firstCounts.set(first, (firstCounts.get(first) || 0) + 1);
  }

  const hits = [];
  for (const p of people) {
    if (p.is_me) continue;
    const name = words(p.display_name);
    if (!name.length) continue;
    const full = ` ${name.join(' ')} `;
    const first = name[0];
    const fullMatch = name.length > 1 && q.includes(full);
    const firstMatch = first.length >= 3 && firstCounts.get(first) === 1 && q.includes(` ${first} `);
    if (fullMatch || firstMatch) hits.push(p.id);
  }
  return hits;
}

module.exports = { mentionedPeople, words };
