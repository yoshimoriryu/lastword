import {
  ATTACK_LAND_DELAY_MS,
  attackValue,
  BOT_NAMES,
  BOT_PRESETS,
  comboMult,
  COUNTDOWN_MS,
  MAX_PLAYERS,
  MAX_STACK,
  neutralIntervalMs,
  STACK_MIN,
  STREAK_GAP_MS,
  SURGE_MAX,
  SURGE_MIN_STREAK,
  surgeGain,
  TICK_MS,
} from "../shared/constants";
import { mulberry32 } from "../shared/rng";
import { WORDS } from "../shared/words";
import type {
  BotLevel,
  ClientMsg,
  EvKind,
  Phase,
  PlayerSnap,
  PlayerStats,
  Results,
  ServerMsg,
  StateSnap,
  WordItem,
} from "../shared/types";

export interface Client {
  send(data: string): void;
  close(): void;
}

interface Pending {
  landAt: number;
  from: string;
}

interface Player {
  id: string;
  name: string;
  client: Client;
  ready: boolean;
  connected: boolean;

  alive: boolean;
  placement: number | null;
  stack: WordItem[];
  typed: string;
  wordStart: number;
  pending: Pending[];
  /** index into the shared neutral word sequence */
  neutralIdx: number;

  streak: number;
  maxStreak: number;
  surge: number;
  lastClear: number;
  /** fractional attack carry — whole words send when this crosses 1 */
  attackAcc: number;

  /** when this player topped out — wpm is measured over time actually alive */
  diedAt: number | null;
  correctKeys: number;
  errorKeys: number;
  wordsCleared: number;
  attackSent: number;
  attackReceived: number;

  /** present when this player is server-driven */
  bot?: { label: string; wpm: number; err: number; nextKeyAt: number };
}

const NOOP_CLIENT: Client = { send: () => {}, close: () => {} };

let nextId = 1;

export class Game {
  private players = new Map<string, Player>();
  private phase: Phase = "lobby";
  private hostId = "";
  private startedAt = 0;
  private countdownEndsAt = 0;
  private neutralSeq: string[] = [];
  private nextNeutralAt = 0;
  private attackRng = mulberry32((Math.random() * 2 ** 31) | 0);
  private results: Results | null = null;
  private deaths = 0;

  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBroadcast = 0;
  private dirty = false;

  /** room option: stack size that kills — host-adjustable in lobby */
  private maxStack = MAX_STACK;

  private tickTimer: ReturnType<typeof setInterval>;

  constructor(private now: () => number = Date.now) {
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  /** stop timers so an empty room can be garbage-collected */
  dispose(): void {
    clearInterval(this.tickTimer);
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
  }

  get size(): number {
    return this.players.size;
  }

  info(code: string): { code: string; humans: number; bots: number; phase: Phase } {
    let humans = 0, bots = 0;
    for (const p of this.players.values()) p.bot ? bots++ : humans++;
    return { code, humans, bots, phase: this.phase };
  }

  // ---- connection lifecycle -------------------------------------------------

  join(client: Client, rawName: string): string | null {
    if (this.players.size >= MAX_PLAYERS) {
      client.send(JSON.stringify({ t: "err", msg: "room full (6 max)" } satisfies ServerMsg));
      return null;
    }
    if (this.phase === "playing" || this.phase === "countdown") {
      client.send(JSON.stringify({ t: "err", msg: "round in progress — wait for lobby" } satisfies ServerMsg));
      return null;
    }
    const id = `p${nextId++}`;
    let name = (rawName || "player").trim().slice(0, 12) || "player";
    while ([...this.players.values()].some((p) => p.name === name)) name += "_";
    const p: Player = {
      id, name, client,
      ready: false, connected: true,
      alive: false, placement: null,
      stack: [], typed: "", wordStart: 0, pending: [], neutralIdx: 0,
      streak: 0, maxStreak: 0, surge: 0, lastClear: 0, attackAcc: 0, diedAt: null,
      correctKeys: 0, errorKeys: 0, wordsCleared: 0, attackSent: 0, attackReceived: 0,
    };
    this.players.set(id, p);
    if (!this.hostId) this.hostId = id;
    this.markDirty();
    return id;
  }

  leave(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase === "playing" && p.alive) {
      p.connected = false;
      this.die(p, this.now());
      this.checkRoundEnd();
    } else {
      this.players.delete(id);
    }
    // no humans left → clear the room (bots can't host a party)
    if (![...this.players.values()].some((q) => q.connected && !q.bot)) {
      this.players.clear();
      this.hostId = "";
      this.resetToLobby();
      return;
    }
    // host must always be a human who can still press buttons
    if (this.hostId === id || !this.players.get(this.hostId)?.connected) {
      this.hostId = [...this.players.values()].find((q) => q.connected && !q.bot)?.id ?? "";
    }
    this.markDirty();
  }

  handle(id: string, msg: ClientMsg): void {
    const p = this.players.get(id);
    if (!p) return;
    switch (msg.t) {
      case "ready":
        if (this.phase === "lobby") { p.ready = !!msg.ready; this.markDirty(); }
        break;
      case "start":
        this.tryStart(id);
        break;
      case "key":
        this.onKey(p, msg.k);
        break;
      case "toLobby":
        if (this.phase === "over" && id === this.hostId) this.resetToLobby();
        break;
      case "addBot":
        this.addBot(id, msg.level, msg.wpm);
        break;
      case "removeBot":
        this.removeBot(id, msg.id);
        break;
      case "setOpt":
        if (this.phase === "lobby" && id === this.hostId && Number.isFinite(msg.maxStack)) {
          this.maxStack = Math.min(30, Math.max(6, Math.round(msg.maxStack)));
          this.markDirty();
        }
        break;
    }
  }

  // ---- bots -----------------------------------------------------------------

  private addBot(requesterId: string, level: BotLevel | "custom", customWpm?: number): void {
    if (this.phase !== "lobby" || requesterId !== this.hostId) return;
    if (this.players.size >= MAX_PLAYERS) return;
    let preset: { wpm: number; err: number };
    let label: string;
    if (level === "custom") {
      if (!Number.isFinite(customWpm)) return;
      const wpm = Math.min(300, Math.max(10, Math.round(customWpm!)));
      // error rate fitted to the preset curve: slower bots fumble more
      const err = Math.min(0.08, Math.max(0.01, 0.07 - 0.0006 * wpm));
      preset = { wpm, err };
      label = `${wpm}wpm`;
    } else {
      if (!BOT_PRESETS[level]) return;
      preset = BOT_PRESETS[level];
      label = level;
    }
    const id = `p${nextId++}`;
    let name = BOT_NAMES[(nextId + this.players.size) % BOT_NAMES.length];
    while ([...this.players.values()].some((p) => p.name === name)) name += "_";
    this.players.set(id, {
      id, name, client: NOOP_CLIENT,
      ready: true, connected: true,
      alive: false, placement: null,
      stack: [], typed: "", wordStart: 0, pending: [], neutralIdx: 0,
      streak: 0, maxStreak: 0, surge: 0, lastClear: 0, attackAcc: 0, diedAt: null,
      correctKeys: 0, errorKeys: 0, wordsCleared: 0, attackSent: 0, attackReceived: 0,
      bot: { label, wpm: preset.wpm, err: preset.err, nextKeyAt: 0 },
    });
    this.markDirty();
  }

  private removeBot(requesterId: string, botId: string): void {
    if (this.phase !== "lobby" || requesterId !== this.hostId) return;
    const p = this.players.get(botId);
    if (!p?.bot) return;
    this.players.delete(botId);
    this.markDirty();
  }

  /** keystrokes through the same input path as humans; catch-up loop keeps
   *  the average rate at the preset wpm despite the coarse tick */
  private driveBot(p: Player, now: number): void {
    const b = p.bot!;
    for (let burst = 0; burst < 4 && now >= b.nextKeyAt; burst++) {
      const word = p.stack[0];
      if (!word) return;
      let k: string;
      const beforeTyped = p.typed;
      if (!word.text.startsWith(p.typed)) {
        k = "Backspace";
      } else if (p.typed === word.text) {
        k = " "; // commit
      } else {
        const next = word.text[p.typed.length];
        k = Math.random() < b.err
          ? String.fromCharCode(97 + Math.floor(Math.random() * 26))
          : next;
      }
      this.onKey(p, k);
      const msPerChar = 60000 / (b.wpm * 5);
      // mean ~0.75: budgets for the word pauses below so measured wpm ≈ preset
      let delay = msPerChar * (0.45 + Math.random() * 0.6);
      if (k !== "Backspace" && beforeTyped.length > 0 && p.typed === "") {
        delay += 100 + Math.random() * 250; // finished a word — brief "thinking" pause
      }
      // accumulate from the schedule, not from `now` — otherwise every key
      // rounds up to the next 50ms tick and the bot runs ~20% slow
      b.nextKeyAt = Math.max(b.nextKeyAt + delay, now - 200);
    }
  }

  // ---- round flow -----------------------------------------------------------

  private tryStart(id: string): void {
    if (this.phase !== "lobby" || id !== this.hostId) return;
    const ps = [...this.players.values()];
    if (ps.length < 1) return;
    if (!ps.every((p) => p.ready)) return;
    this.phase = "countdown";
    this.countdownEndsAt = this.now() + COUNTDOWN_MS;
    // zero the word counters now, not at go — countdown snapshots otherwise
    // carry last round's counts and poison client-side prediction anchors
    for (const p of ps) p.wordsCleared = 0;
    this.markDirty();
  }

  private beginRound(): void {
    const now = this.now();
    const seed = (Math.random() * 2 ** 31) | 0;
    const rng = mulberry32(seed);
    this.neutralSeq = Array.from({ length: 2000 }, () => WORDS[Math.floor(rng() * WORDS.length)]);
    this.attackRng = mulberry32(seed ^ 0x9e3779b9);
    this.phase = "playing";
    this.startedAt = now;
    this.nextNeutralAt = now + neutralIntervalMs(0);
    this.results = null;
    this.deaths = 0;
    for (const p of this.players.values()) {
      p.alive = true;
      p.placement = null;
      p.stack = this.neutralSeq.slice(0, STACK_MIN).map((text) => ({ text, attack: false }));
      p.neutralIdx = STACK_MIN;
      p.typed = "";
      p.wordStart = now;
      p.pending = [];
      p.streak = 0;
      p.maxStreak = 0;
      p.surge = 0;
      p.lastClear = now;
      p.attackAcc = 0;
      p.diedAt = null;
      p.correctKeys = 0;
      p.errorKeys = 0;
      p.wordsCleared = 0;
      p.attackSent = 0;
      p.attackReceived = 0;
      if (p.bot) p.bot.nextKeyAt = now + 400 + Math.random() * 800; // human-ish reaction to "go"
    }
    this.emit({ t: "ev", kind: "go" });
    this.markDirty();
  }

  private resetToLobby(): void {
    this.phase = "lobby";
    this.results = null;
    for (const p of [...this.players.values()]) {
      if (!p.connected) { this.players.delete(p.id); continue; }
      p.ready = !!p.bot; // bots are always ready; humans re-ready each round
      p.alive = false;
      p.placement = null;
      p.stack = [];
      p.typed = "";
      p.pending = [];
    }
    if (!this.players.has(this.hostId)) this.hostId = this.players.keys().next().value ?? "";
    this.markDirty();
  }

  // ---- typing ---------------------------------------------------------------

  private onKey(p: Player, k: string): void {
    if (this.phase !== "playing" || !p.alive) return;
    const now = this.now();
    const word = p.stack[0];
    if (!word) return;

    if (k === "Backspace") {
      if (p.typed.length > 0) p.typed = p.typed.slice(0, -1);
      this.markDirty();
      return;
    }
    if (k === "ClearWord") {
      p.typed = "";
      this.markDirty();
      return;
    }
    if (k === "Enter") {
      // manual surge release: fire the banked burst at a moment of your
      // choosing — costs the streak, same as a break, but no accuracy hit
      if (p.surge > 0) {
        this.breakStreak(p, now, false);
        this.markDirty();
      }
      return;
    }
    if (k.length !== 1) return;

    // space commits the word (monkeytype muscle memory); early space = typo
    if (k === " ") {
      if (p.typed === word.text) {
        p.correctKeys++; // standard wpm counts the space
        this.clearWord(p, now);
      } else if (p.typed.length < word.text.length + 8) {
        p.typed += " ";
        p.errorKeys++;
        this.breakStreak(p, now, true);
      }
      this.markDirty();
      return;
    }

    // cap buffer so mashing can't grow unbounded
    if (p.typed.length >= word.text.length + 8) return;

    p.typed += k;
    if (word.text.startsWith(p.typed)) {
      p.correctKeys++;
    } else {
      p.errorKeys++;
      this.breakStreak(p, now, true);
    }
    this.markDirty();
  }

  /** next word from this player's cursor into the shared seeded sequence */
  private nextNeutral(p: Player): WordItem {
    const text = this.neutralSeq[p.neutralIdx++ % this.neutralSeq.length];
    return { text, attack: false };
  }

  /** stack floor: fast typists always have words to type (tetris piece queue) */
  private refill(p: Player): void {
    while (p.stack.length < STACK_MIN) p.stack.push(this.nextNeutral(p));
  }

  private clearWord(p: Player, now: number): void {
    const word = p.stack.shift()!;
    this.refill(p);
    const took = now - p.wordStart;
    p.typed = "";
    p.wordStart = now;
    p.wordsCleared++;

    // streak: continues if the gap since last clear was short enough
    p.streak = now - p.lastClear <= STREAK_GAP_MS ? p.streak + 1 : 1;
    p.maxStreak = Math.max(p.maxStreak, p.streak);
    p.lastClear = now;
    if (p.streak >= SURGE_MIN_STREAK) {
      p.surge = Math.min(SURGE_MAX, p.surge + surgeGain(p.streak));
    }

    p.attackAcc += attackValue(word.text.length, took) * comboMult(p.streak);
    const attack = Math.floor(p.attackAcc);
    if (attack > 0) {
      p.attackAcc -= attack;
      this.sendAttack(p, attack, now);
    }
    this.emit({ t: "ev", kind: "clear", p: p.id, n: attack });
  }

  private breakStreak(p: Player, now: number, byTypo: boolean): void {
    if (byTypo) this.emit({ t: "ev", kind: "error", p: p.id });
    if (p.surge > 0) {
      const burst = p.surge;
      p.surge = 0;
      this.sendAttack(p, burst, now);
      this.emit({ t: "ev", kind: "surge", p: p.id, n: burst });
    }
    p.streak = 0;
  }

  // ---- attacks --------------------------------------------------------------

  private sendAttack(p: Player, n: number, now: number): void {
    // counter first: cancel own soonest-landing incoming words
    let cancelled = 0;
    while (n > 0 && p.pending.length > 0) {
      p.pending.sort((a, b) => a.landAt - b.landAt);
      p.pending.shift();
      n--;
      cancelled++;
    }
    if (cancelled > 0) this.emit({ t: "ev", kind: "counter", p: p.id, n: cancelled });
    if (n <= 0) return;

    const targets = [...this.players.values()].filter((q) => q.alive && q.id !== p.id);
    if (targets.length === 0) return;
    p.attackSent += n;
    const start = Math.floor(this.attackRng() * targets.length);
    for (let i = 0; i < n; i++) {
      const victim = targets[(start + i) % targets.length];
      victim.pending.push({ landAt: now + ATTACK_LAND_DELAY_MS, from: p.id });
    }
  }

  private landPending(p: Player, now: number): void {
    const due = p.pending.filter((a) => a.landAt <= now);
    if (due.length === 0) return;
    p.pending = p.pending.filter((a) => a.landAt > now);
    for (const _ of due) {
      const text = WORDS[Math.floor(this.attackRng() * WORDS.length)];
      p.stack.push({ text, attack: true });
      p.attackReceived++;
    }
    this.emit({ t: "ev", kind: "hit", p: p.id, n: due.length });
    if (p.stack.length > this.maxStack) this.die(p, now);
    this.markDirty();
  }

  private die(p: Player, now: number): void {
    if (!p.alive) return;
    p.alive = false;
    p.diedAt = now;
    this.deaths++;
    const alivePlayersBefore = [...this.players.values()].filter((q) => q.alive).length + 1;
    p.placement = alivePlayersBefore;
    p.surge = 0; // charge dies with you
    p.streak = 0;
    this.emit({ t: "ev", kind: "death", p: p.id, n: p.placement });
    this.markDirty();
  }

  // ---- tick -----------------------------------------------------------------

  private tick(): void {
    const now = this.now();

    if (this.phase === "countdown") {
      if (now >= this.countdownEndsAt) {
        this.beginRound();
      } else {
        this.markDirty(); // keep the countdown number ticking on clients
      }
      return;
    }
    if (this.phase !== "playing") {
      this.flushIfDirty(now);
      return;
    }

    const elapsedS = (now - this.startedAt) / 1000;

    // neutral stream: everyone draws the next word from the same shared
    // sequence at their own cursor — same order for all, own pace
    while (now >= this.nextNeutralAt) {
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        p.stack.push(this.nextNeutral(p));
        if (p.stack.length > this.maxStack) this.die(p, now);
      }
      this.nextNeutralAt += neutralIntervalMs(elapsedS);
      this.markDirty();
    }

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (p.bot) this.driveBot(p, now);
      this.landPending(p, now);
      // streak decay: too long since last clear
      if (p.streak > 0 && now - p.lastClear > STREAK_GAP_MS) {
        this.breakStreak(p, now, false);
        this.markDirty();
      }
    }

    this.checkRoundEnd();
    this.flushIfDirty(now);
  }

  private checkRoundEnd(): void {
    if (this.phase !== "playing") return;
    const alive = [...this.players.values()].filter((p) => p.alive);
    const total = this.players.size;
    const done = (total > 1 && alive.length <= 1) || (total === 1 && alive.length === 0);
    if (!done) return;
    const now = this.now();
    if (alive[0]) {
      alive[0].placement = 1;
      alive[0].alive = false;
    }
    this.phase = "over";
    this.results = this.buildResults(now);
    this.markDirty();
  }

  private buildResults(now: number): Results {
    const placements: PlayerStats[] = [...this.players.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        bot: p.bot?.label,
        placement: p.placement ?? 99,
        wpm: this.liveWpm(p, now),
        acc: p.correctKeys + p.errorKeys === 0 ? 100 : Math.round((100 * p.correctKeys) / (p.correctKeys + p.errorKeys)),
        words: p.wordsCleared,
        sent: p.attackSent,
        received: p.attackReceived,
        maxStreak: p.maxStreak,
      }))
      .sort((a, b) => a.placement - b.placement);
    return { placements };
  }

  // ---- snapshots ------------------------------------------------------------

  private snapshot(now: number): StateSnap {
    const players: PlayerSnap[] = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      connected: p.connected,
      alive: p.alive,
      placement: p.placement,
      stack: p.stack,
      typed: p.typed,
      streak: p.streak,
      surge: p.surge,
      pending: p.pending.map((a) => ({ inMs: Math.max(0, a.landAt - now) })),
      wpm: this.liveWpm(p, now),
      words: p.wordsCleared,
      bot: p.bot?.label,
      acc: p.correctKeys + p.errorKeys === 0 ? 100 : Math.round((100 * p.correctKeys) / (p.correctKeys + p.errorKeys)),
    }));
    return {
      phase: this.phase,
      hostId: this.hostId,
      maxStack: this.maxStack,
      players,
      elapsed: this.phase === "playing" || this.phase === "over" ? now - this.startedAt : 0,
      countdown: this.phase === "countdown" ? Math.max(0, this.countdownEndsAt - now) : undefined,
      results: this.results ?? undefined,
    };
  }

  private liveWpm(p: Player, now: number): number {
    if (this.phase !== "playing" && this.phase !== "over") return 0;
    // measure over time actually alive — otherwise dead players' wpm dilutes
    const end = p.diedAt ?? now;
    const minutes = Math.max((end - this.startedAt) / 60000, 1 / 60);
    return Math.round(p.correctKeys / 5 / minutes);
  }

  // ---- output ---------------------------------------------------------------

  private emit(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.connected) p.client.send(data);
    }
  }

  private markDirty(): void {
    this.dirty = true;
    const now = this.now();
    if (now - this.lastBroadcast >= 15) {
      this.flush(now);
    } else if (!this.broadcastTimer) {
      this.broadcastTimer = setTimeout(() => {
        this.broadcastTimer = null;
        this.flush(this.now());
      }, 15);
    }
  }

  private flushIfDirty(now: number): void {
    if (this.dirty) this.flush(now);
  }

  private flush(now: number): void {
    this.dirty = false;
    this.lastBroadcast = now;
    this.emit({ t: "state", s: this.snapshot(now) });
  }
}
