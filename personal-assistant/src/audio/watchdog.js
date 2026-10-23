'use strict';

// Keeps always-on capture honest, and warns before the disk runs out.
//
// A recorder can be alive and recording nothing. When the disk filled up
// the loopback recorder's writes failed, it reopened, and then sat with an
// empty file for twelve minutes — the process was up, the scheduled task
// said "Running", and nobody knew the calls were not being kept. So the
// check is the one that matters: has this stream's spool *grown* lately?
// If not (and capture is not paused), its process is killed and its task
// started again, and the user is told.
//
// The disk check fires before that happens: a notification once free space
// on the spool's drive drops under the threshold, so there is time to act.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { config } = require('../config');
const { logger } = require('../log');

const exec = promisify(execFile);
const log = logger('capture-watchdog');

const STALE_MS = 120_000;
const RESTART_COOLDOWN_MS = 10 * 60_000;
const lastRestart = new Map();

// Paused by you or by the meeting gate: either way silence is the point.
function paused() {
  return require('./gate').readPause().state !== 'on';
}

// Newest write to any raw capture file in a stream's spool (speech files are
// written by the processing pass, not the recorder, so they do not count).
function lastWrite(stream) {
  const dir = path.join(config.audioDir, stream);
  let newest = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const n of names) {
    if (!n.endsWith('.wav') || n.endsWith('.speech.wav')) continue;
    try {
      const st = fs.statSync(path.join(dir, n));
      if (st.size > 44 && st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      // rolled or deleted between listing and stat
    }
  }
  return newest;
}

// Pure: which streams need a restart.
function staleStreams({ now, writes, isPaused, lastRestarts }) {
  if (isPaused) return [];
  return Object.entries(writes)
    .filter(([stream, at]) => now - at > STALE_MS && now - (lastRestarts[stream] || 0) > RESTART_COOLDOWN_MS)
    .map(([stream]) => stream);
}

async function restart(stream) {
  const task = `pa-capture-${stream}`;
  // Ending the task leaves the python child running (the task's process is a
  // wrapper), so the recorder itself is killed by its command line.
  const ps = [
    `Stop-ScheduledTask -TaskName '${task}' -ErrorAction SilentlyContinue`,
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'capture\\.py --stream ${stream}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }`,
    'Start-Sleep -Seconds 2',
    `Start-ScheduledTask -TaskName '${task}'`,
  ].join('; ');
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 60_000 });
}

async function checkCapture() {
  if (!config.audio.enabled || process.platform !== 'win32') return [];
  const now = Date.now();
  const writes = { mic: lastWrite('mic'), loopback: lastWrite('loopback') };
  const stale = staleStreams({ now, writes, isPaused: paused(), lastRestarts: Object.fromEntries(lastRestart) });
  for (const stream of stale) {
    lastRestart.set(stream, now);
    const quietMin = writes[stream] ? Math.round((now - writes[stream]) / 60_000) : null;
    log.warn('recorder silent — restarting', { stream, quietMinutes: quietMin });
    let ok = true;
    try {
      await restart(stream);
    } catch (err) {
      ok = false;
      log.warn('recorder restart failed', { stream, message: err.message });
    }
    await require('../notify')
      .notify({
        kind: 'info',
        title: `Recording: ${stream === 'mic' ? 'microphone' : 'call audio'} had stopped`,
        body: `Nothing was written for ${quietMin ?? '?'} min. ${ok ? 'Restarted it.' : 'Restart failed — run: Start-ScheduledTask pa-capture-' + stream}`,
        dedupeKey: `capture-stale:${stream}:${Math.floor(now / RESTART_COOLDOWN_MS)}`,
      })
      .catch(() => {});
  }
  return stale;
}

// Free bytes on the drive holding the audio spool (Windows drive letter).
async function freeBytes() {
  const drive = path.parse(path.resolve(config.audioDir)).root.slice(0, 1);
  const { stdout } = await exec(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-PSDrive -Name '${drive}').Free`],
    { windowsHide: true, timeout: 30_000 }
  );
  return Number(String(stdout).trim());
}

async function checkDisk() {
  if (process.platform !== 'win32') return null;
  const free = await freeBytes();
  if (!Number.isFinite(free)) return null;
  const gb = free / 1e9;
  if (gb < config.audio.lowDiskGb) {
    await require('../notify')
      .notify({
        kind: 'info',
        title: `Disk almost full: ${gb.toFixed(1)} GB free`,
        body: 'Recording, the database and backups all fail when it fills. Free some space (Disk Cleanup, OneDrive "free up space", old builds).',
        // Once per hour at most.
        dedupeKey: `low-disk:${Math.floor(Date.now() / 3600_000)}`,
      })
      .catch(() => {});
  }
  return gb;
}

module.exports = { checkCapture, checkDisk, staleStreams, lastWrite, STALE_MS };
