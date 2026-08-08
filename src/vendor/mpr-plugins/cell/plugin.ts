import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "cell",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Deterministic Cell v2 spawn/down: 2 panes (head + worker). Module surface — `runCell` is invoked by `maw company cell`.",
  "author": "meganechan:hermes",
  "module": {
    "path": "./index.ts",
    "exports": ["runCell"]
  },
  "weight": 0,
  "license": "MIT",
  "schemaVersion": 1
} as const);
