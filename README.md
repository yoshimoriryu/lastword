# lastword

LAN typing battle royale (2–6 players + bots). Type words to survive; type
fast and clean to attack. Last one standing gets the last word.

Inspired by [monkeytype](https://monkeytype.com)'s typing feel and
[TETR.IO](https://tetr.io)'s attack, garbage, and surge mechanics. Not
affiliated with either — go play both, they're great.

## Run

```sh
npm install
npm start
```

The host terminal prints a LAN URL like `http://192.168.1.23:3000`.
Friends on the same network open it in a browser, then **create a room** or
join one — by clicking it in the live room list or typing its 4-letter code.
Multiple rooms run independently on one server (up to 16). Everyone readies
up in the lobby; the room's host (★) starts the round.

**Single player / fill slots:** the host can add server-driven bots in the
lobby — presets (easy 25wpm · medium 45 · hard 70 · insane 95) or a custom
wpm of your choice. Bots use the exact same input path and rules as humans,
with human-like jitter, typos, and pauses.

**Room options:** host sets *life* (stack size that kills, 8–30).

## How it plays

- Words flow monkeytype-style as a paragraph from a shared seeded sequence —
  same word order for everyone, consumed at your own pace. The queue never
  drops below 5 words, so fast typists are never idle. The timed stream
  **speeds up over time** — the match must end.
- Type the first word, then press **space to commit** — the word turns green
  when ready. Typos must be fixed (backspace one letter, cmd/ctrl+backspace
  wipes the word); a premature space is itself a typo.
- **HP bar = free board space.** Board full = dead. Last one standing wins.
- **Attack**: committing long words fast charges attacks toward opponents
  (round-robin split). Incoming attacks telegraph for 2s on the red gauge —
  attack you send during that window **counters** them first.
- **Combo**: consecutive commits within 3s build a streak, multiplying your
  attack (caps at ×1.8). From streak 3+, the **⚡ surge meter** charges.
- **Surge**: when your streak breaks (typo or idle), the charge fires as one
  burst — or press **enter** to fire it manually at the perfect moment, at
  the cost of your streak.
- Full mechanics with live-computed numbers: the **?** button in game.

## Dev

```sh
npm run typecheck   # tsc, strict
npm run test:bots   # headless: 3 ws bots play a full round, asserts it ends sanely
```

Layout: `shared/` (game math, protocol types, RNG, word list — used by both
sides), `server/` (authoritative game logic, rooms, http/ws host), `client/`
(DOM renderer with client-side prediction, no framework), `test/` (bot
integration test).

Balance knobs all live in `shared/constants.ts`. Bump `PROTO_VERSION` there
whenever the protocol or game rules change — mismatched (cached) clients get
told to hard-refresh instead of desyncing.
