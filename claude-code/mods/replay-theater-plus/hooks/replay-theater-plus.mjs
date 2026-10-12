// Replay Theater Plus
//
// A fork of Anthropic's Replay Theater sample mod (Apache-2.0, Copyright 2026
// Anthropic PBC), kept in its own folder so upstream changes never clobber it.
//
// What this fork adds over the original:
//   1. Shell changes. A Bash command that writes files (sed, mv, a formatter, a
//      generator) is invisible to the Edit/Write hooks. Inside a git repo this
//      reads the repo's state before and after such a call and turns whatever
//      moved into steps, showing what that command changed rather than
//      everything the file has pending.
//   2. More than one turn. The last TURNS_KEPT turns with edits are held, and
//      the pane walks back through them.
//   3. Who made it. Each step is labelled with the agent that made it, so a
//      subagent's edits are told apart from the main loop's.
//   4. The band composes. Its AbovePrompt hook draws whatever is beneath it
//      underneath its own row, so another mod's band is never hidden (notably
//      blast-radius's file list on a terminal too narrow for a pane).

const PANE_ID = "replay-theater";
const MAX_DIFF_LINES = 12;
const MAX_LCS_LINES = 400;
const TURNS_KEPT = 10;
const MAX_STORED_DIFF = 400;
const MAX_SHELL_FILES = 12;
const MAX_NEW_FILE_LINES = 200;
const MAX_UNTRACKED_STAT = 60;
// A file already changed before a shell command runs needs its content kept, or
// the diff afterwards shows the earlier change too. These bound that reading.
const MAX_SNAPSHOT_FILES = 25;
const MAX_SNAPSHOT_BYTES = 400000;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

// Shell commands that move VCS state rather than edit your files. Measuring
// across one of these reports the move itself (a commit empties the diff), so
// they are skipped.
const VCS_MOVE =
  /(^|[;&|]\s*)git\s+(commit|add|checkout|switch|restore|reset|stash|merge|rebase|pull|fetch|clone|am|cherry-pick|revert)\b/;

// `pending` fills during a turn; `turns` holds the finished ones, newest first.
const state = {
  pending: [],
  turns: [],
  turnIndex: 0,
  index: 0,
  isOpen: false,
  inBand: false,
  turnsSeen: 0,
  isShellOn: true,
};

const shownSteps = () => state.turns[state.turnIndex]?.steps ?? [];

function relPath(cwd, path) {
  if (!path) return "(unknown file)";
  if (cwd && path.startsWith(cwd + "/")) return path.slice(cwd.length + 1);
  return path;
}

function splitLines(text) {
  if (text === undefined || text === null || text === "") return [];
  const lines = String(text).split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// A line diff. Small inputs get an LCS diff, so unchanged lines show as
// context; large ones fall back to all-removed then all-added.
function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    return [...a.map((t) => ({ op: "-", t })), ...b.map((t) => ({ op: "+", t }))];
  }
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: " ", t: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", t: a[i++] });
    else out.push({ op: "+", t: b[j++] });
  }
  while (i < n) out.push({ op: "-", t: a[i++] });
  while (j < m) out.push({ op: "+", t: b[j++] });
  return trimContext(out);
}

// Keep one line of context around each change, so a long file's Write shows
// the changed lines, not the whole file.
function trimContext(lines) {
  if (!lines.some((l) => l.op !== " ")) return lines.slice(0, MAX_DIFF_LINES);
  const keep = lines.map((l, k) =>
    l.op !== " " || lines[k - 1]?.op && lines[k - 1].op !== " " || lines[k + 1]?.op && lines[k + 1].op !== " ");
  const out = [];
  let skipped = false;
  lines.forEach((l, k) => {
    if (keep[k]) { if (skipped && out.length) out.push({ op: "~", t: "⋯" }); out.push(l); skipped = false; }
    else skipped = true;
  });
  return out;
}

function countChanges(diff) {
  let add = 0, del = 0;
  for (const l of diff) { if (l.op === "+") add++; else if (l.op === "-") del++; }
  return { add, del };
}

// ---------------------------------------------------------------- the agent

// agentId -> a readable name, filled from $.agent.list() the first time an id
// is seen. The main loop has no id and gets no label.
const agentNames = new Map();

async function agentLabel($, agentId) {
  if (!agentId) return "";
  const known = agentNames.get(agentId);
  if (known) return known;
  try {
    for (const one of await $.agent.list()) {
      if (one?.id) agentNames.set(one.id, one.name || one.type || "subagent");
    }
  } catch { /* the list is a nicety, never a reason to miss the edit */ }
  const label = agentNames.get(agentId) ?? `agent ${String(agentId).slice(0, 6)}`;
  agentNames.set(agentId, label);
  return label;
}

// ------------------------------------------------------- shell changes, git

let repoSeen = { cwd: "", isRepo: false };

async function git($, cwd, args, timeoutMs = 10000) {
  const run = await $.process.run(["git", "--no-optional-locks", "-C", cwd, ...args], { timeoutMs });
  return run.exitCode === 0 ? run.stdout : "";
}

async function isRepo($, cwd) {
  if (!cwd) return false;
  if (repoSeen.cwd === cwd) return repoSeen.isRepo;
  let ok = false;
  try {
    ok = (await git($, cwd, ["rev-parse", "--is-inside-work-tree"], 5000)).trim() === "true";
  } catch { ok = false; }
  repoSeen = { cwd, isRepo: ok };
  return ok;
}

// The content of the files that already differ from HEAD, so a later diff can
// be taken against this moment rather than against HEAD. Null when there is
// too much of it to hold, which drops that file back to a diff against HEAD.
async function snapshot($, cwd, paths) {
  if (paths.length > MAX_SNAPSHOT_FILES) return null;
  const blobs = new Map();
  let budget = MAX_SNAPSHOT_BYTES;
  for (const path of paths) {
    try {
      const text = await $.fs.read(`${cwd}/${path}`);
      budget -= text.length;
      if (budget <= 0) return null;
      blobs.set(path, text);
    } catch { /* unreadable or binary: left out, so it falls back to HEAD */ }
  }
  return blobs;
}

// What the repo looks like right now: per-file add/del counts against HEAD
// (stable across `git add`, unlike a plain `git diff`), plus the untracked
// files with their size and mtime, so a rewrite of an untracked file shows up.
async function repoState($, cwd, withBlobs = false) {
  const numstat = await git($, cwd, ["diff", "HEAD", "--numstat"]);
  const porcelain = await git($, cwd, ["status", "--porcelain"]);
  const tracked = new Map();
  for (const line of numstat.split("\n")) {
    const parts = line.split("\t");
    if (parts.length >= 3 && parts[2]) tracked.set(parts[2], `${parts[0]},${parts[1]}`);
  }
  const untracked = new Map();
  const paths = porcelain
    .split("\n")
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .slice(0, MAX_UNTRACKED_STAT);
  for (const path of paths) {
    let mark = "?";
    try {
      const stat = await $.fs.stat(`${cwd}/${path}`);
      mark = `${stat.size},${stat.mtimeMs}`;
    } catch { /* gone or unreadable: the marker alone still says it exists */ }
    untracked.set(path, mark);
  }
  const blobs = withBlobs ? await snapshot($, cwd, [...tracked.keys(), ...untracked.keys()]) : null;
  return { tracked, untracked, blobs };
}

// Which paths differ between two readings.
function movedPaths(before, after) {
  const moved = [];
  for (const [path, mark] of after.tracked) if (before.tracked.get(path) !== mark) moved.push({ path, isTracked: true });
  for (const [path] of before.tracked) if (!after.tracked.has(path)) moved.push({ path, isTracked: true });
  for (const [path, mark] of after.untracked) if (before.untracked.get(path) !== mark) moved.push({ path, isTracked: false });
  return moved.slice(0, MAX_SHELL_FILES);
}

// A unified patch as the viewer's line list.
function patchToDiff(patch) {
  const out = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("@@")) { if (out.length) out.push({ op: "~", t: "⋯" }); continue; }
    if (line.startsWith("+")) out.push({ op: "+", t: line.slice(1) });
    else if (line.startsWith("-")) out.push({ op: "-", t: line.slice(1) });
    else if (line.startsWith(" ")) out.push({ op: " ", t: line.slice(1) });
    if (out.length >= MAX_STORED_DIFF) break;
  }
  return out;
}

// One step per file a shell command moved, showing what THAT command changed:
// a file already different from HEAD is diffed against the copy kept before the
// command, and one that was clean is diffed against HEAD, which is the same
// thing. Only when a file was already dirty and too large to keep does the step
// fall back to the whole difference from HEAD, and its note says so.
async function shellSteps($, cwd, before, after, command, agent) {
  const steps = [];
  for (const { path, isTracked } of movedPaths(before, after)) {
    const wasDirty = isTracked ? before.tracked.has(path) : before.untracked.has(path);
    const had = before.blobs?.get(path);
    let now = null;
    try { now = await $.fs.read(`${cwd}/${path}`); } catch { /* deleted, or not text */ }

    let diff = [];
    let note = "shell";

    if (wasDirty && had !== undefined) {
      diff = diffLines(had, now ?? "");
      if (now === null) note = "shell · deleted";
    } else if (wasDirty) {
      diff = patchToDiff(await git($, cwd, ["diff", "HEAD", "-U1", "--", path]));
      note = "shell · whole change from HEAD";
    } else if (isTracked) {
      diff = patchToDiff(await git($, cwd, ["diff", "HEAD", "-U1", "--", path]));
      if (now === null) note = "shell · deleted";
    } else if (now === null) {
      diff = [{ op: "~", t: "(gone)" }];
      note = "shell · deleted";
    } else {
      diff = splitLines(now).slice(0, MAX_NEW_FILE_LINES).map((t) => ({ op: "+", t }));
      note = "shell · new, untracked";
    }

    if (!diff.length) note = "shell · no line change";
    steps.push({ tool: "Bash", file: path, diff: diff.slice(0, MAX_STORED_DIFF), note, agent, command: String(command).slice(0, 120) });
  }
  return steps;
}

// ------------------------------------------------- one tool call, as steps

async function stepsFor($, e, agent) {
  let cwd = "";
  try { cwd = await $.session.cwd(); } catch { /* keep the full path */ }
  const file = relPath(cwd, e.file_path);
  if (e.tool === "Edit") {
    return [{ tool: "Edit", file, diff: diffLines(e.old_string, e.new_string), note: e.replace_all ? "replace all" : "", agent }];
  }
  if (e.tool === "MultiEdit" && Array.isArray(e.edits)) {
    return e.edits.map((ed, k) => ({
      tool: "MultiEdit", file, diff: diffLines(ed.old_string, ed.new_string), note: `edit ${k + 1} of ${e.edits.length}`, agent,
    }));
  }
  if (e.tool === "Write") {
    let before = "";
    let isNew = true;
    try {
      if (e.file_path && (await $.fs.exists(e.file_path))) {
        before = await $.fs.read(e.file_path);
        isNew = false;
      }
    } catch { /* unreadable: show it as a new file */ }
    return [{ tool: "Write", file, diff: diffLines(before, e.content), note: isNew ? "new file" : "rewrite", agent }];
  }
  return [];
}

// ------------------------------------------------------------------ the view

function hintText() {
  const n = shownSteps().length;
  const kept = state.turns.length;
  const more = kept > 1 ? ` · ${kept} turns kept` : "";
  return `▶ Replay: ${n} edit${n === 1 ? "" : "s"}${more} (press r)`;
}

async function openReplay($, turnIndex = 0) {
  if (!state.turns.length) return false;
  state.turnIndex = Math.max(0, Math.min(turnIndex, state.turns.length - 1));
  state.index = 0;
  state.isOpen = true;
  // The pane only takes the keyboard while nothing else holds it. Hide the
  // band first (it held the keys if its button was pressed), then open.
  $.ui.invalidate("ui.render");
  await $.clock.sleep(200);
  const rows = Math.min(MAX_DIFF_LINES + 10, 24);
  const placed = await $.ui.open({ id: PANE_ID, title: "Replay Theater", focus: true, closeOnEscape: true, rows, columns: 62 });
  // No room for a pane (a narrow terminal): draw the replay in the band.
  state.inBand = placed?.isPlaced === false;
  $.ui.invalidate("ui.render");
  return true;
}

// The replay view: one step at a time. Drawn in the Pane, or in the band
// above the prompt when the surface can't place a pane.
function replayView($, e, inBand) {
  const { Box, Text, Button } = $.ui.resolve(e);
  const maxDiff = inBand ? Math.max(3, Math.min(MAX_DIFF_LINES, (e.maxRows || 20) - 9)) : MAX_DIFF_LINES;
  const steps = shownSteps();
  const total = steps.length;
  if (!total) return Text({ dimColor: true, children: "No edits to replay." });
  const k = Math.max(0, Math.min(state.index, total - 1));
  const step = steps[k];
  const turn = state.turns[state.turnIndex];
  const width = Math.max(40, (e.bodyColumns || 100) - 4);
  const { add, del } = countChanges(step.diff);
  const shown = step.diff.slice(0, maxDiff);

  const diffRows = shown.map((l, n) => {
    const color = l.op === "+" ? "green" : l.op === "-" ? "red" : undefined;
    const line = `${l.op === "~" ? " " : l.op} ${l.t}`.slice(0, width);
    return Text({ key: `d${n}`, color, dimColor: l.op === " " || l.op === "~", wrap: "truncate-end", children: line });
  });
  if (step.diff.length > maxDiff) diffRows.push(Text({ key: "more", dimColor: true, children: `  … ${step.diff.length - maxDiff} more lines` }));
  if (!shown.length) diffRows.push(Text({ key: "empty", dimColor: true, children: "  (no line changes)" }));

  // The step list: one cell per step, the current one highlighted.
  const strip = steps.map((s, n) =>
    Text({ key: `s${n}`, inverse: n === k, color: n === k ? "cyan" : undefined, dimColor: n !== k, children: ` ${n + 1} ` }));

  const go = (to) => { state.index = Math.max(0, Math.min(to, total - 1)); $.ui.invalidate("ui.render"); };
  const goTurn = (to) => {
    state.turnIndex = Math.max(0, Math.min(to, state.turns.length - 1));
    state.index = 0;
    $.ui.invalidate("ui.render");
  };
  const close = () => {
    state.isOpen = false;
    if (!state.inBand) $.ui.close({ id: PANE_ID });
    state.inBand = false;
    $.ui.invalidate("ui.render");
  };

  const older = state.turnIndex + 1 < state.turns.length;
  const newer = state.turnIndex > 0;

  return Box({
    flexDirection: "column", borderStyle: "round", borderColor: "magenta", paddingX: 1,
    children: [
      Box({ flexDirection: "row", justifyContent: "space-between", children: [
        Text({ bold: true, color: "magenta", children: "▶ Replay Theater" }),
        Text({ bold: true, children: `step ${k + 1} of ${total}` }),
      ] }),
      Box({ flexDirection: "row", gap: 1, children: [
        Text({ dimColor: true, children: `turn ${turn?.n ?? "?"}` }),
        Text({ dimColor: true, children: state.turns.length > 1 ? `· ${state.turnIndex + 1} of ${state.turns.length} kept` : "" }),
      ] }),
      Box({ flexDirection: "row", children: strip }),
      Text({ bold: true, color: "cyan", wrap: "truncate-start", children: step.file }),
      Box({ flexDirection: "row", gap: 2, children: [
        Text({ dimColor: true, children: `${step.tool}${step.note ? " · " + step.note : ""}` }),
        Text({ color: "green", children: `+${add}` }),
        Text({ color: "red", children: `-${del}` }),
        step.agent ? Text({ color: "yellow", children: `⟐ ${step.agent}` }) : Text({ children: "" }),
      ] }),
      step.command ? Text({ dimColor: true, wrap: "truncate-end", children: `$ ${step.command}` }) : Text({ children: "" }),
      Box({ flexDirection: "column", marginTop: 1, children: diffRows }),
      Box({ flexDirection: "row", gap: 2, marginTop: 1, children: [
        Button({ key: "prev", label: "◀ Prev", hotkey: "p", onPress: () => go(k - 1) }),
        Button({ key: "next", label: "Next ▶", hotkey: "n", autoFocus: true, onPress: () => go(k + 1) }),
        older ? Button({ key: "older", label: "◀◀ Older turn", hotkey: "b", onPress: () => goTurn(state.turnIndex + 1) }) : Text({ children: "" }),
        newer ? Button({ key: "newer", label: "Newer turn ▶▶", hotkey: "f", onPress: () => goTurn(state.turnIndex - 1) }) : Text({ children: "" }),
        Button({ key: "close", label: "Close", hotkey: "c", onPress: close }),
      ] }),
    ],
  });
}

export function register(on) {
  on("session.start", async ($, e, next) => {
    const r = await next(e);
    await $.command.register({
      name: "replay",
      description: "Replay Theater Plus: step through recent file edits, shell changes included",
      argumentHint: "[turns back | shell]",
    });
    return r;
  });

  on("command.run", { command: "replay" }, async ($, e) => {
    const arg = String(e.args ?? "").trim().toLowerCase();
    if (arg === "shell") {
      state.isShellOn = !state.isShellOn;
      return { text: `Replay Theater Plus: shell-change recording ${state.isShellOn ? "on" : "off"}.` };
    }
    const back = Number.parseInt(arg, 10);
    const index = Number.isFinite(back) && back > 1 ? back - 1 : 0;
    if (index >= state.turns.length && state.turns.length) {
      return { text: `Replay Theater Plus: only ${state.turns.length} turn${state.turns.length === 1 ? "" : "s"} kept.` };
    }
    const opened = await openReplay($, index);
    return {
      text: opened
        ? `Replay Theater Plus: ${shownSteps().length} edits, turn ${state.turns[state.turnIndex]?.n}`
        : "Replay Theater Plus: no edits recorded yet.",
    };
  });

  // Record each edit, then let it run. Never blocks the call.
  on("tool.call", async ($, e, next) => {
    if (EDIT_TOOLS.has(e.tool)) {
      try {
        const agent = await agentLabel($, e.agentId);
        state.pending.push(...(await stepsFor($, e, agent)));
      } catch { /* recording must never stop the edit */ }
    }
    return next(e);
  });

  // A shell command that writes files: read the repo before and after, and
  // turn whatever moved into steps. Reads only; the command runs either way.
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    let cwd = "";
    let before = null;
    try {
      if (state.isShellOn && e.run_in_background !== true && !VCS_MOVE.test(String(e.command ?? ""))) {
        cwd = await $.session.cwd();
        if (await isRepo($, cwd)) before = await repoState($, cwd, true);
      }
    } catch { before = null; }

    const ran = await next(e);

    if (before) {
      try {
        const agent = await agentLabel($, e.agentId);
        const after = await repoState($, cwd);
        state.pending.push(...(await shellSteps($, cwd, before, after, e.command, agent)));
      } catch { /* a missed reading is never worth failing the call over */ }
    }
    return ran;
  });

  on("turn.start", ($, e, next) => {
    if (!e.agentId) state.pending = [];
    return next(e);
  });

  // At the end of a main-loop turn, the pending steps become a kept turn.
  on("turn.complete", async ($, e, next) => {
    const r = await next(e);
    if (e.agentId || !state.pending.length) return r;
    state.turnsSeen++;
    let at = 0;
    try { at = await $.clock.now(); } catch { /* the stamp is a nicety */ }
    state.turns.unshift({ n: state.turnsSeen, at, steps: state.pending });
    if (state.turns.length > TURNS_KEPT) state.turns.length = TURNS_KEPT;
    state.pending = [];
    state.turnIndex = 0;
    state.index = 0;
    $.ui.invalidate("ui.render");
    return r;
  });

  // The band above the prompt: the hint and a button that opens the pane. It
  // draws whatever is beneath it underneath its own row, so another mod's band
  // still shows.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (state.isOpen && state.inBand) return replayView($, e, true);
    if (!state.turns.length || state.isOpen) return next(e);
    const below = await next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    return Box({
      flexDirection: "column",
      children: [
        Box({
          flexDirection: "row", gap: 2, paddingX: 1,
          children: [
            Text({ color: "magenta", bold: true, children: hintText() }),
            Button({ key: "open-replay", label: "Replay", hotkey: "r", onPress: () => openReplay($, 0) }),
          ],
        }),
        below,
      ],
    });
  });

  // The pane.
  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e);
    return replayView($, e, false);
  });

  // The person closed the pane (Escape): keep our flag in step.
  on("ui.close", ($, e, next) => {
    if (e.id === PANE_ID || e.requestId === PANE_ID) state.isOpen = false;
    $.ui.invalidate("ui.render");
    return next(e);
  });
}
