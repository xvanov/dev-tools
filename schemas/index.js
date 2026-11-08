'use strict';

// The contract schemas (plan 1.1, D15): one JSON Schema source per object the
// parts exchange (Job, Run, Card, Event, Approval). TypeScript types are
// generated from them (gen-types.js -> types.d.ts); Python validates with
// `jsonschema` (software-factory/factory/contract_schemas.py); JS validates
// here.
//
// This validator is deliberately small and dependency-free: it implements only
// the keywords the schemas use and THROWS on any other keyword, so a schema
// can never silently mean more to Python's full validator than to this one.
// Add a keyword here (and to gen-types.js) before using it in a schema.

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const NAMES = ['job', 'run', 'card', 'event', 'approval'];
const KEYWORDS = new Set([
  '$schema', '$id', '$ref', '$defs', 'title', 'description',
  'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items',
  'anyOf', 'pattern', 'minimum', 'minLength',
]);

let cache = null;
function load() {
  if (cache) return cache;
  cache = new Map();
  for (const n of NAMES) cache.set(`${n}.schema.json`, JSON.parse(fs.readFileSync(path.join(DIR, `${n}.schema.json`), 'utf8')));
  return cache;
}

/** The parsed schema `name` ('job', 'run', ...). */
function schema(name) {
  const s = load().get(`${name}.schema.json`);
  if (!s) throw new Error(`no schema "${name}" (have: ${NAMES.join(', ')})`);
  return s;
}

/** Resolves a $ref ("#/$defs/x" or "other.schema.json#/$defs/x") against the file it appears in. */
function resolve(ref, file) {
  const [doc, frag = ''] = ref.split('#');
  const target = doc ? doc : file;
  let node = load().get(target);
  if (!node) throw new Error(`unresolvable $ref "${ref}" in ${file}`);
  for (const part of frag.split('/').filter(Boolean)) {
    node = node[part];
    if (node === undefined) throw new Error(`unresolvable $ref "${ref}" in ${file}`);
  }
  return { node, file: target };
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(want, v) {
  const t = typeOf(v);
  return want === t || (want === 'number' && t === 'integer');
}

function check(s, v, at, file, errors) {
  if (s === true) return;
  if (s === false) return void errors.push(`${at}: not allowed`);
  for (const k of Object.keys(s)) if (!KEYWORDS.has(k)) throw new Error(`schema keyword "${k}" at ${file} is not supported by schemas/index.js`);
  if (s.$ref) {
    const r = resolve(s.$ref, file);
    check(r.node, v, at, r.file, errors);
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeMatches(t, v))) return void errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(v)}`);
  }
  if (s.enum && !s.enum.some((e) => e === v)) errors.push(`${at}: ${JSON.stringify(v)} is not one of ${JSON.stringify(s.enum)}`);
  if ('const' in s && s.const !== v) errors.push(`${at}: must be ${JSON.stringify(s.const)}`);
  if (typeof v === 'string') {
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) errors.push(`${at}: "${v.slice(0, 60)}" does not match ${s.pattern}`);
    if (s.minLength != null && [...v].length < s.minLength) errors.push(`${at}: shorter than ${s.minLength}`);
  }
  if (typeof v === 'number' && s.minimum != null && v < s.minimum) errors.push(`${at}: below ${s.minimum}`);
  if (Array.isArray(v) && s.items) v.forEach((x, i) => check(s.items, x, `${at}[${i}]`, file, errors));
  if (typeOf(v) === 'object') {
    for (const k of s.required || []) if (!(k in v)) errors.push(`${at}: missing "${k}"`);
    const props = s.properties || {};
    for (const [k, x] of Object.entries(v)) {
      if (props[k]) check(props[k], x, `${at}.${k}`, file, errors);
      else if (s.additionalProperties === false) errors.push(`${at}: unexpected "${k}"`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, x, `${at}.${k}`, file, errors);
    }
  }
  if (s.anyOf) {
    const tries = s.anyOf.map((sub) => {
      const e = [];
      check(sub, v, at, file, e);
      return e;
    });
    if (!tries.some((e) => e.length === 0)) {
      // Report the closest branch: the one with the fewest complaints.
      const best = tries.reduce((a, b) => (b.length < a.length ? b : a));
      errors.push(...best);
    }
  }
}

/**
 * Validates `value` against schema `name`, or against one of its $defs with
 * `name#/$defs/x`. Returns a list of error strings (empty when valid).
 */
function validate(name, value) {
  const [base, frag] = name.split('#');
  const file = `${base}.schema.json`;
  schema(base);
  const node = frag ? resolve(`#${frag}`, file).node : load().get(file);
  const errors = [];
  check(node, value, '$', file, errors);
  return errors;
}

/** validate() that throws with every error listed. */
function assertValid(name, value) {
  const errors = validate(name, value);
  if (errors.length) throw new Error(`not a valid ${name}:\n  ${errors.slice(0, 20).join('\n  ')}`);
  return value;
}

module.exports = { NAMES, KEYWORDS, DIR, schema, validate, assertValid };
