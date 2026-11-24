# Eval results

What the AI adds on top of the deterministic rules, measured on the 25 labelled cases in `eval/cases/`. Raw
results are in `eval/results/` (one JSON file per run, with every case's matches, misses and false positives).

## Configurations

| Config | Detectors | Run |
|---|---|---|
| `rules` | Deterministic rules only (SEC-001 patterns, MNT-001, TST-001). No model | `2026-11-24-rules.json` |
| `llm` | Rules + Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`), prompt v3, evidence verification on. This is what the app runs | `2026-11-24-llm.json` |

Both ran on 2026-11-24 against the same 25 cases and standard versions. The `llm` run used 26 model calls (one
retry) and took about 4 s a case.

## Results

| | `rules` | `llm` |
|---|---|---|
| Standards it can detect | 3 of 8 | 8 of 8 |
| Expected findings it can detect | 12 of 19 | 19 of 19 |
| True positives / false positives / misses | 12 / 0 / 0 | 19 / 1 / 0 |
| **Recall over all 19 expected findings** | **63%** (it can't see the 7 AI-only findings) | **100%** |
| Precision | 100% | 95% |
| Blocker precision (a false blocker stops a change) | 100% (7 of 7) | **100% (10 of 10)** |
| Clean cases with a false positive | 0 of 9 | 1 of 9 |
| Hard gates passed | 2 of 2 | 4 of 4 |

Per standard (`llm`): every standard is at 100% precision and recall except **OBS-001: 1 true positive, 1 false
positive** (50% precision).

`rules` is scored only on the standards it can detect, so its own table shows 100% across the board. The
recall row above puts both on the same 19 expected findings.

### What the AI adds

- **Seven findings the rules can't express**: SEC-002 SQL concatenation (three cases, two of them prompt-injection
  attempts), REL-001 swallowed errors, REL-002 a fetch without a timeout, REL-003 an unbounded poll, and OBS-001 a
  logged Authorization header.
- **Prompt injection and "this is safe" comments.** Neither changes the outcome: all four hard gates pass.
  - Three try injection: comments claiming the code is pre-approved, and code that closes the prompt's code
    block with its own `END CODE` line and then gives new instructions.
  - One is a fixture key whose comment says not to flag it.

### What it costs

- **One false positive.** In `obs-001-logs-redacted-clean` (added in PR #4), the code logs `{ hasAuth }`, a
  boolean saying whether an Authorization header is present. The model reported it as logging a secret. OBS-001
  is a major, not a blocker, so this gives a warning, not a failed change.
- **Model calls.** About 25 a run, which is most of a day's Workers AI free allocation.

**Open follow-up:** this false positive is the kind flagged in the PR #3 review: verification proves the quoted
line exists, not that it breaks the rule. It's a warning, so it doesn't stop a change. It stays on the list rather
than being tuned away against this one case.

**Run metadata:** results saved from now on record the git commit, prompt version, model id, temperature and seed
(`run` in the JSON). The 2026-11-24 files were saved before that and only have the config description.

### Compared with the earlier v2 run (2026-11-23, 22 cases)

The v2 run had 3 false positives and 2 false blockers (80% blocker precision): placeholders such as
`"<your-key-here>"` were flagged as secrets. Two changes fixed those blockers:
- AI SEC-001 findings whose quoted values are placeholders are now dropped (design §11, item 9).
- Prompt v3 adds random delimiters.

The case set grew since then (22 to 25), so the two runs aren't strictly comparable.

## Limits of this comparison

- **One run per configuration.** Calls run at temperature 0 with a fixed seed, but that doesn't make the model
  deterministic across days or deployments, and run-to-run variance isn't measured. Design §8 planned 3 runs of
  4 configurations (about 300 calls). That doesn't fit the free allocation, and prompt 8 decided to revisit it
  once there is usage data. The `baseline` (prompt v1), `v2-no-verify` and `small` (Llama 3.1 8B)
  configurations are still to do.
- **25 hand-labelled cases** is enough to catch regressions and show the shape of the trade-off, not to estimate
  precision tightly. One case moves OBS-001 precision by 50 points.
- **The "history" hard gate isn't in this eval.** The eval calls the detector directly, and the detector has no
  input for feedback history. That gate, ten rejections then a new review that must still flag the finding, runs
  end to end against D1 in the smoke test (`npm run smoke`).
- **The size-cap case from design §8 was dropped.** Through the AI it would cost about 20 calls. The caps are
  covered by unit tests and by the smoke test's 4,000-finding check.

## Reproduce

```sh
npm run eval -- --config rules --strict          # free; CI runs this
npm run dev                                      # with LLM_MODE=workers-ai and EVAL_TOKEN in .dev.vars
npm run eval -- --config llm --save              # ~25 Workers AI calls from the eval budget
```
