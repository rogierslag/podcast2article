# Article coverage: prompt evaluation

Evaluation date: 20 September 2026.
Baseline: `a9b184d361233be028f9a417e32afc6eaeea4cb4`.

The writer sometimes turns a broad interview into a narrower essay, losing distinct topics and their defining examples.
We added the tested coverage instructions to the existing writing request: survey the whole transcript, allocate space across the main topics, preserve qualifications and counterarguments, and check for omissions before returning the article.

On six new Pragmatic Engineer episodes, this stronger prompt retained **86.3%** of the publisher's reference points, compared with **83.2%** for a separate outline followed by a writer.
It used **42.3% fewer total tokens** in that comparison.
This supports the smaller prompt change.
It does not establish an 86.3% factual-accuracy rate or a 42.3% saving against the existing production prompt.

The change supports J2 and J4 in the [user journeys](USER-JOURNEYS.md): an article should preserve the recording's substantive content at the requested level of detail.
Citation support remains a separate J5 concern.

## Why compare these approaches?

An initial experiment used 14 previously audited episodes: ten Pragmatic Engineer and four StaffEng episodes with usable publisher reference material.
A seeded, stratified split put four in development and ten in validation (seed `2284246065`).
Both approaches used the application's stored transcripts and `gpt-5.6-sol`.

On the ten validation episodes, adding a separate outline increased mean coverage from 83.7% to 94.0%.
All seven Pragmatic Engineer cases improved; all three StaffEng cases tied at 100%.
The preset requirement for improvement in both shows therefore failed.
Input tokens rose to 1.97 times baseline and output tokens to 1.88 times baseline.
Mean word counts were 2,026 and 2,040, exceeding the requested 1,100–1,700 range in most cases.
These results suggested that coverage instructions helped, but did not establish that a separate outline request was necessary.

## Follow-up method

The primary comparison used six previously untested Pragmatic Engineer episodes published in 2026, selected randomly from 17 eligible public episodes with full transcripts and substantive publisher highlights (seed `1400517224`).
Prompts, episode selection, and publisher criteria were frozen before generation.

- **Stronger writer:** existing instructions plus the coverage addition, in one initial writing request.
- **Separate outline:** the earlier frozen outline prompt, followed by its writer.
- **Common controls:** `gpt-5.6-sol`, the same transcript and source-linked JSON schema, language `auto`, a 16,384-token output limit, and no explicit temperature or reasoning override.
  Publisher writing and grading criteria were never supplied to either generator.
- **Length control:** both requested 1,450–1,550 total words, including title, introduction, headings, paragraphs, quotes, and takeaways.
  The same length-only correction instruction preserved existing substantive content.
  After examining word counts, but before reading or grading drafts, the correction limit was increased from two to five.
  Earlier outputs were retained.
  This amendment means the complete procedure was not fully preregistered.
- **Evaluation:** Codex read every completed final draft under randomized masked labels and froze all judgments before unblinding.
  No API model graded content.
  Each reference point received retained (1), partial (0.5), or omitted (0).
  Episode coverage is `(retained + 0.5 × partial) / reference points`; the primary result gives each episode equal weight.
  It is not the pooled point percentage.

Two previously tested StaffEng 2026 episodes were repeated separately as regression checks.
A third, Will Maier, remained incomplete when the additional $3 API budget prevented the next request.
Its unpaired outputs were excluded.
There were 182 point judgments across the eight completed pairs, including 154 primary judgments.

## Results

The counts below make the coverage calculation inspectable.
R/P/O means retained, partial, and omitted.
Linked publisher pages identify the reference material.

| New episode                                                                                       | Points | Stronger R/P/O | Outline R/P/O | Stronger coverage | Outline coverage |
| ------------------------------------------------------------------------------------------------- | -----: | -------------: | ------------: | ----------------: | ---------------: |
| [Kelsey Hightower](https://newsletter.pragmaticengineer.com/p/kubernetes-and-retiring-at-the-top) |     15 |          8/5/2 |         7/4/4 |             70.0% |            60.0% |
| [Alice Ryhl](https://newsletter.pragmaticengineer.com/p/why-rust-is-different-with-alice)         |     12 |         11/1/0 |        11/1/0 |             95.8% |            95.8% |
| [Dax Raad](https://newsletter.pragmaticengineer.com/p/opencode)                                   |     14 |         14/0/0 |        12/1/1 |            100.0% |            89.3% |
| [Anders Hejlsberg](https://newsletter.pragmaticengineer.com/p/typescript-c-and-turbo-pascal-with) |     14 |         13/0/1 |        12/0/2 |             92.9% |            85.7% |
| [DHH](https://newsletter.pragmaticengineer.com/p/dhhs-new-way-of-writing-code)                    |     12 |          8/3/1 |         9/2/1 |             79.2% |            83.3% |
| [AWS S3](https://newsletter.pragmaticengineer.com/p/how-aws-s3-is-built)                          |     10 |          7/2/1 |         8/1/1 |             80.0% |            85.0% |
| **Mean, equal episode weight**                                                                    |        |                |               |         **86.3%** |        **83.2%** |

The stronger prompt won three episodes, lost two, and tied one.
Its losses were 4.2 and 5.0 percentage points.
It retained Kelsey's owner-paid-last employment trade-off, Dax's pre-product-market-fit distinction, and Anders's early debugger technique more clearly.
The outline did better on DHH's terminal/model workflow and S3's reasoning about reachable crash states.
Neither approach preserved everything.

Both StaffEng repeats, [Dylan Vassallo](https://podcast.staffeng.com/season-2/dylan-vassallo-openai/) and Jonathan Wondrusch (reference: the [publisher RSS feed](https://feeds.buzzsprout.com/1687069.rss)), retained all seven points with both approaches.
These short benchmarks have a ceiling effect and are not new held-out evidence.

| Primary comparison, six episodes       | Stronger writer | Separate outline |
| -------------------------------------- | --------------: | ---------------: |
| Mean final total words                 |           1,523 |            1,493 |
| Requests, including length corrections |              15 |               26 |
| Length correction requests             |               9 |               14 |
| Input tokens                           |       1,378,903 |        2,387,272 |
| Output tokens                          |          54,779 |           95,726 |
| Mean summed request time per episode   |     117 seconds |      216 seconds |

All twelve final primary drafts met the common length band, though the stronger drafts were 2.0% longer on average.
Only one initial draft met it.
Thus the 42.3% token and 45.9% request-time reductions include corrections.
Before corrections, the initial strategies used six versus twelve requests; their quality was not separately graded.
These are generation measurements, excluding audio processing and queue time.

The practical decision rule required mean coverage no more than three percentage points below the outline, at most one loss above ten points, no consistent reading-quality or sampled support regression, and at least 25% fewer tokens.
The protocol called the coverage margin “within 3 percentage points”; the decision uses its intended noninferiority meaning, allowing a larger improvement.
This is a practical threshold, not a statistically powered noninferiority test.

The preference survives giving partial coverage zero or full credit (+1.6 or +4.6 points).
One S3 reference point, the Rust rewrite, is absent from the supplied transcript.
Excluding it gives 87.8% versus 84.8%; the writer cannot recover content absent from its transcript.

## Quality limits and implementation scope

Codex found no consistent readability regression, but this is one reviewer's judgment with one initial generation per approach and episode.
There is no independent human adjudication or estimate of variation across repeated runs.
This follow-up has no current-production-prompt arm on the new episodes, so it does not directly quantify this change's improvement over production.

The primary inputs were publisher transcripts.
They isolate the writing stage and provide no new evidence about the application's audio transcription accuracy.
Publisher emphasis is a useful reference, not an exhaustive account of every valuable topic.
Transcript/reference discrepancies were checked during grading.

All 1,919 source references in the completed pairs resolved.
Of 38 literal quotes, one outline quote omitted a required source fragment.
Its words existed in the transcript, but the production literal-quote validator would reject the draft.
The offline harness did not run the complete production postprocessing path.

Codex also checked the first, middle, and last nonquote paragraph in each draft.
In the primary set, exact cited fragments fully supported zero of 18 stronger-prompt samples and one of 18 outline samples; the remaining samples had partial support.
Short publisher transcript segments and the five-reference limit constrain these citations.
In the StaffEng repeats, complete support was one of six versus three of six.
These bounded checks do not establish a citation advantage or overall factual accuracy.
Semantic citation coverage remains unresolved.

The implementation in [openai.ts](../src/services/openai.ts) preserves the exact tested English coverage addition.
Its saved UTF-8 text, including two leading newlines and one trailing newline, has SHA-256: `f7ef22636656808eed104294452807d14f043268c307b5d4b308295a33f4659b`.
The surrounding editorial instructions, input labels, and language directives have been translated from Dutch to English for consistency.
The language directive now accompanies the editorial rules in the Responses API `instructions` field; source metadata and the transcript are supplied as an explicit user message in `input`.
Article language is still determined by the user's selection: `auto` follows the transcript's dominant language, while an explicit selection requests that language.
The coverage addition is unchanged, but the complete English prompt and message arrangement differ from the evaluated version.
Its quality has not been remeasured; offline checks verify the request structure and language settings, not equivalent model behavior.

The application retains its configured `ARTICLE_MODEL` (default `gpt-5.6-terra`), existing length ranges, source checks, literal-quote validation, and request budget tracking.
The implementation also preserves the current Flex service tier and bounded standard fallback, which were introduced after the evaluated baseline.
The study used `gpt-5.6-sol`; other models and compact/extended targets were not evaluated.
The narrow experimental length band and correction loop are not part of this change.
Future quality checks should use the deployed model and normal length settings.
Existing saved articles are not regenerated.

The full prompts, protocol, drafts, masked judgments, and usage records remain in the local `coverage-experiment` and `single-pass-comparison` research artifacts.
This note contains the reviewable aggregate evidence; it does not redistribute transcripts or private library records.
After the additional $3 limit was set, twelve generation requests had a conservative cost upper bound of $2.71009.
That is an upper bound rather than an invoice.
No further paid generation is needed for this implementation; repository checks use mocked responses.
