// @ts-check
/**
 * email.js — Phase 8.5 SMTP digest sender.
 *
 * Built so it never causes a "module not found" boot failure: nodemailer
 * is imported dynamically only when `sendDigest()` is actually called.
 * If `SMTP_HOST` is unset, every entry point is a friendly no-op.
 *
 * Environment
 * -----------
 *   SMTP_HOST          required (e.g. smtp.fastmail.com)
 *   SMTP_PORT          optional (default 465)
 *   SMTP_SECURE        optional 'true'|'false' (default true)
 *   SMTP_USER          required
 *   SMTP_PASS          required
 *   SMTP_FROM          required ("Your Name <you@example.com>")
 *   DIGEST_TO          required (comma-separated recipient list)
 *   DIGEST_INTERVAL    optional cron-style description for the email body
 *                      (we don't run the cron, just print it).
 *
 * Install on a host that wants the digest:
 *
 *   cd admin && npm install nodemailer
 *
 * Then add a cron:
 *
 *   0 * * * * cd /opt/terminal-eighty && node scripts/email-digest.mjs
 *
 * The script (and this module) exits 0 when SMTP isn't configured so
 * the cron line is safe to leave in place on hosts that don't want it.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function smtpConfig() {
  if (!process.env.SMTP_HOST) return null;
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== 'false',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'admin@localhost',
    to: (process.env.DIGEST_TO || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * Build the digest body from recently-arrived comments + webmentions.
 *
 * @param {{ sinceMs: number, dbPath?: string }} args
 */
export function buildDigest(args) {
  const dbPath =
    args?.dbPath || process.env.AUTH_DB_PATH || join(__dirname, '..', '..', 'data', 'auth.db');
  if (!existsSync(dbPath)) {
    return { count: 0, lines: ['(no database — nothing to send)'], text: '', html: '' };
  }
  const db = new Database(dbPath, { readonly: true });
  /** @type {any[]} */
  let webmentions = [];
  /** @type {any[]} */
  let activity = [];
  try {
    webmentions = db
      .prepare(
        `SELECT id, source, target, type, author_name, content, received_at, status
           FROM webmentions WHERE received_at >= ? ORDER BY received_at ASC`,
      )
      .all(args.sinceMs);
    activity = db
      .prepare(
        `SELECT id, ts, user, action, target, meta_json FROM activity_log
           WHERE ts >= ? AND action LIKE 'comment.%' ORDER BY ts ASC`,
      )
      .all(args.sinceMs);
  } catch (_) {
    /* schema not yet provisioned */
  } finally {
    db.close();
  }

  const lines = [];
  if (webmentions.length) {
    lines.push(`Webmentions (${webmentions.length}):`);
    for (const w of webmentions) {
      lines.push(
        ` • ${w.status.toUpperCase()} · ${w.type} · ${w.author_name || 'anonymous'} → ${w.target}`,
      );
    }
    lines.push('');
  }
  if (activity.length) {
    lines.push(`Comment activity (${activity.length}):`);
    for (const a of activity) {
      lines.push(` • ${a.action} · ${a.target || '—'} · ${a.user}`);
    }
    lines.push('');
  }
  if (!lines.length) {
    lines.push('Nothing new since the last digest.');
  }
  const text = lines.join('\n');
  const html =
    '<pre style="font-family:monospace;font-size:13px;line-height:1.5">' +
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
    '</pre>';
  return { count: webmentions.length + activity.length, lines, text, html };
}

/**
 * Send a digest of activity since `sinceMs`. Returns `{ sent: boolean,
 * reason?: string, count: number }`.
 *
 * @param {{ sinceMs: number, dbPath?: string, dryRun?: boolean }} args
 */
export async function sendDigest(args) {
  const cfg = smtpConfig();
  if (!cfg) return { sent: false, reason: 'SMTP not configured', count: 0 };
  if (!cfg.to.length) return { sent: false, reason: 'DIGEST_TO empty', count: 0 };

  const digest = buildDigest({ sinceMs: args.sinceMs, dbPath: args.dbPath });
  if (digest.count === 0) {
    return { sent: false, reason: 'nothing new', count: 0 };
  }
  if (args.dryRun) {
    console.log('[email] would send digest:\n' + digest.text);
    return { sent: false, reason: 'dry-run', count: digest.count };
  }
  let nodemailer;
  try {
    // Optional peer dep — left out of package.json so installs stay
    // lightweight. The `@ts-ignore` keeps tsc happy on hosts that
    // haven't run `npm i nodemailer`.
    // @ts-ignore — optional peer dep
    nodemailer = (await import('nodemailer')).default;
  } catch (_err) {
    return {
      sent: false,
      reason: 'nodemailer not installed — run `npm i nodemailer` in admin/',
      count: digest.count,
    };
  }
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  await transport.sendMail({
    from: cfg.from,
    to: cfg.to.join(', '),
    subject: `Terminal Eighty digest — ${digest.count} new`,
    text: digest.text,
    html: digest.html,
  });
  return { sent: true, count: digest.count };
}

export default { buildDigest, sendDigest };
