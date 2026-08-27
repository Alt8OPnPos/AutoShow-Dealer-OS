# Deploying via GitHub Actions (avoids mobile copy/paste entirely)

This deploys worker.js by pushing to GitHub - the actual `wrangler deploy`
command runs on GitHub's own Linux servers, not your phone, so the Android
workerd incompatibility and mobile paste corruption both become non-issues.

## Step 1: Create the repo (if you don't already have one for this)

On GitHub.com (works fine in mobile browser):
- New repository -> name it `autoshow-dealer-os`
- Keep it private if you prefer (this repo will contain your D1 database ID,
  not secret by itself, but no reason to make it public)

## Step 2: Upload three files to the repo root

Use GitHub's own "Add file -> Upload files" button in the repo - this
accepts file uploads directly, which is far more reliable than pasting
code into a text box on mobile.

Upload these three files (all already generated for you):
```
worker.js
wrangler.toml
.github/workflows/deploy.yml
```

Note the folder: the workflow file must live at the exact path
`.github/workflows/deploy.yml` inside the repo - GitHub only detects
Actions workflows in that specific folder.

## Step 3: Get a Cloudflare API token

On Cloudflare dashboard (mobile browser is fine):
- My Profile -> API Tokens -> Create Token
- Use the "Edit Cloudflare Workers" template
- Create Token, then COPY IT IMMEDIATELY - Cloudflare only shows it once

## Step 4: Get your Cloudflare Account ID

- Cloudflare dashboard -> Workers & Pages (or "Compute") -> right sidebar
  or account home shows "Account ID" - copy it

## Step 5: Add both as GitHub repo secrets

In your GitHub repo:
- Settings -> Secrets and variables -> Actions -> New repository secret
- Add secret named `CLOUDFLARE_API_TOKEN` -> paste the token from Step 3
- Add secret named `CLOUDFLARE_ACCOUNT_ID` -> paste the ID from Step 4

## Step 6: Trigger the deploy

Any push to the `main` branch now auto-deploys. Since uploading the files
in Step 2 already counts as a push, check the repo's "Actions" tab right
now - a deploy run should already be in progress or finished.

If it succeeded, your Worker is live at the same URL as before:
https://autoshow-dealer-os.sabelalogic.workers.dev

## Going forward

Any time you want to update the site: edit worker.js (ask Claude to make
the change, download the updated file), upload it to the GitHub repo
(overwriting the old one), and the deploy happens automatically within
about a minute. No wrangler, no Termux, no mobile paste needed ever again
for this project.
