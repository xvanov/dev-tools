'use strict';

// Write an image to THIS machine's native OS clipboard. Used to bridge a browser's
// local clipboard image into a remote sessiond host: once the bytes land here,
// the existing "chat:imagePaste" hotkey in Claude Code (Alt+V on native
// Windows/WSL, Ctrl+V on Linux/macOS) picks it up exactly as if the user had
// copied a screenshot on this machine and pressed it.
//
// Not every host HAS a clipboard, though — a headless Linux server has no X or
// Wayland display for a clipboard to live on, and no amount of installed tooling
// changes that. `clipboardTarget()` says so up front so the caller can take the
// save-to-a-file route instead of failing at the user (see sessiond.js).
//
// **A clipboard write that exits 0 is not proof the image is on the clipboard.**
// Believing it is what made this path fail on every machine except the one the
// browser was sitting at — and there it only ever "worked" because the user had
// just copied the image to that machine's clipboard themselves, so the agent
// found an image whether or not we staged one. On a remote host the staging is
// the only source of the image, and three ways of exiting 0 with nothing usable
// on the clipboard were all live at once:
//
//  - `xsel` cannot attach a MIME type to a selection at all, so an image piped
//    into it becomes an untyped (effectively text) selection. Claude Code asks
//    for `image/png` by name and gets nothing back.
//  - a non-PNG image (a `.jpg` picked with 📎) staged under `image/jpeg` on Linux,
//    or coerced as `«class PNGf»` on macOS, is not what the reader asks for
//    either — Claude Code runs `xclip -t image/png -o` and saves whatever comes
//    back, which for a mismatched target is zero bytes.
//  - PowerShell 7 (`pwsh`) is a different clipboard client from the Windows
//    PowerShell 5.1 that Claude Code shells out to for `ContainsImage()`, and a
//    `SetImage` from it is not dependably visible to that reader.
//
// So: only claim a clipboard we can actually serve the reader from (PNG, and
// never `xsel`), write with the same host the reader uses, and then **read the
// clipboard back** with the reader's own predicate before telling anyone it
// worked. `clipboardHasImage()` is that read-back, and it is what turns a silent
// wrong answer into a fallback that works.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { findOnPath } = require('./shell');
const { extForImageMime } = require('./uploads');

const execFileP = promisify(execFile);

// The one image format every reader on every platform agrees on. Claude Code
// asks X/Wayland for `image/png` by name and coerces the macOS clipboard to
// `«class PNGf»`; neither has a fallback. Windows is the exception — it decodes
// the file and hands the OS a bitmap — but staging a single format everywhere
// keeps the rule the caller has to reason about down to one sentence.
const CLIPBOARD_IMAGE_MIME = 'image/png';

function tempImagePath(mimeType) {
  const name = `termhub-clip-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${extForImageMime(mimeType)}`;
  return path.join(os.tmpdir(), name);
}

async function withTempFile(buffer, mimeType, fn) {
  const file = tempImagePath(mimeType);
  await fs.promises.writeFile(file, buffer);
  try {
    return await fn(file);
  } finally {
    fs.promises.unlink(file).catch(() => {});
  }
}

// Pipe a buffer into a command's stdin and resolve/reject on exit, so Linux
// clipboard tools (which read the image from stdin, not a file argument) don't
// need a temp file at all.
//
// Resolve on 'exit', not 'close'. xclip forks a child that owns the selection
// for as long as it stays on the clipboard, and that child inherits the stderr
// pipe — so 'close' (all stdio drained *and* the process gone) doesn't fire
// until something else takes the clipboard, minutes or hours later. Waiting for
// it hangs the upload request that is waiting on us.
function runPiped(cmd, args, buffer) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (e) {
      return reject(e);
    }
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
    child.stdin.on('error', () => {}); // the tool may close stdin early on failure
    child.stdin.end(buffer);
  });
}

// ---- Windows ----------------------------------------------------------------

// Windows PowerShell (5.1) FIRST, `pwsh` only as a fallback — the reverse of
// what the rest of termhub prefers (see lib/shell.js), and deliberately so.
// Claude Code runs `powershell`, never `pwsh`, for both its `ContainsImage()`
// check and its `GetImage().Save()`; a clipboard staged by a different
// PowerShell host is not dependably visible to it. Matching the reader is the
// whole point, and 5.1 is on every Windows that can run termhub at all, so
// preferring it costs nothing.
function windowsPowerShell() {
  return findOnPath(['powershell']) || findOnPath(['pwsh']) || 'powershell.exe';
}

// WinForms' Clipboard needs a single-threaded apartment (-Sta), same as Claude
// Code's own clipboard-image script.
//
// `Clipboard::SetImage` on its own is NOT reliable and this is not a theory:
// measured here, one write in six left the clipboard with no image on it, with
// PowerShell exiting 0 every time. The clipboard is a contended global — any
// other process (a clipboard manager, an RDP session's clipboard channel, the
// shell itself) can hold it open for the moment we ask for it, and `SetImage`
// gives up after a single attempt. `SetDataObject($img, $true, 10, 100)` is the
// same call with the OLE retry loop turned on (10 tries, 100 ms apart) *and*
// `copy: $true`, which flushes the data out of this process so it survives the
// PowerShell exiting a few milliseconds later. Confirming `ContainsImage()`
// before exiting closes the rest: a non-zero exit here is worth far more than a
// zero that means nothing, because the caller has a working fallback.
async function setClipboardImageWindows(buffer, mimeType) {
  await withTempFile(buffer, mimeType, async (file) => {
    const psPath = file.replace(/'/g, "''");
    const script =
      'Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; ' +
      `$img = [System.Drawing.Image]::FromFile('${psPath}'); ` +
      'try { for ($i = 0; $i -lt 5; $i++) { ' +
      '  try { [System.Windows.Forms.Clipboard]::SetDataObject($img, $true, 10, 100) } catch { } ' +
      '  if ([System.Windows.Forms.Clipboard]::ContainsImage()) { exit 0 } ' +
      '  Start-Sleep -Milliseconds 120 ' +
      '} } finally { $img.Dispose() } ' +
      'Write-Error "clipboard did not accept the image"; exit 3';
    await execFileP(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Sta', '-Command', script]);
  });
}

// Character for character the check Claude Code runs before it will read an
// image (`checkImage` in its clipboard module). Anything weaker would pass on a
// clipboard it then refuses.
// execFile's own rejection message is the entire command line, which is useless
// in a one-line terminal notice — say what the exit code means instead.
async function clipboardHasImageWindows() {
  const script =
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    'if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 1 }';
  try {
    await execFileP(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Sta', '-Command', script]);
  } catch (e) {
    if (e && e.code === 1) throw new Error('the clipboard held no image when read back');
    throw new Error(`could not read the clipboard back: ${(e && e.message ? e.message : String(e)).split('\n')[0]}`);
  }
}

// ---- macOS ------------------------------------------------------------------

// osascript's PNGf coercion is PNG-specific, which is why clipboardTarget()
// refuses any other format here rather than staging something unreadable.
async function setClipboardImageMacOS(buffer) {
  await withTempFile(buffer, CLIPBOARD_IMAGE_MIME, async (file) => {
    const asPath = file.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `set the clipboard to (read (POSIX file "${asPath}") as \xABclass PNGf\xBB)`;
    await execFileP('osascript', ['-e', script]);
  });
}

async function clipboardHasImageMacOS() {
  const { stdout } = await execFileP('osascript', ['-e', 'clipboard info']);
  if (!/PNGf/.test(stdout)) throw new Error('clipboard holds no PNGf flavour');
}

// ---- Linux ------------------------------------------------------------------

// Pick the Linux clipboard tool for this session, or explain why there isn't one.
// The display check matters as much as the tool check: xclip ships by default on
// plenty of servers, exits non-zero with "Can't open display" when there is no X
// running, and there is nothing the user can install to fix that.
//
// `xsel` used to be the third choice here and is gone on purpose. It has no way
// to type a selection, so an image piped into it is offered to X untyped and the
// `xclip -t image/png -o` the agent runs reads back nothing. It exited 0 and
// looked like a working clipboard — the exact shape of failure this file now
// refuses to produce.
function linuxClipboardTool() {
  const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (!hasDisplay) return { reason: 'no X or Wayland display on this host' };
  if (process.env.WAYLAND_DISPLAY && findOnPath(['wl-copy'])) {
    return {
      cmd: 'wl-copy',
      args: ['--type', CLIPBOARD_IMAGE_MIME],
      verify: { cmd: 'wl-paste', args: ['-l'] },
    };
  }
  if (process.env.DISPLAY && findOnPath(['xclip'])) {
    return {
      cmd: 'xclip',
      args: ['-selection', 'clipboard', '-t', CLIPBOARD_IMAGE_MIME],
      verify: { cmd: 'xclip', args: ['-selection', 'clipboard', '-t', 'TARGETS', '-o'] },
    };
  }
  return { reason: 'no clipboard tool found — install xclip (or wl-clipboard under Wayland)' };
}

async function setClipboardImageLinux(buffer) {
  const tool = linuxClipboardTool();
  if (!tool.cmd) throw new Error(tool.reason);
  return runPiped(tool.cmd, tool.args, buffer);
}

// Ask the selection owner what it is offering — the same question Claude Code
// asks to decide there is an image to read at all. An owner that died, or one
// that never typed its selection, simply doesn't list image/png.
async function clipboardHasImageLinux() {
  const tool = linuxClipboardTool();
  if (!tool.cmd) throw new Error(tool.reason);
  let stdout = '';
  try {
    ({ stdout } = await execFileP(tool.verify.cmd, tool.verify.args));
  } catch (e) {
    // `wl-paste -l` exits non-zero on an empty clipboard, and so does xclip with
    // no selection owner — both mean "nothing there", not "the check broke".
    throw new Error(`${tool.verify.cmd} found nothing on the clipboard (${(e && e.message ? e.message : String(e)).split('\n')[0]})`);
  }
  const offered = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!offered.includes(CLIPBOARD_IMAGE_MIME)) {
    throw new Error(`clipboard offers ${offered.join(', ') || 'nothing'} — no ${CLIPBOARD_IMAGE_MIME}`);
  }
}

// ---- public -----------------------------------------------------------------

// Can this host stage an image the agent will actually be able to read back?
// Windows decodes whatever we hand it, so any format goes there; Linux and macOS
// both ask for PNG by name, so anything else is refused here and takes the
// save-to-a-file route instead — which every agent reads regardless of format.
function clipboardTarget(mimeType) {
  const mime = String(mimeType || CLIPBOARD_IMAGE_MIME).toLowerCase();
  if (process.platform === 'win32') return { available: true, tool: 'powershell' };
  if (mime !== CLIPBOARD_IMAGE_MIME) {
    return { available: false, reason: `only PNG can be staged on this platform's clipboard (got ${mime})` };
  }
  if (process.platform === 'darwin') return { available: true, tool: 'osascript' };
  const tool = linuxClipboardTool();
  if (tool.cmd) return { available: true, tool: tool.cmd };
  return { available: false, reason: tool.reason };
}

async function setClipboardImage(buffer, mimeType) {
  const mime = mimeType || CLIPBOARD_IMAGE_MIME;
  if (process.platform === 'win32') return setClipboardImageWindows(buffer, mime);
  if (process.platform === 'darwin') return setClipboardImageMacOS(buffer);
  return setClipboardImageLinux(buffer);
}

// Did the staging actually take? Resolves to `null` when the image is there and
// to a human-readable reason when it is not — never rejects, because the caller
// always has a working fallback and a verification that threw would cost the
// user their attachment for the sake of a diagnostic.
async function clipboardHasImage() {
  try {
    if (process.platform === 'win32') await clipboardHasImageWindows();
    else if (process.platform === 'darwin') await clipboardHasImageMacOS();
    else await clipboardHasImageLinux();
    return null;
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    return msg || 'clipboard read-back failed';
  }
}

// Stage an image and prove it landed: write, read back, and on a miss try the
// whole thing again. Resolves to `null` on success and to a reason on failure,
// so the caller can take the save-to-a-file route.
//
// The retry is not belt-and-braces. Even with the in-process retry loop the
// Windows write does, roughly one staging in thirty still reads back empty from
// another process — the clipboard is global, and anything watching it (clipboard
// history, a clipboard manager, an RDP clipboard channel) can take it away
// between our write and the agent's read. One-in-thirty is invisible in testing
// and infuriating in use, and a second attempt costs a few hundred milliseconds
// only on the attempt that already went wrong.
const STAGE_ATTEMPTS = 3;
async function stageClipboardImage(buffer, mimeType) {
  let last = null;
  for (let attempt = 0; attempt < STAGE_ATTEMPTS; attempt++) {
    try {
      await setClipboardImage(buffer, mimeType);
    } catch (e) {
      last = (e && e.message) ? e.message.split('\n')[0] : String(e);
      continue;
    }
    last = await clipboardHasImage();
    if (!last) return null;
  }
  return last || 'clipboard read-back failed';
}

// A 1x1 transparent PNG — enough to exercise the whole stage-then-read-back path
// without a real image, for the /api/clipboard-probe diagnostic below.
const PROBE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// Stage a throwaway image and read it back, reporting each step separately, so
// "will a pasted image reach the agent on THIS host?" is one curl rather than an
// afternoon of guessing on a machine you are not sitting at. Deliberately ONE
// unretried round trip, unlike stageClipboardImage — the diagnostic is only
// worth having if it shows the mechanism as it really behaves, retries and all
// being what hides the flakiness. Destructive by nature (it replaces whatever is
// on the clipboard), hence a POST.
async function probeClipboard() {
  const target = clipboardTarget(CLIPBOARD_IMAGE_MIME);
  const out = { platform: process.platform, target, staged: false, verified: false, error: null };
  if (!target.available) { out.error = target.reason || 'no clipboard on this host'; return out; }
  try {
    await setClipboardImage(PROBE_PNG, CLIPBOARD_IMAGE_MIME);
    out.staged = true;
  } catch (e) {
    out.error = `write failed: ${(e && e.message) ? e.message : String(e)}`;
    return out;
  }
  const why = await clipboardHasImage();
  out.verified = !why;
  if (why) out.error = `read-back failed: ${why}`;
  return out;
}

module.exports = {
  setClipboardImage,
  stageClipboardImage,
  clipboardTarget,
  clipboardHasImage,
  probeClipboard,
  CLIPBOARD_IMAGE_MIME,
};
