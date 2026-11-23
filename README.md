# Engineering Guardrail Copilot

An AI-assisted code reviewer on Cloudflare that checks code against a team's engineering standards, and turns
developer feedback, challenges and exceptions into data a platform team can use.

> **Demo identity, not authentication.** The UI lets you pick a demo user (developer or approver), and the API
> trusts the `X-Demo-User` header. Anyone can claim to be anyone. The approval rules (only approvers toggle
> standards or approve exceptions; nobody approves their own exception) are enforced on the server against that
> claimed identity, so they show how the rules work, not who is allowed. In production this would be Cloudflare
> Access, with roles from the identity provider.

## Status

Built in phases, one PR each, reviewed before merge. The design is in [`docs/phase-2-design.md`](docs/phase-2-design.md),
and every prompt is recorded in [`prompts.md`](prompts.md).

| PR | Scope | State |
|---|---|---|
| 3-A Foundation | Worker + React, D1 schema, standards as YAML with versions and an audit log, demo identity, deterministic checks, eval harness architecture | merged |
| 3-B AI review | Workflow pipeline, Llama 3.3 detection, evidence verification, challenges, rate limits and the daily AI budget | **this PR** |
| 3-C Interaction and insight | Exceptions, chat, memory, dashboard, full eval | next |

What works (tested; see below):

- Paste a snippet or unified diff. The review runs in a **Cloudflare Workflow**, one step at a time:
  load the standards snapshot, validate, deterministic rules, one **Llama 3.3** call per code chunk, then save. The
  UI shows each step as it finishes.
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
  An AI finding it agrees is wrong is marked **Disputed**, but its classification, severity and the verdict never
  change (only an approved exception will waive a violation, in 3-C). A rule finding is always upheld. One
  challenge per finding, only by the review's author or an approver, recorded with who, why and the model's
  reasoning.
- **Cost protection** (design §10): per-IP rate limits (5 reviews and 10 challenges a minute; polling a running
  review has its own, looser limit) and a strict daily cap on AI calls in D1. Every model call, retries included,
  reserves one call first. Once the cap is reached, reviews still run the deterministic checks and are marked
  `incomplete`, and challenges get `429` with `Retry-After`.
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

## Tests

```sh
npm test            # unit tests: diff parsing, rules, chunking, verification, LLM detector, verdict, budget, scorer
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
- Everything from 3-A: 401/403/404/405/413, audited toggles, snapshots, redaction regressions.

## Eval harness

`eval/cases/*.json` are hand-labelled inputs: expected findings (standard and line range), `must_not_flag` for
areas that look risky but comply, and `hard_gate` for cases that fail the whole run if missed (the two
prompt-injection cases). `npm run eval -- --config <name>` runs every case through the same `review()` and
detectors as the app and reports precision, recall and F1 per standard, false positives on clean cases,
**blocker precision** on its own line, and the hard gates. `--save` writes `eval/results/<date>-<config>.json`.

- `rules`: deterministic checks only, no network. CI runs it in `--strict` mode.
- `llm`: rules plus the real model, through `POST /api/eval/detect` on a running app (`--target`, default
  `http://localhost:5173`). The endpoint needs the `EVAL_TOKEN` secret (from `.dev.vars` locally) and spends the
  separate eval budget, one call per model call (usually one per case).

First real run (22 cases, Llama 3.3 70B, prompt v2, before the review fixes, [`eval/results/2026-11-23-llm-run1.json`](eval/results/2026-11-23-llm-run1.json)):
recall 100% (17/17), precision 85%, both hard gates passed, **blocker precision 80%**. The two false blockers were
AI "secrets" that were placeholders. The placeholder guard above fixed that case in a single re-run, but the full
suite hasn't been re-run since. One OBS-001 false positive (a password literal flagged as "logging a secret")
remains. A single run at temperature 0 says nothing about run-to-run variance; that's part of 3-C. Prompt v3 (random
delimiters) has only been run on the two prompt-injection cases so far: both passed.

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
docs/        design
```

## Known limits (3-B)

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
- Exceptions (the only thing that can waive a violation), accept/reject feedback, chat and the dashboard are 3-C.
