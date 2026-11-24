# Design: Guardrail PR reviewer (GitHub Action)

Status: **draft for review.** All decisions are made and marked *(decided)*; nothing is implemented yet.

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
| D7 | Exceptions | **`.guardrail/exceptions.yaml`, read from the base commit,** so adding an exception needs a reviewed merge. Each entry: `standard`, `path` glob, `reason` (10 to 2,000 characters), `approved-by`, `expires` (a date at most 90 days from the day it is read, valid through that day). An entry that is expired, too far out, misspelled or for an unknown standard is **ignored and listed in the summary**, never applied; a file that isn't valid YAML applies none. Unlike a broken standards file this doesn't fail the run: ignoring is the safe direction, and one bad entry shouldn't stop every review. Waived findings stay in the summary with the reason and approver *(decided)* |
| D8 | Default models | **`gpt-6-luna`** (`openai-compatible`), **`claude-opus-5-5`** (`anthropic`), **`gemini-3.5-flash-lite`** (`gemini`), each overridable with `model`. `gpt-4o-mini` was chosen first, then dropped when building 4-A: it is deprecated and shuts down on 2027-01-14 *(decided)* |
| D9 | Re-runs | **The whole PR on every push;** the concurrency group cancels superseded runs. No state kept between runs *(decided)* |

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
| `max-ai-calls` | `20` | Upper bound on provider requests per run, retries and step-downs included |
| `max-files` | `50` | Files reviewed per pull request; the rest are listed as not reviewed |
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
4. **Apply exceptions** from `.guardrail/exceptions.yaml` at the base commit (D7), with today's
   `core/exceptions.ts` glob matching. A waived finding stays in the summary, marked waived, with the reason.
5. **Publish** (§6), then set the outputs and the job result (§7).

### Limits

Today's limits were chosen for pasted input: 100 KB and 20 files. A PR can be bigger. For the Action:
- Files are reviewed in the order GitHub returns them, up to `max-files` (default 50); the rest are coverage gaps.
- The 100 KB limit applies per file instead of to the whole input.
- Generated files (lock files, minified files, source maps, `dist/`, `build/`, `vendor/`; `isGeneratedPath` in
  `core/diff.ts`) are left out of the model calls; the rules still see them. Test files are still sent, as in the
  app: a hard-coded secret in a test is still a finding.

## 5. Providers

All four implement today's interface, `LlmClient.json(messages, schema, { maxTokens, seed })`. Checked against
the providers' docs when 4-A was built (2026-11-24); current models no longer all accept sampling parameters,
so temperature is sent only where it's accepted.

| Provider | Default model | How JSON is enforced | Temperature / seed |
|---|---|---|---|
| `openai-compatible` | `gpt-6-luna` | Chat Completions `response_format: json_schema` with `strict: true`. A 400 naming the schema switches to `json_object` with the schema in the system prompt | sent; a 400 naming either drops both (reasoning models reject them). A 400 naming `max_completion_tokens` switches to `max_tokens` |
| `anthropic` | `claude-opus-5-5` | structured outputs (`output_config.format`), through the official SDK. Forced tool use is rejected by current Claude models | not sent: API version `2026-10-21` rejects sampling parameters |
| `gemini` | `gemini-3.5-flash-lite` | Interactions API (`POST /v1beta/interactions`; Google calls `generateContent` legacy) with `response_format` and a schema; `store: false` | seed sent; temperature not sent (current models ignore it) |
| `workers-ai` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | the app's request, over `POST /accounts/{id}/ai/run/{model}` | both sent |

- `anthropic` also sends server-side fallback (`fallbacks: "default"`), so a request the model declines is
  re-run on Anthropic's fallback model; on a model without fallbacks it runs as it is.
- The OpenAI-compatible step-downs are remembered for the rest of the run, so each costs one extra request once.
- Thinking models count their reasoning against the output limit, so `openai-compatible`, `anthropic` and
  `gemini` raise the engine's 2,048-token ceiling to 16,000.
- Strict modes need `additionalProperties: false` on every object; the adapters add it, so `core/` schemas
  stay as they are.
- Each adapter has a request timeout and throws a `ProviderError` with `retryable`: true for network errors,
  timeouts, 408, 409, 429 and 5xx; false for other 4xx (a bad key, an unknown model). The engine no longer
  retries an error marked `retryable: false`. The Anthropic SDK's own retries are off, so every attempt is the
  engine's.
- Every adapter takes an injectable `fetch`. The tests mock it; 4-B wraps it to count each HTTP request
  against `max-ai-calls`, so the step-downs count too.
- The key is passed only in the request header and is registered as a secret with the Actions toolkit so it is
  masked in logs.

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
- Each carries a hidden fingerprint (standard, file, hash of the quoted code; not the line) so a re-run skips ones
  already posted instead of duplicating them. GitHub has no REST call to mark a comment outdated, so a comment
  whose finding isn't reported any more is edited to say "No longer reported in `sha` (fixed, or waived by an
  exception)" (the fingerprint stays), and put back if the finding returns. No comment is marked on a run with
  coverage gaps (AI failure, `max-ai-calls`), since a finding it couldn't look for isn't known to be gone. Known
  limits: AI evidence can differ between runs, so an AI finding's comment may be replaced instead of kept
  (unmeasured); a deleted comment is posted again. Only the Action's own comments (author type `Bot`) are ever edited.
- Only lines in the diff can be commented on (GitHub rejects the whole review otherwise): the first line of a
  finding's range that the diff shows. Findings elsewhere stay in the summary and the check. A finding off the
  diff still counts as "found", so its old comment isn't marked gone.
- At most 25 new comments per run, so a large PR can't flood its author; the rest stay in the summary.
- Only violations get inline comments; suggestions and waived findings don't.

Everything posted is redacted the same way as in the app: the comment is public to anyone who can see the PR.

## 7. Gating

| `fail-on` | Check conclusion |
|---|---|
| `none` (default) | `neutral` if there are violations, `success` otherwise |
| `blocker` | `failure` if the verdict is `fail` |
| `major` | `failure` if there is any blocker or major violation |

`incomplete` gives `neutral`, or `failure` with `fail-on-incomplete: true`. An exception-waived finding never
fails the check. With `blocker` or `major`, a run that doesn't fail but has violations is `neutral`, as with
`none`. The job's own exit code follows the conclusion, so a required status works either way.

## 8. Security and privacy

- **Fork PRs.** On `pull_request` from a fork, GitHub doesn't pass secrets and the token is read-only. The Action
  then runs **rules only**, writes the result to the job summary (it can't comment), and says why. The verdict is
  `incomplete`, because the AI standards weren't checked. The same fallback applies when `api-key` is empty for
  another reason (a Dependabot run), except that the Action still writes the check and comment. The docs warn
  against `pull_request_target` with the PR head checked out; the Action never checks out or runs PR code, so it
  is safe under `pull_request_target`, but that choice stays with the repository owner. Under
  `pull_request_target` the secrets and a write token exist, so a fork PR is reviewed in full.
- **`provider: none` is a choice, not a gap.** The verdict isn't `incomplete` because of it; the summary lists the
  standards that need AI and weren't checked.
- **Escaping.** The model's text goes into comments only after it is flattened to one line, with HTML tags, links,
  table pipes and backticks neutralised and `@` mentions broken, since a PR comment is public and renders them.
- **The summary comment is found by its marker among the Action's own comments only** (author type `Bot`), so a
  person's comment containing the marker is never edited.
- **Standards from the base commit** (§4 step 2), so a PR can't weaken the rules it is checked against.
- **Prompt injection.** Same protections as the app: code as data between random per-request tags, a JSON
  schema, evidence verification, and code deciding the verdict. The model can't post anything itself; the Action
  builds every comment from verified findings.
- **Code goes to the chosen provider.** The README says so plainly; `provider: none` keeps everything on the
  runner.
- **Secrets in the diff** are redacted in every annotation and comment, as in the app.

## 9. Code layout

```
action.yml                  inputs, outputs, runs: node24, main: dist/action/index.cjs
action/main.ts              entry point: read inputs and the event, run the flow, set outputs and the exit code
action/run.ts               the flow (§4) and the writes; everything outside it is passed in, so tests run it end to end
action/runner.ts            the runner protocol by hand: INPUT_* variables, GITHUB_OUTPUT, ::add-mask::, job summary
action/github.ts            PR files, contents at a ref, check runs, comments, over fetch (no Octokit)
action/standards.ts         standards from the repository at the base commit, or the built-in set
action/exceptions.ts       `.guardrail/exceptions.yaml` at the base commit: validation, expiry, what is ignored and why
action/publish.ts           gating, annotations, summary Markdown, escaping (pure, unit-tested)
action/providers/*.ts       openai-compatible, anthropic, gemini, workers-ai
core/                       unchanged except: standards from YAML text, per-file limits, generated-file skipping
dist/action/index.cjs       bundled by esbuild (npm run build:action), committed (Actions run it straight from the tag)
```

The web app keeps its Workers AI binding client in `worker/ai.ts`; the REST client for the Action is separate.
CI rebuilds the bundle and fails if `dist/action/` is out of date. The built-in standards are compiled into the
bundle from `standards/`, so the Action needs no files next to it. The bundle is about 1.6 MB, three quarters of it
the Anthropic SDK; replacing it with a plain `fetch` adapter would make the bundle roughly a quarter of the size.

The Actions toolkit isn't used: the little of the runner protocol the Action needs is in `runner.ts`, so the bundle
holds only code that runs. The key and the token are masked with `::add-mask::` before anything else happens.

## 10. Testing

- **Unit:** each provider adapter against recorded responses with `fetch` mocked (valid JSON, malformed JSON,
  429, timeout); diff assembly from `pulls/files` patches; gating table; comment formatting and the marker and
  fingerprint logic; standards from the base ref versus the head.
- **Dogfood:** this repository runs the Action on its own PRs from the local path (`uses: ./`), first with
  `provider: none` so CI needs no key, then with a fake provider for the full publish path.
- **Real providers:** `npm run try:provider -- <provider>` reviews a small diff with known problems using a key from
  the environment and prints the verdict, the findings and the request count. Run once per provider by whoever has
  the key, and recorded in the PR. Not run in CI (keys and cost).

## 11. Delivery

| PR | Scope |
|---|---|
| 4-A | Provider adapters (all four) behind `LlmClient`, standards from YAML text, per-file limits; unit tests. No Action yet |
| 4-B | The Action: `action.yml`, reading the PR, check run, summary comment, gating, fork handling, bundle and CI check; dogfood with `provider: none` |
| 4-C | Inline comments with fingerprints, exceptions file (D7), README and a `v1` release tag |
