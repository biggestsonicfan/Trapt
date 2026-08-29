// Trapt live-state probe over PCSX2 PINE (port 28011).
// Usage:  node pine-probe.mjs [--watch] [--interval ms]
// Requires: PCSX2 running with EnablePINE=true and Trapt booted.

import { PineClient } from './hkmodd/PCSX2-MCP/pcsx2-mcp-server/dist/pine-client.js';

const WATCH = process.argv.includes('--watch');
const IVAL = Number((process.argv.find(a => a.startsWith('--interval=')) || '').split('=')[1]) || 1000;

// Addresses recovered from SLUS-21255 (gp = 0x0048A0F0).
const G_DEBUG_ROOM = 0x00482998; // gp-0x7758 ; -1 = off, else room id
const P_GAMESTATE  = 0x004828A8; // gp-0x7848 ; -> progress object
const P_SCENEMGR   = 0x00482A78; // gp-0x7678 ; -> scene manager
const OFF_CHAPTER  = 0x408;      // gameState + : s16
const OFF_SUB      = 0x40a;      // gameState + : s16
const OFF_ROOM     = 0x40c;      // gameState + : s16  <- the real room id
const OFF_SCENEROOM= 0x12c;      // sceneMgr  + : s16  <- what my first hook wrongly used

const PREFIX = 'hpcg?t';
const roomName = id =>
  (id < 0 || id > 0xff) ? '-' : `r${PREFIX[Math.floor(id / 20)] ?? '?'}${String(id % 20).padStart(2, '0')}`;
const isMainRoom = id => (id >= 1 && id <= 10) || (id >= 21 && id <= 26) || (id >= 41 && id <= 46);
const s16 = v => (v & 0x8000) ? v - 0x10000 : v;

async function sample(p) {
  const dbg = await p.read32(G_DEBUG_ROOM) | 0;
  const gs  = await p.read32(P_GAMESTATE);
  const sm  = await p.read32(P_SCENEMGR);

  let room = null, chapter = null, sub = null;
  if (gs >= 0x100000 && gs < 0x2000000) {
    room    = s16(await p.read16(gs + OFF_ROOM));
    chapter = s16(await p.read16(gs + OFF_CHAPTER));
    sub     = s16(await p.read16(gs + OFF_SUB));
  }
  let sceneRoom = null;
  if (sm >= 0x100000 && sm < 0x2000000) sceneRoom = s16(await p.read16(sm + OFF_SCENEROOM));

  return { dbg, gs, sm, room, chapter, sub, sceneRoom };
}

function render(s) {
  const dbgTxt = s.dbg === -1 || s.dbg === 0xffffffff
    ? 'OFF (-1)'
    : `${s.dbg} = ${roomName(s.dbg)}${isMainRoom(s.dbg) ? '  -> loads ' + roomName(s.dbg) + 'debug' : '  (not a main room, override inactive)'}`;
  return [
    `g_debugRoom @0048_2998 : ${dbgTxt}`,
    `gameState   @0048_28A8 : 0x${s.gs.toString(16).padStart(8, '0')}` +
      (s.room === null ? '  (null/invalid)' : `   room=${s.room} ${roomName(s.room)}  chapter=${s.chapter}  sub=${s.sub}`),
    `sceneMgr    @0048_2A78 : 0x${s.sm.toString(16).padStart(8, '0')}` +
      (s.sceneRoom === null ? '  (null/invalid)' : `   +0x12C=${s.sceneRoom}`),
  ].join('\n');
}

const p = new PineClient('127.0.0.1', 28011);
try {
  await p.connect();
} catch (e) {
  console.error(`Could not reach PINE on 127.0.0.1:28011 — ${e.message}`);
  console.error('Check: PCSX2 running, a game booted, and EnablePINE = true in inis/PCSX2.ini.');
  process.exit(1);
}

try {
  console.log(`connected: ${await p.getTitle()}  [${await p.getID()}]  status=${await p.getStatus()}\n`);
} catch (e) {
  console.error(`connected, but query failed (${e.message}) — is a game actually booted?`);
}

if (!WATCH) {
  console.log(render(await sample(p)));
  p.disconnect();
} else {
  console.log(`watching every ${IVAL}ms — Ctrl-C to stop\n`);
  let last = '';
  for (;;) {
    let out;
    try { out = render(await sample(p)); }
    catch (e) { out = `read failed: ${e.message}`; }
    if (out !== last) { console.log(`[${new Date().toISOString().slice(11, 19)}]\n${out}\n`); last = out; }
    await new Promise(r => setTimeout(r, IVAL));
  }
}
