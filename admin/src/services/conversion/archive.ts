// @ts-check
/**
 * archive.js — Phase 5c archive listing.
 *
 * For ZIP uploads, stream-walks the central directory with `yauzl` and
 * builds a flat JSON tree of entries. We never extract — the attachment
 * renderer (Phase 6) just shows the contents; users download the
 * original to actually use it.
 *
 * Outputs:
 *   - <basename>.tree.json — the entries list + summary counts.
 *
 * conversions_json shape:
 *   {
 *     "tree":        "/files/yyyy/mm/...-tree.json",
 *     "total_files": 42,
 *     "total_size":  1048576,
 *     "truncated":   false
 *   }
 *
 * Edge cases:
 *   - Encrypted ZIP — yauzl exposes a `0x01` general-purpose flag bit;
 *     we refuse and surface a clear error.
 *   - >MAX_ENTRIES entries — truncate the list, set `truncated: true`.
 *   - Archive byte size >MAX_BYTES — emit metadata-only summary (no
 *     entries) so we don't read the whole CD into RAM on a multi-GB
 *     archive. The user still gets the size and a stub tree.
 *   - Non-ZIP archive (TAR / 7z / RAR) — write a metadata-only summary
 *     so the upload still flips to ready instead of failing. Phase
 *     5c+ can extend with a tar walker.
 */

import { basename, extname, join } from 'path';
import { statSync, writeFileSync } from 'fs';
import yauzl from 'yauzl';

/**
 * Hard cap on entries written to the tree. ZIPs with millions of
 * entries (npm-style monorepos) would otherwise generate huge JSON.
 */
export const MAX_ENTRIES = 10_000;
/**
 * Skip enumerating entries above this archive size; emit metadata
 * only. 100 MB matches the upload cap and keeps central-directory
 * scans fast enough for a Pi worker.
 */
export const MAX_BYTES = 100 * 1024 * 1024;

/**
 * Drive the archive listing pipeline for one media row.
 *
 * @param {{
 *   row: Record<string, any>,
 *   diskPath: string,
 *   urlBase: string,
 *   diskDir: string,
 *   enqueueFollowupJob?: (mediaId: string, type: string) => void,
 * }} ctx
 * @returns {Promise<{ conversions: Record<string, any>, mediaPatch: Record<string, any> }>}
 */
export async function processArchive(ctx) {
  const { row, diskPath, urlBase, diskDir } = ctx;
  const archiveSize = safeSize(diskPath);
  const ext = extname(diskPath).toLowerCase();
  const mime = String(row?.mime_type || '').toLowerCase();
  const isZip =
    ext === '.zip' || mime === 'application/zip' || mime === 'application/x-zip-compressed';

  const baseName = stripExt(basename(diskPath));
  const treeName = `${baseName}.tree.json`;
  const treePath = join(diskDir, treeName);

  /** @type {{ entries: any[], total_files: number, total_size: number, truncated: boolean, format: string, note?: string }} */
  let summary;

  if (!isZip) {
    // Phase 5c+: tar / 7z / rar walkers. For now we record what we
    // know without trying to enumerate.
    summary = {
      entries: [],
      total_files: 0,
      total_size: archiveSize,
      truncated: false,
      format: ext.slice(1) || 'unknown',
      note: 'Entry listing not supported for this archive format.',
    };
  } else if (archiveSize > MAX_BYTES) {
    summary = {
      entries: [],
      total_files: 0,
      total_size: archiveSize,
      truncated: true,
      format: 'zip',
      note: `Archive exceeds ${MAX_BYTES} bytes; entry listing skipped.`,
    };
  } else {
    summary = await listZip(diskPath);
    summary.total_size = summary.total_size || archiveSize;
  }

  writeFileSync(treePath, JSON.stringify(summary), 'utf8');

  return {
    conversions: {
      tree: `${urlBase}/${treeName}`,
      total_files: summary.total_files,
      total_size: summary.total_size,
      truncated: summary.truncated,
    },
    mediaPatch: {},
  };
}

/**
 * Stream a ZIP's central directory and collect entries. Refuses
 * encrypted archives. Truncates at MAX_ENTRIES.
 *
 * @param {string} zipPath
 * @returns {Promise<{
 *   entries: any[], total_files: number, total_size: number,
 *   truncated: boolean, format: 'zip',
 * }>}
 */
function listZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(new Error(`Failed to open ZIP: ${err?.message || 'unknown error'}`));
        return;
      }
      /** @type {any[]} */
      const entries = [];
      let totalSize = 0;
      let totalFiles = 0;
      let truncated = false;
      let encrypted = false;

      zipfile.on('error', (e) => {
        reject(new Error(`ZIP read error: ${e.message}`));
      });
      zipfile.on('end', () => {
        if (encrypted) {
          reject(new Error('ZIP is encrypted — entry listing refused'));
          return;
        }
        resolve({
          entries,
          total_files: totalFiles,
          total_size: totalSize,
          truncated,
          format: 'zip',
        });
      });
      zipfile.on('entry', (entry) => {
        // The "encrypted" bit lives in bit 0 of generalPurposeBitFlag
        // per the PKZIP spec. Set means strong/weak encryption is
        // active and the entry isn't readable without a password.
        if ((entry.generalPurposeBitFlag & 0x1) === 0x1) {
          encrypted = true;
          // Close fast so 'end' fires and the rejection path runs.
          zipfile.close();
          return;
        }
        const isDir = /\/$/.test(entry.fileName);
        if (!isDir) {
          totalFiles += 1;
          totalSize += entry.uncompressedSize || 0;
        }
        if (entries.length < MAX_ENTRIES) {
          entries.push({
            path: entry.fileName,
            type: isDir ? 'dir' : 'file',
            size: entry.uncompressedSize || 0,
            compressed_size: entry.compressedSize || 0,
            modified: entryDate(entry),
          });
        } else if (!truncated) {
          truncated = true;
        }
        // Continue scanning the central directory.
        zipfile.readEntry();
      });
      zipfile.readEntry();
    });
  });
}

/**
 * Convert a yauzl entry's MS-DOS date fields into an ISO 8601 string.
 * Falls back to an empty string if the conversion fails — some
 * archives have invalid date fields (epoch 1980 underflow, etc.).
 *
 * @param {any} entry
 */
function entryDate(entry) {
  try {
    // yauzl exposes a helper through the entry's getLastModDate().
    if (typeof entry.getLastModDate === 'function') {
      const d = entry.getLastModDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) {
        return d.toISOString();
      }
    }
  } catch {
    /* fall through */
  }
  return '';
}

/**
 * @param {string} path
 */
function safeSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * @param {string} name
 */
function stripExt(name) {
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

export const __internal = {
  MAX_ENTRIES,
  MAX_BYTES,
  listZip,
  entryDate,
};
