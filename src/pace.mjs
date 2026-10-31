import { setTimeout as delay } from 'node:timers/promises';

export const sleep = (ms, signal) => delay(ms, undefined, { signal });
export function gait(min, max, random = Math.random) {
  // Bounded Gaussian pacing adapted from PuppetMaster x-lead-research.ts.
  const gaussian = Math.sqrt(-2 * Math.log(Math.max(random(), Number.EPSILON))) * Math.cos(2 * Math.PI * random());
  return Math.round(Math.max(min, Math.min(max, (min + max) / 2 + gaussian * (max - min) / 6)));
}
export function retryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - now) || null;
}

export class Budget {
  constructor(minutes) {
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.deadline = Date.now() + minutes * 60000;
    this.timer = setTimeout(() => this.controller.abort(new Error('Maximum run time reached.')), minutes * 60000);
    this.timer.unref();
  }
  check() { this.signal.throwIfAborted(); if (Date.now() >= this.deadline) throw new Error('Maximum run time reached.'); }
  remaining() { return Math.max(1, this.deadline - Date.now()); }
  async wait(ms) { this.check(); await sleep(Math.min(ms, this.remaining()), this.signal); this.check(); }
  close() { clearTimeout(this.timer); }
}
