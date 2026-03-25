# Fintual HTTP capture (reverse-engineering notes)

This document describes what we observed when recording traffic with **agent-browser** (Chrome CDP, equivalent to DevTools Network). It contains **no secrets**; run [`bin/capture-fintual-har.sh`](../bin/capture-fintual-har.sh) locally with your own credentials to capture cookies and full bodies.

## Requirements

- **agent-browser ≥ 0.22** (older builds lack `network har start` / `network har stop`). Upgrade with `npm i -g agent-browser@latest` or Homebrew.
- `agent-browser install` for Chrome.

## Observed request chain (unauthenticated → login attempt)

1. **GET** `https://fintual.cl/f/sign-in/` — loads the Next.js app; the SPA issues GraphQL probes as below.
2. **POST** `https://fintual.cl/gql/` — operations such as `IntercomUserHash`, `CurrentUser` with JSON body `{ operationName, variables, query }`. **401** when there is no session (`ApiError::Unauthorized`).
3. **POST** `https://fintual.cl/auth/sessions/initiate_login` — JSON body:

   ```json
   { "email": "<string>", "password": "<string>" }
   ```

   Request headers included:

   - `Content-Type: application/json`
   - `Referer: https://fintual.cl/f/sign-in/`
   - `User-Agent`: Chromium (HeadlessChrome in automation)

   On **invalid credentials**, response was **401** and we did **not** see `Set-Cookie` in the capture (session not established).

   On **success with e-mail 2FA**, response is typically **201** with a body such as `{"message":"Login initiated"}`.

4. **POST** `https://fintual.cl/auth/sessions/finalize_login_web` — after the user receives the e-mail code, JSON body:

   ```json
   { "email": "<string>", "password": "<string>", "code": "<6-digit string>" }
   ```

   Reuse the **`Cookie`** header from the session established by **GET** sign-in and **`initiate_login`** (often includes `_fintual_session_cookie`). Use `Referer: https://fintual.cl/f/sign-in/`, `Origin: https://fintual.cl`, `Accept: application/json`.

5. **POST** `https://fintual.cl/gql/` — same shape as in [`src/fintual/new-performance.ts`](../src/fintual/new-performance.ts): `operationName: "GoalInvestedBalanceGraphDataPoints"`, variables `goalId`, `timeIntervalCode`. **401** without a valid session.

## What you must capture locally (success + 2FA)

Use **Preserve log** in Chrome DevTools Network, or **`network har start` … `har stop`** in agent-browser, so requests are not dropped when the app navigates after 2FA.

### Checklist after a headed capture

- [ ] **GET** `https://fintual.cl/f/sign-in/` — any **`Set-Cookie`** (e.g. `_fintual_session_cookie`).
- [ ] **POST** `.../auth/sessions/initiate_login` — status **201** (2FA path) or **200** (if no 2FA), response **`Set-Cookie`** if any.
- [ ] **POST** `.../auth/sessions/finalize_login_web` — URL, JSON body, request cookies, response status and **`Set-Cookie`** for the logged-in session.
- [ ] **POST** `https://fintual.cl/gql/` for `GoalInvestedBalanceGraphDataPoints` with **200** and data.
- [ ] Whether **`localStorage` / `sessionStorage`** holds extra tokens (`agent-browser storage local`).

## Programmatic follow-up in this repo

- [`src/fintual/http-session.ts`](../src/fintual/http-session.ts) — `loadSignInPage`, `initiateLogin`, `finalizeLoginWeb`, cookie jar, `postGql`.
- [`src/fintual/http-sync.ts`](../src/fintual/http-sync.ts) — production sync: initiate (201) → Gmail IMAP 2FA → `finalize_login_web` → GraphQL (`GMAIL_*` / `FINTUAL_2FA_*`).

**Note:** Node `fetch` may not receive `Set-Cookie` from Fintual/Cloudflare in some environments. If HTTP login fails, compare cookies in a HAR with a manual browser login.

## HAR output location

Captures are written to **`tmp/fintual-capture.har`** (the `tmp/` directory is gitignored). Do not commit HAR files; they can contain cookies and PII.

## Repo helpers

| File | Role |
|------|------|
| [`bin/capture-fintual-har.sh`](../bin/capture-fintual-har.sh) | `pnpm capture:har` — HAR start, sign-in (from `.env` Fintual fields via [`bin/load-fintual-env-for-capture.mjs`](../bin/load-fintual-env-for-capture.mjs)), optional pause for 2FA, in-page GQL eval from [`bin/fintual-gql-eval-fragment.mjs`](../bin/fintual-gql-eval-fragment.mjs) + [`bin/fintual-goal-performance.graphql`](../bin/fintual-goal-performance.graphql), HAR stop. |
| [`src/fintual/http-session.ts`](../src/fintual/http-session.ts) | Cookie jar + sign-in + `initiate_login` + `finalize_login_web` + `postGql`. |
