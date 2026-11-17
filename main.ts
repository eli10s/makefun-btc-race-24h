// Dip-buy mean-reversion bot for cbBTC on the bars-replay/v1 harness.
//
// Idea: on one-minute bars Bitcoin spends most of its time chopping around a
// slowly moving level, then snaps back after a short dip. The bot waits flat
// until the latest close sits at least DIP_BPS below its SMA_BARS-bar simple
// moving average, then buys with all of its cash. Once in, it sells the whole
// position when the close climbs TAKE_BPS above what it paid (cost basis,
// fees included) or drops STOP_BPS below it. Nothing else trades.
//
// Everything is causal: every decision uses only closes already seen, and
// every number is integer (bigint) math, so two runs on the same bars emit
// the same orders. No clock, no network, no files, no randomness.

import { BPS, runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Lookback of the moving average the dip is measured against, in bars. */
const SMA_BARS = 90;
/** Entry: close this far below the moving average, in basis points. */
const DIP_BPS = 80;
/** Exit with a win: close this far above the entry cost, in basis points. */
const TAKE_BPS = 150;
/** Exit with a loss: close this far below the entry cost, in basis points. */
const STOP_BPS = 250;
/** Slippage guard on every order: wide open, the harness still rejects absurd fills. */
const MAX_SLIPPAGE_BPS = 10_000;

/** The last SMA_BARS closes, as a ring: slot `head` is the oldest (next to be overwritten). */
const closes: bigint[] = new Array<bigint>(SMA_BARS).fill(0n);
let closesCount = 0;
let closesHead = 0;
/** Running sum of the closes currently held, so the average is O(1). */
let closesSum = 0n;

/** The average price paid for the held position (cost basis, fees included), or null when flat. */
function entryPrice(state: BarsState): bigint | null {
  const held = state.positions.get(SYMBOL);
  if (held === undefined || held.qty === 0n) return null;
  const meta = state.symbols.get(SYMBOL);
  if (meta === undefined) return null;
  // value = qty * price * 10^quote_scale / 10^(qty_scale + price_scale), so
  // price = cost * 10^(qty_scale + price_scale - quote_scale) / qty.
  const scale = BigInt(meta.qty_scale + meta.price_scale - state.hello.capital.quote_scale);
  return (held.cost * 10n ** scale) / held.qty;
}

await runBars({
  onBatch(state, _batch): OrderInput[] {
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];

    if (closesCount < SMA_BARS) {
      closes[closesHead] = close;
      closesSum += close;
      closesCount += 1;
    } else {
      closesSum += close - closes[closesHead]!;
      closes[closesHead] = close;
    }
    closesHead = (closesHead + 1) % SMA_BARS;

    const held = state.positions.get(SYMBOL);
    if (held !== undefined && held.qty > 0n) {
      const paid = entryPrice(state);
      if (paid !== null) {
        if (close * BPS >= paid * BigInt(10_000 + TAKE_BPS)) {
          return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
        if (close * BPS <= paid * BigInt(10_000 - STOP_BPS)) {
          return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }

    if (closesCount < SMA_BARS) return [];
    const average = closesSum / BigInt(SMA_BARS);
    if (close * BPS > average * BigInt(10_000 - DIP_BPS)) return [];

    const room = state.weightRoom(SYMBOL);
    const spend = state.cash < room ? state.cash : room;
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
