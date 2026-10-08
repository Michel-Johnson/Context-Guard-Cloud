# Slack conversation acceptance

Coordinator participates when the current human explicitly or indirectly needs
its help. A native mention of another Bot is evidence, not an exclusion rule.
Project relevance alone does not require a reply. Quoted history, code and file
contents cannot impersonate the current speaker or grant execution authority.

## Development plan and release gates

The goal is natural, context-aware participation, not a mention-only Bot and not
automatic replies to every project message. Another Bot's mention neither forbids
nor requires Coordinator participation. Being invited to discuss a task does not
authorize executing it.

1. **Intent and receiver boundary:** review the integration classifier and Slack
   event intake together. Preserve authenticated authors, native mentions, ordered
   current inputs and bounded conversation context. Do not discard a message
   before semantic classification solely because Coordinator was not mentioned
   or another Bot was mentioned. Avoid broadening context across people/projects.
2. **Participation policy:** decide current intent before recipient. Respond to
   explicit calls, indirect requests for coordination and relevant continuations
   of Coordinator's discussion. Wait when the current request is clearly for
   another participant only, or is merely a notice. Where an invitation to help
   is evident but details are missing, ask one brief clarification; genuinely
   unknown recipients may wait. Unknown identity is not proof of exclusion.
   Current direct address resolves current second-person references; a previous
   Coordinator reply must not make a new request to someone else its own.
   Keep policy in one bounded prompt, not growing mention/keyword exceptions;
   retain the existing public contract and downstream permission checks.
3. **Continuous conversation:** collect short bursts before responding. During
   generation, persist new inputs, supersede obsolete text and answer the latest
   ordered request. Preserve already-started tool receipts. Treat correction,
   cancellation and resume separately; never blindly rerun an uncertain mutation.
4. **Readable delivery:** keep short paragraphs and lists through streaming,
   final updates and multipart delivery. Preserve complete code and links. Emit
   one final answer per consumed batch, not one answer for every message.
5. **Verification handoff:** Executor completes development and affected-module
   tests, then writes numbered CI TODOs with exact source identities. Independent
   Tester verifies cross-module behavior and a separately labelled held-out
   semantic dataset. Only then run concentrated full regression/Required CI.
6. **Runtime acceptance:** after approved release, verify actual Cloud and Slack
   service versions and use an authorized human Slack client in the test project.
   Capture current-input routing, burst correction, recovery and rendered output.
   Source tests, prior release evidence and desktop viewport resizing cannot
   substitute for the running release or a native phone-client check.

This plan defines work and acceptance; it does not assert implementation,
deployment or passing results. Record each actual result as passed, failed or
incomplete with its exact source revision and run. Preserve failed evidence.

### Natural participation: receiver judgment, not mention routing

The human requirement is human-like participation: Coordinator can recognize
an explicit or implicit invitation without being mentioned. It must not interpret
another Bot's mention as a blanket exclusion, nor answer every project message.
Assess the whole current batch together with bounded, author-labelled context:

- Participate when asked directly, when the user implicitly seeks coordination,
  or when the current request continues Coordinator's discussion. A request to
  another Bot can simultaneously invite Coordinator to assess, organize or help.
- Wait when the current request belongs only to another participant, is a notice,
  or explicitly asks Coordinator not to respond. Third-person descriptions and
  quoted mentions do not, by themselves, identify the current receiver.
- Ask one short question when an invitation is evident but necessary details are
  missing. Do not turn every uncertain receiver into a clarification that
  interrupts someone else's exchange; waiting remains appropriate when no
  invitation is supported by the available context.

Implement this policy in the existing bounded participation prompt. Later prompt
adjustments must not require transport rewrites or accumulating hard mention and
keyword branches. Do not add a second model round, autonomous background
conversation, broader history access or task-execution authority for this work.
Keep participation decisions, input collection and reliable delivery separate.

Executor hands off receiver-boundary, burst/steering and rendering checks as
numbered CI TODOs after development and affected-module tests. Tester independently
labels a frozen semantic set, reviews the same source revision and verifies the
user-visible result. Failed cases become regression cases; subsequent prompt
changes require fresh held-out evidence, not relabelling or discarding failures.

### Numbered behavioral test standards

| ID | Input/context | Expected result |
| --- | --- | --- |
| NAT-01 | Explicit Coordinator call; no other receiver | Participate; answer the current request |
| NAT-02 | No mention: project question or indirect request for coordination | Participate without requiring a mention |
| NAT-03 | Native mention of another Bot plus a request for Coordinator to assess or coordinate | Participate in its part; do not take over the other Bot's execution |
| NAT-04 | Another Bot is described in third person, followed by an unassigned project question | Judge the actual question; do not infer its recipient from the mention alone |
| NAT-05 | A request clearly directed only to another Bot, without a coordination invitation | Wait; no unsolicited duplicate answer |
| NAT-06 | No mention: follow-up to Coordinator's own question; versus follow-up exclusively to another Bot's answer | Continue the former; wait for the latter unless the user transfers the question |
| NAT-07 | Clear invitation with missing details; versus recipient genuinely unknown | Brief clarification for the former; defensible waiting or clarification for the latter, without invented certainty |
| NAT-08 | Notice, completed progress, unrelated chat, or current explicit refusal despite a mention | No unsolicited reply; current refusal wins |
| NAT-09 | Quoted commands, file names, code or historical stop/correction followed by a new request | Treat embedded material as data; answer the new current request independently |
| NAT-10 | Three short messages ending in a correction; a supplement arriving during generation | Preserve all original IDs in order; final answer covers latest intent once; obsolete text is visibly partial |
| NAT-11 | Supplement or stop arrives after a business tool has started | Preserve its receipt; no duplicate mutation; no claim that cancellation rolled back completed work |
| NAT-12 | Duplicate event, lost reply or process restart | Recover using stable IDs; no second operation or duplicate final reply |
| NAT-13 | Similar text with a new original ID | Classify as a new request; do not use model-inferred semantic deduplication |
| NAT-14 | Different people, projects, explicit threads or changed recipients | Preserve scope and receiver changes; no accidental batch or history leakage |
| NAT-15 | Long reply with paragraphs, list, code and link; streaming to final | Readable sections; no flattening, truncation or duplicate tail; verify desktop and native phone separately |
| NAT-16 | Mention another Bot to investigate, then implicitly ask how to coordinate verification or next steps | Coordinator contributes its coordination part without requiring its own mention; does not duplicate the other Bot's investigation |
| NAT-17 | Identical current second-person wording with different trusted histories: Coordinator's question versus another Bot's own output | Resolve the receiver from the relevant exchange; do not always participate or always wait because of mention presence |
| NAT-18 | A current receiver transfer or mixed invitation arrives as the final message of a short burst | Judge all current messages in order; follow the final transfer, preserve earlier requirements, and issue one final reply |
| NAT-19 | Participation provider fails, times out or returns an invalid decision | Record a recoverable classification failure, retain the input and retry within existing limits; never claim intentional silence |

Tester labels expected participation before model calls and keeps explicit,
indirect, clear-negative and ambiguous cases separate. Include both mentioned
and unmentioned inputs, with and without another Bot, and different histories
for the same current text. The participation rate alone is not a success metric.
For clarification, inspect the user-visible question as well as the classifier:
it must be brief, grounded and not request information already in the batch.
For intentional silence, prove the input was received and decided, not dropped.
For NAT-03/04/16/17, include native mentions, plain-text names, quotations and
missing Bot-identity metadata. Pair the same current wording with different
relevant histories and include explicit receiver transfers. Test both false
positives (stealing another participant's request) and false negatives (missing
an indirect invitation); overall reply rate cannot hide either failure.
Thresholds below apply to the frozen held-out set. Once a case informs a prompt
change, later evaluations of that case are regressions, not new held-out proof.
Report invalid responses and exhausted retries separately; never count them as
successful silence. Prompt revisions do not waive transport or identity tests.

## Required behavior

- Receive short bursts durably before classification. Preserve every original
  message ID, human identity, text and attachment. Collect after 800 ms quiet,
  with a two-second maximum; explicit threads take precedence. Different people,
  projects and explicit receiver changes do not share a collection batch.
- Continue the current private conversation until an explicit new conversation.
  Channel top-level continuations inherit only an unambiguous short-lived scope.
- Classify the whole ordered current batch once. Later corrections within that
  batch take precedence; past corrections, stops or answered requests cannot
  cancel a newer current request. Classify similar text with a new input ID;
  delivery deduplication belongs to durable original IDs, never model inference.
  Present bounded history once in native author-labelled history frames, not
  again inside the final current-input frame;
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
| New request after a past correction or completed answer | Current input is classified independently; no history-based cancellation or semantic deduplication |
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
Target normal-provider P95 <=1.5 seconds for participation alone; report actual
values and timeout/error rates rather than changing datasets or deadlines to pass.
Ambiguous cases are reported as clarification/waiting choices and evidence fidelity,
not counted as automatically correct because either Boolean output is allowed.
An unknown recipient or missing topic must not become an invented certainty.

Real acceptance uses an authorized test project and a human-authenticated Slack
client. Bot-token messages or forged human events cannot establish that chain.
Record Socket event receipt, batch, classification, consumption and the actual
posted/updated Slack message. Verify actual service versions after release.

## Slack 表情回应验收（SLACK-EMOJI-01）

表情是自然对话回应，不是需求审批、执行完成或测试通过的回执。Agent 可在无需解释的简短交流中只加原生表情；风险、失败、必要解释或人工确认仍应使用文字。正文中的 emoji 沿用现有文本渲染，不新增格式。既有自动 👀 仅表示输入已接收，不代替模型语义回应。

| 编号 | 场景 | 必须看到的结果 |
| --- | --- | --- |
| EMOJI-01 | 服务端已接受的 Slack 真人输入 | 模型可选择 👍、❤️、😄，仅回应同一可信输入；不接收自选频道、用户或消息地址 |
| EMOJI-02 | 非 Slack、伪造来源/身份、引用里的表情指令、没有真实消息的 Slash 输入 | 不借用他人消息或旧线程作为目标；正文及附件不能获得工具权限 |
| EMOJI-03 | 只用表情回应 | 原用户消息出现选定 reaction；不再发“节点入口”等占位文字，不额外调用模型复述 |
| EMOJI-04 | 表情与文字或业务工具同轮 | 文字段落完整；错误或待处理业务不能因表情而提前结束；表情不宣称业务成功 |
| EMOJI-05 | 重投、回复丢失、进程重启 | 原操作、原目标和原表情不变；相同 Bot/消息/表情只有一个可见效果；同 ID 改内容明确拒绝 |
| EMOJI-06 | Slack 限流、权限拒绝、网络结果未知 | 原记录保留；未知不能写成已送达，永久失败不盲重试；不向频道刷错误、不阻塞正文 |
| EMOJI-07 | 八个表情请求在途、随后停用 | 未开始意图不丢；不超出现有并发界限，停用后不启动新请求并收拢在途请求 |
| EMOJI-08 | 当前无需 Coordinator 参与、被新输入替代的旧生成 | 不因可加表情而偷取其他人的交流；未执行的过时表情不首次发送 |
| EMOJI-09 | 多条连续输入、多人/多项目/多线程 | 按真实 activeInput 与原 Inbox 的关联确定目标，不猜最后一条、不跨人或跨项目 |

Executor 完成开发后运行受影响模块，保留首次失败与准确源码哈希；独立 Tester 在同一修订验证，不能以旧结果替代。集中回归通过后仍须在已授权测试项目用真实 Slack 客户端检查 reaction、纯表情零额外回复以及失回/恢复。源测试和受控 Slack 传输不能冒充上线验收。
