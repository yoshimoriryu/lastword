# Contributing to lastword

PRs and issues welcome — bug reports, balance feedback, features, word packs.

## Setup

```sh
git clone https://github.com/yoshimoriryu/lastword.git
cd lastword
npm install
npm start        # builds + serves at http://localhost:3000
```

## Before you PR

```sh
npm run typecheck   # strict tsc must pass
npm run test:bots   # headless bots play a full round — must PASS
```

- Fork → feature branch → PR against `main`.
- Keep game balance changes in `shared/constants.ts` and explain the reasoning
  in the PR description (ideally with a bot-test or playtest result).
- Protocol or rule changes must bump `PROTO_VERSION` in `shared/constants.ts`
  so stale browser clients get told to refresh.
- No new runtime dependencies without discussion — the whole game is
  TypeScript + `ws`, and we like it that way.

## Where things live

| Path | What |
|---|---|
| `shared/` | game math, protocol types, RNG, word list (both sides import this) |
| `server/` | authoritative game logic, rooms, bots, http/ws host |
| `client/` | DOM renderer, client-side prediction, no framework |
| `test/` | headless ws bot integration test |

## Ideas that would be welcome

- Targeting modes for FFA (attack weakest / attacker / manual)
- Word packs (languages, code keywords, quotes)
- Spectator mode, replays
- Balance tuning with data
