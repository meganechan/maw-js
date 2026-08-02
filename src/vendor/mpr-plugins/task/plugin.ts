import { definePlugin } from "maw-js/sdk";

export default definePlugin({
  "name": "task",
  "version": "1.0.0",
  "entry": "./index.ts",
  "sdk": "^1.0.0",
  "description": "Company task board backbone (ADR 0001). Module surface — the reference implementation of the sign/merge gate. NOT routed from any entry point: the `maw company task` CLI and the `maw_task` MCP tool were both removed. Kept until kobo taskd reimplements sign/merge.",
  "author": "meganechan:patchwork",
  "module": {
    "path": "./index.ts",
    "exports": ["runTask"],
  },
  "weight": 0,
  "license": "MIT",
  "schemaVersion": 1
} as const);
