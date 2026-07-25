'use strict';

// Save a browser-dropped/pasted non-image file (PDF, .md, .txt, whatever)
// into a session's own working directory, mirroring what a native OS
// drag-and-drop of a file onto a terminal window does: the file lands where
// the terminal — and whatever agent is running inside it — can see it. The
// caller (sessiond.js) then has the client insert the resulting path as
// terminal input, same as a real drag-drop would.

const fs = require('fs');
const path = require('path');
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
function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  let candidate = path.join(dir, fileName);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

async function saveUploadedFile(dir, rawName, buffer) {
  const fileName = sanitizeFileName(rawName);
  const dest = uniquePath(dir, fileName);
  await fs.promises.writeFile(dest, buffer);
  return { path: dest, name: path.basename(dest) };
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
// Best-effort: a failure here must never cost the user their paste.
const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function pruneOldAttachments(dir) {
  const cutoff = Date.now() - ATTACHMENT_TTL_MS;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const file = path.join(dir, name);
    try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch {}
  }
}

// A clipboard image arrives with no filename of its own, so stamp it with the
// time it was pasted: sortable, obvious in a listing, and no two collide.
function defaultImageName(mimeType) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `pasted-image-${stamp}${extForImageMime(mimeType)}`;
}

async function saveImageAttachment(rawName, mimeType, buffer) {
  const dir = attachmentsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  pruneOldAttachments(dir);
  let fileName = sanitizeFileName(rawName || defaultImageName(mimeType));
  // A name the browser handed us may have no extension at all; without one
  // neither an agent nor an image viewer can tell what it is looking at.
  if (!path.extname(fileName)) fileName += extForImageMime(mimeType);
  const dest = uniquePath(dir, fileName);
  await fs.promises.writeFile(dest, buffer);
  return { path: dest, name: path.basename(dest) };
}

module.exports = {
  saveUploadedFile, sanitizeFileName, saveImageAttachment, attachmentsDir, extForImageMime,
};
