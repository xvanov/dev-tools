'use strict';

// Save a browser-dropped/pasted/attached file where the session can see it.
// Ordinary files (PDF, .md, .txt, whatever) go into the session's own working
// directory, mirroring what a native OS drag-and-drop of a file onto a terminal
// window does: the file lands where the terminal — and whatever agent is
// running inside it — can see it. Images that could not be staged on an OS
// clipboard go to the data dir instead (see saveImageAttachment below). Either
// way the caller (sessiond.js) has the client insert the resulting path as
// terminal input, same as a real drag-drop would.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./paths');

// Extension per image MIME type, shared with lib/clipboard.js (which needs the
// same mapping for the temp file it hands to the OS clipboard tools).
const EXT_BY_IMAGE_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
};

function extForImageMime(mimeType) {
  return EXT_BY_IMAGE_MIME[mimeType] || '.png';
}

// Filenames as handed to us by the browser occasionally carry path
// separators (e.g. a full path leaking through on some OS/browser combos) —
// keep only the base name so an upload can never escape the target
// directory. Also strip the other characters Windows filenames reject
// outright — importantly ':', since NTFS treats "name:rest" as an Alternate
// Data Stream reference rather than a literal filename: fs.writeFile happily
// "succeeds" but silently writes into a hidden stream on a file called `name`
// (verified: no error, and the named file never appears in a directory
// listing) instead of creating the file the caller asked for.
function sanitizeFileName(name) {
  const base = path.basename(String(name || 'upload').replace(/[\\/]/g, '_'));
  const cleaned = base.replace(/[\x00-\x1f<>:"|?*]/g, '').trim();
  return cleaned || 'upload';
}

// Never clobber an existing file: "notes.pdf" -> "notes (1).pdf" -> ...
//
// The name is claimed by the write ITSELF, with the exclusive-create flag, and
// we retry on EEXIST. Looking first with fs.existsSync and writing afterwards
// looks equivalent and is not: the write is awaited, so the event loop turns
// between the check and the create, and two uploads racing for the same name
// both pass the check and the second silently overwrites the first — while both
// clients are told `{ok:true}` with the same path. That is not a rare
// interleaving here: a multi-file pick uploads everything at once, and iOS
// hands back the same "image.jpg" for every photo in a selection.
const MAX_NAME_ATTEMPTS = 1000;
async function writeUnique(dir, fileName, buffer) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let n = 0; n < MAX_NAME_ATTEMPTS; n++) {
    const candidate = path.join(dir, n === 0 ? fileName : `${stem} (${n})${ext}`);
    try {
      await fs.promises.writeFile(candidate, buffer, { flag: 'wx' }); // O_CREAT|O_EXCL
      return { path: candidate, name: path.basename(candidate) };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;    // a real failure (EACCES, ENOSPC, …)
    }
  }
  // A thousand files of the same name. Take a random suffix rather than spin.
  const candidate = path.join(dir, `${stem} (${crypto.randomBytes(4).toString('hex')})${ext}`);
  await fs.promises.writeFile(candidate, buffer, { flag: 'wx' });
  return { path: candidate, name: path.basename(candidate) };
}

async function saveUploadedFile(dir, rawName, buffer) {
  return writeUnique(dir, sanitizeFileName(rawName), buffer);
}

// ---- image attachments ------------------------------------------------------
// Where an image lands when this host has no usable OS clipboard to stage it on
// (see lib/clipboard.js): the data dir, NOT the session's cwd. An image is a
// throwaway of the turn it was pasted for, and dropping screenshots into what is
// usually a git checkout means `git status` noise the user then has to clean up.
// Here they are out of the way, always in the same predictable place, and one
// `rm -rf` clears the lot.
function attachmentsDir() {
  return path.join(dataDir(), 'attachments');
}

// Nobody ever tidies this directory by hand and a month of pasted screenshots
// adds up, so drop anything older than a week — long past the turn it was for.
//
// Async and throttled, because this runs inside the process that owns every
// live PTY: the synchronous version stat'd every entry on each save (6 ms for
// 3000 files) and blocked all terminal I/O while it did. Once an hour is plenty
// for a week-old cutoff. Best-effort throughout — a failure here must never
// cost the user their paste, so nothing awaits it and nothing throws.
const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

async function pruneOldAttachments(dir) {
  const cutoff = Date.now() - ATTACHMENT_TTL_MS;
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = await fs.promises.stat(file);
      if (st.mtimeMs < cutoff) await fs.promises.unlink(file);
    } catch {
      // vanished under us, or not ours to delete — either way, skip it
    }
  }
}

function maybePrune(dir) {
  if (Date.now() - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = Date.now();
  pruneOldAttachments(dir).catch(() => {});   // deliberately not awaited
}

// A clipboard image arrives with no filename of its own, so stamp it with the
// time it was pasted: sortable, and obvious in a listing. Only second
// resolution, so two images pasted in the same second DO collide by name —
// writeUnique is what keeps that from costing anyone their data.
function defaultImageName(mimeType) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `pasted-image-${stamp}${extForImageMime(mimeType)}`;
}

async function saveImageAttachment(rawName, mimeType, buffer) {
  const dir = attachmentsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  maybePrune(dir);
  let fileName = sanitizeFileName(rawName || defaultImageName(mimeType));
  // A name the browser handed us may have no extension at all; without one
  // neither an agent nor an image viewer can tell what it is looking at.
  if (!path.extname(fileName)) fileName += extForImageMime(mimeType);
  return writeUnique(dir, fileName, buffer);
}

module.exports = { saveUploadedFile, sanitizeFileName, saveImageAttachment, extForImageMime };
