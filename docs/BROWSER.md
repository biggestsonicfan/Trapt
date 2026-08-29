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
hosting question that followed — a 25 GB droplet, Cloudflare Pages, git
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
| `model.js`, `play.js`, `audio.js`, `cards.js`, `catalog.js`, `poster.js` | — | the three.js and playback layer |

## 3. What the page does

* **Gallery** — a card per cutscene in story order under chapter headings:
  a still, the name, where the game plays it, the first line and the cast.
  The text comes from `catalog.js`, which reads only the `.ssc` tracks —
  about 35 KB of a 5 MB bundle. The still is rendered on demand by
  `poster.js` when a card scrolls into view.
* **Route** — the game's own chapter cards (`DATA/TWO_D/SLD`, with the
  chapter name already in the art) and then that chapter's cutscenes, in the
  order the tables give, unattended.
* **PS2 / Modern** — the GS fixed function at 512x224 with the letterbox and
  the game's font, or a modern render filling the element with DOM subtitles
  and no bars.
* **Fullscreen**, orbit, scrub, and a Look panel of grading knobs.

Two projection rules are worth restating because both have been got wrong
here before: a `.cam` FOV is **vertical**, and the 512x224 target is
**anamorphic**, so in native mode the horizontal half-angle comes from the 4:3
display aspect and not from the element. Modern has no such obligation and
uses the element's own aspect.

## 4. Tests

```
node tools/web/test_all.js              # 390 checks with a disc
node tools/web/test_all.js --no-disc    # 114 without
```

Every decoder is diffed against its Python counterpart on real disc data —
the same textures, the same skinned vertices, the same timeline, the same
audio samples. A suite that needs the disc exits 2 when there is none, which
the runner reports as a skip.

Three suites need no game data, and they are the ones that have caught bugs
that actually shipped:

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

`.forgejo/workflows/ci.yml` runs those three, compiles the Python, and checks
the docs' relative links.

## 5. What is not here

* **The stage half of the game.** The viewer plays cutscenes; the rooms are
  the other machine (`FUN_0016B870`), and a route announces a stage and steps
  over it.
* **Ending BGM.** Music is looked up by cutscene name, which is right for the
  main story and finds nothing for an `e4xx` ending — those ask for a *track
  id* through a slot table at `0x00370918` that is only half decoded
  ([`CUTSCENES.md`](CUTSCENES.md)). Endings are also unvoiced in the data
  itself: their scripts call `play_voice("none")`.
* **Loading-screen tips.** There is no tip-string table. A scan of the
  executable for Shift-JIS runs turns up menu labels, item names and error
  messages; `LS/LS.ARC` is a background with an empty panel and nothing fills
  it from a table.
