// @ts-check
/**
 * atomicWrite.js — crash-safe file writes for post content.
 *
 * `writeFileSync` truncates the target, THEN streams bytes; a crash or a
 * full disk midway leaves a half-written `.md` (lost/corrupted post).
 * Writing to a temp sibling and `rename(2)`-ing over the target is atomic
 * on the same filesystem: readers see either the complete old file or the
 * complete new one, never a torn write.
 */
import {
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Atomically + durably write `data` to `filePath`.
 *
 * Writes to a temp sibling, fsyncs the data to disk, renames over the
 * target (atomic on the same fs), then fsyncs the parent directory so the
 * rename itself survives a power loss. Without the fsyncs the rename is
 * atomic but not durable: on an SD-card / unclean shutdown (the Pi's
 * reality) the page cache can roll back to the pre-write file. fsync makes
 * the "never lose a save" guarantee real, not just torn-write-free.
 *
 * @param {string} filePath absolute path of the file to write
 * @param {string | Buffer} data contents
 */
export function writeFileAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
  let fd;
  try {
    fd = openSync(tmp, 'w');
    writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
    fsyncSync(fd); // flush file data before we expose it via rename
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, filePath);
    // fsync the directory so the rename (the new dirent) is durable too.
    syncDir(dirname(filePath));
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed / invalid fd */
      }
    }
    // Best-effort cleanup so a failed write never litters tmp files.
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp may not exist if the open itself failed */
    }
    throw err;
  }
}

/**
 * fsync a directory entry. Opening a directory for fsync is POSIX; on
 * platforms/filesystems that reject it (some don't allow O_RDONLY dir
 * fsync) we swallow the error — the data fsync already happened, and the
 * rename is still atomic, so this only degrades durability, never safety.
 *
 * @param {string} dir
 */
function syncDir(dir) {
  let dfd;
  try {
    dfd = openSync(realpathSync(dir), 'r');
    fsyncSync(dfd);
  } catch {
    /* best-effort: directory fsync unsupported here */
  } finally {
    if (dfd !== undefined) {
      try {
        closeSync(dfd);
      } catch {
        /* ignore */
      }
    }
  }
}
