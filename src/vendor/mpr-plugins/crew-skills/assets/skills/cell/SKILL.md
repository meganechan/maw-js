---
name: cell
description: Give each oracle in a company roster the worker pane it needs to work the board. Use when user says /cell, "สร้าง cell", or wants oracle-based cells.
---

# /cell — worker pane for a company roster

Use this when Tony asks for “cell”, “สร้าง cell”, “กดสร้าง cell”, or an oracle/company needs its worker pane.

## What cell is (and is not)

`cell` is an **add-on**. It does not bring an oracle up — that is `maw wake`, and cell never calls it.

**The oracle's own pane IS the head.** Cell does not adopt it, rename its window, relaunch it, kill it — or stamp it. `wake` writes `@oracle_pane = {oracle}:head` when it launches the agent; cell only **reads** that stamp to find the head, and **refuses** the oracle when it is missing (`maw wake <oracle>` is the fix, and the refusal says so). It then adds one pane beside the head:

```text
The oracle's own window: the oracle, untouched   ← head
Window `cell-workers`:   worker                  ← the only thing cell creates
```

The head needs no contract and no launch line: the queue feeder dispatches work to panes **by role**, so nothing routes through the head (kobo-771).

This is NOT a caller-local split and NOT the older `/crew` 4-pane cell. (kobo-859: cell used to also create a reviewer pane; removed — review-requests already land on the worker pane, so the reviewer pane had no work of its own to do.)

## Run

From anywhere — a controlling pane, a plain shell, a session that belongs to no oracle. You do not have to be inside any oracle's pane.

```bash
maw company cell spawn <company>
maw company cell down  <company> [--force]
```

Example:

```bash
maw company cell spawn kobo
```

**`spawn`** walks the company roster and, for each oracle: resolves its tmux session, finds the pane already stamped `{oracle}:head` (refusing the oracle if there is none), writes that oracle's `worker-contract.md` into **its own repo** (`#{session_path}/ψ/active/cell`), then creates the worker pane if it is missing. An oracle that already has a worker gets nothing. The pane is created with its launch line as the tmux **creation argument** — nothing is ever typed into an existing pane.

An oracle that is **not running** is reported, not woken. Run `maw wake <oracle>` first, then re-run.

**`down`** kills only the pane whose `@oracle_pane` identity is `{that oracle}:worker`. A pane with no identity, or another oracle's, is never touched — window name and pane title are not selectors. **The head is never killed and never written to**, and it keeps its `{oracle}:head` stamp (that is exactly what a solo `maw wake` pane carries; dropping it would blind the feeder to an oracle that is still there). The busy guard fails closed unless `--force` is passed. `killed` counts panes verified gone; anything still standing is a PARTIAL teardown.

Both verbs count from a fresh `tmux list-panes` read afterwards, never from what their own commands returned.

## Verifying it worked

Ask tmux directly, not the summary line:

```bash
tmux list-panes -a -F '#{session_name}:#{window_name} @=#{@oracle_pane}'
```

`-a` is required. A `-t <session>` query answers for that session's **current window only**, and will read as a failure when nothing is wrong.

## Cell rules

1. One active card per oracle cell.
2. Head assigns the card to worker.
3. Worker executes and records evidence.
4. Worker hands off for review — a review-request lands on the worker pane itself (feeder dispatches by role, kobo-771), not a separate reviewer pane.
5. Head starts the next card only after review passes and handoff is complete.

## Evidence steps

**⚠️ no CLI — [pending taskd cutover].** The `maw task` / `maw company task` CLI and the
`maw_task` MCP tool were removed; `evidence`, `ready-for-review`, `external-wait` and
`reopen` have **no replacement invocation yet**. Record them on the **web board**
(`/api/tasks/*`) until the taskd cutover lands:

- **evidence** — scope (producer/consumer) + what changed · what was verified (and how) · locus · limitations
- **ready-for-review** — hand the card to the reviewer
- **external-wait** — park the card, naming the trigger signal it waits on
- **reopen** — pull a closed card back for rework

## Completion signal

```text
✓ cell spawn <company>: <ready> ready, <incomplete> incomplete, <not-running> not-running, <refused> refused (<N> oracles)
```

- **ready** — that oracle has a stamped worker, confirmed by re-reading tmux.
- **incomplete** — a creation call returned but no stamped pane appeared. The missing role is named in a `⚠ … INCOMPLETE` line above; the head is untouched and still stamped.
- **not-running** — no tmux session. Run `maw wake <oracle>` and re-run.
- **refused** — cell would have had to guess, so it did not act. Two causes: **no pane carries `{oracle}:head`** (an oracle running since before kobo-759 has no stamp until it is re-woken — run `maw wake <oracle>`); or `#{session_path}` is unreadable, so the oracle's repo is unknown — refused rather than anchoring the cell to the maw wrapper's repo, which is shared by every oracle.
- **orphan panes** — a pane in a `cell-workers`/`cell-worker`/`cell-reviewer` window with no `@oracle_pane` is named by both verbs, with the `tmux` line that fixes it. Cell selects on the identity option alone, so it can neither reuse nor remove such a pane.

A duplicate `{oracle}:head` is reported, the **lowest pane id wins** (oldest pane = the one the oracle has been living in), and the losers are **left completely alone** — a duplicate head can be a live agent in someone else's session (kobo-782).

A worker whose contract file is missing or empty **does not start at all** and says so in its pane: there is no path to a pane booting with an empty system prompt. If spawn reports a missing contract *asset*, run `maw crew-skills sync` and retry.

## Removed verbs

- **`self-spawn`** — gone. It was typed into the oracle's own pane with `send-keys`, and every working oracle runs `claude`, where a typed line lands as prompt text and never runs. `cell spawn pgw` once reported `1 ready · 0 repaired · 10 refused` having changed nothing at all. Cell types into no pane any more.
- **`up`** — replaced by `spawn`.
