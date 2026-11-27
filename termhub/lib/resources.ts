'use strict';

// The machine's own headroom for the sidebar's resource strip (GET /api/resources):
// RAM, swap, the disk under the home directory, and NVIDIA GPU memory. Agent swarms
// run in this machine's terminals, and on 2026-11-27 one filled RAM and froze the
// box (termhub, the tunnels and remote desktop with it), so the numbers sit where
// the sessions are and turn red before that point, not after.
//
// Cheap on purpose: /proc/meminfo and statfs are a file read and a syscall;
// nvidia-smi is a fork, so it is cached for GPU_TTL_MS and skipped for good once
// it is missing. Every part is optional: a field that cannot be read is null and
// the UI leaves it out.
//
// Strict TypeScript (plan 4.1): erasable syntax, CommonJS (docs/native/JARVISD.md).

const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

type Pair = { used: number; total: number } | null;
type Gpu = { name: string; used: number; total: number; util: number | null };

/** Levels as fractions used. Above `warn` the UI goes amber, above `danger` red. */
const LEVELS = {
  mem: { warn: 0.80, danger: 0.90 },
  swap: { warn: 0.50, danger: 0.75 },
  disk: { warn: 0.85, danger: 0.93 },
  gpu: { warn: 0.85, danger: 0.95 },
};

const GPU_TTL_MS = 15_000;

/** RAM and swap in bytes from /proc/meminfo text; `used` counts what cannot be reclaimed (total - MemAvailable). */
function parseMeminfo(text: string): { mem: Pair; swap: Pair } {
  const kb: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) kb[m[1]] = Number(m[2]) * 1024;
  }
  const mem = kb.MemTotal && kb.MemAvailable != null ? { used: kb.MemTotal - kb.MemAvailable, total: kb.MemTotal } : null;
  const swap = kb.SwapTotal ? { used: kb.SwapTotal - (kb.SwapFree || 0), total: kb.SwapTotal } : null;
  return { mem, swap };
}

function readMemory(): { mem: Pair; swap: Pair } {
  try {
    return parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8'));
  } catch {
    // Not Linux: os.freemem is close enough to "available" on Windows/macOS. No swap figure.
    return { mem: { used: os.totalmem() - os.freemem(), total: os.totalmem() }, swap: null };
  }
}

function readDisk(dir: string): Pair {
  try {
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize;
    return total ? { used: total - s.bavail * s.bsize, total } : null;
  } catch {
    return null;
  }
}

/** nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits */
function parseNvidiaSmi(text: string): Gpu[] {
  const out: Gpu[] = [];
  for (const line of text.split('\n')) {
    const f = line.split(',').map((x) => x.trim());
    if (f.length < 3 || !f[0]) continue;
    const used = Number(f[1]), total = Number(f[2]), util = Number(f[3]);
    if (!Number.isFinite(used) || !Number.isFinite(total) || !total) continue;
    out.push({ name: f[0], used: used * 1024 * 1024, total: total * 1024 * 1024, util: Number.isFinite(util) ? util : null });
  }
  return out;
}

let gpuCache: { at: number; value: Gpu[] | null } = { at: 0, value: null };
let gpuMissing = false;
let gpuInFlight: Promise<Gpu[] | null> | null = null;

function readGpus(now = Date.now()): Promise<Gpu[] | null> {
  if (gpuMissing) return Promise.resolve(null);
  if (now - gpuCache.at < GPU_TTL_MS) return Promise.resolve(gpuCache.value);
  if (gpuInFlight) return gpuInFlight;
  gpuInFlight = new Promise<Gpu[] | null>((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 3000, windowsHide: true }, (err: any, stdout: string) => {
        if (err && err.code === 'ENOENT') gpuMissing = true;
        const value = err ? null : parseNvidiaSmi(String(stdout));
        gpuCache = { at: Date.now(), value: value && value.length ? value : null };
        resolve(gpuCache.value);
      });
  }).finally(() => { gpuInFlight = null; });
  return gpuInFlight;
}

async function snapshot({ diskPath = os.homedir() }: { diskPath?: string } = {}) {
  const { mem, swap } = readMemory();
  return {
    at: Date.now(),
    mem,
    swap,
    disk: readDisk(diskPath),
    gpus: await readGpus(),
    levels: LEVELS,
  };
}

module.exports = { snapshot, parseMeminfo, parseNvidiaSmi, LEVELS };
