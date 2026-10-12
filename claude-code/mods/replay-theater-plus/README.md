# Replay Theater Plus

Step through the file changes of a turn, one diff at a time.

A fork of the [Replay Theater](../replay-theater) sample mod in this repository, with four
changes. The original is unchanged and still installable beside this one.

## What it adds

**Shell changes are recorded too.** The original records the `Edit`, `Write` and `MultiEdit`
tool calls. Anything a shell command writes, through `sed`, `mv`, a formatter or a generator,
never reaches those hooks and so never appears in the replay. Inside a git repository this fork
reads the repository's state before and after a Bash call and turns whatever moved into steps.

The diff shown is what that command changed, not everything the file has pending. A file that
already differed from HEAD has its content kept before the command runs and is diffed against
that copy; a file that was clean is diffed against HEAD, which is the same thing. Only a file
that was already changed and too large to keep falls back to its whole difference from HEAD,
and the step says so.

Nothing is measured for a background command, outside a git repository, or across a command
that moves VCS state (`git commit`, `add`, `checkout`, `reset`, `stash` and the rest), where
the reading would report the move rather than an edit. `/replay shell` turns the whole thing
off and on.

**The last ten turns are kept.** The original holds the last turn with edits. `◀◀ Older turn`
and `Newer turn ▶▶` walk back through them, hotkeys `b` and `f`, and `/replay 3` opens the turn
three back.

**Each step says who made it.** A step a subagent made is labelled with that agent's name, so
its work is told apart from the main loop's.

**The band composes.** The band above the prompt draws whatever is beneath it underneath its own
row, instead of replacing it, so another mod's band is not hidden. That matters next to Blast
Radius, which draws its file list in the same band on a terminal too narrow for a pane.

## Install

```sh
claude plugin marketplace add ChinmayaThakral/claude-code-playground
claude plugin install replay-theater-plus@claude-code-playground-mods
```

Then `/replay`, or press `r` when the hint appears above the prompt.

## Commands and keys

| | |
|---|---|
| `/replay` | open the most recent turn with changes |
| `/replay 3` | open the turn three back |
| `/replay shell` | turn shell-change recording off or on |
| `r` | open the replay from the hint above the prompt |
| `p` / `n` | previous and next step |
| `b` / `f` | older and newer turn |
| `c` | close |

## What it costs

No model calls and no network calls. A Bash command that is measured adds two `git` reads
before it and two after, plus one `git diff` per file that moved. Time inside those reads does
not count against the hook's budget, and the command itself runs either way: a failed reading
is dropped, never raised.

## Credit and licence

Forked from `claude-code/mods/replay-theater` in
[anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground),
Copyright 2026 Anthropic PBC, Apache-2.0. The diffing, the pane and the band are theirs. This
fork keeps the same licence.
