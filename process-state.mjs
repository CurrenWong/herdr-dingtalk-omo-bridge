// Liveness and single-instance helpers for the startup hook.
//
// The distinction that matters here is not "alive or dead" but "can we prove it
// is gone". A pid file is written by the process that owns it, and read by a
// hook whose job is to not start a second copy — DingTalk allows one Stream
// connection per app, so a duplicate silently shadows the working one. Treating
// an unreadable answer as death is exactly how that duplicate gets created.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Is this pid a running process?
 *
 * `EPERM` means yes: the process is there, it just belongs to another user or
 * session. Reporting it as dead started a second bridge alongside a live one.
 * Anything that is not a positive integer is not a pid we can check.
 */
export function pidAlive(pid) {
  const n = typeof pid === "string" ? Number(pid.trim()) : pid;
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * The pid recorded in a JSON state file, or null.
 *
 * A string, a float, `"1234abc"` or a missing field are all null: none of them
 * is a process id, and the caller needs to know the difference between "no
 * bridge" and "a bridge I cannot identify" before deciding to open a pane.
 */
export function pidFromStateFile(path) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const n = typeof raw?.pid === "string" ? Number(raw.pid.trim()) : raw?.pid;
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Take a single-instance lock, or report that someone else holds it.
 *
 * Herdr may run the startup hook again during a live handoff, and two runs both
 * see "no agent", both open a pane. The lock is a file created with O_EXCL; a
 * lock whose owner is gone is taken over, so a crashed run cannot wedge the
 * next one.
 */
export function acquireLock(path, { pid = process.pid, alive = pidAlive } = {}) {
  mkdirSync(dirname(path), { recursive: true });

  const create = () => {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, String(pid));
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };

  if (create()) return true;

  let holder = null;
  try {
    holder = Number(readFileSync(path, "utf8").trim());
  } catch {}
  if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder)) return false;

  // Stale — the owner is gone, or it is us from an earlier run.
  try {
    unlinkSync(path);
  } catch {
    return false;
  }
  return create();
}

export function releaseLock(path) {
  try {
    unlinkSync(path);
  } catch {}
}
