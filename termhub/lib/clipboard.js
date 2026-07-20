'use strict';

// Write an image to THIS machine's native OS clipboard. Used to bridge a browser's
// local clipboard image into a remote sessiond host: once the bytes land here,
// the existing "chat:imagePaste" hotkey in Claude Code (Alt+V on native
// Windows/WSL, Ctrl+V on Linux/macOS) picks it up exactly as if the user had
// copied a screenshot on this machine and pressed it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { findOnPath } = require('./shell');

const execFileP = promisify(execFile);

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
};

function tempImagePath(mimeType) {
  const ext = EXT_BY_MIME[mimeType] || '.png';
  const name = `termhub-clip-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${ext}`;
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

async function setClipboardImageLinux(buffer, mimeType) {
  if (process.env.WAYLAND_DISPLAY && findOnPath(['wl-copy'])) {
    return runPiped('wl-copy', ['--type', mimeType], buffer);
  }
  if (findOnPath(['xclip'])) {
    return runPiped('xclip', ['-selection', 'clipboard', '-t', mimeType], buffer);
  }
  if (findOnPath(['xsel'])) {
    // xsel has no MIME-type option — best-effort, text tools mostly ignore it anyway.
    return runPiped('xsel', ['--clipboard', '--input'], buffer);
  }
  throw new Error('no clipboard tool found — install xclip (or wl-clipboard under Wayland)');
}

async function setClipboardImage(buffer, mimeType) {
  const mime = mimeType || 'image/png';
  if (process.platform === 'win32') return setClipboardImageWindows(buffer, mime);
  if (process.platform === 'darwin') return setClipboardImageMacOS(buffer);
  return setClipboardImageLinux(buffer, mime);
}

module.exports = { setClipboardImage };
