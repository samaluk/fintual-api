# fintual-api

**fintual-api** is a TypeScript toolkit for automating the retrieval, processing, and import of investment data from Fintual into Actual Budget. It combines direct API access with browser automation (via Playwright) to ensure robust data collection, validation, and integration.

## Overview

- **Fetches investment data** from Fintual using both public and authenticated APIs.
- **Automates browser scraping** with Playwright for data not available via API.
- **Validates and transforms** data using [valibot](https://valibot.dev/) schemas.
- **Imports transactions** into Actual Budget using the `@actual-app/api` package.
- **Includes automated tests** and examples for browser automation.

---

## Prerequisites

- Node.js (v20+ recommended)
- [Bun](https://bun.sh) (for development, optional)
- [Playwright](https://playwright.dev/) (for browser automation)

## Setup

1. **Install dependencies:**

   ```bash
   npm install
   # or, for development
   bun install
   ```

2. **Configure credentials:**
   - Create a `.env` file in the root directory based on `.env.example`:

     ```bash
     cp .env.example .env
     ```

   - Fill in your Fintual credentials and Actual Budget API key. Ensure you have the correct permissions for the API key.
   - **Fintual credentials:** You can find your Fintual account ID and goal ID in the URL when logged into your account. For example, if the URL is `https://app.fintual.cl/goal/123456`, then `123456` is your goal ID.
   - **Actual Budget API key:** You can find your API key in the Actual Budget settings, search the documentation.
   - **Do not commit real credentials.** Use environment variables or secrets management for production.

### Automatic 2FA Code Retrieval (Optional)

The login process can automatically retrieve 2FA codes from your email instead of requiring manual input. To enable this feature:

1. **Configure IMAP settings in your `.env` file:**

   ```env
   # IMAP settings for automatic 2FA code retrieval
   IMAP_HOST=imap.gmail.com          # Your email provider's IMAP server
   IMAP_PORT=993                      # IMAP port (993 for SSL)
   IMAP_USER=your-email@gmail.com    # Your email address
   IMAP_PASSWORD=your-app-password    # App password (see below)
   
   # Fintual email filter settings (optional, defaults shown)
   FINTUAL_2FA_SENDER=notificaciones@fintual.com
   FINTUAL_2FA_SUBJECT_PATTERN=código
   ```

2. **Gmail users:** You must use an [App Password](https://support.google.com/accounts/answer/185833) instead of your regular password:
   - Go to [Google Account Security](https://myaccount.google.com/security)
   - Enable 2-Step Verification if not already enabled
   - Go to "App passwords" and generate a new password for "Mail"
   - Use this 16-character password as `IMAP_PASSWORD`

3. **Other email providers:** Use your IMAP server settings:
   - **Outlook/Hotmail:** `IMAP_HOST=outlook.office365.com`
   - **Yahoo:** `IMAP_HOST=imap.mail.yahoo.com`
   - **iCloud:** `IMAP_HOST=imap.mail.me.com`

If IMAP is not configured or the automatic fetch fails, the system will fall back to manual code entry in the terminal.

---

## Usage

### 1. Scrape and Save Fintual Data

Fetch and process your Fintual investment data, saving it to `balance.json`:

```bash
npm run build
npm run scraper
```

### 2. Import Data into Actual Budget

Import processed data from `balance.json` into your Actual Budget instance:

```bash
npm run build
npm run actual
```

### 3. Run Both Steps Sequentially

Run both the scraper and the Actual Budget importer:

```bash
npm run start
```

### 4. Run Playwright Tests

Run browser-based tests and view reports:

```bash
npx playwright test
```

Test results and reports are available in the `playwright-report/` directory.

### 5. Schedule Daily Execution

- To run the workflow daily inside Docker, use the scheduler script:

  ```bash
  npm run build
  npm run scheduler
  ```

- The scheduler will run the import job automatically at the time specified in `src/scheduler.ts` (default: 23:04 America/Santiago). You can change the time by editing the cron pattern in that file.
- For one-off/manual runs, use the regular `npm run start` or `npm run actual`/`scraper` commands.

---

## Project Structure

- `src/scraper.ts` — Playwright script to log in to Fintual, fetch performance data, and save it as `balance.json`. Credentials and goal/account IDs are now loaded from environment variables (see `.env.example`).
- `src/actual.ts` — Imports data from `balance.json` into Actual Budget using the API. All sensitive data and dates are loaded from environment variables.
- `src/scheduler.ts` — Scheduler script for daily cron-like execution.
- `src/job.ts` — (If present) Shared job logic for scheduled runs.
- `tests/` — Automated and Playwright test specs.
- `tests-examples/` — Example Playwright tests.
- `playwright.config.ts` — Playwright configuration.
- `balance.json` — Output file with processed investment and deposit data.
- `tmp/actual-data/` — Local Actual Budget data cache.

---

## Notes & Tips

- **Sensitive Data:** Never commit real credentials or sensitive data. Use environment variables or secrets management for production.
- **Playwright Browsers:** If running Playwright for the first time, install browsers with:

  ```bash
  npx playwright install --with-deps
  ```

- **Customization:** Adjust goal/account IDs and credentials in the scripts to match your Fintual and Actual Budget setup.
- **Testing:** Add or update tests in `tests/` as you extend functionality. Run tests with your preferred runner (e.g., `npm test`, `npx vitest`).

---

This project was created using `bun init` (v1.1.2). [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
