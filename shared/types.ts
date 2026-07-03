export type Phase = "lobby" | "countdown" | "playing" | "over";

export type BotLevel = "easy" | "medium" | "hard" | "insane";

export interface WordItem {
  text: string;
  /** true = came from an opponent's attack (rendered red) */
  attack: boolean;
}

export interface PendingSnap {
  /** ms until this attack word lands on the stack */
  inMs: number;
}

export interface PlayerSnap {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  alive: boolean;
  /** 1 = winner; null while alive or in lobby */
  placement: number | null;
  /** index 0 = bottom = the active (typeable) word */
  stack: WordItem[];
  /** current input buffer for the bottom word */
  typed: string;
  streak: number;
  surge: number;
  pending: PendingSnap[];
  wpm: number;
  acc: number;
  /** words cleared this round — client prediction anchors on this */
  words: number;
  /** set when this player is a server-driven bot — level name or "<n>wpm" */
  bot?: string;
}

export interface PlayerStats {
  id: string;
  name: string;
  bot?: string;
  placement: number;
  wpm: number;
  acc: number;
  words: number;
  sent: number;
  received: number;
  maxStreak: number;
}

export interface Results {
  placements: PlayerStats[];
}

export interface StateSnap {
  phase: Phase;
  hostId: string;
  /** room option: stack size that kills (a.k.a. life) */
  maxStack: number;
  players: PlayerSnap[];
  /** ms since round start (playing/over) */
  elapsed: number;
  /** ms left in countdown */
  countdown?: number;
  results?: Results;
}

export interface RoomInfo {
  code: string;
  humans: number;
  bots: number;
  phase: Phase;
}

export type ClientMsg =
  | { t: "create"; name: string }
  | { t: "join"; name: string; room: string }
  | { t: "ready"; ready: boolean }
  | { t: "start" }
  | { t: "key"; k: string } // single printable char, "Backspace", or "ClearWord"
  | { t: "toLobby" }
  | { t: "addBot"; level: BotLevel | "custom"; wpm?: number } // host, lobby only
  | { t: "removeBot"; id: string } // host, lobby only
  | { t: "setOpt"; maxStack: number }; // host, lobby only

export type EvKind =
  | "clear" // p cleared a word (n = attack sent)
  | "error" // p typo'd (streak broke)
  | "surge" // p's surge fired (n = burst size)
  | "hit" // p received attack words (n = count landed)
  | "counter" // p cancelled n incoming words
  | "death" // p topped out (n = placement)
  | "go"; // round started

export type ServerMsg =
  | { t: "welcome"; id: string; addrs: string[]; v: number; room: string }
  | { t: "rooms"; rooms: RoomInfo[] }
  | { t: "state"; s: StateSnap }
  | { t: "ev"; kind: EvKind; p?: string; n?: number }
  | { t: "err"; msg: string };
