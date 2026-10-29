/**
 * The page in Japanese.
 *
 *   T('Play')                         -> '再生'
 *   T('{0} cues', 12)                 -> '12 キュー'
 *   T('reading room R101')            -> 'ルーム R101 を読み込み中'   (MSG)
 *
 * English is the source: every string in pick.html is written in English and
 * passed through `T`, which looks it up here and hands back the English when
 * there is no entry or the page is in English.  A missing translation is
 * therefore an English word on a Japanese page, never a blank or a crash.
 *
 * `JA` is looked up exactly.  `MSG` holds what the modules say -- progress
 * lines, errors, story-beat labels -- which arrive already formatted
 * ('reading room R101'), so its `{n}` keys are matched as patterns.  It is
 * kept apart because a pattern as loose as '{0} pad' would otherwise match a
 * trap's name off the disc.
 *
 * The first draft came from DeepL and was then corrected by hand: DeepL reads
 * "building models" as 建物モデル and "Cross" as the d-pad.  Game terms
 * follow the Japanese release, 影牢II: traps are トラップ, the face buttons
 * are ○ × □ △.
 *
 * Which language: ?lang=ja|en, then the last choice (localStorage), then the
 * browser's.  Switching reloads the page, because everything below the drop
 * zone is built once from the disc; the disc has to be picked again.
 */
'use strict';

(function (root) {

const JA = {
  // ------------------------------------------------------------ the markup
  'Trapt — supply your disc': '影牢II / Trapt — ディスクを読み込む',
  'Supply your Trapt disc': 'お手持ちの Trapt / 影牢II のディスクを読み込む',
  'This page reads the game out of your own copy. Nothing is uploaded — the file never leaves your machine, and only the parts actually needed are read out of it.':
    'このページは、お手持ちのディスクからゲームを読み出します。アップロードは一切ありません。'
    + 'ファイルがこのコンピューターの外に出ることはなく、実際に必要な部分だけを読み込みます。',
  'Choose your .iso': '.iso を選ぶ',
  'or drop it here · Trapt (SLUS-21255) or Kagero II (SLPS-25445), 1.76 GB':
    'またはここにドロップ · Trapt (SLUS-21255) または 影牢II (SLPS-25445)、1.76 GB',
  'Walk a stage': 'ステージを歩く',
  'Play a route': 'ルートを通して再生',
  'Cutscenes on the disc': 'ディスク上のカットシーン',
  'Gallery': 'ギャラリー',
  'Cutscenes': 'カットシーン',
  'Stages': 'ステージ',
  'Routes': 'ルート',
  'Disc': 'ディスク',
  'Pick a cutscene, a stage or a route on the left.': '左の一覧からカットシーン、ステージ、ルートを選んでください。',
  'Search cutscenes: name, room, speaker, line': 'カットシーンを検索: 名前、ルーム、話者、台詞',
  'assets': '素材',
  'every model, clip and texture in this bundle': 'このアーカイブのモデル、モーション、テクスチャをすべて表示',
  'cutscenes': 'カットシーン',
  '{0} of {1} have data': '{1} 本中 {0} 本にデータあり',
  'Elsewhere in the tables': 'その他の表から',
  'In the registry, no data on this disc': '登録表にあるが、このディスクにデータがないもの',

  // ------------------------------------------------------- the disc's rows
  'page build': 'ページのビルド',
  'file': 'ファイル',
  'problem': '問題',
  'disc': 'ディスク',
  'volume': 'ボリューム',
  'files in the AFS': 'AFS 内のファイル',
  'opened in': '読み込み時間',
  'cutscene registry': 'カットシーン登録表',
  'subtitle font': '字幕フォント',
  'story order': 'ストーリー順',
  'never played': '未使用',
  'stages': 'ステージ',
  'stage → map': 'ステージ → マップ',
  '{0} ms  (about 100 KB read)': '{0} ms（読み込み 約 100 KB）',
  '{0} entries, {1} … {2}': '{0} 件、{1} … {2}',
  'PS2 kernel face from the ELF at 0x{0}, {1} advances, {2}-entry CLUT':
    'ELF の 0x{0} にある PS2 カーネルフォント、字幅 {1} 件、CLUT {2} 色',
  '{0} chapters, {1} cutscene groups, {2} ending flows':
    '{0} 章、カットシーングループ {1}、エンディングフロー {2}',
  '{0} on the disc that no table reaches: {1}':
    'ディスクにあるがどの表からも呼ばれないもの {0} 件：{1}',
  '{0} in DATA/MAP_DATA/BIN, with collision for {1} rooms':
    'DATA/MAP_DATA/BIN に {0} 件、当たり判定のある部屋 {1}',
  '{0} of {1} stages resolved to a map, from their B##EVENT scripts':
    '{1} ステージ中 {0} をマップに対応付け（B##EVENT スクリプトより）',
  'in the registry, but no data on this disc': '登録表にはあるが、このディスクにデータがない',
  'Cutscenes on the disc — {0} of {1} have data; click one to extract it':
    'ディスク上のカットシーン — {1} 件中 {0} 件にデータあり。クリックで展開',

  // ---------------------------------------------------- a cutscene's bundle
  'reading…': '読み込み中…',
  '{0} MB archive read in {1} ms · {2} members ({3}) · {4} loose .sai beside it · {5} textures, {6} Mpx decoded in {7} ms':
    '{0} MB のアーカイブを {1} ms で読み込み · {2} ファイル ({3}) · 別置きの .sai {4} 件 · '
    + 'テクスチャ {5} 枚、{6} Mpx を {7} ms でデコード',
  '▶ play the whole scene': '▶ シーン全体を再生',
  'no models in this bundle': 'このアーカイブにモデルはない',
  'bind pose': 'バインドポーズ',
  'no clips for this rig': 'このリグのモーションはない',
  '{0} bones, {1} meshes, {2} verts, {3} tris': 'ボーン {0}、メッシュ {1}、頂点 {2}、三角形 {3}',
  '{0} animated nodes, {1} frames, skin {2} ms/frame':
    'アニメーションするノード {0}、{1} フレーム、スキニング {2} ms/フレーム',
  'WASD to fly, QE up/down, shift to hurry, drag to look, right-drag to orbit, wheel to zoom':
    'WASD で移動、QE で上下、Shift で加速、ドラッグで視点、右ドラッグで周回、ホイールでズーム',

  // ------------------------------------------------------------- transport
  'Play': '再生',
  'Pause': '一時停止',
  'Free cam': 'フリーカメラ',
  'Scene cam': 'シーンカメラ',
  'Modern': 'モダン',
  'Subs PS2': '字幕 PS2',
  'Subs DOM': '字幕 DOM',
  'Sound': '音声オン',
  'Muted': 'ミュート',
  'Look': '画質',
  'Fullscreen': '全画面',
  'Exit fullscreen': '全画面を終了',
  'Native 512x224': 'ネイティブ 512x224',
  'Sharp upscale': 'シャープ拡大',
  'Colour bits': '色深度',
  'GS dither': 'GS ディザ',
  'Exposure': '露出',
  'Contrast': 'コントラスト',
  'Saturation': '彩度',
  'Warmth': '色温度',
  'Vignette': '周辺減光',
  'Scanlines': '走査線',
  'Curvature': '画面の湾曲',
  'Ghosting': 'ゴースト',
  'Interference': 'ノイズ',
  'Rolling lines': '流れる横線',
  'Persistence': '残光',
  'Ghost blur': 'ゴーストのぼかし',
  'loading audio…': '音声を読み込み中…',
  'voice {0} of {1}…': 'ボイス {0} / {1}…',
  'assembling {0}…': '{0} を組み立て中…',
  'room {0}': '部屋 {0}',
  '{0} actors, {1} entities, {2} cues, {3} frames · assembled in {4} ms · pose {5} ms/frame':
    'アクター {0}、エンティティ {1}、字幕 {2}、{3} フレーム · 組み立て {4} ms · ポーズ {5} ms/フレーム',
  '{0} voice clips': 'ボイス {0} 件',
  '{0} warnings': '警告 {0} 件',
  'WASD to fly, drag to look, right-drag to orbit (any of them switches to free cam)':
    'WASD で移動、ドラッグで視点、右ドラッグで周回（どれを使ってもフリーカメラに切り替わる）',

  // --------------------------------------------------------------- gallery
  'still': '静止画',
  'rendering…': '描画中…',
  'reading {0} of {1}…': '読み込み中 {0} / {1}…',
  '{0} cutscenes; stills render as you scroll': 'カットシーン {0} 本。静止画はスクロールに合わせて描画',
  '{0} cues': '字幕 {0}',
  'unreferenced': '未参照',

  // ----------------------------------------------------------------- route
  'Route': 'ルート',
  'Route — {0}': 'ルート — {0}',
  'open a disc first': '先にディスクを読み込んでください',
  '{0} of {1} cutscenes · beat {2} of {3}': 'カットシーン {0} / {1} · 場面 {2} / {3}',
  'The end': '終',
  'Stage {0}': 'ステージ {0}',
  'played here in the game — map M{0}, {1} rooms, from {2}':
    'ゲームではここでプレイする — マップ M{0}、{1} 部屋、{2} より',
  'played here in the game; this stage has no map the viewer can find':
    'ゲームではここでプレイする。このビューアーではこのステージのマップが見つからない',
  'Play this stage': 'このステージをプレイ',
  'Skip it': 'スキップ',
  'Continue': '次へ',
  'Done': '閉じる',
  'Leave the route': 'ルートをやめる',
  '▶ the whole story': '▶ ストーリー全編',
  'all 15 chapters, then the finale': '全 15 章、そしてフィナーレ',
  'finale {0}': 'フィナーレ {0}',
  'ch {0} → ending {1}': '{0} 章 → エンディング {1}',
  'chapters 1-{0}, then flow {1}': '1〜{0} 章、続いてフロー {1}',

  // ----------------------------------------------------------------- stage
  'walk stage {0}': 'ステージ {0} を歩く',
  '{0} on the disc — click one to walk it': 'ディスクに {0} 件 — クリックで歩ける',
  'Stage M{0}': 'ステージ M{0}',
  'assembling…': '組み立て中…',
  '{0} rooms, {1} doors, {2} traps · assembled in {3} ms':
    '{0} 部屋、扉 {1}、トラップ {2} · 組み立て {3} ms',
  '{0} is {1} tall, radius {2}, walks {3} and runs {4} units/s':
    '{0}：身長 {1}、半径 {2}、歩き {3}・走り {4} 単位/秒',
  'script {0}: {1} gimmicks, {2} cast': 'スクリプト {0}：仕掛け {1}、登場人物 {2}',
  ', scripted start': '、スクリプトの開始位置',
  'no stage script': 'ステージスクリプトなし',
  'collision': '当たり判定',
  'draw the .col itself: floors green, walls red, ceilings blue':
    '.col そのものを表示：床は緑、壁は赤、天井は青',
  '◀ back to the route': '◀ ルートに戻る',
  'finish here and carry on from stage {0}': 'ここで終えて、ステージ {0} の続きから',
  '{0} damage · cost {1} · reset {2} frames': 'ダメージ {0} · コスト {1} · 再設置 {2} フレーム',
  'starting trap': '初期トラップ',
  'passage': '通路',
  'room': '部屋',
  'of M{0}': '（M{0}）',
  'floor': '床',
  'wall': '壁',
  'ceiling': '天井',
  'Floor': '床',
  'Wall': '壁',
  'Ceiling': '天井',
  'material': '材質',
  'none': 'なし',
  'gait': '歩様',
  'idle': '待機',
  'walk': '歩き',
  'run': '走る',
  'clip': 'モーション',
  'trap': 'トラップ',
  '{0}, {1} set': '{0}、設置 {1}',
  '<b>Cross</b> to enter {0}': '<b>×</b> で {0} へ入る',
  'L1/R1 trap · Square set · Circle run': 'L1/R1 トラップ選択 · □ 設置 · ○ 走る',
  '{0} pad': 'パッド {0} 台',
  '{0} pads': 'パッド {0} 台',
  'no pad': 'パッドなし',
  'default bindings': '既定の割り当て',
  'entered {0}': '{0} に入った',
  '{0} set on the {1}': '{0} を{1}に設置',

  // ------------------------------------------------------------------- pad
  'nothing bound': '割り当てなし',
  'the left stick': '左スティック',
  'the right stick': '右スティック',
  'gamepad {0}': 'ゲームパッド {0}',
  '{0} keyboard': 'キーボード {0}',
  '{0} controls bound ({1})': '{0} 操作を割り当て済み（{1}）',
  'Use my PCSX2 bindings': '自分の PCSX2 の設定を使う',
  'built-in keyboard defaults': '内蔵のキーボード既定値',
  'move': '移動',
  'camera': 'カメラ',
  'door': '扉',
  'set a trap': 'トラップ設置',
  'pick a trap': 'トラップ選択',
  'no [Pad1] bindings in {0}': '{0} に [Pad1] の割り当てがない',
};

// What the modules say, already formatted.  Matched as patterns.
const MSG = {
  // play.js, stageview.js: progress
  'reading archives': 'アーカイブを読み込み中',
  'compiling the script': 'スクリプトをコンパイル中',
  'reading room {0}': '部屋 {0} を読み込み中',
  'streaming {0} clips': 'モーション {0} 件を読み込み中',
  'building models': 'モデルを構築中',
  'reading the stage graph': 'ステージの構成を読み込み中',
  'reading collision': '当たり判定を読み込み中',
  'reading the stage script': 'ステージスクリプトを読み込み中',
  'building the cast': '登場人物を構築中',
  'placing {0} in {1}': '{1} に {0} 体を配置中',
  'reading {0}': '{0} を読み込み中',
  // story.js: the beats of a route and the gallery's headings
  'Trapt': '影牢II',
  'the opening': 'オープニング',
  'Chapter {0}': '第 {0} 章',
  'chapter opening': '章の冒頭',
  'before stage {0}': 'ステージ {0} の前',
  'after stage {0}': 'ステージ {0} の後',
  'Ending': 'エンディング',
  'Finale': 'フィナーレ',
  'flow {0}': 'フロー {0}',
  'ending flow, step {0}': 'エンディングフロー、ステップ {0}',
  'chapter 14, story flag 1 clear': '第 14 章、ストーリーフラグ 1 が未設定',
  'chapter 15, story flag 2 clear': '第 15 章、ストーリーフラグ 2 が未設定',
  'chapter 15, story flag 2 set': '第 15 章、ストーリーフラグ 2 が設定済み',
  'In the registry, never played': '登録表にあるが、使われないもの',
  'no table reaches these, and they are exactly the {0} on the disc that were never translated':
    'どの表からも呼ばれない。ディスク上で英訳されなかった {0} 本と完全に一致する',
  // errors a visitor can cause
  'open a disc first': '先にディスクを読み込んでください',
  'no bundle for {0}': '{0} のアーカイブがない',
  'no stage M{0} on this disc': 'このディスクにステージ M{0} はない',
  'no character archive for {0}': '{0} のキャラクターアーカイブがない',
};

const DISC_ERR = /^that image has no (.*) -- it does not look like Trapt or Kagero II (\(volume id ".*"\))$/;

function choose() {
  const q = /[?&]lang=(ja|en)\b/.exec(root.location ? root.location.search : '');
  if (q) return q[1];
  try {
    const kept = root.localStorage && root.localStorage.getItem('trapt.lang');
    if (kept === 'ja' || kept === 'en') return kept;
  } catch (e) { /* storage refused, e.g. a sandboxed file:// page */ }
  const langs = (root.navigator && (root.navigator.languages
                || [root.navigator.language])) || [];
  return langs.some((l) => /^ja\b/i.test(l || '')) ? 'ja' : 'en';
}

const fill = (s, args) => s.replace(/\{(\d+)\}/g, (m, i) =>
  (+i < args.length ? String(args[+i]) : m));

const esc = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');

// MSG keys as anchored patterns, the ones with most literal text first so
// 'reading room {0}' is tried before 'reading {0}'.
const PATTERNS = Object.keys(MSG)
  .filter((k) => /\{\d+\}/.test(k))
  .sort((a, b) => b.replace(/\{\d+\}/g, '').length - a.replace(/\{\d+\}/g, '').length)
  .map((k) => {
    const order = [];
    const re = new RegExp('^' + esc(k).replace(/\\?\{(\d+)\\?\}/g, (m, i) => {
      order.push(+i); return '(.+?)';
    }) + '$');
    return { re, order, out: MSG[k] };
  });

function make(lang) {
  const ja = lang === 'ja';
  function t(s, ...args) {
    if (s === null || s === undefined) return s;
    s = String(s);
    if (!ja) return args.length ? fill(s, args) : s;
    if (Object.prototype.hasOwnProperty.call(JA, s)) return fill(JA[s], args);
    if (Object.prototype.hasOwnProperty.call(MSG, s)) return fill(MSG[s], args);
    if (args.length) return fill(s, args);
    for (const p of PATTERNS) {
      const m = p.re.exec(s);
      if (!m) continue;
      const vals = [];
      p.order.forEach((i, n) => { vals[i] = m[n + 1]; });
      return fill(p.out, vals);
    }
    const d = DISC_ERR.exec(s);
    if (d) return 'このイメージには ' + d[1].replace(/ or /g, ' / ')
      .replace(/ with /, ' と ') + ' が見つからない — Trapt / 影牢II のディスクではないようだ '
      + d[2];
    return s;
  }
  return t;
}

let LANG = choose();
let t = make(LANG);

/**
 * Translate the static markup: every element marked `data-i18n` whose text
 * (whitespace collapsed) is a key gets its text replaced, or its HTML when the
 * key is listed in `HTML`.  Then the language switch.
 */
const HTML = {
  'Reads the ISO 9660 directory, the filename table baked into the executable — SLUS_212.55 at 0x0036A0F0, SLPS_254.45 at 0x0036C070 — and the AFS index at the front of DATA/GAME.DAT — about 100 KB out of 1.76 GB. A Japanese disc plays in Japanese: its script, its voices and its own copy of the subtitle face. Opening a cutscene reads only that cutscene\'s archive and decodes its .TM2 textures here, in the page.':
    '読み込むのは ISO 9660 のディレクトリ、実行ファイルに埋め込まれたファイル名表'
    + '（<code>SLUS_212.55</code> の <code>0x0036A0F0</code>、'
    + '<code>SLPS_254.45</code> の <code>0x0036C070</code>）、そして '
    + '<code>DATA/GAME.DAT</code> 先頭の AFS インデックスだけで、1.76 GB のうち約 100 KB です。'
    + '日本版のディスクは日本語で再生されます。台本も、ボイスも、字幕の書体もそのディスクのものです。'
    + 'カットシーンを開くと、そのカットシーンのアーカイブだけを読み、'
    + '<code>.TM2</code> テクスチャをこのページの中でデコードします。',
};

function apply(doc) {
  const ja = LANG === 'ja';
  if (ja) {
    doc.documentElement.lang = 'ja';
    for (const el of doc.querySelectorAll('[data-i18n]')) {
      const key = el.textContent.replace(/\s+/g, ' ').trim();
      if (HTML[key]) el.innerHTML = HTML[key];
      else if (JA[key]) el.textContent = JA[key];
    }
  }
  const host = doc.getElementById('lang');
  if (!host) return;
  const a = doc.createElement('a');
  a.href = '#';
  a.textContent = ja ? 'English' : '日本語';
  a.lang = ja ? 'en' : 'ja';
  a.onclick = (e) => { e.preventDefault(); switchTo(ja ? 'en' : 'ja'); };
  host.appendChild(a);
}

function switchTo(lang) {
  try { root.localStorage.setItem('trapt.lang', lang); } catch (e) { /* ignore */ }
  const url = new URL(root.location.href);
  url.searchParams.set('lang', lang);
  root.location.href = url.toString();
}

const api = {
  get lang() { return LANG; },
  t: (...a) => t(...a),
  apply, switchTo, JA, MSG, HTML,
  /** For the tests: run the lookup as if the page were in `lang`. */
  setLang(lang) { LANG = lang; t = make(lang); },
};

if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.TraptI18n = api;

})(typeof self !== 'undefined' ? self : globalThis);
