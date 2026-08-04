/**
 * maw peers — file lock for concurrent writers (#572 nit 3).
 *
 * O_EXCL-style mutual exclusion on a sibling `.lock` file holding the owner's pid.
 * If the holder pid is gone (kill -0 → ESRCH) we steal the lock immediately rather
 * than waiting out the timeout. Synchronous (no await) so it composes with the
 * existing sync savePeers signature without a contract change.
 *
 * Sized for CLI use: 5s deadline, 50ms poll. peers.json writes are
 * sub-millisecond, so racing CLIs almost always succeed on first try.
 *
 * kobo-783 — this lock did NOT provide mutual exclusion, and the room store built on
 * it (appendRoomMessage) silently lost writes. Three defects, all fixed below:
 *   a. Acquisition was open(O_EXCL) THEN write(pid) — two syscalls, so the lock file
 *      was briefly visible while EMPTY. A contender landing in that gap read 0 bytes,
 *      parsed NaN, judged the LIVE holder stale, and unlinked its lock. Measured: two
 *      writers inside the same critical section, 3 of 80 room appends lost with both
 *      processes exiting 0. Now the pid is written to a private tmp file first and
 *      link()ed into place — link is atomic and fails EEXIST, so the lock file can
 *      never be observed without its pid already in it.
 *   b. A vanished or unreadable lock file was treated as STALE (steal). Absence is not
 *      staleness — it is a race with another stealer. Now only a lock we could actually
 *      read, whose pid is finite AND dead, is stolen; anything else retries.
 *   c. Release unlinked the lock unconditionally. After a steal that file belongs to a
 *      DIFFERENT process, so releasing ours admitted a third writer while that one was
 *      still inside its critical section. Now we only unlink a lock that still holds
 *      our own pid.
 * The same three defects existed in all five copies of this file (the vendored
 * duplicates are deliberate plugin isolation) and are fixed identically in each.
 */
import { openSync, closeSync, unlinkSync, writeSync, readSync, linkSync } from "fs";

const DEADLINE_MS = 5_000;
const POLL_MS = 50;

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin — short waits only */ }
}

/**
 * The pid recorded in an existing lock file, or null if we could not read one.
 * null means "unknown holder" — the file vanished mid-read, is unreadable, or (only
 * possible for a lock written by a pre-kobo-783 build) is empty/garbage. A null NEVER
 * authorises a steal: see defect (b) above.
 * fd-based read to prevent a path-TOCTOU symlink swap (#562 / #581). Fixed 64-byte
 * buffer — PIDs are ≤20 digits on every supported OS, so no fstatSync needed (also
 * avoids the CodeQL "stat-then-read" pattern).
 */
function readHolderPid(lockPath: string): number | null {
  let readFd: number | null = null;
  try {
    readFd = openSync(lockPath, "r");
    const buf = Buffer.alloc(64);
    const n = readSync(readFd, buf, 0, buf.length, 0);
    const pid = parseInt(buf.subarray(0, n).toString("utf-8").trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  } finally {
    if (readFd !== null) { try { closeSync(readFd); } catch { /* ignore */ } }
  }
}

/** Run fn() while holding an exclusive lock on `<path>.lock`. Synchronous. */
export function withPeersLock<T>(path: string, fn: () => T): T {
  const lockPath = `${path}.lock`;
  const tmpPath = `${lockPath}.${process.pid}.tmp`;
  const deadline = Date.now() + DEADLINE_MS;
  const myPid = String(process.pid);

  while (true) {
    let acquired = false;
    let tmpMade = false;
    try {
      // "wx" on the tmp too: O_CREAT|O_EXCL refuses an existing path INCLUDING a
      // planted symlink, so the fd we write the pid through is always our own file
      // (#562 / #581), and the write stays fd-based for the same reason.
      const fd = openSync(tmpPath, "wx");
      tmpMade = true;
      try {
        const pidBytes = Buffer.from(myPid);
        writeSync(fd, pidBytes, 0, pidBytes.length, 0);
      } finally { closeSync(fd); }
      _test.beforePublish?.(); // kobo-783 test seam — see lock.test.ts; undefined in production
      linkSync(tmpPath, lockPath); // atomic publish: EEXIST = someone else holds it
      acquired = true;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      // EEXIST before the tmp was ours = a leftover from a same-pid process that died
      // mid-acquire. Clear it and fall through to the normal poll; the next pass creates it.
      if (!tmpMade) { try { unlinkSync(tmpPath); } catch { /* next pass retries */ } }
    } finally {
      if (tmpMade) { try { unlinkSync(tmpPath); } catch { /* ignore */ } }
    }
    if (acquired) break;

    const holderPid = readHolderPid(lockPath);
    if (holderPid !== null && !isAlive(holderPid)) {
      try { unlinkSync(lockPath); } catch { /* another stealer got there first — fine */ }
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`peers lock timeout: pid ${holderPid ?? "unreadable"} still holds ${lockPath}`);
    }
    sleepSync(POLL_MS);
  }

  try {
    return fn();
  } finally {
    // Only OUR lock may be removed (defect c). Losing the read→unlink race here is
    // harmless: we leave the file, and the next contender's dead-pid check reclaims it.
    try { if (readHolderPid(lockPath) === process.pid) unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

/**
 * kobo-783 test seam — same shape as the store test seam.
 * `beforePublish` runs after the pid tmp file is written but BEFORE it is linked into
 * place. Widening that gap is what turns the lost-write race deterministic: under the
 * old open-then-write acquisition a 2ms delay there cost 30 of every 80 appends, so a
 * test that widens it and still loses nothing is pinning the atomicity itself rather
 * than the fact that the window happens to be narrow on the test machine.
 */
export const _test: { beforePublish?: () => void } = {};
