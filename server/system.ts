import fs from 'node:fs';

import type {ResourceUsage, SystemStats} from '../shared/types';

// Best-effort host stats, read straight from /proc and statfs. Every reader
// degrades to zeroes rather than throwing: a missing stat must never take down
// an API request.

function usage(total: number, available: number): ResourceUsage {
  return {total, available, used: Math.max(0, total - available)};
}

/** Host memory, parsed from /proc/meminfo. */
export function hostMemory(): ResourceUsage {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const fields = new Map<string, number>();
    for (const line of meminfo.split('\n')) {
      const match = /^(\w+):\s+(\d+)\s*kB/.exec(line);
      if (match) fields.set(match[1] as string, Number(match[2]) * 1024);
    }
    const total = fields.get('MemTotal') ?? 0;
    const available = fields.get('MemAvailable') ?? fields.get('MemFree') ?? 0;
    return usage(total, available);
  } catch {
    return usage(0, 0);
  }
}

/** Free/total space on the filesystem holding `path`. */
export function diskUsage(path: string): ResourceUsage & {path: string} {
  try {
    const stat = fs.statfsSync(path);
    const total = stat.blocks * stat.bsize;
    const available = stat.bavail * stat.bsize;
    return {...usage(total, available), path};
  } catch {
    return {...usage(0, 0), path};
  }
}

/** Resident set size of a process, parsed from /proc/<pid>/status. */
export function processRss(pid: number): number {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s*kB/m.exec(status);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

export function systemStats(diskPath: string): SystemStats {
  return {memory: hostMemory(), disk: diskUsage(diskPath)};
}
