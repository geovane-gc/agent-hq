// Every balance number of the office economy lives here, so it can be tuned in
// one place. Amounts are USD, the same unit as the API-equivalent token cost
// that Claude Code reports (which is what we book as expenses).
//
// Rules of thumb behind the defaults:
// - A typical agent task costs $0.50–$15 of API-equivalent tokens. A merged,
//   reasonably sized change should clearly beat that, so good work is
//   profitable even on expensive models.
// - Revenue never depends on tokens spent. Only verified merged work pays.
// - Splitting work into tiny PRs must not pay more than doing it in one go.

import type { OfficeMode } from '@agent-hq/protocol';

export const ECONOMY = {
  // ------------------------------------------------------------ career start

  /** Career: cash a new office starts with. Enough for 3 hires plus a little runway for token costs. */
  startingCash: 1_750,

  /** Career: one-time fee to hire an agent. Hiring is refused when cash is below it. */
  hiringFee: 500,

  /**
   * Sandbox: whether hiring fees are booked at all. Off: sandbox is a work
   * tool, and the scoreboard only reflects delivered work vs. token costs.
   */
  sandboxChargesHiringFee: false,

  // ------------------------------------------------------------ payout for merged work
  // payout = (basePayout + perLine × min(lines, lineCap)) × tinyFactor
  // tinyFactor = 1 when lines ≥ tinyThreshold, else (lines / tinyThreshold)²
  //
  // Examples with the defaults:
  //   1 line   → $0.10   (50 one-line PRs ≈ $5 in total)
  //   10 lines → $11.25
  //   20 lines → $50
  //   100 lines → $90
  //   600+ lines → $340 (cap)

  /** Flat amount for a meaningful delivery. */
  basePayout: 40,
  /** Extra per changed line (insertions + deletions). */
  perLine: 0.5,
  /** Lines above this don't pay more. */
  lineCap: 600,
  /** Below this many lines, the payout shrinks quadratically. */
  tinyThreshold: 20,
  /** Changed files matching these don't count as lines (lockfiles, generated snapshots…). */
  ignoredFiles: [
    /(^|\/)package-lock\.json$/,
    /(^|\/)npm-shrinkwrap\.json$/,
    /(^|\/)yarn\.lock$/,
    /(^|\/)pnpm-lock\.yaml$/,
    /(^|\/)bun\.lockb?$/,
    /(^|\/)Cargo\.lock$/,
    /(^|\/)poetry\.lock$/,
    /(^|\/)Gemfile\.lock$/,
    /(^|\/)composer\.lock$/,
    /(^|\/)go\.sum$/,
    /\.min\.(js|css)$/,
    /\.snap$/,
  ] as RegExp[],

  /**
   * Income (revenue + commissions + bonuses) per local day. A delivery that
   * doesn't fit in what's left today is queued and paid on a later day.
   */
  dailyRevenueCap: 1_500,

  // ------------------------------------------------------------ bonuses

  /** A coordinator that delegated the task (it created it) earns this share of the payout, on top. */
  coordinatorCommission: 0.15,

  // TODO(phase 2): CI-green bonus, e.g. +10% when the merged head commit has
  // all GitHub checks green (needs the GitHub-linked projects feature: the
  // commit status API). See Economy.bonusesFor().
  ciGreenBonus: 0.1,
  // TODO(phase 2): no-revert bonus, e.g. +10% paid 7 days after the merge if no
  // later commit on the default branch reverts it (`git log --grep "This reverts commit <sha>"`).
  noRevertBonus: 0.1,
  noRevertDays: 7,

  // ------------------------------------------------------------ verification

  /** How often the host looks for newly merged task branches. */
  sweepIntervalMs: 5 * 60_000,
  /** Don't `git fetch` the same project more often than this (manual checks ignore it). */
  fetchMinIntervalMs: 2 * 60_000,
  /** Tasks untouched for longer than this are no longer checked. */
  maxTaskAgeMs: 30 * 86_400_000,
  /** Give up on a `git fetch` after this long (offline, credentials prompt…). */
  fetchTimeoutMs: 30_000,
} as const;

/** Payout for a merged change of `lines` changed lines (before caps and bonuses). */
export function payoutFor(lines: number): number {
  const e = ECONOMY;
  if (lines <= 0) return 0;
  const counted = Math.min(lines, e.lineCap);
  const tiny = lines >= e.tinyThreshold ? 1 : (lines / e.tinyThreshold) ** 2;
  return round2((e.basePayout + e.perLine * counted) * tiny);
}

export function hiringFeeFor(mode: OfficeMode): number {
  return mode === 'career' || ECONOMY.sandboxChargesHiringFee ? ECONOMY.hiringFee : 0;
}

export function startingCashFor(mode: OfficeMode): number {
  return mode === 'career' ? ECONOMY.startingCash : 0;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
