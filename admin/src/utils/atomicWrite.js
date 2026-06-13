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
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * Atomically write `data` to `filePath`.
 *
 * @param {string} filePath absolute path of the file to write
 * @param {string | Buffer} data contents
 */
export function writeFileAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup so a failed write never litters tmp files.
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp may not exist if writeFileSync itself failed */
    }
    throw err;
  }
}
