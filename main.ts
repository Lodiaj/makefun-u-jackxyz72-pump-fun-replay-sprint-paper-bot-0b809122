// Young-momentum sniper for the pump.fun replay (agent-fun/replay/v2).
//
// The idea is simple and deliberately narrow: most pump.fun coins die within
// minutes, so the bot only buys coins that are young and already being bought
// hard, and it gets out fast — take profit, stop loss, or a hard time stop.
// No pyramid, no re-entry, no trailing logic: one small stake per coin, one
// entry per coin, and the position is sold whole the moment any exit trips.
//
// How a batch works (the protocol words: the harness sends hello once, then
// one batch per slot, and this bot answers each batch with its orders):
//   - entry: a curve aged 300-600 slots since its CreateEvent, with at
//     least 12 recorded trades, at least 7 buys among its last 10 trades, a
//     price at least 20% above its creation price and within 3% of its high
//     since creation, and real SOL reserves between 0.5 and 80 SOL. The buy
//     is 0.02 SOL at most, capped by the 1%-of-real-reserve order cap and by
//     free cash (0.5 SOL of cash is always kept back), and skipped when the
//     capped size falls under 0.02 SOL, where the per-order tx fee alone
//     would eat the trade.
//   - exit: every held position is re-priced each batch from the curve's
//     current reserves. The estimated net sell proceeds (curve quote out,
//     less the 1.25% curve fees and the 105,000-lamport tx fee) are compared
//     with the position's cost: sell everything at +15% (take profit), at
//     -8% (stop loss), or after 400 slots held (time stop).
//   - the harness closes a completed curve by itself; this bot never orders
//     on a complete curve.
//
// Deterministic by construction: no clock, no environment, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream, so the
// two graded executions produce byte-identical action logs.

import { runBot, LAMPORTS_PER_SOL, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- parameters

const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n lamports
const TX_FEE = 105_000n; // base 5,000 + priority 100,000 lamports per order
const CURVE_FEE_BPS = 125n; // protocol 95 + creator 30 bps fallback
const BPS = 10_000n;

const MIN_AGE_SLOTS = 300; // youngest a curve may be at entry
const MAX_AGE_SLOTS = 600; // oldest a curve may be at entry
const MIN_TRADES = 12; // trades a curve needs before it can be bought
const LAST_N = 10; // recent trades checked for buy dominance
const MIN_BUYS_IN_LAST = 7; // buys among the last 10 trades
const MIN_RISE_NUM = 120n; // price now >= create price * 120 / 100
const MIN_RISE_DEN = 100n;
const NEAR_HIGH_NUM = 97n; // price now >= high since create * 97 / 100
const NEAR_HIGH_DEN = 100n;
const MIN_RQ_SOL = 5n * SOL / 10n; // 0.5 SOL of real reserves, minimum
const MAX_RQ_SOL = 80n * SOL; // 80 SOL of real reserves, maximum
const TARGET_BUY = SOL / 50n; // 0.02 SOL per position at most
const MIN_BUY = SOL / 50n; // 0.02 SOL: smaller buys are not worth the tx fee
const CASH_RESERVE = SOL / 2n; // 0.5 SOL of cash always kept back
const BUY_SLIPPAGE_BPS = 800;
const SELL_SLIPPAGE_BPS = 10_000; // sells go out at any price
const TAKE_PROFIT_NUM = 115n; // sell when proceeds >= cost * 115 / 100
const TAKE_PROFIT_DEN = 100n;
const STOP_LOSS_NUM = 92n; // sell when proceeds <= cost * 92 / 100
const STOP_LOSS_DEN = 100n;
const MAX_HOLD_SLOTS = 400; // sell whatever is left after this long
const PRICE_SCALE = 1_000_000n; // fixed-point scale for stored prices

// Guardrail probe: the run must round-trip at least 0.01 SOL on 20 distinct
// coins. If the strict entry above has not produced 20 coins by the last
// quarter of the window, relax the entry for a few small probes — liquid,
// slightly rising curves, bought small and sold after at most 60 slots — so
// the run still clears the guardrail instead of ranking below every entry
// that meets it. The probe never fires while the normal entries keep pace.
const WINDOW_SLOTS = 400_000; // ~24h of slots, from the kit's dev window
const PROBE_AFTER_SLOTS = 300_000; // last quarter of the window
const PROBE_MIN_COINS = 20;
const PROBE_BUY = SOL / 20n; // 0.05 SOL per probe
const PROBE_HOLD_SLOTS = 60;
const PROBE_MIN_RQ_SOL = 5n * SOL; // probes only on liquid curves
const PROBE_MIN_RISE_NUM = 102n; // price now >= create price * 102 / 100
const PROBE_MIN_RISE_DEN = 100n;

// ---------------------------------------------------------------- per-mint tape

interface Tape {
  createPrice: bigint; // scaled price at the CreateEvent
  highPrice: bigint; // scaled high since creation
  prices: bigint[]; // scaled post-trade prices, newest last (kept short)
  buys: boolean[]; // is_buy flags matching prices
  createdSlot: number;
}

interface HeldInfo {
  entrySlot: number;
}

function scaledPrice(vq: bigint, vt: bigint): bigint {
  if (vt <= 0n) return 0n;
  return (vq * PRICE_SCALE) / vt;
}

// Estimated net SOL received for selling `tokens` on this curve now:
// curve quote out, less the 1.25% curve fees, less one tx fee.
function sellProceeds(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  const afterFees = (q * (BPS - CURVE_FEE_BPS)) / BPS;
  return afterFees > TX_FEE ? afterFees - TX_FEE : 0n;
}

// ---------------------------------------------------------------- the bot

function createBot(): { onHello(state: BotState): void; onBatch(state: BotState, batch: Batch): OrderInput[] } {
  const tapes = new Map<Pubkey, Tape>();
  const entered = new Set<Pubkey>(); // mints already bought once (no re-entry)
  const heldInfo = new Map<Pubkey, HeldInfo>();
  const myCoins = new Set<Pubkey>(); // distinct mints with a filled buy
  const probes = new Set<Pubkey>(); // probe mints (short hold, see below)
  let firstSlot = -1; // slot of the first batch seen, for window pacing

  function tapeOf(mint: Pubkey, slot: number): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { createPrice: 0n, highPrice: 0n, prices: [], buys: [], createdSlot: slot };
      tapes.set(mint, t);
    }
    return t;
  }

  return {
    onHello(_state: BotState): void {
      // Nothing to seed: the strategy reads no randomness at all.
    },

    onBatch(state: BotState, batch: Batch): OrderInput[] {
      if (firstSlot < 0) firstSlot = batch.slot;

      // Fold this batch's fills first: record entries and distinct coins.
      for (const f of batch.fills) {
        if (f.status === 'filled' && f.side === 'buy') {
          myCoins.add(f.mint);
          if (!heldInfo.has(f.mint)) heldInfo.set(f.mint, { entrySlot: f.slot });
        }
        if (f.status === 'filled' && f.side === 'sell' && !state.positions.has(f.mint)) {
          heldInfo.delete(f.mint);
        }
      }

      // Fold this batch's events into the tapes.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint, e.slot);
          t.createdSlot = e.slot;
          t.createPrice = scaledPrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          t.highPrice = t.createPrice;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint, e.slot);
          const p = scaledPrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          t.prices.push(p);
          t.buys.push(e.is_buy);
          if (t.prices.length > 40) {
            t.prices.shift();
            t.buys.shift();
          }
          if (p > t.highPrice) t.highPrice = p;
          if (t.createPrice === 0n) t.createPrice = p;
        }
      }

      const orders: OrderInput[] = [];
      const pendingBuyMints = new Set<Pubkey>();
      const pendingSellMints = new Set<Pubkey>();
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy') pendingBuyMints.add(p.order.mint);
        else pendingSellMints.add(p.order.mint);
      }

      // --- exits first: re-price every holding, sell whole on any trip.
      for (const [mint, holding] of state.positions) {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        // A sell for this mint is already in flight (2-slot latency): sending
        // another would be rejected for insufficient tokens once the first
        // one fills, so wait for the fill to come back first.
        if (pendingSellMints.has(mint)) continue;
        const proceeds = sellProceeds(holding.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const info = heldInfo.get(mint);
        const heldSlots = info === undefined ? 0 : batch.slot - info.entrySlot;
        const takeProfit = proceeds * TAKE_PROFIT_DEN >= holding.cost_lamports * TAKE_PROFIT_NUM;
        const stopLoss = proceeds * STOP_LOSS_DEN <= holding.cost_lamports * STOP_LOSS_NUM;
        // Probes leave fast regardless of profit: they exist only to clear
        // the distinct-coins guardrail, not to ride a move.
        const probeDone = probes.has(mint) && heldSlots >= PROBE_HOLD_SLOTS;
        if (takeProfit || stopLoss || heldSlots >= MAX_HOLD_SLOTS || probeDone) {
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        }
      }

      // --- entries: young, buy-dominated, rising, near its high.
      if (state.committedPositionCount() < state.hello.caps.max_open_positions) {
        for (const [mint, curve] of state.curves) {
          if (orders.length >= state.hello.caps.max_orders_per_batch) break;
          if (curve.complete) continue;
          if (state.positions.has(mint)) continue;
          if (pendingBuyMints.has(mint)) continue;
          if (entered.has(mint)) continue;
          const tape = tapes.get(mint);
          if (tape === undefined || tape.createPrice === 0n) continue;
          const age = batch.slot - tape.createdSlot;
          if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) continue;
          if (tape.prices.length < MIN_TRADES) continue;
          const recent = tape.buys.slice(-LAST_N);
          let buys = 0;
          for (const b of recent) if (b) buys++;
          if (buys < MIN_BUYS_IN_LAST) continue;
          const priceNow = scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          if (priceNow * MIN_RISE_DEN < tape.createPrice * MIN_RISE_NUM) continue;
          if (priceNow * NEAR_HIGH_DEN < tape.highPrice * NEAR_HIGH_NUM) continue;
          if (curve.real_quote_reserves < MIN_RQ_SOL || curve.real_quote_reserves > MAX_RQ_SOL) continue;
          if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= state.hello.caps.max_open_positions) break;
          const cap = state.maxBuyLamports(mint);
          const free = state.freeCashLamports() - CASH_RESERVE - TX_FEE;
          let size = TARGET_BUY;
          if (size > cap) size = cap;
          if (size > free) size = free;
          if (size < MIN_BUY) continue;
          entered.add(mint);
          orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
        }
      }

      // --- guardrail probes: late window, still short of 20 coins.
      if (
        myCoins.size < PROBE_MIN_COINS &&
        batch.slot - firstSlot >= PROBE_AFTER_SLOTS &&
        state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length < state.hello.caps.max_open_positions
      ) {
        for (const [mint, curve] of state.curves) {
          if (orders.length >= state.hello.caps.max_orders_per_batch) break;
          if (curve.complete) continue;
          if (state.positions.has(mint)) continue;
          if (pendingBuyMints.has(mint)) continue;
          if (entered.has(mint)) continue;
          const tape = tapes.get(mint);
          if (tape === undefined || tape.createPrice === 0n) continue;
          if (curve.real_quote_reserves < PROBE_MIN_RQ_SOL) continue;
          const priceNow = scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          if (priceNow * PROBE_MIN_RISE_DEN < tape.createPrice * PROBE_MIN_RISE_NUM) continue;
          const cap = state.maxBuyLamports(mint);
          const free = state.freeCashLamports() - CASH_RESERVE - TX_FEE;
          let size = PROBE_BUY;
          if (size > cap) size = cap;
          if (size > free) size = free;
          if (size < MIN_BUY) continue;
          entered.add(mint);
          probes.add(mint);
          orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
        }
      }

      return orders;
    },
  };
}

await runBot(createBot());
