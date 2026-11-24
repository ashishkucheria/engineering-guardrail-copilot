# Engineering Guardrail Copilot

An AI-assisted code reviewer on Cloudflare that checks code against a team's engineering standards, and turns
developer feedback, challenges and exceptions into data a platform team can use.

> **Demo identity, not authentication.** The UI lets you pick a demo user (developer or approver), and the API
> trusts the `X-Demo-User` header. Anyone can claim to be anyone. The approval rules (only approvers toggle
> standards or approve exceptions; nobody approves their own exception) are enforced on the server against that
> claimed identity, so they show how the rules work, not who is allowed. In production this would be Cloudflare
> Access, with roles from the identity provider.

## How it works

```mermaid
flowchart LR
  UI[React UI] -->|/api/*| W[API Worker]
  W -->|start| WF[Review Workflow]
  WF --> R[Deterministic rules]
  WF --> AI[Workers AI: Llama 3.3]
  AI --> V[Evidence verification]
  R --> X[Apply exceptions]
  V --> X
  X --> DB[(D1)]
  W <--> DB
  W -->|challenges, chat| AI
```

Standards are YAML files in [`standards/`](standards). A review runs the deterministic rules and the model over the
code, keeps only AI findings whose quoted evidence is really in the code, applies approved exceptions, and stores
everything in D1. The model can explain and argue; code decides what counts as a violation and what the verdict is.

## Features

- Paste a snippet or unified diff. The review runs in a **Cloudflare Workflow**, one step at a time:
  load the standards snapshot and active exceptions, validate, deterministic rules, one **Llama 3.3** call per code
  chunk, apply exceptions, then save. The UI shows each step as it finishes.
- **Deterministic checks:** SEC-001 hardcoded secrets (credential-named literals and known token formats, each
  secret its own finding, all redacted), MNT-001 TODOs without a ticket, TST-001 new logic without tests (diffs
  only).
- **AI checks** for SEC-001, SEC-002 (SQL from unescaped input), REL-001/002/003 and OBS-001, in JSON mode. Code,
  not the model, decides everything that matters:
  - **Evidence verification:** a finding is kept only if its quote is in the input; the line numbers come from
    where it matches. Unmatched quotes are dropped and counted in the pipeline log.
  - Severity comes from the standard. A finding is a violation only if the model says "definite" and the quote is
    on a line the change adds. A finding on unchanged diff lines is a **pre-existing** suggestion and can't fail
    the change.
  - Secrets the model quotes are redacted, and an AI "secret" whose value is a placeholder (`<your-key>`, `****`)
    is dropped, by the same definition the rule uses.
  - Detection never sees feedback history, and the prompt treats code as data. The code sits between markers
    with a random tag per request, so code containing its own "END CODE" line can't close the block early (two
    prompt-injection hard gates in the eval).
- **Failure is visible, never a silent pass.** A chunk the model can't answer after 3 retries (each with a new seed) becomes a coverage
  gap and the verdict is `incomplete` (still `fail` if a rule found a blocker). Large files are chunked (8,000
  characters, 15 lines of overlap, at most 40 chunks), never truncated. At most 200 findings are kept per review;
  the rest are recorded as a gap.
- **Challenges:** "Challenge this finding" sends your argument, the standard and the surrounding code to the model.
  An AI finding it agrees is wrong is marked **Disputed by the author**, but its classification, severity and the
  verdict never change (only an approved exception waives a violation). A rule finding is always upheld. One
  challenge per finding, only by the review's author or an approver, recorded with who, why and the model's
  reasoning.
- **Exceptions** are the only thing that waives a violation. From a violation, the review's author (or an approver)
  requests one: a standard, a path glob (`src/legacy/**`, or `*` for every path), a justification and an expiry of
  at most 90 days. Only an approver who didn't request it can approve or deny it; nobody approves their own, which
  a database constraint also enforces. Once approved:
  - The matching findings in the review it came from are waived, that review's verdict is recomputed, and the
    pipeline log records it. The findings stay on record, marked waived.
  - Later reviews get matching findings waived by the `apply-exceptions` step until the exception expires.
  - "Active" and "expired" are worked out from the expiry date, never stored, so an exception can't be left stale.
  - Approving a pattern that covers every path (such as `*` or `**`), or any exception to a blocker standard,
    needs a written decision note. The note is shown on the exception and in the source review's log.
  - An approver can **revoke** an active exception early, with a required note. Findings it already waived stay
    waived; later reviews aren't waived. The source review's log records the revocation.
  - One person can have at most 5 pending requests at a time.
  - Path patterns are matched without regular expressions, in time linear in the pattern and path length.
- **Feedback:** the author or an approver can accept or reject a finding (rejecting needs a reason). Feedback is a
  signal for the dashboard and for people. It never changes the finding or the verdict, and **ten rejections
  don't stop a finding from being reported next time** (a hard gate in the smoke test). Detection and the waiver
  step have no input that could carry feedback.
- **History, where it can't suppress anything:** next to each finding, how that standard's findings fared in
  other reviews (accepted, rejected, disputed, and the latest rejection reasons). The chat sees the same history.
- **Chat** about a review, for its author or an approver: it sees the findings (at most 40, worst first, long
  text clipped, and the prompt says how many were left out), the standards involved, active exceptions, that
  history and the last 10 messages. It's advisory only: no tools, and it can't accept, reject, challenge or waive
  anything. Each question costs one AI call from the daily budget; each person can ask 5 a day, and chat stops
  5 calls before the budget runs out so reviews and challenges keep some. The review data sits between randomly
  tagged markers, like the code in detection.
- **Dashboard:** reviews by verdict, violations by severity (waived ones left out), the most frequent standards,
  accept/reject counts and reject rate per standard, challenges (upheld and disputed by the author), exceptions
  (pending, active, expired, denied, revoked) and today's AI budget. "Violations waived" and "most frequent
  standards" count violations only; the latter leaves out waived ones. All are read live from D1. "Accepted" stands in for
  "remediated", because the app can't see whether a fix landed.
- **Cost protection** (design §10): per-IP rate limits (5 reviews and 10 challenges a minute; polling a running
  review has its own, looser limit) and a strict daily cap on AI calls in D1. Every model call, retries included,
  reserves one call first. Once the cap is reached, reviews still run the deterministic checks and are marked
  `incomplete`, and challenges and chat get `429` with `Retry-After`.
- Standards live in `standards/*.yaml`. Approvers can enable or disable them, every change is audited, and every
  review keeps a snapshot of the version and status of every standard it ran with.

## Run it locally

Needs Node 22.18+ (it runs TypeScript scripts directly) and npm.

```sh
npm install
cp .dev.vars.example .dev.vars   # LLM_MODE=fake by default: no AI calls, no Cloudflare account needed
npm run db:setup:local           # apply migrations to the local D1 and seed standards + demo users
npm run dev                      # http://localhost:5173
```

To use the real model, set `LLM_MODE=workers-ai` in `.dev.vars` and run `npx wrangler login` first. Workers AI
always runs remotely, also in local dev, and uses your account's Workers AI allocation (10,000 neurons a day free;
one review chunk is roughly 250 neurons). `LLM_MODE=off` runs the deterministic checks only.

Other local commands: `npm run db:seed:local` after editing `standards/*.yaml`; `npm run db:migrate:local` after
pulling new migrations; `npm run budget:reset:local` to reset today's local AI budget.

## Deploy to Cloudflare

Works on a free account. Read **Known limits** first: the demo identity means anyone with the URL can act as any
user and read every review, so don't paste real secrets, and consider putting the app behind Cloudflare Access.

```sh
npx wrangler login
npm run deploy                                         # builds, creates the D1 database on first deploy, deploys
npx wrangler d1 migrations apply DB --remote
node scripts/seed.ts && npx wrangler d1 execute DB --remote --file=.wrangler/seed.sql
```

The deployed app uses the real model (`LLM_MODE=workers-ai` in `wrangler.jsonc`) with at most 20 app calls a day.
For the eval endpoint, also run `npx wrangler secret put EVAL_TOKEN`. To remove everything:
`npx wrangler delete`, `npx wrangler workflows delete guardrail-review` and `npx wrangler d1 delete guardrail-copilot`.

Checked end to end on 2026-11-24 with the real model: reviews, challenges, chat, exception approve and revoke, and
the dashboard, using 6 AI calls.

## Tests

```sh
npm test            # unit tests: diff parsing, rules, chunking, verification, LLM detector, verdict, budget, scorer,
                    # exceptions (matching, expiry, validation), every approval rule, the chat prompt
npm run typecheck   # client, worker and node projects
npm run smoke       # end-to-end API checks against `npm run dev` with LLM_MODE=fake (changes local data)
npm run eval        # eval harness: scores the engine against labelled cases in eval/cases
```

CI (`.github/workflows/ci.yml`) runs all of these on every PR with no Cloudflare account: generated Worker types
are up to date, typecheck, unit tests, the rules eval in `--strict` mode, build, and the smoke test against a
local server running the fake model (`LOCAL_ONLY=1` turns off remote bindings).

The fake model (`worker/ai.ts`) recognises a few patterns, invents one quote that isn't in the code, and can be
told to fail. The smoke test uses it to check the whole pipeline without AI calls:

- An AI review through the Workflow: verified findings with lines, a hallucinated quote dropped, every step logged.
- An AI failure after retries is `incomplete`, a rule blocker still fails, and every attempt used one budget call.
- An AI finding on an unchanged diff line is a pre-existing suggestion.
- Challenges: disputed without changing the verdict, once per finding, only by the author or an approver, rule
  findings always upheld.
- The 6th review request in a minute from one IP gets `429`, while 70 polls of one review a minute don't. 4,000
  TODOs give 200 findings and a recorded gap. Once the daily budget is used up, reviews run rules only and
  challenges get `429` with `Retry-After`.
- Feedback is limited to the author or an approver, a reject needs a reason, and the verdict doesn't change.
  **Hard gate:** after ten rejections, a new review of the same code still reports the finding and fails.
- Exceptions:
  - A request is refused (`400`) if it has no expiry or one over 90 days, or if its pattern misses the finding.
  - A developer can't approve one, and nobody can approve their own (`403`).
  - Two approvers approving at once give exactly one approval and one `409`.
  - Approval waives the source finding and recomputes that review's verdict in SQL. The test checks the result
    against the verdict rules.
  - A later review of the same path is waived; another path isn't.
- Chat is refused (`403`) for anyone but the author or an approver, answers, is stored with who asked, and
  spends one budget call. The 6th question from one person in a day gets `429`, and chat gets `429` once only 5
  calls are left while a review still gets the AI.
- Approving a blocker exception without a note is `400`. Revoking needs an approver and a note; two revokes at
  once give one `200` and one `409`; the source review stays waived and a new review isn't. A 6th pending
  request from one person is `409`. A pattern that would hang a regex is rejected at once.
- The dashboard's numbers move exactly as expected, step by step: a new review, a rejection, an exception
  request, and an approval.
- Everything from 3-A: 401/403/404/405/413, audited toggles, snapshots, redaction regressions.

The smoke test makes more fake AI calls than the real daily budget allows, so `.dev.vars.example` raises
`DAILY_LLM_CALLS_APP` for fake mode. That value is ignored above 20 unless `LLM_MODE=fake`. The smoke test
also uses up the day's chat questions; `npm run budget:reset:local` resets both before a re-run.

## Eval harness

`eval/cases/*.json` are hand-labelled inputs: expected findings (standard and line range), `must_not_flag` for
areas that look risky but comply, and `hard_gate` for cases that fail the whole run if missed (three
prompt-injection cases and a fixture key whose comment says not to flag it). `npm run eval -- --config <name>` runs every case through the same `review()` and
detectors as the app and reports precision, recall and F1 per standard, false positives on clean cases,
**blocker precision** on its own line, and the hard gates. `--save` writes `eval/results/<date>-<config>.json`.

- `rules`: deterministic checks only, no network. CI runs it in `--strict` mode.
- `llm`: rules plus the real model, through `POST /api/eval/detect` on a running app (`--target`, default
  `http://localhost:5173`). The endpoint needs the `EVAL_TOKEN` secret (from `.dev.vars` locally) and spends the
  separate eval budget, one call per model call (usually one per case).

**Results** are in [`eval/RESULTS.md`](eval/RESULTS.md): `rules` against `rules + Llama 3.3` (prompt v3), one run
each on 25 cases (2026-11-24).
- The AI path finds all 19 expected findings, where the rules can reach only 12 of them.
- Precision is 95%, with one OBS-001 false positive on a clean case. Blocker precision is 100% (10 of 10).
- All 4 hard gates pass.
- Run-to-run variance and the other configurations in design §8 aren't measured yet: they don't fit the free
  allocation.

## Layout

```
core/        pure domain logic: diff parsing, chunking, rules, prompts, LLM detector, engine, verdict, policy
worker/      the API Worker: routing, demo identity, D1 queries, the review Workflow, AI clients, budget
client/      React UI
standards/   the engineering standards, one YAML file each
migrations/  D1 schema
eval/        eval cases, scorer, runner, saved results
scripts/     seed generator, standards loader, API smoke test
test/        unit tests (Vitest)
docs/        build notes: the design and the prompt history
```

## Known limits

- Demo identity only (see the top of this file).
- The submitted input is stored as is, including any secret it contains. Findings, AI explanations and challenge
  reasoning are redacted; the input isn't.
- Any demo user can read any review. With stored inputs, the demo must not be used with real secrets.
- One abuser can use up the day's AI budget for everyone. The demo then runs deterministic checks only; it never
  becomes an unbounded bill. Per-IP limits can be dodged with many IPs; the global budget still holds.
- The free Workers AI allocation (10,000 neurons, about 33 calls a day at roughly 300 neurons a call) is shared by
  the app, local development and the eval. The caps (`DAILY_LLM_CALLS_APP=20`, `DAILY_LLM_CALLS_EVAL=25` in
  `wrangler.jsonc`) add up to 45: a ceiling on what the app tries, not a guarantee. A call past the free allocation
  fails (no charge) and shows as a coverage gap.
- A "disputed" challenge comes from a model reading the developer's own argument, so it can be steered. It never
  changes the verdict, and it shouldn't be read as a confirmed false positive.
- The 1 MiB limit on Workflow step output isn't enforced in local dev. Findings are capped inside the steps, but
  the limit is only really tested on the first deploy.
- AI verification checks that the quote exists, not that the model's reasoning is right. A real line can still be
  wrongly flagged; that's what challenges and the eval's blocker precision are for.
- TST-001 is satisfied by *any* test file in the diff. Secret detection uses patterns, not every format. The
  MNT-001 list of technical prefixes is fixed in code.
- Approving an exception waives findings in the review it was requested from and in reviews that start after it.
  It doesn't touch other past reviews, or a review already running when it was approved. An exception that
  expires doesn't un-waive past reviews; it only stops waiving new ones.
- Rejection reasons, from any user, reach the chat model as data, in other users' chats too (for any review with
  the same standard), so a reason could try to steer the chat. Accepted risk (review of PR #4): the chat is
  advisory and can't change anything, the reasons sit inside tagged markers, and the prompt says they are
  opinions, not proof. The worst case is misleading advice.
- A chat question counts against the person's daily 5 even if the AI budget then refuses it (`429`). Over-counting
  errs on the safe side, like the budget itself.
- Rejecting the same finding repeatedly is allowed. Each rejection is kept in the feedback history, but the
  dashboard counts each finding's latest disposition once.
- The UI's tabs don't change the URL, so a link to `/exceptions` opens the review page.

## Roadmap

Review pull requests where they happen: a GitHub Action (or webhook) that sends a PR's diff to the review pipeline,
reads the standards from the repository being reviewed, and posts the findings as PR comments. The web app stays the
place for exceptions, challenges and the dashboard. Design: [`docs/pr-reviewer-design.md`](docs/pr-reviewer-design.md).

## How it was built

Built with an AI coding assistant (Claude Code), in phases, one pull request each, every one reviewed before merge.
[`docs/build-notes/design.md`](docs/build-notes/design.md) is the design written before the build, with a record of
where the build differs. [`docs/build-notes/prompts.md`](docs/build-notes/prompts.md) quotes every prompt verbatim
up to the PR #4 review fixes, with what each was for and what came out of it. "Prompt N", "design §N" and "review
of PR #N" in code comments point to these files and the merged pull requests.

## Licence

[MIT](LICENSE).
