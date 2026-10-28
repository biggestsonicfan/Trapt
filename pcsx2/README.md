# PCSX2 helpers

- `DCFBB290.pnach`: the debug-script switch and the Story Mode room override
  for the US disc (SLUS-21255), named by its CRC. Drop it in PCSX2's
  `cheats` folder and enable only one of its patches.
- `trapt-debug-scripts.pnach`, `trapt-debug-room-first.pnach`: the same two
  patches as separate files, for another disc's CRC. Do not enable both.
- `pine-probe.mjs`: reads live game state over PCSX2's PINE port (28011).
  Needs PCSX2 with `EnablePINE=true` and the PCSX2-MCP clone in `hkmodd/`.
