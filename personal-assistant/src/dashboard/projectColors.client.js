'use strict';

// A project's colour and the Plan board's project groups. A project name hashes
// (FNV-1a) into one of the eight --proj-N hues in theme.css, so the same project
// has the same colour on every card, every page and every reload. The pure half
// (slot, group) is required by test/projectColors.test.js; the browser gets
// window.JarvisProjects. page.client.js keeps its own copy of slot(), because the
// export inlines that file alone; the test holds the two in step. Text only.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JarvisProjects = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const SLOTS = 8;

  /** The colour slot (0..7) for a project name; null for no project. */
  function slot(name) {
    const s = name == null ? '' : String(name);
    if (!s) return null;
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % SLOTS;
  }

  /**
   * Cards grouped by project: [{ project, slot, cards }], projects in name order
   * (case-insensitive), cards without a project last. A group keeps its cards in
   * the order they came, so the board's own ranking holds inside each project.
   */
  function group(cards, projectOf = (c) => c.project) {
    const byName = new Map();
    for (const c of cards || []) {
      const p = projectOf(c) || null;
      if (!byName.has(p)) byName.set(p, { project: p, slot: slot(p), cards: [] });
      byName.get(p).cards.push(c);
    }
    const key = (p) => p.toLowerCase();
    return [...byName.values()].sort((a, b) => {
      if (a.project === null || b.project === null) return (a.project === null) - (b.project === null);
      return key(a.project) < key(b.project) ? -1 : key(a.project) > key(b.project) ? 1 : a.project < b.project ? -1 : a.project > b.project ? 1 : 0;
    });
  }

  return { SLOTS, slot, group };
});
