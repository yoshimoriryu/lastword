import {
  ATTACK_LAND_DELAY_MS,
  attackValue,
  BASELINE_MS_PER_CHAR,
  comboMult,
  MODES,
  NEUTRAL_MIN_INTERVAL_MS,
  NEUTRAL_START_INTERVAL_MS,
  neutralIntervalMs,
  PROTO_VERSION,
  STREAK_GAP_MS,
  SURGE_MAX,
  SURGE_MIN_STREAK,
} from "../shared/constants";
import type { ClientMsg, PlayerSnap, ServerMsg, StateSnap } from "../shared/types";

// ---- dom helpers ------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

const screens = {
  join: $("#screen-join"),
  lobby: $("#screen-lobby"),
  game: $("#screen-game"),
  results: $("#screen-results"),
};

function show(name: keyof typeof screens): void {
  for (const [k, el] of Object.entries(screens)) el.classList.toggle("hidden", k !== name);
}

// ---- sound (webaudio blips, no assets) --------------------------------------

let audio: AudioContext | null = null;
function ensureAudio(): void {
  if (!audio) audio = new AudioContext();
  if (audio.state === "suspended") void audio.resume();
}

function tone(freq: number, dur: number, type: OscillatorType = "sine", gain = 0.08, slideTo?: number): void {
  if (!audio) return;
  const t = audio.currentTime;
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(audio.destination);
  o.start(t);
  o.stop(t + dur);
}

const sfx = {
  key: () => tone(2200, 0.03, "square", 0.02),
  clear: () => { tone(880, 0.08, "sine", 0.07); tone(1320, 0.12, "sine", 0.05); },
  error: () => tone(140, 0.15, "sawtooth", 0.08),
  surge: () => tone(300, 0.35, "sawtooth", 0.09, 1200),
  hit: () => tone(180, 0.2, "square", 0.09, 90),
  counter: () => tone(1500, 0.1, "triangle", 0.06, 2400),
  death: () => tone(400, 0.8, "sawtooth", 0.1, 60),
  go: () => { tone(660, 0.1, "sine", 0.08); setTimeout(() => tone(990, 0.2, "sine", 0.08), 110); },
};

// ---- connection -------------------------------------------------------------

const ws = new WebSocket(`ws://${location.host}`);
let myId = "";
let lastState: StateSnap | null = null;
let roomMax = 16; // room life option, synced from every snapshot
let roomMode: keyof typeof MODES = "surge"; // room mode, synced from every snapshot

// Local prediction of own typing. Rendering only after the server echo makes
// fast typing feel laggy, so we simulate our own keystrokes instantly; the
// server stays authoritative and we re-anchor on its cleared-words count.
const pred = { clearedTotal: 0, typed: "" };

const desync = { words: -1, stuck: 0 };

// committed words stay visible (dimmed) so the paragraph never reflows
// per-word; whole lines scroll off instead (monkeytype-style line jump)
const doneTail: string[] = [];

function predictedView(me: PlayerSnap): { stack: PlayerSnap["stack"]; typed: string } {
  if (me.words > pred.clearedTotal) {
    // server got ahead of the prediction — snap to truth
    pred.clearedTotal = me.words;
    pred.typed = me.typed;
    doneTail.length = 0;
  }
  let lag = Math.min(pred.clearedTotal - me.words, me.stack.length);
  // self-heal: legit in-flight lag resolves within a few snapshots; if the
  // server stays behind the prediction, we mispredicted — snap to truth
  if (lag > 0 && me.words === desync.words) {
    if (++desync.stuck > 30) {
      pred.clearedTotal = me.words;
      pred.typed = me.typed;
      desync.stuck = 0;
      lag = 0;
      doneTail.length = 0;
    }
  } else {
    desync.words = me.words;
    desync.stuck = 0;
  }
  return { stack: me.stack.slice(lag), typed: pred.typed };
}

function send(msg: ClientMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

ws.onmessage = (e) => {
  const msg: ServerMsg = JSON.parse(e.data);
  switch (msg.t) {
    case "welcome":
      if (msg.v !== PROTO_VERSION) {
        show("join");
        $("#join-err").textContent =
          "game was updated — hard refresh this page (Cmd/Ctrl+Shift+R)";
        ws.close();
        return;
      }
      myId = msg.id;
      $("#lobby-room").textContent = msg.room;
      $("#lobby-addr").textContent = msg.addrs.join("  ·  ");
      show("lobby");
      break;
    case "rooms":
      renderRoomList(msg.rooms);
      break;
    case "state":
      lastState = msg.s;
      render(msg.s);
      break;
    case "ev":
      onEvent(msg.kind, msg.p, msg.n);
      break;
    case "err":
      $("#join-err").textContent = msg.msg;
      break;
  }
};

ws.onclose = () => {
  $("#join-err").textContent = "disconnected from host";
  show("join");
};

// ---- join / lobby wiring -----------------------------------------------------

const nameInput = $<HTMLInputElement>("#name-input");
const roomInput = $<HTMLInputElement>("#room-input");
nameInput.focus();

function checkedName(): string | null {
  ensureAudio();
  const name = nameInput.value.trim();
  if (!name) { $("#join-err").textContent = "need a name"; return null; }
  $("#join-err").textContent = "";
  return name;
}

function doCreate(): void {
  const name = checkedName();
  if (name) send({ t: "create", name });
}

function doJoin(code?: string): void {
  const name = checkedName();
  if (!name) return;
  const room = (code ?? roomInput.value).trim().toUpperCase();
  if (!room) { $("#join-err").textContent = "need a room code — or create one"; return; }
  send({ t: "join", name, room });
}

$("#create-btn").onclick = doCreate;
$("#join-btn").onclick = () => doJoin();
nameInput.onkeydown = (e) => { if (e.key === "Enter") doCreate(); };
roomInput.onkeydown = (e) => { if (e.key === "Enter") doJoin(); };

function renderRoomList(rooms: { code: string; humans: number; bots: number; phase: string }[]): void {
  const ul = $("#room-list");
  ul.innerHTML = "";
  for (const r of rooms) {
    const li = document.createElement("li");
    li.className = "room-item";
    const busy = r.phase !== "lobby";
    li.innerHTML = `<span class="accent">${esc(r.code)}</span><span>${r.humans}p${r.bots ? ` + ${r.bots}🤖` : ""}</span><span class="${busy ? "notready" : "ready"}">${busy ? "in game" : "open"}</span>`;
    li.onclick = () => doJoin(r.code);
    ul.appendChild(li);
  }
}

let amReady = false;
$("#ready-btn").onclick = () => {
  ensureAudio();
  amReady = !amReady;
  send({ t: "ready", ready: amReady });
};
$("#start-btn").onclick = () => send({ t: "start" });
$("#rematch-btn").onclick = () => send({ t: "toLobby" });
document.querySelectorAll<HTMLButtonElement>(".bot-btn").forEach((b) => {
  b.onclick = () => send({ t: "addBot", level: b.dataset.level as never });
});
const botWpmInput = $<HTMLInputElement>("#bot-wpm");
botWpmInput.onkeydown = (e) => {
  if (e.key !== "Enter") return;
  const wpm = Number(botWpmInput.value);
  if (!wpm || wpm < 10 || wpm > 300) {
    botWpmInput.value = "";
    botWpmInput.placeholder = "10-300 ⏎";
    return;
  }
  send({ t: "addBot", level: "custom", wpm });
  botWpmInput.value = "";
  botWpmInput.placeholder = "type wpm ⏎";
};
const lifeSelect = $<HTMLSelectElement>("#opt-life");
lifeSelect.onchange = () => send({ t: "setOpt", maxStack: Number(lifeSelect.value) });
const modeSelect = $<HTMLSelectElement>("#opt-mode");
modeSelect.onchange = () => send({ t: "setOpt", mode: modeSelect.value });

// ---- help overlay -------------------------------------------------------------

const helpOverlay = $("#help-overlay");
const helpOpen = (): boolean => !helpOverlay.classList.contains("hidden");
document.querySelectorAll<HTMLButtonElement>(".help-open").forEach((b) => {
  b.onclick = () => helpOverlay.classList.toggle("hidden");
});
$("#help-close").onclick = () => helpOverlay.classList.add("hidden");
helpOverlay.onclick = (e) => { if (e.target === helpOverlay) helpOverlay.classList.add("hidden"); };

/** the tables in the help text are computed from the live game constants */
function buildHelp(): void {
  const atk = $("#atk-table tbody");
  for (const len of [3, 5, 7, 9, 12]) {
    const base = len * BASELINE_MS_PER_CHAR;
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${len} letters</td>` +
      [0.4, 0.8, 1.5].map((f) => `<td>${attackValue(len, base * f).toFixed(2)}</td>`).join("");
    atk.appendChild(tr);
  }
  const combo = $("#combo-table tbody");
  for (const streak of [0, 3, 5, 10]) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>x${streak}</td><td>×${comboMult(streak).toFixed(2)}${streak === 10 ? " (max)" : ""}</td>`;
    combo.appendChild(tr);
  }
  $("#help-gap").textContent = String(STREAK_GAP_MS / 1000);
  $("#help-surgemin").textContent = String(SURGE_MIN_STREAK);
  $("#help-surgemax").textContent = String(SURGE_MAX);
  $("#help-delay").textContent = String(ATTACK_LAND_DELAY_MS / 1000);
}
buildHelp();

// ---- typing input -----------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if (helpOpen()) {
    if (e.key === "Escape") helpOverlay.classList.add("hidden");
    return; // reading the manual pauses your fingers, not the game
  }
  if (e.key === "Escape" && (lastState?.phase === "playing" || lastState?.phase === "countdown")) {
    e.preventDefault();
    send({ t: "abort" }); // server allows only when no other humans in room
    return;
  }
  if (!lastState || lastState.phase !== "playing") return;
  if (document.activeElement === nameInput) return;
  if ((e.metaKey || e.ctrlKey || e.altKey) && e.key !== "Backspace") return;
  const me = lastState.players.find((p) => p.id === myId);
  if (!me || !me.alive) return;

  if (e.key === "Backspace") {
    e.preventDefault();
    if (e.metaKey || e.ctrlKey || e.altKey) {
      // cmd/ctrl/alt+backspace wipes the whole word buffer (monkeytype habit)
      pred.typed = "";
      send({ t: "key", k: "ClearWord" });
    } else {
      pred.typed = pred.typed.slice(0, -1);
      send({ t: "key", k: "Backspace" });
    }
    repaintOwn(me);
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (MODES[roomMode].manualFire) {
      send({ t: "key", k: "Enter" }); // manual surge fire — server checks charge
    }
    return;
  }
  if (e.key === " ") {
    // space commits the finished word; early space = typo (mirrors server)
    e.preventDefault();
    ensureAudio();
    const view = predictedView(me);
    const word = view.stack[0];
    if (!word) return;
    if (pred.typed === word.text) {
      pred.clearedTotal++;
      pred.typed = "";
      doneTail.push(word.text);
      sfx.clear();
      flash("#combo");
    } else if (pred.typed.length < word.text.length + 8) {
      pred.typed += " ";
      sfx.key();
    }
    send({ t: "key", k: " " });
    repaintOwn(me);
    return;
  }
  if (e.key.length === 1) {
    e.preventDefault();
    ensureAudio();
    sfx.key();
    // predict locally, mirroring server rules exactly
    const view = predictedView(me);
    const word = view.stack[0];
    if (word && pred.typed.length < word.text.length + 8) {
      pred.typed += e.key;
    }
    send({ t: "key", k: e.key });
    repaintOwn(me);
  }
});

function repaintOwn(me: PlayerSnap): void {
  if (lastState?.phase === "playing") renderOwnBoard(me);
}

// ---- events -----------------------------------------------------------------

function onEvent(kind: string, p?: string, n?: number): void {
  const mine = p === myId;
  switch (kind) {
    case "go": sfx.go(); break;
    case "clear": break; // own clears are predicted locally (sfx there); opponents stay silent
    case "error": if (mine) sfx.error(); break;
    case "surge": if (mine || isOpponentVisible(p)) sfx.surge(); break;
    case "counter": if (mine) sfx.counter(); break;
    case "hit":
      if (mine) {
        sfx.hit();
        document.body.classList.add("hitflash");
        setTimeout(() => document.body.classList.remove("hitflash"), 180);
      }
      break;
    case "death": sfx.death(); break;
  }
}

function isOpponentVisible(p?: string): boolean {
  return !!p && lastState?.phase === "playing";
}

function flash(sel: string): void {
  const el = $(sel);
  el.classList.remove("flash");
  void el.offsetWidth; // restart animation
  el.classList.add("flash");
}

// ---- render -----------------------------------------------------------------

let prevPhase = "";

function render(s: StateSnap): void {
  roomMax = s.maxStack || 16;
  roomMode = (s.mode in MODES ? s.mode : "surge") as keyof typeof MODES;
  document.body.classList.toggle("no-surge", !MODES[roomMode].surge);
  document.body.classList.toggle("no-manual", !MODES[roomMode].manualFire);
  const me = s.players.find((p) => p.id === myId);

  // reset prediction outside rounds AND on the transition into one — rendering
  // during countdown can re-inflate it from stale snapshots otherwise
  if (s.phase !== "playing" || prevPhase !== "playing") {
    pred.clearedTotal = 0;
    pred.typed = "";
    desync.words = -1;
    desync.stuck = 0;
    doneTail.length = 0;
  }

  if (s.phase === "lobby") {
    if (prevPhase !== "lobby") amReady = false;
    show("lobby");
    renderLobby(s);
  } else if (s.phase === "countdown" || s.phase === "playing") {
    show("game");
    renderGame(s, me);
  } else if (s.phase === "over") {
    show("results");
    renderResults(s);
  }
  prevPhase = s.phase;
}

function renderLobby(s: StateSnap): void {
  const isHost = myId === s.hostId;
  const ul = $("#lobby-players");
  ul.innerHTML = "";
  for (const p of s.players) {
    const li = document.createElement("li");
    const who = p.id === myId ? `${p.name} (you)` : p.name;
    const host = p.id === s.hostId ? " ★" : "";
    if (p.bot) {
      li.innerHTML = `<span>🤖 ${esc(p.name)}<span class="bot-tag">${p.bot}</span></span><span class="ready">ready</span>`;
      if (isHost) {
        const kick = document.createElement("button");
        kick.className = "kick-btn";
        kick.textContent = "✕";
        kick.onclick = () => send({ t: "removeBot", id: p.id });
        li.appendChild(kick);
      }
    } else {
      li.innerHTML = `<span>${esc(who)}${host}</span><span class="${p.ready ? "ready" : "notready"}">${p.ready ? "ready" : "not ready"}</span>`;
    }
    ul.appendChild(li);
  }
  const allReady = s.players.length >= 1 && s.players.every((p) => p.ready);
  const startBtn = $<HTMLButtonElement>("#start-btn");
  startBtn.classList.toggle("hidden", !isHost);
  startBtn.disabled = !allReady;
  $("#bot-row").classList.toggle("hidden", !isHost);
  lifeSelect.classList.toggle("hidden", !isHost);
  const lifeView = $("#opt-life-view");
  lifeView.classList.toggle("hidden", isHost);
  lifeView.textContent = `${s.maxStack} words`;
  if (isHost && document.activeElement !== lifeSelect && lifeSelect.value !== String(s.maxStack)) {
    lifeSelect.value = String(s.maxStack);
  }
  modeSelect.classList.toggle("hidden", !isHost);
  const modeView = $("#opt-mode-view");
  modeView.classList.toggle("hidden", isHost);
  modeView.textContent = s.mode;
  if (isHost && document.activeElement !== modeSelect && modeSelect.value !== s.mode) {
    modeSelect.value = s.mode;
  }
  const readyBtn = $("#ready-btn");
  readyBtn.textContent = amReady ? "unready" : "ready";
  readyBtn.classList.toggle("off", amReady);
  $("#lobby-hint").textContent = isHost
    ? allReady ? "all ready — hit start" : "start unlocks when everyone is ready"
    : "waiting for host to start";
}

function renderGame(s: StateSnap, me?: PlayerSnap): void {
  // countdown overlay
  const cd = $("#countdown-overlay");
  if (s.phase === "countdown") {
    cd.classList.remove("hidden");
    $("#countdown-num").textContent = String(Math.ceil((s.countdown ?? 0) / 1000));
  } else {
    cd.classList.add("hidden");
  }

  // hud
  const sec = Math.floor(s.elapsed / 1000);
  $("#hud-time").textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  const iv = neutralIntervalMs(sec);
  const paceRatio = 1 - (iv - NEUTRAL_MIN_INTERVAL_MS) / (NEUTRAL_START_INTERVAL_MS - NEUTRAL_MIN_INTERVAL_MS);
  $("#hud-pace").textContent = `pace ${"▮".repeat(1 + Math.round(paceRatio * 7))}`;
  $("#hud-wpm").textContent = `${me?.wpm ?? 0} wpm · ${me?.acc ?? 100}%`;

  // own board
  if (me) renderOwnBoard(me);

  // dead overlay
  const dead = $("#dead-overlay");
  if (me && !me.alive && s.phase === "playing") {
    dead.classList.remove("hidden");
    $("#dead-place").textContent = me.placement ? `#${me.placement}` : "dead";
  } else {
    dead.classList.add("hidden");
  }

  // opponents
  renderOpponents(s);
}

function renderOwnBoard(me: PlayerSnap): void {
  const view = predictedView(me);

  // pending attack dots
  const pb = $("#pending-bar");
  pb.innerHTML = "";
  for (const a of me.pending) {
    const d = document.createElement("div");
    d.className = "pend" + (a.inMs < 700 ? " soon" : "");
    pb.appendChild(d);
  }

  // words as a flowing paragraph: dimmed committed words, then the active
  // word, then upcoming — positions stay fixed, whole lines scroll off
  const stackEl = $("#stack");
  stackEl.classList.toggle("danger", view.stack.length >= roomMax - 3);
  const build = () => {
    stackEl.innerHTML = "";
    for (const t of doneTail) {
      const el = document.createElement("span");
      el.className = "w done";
      el.textContent = t;
      stackEl.appendChild(el);
    }
    view.stack.forEach((w, i) => {
      const el = document.createElement("span");
      el.className = "w" + (w.attack ? " attack" : "");
      if (i === 0) {
        el.classList.add("active");
        if (view.typed === w.text) el.classList.add("ready"); // press space
        el.appendChild(renderActiveWord(w.text, view.typed));
      } else {
        el.textContent = w.text;
      }
      stackEl.appendChild(el);
    });
  };
  build();

  // line jump: once the active word passes line 2, drop the first line of
  // committed words in one go (everything before the active word is done)
  const lineH = parseFloat(getComputedStyle(stackEl).lineHeight) || 40;
  for (let guard = 0; guard < 6; guard++) {
    const act = stackEl.querySelector<HTMLElement>(".w.active");
    const first = stackEl.firstElementChild as HTMLElement | null;
    if (!act || !first || act.offsetTop - first.offsetTop < lineH * 2) break;
    let dropped = 0;
    for (const child of [...stackEl.children] as HTMLElement[]) {
      if (child.offsetTop - first.offsetTop >= lineH || !child.classList.contains("done")) break;
      dropped++;
    }
    if (dropped === 0) break;
    doneTail.splice(0, dropped);
    build();
  }

  // health = remaining capacity before top-out
  const hp = Math.max(0, roomMax - view.stack.length);
  const pct = (hp / roomMax) * 100;
  const hpFill = $("#hp-fill");
  hpFill.style.width = `${pct}%`;
  hpFill.classList.toggle("mid", pct <= 50 && pct > 25);
  hpFill.classList.toggle("low", pct <= 25);
  const num = $("#hp-num");
  num.textContent = `${hp}/${roomMax}`;
  num.classList.toggle("hot", pct <= 25);

  // combo + surge
  $("#combo").textContent = me.streak >= 2 ? `x${me.streak}` : "";
  const fill = $("#surge-fill");
  fill.style.width = `${Math.min(100, (me.surge / SURGE_MAX) * 100)}%`;
  $("#surge-num").textContent = me.surge > 0 ? (MODES[roomMode].manualFire ? `⚡${me.surge} ⏎` : `⚡${me.surge}`) : "";
}

function renderActiveWord(word: string, typed: string): DocumentFragment {
  // monkeytype-style: the word's own letters never move — a wrong keystroke
  // paints the EXPECTED letter red instead of printing what you typed
  const frag = document.createDocumentFragment();
  const span = (cls: string, text: string) => {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    frag.appendChild(s);
  };
  const judged = Math.min(typed.length, word.length);
  for (let i = 0; i < judged; i++) {
    span(typed[i] === word[i] ? "c-done" : "c-wrong", word[i]);
  }
  // overflow beyond the word appends dark-red (also monkeytype behavior) —
  // without it a fully-green word that won't commit would be baffling
  if (typed.length > word.length) span("c-extra", typed.slice(word.length));
  const caret = document.createElement("span");
  caret.className = "caret";
  frag.appendChild(caret);
  if (judged < word.length) span("c-left", word.slice(judged));
  return frag;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function renderOpponents(s: StateSnap): void {
  const box = $("#opponents");
  box.innerHTML = "";
  for (const p of s.players) {
    if (p.id === myId) continue;
    const div = document.createElement("div");
    div.className = "mini" + (p.alive ? "" : " dead");
    if (!p.alive) div.dataset.place = p.placement ? `#${p.placement}` : "dead";
    const fillPct = Math.max(0, ((roomMax - p.stack.length) / roomMax) * 100);
    const hot = fillPct <= 25;
    const word = p.stack[0];
    const okLen = word ? commonPrefix(word.text, p.typed) : 0;
    div.innerHTML = `
      <div class="mname"><span>${p.bot ? "🤖 " : ""}${esc(p.name)}</span><span class="mcombo">${p.streak >= 2 ? "x" + p.streak : ""}${p.surge > 0 ? " ⚡" + p.surge : ""}</span></div>
      <div class="mbar"><div class="mfill${hot ? " hot" : ""}" style="width:${fillPct}%"></div></div>
      <div class="mword">${word ? `<span class="done">${esc(word.text.slice(0, okLen))}</span>${esc(word.text.slice(okLen))}` : ""}</div>
    `;
    box.appendChild(div);
  }
}

function renderResults(s: StateSnap): void {
  const res = s.results;
  if (!res) return;
  const winner = res.placements.find((p) => p.placement === 1);
  $("#results-title").innerHTML = winner
    ? `<span class="accent">${esc(winner.name)}</span> wins`
    : "results";
  const tbody = $("#results-table tbody");
  tbody.innerHTML = "";
  for (const p of res.placements) {
    const tr = document.createElement("tr");
    if (p.placement === 1) tr.className = "first";
    tr.innerHTML = `<td>${p.placement}</td><td>${p.bot ? "🤖 " : ""}${esc(p.name)}${p.id === myId ? " (you)" : ""}</td><td>${p.wpm}</td><td>${p.acc}%</td><td>${p.words}</td><td>${p.sent}</td><td>${p.received}</td><td>x${p.maxStreak}</td>`;
    tbody.appendChild(tr);
  }
  const isHost = myId === s.hostId;
  $("#rematch-btn").classList.toggle("hidden", !isHost);
  $("#results-hint").textContent = isHost ? "" : "host can send everyone back to lobby";
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
