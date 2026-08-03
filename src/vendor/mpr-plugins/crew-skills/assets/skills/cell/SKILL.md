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
✓ cell spawn <company>: <ready> ready, <repaired> repaired, <refused> refused/failed (<N> oracles)
```

Each target pane's local self-spawn prints before the head pane execs Claude:

```text
✓ cell spawned — head=<pane> worker=<pane> (<model>) reviewer=<pane>
```

After that, the head pane should be a live Claude process, not a shell.

If it reports a missing contract asset, run:

```bash
maw crew-skills sync
```

then retry `/cell`.
