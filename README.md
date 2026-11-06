# RAS Alerts

Emails IIT Kanpur RAS portal users when:

- a **new job opening** appears in Job Opening, or
- a **new notice** mentions a company in their Your Applications list. When
  someone applies to a new company, that company's existing notices are
  emailed once too.

One GitHub Actions workflow checks several RAS accounts in a single run and
sends every alert from one shared sender Gmail account to each person's own
address. The repository is public, which gives unlimited free Actions minutes
on standard runners.

## How data is protected

- **Secrets** (RAS passwords, Gmail token, state key) are GitHub Actions
  secrets. They are encrypted, cannot be viewed after saving, and are masked in
  logs.
- **Logs are public.** They show only each user's short id and counts, never
  email addresses, company names, or notice text. Use neutral ids such as
  `u1`, `u2`.
- **Saved state** (seen notices and openings, applied companies) is encrypted
  with AES-256-GCM using the `RAS_STATE_KEY` secret before it goes into the
  Actions cache.
- **Only people with write access can run the workflow.** It has no `push` or
  `pull_request` trigger.
- Every person whose RAS password is stored here must agree to it. They can
  revoke access at any time by changing their RAS password. Use this only in
  line with IITK RAS portal rules.

## One-time setup (maintainer)

### 1. Repository settings

In **Settings → Actions → General**, under *Fork pull request workflows from
outside collaborators*, select **Require approval for all outside
collaborators**. Never approve workflow runs on pull requests from people you
do not know.

### 2. Sender Gmail account

Use a dedicated Gmail account for sending, not a personal one.

1. In [Google Cloud Console](https://console.cloud.google.com), signed in as
   the sender account, create a project.
2. **APIs & Services → Library → Gmail API → Enable**.
3. **Google Auth Platform → Branding**: set an app name and support email.
   Under **Audience**, choose **External**, then click **Publish app** so that
   its status is **In production**. In Testing mode the refresh token expires
   after 7 days.
4. **Clients → Create client → Desktop app**. Download the JSON, then save it
   in this folder as `credentials.json`.
5. Run:

   ```powershell
   npm install
   npm run gmail-token
   ```

   Sign in as the sender account. Google shows an "unverified app" warning;
   choose **Advanced → Go to (app name)** and allow sending email. The token
   is saved to `.gmail-token.json`.
6. Add the three secrets in **Settings → Secrets and variables → Actions →
   Secrets**. Each command below copies one value to the clipboard without
   showing it; paste it into the matching secret before running the next one.

   ```powershell
   (Get-Content credentials.json | ConvertFrom-Json).installed.client_id | Set-Clipboard      # GMAIL_CLIENT_ID
   (Get-Content credentials.json | ConvertFrom-Json).installed.client_secret | Set-Clipboard  # GMAIL_CLIENT_SECRET
   (Get-Content .gmail-token.json | ConvertFrom-Json).refresh_token | Set-Clipboard           # GMAIL_REFRESH_TOKEN
   ```
7. Delete `credentials.json` and `.gmail-token.json`. Both are ignored by Git;
   never commit them.

### 3. State encryption key

Generate a random key, copy it to the clipboard, and save it as the secret
`RAS_STATE_KEY`:

```powershell
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | Set-Clipboard
```

If this key is changed later, every user starts a fresh baseline on the next
run (no email that run).

### 4. Trigger every hour with cron-job.org

GitHub's own schedule often delays or skips runs, so an external scheduler
starts the workflow instead.

1. On GitHub, create a **fine-grained personal access token**. Under
   **Repository access**, select only this repository. Under **Permissions**,
   set **Actions** to **Read and write**.
2. On [cron-job.org](https://cron-job.org), create a job that runs every 60
   minutes:
   - URL: `https://api.github.com/repos/<owner>/<repo>/actions/workflows/ras-notices.yml/dispatches`
   - Method: `POST`
   - Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
     `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`
   - Body: `{"ref":"main"}`
3. **Test run** should return `204 No Content`. Turn on failure notifications so
   you hear about an expired token.

## Add a person

1. Pick a neutral id with letters, numbers, or underscores, for example `u3`.
2. Add two **secrets**:
   - `RAS_EMAIL_U3`: their RAS login email
   - `RAS_PASSWORD_U3`: their RAS password (let them type it in)
3. Edit the **variable** `RAS_USERS` and add one line in the form
   `id:alert-email`. Add `:cycle-id` if their placement cycle differs from the
   default (`RAS_RC_ID` variable, or `18`):

   ```
   u1:first.person@gmail.com
   u2:second.person@gmail.com
   u3:third.person@gmail.com:19
   ```
4. In **Actions**, open **RAS notice email alerts** and click **Run workflow**.
   A new person's first run saves a baseline and sends no email.

**To remove a person**, delete their line from `RAS_USERS` and delete their two
secrets.

## Troubleshooting

Each user's result appears in the run log as `[id] ...`. If one person's check
fails, the others still run, and the run is marked failed.

| Log line | Fix |
| --- | --- |
| `Missing required GitHub Actions secret: RAS_EMAIL_U3` | Add the secret; the name must match the id in `RAS_USERS` in uppercase. |
| `RAS sign-in did not complete` | Wrong RAS email or password, or the portal asked for an OTP or CAPTCHA, which this workflow cannot complete. |
| `redirected to login when opening the configured placement cycle` | Set that person's cycle id (the number in `/student/rc/<id>/` on the portal). |
| `Gmail authorization failed (...)` | The three `GMAIL_*` secrets do not belong together, or the token expired or was revoked. Repeat step 2 above. |
| `Saved state could not be decrypted` | `RAS_STATE_KEY` changed. Each user gets a fresh baseline automatically. |

Each person adds about 20–30 seconds to a run. Each run reads up to 100 rows
from each list, so if more than 100 items are posted between two runs, the
older ones beyond that are missed.
