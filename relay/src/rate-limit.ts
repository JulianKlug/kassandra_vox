/**
 * Per-IP sliding window rate limiter.
 * 100 messages per 60-second window.
 * Stale entries swept every 10 minutes.
 */

const MAX_MESSAGES = 300; // ~5/sec sustained, enough for throttled transcript streaming
const WINDOW_MS = 60_000;
const SWEEP_INTERVAL_MS = 10 * 60_000; // 10 minutes

const windows = new Map<string, number[]>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function isRateLimited(ip: string): boolean {
  const now = Date.now();
  let timestamps = windows.get(ip);
  if (!timestamps) {
    timestamps = [];
    windows.set(ip, timestamps);
  }

  // Drop entries outside the window
  while (timestamps.length > 0 && timestamps[0] <= now - WINDOW_MS) {
    timestamps.shift();
  }

  if (timestamps.length >= MAX_MESSAGES) {
    return true;
  }

  timestamps.push(now);
  return false;
}

export function clearRateLimit(ip: string): void {
  windows.delete(ip);
}

/**
 * Remove IPs with no activity in the last window.
 * Prevents memory leak from IPs that connected once and never returned.
 */
export function sweepStaleEntries(): number {
  const now = Date.now();
  let swept = 0;
  for (const [ip, timestamps] of windows) {
    if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= now - WINDOW_MS) {
      windows.delete(ip);
      swept++;
    }
  }
  return swept;
}

export function startRateLimitSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepStaleEntries, SWEEP_INTERVAL_MS);
}

export function stopRateLimitSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

export function clearAllRateLimits(): void {
  windows.clear();
}
