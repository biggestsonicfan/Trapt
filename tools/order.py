"""The story order of Trapt's 154 cutscenes, read out of the ELF.

The disc names cutscenes `e001` ... `e430_01`, and that is *nearly* the order
they play in -- but not quite, and it says nothing about where the playable
stages sit between them.  The real order is four tables in `SLUS_212.55`,
driven by the chapter state machine `FUN_00173520` and the ending machine
`FUN_0032A7C0`.

    python order.py                 # the whole story order, as an outline
    python order.py --json          # the same, machine readable
    python order.py --playlist      # just the cutscene names, in order
    python order.py --script        # every line of dialogue, in story order
    python order.py --graph         # every branch point in the run
    python order.py --check         # cross-check the tables against the disc
    python order.py --tables        # the JSON site.py bakes into order.js
    python order.py --rules         # the branch-rule fixture test_order.js uses

How the game sequences them
---------------------------

**Cutscenes come in groups, not one at a time.**  `FUN_00323AE0` takes a
*group* index and `FUN_00323BC0` walks it, tearing down each RT player and
building the next, so several cutscenes play back to back with no return to
the caller.  The group table is at **`0x0045DB50`**, 38 records of 8 bytes::

    +0x00 u8   count            +0x01 u8[7]  cutscene ids

Group 0 is `e001 e002 e003` (the opening the attract loop plays); the last
group, 0x25, is `e322`..`e326`.  Between them the 38 groups cover cutscene ids
`0x00`-`0x40` -- every `e0xx`/`e1xx`/`e2xx`/`e3xx` scene -- **in ascending
group order, which is story order**.

**Chapters pick the groups.**  Three parallel tables indexed by the chapter
number at `app+0x408` (`FUN_00171BC0`), 15 chapters:

===============  ==============================================  ===============
address          record                                          read by
===============  ==============================================  ===============
`0x0042DD20`     `u8 count; u8 stage[3]` -- the chapter's stages  states 9, 0xC
`0x0042DD60`     `u8 group` -- plays before the chapter           state 6
`0x0042DD70`     `u8 [3][2]` -- per stage, (before, after)        states 9, 0xF
===============  ==============================================  ===============

`0xFF` means "no cutscene here".  So one chapter runs::

    group 0042DD60[c]                       state 6  (FUN_00172F20)
    for each stage s of the chapter:
        group 0042DD70[c][s][0]             state 9  (FUN_00172DF0)
        play stage 0042DD20[c][s]           state 0xC -> 0xD -> 0xE
        group 0042DD70[c][s][1]             state 0xF

The chapter loop is not a straight line: `FUN_00172B50` reads the stage's
result code, `FUN_00174250` picks the next stage and `FUN_001741B0` the next
chapter, and all three consult the story flags -- see `--graph`.

**Three story flags steer the whole run.**  They live in one byte at
`app+0x40E`.  `FUN_00173520` state 8 reads flag 0 to pick which of chapter
10's two stages runs; `FUN_00174250` reads flag 1 to decide whether chapter 14
plays a third stage; `FUN_001741B0` reads both to decide whether there *is* a
next chapter; and `FUN_001726F0` reads flags 1 and 2 to pick the finale group
(`0x23` `e129 e130`, `0x25` `e322`..`e326`, `0x24` `e230 e231`).  Nothing in
the ELF sets them -- that happens inside a stage -- but `0042DDD0` says which
flag each chapter *loses* when its stage is failed (`FUN_00172B50`).

**Endings are a second, branching machine.**  `FUN_0032A730(this, chapter)`
looks the chapter up in the 15x2 byte table at **`0x003872A0`** -- two routes
per chapter, selected by bit 0 of `app+0x80` -- to get one of **30 flow
records** at **`0x003872C0`**, `0x50` bytes each::

    +0x00 s16 step[16]      -1 end; < 0x4E a stage id; >= 0x4E cutscene id + 0x4E
    +0x20 s8  branch[16][3] (flag, next_if_clear, next_if_set); flag -1 = fall through

`FUN_0032A5D0` is the walk: with no flag it steps to `i+1`, otherwise it tests
bit `flag` of the 16-bit field at `app+0x40F` (cleared when the ending starts,
`FUN_0032AB50`) and jumps to one of the two successors.  A step landing on
`-1` ends the ending.  These records hold cutscene ids `0x41`-`0x99`, i.e.
every `e4xx_xx`, interleaved with stages `0x1A`-`0x43`.

Sixteen `e4xx` ids are in the registry but in no group and no flow record, and
five of those have no data on the disc at all -- see `--check`.
"""
import json
import struct
import sys

import afs

ELF = afs.ELF

# --- ELF virtual addresses (retail US, SLUS-21255) -------------------------
NAME_TABLE = 0x00386920        # 154 `const char *`, `FUN_00323AB0(id)`
FLAG_TABLE = 0x0045DA10        # 154 x 2 bytes, `FUN_00323A90(id)`
GROUP_TABLE = 0x0045DB50       # 38 x {u8 count; u8 id[7]}
CH_STAGES = 0x0042DD20         # 15 x {u8 count; u8 stage[3]}
CH_OPEN = 0x0042DD60           # 15 x u8 group
CH_STAGE_GROUPS = 0x0042DD70   # 15 x 3 x {u8 before, u8 after}
CH_FLAG = 0x0042DDD0           # 15 x s8 -- the flag a failed stage clears
ROUTE_TABLE = 0x003872A0       # 15 x 2 x u8 -> flow record
FLOW_TABLE = 0x003872C0        # 30 x 0x50

N_CUTSCENES = 154
N_GROUPS = 0x26
N_CHAPTERS = 15
N_FLOWS = 30
FLOW_STRIDE = 0x50
FLOW_STEPS = 16
CUTSCENE_BIAS = 0x4E           # a step >= this is a cutscene id, biased
NONE = 0xFF

# `FUN_001726F0` picks one of these three by the story flags, and the run can
# only reach it from chapter 14 (flag 1 clear) or chapter 15.
FINALES = ((0x23, 'chapter 14, story flag 1 clear'),
           (0x25, 'chapter 15, story flag 2 clear'),
           (0x24, 'chapter 15, story flag 2 set'))


class Story:
    """Every ordering table in the ELF, decoded."""

    def __init__(self, elf_path=ELF):
        with open(elf_path, 'rb') as f:
            self.blob = f.read()
        self.names = [self._cstr(self._u32(NAME_TABLE + i * 4))
                      for i in range(N_CUTSCENES)]
        self.groups = [self._group(g) for g in range(N_GROUPS)]
        self.chapters = [self._chapter(c) for c in range(N_CHAPTERS)]
        self.flows = [self._flow(r) for r in range(N_FLOWS)]
        self.routes = [(self._u8(ROUTE_TABLE + c * 2),
                        self._u8(ROUTE_TABLE + c * 2 + 1))
                       for c in range(N_CHAPTERS)]
        self.chapter_flags = [self._s8(CH_FLAG + c) for c in range(N_CHAPTERS)]

    # ---------------------------------------------------------- ELF access
    def _off(self, va):
        """Virtual address -> file offset; the one segment loads at 0x100000."""
        return va - 0x00100000 + 0x80

    def _u8(self, va):
        return self.blob[self._off(va)]

    def _s8(self, va):
        v = self.blob[self._off(va)]
        return v - 0x100 if v > 0x7F else v

    def _s16(self, va):
        return struct.unpack_from('<h', self.blob, self._off(va))[0]

    def _u32(self, va):
        return struct.unpack_from('<I', self.blob, self._off(va))[0]

    def _cstr(self, va):
        o = self._off(va)
        return self.blob[o:self.blob.index(b'\x00', o)].decode('ascii')

    # ------------------------------------------------------------- tables
    def _group(self, g):
        base = GROUP_TABLE + g * 8
        return [self._u8(base + 1 + i) for i in range(self._u8(base))]

    def _chapter(self, c):
        base = CH_STAGES + c * 4
        stages = []
        for s in range(self._u8(base)):
            pair = CH_STAGE_GROUPS + c * 6 + s * 2
            stages.append({'stage': self._u8(base + 1 + s),
                           'before': self._opt(self._u8(pair)),
                           'after': self._opt(self._u8(pair + 1))})
        return {'index': c, 'open': self._opt(self._u8(CH_OPEN + c)),
                'stages': stages}

    @staticmethod
    def _opt(group):
        return None if group == NONE else group

    def _flow(self, r):
        """One ending record, with the steps `FUN_0032A5D0` can actually reach."""
        base = FLOW_TABLE + r * FLOW_STRIDE
        steps = []
        for i in range(FLOW_STEPS):
            v = self._s16(base + i * 2)
            b = tuple(self._s8(base + 0x20 + i * 3 + k) for k in range(3))
            step = {'index': i, 'raw': v,
                    'branch': None if b[0] == -1 else
                              {'flag': b[0], 'clear': b[1], 'set': b[2]}}
            if v == -1:
                step['kind'] = 'end'
            elif v >= CUTSCENE_BIAS:
                step['kind'] = 'cutscene'
                step['id'] = v - CUTSCENE_BIAS
                step['name'] = self.names[v - CUTSCENE_BIAS]
            else:
                step['kind'] = 'stage'
                step['stage'] = v
            steps.append(step)
        return {'index': r, 'steps': steps, 'reachable': self._reach(steps)}

    @staticmethod
    def _reach(steps):
        """Step indices reachable from step 0, exactly as the walk resolves them.

        `FUN_0032A5D0` refuses any successor whose step is `-1`, so a record's
        tail of zero bytes is never entered and needs no heuristic to skip.
        """
        seen, queue = set(), [0]
        while queue:
            i = queue.pop(0)
            if not 0 <= i < FLOW_STEPS or i in seen or steps[i]['kind'] == 'end':
                continue
            seen.add(i)
            b = steps[i]['branch']
            queue.extend([i + 1] if b is None else [b['clear'], b['set']])
        return sorted(seen)

    # -------------------------------------------------------- the ordering
    def sections(self):
        """The whole story, as ordered sections of ordered items."""
        out = [{'kind': 'opening', 'title': 'Opening', 'index': 0,
                'items': self._group_items(0, 'attract loop / new game')}]
        for ch in self.chapters:
            items = self._group_items(ch['open'], 'chapter opening')
            for st in ch['stages']:
                items += self._group_items(st['before'],
                                           'before stage %02X' % st['stage'])
                items.append({'kind': 'stage', 'stage': st['stage'],
                              'note': 'playable stage'})
                items += self._group_items(st['after'],
                                           'after stage %02X' % st['stage'])
            out.append({'kind': 'chapter', 'index': ch['index'], 'items': items,
                        'title': 'Chapter %d' % (ch['index'] + 1)})
        out.append({'kind': 'finale', 'title': 'Finale', 'index': 0,
                    'items': [i for g, why in FINALES
                              for i in self._group_items(g, why)]})
        for c, routes in enumerate(self.routes):
            for route, rec in enumerate(routes):
                out.append({'kind': 'ending', 'index': rec, 'chapter': c,
                            'route': route,
                            'title': 'Ending -- chapter %d, route %d (flow %02X)'
                                     % (c + 1, route, rec),
                            'items': self._flow_items(self.flows[rec])})
        loose = self.unreferenced()
        if loose:
            out.append({'kind': 'unused', 'index': 0,
                        'title': 'In the registry, never played',
                        'items': [{'kind': 'cutscene', 'id': i, 'group': None,
                                   'name': self.names[i],
                                   'note': 'no group, no flow record'}
                                  for i in loose]})
        return out

    def _group_items(self, group, note):
        if group is None:
            return []
        return [{'kind': 'cutscene', 'id': i, 'name': self.names[i],
                 'group': group, 'note': note} for i in self.groups[group]]

    @staticmethod
    def _flow_items(flow):
        items = []
        for i in flow['reachable']:
            item = dict(flow['steps'][i])
            b = item['branch']
            item['note'] = ('' if not b else 'then flag %d ? step %d : step %d'
                            % (b['flag'], b['set'], b['clear']))
            items.append(item)
        return items

    def playlist(self, names=None):
        """Every cutscene, once, in story order.

        `names` filters to what actually exists (``export.list_cutscenes()``);
        a scene can appear in more than one ending route, so this de-dupes.
        """
        seen, out = set(), []
        for sec in self.sections():
            for it in sec['items']:
                n = it.get('name')
                if it['kind'] != 'cutscene' or n in seen:
                    continue
                if names is not None and n not in names:
                    continue
                seen.add(n)
                out.append(n)
        return out

    def referenced(self):
        """Cutscene ids some table actually plays."""
        ids = {i for g in self.groups for i in g}
        for flow in self.flows:
            for i in flow['reachable']:
                if flow['steps'][i]['kind'] == 'cutscene':
                    ids.add(flow['steps'][i]['id'])
        return ids

    def unreferenced(self):
        return [i for i in range(N_CUTSCENES) if i not in self.referenced()]

    # ------------------------------------------------- the branch rules
    # Four short functions in the ELF decide where the chapter machine goes
    # next.  They are code, not tables, so they are transcribed here rather
    # than read -- and mirrored again in `player.html`'s STORY block, which
    # `tools/test_order.js` checks against these.

    @staticmethod
    def first_stage(chapter, flags):
        """`FUN_00173520` state 8 -- which stage a chapter opens on.

        Only chapter 10 (index 9) has a choice, and it plays exactly one of
        its two stages: `0x11` when story flag 0 is already set on entry,
        `0x10` when it is not.
        """
        return 1 if chapter == 9 and not flags & 1 else 0

    @staticmethod
    def next_stage(chapter, sub, flags, count):
        """`FUN_00174250(chapter, sub, flags)` -- the next stage, or -1."""
        if chapter == 13:
            if sub == 2:
                return -1
            if sub == 1:
                return -1 if flags & 2 else 2
            if sub == 0:
                return 1
        elif chapter == 9:
            return -1                      # chapter 10 plays one stage, then out
        nxt = sub + 1
        return -1 if nxt >= count else nxt

    @staticmethod
    def next_chapter(chapter, flags):
        """`FUN_001741B0(chapter, flags)` -- the next chapter, or -1."""
        if chapter == 9 and flags & 1:
            return -1
        if chapter == 13 and not flags & 2:
            return -1
        return -1 if chapter + 1 > 14 else chapter + 1

    @staticmethod
    def finale_group(flags):
        """`FUN_001726F0` -- which group closes the game."""
        if not flags & 2:
            return 0x23                    # e129 e130
        return 0x25 if not flags & 4 else 0x24

    def rules(self):
        """Every (chapter, flags) outcome of the four rules, as a fixture.

        `player.html` transcribes the same four functions; `test_order.js`
        diffs its answers against this so the two cannot drift apart.
        """
        out = []
        for c in range(N_CHAPTERS):
            n = len(self.chapters[c]['stages'])
            for f in range(8):
                out.append({'c': c, 'f': f,
                            'first': self.first_stage(c, f),
                            'chapter': self.next_chapter(c, f),
                            'finale': self.finale_group(f),
                            'stages': [self.next_stage(c, s, f, n)
                                       for s in range(3)]})
        return out

    def tables(self, have=None):
        """Everything `player.html`'s story mode needs, as plain JSON."""
        keep = ('kind', 'branch', 'id', 'name', 'stage')
        return {
            'names': self.names,
            'groups': self.groups,
            'chapters': self.chapters,
            'routes': [list(r) for r in self.routes],
            'chapterFlags': self.chapter_flags,
            'flows': [{'index': f['index'], 'reachable': f['reachable'],
                       'steps': [{k: s[k] for k in keep if k in s}
                                 for s in f['steps']]}
                      for f in self.flows],
            'have': sorted(have) if have is not None else None,
        }

    def stages(self):
        """Every stage id the two machines enter, chapters first."""
        main = [st['stage'] for ch in self.chapters for st in ch['stages']]
        ending = []
        for flow in self.flows:
            for i in flow['reachable']:
                st = flow['steps'][i]
                if st['kind'] == 'stage' and st['stage'] not in ending:
                    ending.append(st['stage'])
        return main, ending


# ---------------------------------------------------------------- dialogue

def dialogue(name, disc):
    """`(frame, speaker, lines, voice)` for one cutscene, frame-ordered.

    Every `.ssc` in the bundle is scanned rather than just `rt_<name>_txt.ssc`:
    a few scenes put their `0x60` calls straight in another track.
    """
    import ssc
    members = disc.members('DATA/RT/%s/RT_%s.ARC' % (name.upper(), name.upper()))
    cues = []
    for member, blob in sorted(members.items()):
        if not member.endswith('.ssc'):
            continue
        try:
            cues.extend(ssc.dialogue(blob))
        except Exception:                  # a track we cannot parse is not fatal
            continue
    return sorted((c for c in cues if c[0] is not None), key=lambda c: c[0])


# -------------------------------------------------------------------- CLI

def _outline(story, out=sys.stdout):
    w = out.write
    w('Trapt story order -- %d cutscenes, %d groups, %d chapters, %d ending flows\n\n'
      % (N_CUTSCENES, N_GROUPS, N_CHAPTERS, N_FLOWS))
    for sec in story.sections():
        w('%s\n' % sec['title'])
        for it in sec['items']:
            if it['kind'] == 'stage':
                w('    %-10s stage %02X\n' % ('', it['stage']))
            elif it['kind'] == 'cutscene':
                g = '' if it.get('group') is None else 'group %02X' % it['group']
                w('    %-10s %-10s %s\n' % (g, it['name'], it['note']))
            else:
                w('    %-10s %s\n' % ('', it['note']))
        w('\n')
    main, ending = story.stages()
    w('%d stages in the chapters (%02X-%02X), %d more in the endings (%02X-%02X)\n'
      % (len(main), min(main), max(main), len(ending), min(ending), max(ending)))


def _graph(story, out=sys.stdout):
    """Every point in the run where the game asks the story which way to go."""
    w = out.write
    w('The chapter machine, FUN_00173520, and where it branches.\n\n')
    w('Three story flags live in one byte at app+0x40E.  Nothing in the ELF\n'
      'sets them -- that happens inside a stage -- but 0042DDD0 says which\n'
      'flag a chapter loses when its stage is failed (FUN_00172B50), and\n'
      'FUN_00174250 / FUN_001741B0 / FUN_001726F0 read them to pick the next\n'
      'stage, the next chapter and the finale.  Only eight flag states exist,\n'
      'so this enumerates every one a chapter can be entered with.\n\n')

    reach = [set() for _ in range(N_CHAPTERS)]
    reach[0].add(0)
    for c in range(N_CHAPTERS):
        own = story.chapter_flags[c]
        for flags in sorted(reach[c]):
            for bit in ((0,) if own < 0 else (0, 1 << own)):
                nxt = story.next_chapter(c, flags | bit)
                if nxt >= 0:
                    reach[nxt].add(flags | bit)

    for c, ch in enumerate(story.chapters):
        own = story.chapter_flags[c]
        w('Chapter %-2d  stages %s%s\n'
          % (c + 1, ' '.join('%02X' % st['stage'] for st in ch['stages']),
             '' if own < 0 else '   reads story flag %d' % own))
        seen = set()
        for entry in sorted(reach[c]):
            for bit in ((0,) if own < 0 else (0, 1 << own)):
                flags = entry | bit
                if flags in seen:
                    continue
                seen.add(flags)
                walk, st = [], story.first_stage(c, flags)
                while st >= 0:
                    walk.append('%02X' % ch['stages'][st]['stage'])
                    st = story.next_stage(c, st, flags, len(ch['stages']))
                nxt = story.next_chapter(c, flags)
                if nxt >= 0:
                    after = 'chapter %d' % (nxt + 1)
                elif c == 9:
                    after = 'the machine exits (app+0x7F = 1) -- no finale'
                else:
                    after = ('the finale, group %02X'
                             % story.finale_group(flags))
                w('    flags %d -> plays %-9s then %s\n'
                  % (flags, ' '.join(walk), after))
        w('    ending routes: flow %02X / flow %02X\n' % story.routes[c])

    w('\nThe finale, FUN_001726F0 -- reached only where FUN_001741B0 has no\n'
      'next chapter, so from chapter 14 with flag 1 clear, or chapter 15:\n')
    for flags, why in ((0, 'flag 1 clear'), (2, 'flag 1 set, flag 2 clear'),
                       (6, 'flags 1 and 2 set')):
        g = story.finale_group(flags)
        w('    %-24s group %02X   %s\n'
          % (why, g, ' '.join(story.names[i] for i in story.groups[g])))

    w('\nBranches inside the ending flows (bit of app+0x40F):\n')
    for flow in story.flows:
        for i in flow['reachable']:
            b = flow['steps'][i]['branch']
            if b:
                w('    flow %02X step %-2d  flag %-2d  clear -> %d, set -> %d\n'
                  % (flow['index'], i, b['flag'], b['clear'], b['set']))


def _check(story, out=sys.stdout):
    import export
    w = out.write
    on_disc = set(export.list_cutscenes())
    w('registry %d, on disc %d\n' % (N_CUTSCENES, len(on_disc)))
    missing = [n for n in story.names if n not in on_disc]
    w('\nin the registry, no data on the disc (%d):\n  %s\n'
      % (len(missing), ' '.join(missing)))
    loose = [story.names[i] for i in story.unreferenced()]
    w('\nin the registry, no table plays them (%d):\n  %s\n'
      % (len(loose), ' '.join(loose)))
    extra = sorted(on_disc - set(story.names))
    w('\non the disc, not in the registry (%d):\n  %s\n'
      % (len(extra), ' '.join(extra) or '-'))
    order = story.playlist(on_disc)
    w('\nplayable in story order: %d\n' % len(order))
    unordered = sorted(on_disc - set(order))
    if unordered:
        w('on the disc but not in the order (%d):\n  %s\n'
          % (len(unordered), ' '.join(unordered)))


def _script(story, out=sys.stdout):
    import export
    import scene as scene_mod
    disc = scene_mod.Disc()
    names = set(export.list_cutscenes())
    w, total = out.write, 0
    for sec in story.sections():
        head = False
        for it in sec['items']:
            if it['kind'] != 'cutscene' or it['name'] not in names:
                continue
            cues = dialogue(it['name'], disc)
            if not cues:
                continue
            if not head:
                w('\n== %s ==\n' % sec['title'])
                head = True
            w('\n-- %s (%s)\n' % (it['name'], it['note']))
            for frame, speaker, lines, voice in cues:
                w('%6d  %-10s %-15s %s\n'
                  % (frame, speaker or '', voice or '-', ' / '.join(lines)))
                total += 1
    w('\n%d cues\n' % total)


def main():
    args = sys.argv[1:]
    try:                     # the script still has Japanese in it; cp1252 chokes
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass
    story = Story()
    if '--json' in args:
        json.dump({'names': story.names, 'groups': story.groups,
                   'chapters': story.chapters, 'routes': story.routes,
                   'flows': story.flows, 'sections': story.sections(),
                   'chapter_flags': story.chapter_flags,
                   'playlist': story.playlist()},
                  sys.stdout, indent=1)
        print()
    elif '--playlist' in args:
        names = None
        if '--on-disc' in args:
            import export
            names = set(export.list_cutscenes())
        print('\n'.join(story.playlist(names)))
    elif '--script' in args:
        _script(story)
    elif '--graph' in args:
        _graph(story)
    elif '--tables' in args:            # what site.py bakes into order.js
        json.dump(story.tables(), sys.stdout, separators=(',', ':'))
    elif '--rules' in args:             # the fixture test_order.js diffs against
        json.dump(story.rules(), sys.stdout, separators=(',', ':'))
    elif '--check' in args:
        _check(story)
    else:
        _outline(story)


if __name__ == '__main__':
    main()
