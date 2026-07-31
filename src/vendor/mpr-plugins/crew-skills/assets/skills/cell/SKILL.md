---
name: cell
description: Spawn a Cell v2 work cell: 2 tmux windows, 3 panes — main + review|worker. Use when user says /cell, "สร้าง cell", or wants a one-card execution cell.
---

# /cell — Cell v2: main + review|worker

Use this when Tony asks for “cell”, “สร้าง cell”, “กดสร้าง cell”, or an oracle needs the simple Cell v2 shape.

## What this creates

One oracle session with exactly the Cell v2 operating shape:

```text
Window/Page 1: main
  - talks to human
  - owns routing/reporting
  - keeps only one active card in the cell

Window/Page 2: review | worker
  - worker executes only
  - reviewer reviews only
  - worker and reviewer are separate panes
```

This is NOT the older `/head` strategic tier and NOT the older `/crew` 4-pane cell.

## Run

From the pane that should become `main`:

```bash
maw company cell spawn <company>
```

Example:

```bash
maw company cell spawn kobo
```

The binary verb is the source of truth for tmux layout. Do not hand-compose tmux split commands unless the verb fails.

## Cell rules

1. One active card per cell.
2. Main assigns the card to worker.
3. Worker executes and records evidence.
4. Worker sends to reviewer.
5. Reviewer either accepts back to main or rejects to worker on the same card.
6. Main starts the next card only after review passes and handoff is complete.

## Evidence commands

```bash
maw company task evidence <id> --scope producer --changed "..." --verified "..." --locus "..." --limitations "..."
maw company task ready-for-review <id>
maw company task external-wait <id> --trigger <signal>
maw company task reopen <id>
```

## Completion signal

Spawn is complete only when the command prints:

```text
✓ cell spawned — main=<pane> worker=<pane> (<model>) reviewer=<pane>
```

If it reports a missing contract asset, run:

```bash
maw crew-skills sync
```

then retry `/cell`.
