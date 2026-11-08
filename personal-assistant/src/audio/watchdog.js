'use strict';

// Keeps always-on capture honest, and warns before the disk runs out.
//
// A recorder can be alive and recording nothing. When the disk filled up
// the loopback recorder's writes failed, it reopened, and then sat with an
// empty file for twelve minutes — the process was up, the scheduled task
// said "Running", and nobody knew the calls were not being kept. So the
// check is the one that matters: has this stream's spool *grown* lately?
// If not (and capture is not paused), its process is killed and its service
// started again (a logon task on Windows, a systemd user unit on Linux — see
// src/platform), and the user is told.
//
// The disk check fires before that happens: a notification once free space
// on the spool's drive drops under the threshold, so there is time to act.

const fs = require('fs');
const path = require('path');

const { config } = require('../config.ts');
const { logger } = require('../log.ts');
const platform = require('../platform');

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

async function checkCapture() {
  // A stream whose service was never installed (`--no-audio`, or a platform
  // without capture) is reported by `pa doctor`, not restarted every ten
  // minutes with a notification each time.
  if (!config.audio.enabled || !platform.capture.installed()) return [];
  const now = Date.now();
  const writes = { mic: lastWrite('mic'), loopback: lastWrite('loopback') };
  const stale = staleStreams({ now, writes, isPaused: paused(), lastRestarts: Object.fromEntries(lastRestart) });
  for (const stream of stale) {
    lastRestart.set(stream, now);
    const quietMin = writes[stream] ? Math.round((now - writes[stream]) / 60_000) : null;
    log.warn('recorder silent — restarting', { stream, quietMinutes: quietMin });
    let ok = true;
    try {
      await platform.capture.restart(stream);
    } catch (err) {
      ok = false;
      log.warn('recorder restart failed', { stream, message: err.message });
    }
    await require('../notify')
      .notify({
        kind: 'info',
        title: `Recording: ${stream === 'mic' ? 'microphone' : 'call audio'} had stopped`,
        body: `Nothing was written for ${quietMin ?? '?'} min. ${ok ? 'Restarted it.' : 'Restart failed — run: ' + platform.capture.restartHint(stream)}`,
        dedupeKey: `capture-stale:${stream}:${Math.floor(now / RESTART_COOLDOWN_MS)}`,
      })
      .catch(() => {});
  }
  return stale;
}

// Free bytes on the filesystem holding the audio spool: a PowerShell drive
// query on Windows, one statfs call elsewhere (src/platform).
function freeBytes() {
  return platform.freeBytes(config.audioDir);
}

async function checkDisk() {
  const free = await freeBytes();
  if (!Number.isFinite(free)) return null;
  const gb = free / 1e9;
  if (gb < config.audio.lowDiskGb) {
    await require('../notify')
      .notify({
        kind: 'info',
        title: `Disk almost full: ${gb.toFixed(1)} GB free`,
        body: 'Recording, the database and backups all fail when it fills. Free some space (old builds, caches, aged audio).',
        // Once per hour at most.
        dedupeKey: `low-disk:${Math.floor(Date.now() / 3600_000)}`,
      })
      .catch(() => {});
  }
  return gb;
}

module.exports = { checkCapture, checkDisk, staleStreams, lastWrite, STALE_MS };
