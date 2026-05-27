#!/usr/bin/env node
/**
 * email-digest.mjs — Phase 8.5 hourly digest cron entry point.
 *
 * Invoked from cron (or scripts/maintenance.sh) once an hour. Reads the
 * comment / webmention activity from the last DIGEST_WINDOW_MS window
 * and ships a tiny plain-text + HTML email via the SMTP credentials
 * defined in env.
 *
 * Exit 0 in all expected paths:
 *   - SMTP not configured            → noop
 *   - nothing new                    → noop
 *   - email sent                     → ok
 *
 * Exit 1 on a hard failure (DB missing AND SMTP set AND we tried to send).
 *
 * Cron line (UTC):
 *
 *   5 * * * * cd /opt/terminal-eighty && node scripts/email-digest.mjs >>/var/log/t80-digest.log 2>&1
 */

import { sendDigest } from '../admin/src/services/email.js';

const WINDOW_MS = Number(process.env.DIGEST_WINDOW_MS || 3600 * 1000); // last hour
const sinceMs = Date.now() - WINDOW_MS;

try {
  const result = await sendDigest({ sinceMs, dryRun: process.argv.includes('--dry-run') });
  if (result.sent) {
    console.log(`[email-digest] sent (${result.count} items)`);
  } else {
    console.log(`[email-digest] skipped: ${result.reason} (${result.count} items)`);
  }
  process.exit(0);
} catch (err) {
  console.error('[email-digest] failed:', err && err.message);
  process.exit(1);
}
