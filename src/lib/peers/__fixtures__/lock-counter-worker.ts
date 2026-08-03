// kobo-783 — a REAL separate OS process, spawned by ../lock.test.ts. Appends `count` ids to
// one shared JSON file under withPeersLock, using the SAME read-modify-write shape that
// silently lost room messages (read the whole array, push, write the whole array back): if
// two processes are ever inside the lock at once, the later write drops the earlier's entry.
// A same-process simulation cannot reproduce this — JS run-to-completion is already immune —
// so this has to be a separate OS process, same technique as src/core/room/store.test.ts.
import { readFileSync, writeFileSync } from "fs";
import { withPeersLock, _test } from "../lock";

const [, , target, prefix, countArg, widenArg] = process.argv;
const count = parseInt(countArg, 10);
const widen = parseInt(widenArg ?? "0", 10);

// Widen the acquire window (pid written, not yet published) on purpose — this is what makes
// the test deterministic instead of hardware-dependent. See the _test doc comment in ../lock.ts.
if (widen > 0) _test.beforePublish = () => { const end = Date.now() + widen; while (Date.now() < end) { /* spin */ } };

for (let i = 0; i < count; i++) {
  withPeersLock(target, () => {
    const cur = JSON.parse(readFileSync(target, "utf8")) as string[];
    cur.push(`${prefix}-${i}`);
    writeFileSync(target, JSON.stringify(cur));
  });
}
