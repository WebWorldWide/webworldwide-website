# Post-merge migration checklist

Phase 12 (redesign/full-stack) is feature-complete. Once `redesign/full-stack`
is merged into `main`, the steps below turn the new capabilities on. Every
item is one-time setup — the daily authoring loop needs none of this.

Items marked **required** are needed for the stack to keep working as before.
**Optional** entries enable a capability that the codebase supports but that
the operator hasn't asked for yet.

## Required

### 1. GitHub branch protection

Lock `main` so a green CI is the only path in.

1. Repo → **Settings → Branches → Add branch protection rule**
2. Branch name pattern: `main`
3. Require status checks to pass before merging — pick:
   - `quality` (from `quality.yml`)
   - `e2e` (from `e2e.yml`)
   - `lighthouse` (from `lighthouse.yml`)
4. Require pull request reviews: **1** (self-review is fine on a single-author repo)
5. Do not allow bypassing — even for admins

The three workflows already run on every push and PR, so this only formalizes
what's already happening on the redesign branch.

### 2. `deploy.yml` smoke check

`deploy.yml` is already wired to fire on push to `main`. The first push will
fail loudly in the GitHub Actions tab if any production secret is missing —
fix it there, no need to rebuild locally. Watch for:

- `SSH_HOST`, `SSH_USER`, `SSH_KEY` (Pi access)
- `CADDY_RELOAD_URL` (graceful reload after rsync)

## Optional — fediverse + cross-post

### 3. Bridgy Fed federation

The site already advertises itself as a `rel="me"` host. To federate it onto
the Fediverse:

1. Visit <https://fed.brid.gy/>
2. Enter your blog URL (`https://terminaleighty.com/`)
3. Click **Federate**
4. Verify that webmentions start arriving at `/webmention` (the admin's
   `Comments` view shows them in the moderation queue)

The single-user shortcut: set `WEBMENTION_AUTO_APPROVE=1` in the admin's
production `.env` so verified mentions skip the moderation queue.

### 4. Bluesky cross-post

To auto-post every new article to Bluesky on publish:

```bash
# admin/.env (production)
BLUESKY_HANDLE=you.bsky.social
BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

Generate the app password at <https://bsky.app/settings/app-passwords>. The
cross-post hook lives in `admin/services/publish.js` and is idempotent (it
writes the AT URI back into `webmentions.bluesky_uri`, so the second publish
of the same post never duplicates).

## Optional — operational cron

Two cron entries make the publish loop fully automatic. Both ship as POSIX
shell scripts in `scripts/`.

### 5. Scheduled publishing

Posts with a future `publish_at` flip live when the cron fires. Recommended
cadence: every 5 minutes.

```cron
*/5 * * * * /home/pi/terminal-eighty-blog/scripts/promote-scheduled.sh >> /home/pi/log/promote.log 2>&1
```

### 6. Webmention dump → Hugo data

Approved webmentions are baked into `site/data/webmentions/<slug>.json` so
they render at build time. Recommended cadence: every 5 minutes.

```cron
*/5 * * * * /home/pi/terminal-eighty-blog/scripts/dump-webmentions.sh >> /home/pi/log/webmentions.log 2>&1
```

Both scripts are idempotent and exit 0 on no-op, so they're safe to run on a
tight cadence.

## Optional — email digest

If you want a daily/weekly email summary of new comments, set the SMTP
quartet in `admin/.env`:

```bash
SMTP_HOST=smtp.fastmail.com
SMTP_PORT=465
SMTP_USER=you@yourdomain.com
SMTP_PASS=app-specific-password
DIGEST_RECIPIENT=you@yourdomain.com
DIGEST_CADENCE=daily   # or "weekly"
```

The digest service (`admin/services/digest.js`) is opt-in — it never runs
without `SMTP_HOST` set, so the absence of these vars is the off switch.

## Verification

After completing the required items above, this command on the Pi should
return all green:

```bash
npm run dev:check
```

It pings every service (Hugo, admin, Remark42, Umami, Postgres) and prints a
table with HTTP status codes. Any red line is an issue you can chase before
authoring your first post on the new stack.
