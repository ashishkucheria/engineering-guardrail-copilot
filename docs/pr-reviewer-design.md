# Design: Guardrail PR reviewer (GitHub Action)

Status: **draft for review.** Decisions already made are marked *(decided)*; the questions at the end are still
open.

## 1. Goal

Review every pull request against the reviewed repository's own engineering standards, inside GitHub, with the
AI provider and key that repository chooses. Same engine as the web app: deterministic rules, then the model,
then evidence verification, so code (not the model) decides what is a violation and what the verdict is.

Non-goals for v1: the web app's challenges, chat, feedback and dashboard. The Action is stateless and doesn't
talk to the web app or D1.

## 2. Decisions

| # | Question | Decision |
|---|---|---|
| D1 | Where the review runs | **Inside the Action, on the GitHub runner,** calling the AI provider directly with a key from a repository secret *(decided)* |
| D2 | Where standards come from | **The reviewed repository:** `.guardrail/standards/*.yaml`, same format as `standards/` today. If the folder is missing, the 8 built-in standards apply *(decided)* |
| D3 | AI providers | **OpenAI-compatible, Anthropic, Google Gemini and Workers AI (native)** *(decided)* |
| D4 | Output on the PR | **Check run with annotations, one summary comment, inline review comments**, each switchable. Default: check + summary on, inline off *(decided)* |
| D5 | Gating | **Advisory by default.** `fail-on: blocker` or `major` makes the check fail; branch protection can then require it *(decided)* |
| D6 | Packaging | **In this repository:** `action.yml` at the root, a bundled JavaScript action built from the same `core/`. Used as `ashishkucheria/engineering-guardrail-copilot@v1` *(decided)* |

## 3. How a repository uses it

```yaml
# .github/workflows/guardrail.yml in the reviewed repository
name: Guardrail
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write   # summary and inline comments
  checks: write          # check run and annotations
concurrency:
  group: guardrail-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: ashishkucheria/engineering-guardrail-copilot@v1
        with:
          provider: openai-compatible
          base-url: https://api.groq.com/openai/v1
          model: llama-3.3-70b-versatile
          api-key: ${{ secrets.GUARDRAIL_AI_KEY }}
          fail-on: blocker
```

No `actions/checkout` is needed: the Action reads the diff and the standards through the GitHub API.

### Inputs

| Input | Default | Meaning |
|---|---|---|
| `provider` | *(required)* | `openai-compatible`, `anthropic`, `gemini`, `workers-ai` or `none` (rules only) |
| `model` | per provider (§5) | Model name |
| `api-key` | *(required unless `none`)* | Provider key, from a secret |
| `base-url` | `https://api.openai.com/v1` | `openai-compatible` only |
| `cloudflare-account-id` | | `workers-ai` only |
| `standards-path` | `.guardrail/standards` | Folder of standard YAML files in the reviewed repo |
| `fail-on` | `none` | `none`, `blocker` or `major` |
| `fail-on-incomplete` | `false` | Fail the check when part of the PR couldn't be reviewed |
| `check-run` | `true` | Create the check run with annotations |
| `summary-comment` | `true` | Keep one summary comment up to date |
| `inline-comments` | `false` | Comment on each violation's line |
| `max-ai-calls` | `20` | Upper bound on model calls per run, retries included |
| `github-token` | `${{ github.token }}` | Token for reading the PR and writing results |

Outputs: `verdict`, `violations`, `blockers`, `incomplete`, for later steps.

## 4. Flow

1. **Read the PR.** `GET /repos/{owner}/{repo}/pulls/{n}/files` (paginated) gives each file's status and patch.
   The patches are joined into one unified diff and parsed by today's `core/diff.ts`. A file without a patch
   (GitHub leaves it out for very large files) or a binary file is a coverage gap, as in the app.
2. **Load standards from the base commit**, not the PR head: `GET /repos/{owner}/{repo}/contents/{path}?ref={base sha}`.
   Otherwise a PR could switch off the standard it violates in the same change. A PR that edits
   `.guardrail/standards/` is reviewed against the old standards; the summary says the standards changed.
   Invalid YAML fails the run with a clear message (a broken standard isn't silently skipped).
3. **Run the engine.** `core/engine.ts review()` with the rule detector and the LLM detector over the provider
   client (§5). Same chunking, evidence verification, pre-existing-line handling, redaction and caps as the app.
   Each model call, retries included, counts against `max-ai-calls`; past it, the remaining chunks are coverage
   gaps and the verdict is `incomplete`.
4. **Apply exceptions** from `.guardrail/exceptions.yaml` at the base commit (see open question Q1).
5. **Publish** (§6), then set the outputs and the job result (§7).

### Limits

Today's limits were chosen for pasted input: 100 KB and 20 files. A PR can be bigger. For the Action:
- Files are reviewed in the order GitHub returns them, up to `max-files` (default 50); the rest are coverage gaps.
- The 100 KB limit applies per file instead of to the whole input.
- Test files and files the standards can't apply to (lock files, images, generated `dist/`) are left out of the
  model calls; the rules still see them where a rule needs them (TST-001 needs to know whether tests changed).

## 5. Providers

All four implement today's interface, `LlmClient.json(messages, schema, { maxTokens, seed })`, with temperature 0.

| Provider | Default model | How JSON is enforced | Seed |
|---|---|---|---|
| `openai-compatible` | `gpt-4o-mini` | `response_format: { type: "json_schema", ... }`, falling back to `json_object` where a server rejects schemas | if the server accepts it |
| `anthropic` | a current Claude model, chosen when this is built | one forced tool whose input schema is the detection schema | not supported; retries rely on the existing validation and re-ask |
| `gemini` | a current Gemini Flash model, chosen when this is built | `responseMimeType: application/json` plus `responseSchema` | if supported |
| `workers-ai` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | the app's current client, over `POST /accounts/{id}/ai/run/{model}` | yes |

- The output schemas use only what all four accept (no `oneOf`, no recursive types); each adapter maps them.
- Each adapter has a request timeout and turns HTTP 429/5xx into a retryable error, so today's retry loop (3
  attempts, new seed each time) works unchanged.
- The key is passed only in the request header and is registered as a secret with the Actions toolkit so it is
  masked in logs.
- Model names and API details are checked against each provider's current docs at build time, not assumed from
  this document.

## 6. Output on the PR

**Check run** (`checks: write`), named "Guardrail":
- Conclusion from §7; the title gives the verdict and the counts.
- One annotation per finding on its file and line: blocker → `failure`, major → `warning`, minor and
  suggestions → `notice`. The API takes 50 annotations per request, so they are sent in batches; past 200
  findings the engine's existing cap applies and the summary says how many were left out.
- The check's summary (Markdown) holds the same table as the summary comment.

**Summary comment** (`pull-requests: write`), on by default:
- One comment, found again by a hidden marker (`<!-- guardrail:summary -->`) and edited on every run, never a new
  comment per push.
- Verdict, coverage, a table of violations (standard, severity, file:line, explanation) and collapsed
  suggestions, plus which provider and model ran.

**Inline comments**, off by default:
- One review comment per violation on its changed line, posted as a single PR review.
- Each carries a hidden fingerprint (standard, file, evidence hash) so a re-run skips ones already posted and
  marks those no longer found as outdated, instead of duplicating them.
- Only lines in the diff can be commented on; findings elsewhere stay in the summary.

Everything posted is redacted the same way as in the app: the comment is public to anyone who can see the PR.

## 7. Gating

| `fail-on` | Check conclusion |
|---|---|
| `none` (default) | `neutral` if there are violations, `success` otherwise |
| `blocker` | `failure` if the verdict is `fail` |
| `major` | `failure` if there is any blocker or major violation |

`incomplete` gives `neutral`, or `failure` with `fail-on-incomplete: true`. An exception-waived finding never
fails the check. The job's own exit code follows the conclusion, so a required status works either way.

## 8. Security and privacy

- **Fork PRs.** On `pull_request` from a fork, GitHub doesn't pass secrets and the token is read-only. The Action
  then runs **rules only**, writes the result to the job summary (it can't comment), and says why. The docs warn
  against `pull_request_target` with the PR head checked out; the Action never checks out or runs PR code, so it
  is safe under `pull_request_target`, but that choice stays with the repository owner.
- **Standards from the base commit** (§4 step 2), so a PR can't weaken the rules it is checked against.
- **Prompt injection.** Same protections as the app: code as data between random per-request tags, a JSON
  schema, evidence verification, and code deciding the verdict. The model can't post anything itself; the Action
  builds every comment from verified findings.
- **Code goes to the chosen provider.** The README says so plainly; `provider: none` keeps everything on the
  runner.
- **Secrets in the diff** are redacted in every annotation and comment, as in the app.

## 9. Code layout

```
action.yml                  inputs, outputs, runs: node24 (version checked at build time), main: dist/action/index.js
action/main.ts              entry point: read inputs, run the flow, set outputs
action/github.ts            PR files, contents at a ref, check runs, comments (fetch, no Octokit dependency if practical)
action/publish.ts           check run, summary comment, inline comments (pure formatting, unit-tested)
action/providers/*.ts       openai-compatible, anthropic, gemini, workers-ai
core/                       unchanged except: standards loading from YAML text, and per-file limits for the Action
dist/action/index.js        bundled output, committed (Actions run it straight from the tag)
```

The web app keeps its Workers AI binding client in `worker/ai.ts`; the REST client for the Action is separate.
CI rebuilds the bundle and fails if `dist/action/` is out of date.

## 10. Testing

- **Unit:** each provider adapter against recorded responses with `fetch` mocked (valid JSON, malformed JSON,
  429, timeout); diff assembly from `pulls/files` patches; gating table; comment formatting and the marker and
  fingerprint logic; standards from the base ref versus the head.
- **Dogfood:** this repository runs the Action on its own PRs from the local path (`uses: ./`), first with
  `provider: none` so CI needs no key, then with a fake provider for the full publish path.
- **Real providers:** one manual run per provider against a test PR with known findings, recorded in the PR that
  adds it. Not run in CI (keys and cost).

## 11. Delivery

| PR | Scope |
|---|---|
| 4-A | Provider adapters (all four) behind `LlmClient`, standards from YAML text, per-file limits; unit tests. No Action yet |
| 4-B | The Action: `action.yml`, reading the PR, check run, summary comment, gating, fork handling, bundle and CI check; dogfood with `provider: none` |
| 4-C | Inline comments with fingerprints, exceptions file (if Q1 is yes), README and a `v1` release tag |

## 12. Open questions

- **Q1. Exceptions.** Support `.guardrail/exceptions.yaml` (standard, path glob, reason, expiry ≤ 90 days, who
  approved), read from the base commit, so adding one needs a reviewed merge? Or leave exceptions out of v1?
- **Q2. Default model** for `openai-compatible`: `gpt-4o-mini` (cheap, widely available), or no default so the
  repository must choose?
- **Q3. Re-runs.** Review the whole PR on every push (simple, predictable cost per push), or only files changed
  since the last reviewed commit (cheaper, more state to get right)? Proposal: whole PR, with the concurrency
  group cancelling superseded runs.
