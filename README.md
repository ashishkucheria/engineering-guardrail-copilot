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
| 3-A Foundation | Worker + React, D1 schema, standards as YAML with versions and an audit log, demo identity, deterministic checks, eval harness architecture | **this PR** |
| 3-B AI review | Workflows, Llama 3.3 detection, evidence verification, challenges | next |
| 3-C Interaction and insight | Exceptions, chat, memory, dashboard, full eval | after that |

What works in 3-A (tested; see below):

- Paste a snippet or unified diff and get a review from the **deterministic checks**. The AI review is **not**
  in this PR.
  - **SEC-001 hardcoded secrets.** Credential-named literals plus well-known token formats (Stripe, GitHub,
    Slack, Google API, AWS, literal bearer tokens, private keys). Each secret is its own finding, and every secret
    on the line is redacted in the evidence.
  - **MNT-001** TODOs without a ticket.
  - **TST-001** new logic without tests (diffs only).
- Findings show severity, standard, file and line (new-file line numbers for diffs), evidence, why, impact and fix.
- The verdict is computed in code: fail on any blocker; `incomplete`, never pass, if any file couldn't be read;
  warn on other violations; otherwise pass.
- Standards live in `standards/*.yaml`. Approvers can enable or disable them. Every change is audited with who and
  when, and concurrent toggles can't double-write. Every review keeps a snapshot of every standard's version and
  status, so history isn't rewritten. Removing a YAML file **retires** the standard: it stops running and can't
  be toggled, but its history stays.

## Run it locally

Needs Node 22.18+ (it runs TypeScript scripts directly) and npm. No Cloudflare account is needed for 3-A: D1 runs
locally.

```sh
npm install
npm run db:setup:local   # apply migrations to the local D1 and seed standards + demo users
npm run dev              # http://localhost:5173
```

Re-run `npm run db:seed:local` after editing `standards/*.yaml`. Seeding updates content, adds a new version
(rule text and examples), keeps each standard's enabled flag and audit trail, and retires standards whose file
was removed. After pulling new migrations, run `npm run db:migrate:local`.

## Tests

```sh
npm test            # unit tests: diff parsing, rules, verdict, policy, standards, eval scorer
npm run typecheck   # client, worker and node projects
npm run smoke       # end-to-end API checks against a running `npm run dev` (changes local data)
npm run eval        # eval harness: scores the engine against labelled cases in eval/cases
```

CI (`.github/workflows/ci.yml`) runs all of these on every PR: generated Worker types are up to date, typecheck,
unit tests, the rules eval in `--strict` mode (any miss fails), build, and the smoke test against a local
server.

The smoke test covers the PR's acceptance criteria:

- A developer gets 403 on a toggle, and nothing is audited.
- An approver's toggle is audited with who and when.
- A disabled standard doesn't run.
- An old review still shows the version and status it ran with.
- Input validation errors (400, 413), unknown routes (404) and wrong methods (405).
- Regressions from the PR review: every secret on a line redacted, `$&` in a secret, a 99 KB input accepted,
  a malformed URL gets 400, and concurrent toggles write one audit row.

## Eval harness

`eval/cases/*.json` are hand-labelled inputs: expected findings (standard and line range), plus
`must_not_flag` for areas that look risky but comply. `npm run eval -- --config <name>` runs every case through
the same `review()` the Worker uses and reports precision, recall and F1 per standard, false positives on clean
cases, and `must_not_flag` failures. Add `--save` to write `eval/results/<date>-<config>.json`.

Each config only scores the standards it can detect. The `rules` config scores SEC-001, MNT-001 and TST-001. The
cases already include LLM-standard labels (REL-001, REL-002, and a prompt-injection case) for the AI configs that
PR 3-B adds.

Today the rules config scores 100% on its 11 labelled findings. That's expected and doesn't mean much: the cases
were written alongside the rules. The harness matters for comparing AI prompts and models, where results vary.

## Layout

```
core/        pure domain logic: diff parsing, rules, engine, verdict, policy (no bindings, unit-tested)
worker/      the API Worker: routing, demo identity, D1 queries
client/      React UI
standards/   the engineering standards, one YAML file each
migrations/  D1 schema
eval/        eval cases, scorer, runner
scripts/     seed generator, standards loader, API smoke test
test/        unit tests (Vitest)
docs/        design
```

## Known limits (3-A)

- Demo identity only (see the top of this file).
- The submitted input is stored as is, including any secret it contains. Only the finding's evidence is
  redacted.
- TST-001 is satisfied by *any* test file in the diff, not necessarily one for the changed code.
- Secret detection uses patterns. It catches credential-named literals and the token formats listed above, not
  every secret format. A literal under a neutral name (`const k = "…"`) in an unknown format isn't caught.
- MNT-001 treats `ABC-123` as a ticket unless the key is a known technical prefix (SHA, UTF, ISO, RFC, CVE, …).
  The list is fixed in code, not configurable per team.
- Any demo user can read any review (`GET /api/reviews/:id`). Combined with stored inputs, this matters before
  any public deploy (see the open decision in `docs/phase-2-design.md`).
- No cap on findings per review yet (planned for 3-B).
