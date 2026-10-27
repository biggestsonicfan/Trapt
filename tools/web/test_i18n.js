/**
 * The Japanese page: every string pick.html translates has a translation.
 *
 *   node tools/web/test_i18n.js
 *
 * English is the source and `T` falls back to it, so a key with no entry does
 * not break anything -- it just leaves an English word on the Japanese page,
 * which nobody notices until a visitor does.  This reads every literal handed
 * to `T(...)` and every `data-i18n` element out of the page and checks each has
 * an entry, with the same `{n}` placeholders, and runs the module messages
 * the page passes through as already-formatted text.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const I = require('./i18n.js');

const html = fs.readFileSync(path.join(__dirname, 'pick.html'), 'utf8')
  .replace(/\r\n/g, '\n');

let failed = 0, passed = 0;
function check(what, ok, why) {
  if (ok) { passed++; console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what + (why ? '  -- ' + why : ''));
}

/** The first argument of every `T(` call, as source text. */
function tArgs(src) {
  const out = [];
  const re = /\bT\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + 2, depth = 0, quote = null, arg = '';
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) { arg += c; if (c === quote && src[i - 1] !== '\\') quote = null; continue; }
      if (c === "'" || c === '"') { quote = c; arg += c; continue; }
      if (c === '(' || c === '[') depth++;
      if (c === ')' || c === ']') { if (depth === 0) break; depth--; }
      if (c === ',' && depth === 0) break;
      arg += c;
    }
    out.push(arg.trim());
  }
  return out;
}

/** The keys an argument can produce: concatenated literals, or each arm of a ternary. */
function keysOf(arg) {
  const lits = [...arg.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1].replace(/\\'/g, "'"));
  if (!lits.length) return [];
  if (/\?/.test(arg.replace(/'(?:[^'\\]|\\.)*'/g, ''))) return lits;     // a ternary
  if (/^(?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+$/.test(arg)) return [lits.join('')];
  return [];                                   // an expression: checked at run time
}

const holes = (s) => (s.match(/\{\d+\}/g) || []).sort().join(',');
const has = (k) => Object.prototype.hasOwnProperty.call(I.JA, k)
                || Object.prototype.hasOwnProperty.call(I.MSG, k);

console.log('every string the page passes to T() is translated');
const SCRIPT = html.slice(html.indexOf("const BUILD"));
const keys = new Set();
for (const a of tArgs(SCRIPT)) for (const k of keysOf(a)) keys.add(k);
// row() and pill() and mk() take their label as a literal and translate it inside.
for (const m of SCRIPT.matchAll(/\brow\('([^']+)'/g)) keys.add(m[1]);
for (const m of SCRIPT.matchAll(/\bpill\('([^']+)'/g)) keys.add(m[1]);
for (const m of SCRIPT.matchAll(/\bmk\('([^']+)', '([^']+)'/g)) { keys.add(m[1]); keys.add(m[2]); }
for (const m of SCRIPT.matchAll(/\['\w+', '([^']+)', [-\d.]+, [-\d.]+, [-\d.]+\]/g)) keys.add(m[1]);
const LEAVE = new Set(['PS2', '']);            // the same in both
check('found the page\'s strings', keys.size > 120, keys.size + ' keys');
for (const k of keys) {
  if (LEAVE.has(k)) continue;
  check('translated: ' + JSON.stringify(k), has(k));
}

console.log('every translation keeps its placeholders');
for (const dict of [I.JA, I.MSG])
  for (const [k, v] of Object.entries(dict))
    check('placeholders of ' + JSON.stringify(k), holes(k) === holes(v),
          holes(k) + ' vs ' + holes(v));

console.log('every data-i18n element in the markup has an entry');
const marked = [...html.matchAll(/<(\w+)[^>]*\bdata-i18n\b[^>]*>([\s\S]*?)<\/\1>/g)];
check('the markup is marked', marked.length >= 9, marked.length + ' elements');
for (const [, , inner] of marked) {
  const text = inner.replace(/<[^>]+>/g, '').replace(/&middot;/g, '·')
    .replace(/\s+/g, ' ').trim();
  check('static: ' + text.slice(0, 50), !!(I.JA[text] || I.HTML[text]));
}

console.log('module messages are translated as patterns');
I.setLang('ja');
const T = I.t;
for (const [said, want] of [
  ['reading room R101', '部屋 R101 を読み込み中'],
  ['reading M001.BIN', 'M001.BIN を読み込み中'],
  ['streaming 29 clips', 'モーション 29 件を読み込み中'],
  ['placing 4 in R203', 'R203 に 4 体を配置中'],
  ['Chapter 3', '第 3 章'],
  ['before stage 1A', 'ステージ 1A の前'],
  ['ending flow, step 4', 'エンディングフロー、ステップ 4'],
  ['no stage M042 on this disc', 'このディスクにステージ M042 はない'],
]) check(said, T(said) === want, JSON.stringify(T(said)));
check('formatting with arguments', T('{0} cues', 12) === '字幕 12');
check('an unknown string comes back unchanged', T('e001') === 'e001');
check('a trap name is not taken for a pattern', T('Spring Floor · Spring') === 'Spring Floor · Spring');
check('the wrong-disc error',
      /影牢II/.test(T('that image has no SLUS_212.55 or SLPS_254.45 with DATA/GAME.DAT'
        + ' -- it does not look like Trapt or Kagero II (volume id "FOO")')));

I.setLang('en');
check('English formats and is otherwise untouched',
      I.t('{0} cues', 12) === '12 cues' && I.t('Play') === 'Play'
      && I.t('reading room R101') === 'reading room R101');

console.log('the page loads i18n.js before its own script uses T');
const at = html.indexOf('<script src="i18n.js"></script>');
check('i18n.js is a script of the page', at > 0);
check('and comes before the inline script', at < html.indexOf("const T = TraptI18n.t;"));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
