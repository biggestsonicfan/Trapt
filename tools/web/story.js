/**
 * The story order, read out of the ELF in the browser -- `tools/order.py`.
 *
 * Disc order is not story order.  Four tables decide it, and the page already
 * has the ELF open, so nothing extra is fetched:
 *
 *   0x0045DB50  38 cutscene groups, `{u8 count; u8 id[7]}` -- cutscenes never
 *               play alone, and ascending group id *is* story order
 *   0x0042DD20  per chapter `{u8 count; u8 stage[3]}`
 *   0x0042DD60  per chapter, the group that plays before it
 *   0x0042DD70  per chapter x stage, the (before, after) groups
 *   0x0042DDD0  the story flag a failed stage clears
 *   0x003872A0  15 x 2 routes into the 30 ending flow records at 0x003872C0
 *   0x0044D930  the chapter title cards, `DATA/TWO_D/SLD/SLD<nn>.ARC`
 *
 * See docs/CUTSCENES.md section 7.  The four branch rules are transcribed
 * from the ELF in `player.html`'s TRAPT STORY block; this file is the data.
 */
(function () {
'use strict';

const NAME_TABLE = 0x00386920, GROUP_TABLE = 0x0045DB50;
const CH_STAGES = 0x0042DD20, CH_OPEN = 0x0042DD60, CH_STAGE_GROUPS = 0x0042DD70;
const CH_FLAG = 0x0042DDD0, ROUTE_TABLE = 0x003872A0, FLOW_TABLE = 0x003872C0;
const CARD_TABLE = 0x0044D930, CARD_STRIDE = 0x20, CARD_N = 16;

const N_CUTSCENES = 154, N_GROUPS = 0x26, N_CHAPTERS = 15, N_FLOWS = 30;
const FLOW_STRIDE = 0x50, FLOW_STEPS = 16, CUTSCENE_BIAS = 0x4E, NONE = 0xFF;

// FUN_001726F0, reachable only where FUN_001741B0 has no next chapter.
const FINALES = [[0x23, 'chapter 14, story flag 1 clear'],
                 [0x25, 'chapter 15, story flag 2 clear'],
                 [0x24, 'chapter 15, story flag 2 set']];

/** `disc` is a disc.js Disc; every table comes out of its ELF. */
function read(disc) {
  const s8 = (va) => { const v = disc.elfU8(va); return v > 0x7F ? v - 0x100 : v; };
  const s16 = (va) => {
    const v = disc.elfU8(va) | (disc.elfU8(va + 1) << 8);
    return v > 0x7FFF ? v - 0x10000 : v;
  };
  const opt = (g) => (g === NONE ? null : g);

  const names = [];
  for (let i = 0; i < N_CUTSCENES; i++)
    names.push(disc.elfStr(disc.elfU32(NAME_TABLE + i * 4)));

  const groups = [];
  for (let g = 0; g < N_GROUPS; g++) {
    const base = GROUP_TABLE + g * 8, n = disc.elfU8(base), ids = [];
    for (let i = 0; i < n; i++) ids.push(disc.elfU8(base + 1 + i));
    groups.push(ids);
  }

  const chapters = [];
  for (let c = 0; c < N_CHAPTERS; c++) {
    const base = CH_STAGES + c * 4, n = disc.elfU8(base), stages = [];
    for (let st = 0; st < n; st++) {
      const pair = CH_STAGE_GROUPS + c * 6 + st * 2;
      stages.push({ stage: disc.elfU8(base + 1 + st),
                    before: opt(disc.elfU8(pair)),
                    after: opt(disc.elfU8(pair + 1)) });
    }
    chapters.push({ index: c, open: opt(disc.elfU8(CH_OPEN + c)), stages: stages,
                    flag: s8(CH_FLAG + c),
                    card: 'DATA/TWO_D/SLD/SLD' + String(c + 1).padStart(2, '0')
                          + '.ARC' });
  }

  const routes = [];
  for (let c = 0; c < N_CHAPTERS; c++)
    routes.push([disc.elfU8(ROUTE_TABLE + c * 2), disc.elfU8(ROUTE_TABLE + c * 2 + 1)]);

  const flows = [];
  for (let r = 0; r < N_FLOWS; r++) {
    const base = FLOW_TABLE + r * FLOW_STRIDE, steps = [];
    for (let i = 0; i < FLOW_STEPS; i++) {
      const v = s16(base + i * 2);
      const bf = s8(base + 0x20 + i * 3);
      const step = { index: i, raw: v,
                     branch: bf === -1 ? null
                       : { flag: bf, clear: s8(base + 0x21 + i * 3),
                           set: s8(base + 0x22 + i * 3) } };
      if (v === -1) step.kind = 'end';
      else if (v >= CUTSCENE_BIAS) {
        step.kind = 'cutscene'; step.id = v - CUTSCENE_BIAS;
        step.name = names[v - CUTSCENE_BIAS];
      } else { step.kind = 'stage'; step.stage = v; }
      steps.push(step);
    }
    flows.push({ index: r, steps: steps, reachable: reach(steps) });
  }

  // The card table also holds named slides past the 16 numbered ones.
  const cards = [];
  for (let i = 0; i < CARD_N; i++)
    cards.push(disc.elfStr(CARD_TABLE + i * CARD_STRIDE));

  return { names: names, groups: groups, chapters: chapters, routes: routes,
           flows: flows, cards: cards, finales: FINALES };
}

/** Steps FUN_0032A5D0 can reach; it refuses any successor whose step is -1. */
function reach(steps) {
  const seen = new Set(), queue = [0];
  while (queue.length) {
    const i = queue.shift();
    if (!(i >= 0 && i < FLOW_STEPS) || seen.has(i) || steps[i].kind === 'end') continue;
    seen.add(i);
    const b = steps[i].branch;
    if (!b) queue.push(i + 1); else queue.push(b.clear, b.set);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Cutscene ids some table actually plays. */
function referenced(tables) {
  const ids = new Set();
  for (const g of tables.groups) for (const i of g) ids.add(i);
  for (const f of tables.flows)
    for (const i of f.reachable)
      if (f.steps[i].kind === 'cutscene') ids.add(f.steps[i].id);
  return ids;
}

/**
 * One playable route, as a flat list of beats.
 *
 * `opts.chapters` limits it (default all 15), `opts.ending` picks a chapter
 * and route to finish on instead of running to the finale, and `have` drops
 * anything the disc does not carry.
 */
function route(tables, opts) {
  const o = opts || {};
  const have = o.have || null;
  const ok = (n) => !have || have.has(n);
  const beats = [];
  const push = (b) => { if (b.kind !== 'cutscene' || ok(b.name)) beats.push(b); };

  const group = (g, note) => {
    if (g === null || g === undefined) return;
    for (const id of tables.groups[g])
      push({ kind: 'cutscene', name: tables.names[id], id: id, group: g, note: note });
  };

  if (o.opening !== false) {
    push({ kind: 'card', card: null, title: 'Trapt', subtitle: 'the opening' });
    group(0, 'the opening');
  }

  const last = o.chapters === undefined ? tables.chapters.length : o.chapters;
  for (let c = 0; c < last; c++) {
    const ch = tables.chapters[c];
    push({ kind: 'card', card: ch.card, chapter: c,
           title: 'Chapter ' + (c + 1) });
    group(ch.open, 'chapter opening');
    for (const st of ch.stages) {
      group(st.before, 'before stage ' + st.stage.toString(16).toUpperCase());
      push({ kind: 'stage', stage: st.stage, chapter: c });
      group(st.after, 'after stage ' + st.stage.toString(16).toUpperCase());
    }
  }

  if (o.ending !== undefined && o.ending !== null) {
    const flow = tables.flows[o.ending];
    push({ kind: 'card', card: null, title: 'Ending',
           subtitle: 'flow ' + flow.index.toString(16).toUpperCase() });
    for (const i of flow.reachable) {
      const st = flow.steps[i];
      if (st.kind === 'cutscene')
        push({ kind: 'cutscene', name: st.name, id: st.id,
               note: 'ending flow, step ' + i });
      else if (st.kind === 'stage')
        push({ kind: 'stage', stage: st.stage });
    }
  } else if (last >= tables.chapters.length) {
    const g = o.finale === undefined ? 0x23 : o.finale;
    const why = (tables.finales.find((f) => f[0] === g) || [g, ''])[1];
    push({ kind: 'card', card: null, title: 'Finale', subtitle: why });
    group(g, why);
  }
  return beats;
}

const api = { read, route, referenced, reach, N_CHAPTERS, N_CUTSCENES,
              FINALES, CARD_TABLE };
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptStory2 = api;
})();
