---
name: cell
description: Spawn Cell v2 for a company roster: each oracle gets head + reviewer|worker tmux panes. Use when user says /cell, "สร้าง cell", or wants oracle-based cells.
---

# /cell — Cell v2: head + reviewer|worker

Use this when Tony asks for “cell”, “สร้าง cell”, “กดสร้าง cell”, or an oracle/company needs the simple Cell v2 shape.

## What this creates

`maw company cell spawn <company>` is company/oracle based. It wakes every oracle in the company roster and repairs each oracle's tmux session to this shape:

```text
Window/Page 1: head
  - talks to human
  - owns routing/reporting
  - keeps only one active card in the cell

Window/Page 2: reviewer | worker
  - worker executes only
  - reviewer reviews only
  - worker and reviewer are separate panes
```

This is NOT a caller-local split and NOT the older `/crew` 4-pane cell.

## Run

From any controlling pane:

```bash
maw company cell spawn <company>
maw company cell down <company> [--force]
```

Example:

```bash
maw company cell spawn kobo
```

The public spawn verb controls the company fleet: wake missing oracle sessions headlessly, locate each oracle session, then inject the local self-spawn into that oracle's pane so tmux layout is created in the correct place and the head pane launches Claude afterward.

The public down verb controls Cell v2 teardown for the company roster: it resolves each oracle session, requires an identifiable cell head pane before killing anything, honors busy guard unless `--force` is passed, and kills only the panes whose `@oracle_pane` identity is `{that oracle}:worker` or `{that oracle}:reviewer`. A pane carrying no identity, or another oracle's, is never killed — window name and pane title are not selectors. The head pane is never killed: it is the oracle's own adopted pane, so down stands it down instead (clears `@role`, removes the cell state files, keeps its `{oracle}:head` identity). `killed` counts panes verified gone; anything still standing is reported as a PARTIAL teardown and leaves the cell state in place.

The hidden internal verb is:

```bash
maw company cell self-spawn <company>
```

Do not run `self-spawn` by hand unless debugging a single target pane.

## Two spawn modes — chosen per pane, never by a flag

Spawn looks at what the target pane is actually running and picks the only route that pane can receive:

| Pane is running | Mode | What happens | Counted as |
|---|---|---|---|
| a shell (`zsh`, `bash`, …) | **inject** | the self-spawn + head launch line is typed into it | `repaired` (once head boots) |
| an agent REPL (`claude`, `node`, `bun`) | **prompt handoff** | `maw hey` delivers a message asking the AGENT to run self-spawn itself | `handed-off` |
| anything else, or unreadable | — | nothing is sent | `refused/failed` |

A shell line is never typed into an agent pane — it would land as prompt text and never run. A pane running neither a shell nor an agent (an editor, a pager, a database client) is left alone: a message typed at it is the same blind send.

**Handed-off is not done.** The agent acts on its own clock, so `handed-off` means "asked", not "cell is up". Re-run `maw company cell spawn <company>` afterwards to see it turn into `ready`.

**The head-contract caveat.** A head started by the inject mode receives its contract through `claude --append-system-prompt`. An agent that is **already running** cannot be handed a system prompt by anyone — so the handoff message tells it to read `ψ/active/cell/head-contract.md` from disk instead. That file is written by `self-spawn`, so the order is: run self-spawn first, then read the contract. An agent that skips the read is a head that never got its contract: alive, and behaving like a stranger.

## Cell rules

1. One active card per oracle cell.
2. Head assigns the card to worker.
3. Worker executes and records evidence.
4. Worker sends to reviewer.
5. Reviewer either accepts back to head or rejects to worker on the same card.
6. Head starts the next card only after review passes and handoff is complete.

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

Public company spawn is complete when the command prints:

```text
✓ cell spawn <company>: <ready> ready, <repaired> repaired, <handed-off> handed-off, <boot-failed> head-boot-failed, <refused> refused/failed (<N> oracles)
```

`repaired` means the head pane came up. A pane where the repair line ran but no
Claude prompt appeared counts as **head-boot-failed**, never repaired — that pane
is named in a `⚠ head boot FAILED` line above the summary; go look at it.

`handed-off` means an agent pane was asked (see spawn modes above) — each one is
named in a `↗ HANDED OFF` line. `refused/failed` is reserved for panes nothing
could be delivered to at all.

Each target pane's local self-spawn prints before the head pane starts Claude:

```text
✓ cell spawned — head=<pane> worker=<pane> (<model>) reviewer=<pane>
```

After that, the head pane should be a live Claude process, not a shell. If head
refuses to start, the pane says so instead: an empty/missing
`ψ/active/cell/head-contract.md` never boots a head with a blank system prompt.

If it reports a missing contract asset, run:

```bash
maw crew-skills sync
```

then retry `/cell`.
