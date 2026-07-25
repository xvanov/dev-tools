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

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { findOnPath } = require('./shell');
const { extForImageMime } = require('./uploads');

const execFileP = promisify(execFile);

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
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
    child.stdin.on('error', () => {}); // the tool may close stdin early on failure
    child.stdin.end(buffer);
  });
}

// WinForms' Clipboard needs a single-threaded apartment (-Sta), same as Claude
// Code's own clipboard-image script.
async function setClipboardImageWindows(buffer, mimeType) {
  await withTempFile(buffer, mimeType, async (file) => {
    const psPath = file.replace(/'/g, "''");
    const script =
      'Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; ' +
      `$img = [System.Drawing.Image]::FromFile('${psPath}'); ` +
      '[System.Windows.Forms.Clipboard]::SetImage($img); $img.Dispose()';
    const pwsh = findOnPath(['pwsh']) || findOnPath(['powershell']) || 'powershell.exe';
    await execFileP(pwsh, ['-NoProfile', '-NonInteractive', '-Sta', '-Command', script]);
  });
}

// osascript's PNGf coercion is PNG-specific — fine here since browser
// clipboard-paste images are effectively always PNG.
async function setClipboardImageMacOS(buffer) {
  await withTempFile(buffer, 'image/png', async (file) => {
    const asPath = file.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `set the clipboard to (read (POSIX file "${asPath}") as \xABclass PNGf\xBB)`;
    await execFileP('osascript', ['-e', script]);
  });
}

// Pick the Linux clipboard tool for this session, or explain why there isn't one.
// The display check matters as much as the tool check: xclip ships by default on
// plenty of servers, exits non-zero with "Can't open display" when there is no X
// running, and there is nothing the user can install to fix that.
function linuxClipboardTool(mimeType) {
  const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (!hasDisplay) return { reason: 'no X or Wayland display on this host' };
  if (process.env.WAYLAND_DISPLAY && findOnPath(['wl-copy'])) {
    return { cmd: 'wl-copy', args: ['--type', mimeType] };
  }
  if (process.env.DISPLAY && findOnPath(['xclip'])) {
    return { cmd: 'xclip', args: ['-selection', 'clipboard', '-t', mimeType] };
  }
  if (process.env.DISPLAY && findOnPath(['xsel'])) {
    // xsel has no MIME-type option — best-effort, text tools mostly ignore it anyway.
    return { cmd: 'xsel', args: ['--clipboard', '--input'] };
  }
  return { reason: 'no clipboard tool found — install xclip (or wl-clipboard under Wayland)' };
}

async function setClipboardImageLinux(buffer, mimeType) {
  const tool = linuxClipboardTool(mimeType);
  if (!tool.cmd) throw new Error(tool.reason);
  return runPiped(tool.cmd, tool.args, buffer);
}

// Can this host stage an image on a native clipboard at all? Windows and macOS
// always can (the APIs are part of the OS); Linux only with a display plus a
// tool to talk to it. MIME type only affects which Linux tool is picked, so the
// answer is the same for every image format we accept.
function clipboardTarget() {
  if (process.platform === 'win32') return { available: true, tool: 'powershell' };
  if (process.platform === 'darwin') return { available: true, tool: 'osascript' };
  const tool = linuxClipboardTool('image/png');
  if (tool.cmd) return { available: true, tool: tool.cmd };
  return { available: false, reason: tool.reason };
}

async function setClipboardImage(buffer, mimeType) {
  const mime = mimeType || 'image/png';
  if (process.platform === 'win32') return setClipboardImageWindows(buffer, mime);
  if (process.platform === 'darwin') return setClipboardImageMacOS(buffer);
  return setClipboardImageLinux(buffer, mime);
}

module.exports = { setClipboardImage, clipboardTarget };
