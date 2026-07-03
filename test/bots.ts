/**
 * Headless integration test: boots the real server, connects N ws bots at
 * different typing speeds, plays a full FFA round, asserts it finishes and
 * that faster bots place higher.
 *
 * Run: npm run test:bots
 */
import { spawn } from "node:child_process";
import path from "node:path";
import WebSocket from "ws";
import type { ServerMsg, StateSnap, ClientMsg } from "../shared/types";

const PORT = 3131;
const TIMEOUT_MS = 5 * 60 * 1000;

interface BotSpec { name: string; wpm: number; errorRate: number }
const BOTS: BotSpec[] = [
  { name: "fast", wpm: 90, errorRate: 0.02 },
  { name: "mid", wpm: 55, errorRate: 0.04 },
  { name: "slow", wpm: 30, errorRate: 0.06 },
];

function log(...a: unknown[]): void { console.log("[bots]", ...a); }

class Bot {
  ws: WebSocket;
  state: StateSnap | null = null;
  events: Record<string, number> = {};
  roomCode: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  // local echo of our own typing — snapshots lag one broadcast, so predicting
  // avoids re-sending duplicate chars (which read as typos)
  private curWord = "";
  private myTyped = "";
  private spaceSent = false;

  constructor(public spec: BotSpec, url: string, private onOver: (s: StateSnap) => void, room: string | null) {
    this.ws = new WebSocket(url);
    this.ws.on("open", () => {
      this.send(room ? { t: "join", name: spec.name, room } : { t: "create", name: spec.name });
    });
    this.ws.on("message", (raw) => {
      const msg: ServerMsg = JSON.parse(raw.toString());
      if (msg.t === "welcome") {
        this.roomCode = msg.room;
        this.send({ t: "ready", ready: true });
      } else if (msg.t === "state") {
        this.state = msg.s;
        if (msg.s.phase === "over") this.onOver(msg.s);
      } else if (msg.t === "ev") {
        this.events[msg.kind] = (this.events[msg.kind] ?? 0) + 1;
      }
    });
    const msPerChar = 60000 / (spec.wpm * 5);
    this.timer = setInterval(() => this.step(), msPerChar);
  }

  private send(m: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private step(): void {
    const s = this.state;
    if (!s || s.phase !== "playing") return;
    const me = s.players.find((p) => p.name === this.spec.name);
    if (!me || !me.alive) return;
    const word = me.stack[0];
    if (!word) return;
    if (word.text !== this.curWord) {
      this.curWord = word.text;
      this.myTyped = me.typed;
      this.spaceSent = false;
    } else if (me.typed === "" && this.myTyped.length >= this.curWord.length) {
      this.myTyped = ""; // same word text twice in a row — previous one cleared
      this.spaceSent = false;
    }
    if (!this.curWord.startsWith(this.myTyped)) {
      this.myTyped = this.myTyped.slice(0, -1);
      this.send({ t: "key", k: "Backspace" });
      return;
    }
    if (this.myTyped.length >= this.curWord.length) {
      // word fully typed: commit with space once, then wait for the next word
      if (!this.spaceSent) {
        this.spaceSent = true;
        this.send({ t: "key", k: " " });
      }
      return;
    }
    const next = this.curWord[this.myTyped.length];
    const k = Math.random() < this.spec.errorRate ? (next === "z" ? "q" : "z") : next;
    this.myTyped += k;
    this.send({ t: "key", k });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.ws.close();
  }
}

async function main(): Promise<void> {
  const serverPath = path.join(__dirname, "server.cjs");
  const proc = spawn("node", [serverPath], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  proc.stderr.on("data", (d) => process.stderr.write(`[server!] ${d}`));

  await new Promise((r) => setTimeout(r, 800));

  let finished: StateSnap | null = null;
  const bots: Bot[] = [];
  const onOver = (s: StateSnap) => { if (!finished) finished = s; };

  // first bot creates the room; the rest join its code
  bots.push(new Bot(BOTS[0], `ws://127.0.0.1:${PORT}`, onOver, null));
  const tRoom = Date.now();
  while (!bots[0].roomCode && Date.now() - tRoom < 5000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!bots[0].roomCode) { log("FAIL: no room code from server"); process.exit(1); }
  log(`room ${bots[0].roomCode}`);
  for (const spec of BOTS.slice(1)) {
    bots.push(new Bot(spec, `ws://127.0.0.1:${PORT}`, onOver, bots[0].roomCode));
    await new Promise((r) => setTimeout(r, 150));
  }

  // host (first bot) starts once everyone is ready — retry until the server
  // accepts (a one-shot start can race the other bots' ready messages)
  const starter = setInterval(() => {
    const phase = bots[0].state?.phase;
    if (phase === "lobby" || phase === undefined) {
      bots[0].ws.send(JSON.stringify({ t: "start" } satisfies ClientMsg));
    } else {
      clearInterval(starter);
      log("round started, playing…");
    }
  }, 500);

  const t0 = Date.now();
  let lastStatus = 0;
  while (!finished && Date.now() - t0 < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 500));
    if (Date.now() - lastStatus > 10000) {
      lastStatus = Date.now();
      const s = bots[0].state;
      if (s?.phase === "playing") {
        const rows = s.players.map((p) =>
          `${p.name}:${p.alive ? "alive" : "dead"} stack=${p.stack.length} words=${p.words} typed="${p.typed}" pend=${p.pending.length}`);
        log(`t=${Math.round(s.elapsed / 1000)}s | ${rows.join(" | ")}`);
      }
    }
  }

  for (const b of bots) b.stop();
  proc.kill();

  if (!finished) {
    log("FAIL: round did not finish within timeout");
    process.exit(1);
  }

  const s: StateSnap = finished;
  const res = s.results!;
  log(`round finished in ${Math.round(s.elapsed / 1000)}s`);
  for (const p of res.placements) {
    log(`  #${p.placement} ${p.name.padEnd(6)} wpm=${p.wpm} acc=${p.acc}% words=${p.words} sent=${p.sent} recv=${p.received} maxCombo=x${p.maxStreak}`);
  }
  const evTotals: Record<string, number> = {};
  for (const b of bots) for (const [k, v] of Object.entries(b.events)) evTotals[k] = Math.max(evTotals[k] ?? 0, v);
  log("events seen:", JSON.stringify(evTotals));

  const failures: string[] = [];
  if (res.placements.length !== BOTS.length) failures.push("wrong placement count");
  const fast = res.placements.find((p) => p.name === "fast")!;
  const slow = res.placements.find((p) => p.name === "slow")!;
  if (fast.placement > slow.placement) failures.push("fast bot placed below slow bot (balance suspect)");
  if (!evTotals["clear"]) failures.push("no clear events");
  if (!evTotals["hit"]) failures.push("no attacks landed");
  if (!evTotals["death"]) failures.push("no deaths");

  if (failures.length) {
    log("FAIL:", failures.join("; "));
    process.exit(1);
  }
  log("PASS");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
