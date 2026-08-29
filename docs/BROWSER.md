# Playing Trapt from your own disc, in a browser

`tools/web/pick.html` asks the visitor for their copy of the game and plays it:
the cast, the room, the real camera track, the game's own subtitle font, the
voices and the music. Nothing game-derived is served — the page is code, and
every byte it draws comes out of the ISO the visitor picked.

Open it straight off disk. Nothing is uploaded, and only the parts actually
needed are read: opening a disc costs about 100 KB of a 1.76 GB image.

```
tools/web/pick.html      the page
node tools/web/test_all.js   every suite the disc allows
```

---

## 1. Why not just serve the exported site

`tools/site.py` builds a gallery of all 149 cutscenes ([`VIEWER.md`](VIEWER.md)
§2.1) and it works well, but it is **0.89 GB of somebody else's assets**. Every
hosting question that followed — the droplet, Cloudflare Pages, git
storage — was really the same question, and the answer that dissolves all of
them is to ship no assets at all.

That means the browser has to do what `export.py` does: read the disc, decode
every format, and assemble a scene. It now does.

## 2. The modules

Each is a port of its Python counterpart and is diffed against it over real
disc data. They work under two loaders — `require` in the tests and a classic
`<script>` in the page — which is why each is wrapped in an IIFE.

| file | Python | what it does |
|---|---|---|
| `iso.js` | — | ISO 9660, range-based; the disc is never loaded whole |
| `disc.js` | `afs.py` | the ELF filename table + the AFS index in `GAME.DAT` |
| `arc.js` | `arc.py` | the `RPS` archive, whole or ranged |
| `tm2.js` | `tm2.py` | TIM2 textures, with the PS2 alpha and CLUT swizzle |
| `smi.js` | `smi.py` | models: skeleton, meshes, materials, bind pose |
| `sai.js` | `sai.py` + `pose.py` | animation, and the posed skin |
| `ssc.js` | `ssc.py` | the scene bytecode |
| `cam.js` | `cam.py` | the baked camera track |
| `scene.js` | `scene.py` | the interpreter: the whole timeline |
| `sli.js` | `sli.py` | room lights, which is where a directional aim lives |
| `font.js` | `font.py` | the PS2 kernel face, out of the ELF |
| `adx.js` | `adx.py` | CRI ADX, straight to PCM |
| `story.js` | `order.py` | the ordering tables and a route walk |
| `gs.js` | `player.html` | the GS look: shaders copied verbatim |
| `hbin.js` | `hbin.py` | the `#bin` container the stage half is authored in |
| `col.js` | `col.py` | room collision, and the solver a body walks with |
| `mapbin.js` | `mapbin.py` | the stage graph: rooms, passages, doors |
| `trap.js` | `trap.py` | the 48 traps, their stats and their volumes |
| `stage.js` | `stage.py` | a whole stage, assembled and walkable |
| `stagescript.js` | `stagescript.py` | what a stage is told to contain |
| `pad.js` | `pcsx2pad.py` | a PCSX2 `[Pad1]`, and the pad it becomes |
| `model.js`, `play.js`, `audio.js`, `cards.js`, `catalog.js`, `poster.js` | — | the three.js and playback layer |
| `stageview.js` | — | the same, for a stage: geometry, skinning, camera, input |

## 3. What the page does

* **Gallery** — a card per cutscene in story order under chapter headings:
  a still, the name, where the game plays it, the first line and the cast.
  The text comes from `catalog.js`, which reads only the `.ssc` tracks —
  about 35 KB of a 5 MB bundle. The still is rendered on demand by
  `poster.js` when a card scrolls into view.
* **Route** — the game's own chapter cards (`DATA/TWO_D/SLD`, with the
  chapter name already in the art) and then that chapter's cutscenes, in the
  order the tables give, unattended — and it now hands over to the stage half
  rather than stepping past it.
* **Stage** — the other half of the game. Any of the 22 stages, its rooms
  placed where the stage graph says, walked with real collision, its doors
  crossed, its 48 traps set on the ceilings, walls and floors they belong on.
  The pad comes from your own `PCSX2.ini`. See [`STAGE.md`](STAGE.md).
* **PS2 / Modern** — the GS fixed function at 512x224 with the letterbox and
  the game's font, or a modern render filling the element with DOM subtitles
  and no bars.
* **Fullscreen**, scrub, and a Look panel of grading knobs.
* **The camera.** `WASD` flies, `Q`/`E` drop and rise, `shift` hurries by four,
  the wheel zooms. The mouse turns the camera and not the world: dragging
  looks around from where you are standing, and **double-click** takes pointer
  lock to do the same without holding a button (`Esc` releases it). Orbiting a
  point -- the right thing for looking over a model, disorienting in a room --
  is on **right-drag** or alt-drag. Any of them takes the shot off the
  cutscene's own camera, the same way the drag always did.

  Speed follows the orbit distance, and that is set from the size of whatever
  was loaded, so the same keys cross a face and cross a courtyard in about the
  same time -- floored so a close-up does not crawl. Keys are ignored while
  something is being typed into and whenever ctrl, meta or alt is down, and a
  stage keeps its own follow camera: flying is skipped entirely while one is
  running, so the two never fight for the frame.

Two projection rules are worth restating because both have been got wrong
here before: a `.cam` FOV is **vertical**, and the 512x224 target is
**anamorphic**, so in native mode the horizontal half-angle comes from the 4:3
display aspect and not from the element. Modern has no such obligation and
uses the element's own aspect.

## 4. Tests

```
node tools/web/test_all.js              # 691 checks with a disc
node tools/web/test_all.js --no-disc    # 235 without
```

Every decoder is diffed against its Python counterpart on real disc data —
the same textures, the same skinned vertices, the same timeline, the same
audio samples, the same collision and the same walk. A suite that needs the
disc exits 2 when there is none, which the runner reports as a skip.

Four suites need no game data, and the first three are the ones that have
caught bugs that actually shipped:

* `test_modules.js` — every module loaded the way a browser loads it, in one
  shared global scope. `iso.js` and `disc.js` once both declared `u32` and
  `api` at top level, so the second `<script>` died with a redeclaration
  error and the page failed with *"TraptDisc is not defined"* — while every
  test passed, because `require` gives each file its own scope.
* `test_shader.js` — the GS fragment shader and post pass in `gs.js` still
  byte-identical to `player.html`'s. Two copies of anything drift.
* `test_page.js` — `pick.html`'s initialisation order. Route mode once called
  `setPs2()` before wiring the play button, and `setPs2()` touched a field
  that only the post pass creates; the throw left a dead Play button and,
  with it, the only thing that resumed the AudioContext.
* `test_pad.js` — the PCSX2 binding tables, which need no game data because a
  `PCSX2.ini` is not game data. A transposed pair in them silently swaps
  Circle and Cross, and the game gets the blame.

`.forgejo/workflows/ci.yml` runs those four, compiles the Python, and checks
the docs' relative links.

## 5. What is not here

* **The rest of a stage.** The rooms can be walked and traps can be set on
  them ([`STAGE.md`](STAGE.md)), but nothing fires a trap yet, no intruder
  walks in, and there is no damage, no gauge and no mission. The trap effect
  scripts are `.ssc`, which the cutscene VM already runs, so the missing piece
  is the game around them rather than another format.
* **Ending BGM.** Music is looked up by cutscene name, which is right for the
  main story and finds nothing for an `e4xx` ending — those ask for a *track
  id* through a slot table at `0x00370918` that is only half decoded
  ([`CUTSCENES.md`](CUTSCENES.md)). Endings are also unvoiced in the data
  itself: their scripts call `play_voice("none")`.
* **Loading-screen tips.** There is no tip-string table. A scan of the
  executable for Shift-JIS runs turns up menu labels, item names and error
  messages; `LS/LS.ARC` is a background with an empty panel and nothing fills
  it from a table.
