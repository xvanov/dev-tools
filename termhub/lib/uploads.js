'use strict';

// Save a browser-dropped/pasted non-image file (PDF, .md, .txt, whatever)
// into a session's own working directory, mirroring what a native OS
// drag-and-drop of a file onto a terminal window does: the file lands where
// the terminal — and whatever agent is running inside it — can see it. The
// caller (sessiond.js) then has the client insert the resulting path as
// terminal input, same as a real drag-drop would.

const fs = require('fs');
const path = require('path');

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

module.exports = { saveUploadedFile, sanitizeFileName };
