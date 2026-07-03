import http from "node:http";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { Game } from "./game";
import { MAX_ROOMS, PORT_DEFAULT, PROTO_VERSION } from "../shared/constants";
import type { ClientMsg, RoomInfo, ServerMsg } from "../shared/types";

const PORT = Number(process.env.PORT) || PORT_DEFAULT;
const CLIENT_DIR = path.join(__dirname, "..", "client");

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/bundle.js": { file: "bundle.js", type: "text/javascript; charset=utf-8" },
};

const server = http.createServer((req, res) => {
  const entry = STATIC[req.url ?? "/"];
  if (!entry) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  try {
    const body = readFileSync(path.join(CLIENT_DIR, entry.file));
    // never cache — stale clients desync against an updated server
    res.writeHead(200, { "content-type": entry.type, "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(500);
    res.end("missing build — run: npm run build");
  }
});

function lanAddrs(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === "IPv4" && !i.internal) out.push(`http://${i.address}:${PORT}`);
    }
  }
  return out.length ? out : [`http://localhost:${PORT}`];
}

// ---- rooms ------------------------------------------------------------------

const rooms = new Map<string, Game>();

// no I/O/0/1 — codes get read out loud across a room
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genCode(): string {
  let code = "";
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function roomList(): RoomInfo[] {
  return [...rooms.entries()].map(([code, g]) => g.info(code));
}

function dropIfEmpty(code: string): void {
  const g = rooms.get(code);
  if (g && g.size === 0) {
    g.dispose();
    rooms.delete(code);
  }
}

// ---- websocket --------------------------------------------------------------

const wss = new WebSocketServer({ server });
/** sockets on the join screen (not yet in a room) — they get room-list pushes */
const browsing = new Set<WebSocket>();

function pushRooms(): void {
  const data = JSON.stringify({ t: "rooms", rooms: roomList() } satisfies ServerMsg);
  for (const ws of browsing) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
setInterval(pushRooms, 2000);

wss.on("connection", (ws: WebSocket) => {
  let id: string | null = null;
  let roomCode: string | null = null;
  browsing.add(ws);

  const client = {
    send: (data: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); },
    close: () => ws.close(),
  };
  const err = (msg: string) => client.send(JSON.stringify({ t: "err", msg } satisfies ServerMsg));

  client.send(JSON.stringify({ t: "rooms", rooms: roomList() } satisfies ServerMsg));

  ws.on("message", (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.t === "create" || msg.t === "join") {
      if (id !== null) return;
      let code: string;
      if (msg.t === "create") {
        if (rooms.size >= MAX_ROOMS) { err("too many rooms"); return; }
        code = genCode();
        rooms.set(code, new Game());
      } else {
        code = (msg.room || "").trim().toUpperCase();
        if (!rooms.has(code)) { err(`room ${code || "?"} not found`); return; }
      }
      const game = rooms.get(code)!;
      id = game.join(client, msg.name);
      if (id) {
        roomCode = code;
        browsing.delete(ws);
        client.send(JSON.stringify({ t: "welcome", id, addrs: lanAddrs(), v: PROTO_VERSION, room: code } satisfies ServerMsg));
      } else if (msg.t === "create") {
        dropIfEmpty(code); // join into freshly created room failed — clean up
      }
      pushRooms();
      return;
    }

    if (id !== null && roomCode !== null) rooms.get(roomCode)?.handle(id, msg);
  });

  ws.on("close", () => {
    browsing.delete(ws);
    if (id !== null && roomCode !== null) {
      rooms.get(roomCode)?.leave(id);
      dropIfEmpty(roomCode);
      pushRooms();
    }
  });
  ws.on("error", () => {});
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("  LASTWORD — host running");
  console.log("  players join at:");
  for (const a of lanAddrs()) console.log(`    ${a}`);
  console.log("");
});
