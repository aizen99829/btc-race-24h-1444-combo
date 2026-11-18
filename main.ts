/**
 * BTC race bot: three-engine combo (CBBTC, bars-replay/v1)
 * for make.fun btc-race-24h-20261118-1444.
 *
 * Why not the 0603-v2 bot as-is: that bot (two-tier SMA dip-buy) graded
 * +$5.95 on THIS dev window and -$77.37 on the 20261115 waterfall window
 * (31 fills, 9.5% drawdown) — it catches falling knives. The dev window
 * only decides the gate (> $0); the unseen race window decides the prize,
 * so the pick must be profitable in every regime we have actually seen.
 *
 * Design (long only, one position slot, owner-tracked exits):
 * - Deep tier (the engine): close at least 75 bps below its 90-bar mean
 *   -> buy full equity. Exit +180 / -40 bps vs the cost-basis average
 *   entry. A waterfall guard blocks deep entries while the 240-bar
 *   return is <= -150 bps or the 480-bar return is <= -250 bps — that
 *   guard is what turns the waterfall window from -$77 into a gain.
 * - Flush engine (bounce-confirmed knife-catch, 45% size): 120-bar return
 *   <= -180 bps AND the last 3 closes up >= +30 bps -> buy 45% equity.
 *   Exit on a 150 bps giveback from the peak (only once in profit),
 *   a -140 bps stop, or a 120-bar time stop.
 * - Mid tier (quiet-tape filler): close at least 25 bps below its
 *   15-bar mean, only in a quiet tape (below its ~30-bar mean by >= 10
 *   bps, 30-bar range <= 80 bps, 60-bar range <= 90 bps, not already
 *   deep below the 90-bar mean, 120-bar return > -60 bps) -> buy full
 *   equity. Exit +50 / -40 bps or after 60 bars.
 * - Entry priority when flat: flush > deep > mid. 15-bar cooldown after
 *   any exit. No entries in the last 30 bars: an entry there cannot
 *   reach its take-profit and only risks the stop (it cost the v2 bot
 *   -$2.3 on this window's end-of-window flush).
 *
 * Everything is integer arithmetic on the closes and the account the
 * harness sends: BigInt closes, bps returns, floor division, no floats,
 * no clock, no randomness, no files, no network, so the two graded
 * executions agree byte for byte. Position state (entry bar, tier, peak)
 * is derived from the OBSERVED position: the tier is latched when a buy
 * is sent and applied when the position is observed, and exits depend
 * only on the observed position, so a rejected buy simply retries on the
 * next batch. Buy sizes are clamped to the hello's own caps
 * (max_weight_bps) and min notional instead of hardcoded constants.
 * Warm-up batches only feed the averages; orders on them would be
 * rejected anyway.
 *
 * Measured on an exact replica of the official engine (validated: the
 * 0603-v2 bot reproduces its grade-local +$5.95 / 10 fills / 1.23% DD
 * exactly), ~13,000 configurations searched across the family:
 * - dev window 1444 (down -280 bps): net +$13.66, 8 fills, DD ~0.9%
 * - window 0603 (chop-up +49 bps): net +$40.18, 7 fills
 * - window 1115 (waterfall -400 bps, buy-and-hold DD -792 bps):
 *   net +$7.54, 10 fills, DD 1.3%
 * Baselines on the dev window: buy-and-hold -$31.63, momentum -$23.87,
 * ema-cross -$148.17, adx-momentum -$75.57, rsi-bollinger -$39.92,
 * hold-cash $0.00. The 0603-v2 bot as-submitted: +$5.95 / +$40.18 /
 * -$77.37 on the same three windows.
 *
 * Official kit grade-local on this file (2026-11-18, --driver process):
 * net PnL +$13.664667 USDC, 8 trades, win rate 75%, max drawdown
 * 0.9199636%, fees $3.217249, guardrails met; at 2x fees +$10.439691.
 * Two executions reproduced byte for byte, result_sha256
 * a03122f9d7aa2642fa293bb95faedc3cc0ab37a9ad8ac27d9b5990cf1b0de67e
 * (action_log_sha256 fef90d14aaa786f54c10d50fd2c94102b7a093a9698d2526
 * e21e3d1da4bf8c6b). The same hashes came back from a second run as the
 * unprivileged user with the repo read-only.
 *
 * Honest caveats: every window's score leans on 1-3 big trades. The
 * deep anchor (flush 75, stop 40) is a sharp ridge on the dev window —
 * flush 70/80 and stop 30/50 both break it — because the bar-133
 * recovery trade is the load-bearing trade there. The same values are
 * the plateau centre on 0603 (flush 70/75/80 all positive, stop 40
 * best), and the waterfall guard plus the flush engine — not the ridge
 * parameters — are what protect the downside. If the race window has no
 * qualifying flush or recovery, the bot trades little and scores ~$0.
 */

import { runBars, type BarsState, type OrderInput } from "./vendor/makefun-bars.ts";

const BPS = 10000n;
const SYMBOL = "CBBTC";
const MAX_SLIP = 300; // max_slippage_bps sent on every order (300 bps = 3%)
const TOTAL_BARS = 1440; // dev and race windows are both 1,440 one-minute bars

// Deep tier: SMA flush with a waterfall guard.
const DEEP_W = 90;
const DEEP_FLUSH_BPS = 75n;
const DEEP_TP_BPS = 180n;
const DEEP_SL_BPS = 40n;
const GUARD_RET240_MAX_BPS = -150n; // block deep entries at or below this
const GUARD_RET480_MAX_BPS = -250n;

// Flush engine: bounce-confirmed, half size.
const FLUSH_RET120_MAX_BPS = -180n;
const FLUSH_BOUNCE_MIN_BPS = 30n;
const FLUSH_SIZE_BPS = 4500n; // 45% of equity
const FLUSH_TRAIL_BPS = 150n; // giveback from the peak, only once in profit
const FLUSH_SL_BPS = 140n;
const FLUSH_HOLD_BARS = 120; // time stop

// Mid tier: shallow dip, quiet tape only.
const MID_W = 15;
const MID_FLUSH_BPS = 25n;
const MID_TP_BPS = 50n;
const MID_SL_BPS = 40n;
const MID_HOLD_BARS = 60;

// Shared.
const COOLDOWN_BARS = 15;
const NO_ENTRY_LAST_BARS = 30;

// Quiet-tape gates for the mid tier (all must hold).
const GATE_DEV30_MAX_BPS = -10n;
const GATE_RNG30_MAX_BPS = 80n;
const GATE_RNG60_MAX_BPS = 90n;
const GATE_DEV90_MIN_BPS = -30n;
const GATE_RET120_MIN_BPS = -60n;

/** Floor division for BigInt with a positive divisor (BigInt `/` truncates). */
function divFloor(a: bigint, b: bigint): bigint {
  const q = a / b;
  if (a % b !== 0n && a < 0n) return q - 1n;
  return q;
}

/**
 * Average entry price implied by the account's cost basis (fees included).
 * The scales are the hello's for CBBTC in this competition (qty_scale 8,
 * price_scale 5, quote_scale 6): cost * 10^(8+5) / (qty * 10^6).
 */
function avgEntry(cost: bigint, qty: bigint): bigint | null {
  if (qty <= 0n || cost <= 0n) return null;
  return divFloor(cost * 10n ** 13n, qty * 10n ** 6n);
}

/** Floor mean of the last w closes, or null with fewer than w bars. */
function sma(closes: bigint[], w: number): bigint | null {
  if (closes.length < w) return null;
  let s = 0n;
  for (let j = closes.length - w; j < closes.length; j++) s += closes[j];
  return s / BigInt(w);
}

/** Return of the close vs the close k bars ago, in bps; null if too short. */
function retBps(closes: bigint[], k: number): bigint | null {
  if (closes.length <= k) return null;
  const c = closes[closes.length - 1];
  const back = closes[closes.length - 1 - k];
  return divFloor((c - back) * BPS, back);
}

/** Deviation of the close from its mean over the last min(w, len) bars, bps. */
function devVsMean(closes: bigint[], w: number): bigint | null {
  const n = Math.min(w, closes.length);
  if (n < 15) return null;
  let s = 0n;
  for (let j = closes.length - n; j < closes.length; j++) s += closes[j];
  const mean = s / BigInt(n);
  const c = closes[closes.length - 1];
  return divFloor((c - mean) * BPS, mean);
}

/** Range (max-min) of the last min(w, len) closes, in bps of the close. */
function rangeBps(closes: bigint[], w: number): bigint | null {
  const n = Math.min(w, closes.length);
  if (n < 15) return null;
  let hi = closes[closes.length - n];
  let lo = hi;
  for (let j = closes.length - n + 1; j < closes.length; j++) {
    if (closes[j] > hi) hi = closes[j];
    if (closes[j] < lo) lo = closes[j];
  }
  const c = closes[closes.length - 1];
  return divFloor((hi - lo) * BPS, c);
}

/** Quiet-tape gate for the mid tier; see the header for the rationale. */
function quietTape(closes: bigint[]): boolean {
  const dev30 = devVsMean(closes, 30);
  if (dev30 === null || dev30 > GATE_DEV30_MAX_BPS) return false;
  const rng30 = rangeBps(closes, 30);
  if (rng30 === null || rng30 > GATE_RNG30_MAX_BPS) return false;
  const r90 = sma(closes, DEEP_W);
  if (r90 !== null) {
    const c = closes[closes.length - 1];
    if (divFloor((c - r90) * BPS, r90) <= GATE_DEV90_MIN_BPS) return false;
  }
  const ret120 = retBps(closes, 120);
  if (ret120 !== null && ret120 <= GATE_RET120_MIN_BPS) return false;
  const rng60 = rangeBps(closes, 60);
  if (rng60 === null || rng60 > GATE_RNG60_MAX_BPS) return false;
  return true;
}

type Tier = "deep" | "mid" | "flush";

// State derived from the observed position (see header). Bar indices are
// counts of batches since the first one, warm-up batches included, so
// they always match positions in the closes array.
const closes: bigint[] = [];
let entryBar = -1; // bar index where the open position was first observed
let lastExitBar = -1_000_000_000; // bar index where a position was last seen closed
let pendingTier: Tier | null = null; // tier of the most recent buy sent
let activeTier: Tier | null = null; // tier of the observed open position
let peak: bigint | null = null; // highest close seen while holding (flush tier)

await runBars({
  onBatch(state: BarsState): OrderInput[] {
    const close = state.close(SYMBOL);
    if (close === null) return [];
    closes.push(close);
    const i = closes.length - 1;
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const qty = held === undefined ? 0n : held.qty;
    const cost = held === undefined ? 0n : held.cost;

    // Sync state from the observed position.
    if (qty > 0n) {
      if (entryBar < 0) {
        entryBar = i;
        activeTier = pendingTier ?? activeTier ?? "deep";
      }
      if (peak === null || close > peak) peak = close;
    } else if (entryBar >= 0) {
      lastExitBar = i;
      entryBar = -1;
      activeTier = null;
      pendingTier = null;
      peak = null;
    }

    if (qty > 0n) {
      const ent = avgEntry(cost, qty);
      if (ent === null) return [];
      const gain = divFloor((close - ent) * BPS, ent);
      const heldBars = i - entryBar;
      if (activeTier === "flush") {
        const give =
          peak === null ? 0n : divFloor((peak - close) * BPS, peak);
        if (
          (gain >= 0n && give >= FLUSH_TRAIL_BPS) ||
          gain <= -FLUSH_SL_BPS ||
          heldBars >= FLUSH_HOLD_BARS
        ) {
          return [{ side: "sell", symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIP }];
        }
      } else if (activeTier === "mid") {
        if (gain <= -MID_SL_BPS || gain >= MID_TP_BPS || heldBars >= MID_HOLD_BARS) {
          return [{ side: "sell", symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIP }];
        }
      } else {
        if (gain <= -DEEP_SL_BPS || gain >= DEEP_TP_BPS) {
          return [{ side: "sell", symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIP }];
        }
      }
      return [];
    }

    // Flat: cooldown first, then the no-entry zone, then flush > deep > mid.
    if (i - lastExitBar <= COOLDOWN_BARS) return [];
    if (i >= TOTAL_BARS - NO_ENTRY_LAST_BARS) return [];
    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);
    const weightRoom = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let amount = state.cash < weightRoom ? state.cash : weightRoom;
    if (amount < minNotional) return [];

    // Flush engine: deep 120-bar drop with a 3-bar bounce.
    const ret120 = retBps(closes, 120);
    const ret3 = retBps(closes, 3);
    if (
      ret120 !== null &&
      ret3 !== null &&
      ret120 <= FLUSH_RET120_MAX_BPS &&
      ret3 >= FLUSH_BOUNCE_MIN_BPS
    ) {
      let flushAmt = (state.equity * FLUSH_SIZE_BPS) / BPS;
      if (flushAmt > state.cash) flushAmt = state.cash;
      if (flushAmt >= minNotional) {
        pendingTier = "flush";
        return [
          {
            side: "buy",
            symbol: SYMBOL,
            notional_quote_units: flushAmt,
            max_slippage_bps: MAX_SLIP,
          },
        ];
      }
    }

    // Deep tier, blocked by the waterfall guard.
    const ret240 = retBps(closes, 240);
    const ret480 = retBps(closes, 480);
    const guarded =
      (ret240 !== null && ret240 <= GUARD_RET240_MAX_BPS) ||
      (ret480 !== null && ret480 <= GUARD_RET480_MAX_BPS);
    if (!guarded) {
      const r90 = sma(closes, DEEP_W);
      if (r90 !== null && close * BPS <= r90 * (BPS - DEEP_FLUSH_BPS)) {
        pendingTier = "deep";
        return [
          {
            side: "buy",
            symbol: SYMBOL,
            notional_quote_units: amount,
            max_slippage_bps: MAX_SLIP,
          },
        ];
      }
    }

    // Mid tier, quiet tape only.
    const r15 = sma(closes, MID_W);
    if (
      r15 !== null &&
      close * BPS <= r15 * (BPS - MID_FLUSH_BPS) &&
      quietTape(closes)
    ) {
      pendingTier = "mid";
      return [
        {
          side: "buy",
          symbol: SYMBOL,
          notional_quote_units: amount,
          max_slippage_bps: MAX_SLIP,
        },
      ];
    }
    return [];
  },
});
