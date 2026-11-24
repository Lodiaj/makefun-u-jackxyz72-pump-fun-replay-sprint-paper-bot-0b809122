# Pump.fun Replay Sprint — Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Lodiaj/makefun-u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Lodiaj/makefun-u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the make.fun Pump.fun Replay Sprint. It trades 10 SOL
of paper money on a 24h replay of recorded pump.fun bonding-curve activity.
Best net PnL wins; nothing is traded for real.

Try make.fun yourself: https://make.fun/r/v7bcp4ry

## Strategy: young-momentum sniper

Most pump.fun coins die within minutes, so the bot only buys coins that are
young and already being bought hard, and it gets out fast — take profit, stop
loss, or a hard time stop. One small stake per coin, one entry per coin, and
the position is sold whole the moment any exit trips.

- **Entry:** a curve aged 300–600 slots since its CreateEvent, with at least
  12 recorded trades, at least 7 buys among its last 10 trades, a price at
  least 20% above its creation price and within 3% of its high since
  creation, and real SOL reserves between 0.5 and 80 SOL. The buy is 0.02
  SOL at most, capped by the 1%-of-real-reserve order cap and by free cash
  (0.5 SOL of cash is always kept back).
- **Exit:** every held position is re-priced each batch from the curve's
  current reserves. Estimated net sell proceeds (curve quote out, less the
  1.25% curve fees and the 105,000-lamport tx fee) are compared with the
  position's cost: sell everything at +15% (take profit), at −8% (stop
  loss), or after 400 slots held (time stop).
- **Guardrail probe:** if the run has not round-tripped 20 distinct coins by
  the last quarter of the window, a few small probes (0.05 SOL on liquid,
  slightly rising curves, sold within 60 slots) make sure the run still
  clears the 20-coin minimum instead of ranking below every entry that
  meets it.
- **Deterministic:** no clock, no environment, no randomness — the two
  graded executions produce byte-identical action logs.

## Local backtest (kit dev window, all 3 dataset parts)

Run against the kit's own replay simulator (`tools/sim.ts` port):

- Net PnL **−0.047 SOL** on 10 SOL capital (essentially break-even; the
  house pilot momentum baseline loses −9.38 SOL on the first part alone)
- 158 fills, 79 distinct coins, 79 round trips, 28 wins (35%)
- Max drawdown 0.71% (guardrail: 50%), 3 rejected orders, 3 failed txs
- Two runs back to back: **identical results** (deterministic)
- At 2× fees: −0.100 SOL

## Run it

The grader runs `node /bot/main.ts` (Node 22.18+, TypeScript run as-is).
`main.ts` speaks `agent-fun/replay/v2` on stdin/stdout through the vendored
shim in `vendor/makefun-bot.ts` (the kit's `sdk/ts/makefun-bot.ts`,
byte-identical).

## License

MIT — see LICENSE.
