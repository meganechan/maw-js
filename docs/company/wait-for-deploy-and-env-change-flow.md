# Board Truth: `wait-for-deploy` lane + the env-change gate flow

**Status**: Adopted — epic-272 (kobo-273 lane · kobo-274 park-on-merge · kobo-275 deployed drain · kobo-276 env-change flow)
**Date**: 2026-07-12
**Scope**: company task-board lifecycle (`src/core/tasks`)

> **Invocation surfaces moved.** The `maw company task` / `maw task` CLI and the
> `maw_task` MCP tool were removed. The lanes, the store and the guards described
> below are unchanged and live; only *how you drive them* changed. Today the live
> surface is the **web board** and its `/api/tasks/*` routes. Lane moves that have
> no route yet are marked **[pending taskd cutover]** — no CLI replacement exists
> for them right now; do them from the board UI.

## Why `wait-for-deploy` exists

A merged PR is **not** a live change. maw-server runs from a checked-out repo and
must be redeployed (git pull + `pm2 restart`) for merged code to take effect. If a
card flipped straight to `done` on merge, the board would lie: it would say "shipped"
while the running server still has the old behavior — and a deploy could be forgotten.

`wait-for-deploy` is the honest middle state: **merged, awaiting deploy**. A card
parks here on merge and only reaches `done` once the change is actually live.

## Deploy-required cards

A card is **deploy-required** when landing its change needs a manual apply/restart:

- **has a PR** → deploy-required by default (Tony option a, kobo-274). `pr-watch`
  parks it in `wait-for-deploy` on merge instead of `done`. Override with an explicit
  `deployRequired: false` (a doc/board-only PR that needs no server deploy).
- **env-var changes** (e.g. `MAW_ROOM_COMPANY`) are deploy-required **by nature** —
  the new value only takes effect after the process is restarted with it set. These
  usually have **no PR**, so they ride the lanes manually (below).

Non-deploy cards (research, board-ops, a doc PR marked `deployRequired: false`) still
flip straight to `done` on merge — unchanged.

## The env-change gate flow (kobo-276)

An env-var change reuses the **existing** lanes — no new lane, no auto-detection:

```
need-answer  →  approve  →  wait-for-deploy  →  done
(value?)        (apply?)     (await restart)     (deployed)
```

1. **need-answer** — the value/target isn't settled yet; it's Tony's decision queue.
2. **approve** — the value is agreed; this is the yes/no gate to actually apply it.
3. **wait-for-deploy** — approved, but not yet applied: the operator must set the env
   var and restart the server. Parked here so the board shows "not live yet".
4. **done** — in this flow, reached via the mark-deployed drain (kobo-275) — the
   board's **🚀 Mark deployed** button, `POST /api/tasks/deployed` — pressed
   **after** the value is applied and the server restarted.

### Guard: on the blessed path, the deploy park cannot be skipped

Mark-deployed (`markDeployedTask`, behind `POST /api/tasks/deployed`) drains **only**
a `wait-for-deploy` card →
`done`. Called on any other state it refuses with `not_waiting` and changes nothing —
so on the intended deploy path (`… → wait-for-deploy → deployed`) a card cannot reach
`done` without first being parked and deployed. (Covered by
`src/core/tasks/store.test.ts` → "env-change gate flow".)

This is a **flow guard, not a hard state-lock.** `moveTask` / `completeTask` (the
generic move / done store operations) stay free-form — a human can still manually force any
card to `done` from any state. That escape hatch is deliberate (scope-out: kobo-276
adds no new enforcement); the guard only ensures the *deploy verb itself* can't skip
the park, keeping the intended path honest.

## Worked example

Change `MAW_ROOM_COMPANY` from `pgw` to `kobo`:

1. Create the card "set MAW_ROOM_COMPANY=kobo" (`POST /api/tasks/create`) → discuss
   value → move it to `need-answer` **[pending taskd cutover]**.
2. Value agreed → move to `approve` (Tony's yes/no gate) **[pending taskd cutover]**.
3. Approved → move to `wait-for-deploy` **[pending taskd cutover]**. Board now says
   "awaiting deploy".
4. Operator: `export MAW_ROOM_COMPANY=kobo` + `pm2 restart maw-server`.
5. Verify live, then press **🚀 Mark deployed** on the card → `done`.

Skipping step 3 and marking deployed from `approve` is refused
(`not_waiting`) — the board stays honest.
