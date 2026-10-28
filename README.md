# Trapt, taken apart

A reverse-engineering project on *Trapt* (Tecmo, 2005, PlayStation 2), released
in Japan as *Kagero II: Dark Illusion*. It reads the game's own disc and plays
its cutscenes, walks its stages and draws its subtitles outside the emulator.
Wherever it could be checked, it is checked against the real game running in
PCSX2.

Nothing from the game is in this repository. Every tool reads a disc image you
supply, and the browser page decodes it on your machine; no file on the disc is
changed.

## What it does

- **Plays your disc in a browser.** [`tools/web/pick.html`](tools/web/pick.html)
  asks for an ISO and plays the game's 154 real-time cutscenes from it, with the
  skinned cast, the room, the real camera track, the voices and music, and the
  subtitles in the game's own font. It plays them in story order, and it can
  walk a stage too. Opening a disc reads about 100 KB of the 1.76 GB image, and
  nothing is uploaded. A Japanese disc plays in Japanese.
- **Exports cutscenes as plain web pages.** `tools/export.py e001 out/` writes
  one cutscene as a self-contained HTML player; `tools/site.py` writes all of
  them, chained in the order the game plays them, with a **Story mode** that
  runs the game's own chapter and ending logic.
- **Extracts the assets.** Models (`.SMI`) become Wavefront `.obj` in bind pose,
  textures (`.TM2`) become PNG, and the archives, stage graphs, collision, trap
  tables and stage scripts all have readers.
- **Imitates the PS2's look.** The GS register state and the VU1 lighting
  microcode were read out of PCSX2 savestates, and the page's three.js shader
  reproduces them: the texture function, alpha test, blend rule, fog, the
  game's choice of lights per model, and the display's softening.
- **Grades itself against the hardware.** `tools/grade.py` takes PCSX2
  savestates, works out which cutscene and frame each is a picture of from the
  camera in EE RAM, renders that frame and scores it against PCSX2's own
  screenshot. Every rendering change is judged on all of the captures at once.

## Supported discs

| | executable | |
|---|---|---|
| *Trapt* (USA) | `SLUS_212.55` | SLUS-21255 |
| *Kagero II: Dark Illusion* (Japan/Asia) | `SLPS_254.45` | SLPS-25445 |

The two hold the same files under the same names. Only the executable's data
addresses differ, and [`tools/region.py`](tools/region.py) and
[`tools/web/region.js`](tools/web/region.js) are the only places those are
written down.

## Getting started

Python 3 with `numpy` and `Pillow` for the tools, Node 20 for the web tests.

```sh
python tools/region.py                   # find the disc, check its addresses
python tools/export.py --list            # every cutscene on it
python tools/export.py e001 out/         # play out/e001/index.html
python tools/extract.py out/models       # every model and texture
python tools/order.py                    # the story order, as an outline
node tools/web/test_all.js               # the page's test suites
```

`pick.html` can be opened straight off disk; it needs nothing installed.

## The notes

Most of the work is in [`docs/`](docs). Each file is a write-up of one part of
the game, with the addresses and the evidence:

| | |
|---|---|
| [`tools/README.md`](tools/README.md) | the disc's data formats and every tool |
| [`docs/EXECUTABLE.md`](docs/EXECUTABLE.md) | the retail executable's architecture |
| [`docs/CUTSCENES.md`](docs/CUTSCENES.md) | how cutscenes are stored and sequenced, the `.SSC` scene VM, and the story graph |
| [`docs/VIEWER.md`](docs/VIEWER.md) | the cutscene player, and the log of grading it against PCSX2 |
| [`docs/PS2SHADER.md`](docs/PS2SHADER.md) | the GS state and VU1 microcode, and the shader that reimplements them |
| [`docs/FONT.md`](docs/FONT.md) | the subtitle font baked into the executable |
| [`docs/STAGE.md`](docs/STAGE.md) | rooms, collision, doors and the 48 traps |
| [`docs/BROWSER.md`](docs/BROWSER.md) | the in-browser player |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | publishing the page and the exported site |

[`pcsx2/`](pcsx2) has patches that turn on the retail build's dormant debug
switches, and a probe that reads live game state over PCSX2's PINE port.

## Legal

This is an independent research project, not affiliated with Koei Tecmo.
*Trapt* and *Kagero* are their trademarks. The repository holds code and notes
only; you need your own copy of the game to use any of it.
