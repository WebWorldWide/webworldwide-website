# Comment sign-in options

Readers can comment four ways. Two work out of the box; the other two turn
on when you add credentials to `docker/.env` (then run the auto-update, or
`docker compose up -d remark42` in `docker/`).

| Option | Status | Where it lives |
| --- | --- | --- |
| Guest (type any name) | On | Remark42 `AUTH_ANON=true` |
| Web World Wide account (username + password) | On | CMS, served at `https://comments.<domain>/account/` |
| GitHub | Needs an OAuth app | Remark42 |
| Google | Needs an OAuth client | Remark42 |
| Email link | Needs SMTP | Remark42 |

## Web World Wide accounts

- Passwords: Argon2id (m = 19 MiB, t = 2, p = 1, per-password salt), never
  stored or logged in readable form. 10+ characters, no username inside, a
  short common-password list.
- Five wrong passwords lock an account for 15 minutes, doubling up to 24
  hours; sign-in, sign-up and password changes are also rate-limited per IP.
- A registered name is unique (case-insensitive) and its comments carry the
  verified ✓. A guest typing the same name is a different identity without
  the ✓.
- There is no email reset. In the CMS, **Comments → Accounts** lets you give
  someone a one-time temporary password, or delete an account.
- Backups: the accounts live in the CMS database, which `scripts/backup.sh`
  encrypts with age and pushes to the private `www-blog-backups` repo nightly.

## GitHub

1. GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**.
2. Homepage URL: `https://webworldwide.online`
3. Authorization callback URL: `https://comments.webworldwide.online/auth/github/callback`
4. Create a client secret, then add to `docker/.env`:

   ```sh
   REMARK42_GITHUB_CID=<client id>
   REMARK42_GITHUB_CSEC=<client secret>
   ```

## Google

1. Google Cloud console → APIs & Services → Credentials → **Create
   credentials → OAuth client ID** (type: Web application). Set up the
   consent screen first if asked (External, app name "Web World Wide").
2. Authorized redirect URI: `https://comments.webworldwide.online/auth/google/callback`
3. Add to `docker/.env`:

   ```sh
   REMARK42_GOOGLE_CID=<client id>
   REMARK42_GOOGLE_CSEC=<client secret>
   ```

## Email sign-in link

Needs an SMTP service (for example Resend, Postmark, Fastmail or Gmail with an
app password). Add to `docker/.env`:

```sh
REMARK42_EMAIL_ENABLE=true
REMARK42_EMAIL_FROM=comments@webworldwide.online
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=<username>
SMTP_PASS=<password>
```

The same SMTP settings also turn on the CMS's email digest.
