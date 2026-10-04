# API cost evaluation

Review date: 4 October 2026.
Production snapshot: 4 October 2026, 08:54 UTC.
Related work: [issue 62](https://github.com/rogierslag/podcast2article/issues/62).

Flex is operating in production without recorded standard fallback in this sample.
For 14 completed jobs, the known API estimate is $6.74; the same recorded tokens at standard article rates would make it $9.19.
That is a 26.7% reduction in the known estimate under a fixed-usage scenario, rather than a measured before-and-after saving.
A Codex subagent screen compares four article models on six saved transcripts, with blinded grading by `gpt-6.1-sol` at Ultra effort.
No paid API requests or production mutations were made for either Codex screen.
The resulting implementation selects `gpt-6.1-sol` with low reasoning effort for new article generation and quote repair, using the existing editorial prompt.
It adds verified cost-accounting and budget-reservation rates; existing model overrides and saved background responses remain supported.

## Evidence and method

The [sanitized evidence snapshot](data/api-cost-evaluation-2026-10-04.json) contains aggregate production costs, scenario inputs, public source references and packet hashes, per-case scores, raw-output checks, token counts, and accounting audit totals.
It excludes account identities, job and session identifiers, machine paths, transcripts, and raw drafts.
The snapshot supports checking the reported tables; independently reassessing source judgments still requires the retained local packets and drafts.

The read-only snapshot contains 29 generated jobs created from 15 September 2026 at 00:00 UTC through the snapshot time, all completed when inspected.
Saved shared copies are excluded; soft-deleted generated jobs remain eligible.
No saved copies or soft-deleted jobs were present in this creation cohort.
Twenty-eight jobs have usage ledgers and one has no ledger.
Across the full cohort, 27 attempts have unknown costs: 12 older unpriced article requests, seven failed transcription attempts, six aborted transcription attempts, and two failed article attempts.
Unknown costs are reported separately and never replaced by zero or retrospectively priced.

The Flex subset contains 14 jobs whose initial article request explicitly requested Flex; every recorded article attempt for these jobs also requested Flex.
Their article requests use the production override `gpt-5.6-sol` through the global endpoint, while transcription uses `gpt-4o-transcribe-diarize`.
These are production settings, not the repository's default article-model setting.
All 14 jobs are RSS recordings with standard article length and automatic language selection.
The snapshot does not establish actual Dutch/English coverage, speaker diversity, or audio quality.

Attempts are grouped by `operationId` for retry and fallback frequencies; transcription chunks, manual article regenerations, and quote repairs are separate operations.
Known costs include every recorded attempt across eligible jobs, including unsuccessful work, manual regeneration, and quote repair.
Costs use the ledger's saved pricing snapshots and exclude hosting, downloads, FFmpeg, and invoice adjustments.
The snapshot lacks prompt hashes, processing-release identities, and stage lifecycle history, so creation dates alone cannot establish which prompt or release processed a job.

## Observed Flex results

| Measure                                                       |          Result |
| ------------------------------------------------------------- | --------------: |
| Completed jobs                                                |              14 |
| Known transcription estimate                                  |    $4.286800958 |
| Known article estimate, including regeneration and repair     |    $2.451073300 |
| Known total estimate                                          |    $6.737874258 |
| Known estimate per completed job                              |         $0.4813 |
| Same-token standard-article scenario, unchanged transcription |    $9.188947558 |
| Reduction against that scenario                               |           26.7% |
| Article operations / attempts                                 |         22 / 22 |
| Successful / failed article attempts                          |          20 / 2 |
| Article automatic retries / standard fallbacks                |           0 / 0 |
| Transcription operations / attempts                           |       151 / 155 |
| Transcription operations with automatic retries               | 2 of 151 (1.3%) |
| Attempts with unknown costs                                   |               8 |

The six failed transcription attempts all report `credit_balance_exhausted` on 27 September; four are extra automatic attempts within the two affected operations.
They are payment failures, not evidence of Flex capacity problems.
Five jobs have seven manual article regenerations, which must not be counted as automatic API retries.
One separate quote-repair operation contributes $0.001036 to the article estimate.
Zero observed standard fallback across 22 operations does not establish its frequency under heavier load or other time periods.

Successful article-attempt elapsed time has a median of 41.88 seconds and a nearest-rank 90th percentile of 66.93 seconds across 20 attempts.
This measures submission through recorded completion, including background polling and any interruptions, rather than HTTP submission latency alone.
The job-completion measure is `completedAt - createdAt`, which also includes queueing, media preparation, transcription, and later manual regeneration.

| Completion-time view                                 | Jobs |         Median | Nearest-rank p90 |
| ---------------------------------------------------- | ---: | -------------: | ---------------: |
| All Flex jobs                                        |   14 | 269.66 minutes | 9,031.42 minutes |
| Excluding five manually regenerated jobs             |    9 |  19.78 minutes |   507.90 minutes |
| Also excluding two jobs delayed by exhausted credits |    7 |  17.16 minutes |    32.91 minutes |

The last row describes ordinary completion within this small sample; it does not replace the delayed jobs in the overall result.
The high completion-time median for all jobs reflects later regeneration, and the nine-job tail includes payment interruptions.
There is no matched standard-tier timing baseline, so this review cannot attribute completion-time changes to Flex.

## What the recent quality work establishes

[PR 80](https://github.com/rogierslag/podcast2article/pull/80) implemented explicit Flex requests and bounded standard fallback with mocked retry tests.
[PR 93](https://github.com/rogierslag/podcast2article/pull/93) preserves paid processing checkpoints across drained deployments, while [PR 95](https://github.com/rogierslag/podcast2article/pull/95) adds bounded quote repair whose requests belong in cost comparisons.
The [coverage evaluation](ARTICLE-COVERAGE-EVALUATION.md) found 86.3% versus 83.2% coverage, with 42.3% fewer tokens and 45.9% less summed request time for a stronger single writer than a separate outline followed by a writer.
That experiment used publisher transcripts and Sol; it did not compare Terra, validate cheaper transcription, or measure savings against the current production prompt.
Semantic citation support and dependable length enforcement remain open quality concerns.

## Current prices and fixed-usage scenarios

Official [pricing](https://developers.openai.com/api/docs/pricing), checked on 4 October 2026, lists these short-context Flex rates in USD per million tokens:

| Article model   | Input | Cached input | Cache write | Output |
| --------------- | ----: | -----------: | ----------: | -----: |
| `gpt-5.6-sol`   | $2.00 |        $0.20 |       $2.50 | $10.00 |
| `gpt-5.6-terra` | $1.00 |        $0.10 |       $1.25 |  $6.00 |
| `gpt-6.1-sol`   | $1.00 |        $0.05 |       $1.25 |  $5.00 |
| `gpt-6-luna`    | $0.05 |       $0.005 |     $0.0625 |  $0.25 |

The following averages divide the Flex subset's known costs by its 14 completed articles, including manual regeneration and quote repair.
The current row uses recorded estimates; the other rows apply candidate prices to the same successful generation usage and retain the same transcription costs.

| Article model, all Flex | Transcription per article | Generation per article | Total per article | Total reduction |
| ----------------------- | ------------------------: | ---------------------: | ----------------: | --------------: |
| Current `gpt-5.6-sol`   |                   $0.3062 |                $0.1751 |           $0.4813 |               — |
| `gpt-5.6-terra`         |                   $0.3062 |                $0.0931 |           $0.3993 |           17.0% |
| `gpt-6.1-sol`           |                   $0.3062 |                $0.0873 |           $0.3935 |           18.2% |
| `gpt-6-luna`            |                   $0.3062 |                $0.0044 |           $0.3106 |           35.5% |

Applying those rates to all successful article attempts in the Flex cohort gives known-total scenarios of $5.59 for Terra Flex, $5.51 for 6.1 Sol Flex, and $4.35 for Luna Flex, with transcription held fixed.
These scenarios assume unchanged tokens, caching, successful outcomes, and repair behavior; none is a measured model-comparison result.
Transcription accounts for 63.6% of the current known estimate, which limits the saving available from an article-model change alone.
Eight attempts in this subset have unknown costs and remain outside these totals; these figures are API estimates, not invoice amounts.
[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) supports the Responses API, structured outputs, and sufficient context for this sample, making it a technically suitable evaluation candidate.
Its article quality, citation support, and extra repair frequency still require the same checks as the other candidates.

## Codex screen method

The user requested a model comparison through Codex subagents rather than paid API testing.
Six public RSS transcripts were selected before candidate drafts were inspected: five predominantly English recordings and one predominantly Dutch recording with substantial transcription artifacts.
The recordings cover developer productivity, AI model comparisons, product leadership, platform releases, Rotterdam architecture, and decision-model applications.
Three of six are from How I AI, so the sample is narrow and does not represent private meetings or every supported source provider.
All runs use automatic language selection and the standard 1,100–1,700-word target.

Each case/model run starts in a fresh context and receives the current production editorial instructions, full transcript with segment IDs, and the exact source-linked JSON schema.
The shared editorial instruction hash is `c05c6ce17555731dea9d92796fa3eb5fa8ba5a4bd6c0611437c5a438c5591411`, extracted at implementation revision `c65ebc7b3297f7f73e544ca96f12be5122ecdf42`.
All 30 frozen instruction, input, schema, transcript, and metadata file hashes are checked after the experiment.
Generators may read only their own packet, return one initial article, and receive no article-quality feedback or repair pass.
Actual runtime reasoning defaults are low for both Sol models and medium for Terra and Luna; the test therefore compares these defaults, rather than equal reasoning effort.

Tool-output truncation prevented full schema delivery to 17 original runs and three replacements.
Those 20 runs were excluded solely by a full-input delivery audit, with their raw drafts and token usage preserved.
The replacement transport eventually delivered the unchanged schema in 200-line chunks, read individually.
The selected 24 runs all received the complete editorial instructions, schema, and every full transcript segment line; exposure does not prove attention.
There are 44 generator runs in the accounting, comprising 24 selected runs and 20 discarded deliveries.

An Ultra-effort `gpt-6.1-sol` agent built a source-only checklist before seeing drafts.
The checklist has 64 topics across the six recordings and hash `9c475f4b70005bff5624c04dfc812de5c02d13eb1bb41c17ddfa3479face2354`.
A pilot grade on the original inputs was discarded after the delivery audit.
Six fresh Ultra graders assess one case each, with randomized model labels and no access to model identities, prices, other grades, or session logs.
Their rubric is factual support 30, topic coverage 25, citation support 20, readable article 10, speaker attribution and quotes 10, and requested length 5, totaling 100.
Every topic receives an explicit covered, partial, or omitted judgment before unblinding.
One model grader and one selected generation per case are screening evidence, not independent human adjudication or proof of general equivalence.

Raw JSON/schema validity, source IDs, literal quote matching, and word counts are checked locally against the frozen schema and existing production validators.
Content judgments are reported separately from raw usability because Codex generation lacks production's strict server-side structured decoding and automatic quote repair.
A raw schema failure therefore does not establish that the same model would fail the production API's strict response format.
An independent readable-prose count supplies length for the malformed but parseable Dutch draft; its unavailable mechanical quote checks remain unavailable.
No paid API calls, production mutations, article repairs, or default changes are part of this screen.

## Screen results

At the recorded runtime defaults, `gpt-6.1-sol` receives the highest score in all six cases, averages 91.2/100, and has no fatal source-support finding from the grader.
It is the strongest next production candidate in this screen.
Luna has the lowest price, but its Dutch draft combines De Kaai’s factory-wall, bell-tower, and column details with Flow Town, and turns damaged transcript wording into a confident legal assertion.
Terra scores below current Sol and introduces rewritten quote blocks and an invented warehouse name in the Dutch case.
These findings favor 6.1 Sol ahead of Terra or Luna; they do not establish production equivalence.
The lower-cost 6.1 Sol implementation also uses the follow-up comparison below to retain the existing prompt.

| Article model   | Mean score / 100 | Lowest score | Factual / 30 | Coverage / 25 | Citation support / 20 | Fatal source-support drafts |
| --------------- | ---------------: | -----------: | -----------: | ------------: | --------------------: | --------------------------: |
| `gpt-5.6-sol`   |             83.7 |           75 |         26.8 |          19.9 |                  14.8 |                      1 of 6 |
| `gpt-5.6-terra` |             78.7 |         71.5 |         26.2 |          19.2 |                  14.9 |                      1 of 6 |
| `gpt-6.1-sol`   |             91.2 |           85 |         28.8 |          22.7 |                  16.2 |                      0 of 6 |
| `gpt-6-luna`    |             81.6 |           69 |         25.4 |          19.8 |                  15.9 |                      2 of 6 |

The fatal flags for current Sol, Terra, and one Luna draft concern output-price units that are incomplete in the Dev Day transcript.
They are failures against the frozen source-only criterion, not independently verified claims that the real-world prices are wrong.
Luna’s second fatal flag is the cross-project conflation in the Dutch recording.
All models still have source-citation gaps, including paragraphs whose facts exist elsewhere in the transcript but are not supported by their attached segment IDs.

| Source case                     | Current Sol | Terra | 6.1 Sol | Luna |
| ------------------------------- | ----------: | ----: | ------: | ---: |
| 07: Meta diff authoring time    |          92 |  81.5 |      93 | 84.5 |
| 11: Model blind taste test      |          85 |    82 |      91 |   87 |
| 12: Peter Sellis product advice |          75 |    77 |      85 |   79 |
| 18: OpenAI Dev Day              |          85 |    76 |      90 |   84 |
| 24: Flow Town / Rotterdam       |          77 |  71.5 |      92 |   69 |
| 26: Jev applications            |          88 |    84 |      96 |   86 |

The long product-leadership interview remains difficult for every model.
All four omit the mathematical systems-thinking discussion; 6.1 Sol retains more of the other career and personal material but cites unrelated segments for the team-tenets claim and produces 1,879 words.
Current Sol also writes the English model-comparison episode in Dutch despite automatic language selection requiring the source’s dominant language.
These are specific coverage, citation, language, and length problems that a price comparison alone cannot detect.

## Raw output compliance

| Article model   | JSON passes | Schema passes | Automated literal-quote passes, assessable drafts | In-range length, assessable drafts | Raw usable according to grader |
| --------------- | ----------: | ------------: | ------------------------------------------------: | ---------------------------------: | -----------------------------: |
| `gpt-5.6-sol`   |         6/6 |           6/6 |                                               5/6 |                                5/6 |                            3/6 |
| `gpt-5.6-terra` |         5/6 |           0/6 |                                               3/4 |                                3/5 |                            0/6 |
| `gpt-6.1-sol`   |         6/6 |           6/6 |                                               6/6 |                                5/6 |                            5/6 |
| `gpt-6-luna`    |         6/6 |           0/6 |                                               6/6 |                                4/6 |                            0/6 |

Every Luna and Terra raw draft exceeds the schema’s five-source maximum somewhere; Terra also has one malformed JSON draft and an invalid extra section in another.
Strict production structured outputs would constrain these arrays, so the zero raw-schema pass rate is not a measured production failure rate.
The parse/shape failures leave two automated Terra quote checks unavailable; manual grading identifies rewritten quotes in both affected drafts.
No selected draft received a repair or length-correction pass, and no invalid citation was silently discarded for grading.
Only 6.1 Sol has both valid schema and passing automated literal quotes in every case, although its long-interview draft exceeds the word target.

## Costs from actual agent token usage

The following costs price recorded per-response token usage at the dated global Flex rates above.
They are API equivalents for Codex activity, not paid OpenAI API calls, a Codex bill, or production-generation costs.
The article-producing response includes Codex system context, tool history and cache behavior; the complete agent adds all preceding reading and tool-response turns.
The reading transport differs between retained originals and replacements, so complete-agent means must not be treated as a controlled one-shot API comparison.

| Article model   | Mean article-producing response | Mean complete selected agent | Mean final input tokens | Mean cached input subset | Mean output tokens |
| --------------- | ------------------------------: | ---------------------------: | ----------------------: | -----------------------: | -----------------: |
| `gpt-5.6-sol`   |                         $0.0596 |                      $0.2513 |                  83,787 |                   79,083 |              3,432 |
| `gpt-5.6-terra` |                         $0.0328 |                      $0.1604 |                  84,716 |                   80,640 |              3,437 |
| `gpt-6.1-sol`   |                         $0.0265 |                      $0.0831 |                  77,008 |                   70,933 |              3,367 |
| `gpt-6-luna`    |                         $0.0017 |                      $0.0083 |                  96,553 |                   91,051 |              3,815 |

For each response, ordinary input is total input minus cache-read and cache-write tokens; each category is priced once, alongside output.
Reasoning output is already included in output tokens and is not added again.
Cache writes are zero in the generator records.
Long-context multipliers apply per request above 272,000 input tokens, not to cumulative agent input; an independent audit reconciles all 412 generator response records and finds a maximum request input of 186,042 tokens.

| Experiment work                                                | Flex API equivalent |
| -------------------------------------------------------------- | ------------------: |
| 24 selected generator runs                                     |             $3.0186 |
| 20 discarded input-delivery runs                               |             $2.5698 |
| Source checklist, discarded pilot grade, and six final graders |             $2.2917 |
| Generator and grader total                                     |             $7.8800 |

The total includes discarded setup work rather than treating it as free, and excludes the parent/orchestration conversation and independent accounting-verification agent.
Raw drafts, frozen packets, masked grades, per-agent counters, audits, pricing assumptions and aggregation scripts are retained together as local experiment artifacts.
No API latency, retry/fallback frequency, repair cost, or cost per production-usable article can be measured from these Codex runs.

## Follow-up prompt comparison

A second frozen screen compares the existing editorial prompt with a revised prompt on five public recordings, using two independent generations per model and prompt.
The three development cases were the product-leadership interview, Dev Day, and Flow Town.
The two unseen cases were The Pragmatic Engineer AMA and the Rotterdam coalition-agreement episode.
Each of forty selected drafts received the full transcript, schema and assigned instructions; fresh 6.1 Sol Ultra graders assessed eight anonymous drafts per case against a source-only checklist.
Generators retained the captured defaults: Luna medium and 6.1 Sol low.
The [sanitized follow-up evidence](data/article-prompt-evaluation-2026-10-04.json) contains hashes, per-draft scores and raw-output checks, aggregate costs and the independent token audit.

| Model         | Prompt   | Mean score / 100 | Fatal source-support drafts | Held-out mean / 100 | Uncached final-response Flex equivalent |
| ------------- | -------- | ---------------: | --------------------------: | ------------------: | --------------------------------------: |
| `gpt-6-luna`  | Existing |             76.1 |                        6/10 |                75.0 |                                 $0.0055 |
| `gpt-6-luna`  | Revised  |             73.4 |                        4/10 |                65.0 |                                 $0.0056 |
| `gpt-6.1-sol` | Existing |             89.6 |                        0/10 |               87.25 |                                 $0.1056 |
| `gpt-6.1-sol` | Revised  |             90.6 |                        0/10 |               87.75 |                                 $0.1059 |

The revised prompt removed Luna's fatal findings on the development cases, but all four revised held-out drafts received fatal source-support findings.
The failures include unsupported entity identities, a changed career timeline, housing-category conflation and invented station details from damaged wording.
Revised Luna fails the predeclared candidate bar of zero fatal findings and a mean score within three points of revised Sol.
Sol's one-point mean improvement does not establish a dependable prompt gain; generation costs are essentially unchanged.
The implementation therefore keeps the existing editorial prompt.
Its ten follow-up Sol drafts pass raw schema checks, nine pass literal-quote checks, and nine meet the requested length range.
Production strict decoding and bounded quote repair remain in place; semantic citation support and length control still require monitoring.

One Luna attempt omitted the final four source segments and was replaced solely for incomplete input before grading.
All forty included generators and all five graders pass complete-input audits; no quality failure was excluded.
The accounting retains all forty-one generation attempts and reconciles 943 unique response records with native cumulative counters.
Generators cost $2.9884 in Flex API equivalents, including $0.0117 for the excluded delivery attempt; source-checklist and grader work adds $2.4510, for $5.4394 in total.
Parent orchestration, prompt authorship and the independent verification helper remain outside that total.
Removing cache discounts from the final response still leaves Codex system/tool context, so the table is not a production forecast or API bill.
Five selected difficult episodes, two repetitions per cell and one grader model do not establish a general production failure rate.

## Selected model and rollout

Select 6.1 Sol with low reasoning effort for new article generation and quote repair, keeping transcription and the existing editorial prompt unchanged.
The production fixed-usage scenario is $0.3935 per completed article versus the current known $0.4813, an 18.2% reduction; it still assumes unchanged usage, caching, regeneration and repair behavior.
The Codex screen favors 6.1 Sol on content, but semantic citation support and long-source length control remain unresolved.
Mocked SDK tests cover the selected model and effort, strict schema requests, new quote repairs, bounded Flex fallback, known cost estimates and conservative budget reservations.
Recovery tests change the configured model between submission and restart and verify that saved older-model responses resume without a replacement generation request.
The accounting table now recognizes 6.1 Sol alongside the two 5.6 article models, including actual-tier, cache-write, long-context and regional pricing.
Saved historical estimates keep their original pricing snapshots.
No live API validation was performed; actual rollout costs, repair frequency and article quality remain to be measured from their persisted usage and outcomes.
The existing production environment explicitly selects `ARTICLE_MODEL=gpt-5.6-sol`, so deployment must change that setting to `ARTICLE_MODEL=gpt-6.1-sol`; repository defaults cannot supersede an explicit override.
The [operations guide](OPERATIONS.md#article-service-tier) describes this configuration change through the normal drained deployment.

Keep the [issue 33 decision](https://github.com/rogierslag/podcast2article/issues/33#issuecomment-5686955291): retain current transcription for now, reassess on 15 December 2026, and decide by 15 January 2027 before the [26 February removal deadline](https://developers.openai.com/api/docs/deprecations#2026-08-26-transcription-models).
A separate speaker-label ablation can reuse saved transcripts while retaining their segment boundaries and timestamps, but replacement transcription still needs representative audio review and working source-link playback.
