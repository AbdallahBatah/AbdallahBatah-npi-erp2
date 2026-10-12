---
name: npi-erp-testing
description: Run a full test pass over the NPI Solar ERP — accounting invariants (trial balance, journal balance, ZATCA PIH chain), permission enforcement per role, business-rule guards, and a browser sweep of every screen. Use this whenever the user asks to test, verify, smoke-test, check, or validate the ERP, before any deploy to the demo server, after finishing a wave or package of work, or when they suspect something broke. Triggers include "اختبر النظام", "تأكد أن النظام شغال", "شغّل الاختبارات", "هل النظام سليم", "test the ERP", "smoke test", "verify before deploy", "did I break anything". Applies even when they don't name this skill — any request to confirm the ERP still works end to end should use it.
---

# NPI Solar ERP — test pass

This ERP posts real double-entry journals and signs real ZATCA documents. The
things worth testing are therefore not "does the page load" but "can the ledger
still close" and "does the server still refuse what the UI merely hides".

Two layers, run in this order:

1. **`scripts/api-smoke.mjs`** — the invariants, over HTTP against a running API.
2. **The browser sweep** — every screen renders for a real role.

Both are **non-destructive**: every check is a read, or a write the server is
expected to reject. Nothing in this skill creates or mutates a record, so it is
safe against a dataset someone is about to demo.

## 1. Bring the stack up

Read `references/environment.md` before touching anything — this repo has a
specific local setup (portable Postgres, a port already taken by another
project, Arabic-mangling shells) and several of its traps look like product
bugs when you hit them cold.

The short version:

```bash
npm run db:start
```

Then the API and the web server, each in the background. The API needs the CORS
override because `main.ts` defaults to port 3000 only, and port 3000 belongs to
a different project on this machine:

```bash
CORS_ORIGINS="http://localhost:3000,http://localhost:3001" npm run dev:api
```

```bash
cd apps/web && npx next dev -p 3001
```

Wait for both rather than sleeping blindly — `until curl -s -o /dev/null http://localhost:3001/login; do sleep 3; done`.

## 2. Run the API invariant suite

```bash
node .claude/skills/npi-erp-testing/scripts/api-smoke.mjs
```

It prints one line per check and exits non-zero if any fail. Flags:

- `--base <url>` — default `http://localhost:4000/api`.
- `--skip-throttle` — the throttle check deliberately trips the 5/min login
  limiter, which locks out further logins for a minute. It runs last for that
  reason; skip it if you plan to keep working against the API immediately after.

**Expect the run to pause for up to a minute near the end.** `/auth/login` is
throttled to 5/min per IP, and the five role logins consume exactly that budget,
so the wrong-password check has to wait for the window to reset — otherwise it
reads a 429 and reports the password check as broken, which is a lie. If a
browser session or an earlier run already ate the budget, the first login waits
it out once and says so. This is the suite respecting a real security control,
not slowness to be optimised away.

What it covers and, more usefully, **why each check earns its place**:

| Group | Checks | Why it matters |
|---|---|---|
| Reachability | `/health` reports `db:up` | Distinguishes "API down" from "API up, database gone" — otherwise every later failure is noise. |
| Auth | every seeded role logs in (nine since P1-13); `/auth/me` returns permissions | A stale seed after a deploy silently strips permissions; this catches it before a user hits a 403. |
| Permission enforcement | for every route in the map, each role's actual result is compared against what its **own** permission list predicts | The guard is global and fail-closed. This asserts the wiring still matches the declaration, and it keeps working when the seed's permission sets change, because expectations are derived per-role at runtime rather than hardcoded. |
| Accounting | trial balance `isBalanced` and Σdebit = Σcredit; balance sheet balanced; every journal entry balanced individually | `PostingService.journal` is the single path for automatic entries and checks balance per entry. An unbalanced ledger means something bypassed it. |
| ZATCA | the PIH chain links: each document's `previousInvoiceHash` equals the previous document's `invoiceHash` | The hash chain is the integrity claim made to the tax authority. A break is not cosmetic. |
| Guards | illegal project stage transition → 400; unknown id → 404; reversed report dates → 400; wildly over-allocated payment → 400 | These are the server-side rules the UI also enforces. Testing them here proves the UI is a convenience, not the control. |
| Security | no token → 401; wrong password → 401; sixth login in a minute → 429 | Fail-closed auth and the brute-force limiter. |

If a check fails, the script prints the actual response. Read it before assuming
the test is wrong — most failures in this codebase have been real.

## 3. Sweep the UI in the browser

The in-app browser pane on this machine frequently cannot composite, so
`screenshot` times out and `read_page` returns an empty tree. Don't fight it —
drive the DOM by script instead. This is a limitation of the pane, not of the app.

Open the app, then authenticate by writing the token directly:

```js
// via mcp__Claude_Browser__javascript_tool, on http://localhost:3001
(async () => {
  const r = await fetch('http://localhost:4000/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@npi.sa', password: 'Admin@123' }),
  });
  const j = await r.json();
  localStorage.setItem('npi_token', j.accessToken);
  return !!j.accessToken;
})()
```

Then navigate to `/dashboard` and paste `scripts/ui-sweep.js` into the same tool.
It walks every sidebar link and reports, per screen: whether it arrived, the
heading, icon count, any emoji left in the rendered UI, whether the page shows a
load-error card, horizontal overflow, and icon-only controls missing an
accessible name.

Two things about driving this app by script:

- **`history.pushState` + a `popstate` event does not move the Next App Router.**
  Click the sidebar `<a>` for client-side navigation, or use the `navigate` tool
  for a full load. A sweep built on `pushState` silently reports the same page
  N times, which looks like a pass.
- **Poll for arrival; never use a fixed sleep.** On a cold `.next` the dev
  server compiles each route on first visit, which can take many seconds. A
  fixed wait samples the *previous* screen and reports its heading, so every
  route looks like it failed to navigate and you go hunting for a routing bug
  that isn't there. `ui-sweep.js` waits for `location.pathname` to match, then
  waits for the skeletons to clear.
- The pane's CDP session sometimes drops on a long-running script
  ("Inspected target navigated or closed"). Sweep in batches of ~8 screens
  rather than all 19 in one call.

Re-run the sweep as `engineer@npi.sa` / `Eng@12345`. A role with no finance
permissions must see fewer sidebar links (6 of 24 since P1-13, against admin's
24) and must not render a load-error card anywhere — **a 403 rendered as an error banner is the
recurring defect class on this project**, and it has shipped twice: once on the
dashboard, where a site engineer saw every metric as "—", and once on `/ppa`,
where an unconditional `/projects` fetch replaced the whole page with an error
for an accountant who could settle but not read projects.

Then check that write buttons are absent where the role lacks the write
permission — the sidebar gate and the per-button gate are separate mechanisms
and one can rot without the other:

```js
[...document.querySelectorAll('button[class*="btn-"]')].map(b => b.innerText.trim()).filter(Boolean)
```

Since P1-13 the seeded roles are the company's seven (`ROLE_PRESETS`), so pick
the account by the key that gates the button. The executive (`ceo@npi.sa`, 17
screens) holds no write key at all: this should be **empty on every screen he
sees**. The warehouse keeper (`store@npi.sa`) holds `scm.procurement.write`
without `scm.procurement.approve`: `/procurement` may offer create and receive,
never approve. `/assets` and `/workorders` belong to no company role (ADR-02 §7,
administrator only); on `/assets` install/transfer need `scm.procurement.write`,
which `assets.serialunit.read` does not imply — an asymmetry to check whenever a
custom role holds the one without the other.

## 4. Report

Lead with the verdict, then the evidence. Something like:

```
## النتيجة: <سليم | فيه <N> إخفاقات>

### الخلفية (API)
<pass/fail per group, with the failing detail inline>

### الواجهة
<per-role screen sweep result>

### ما لم يُختبر
<anything skipped and why — a skipped check reported as a pass is worse than a failure>
```

State what you did **not** cover. This suite deliberately writes nothing, so it
cannot catch a bug that only appears on a successful mutation (a wrong journal
on a *new* invoice, say). If the user needs that, say so and offer a scripted
mutation pass against a disposable dataset rather than quietly implying the
system is fully verified.
