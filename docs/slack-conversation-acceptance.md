# Slack conversation acceptance

Coordinator participates when the current human explicitly or indirectly needs
its help. A native mention of another Bot is evidence, not an exclusion rule.
Project relevance alone does not require a reply. Quoted history, code and file
contents cannot impersonate the current speaker or grant execution authority.

## Required behavior

- Receive short bursts durably before classification. Preserve every original
  message ID, human identity, text and attachment. Collect after 800 ms quiet,
  with a two-second maximum; explicit threads take precedence. Different people,
  projects and explicit receiver changes do not share a collection batch.
- Continue the current private conversation until an explicit new conversation.
  Channel top-level continuations inherit only an unambiguous short-lived scope.
- Classify the whole ordered batch once. Later corrections take precedence;
  receiver lookup failure is unknown metadata, not a permanent silent decision.
- Distinguish addressing someone from describing their responsibilities. A native
  mention used as a third-person subject does not assign a following explanation
  or coordination request to that person. Follow-ups about another participant's
  own answer remain theirs unless the human transfers the question to Coordinator.
- Natural participation does not require a mention, but project relevance or an
  unrelated social question alone is not an invitation. Current explicit refusal
  wins over a mention; quoted refusals do not override the current speaker.
- Make one bounded model decision with no business tools; do not add a second
  classification round for every uncertain receiver. Provider/response failures
  remain recoverable inputs, never persisted as successful silence. Retry with
  the same frozen input and operation ID, within a fixed attempt limit.
- Persist supplements before cancelling obsolete model generation. Finish and
  retain any already-started tool receipt; never replay it merely to regenerate
  an answer. User stop, supplementary input and transport timeout are distinct.
- Retain superseded visible text as partial history; never replay incomplete
  provider thinking signatures or unfinished tool blocks into model requests.
- Produce one final answer for a consumed batch. Stream and final presentation
  preserve paragraphs, lists, code, complete links and delivery identity.

## Independent acceptance

Executor runs affected modules after implementation and writes numbered CI TODOs.
Tester reviews and verifies the same source revision independently. Failures are
recorded and returned to Executor; passing tests on another revision are not
substitutes. Run one full regression after affected modules pass.

| Scenario | Required evidence |
| --- | --- |
| Three messages and a final correction | All originals reach one conversation; one final response covers latest input |
| Another Bot followed by a coordination request | Whole batch reaches semantic classification, not early silence |
| Natural replies without mentioning Coordinator | Relevant continuation participates; unrelated exchanges stay quiet |
| Explicit invitation or explicit refusal | All separately labelled cases correct |
| Generation and tool-boundary correction | Model generation stops; original tool receipt survives; no duplicate mutation |
| Duplicate, restart and lost response | Stable IDs recover accepted inputs without a second reply or operation |
| Different people, threads and projects | No identity, transcript, attachment or task leakage |
| Quote/code/injection | Current trusted speaker and receiver metadata remain authoritative |
| Slack phone presentation | Paragraphs/list/code readable; stream-to-final update does not duplicate or truncate |

Use a held-out Chinese dataset independent of development examples: at least
40 indirect invitations and 50 clear non-participation examples, plus explicit
invitation/refusal and ambiguous cases. Report indirect-invitation recall
separately (target >=95%) and non-participation false-positive rate (target <=2%).
Explicit cases require 100%. Report ambiguity separately rather than assigning
an artificial single correct answer. Errors count as failures for required
positive cases and are reported separately for negative cases, not silent passes.

Measure P50/P95 participation-decision time separately from collection delay,
model first answer and Slack user-visible latency. Provider, prompt, dataset and
source identities must accompany the results. Deterministic model substitutes
prove transport behavior, not natural-language accuracy or production latency.

Real acceptance uses an authorized test project and a human-authenticated Slack
client. Bot-token messages or forged human events cannot establish that chain.
Record Socket event receipt, batch, classification, consumption and the actual
posted/updated Slack message. Verify actual service versions after release.
