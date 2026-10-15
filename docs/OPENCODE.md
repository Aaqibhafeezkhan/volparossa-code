# OpenCode integration — development candidate

The selected foundation is OpenCode v1.18.34 at
`aec0b9a6d8898f68f923aaf08b7306d931fd9d76`. Codex scripts and reports are historical,
not an alternative implicitly selected by the editor.

## Explicit source build

On Linux amd64, with Python 3 and bubblewrap already installed:

```sh
python3 -B scripts/build_opencode_runtime.py
python3 -B scripts/build_opencode_runtime.py --execute
```

The first command only previews the work. The second downloads the pinned Bun
build tool, exact upstream source and frozen-lockfile dependencies inside ignored
`build/opencode-runtime/`. Dependency lifecycle scripts are disabled; compilation
runs without network access or access to the owner's files and credentials.
No tool is installed globally. An interrupted, unfinished build can be resumed
with `--execute --resume`; a finished report is not overwritten.

The tested headless build occupies about 3.1 GB. Its embedded web UI is intentionally
absent; reusing upstream web/mobile/desktop clients remains separate work. The
operator-owned `build-report.json` records the binary and source hashes. Supply
a separately provisioned, owner-controlled Node executable to the launcher;
the build script does not download Node or a model.

## Explicit native editor inputs

Set user-level, machine-scoped settings, not repository settings:

```json
{
  "volparossaCode.privateSocket": "/absolute/owned-private/compute.sock",
  "volparossaCode.openCodeRuntime": {
    "version": 1,
    "opencode": "/absolute/prepared/opencode",
    "opencodeSha256": "<actual executable SHA-256>",
    "buildReport": "/absolute/prepared/BUILD_REPORT.json",
    "node": "/absolute/prepared/node",
    "nodeSha256": "<actual Node executable SHA-256>"
  }
}
```

Use canonical owner-controlled inputs, not group/other-writable files. The build
report binds the upstream revision, lockfile, local patch, executable hash and
runtime version. It is an operator-owned build record, not independent release
authorization or evidence of model behavior. The launcher downloads nothing.

The core socket must be same-owner mode `0600` in a mode-`0700` directory. The
owner-selected executor must advertise one of the exact supported conversation
profiles below; the editor does not choose an arbitrary model or download one.
Python 3, bubblewrap and system runtime libraries must already be available.
No existing OpenCode/Codex profile is modified.

An optional user-level `volparossaCode.ownerVerification` plan adds an
owner-selected check after each completed coding turn. Each invocation requires
separate approval; an actual failed check can continue the same session within
the original task budget. See [editor setup and check limitations](OWNER_VERIFICATION.md#use-from-the-editor).

### Core-selected coding profiles

An experimental owner-selected `outputConstraint: "qwen_tagged_tool_json_v1"`
field may be added to `volparossaCode.openCodeRuntime`. It requires the matching
new core capability and native Qwen4B backend; an older or unsupported core is
refused before OpenCode starts. Omitting the field preserves the existing
session and request forms. Opening a workspace still starts nothing.

Each provider connection negotiates the same capability. Requests with offered
tools carry the selector; requests without tools omit it. Ordinary answers
remain allowed, and tools still require their existing execution authority.
The core controls alias derivation and constrained generation; the application
accepts neither a caller-supplied grammar nor an unrequested result claim. There
is no generated-output repair, forced tool use, model substitution or larger
budget. This profile does not imply arbitrary JSON-schema validation or private
execution on other peers.

76 targeted Node contract tests and ten inert Python session-selection tests
pass. They cover actual HTTP/Unix framing with synthetic core replies, legacy
compatibility, result binding, namespace command selection and startup refusal.
No model or OpenCode binary ran in those tests. The core's source-only normal
build now passes all five native check targets; ABI, loader, BF16/F32 and
output-constraint checks also pass under ASan/UBSan. The wider upstream tensor
test still fails on its previously recorded Q1_0/Q8_0 alignment error. See
[the original source-only run](https://github.com/VOLPAROSSA/volparossa/actions/runs/38671551374).
The earlier invalid JSON trial is not considered fixed by these contract checks.

The next native trial is pinned to core
`9d044921f7e684737f9b10868429de42bc5416c9`, with matching build v3/backend v2
provenance and an explicit selector passed into the actual OpenCode runtime.
The native guest and outer verifier require task receipt v2 with that selector;
legacy Torch arguments and task receipt v1 remain unchanged. Source checks still
gate the next real edit/test trial; no new model run has been dispatched.

- `qwen3-0.6b-v1`: the unchanged default; native template
  `qwen3-tools-nonthinking-v1`, model context 32,768 tokens.
- `qwen3-4b-instruct-2507-v1`: the explicit larger profile; native template
  `qwen3-tools-instruct-2507-v1`, model context 262,144 tokens.

Both profiles keep the same bounded conversation allowance: at most 12,288 prompt
tokens, 1,024 new tokens, 4,096 output bytes and a 524,288-byte request envelope.
The larger model context does not enlarge the admitted prompt or authorize silent
truncation. The core remains responsible for exact token validation and resource
admission. Model quality and useful execution still require real-model evidence.

Before starting OpenCode, the owner validates the complete core capability reply,
including template, limits, private-local scope and negotiated `greedy_v1` policy.
Current native sessions also require `execution_error_version: 1`; an older core
without that capability is refused before starting the runtime. Both native smoke
profiles pin core `6a517b576baa17e7329661ee0476d1848081d114` for this contract,
including the preserved main integrations and reviewed source-quality fixes.
Legacy Q&A and conversation clients that do not opt in remain unchanged.

That one model identity binds the native catalog, all agent roles, provider,
task/session checks and trial receipt. Each provider request checks the core again;
a different profile or incompatible result is refused, not silently substituted.
The existing version-1 ready bridge without a model identity is interpreted only
as its historical fixed 0.6B profile, never as 4B. Current owners report the actual
validated identity explicitly. Socket and orchestration tests cover these bindings;
they are not evidence of successful 4B coding or confidential peer execution.

## Execution path

```text
Editor scope and approvals -> bounded stdio bridge
  -> disposable Linux namespace owner
  -> authenticated OpenCode HTTP/SSE sessions
  -> authenticated loopback Chat Completions provider
  -> same-owner core conversation IPC -> current private-local executor
```

OpenCode HTTP and the model provider stay inside the disposable network namespace.
Only the selected project is writable as `/workspace`; configuration and session
state are temporary. Host routes, DNS and firewall remain unchanged. Upstream
permissions are defense in depth, not the OS sandbox.

The configured `build`, `general` and read-only `explore` agents use a compact
prompt for the current Qwen single-tool conversation interface. Each tool turn
must propose one offered call, then wait for its correlated result. This replaces
the pinned upstream default prompt, which explicitly requests parallel tool calls
that this core interface cannot represent. Workspace/approval permissions,
read/edit/test requirements and core-owned scheduling are unchanged. This prompt
alignment does not itself prove that the model can complete a coding task.

Supported message/tool history and call identities are preserved. Unsupported
inputs fail rather than being silently shortened or stripped. The provider waits
for core cleanup before returning SDK-compatible SSE or JSON; this is not
token-by-token model streaming. Exhaustion remains `length`, not successful `stop`.
Cleanup-confirmed invalid/truncated output or an unmet tool choice returns a
terminal HTTP 422, so the pinned SDK and OpenCode do not blindly regenerate that
unusable turn. The negotiated `execution_budget_exceeded` response also maps to
422, but only for the matching admitted task after confirmed core cleanup. It
does not claim a completed model response. Busy, other execution/transport
failures and uncertain cleanup remain separate; this change does not make an
incomplete answer usable.
An already reported, known terminal task failure is separate from runtime cleanup:
the task still fails, while a confirmed session/provider/process shutdown can
succeed. Unknown/protocol errors and any unconfirmed cleanup still fail closed.
The provider also counts cleanup for a correlated, admitted task ending with
the core's terminal `execution_failed`, `cancelled` or negotiated
`execution_budget_exceeded` response, or a valid result
that races local cancellation. These remain failed requests, not model results.
The receipt is retained per rejection inside the checked transport; an error code
alone, admission alone, a cancellation acknowledgement or a disconnect cannot
establish cleanup. This prevents a later native retry from turning a safely
reaped failed attempt into a false runtime-cleanup mismatch.
Cancellation reaches the core and owned session tree. Cleanup uncertainty remains
an error even when text was generated.

Only correlated one-shot bash/edit requests can be approved. Inspect proposed
changes and relevant tests: a completed native turn is not task-correctness proof.
Cancellation does not roll back existing edits. Background subagent mode is not
enabled until its extended lifecycle is supported.

## No implicit provider or installation fallback

Generated configuration enables only `volparossa`, disables sharing, auto-updates,
default/external plugins, LSP downloads and repository configuration, and inherits
no owner credentials. Upstream flags alone do not prevent background dependency
installation: the recorded `opencode-no-runtime-installs.patch` disables the config
loader's install when `VOLPAROSSA_NO_RUNTIME_INSTALLS=1`. Outer network isolation
remains mandatory; the launcher requires the patch in the build report.

## Network cooperation remains required

The public core broker currently performs signed-public-dataset text inference,
not private conversation/tool turns. It must not receive private OpenCode history
disguised as public content. The implemented `volparossa_delegate_public` tool
delegates an exact owner-authorized public snapshot through that broker and returns
the original result, tool-call ID and core task ID. It does not invent an execution
receipt or treat provider selection as proof that a peer executed anything.

To enable this development path, set `volparossaCode.publicSocket` in user settings
to a separately started, same-owner public-serve endpoint and run **OpenCode Task
with Enrolled Public Work**. This currently depends on core branch
`feature/browser-cooperative-compute`, inspected at
`610866b8770b63719ec1f4b4ce6abb6a83a596ef` (PR #178); it is not an interface supplied
by the current main branch. The private conversation service is still needed for
OpenCode's planning turns.

The editor captures and displays the exact public question (at most 512 UTF-8
bytes), selected excerpt (at most 4096 bytes) and supported license for explicit
rights confirmation. It does not rescan the project. Only a single-use proxy
socket enters the runtime namespace; the raw public service socket and its
general submission authority stay outside. The tool takes no model-supplied
content arguments. Private planning, tool history and other files do not become
public because the tool is enabled. Public disclosure cannot be reversed by
cancelling a task. Cancellation is propagated to the actual core task and cleanup
is awaited; incomplete results remain incomplete.

### Explicit public single-file proposals (candidate)

**Run OpenCode Task with Enrolled Public Source** connects the same native agent
loop to the code-proposal service. It captures the complete saved source file in
the selected workspace, displays its exact bytes and public question, and asks
for sharing-rights consent before starting OpenCode. This uses the v6 code task,
not the document-summary enrollment of **Enrolled Public Work**. The two service
purposes remain checked and are not silently substituted.

The agent can invoke its existing argumentless `volparossa_delegate_public` tool
once to receive the original source-bound replacement proposal. Core still
chooses the executor; the agent may inspect the result and propose local edits
under the existing one-shot approvals and owner-selected verification loop.
Private planning history, verification output and other files are not exported.
The private conversation service is still needed for planning. The new editor
wiring is not yet proof of a complete real-model OpenCode/peer coding loop or
protected private network execution.

**Propose a Replacement for a Public Source File** is a separate owner command,
not a private-history fallback. It captures the complete saved selected file
(at most 4096 UTF-8 bytes) and a public task (at most 512 bytes), shows their exact
contents and asks for license/sharing-rights consent. Use an explicitly configured
code-proposal public service; an ordinary document service and a private
conversation service are not interchangeable with it. The core selects and
accounts for the actual peer; the application does not add a scheduler.

The additive `public_code_proposal` operation requests `single_file_replacement_v1`.
Its original worker output is checked against the selected source hash, task
receipt, model identity, report hash, dataset bindings, EOS and cleanup. The same
opaque snapshot and result contract also pass through the existing native
`volparossa_delegate_public` proxy, whose model-facing arguments stay empty.
For the direct owner command, no local planning model is needed to rewrite or
reinterpret the peer's candidate.

Only the exact raw complete replacement is eligible for a separate local edit
approval. Markdown fences are not extracted; partial output is not repaired or
called complete. The owner rechecks the original source hash and pinned local
file identity after approval, rejects symlinks and hardlinks, and replaces only
that selected file. Other files and the original test files are not supplied to
the peer or changed by this operation. An optional user-configured verifier uses
the existing separate one-shot local, read-only/no-network check; its output is
not automatically shared with peers. A passed check is not general correctness.

Focused checks use real Unix framing and owner filesystem operations with
explicit synthetic core/worker reports. They are contract evidence, not real
model quality, live peer execution or a completed distributed coding workflow.
No private remote-execution protection, automatic publication of private code or
complete multi-file coding capability is claimed by this first public contract.

The additive disposable-guest driver `scripts/smoke_public_code_proposal.cjs`
prepares an explicitly public copy of the **unchanged** `ORIGINAL` and `TEST`
fixture from the existing inference trial. Only the selected source and question
are submitted to the real external code-proposal service; the original tests
remain local. No local planner, supplied model answer or scripted model tool
sequence is used. The driver requires the initial three tests to fail, a
source-bound complete peer proposal, separate fixture-owner edit approval, the
existing approved read-only check and the same independent immutable tests to
pass. It records hashes and closed results, not source text or model output.
Its parent must independently establish peer execution, route provenance and
guest cleanup; the driver receipt alone does not prove them.

Capture its committed sources and the already available pinned Node executable
with `scripts/pack_opencode_cooperation.py --public-code-proposal --execute` and
the explicit `--code-revision`, `--node` and fresh workspace `--output` inputs.
That separate `public-code-proposal-inputs` bundle contains no OpenCode binary,
build report or local model. The historical cooperation bundle and private
inference trial retain their original contracts. Preparing this driver or
passing its inert contract tests is not a successful live coding trial.

`opencode-public-code.yml` is the separate manual hosted entry for that proof.
It records its own workflow commit separately from the immutable public driver
commit and the reviewed core fixture. It reuses the core-owned real overlay/VM
runner and final acceptance checks; it does not run a local planning model or
start the private OpenCode inference trial. Only pinned source/runtime inputs
and closed receipts are staged or exported. Like the private trial, dispatch
requires the workflow to be registered on the default branch first; the actual
run must select the reviewed integration commit, not substitute `main`.

The first actual public trial, run `37213737334`, **failed overall**. Its original
receipts show real Qwen0.6B peer execution, a complete raw replacement, the
owner-approved single-file edit and passing unchanged local tests. The parent
route-evidence gate rejected application traffic to an unselected provider:
its capture combined provider discovery with task execution, and its generic
control-path mapping did not distinguish the two discovery contacts from the
single selected executor. Those packet counts alone cannot retrospectively prove
that all unselected traffic was discovery. Cleanup completed with zero owned
objects and matching before/after guest network hashes; the failed run remains
failed, not a complete route/privacy proof.

The reviewed core fixture now separates those phases with a bounded, byte-exact
Unix control observer. It holds the genuine discovery response while the parent
checks TCP teardown and drains the discovery capture, then releases that same
response into a separate task capture. Physical discovery contacts and the
selected executor have separate bindings; task traffic to an unselected provider
is still rejected. The immutable driver, real model, question, original tests,
deadlines and success criteria remain unchanged. Passing fixture/socket checks
is not yet evidence that this revised live trial passes.

The next [public trial `37216555196`](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37216555196)
failed before Connect or model submission: its 60-second discovery barrier never
observed all eight required advertisements. The last of 552 valid queries lacked
relay0/5 and both exits. Cleanup passed, but the retained snapshot does not explain
the missing advertisements. The follow-up core
`1297f8f1a5d163d802efd066c51a950b95588fa5` diagnostic retains only fixed
role-presence/status/event summaries from existing cleanup captures, not raw
identities, endpoints or logs. It does not relax discovery or route requirements.

The [public trial `37218917021`](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37218917021)
on workflow `693516f8` / core `1297f8f1` also **failed**, but did observe all
eight advertisements after 215 queries. It stopped at
`CUSTODY_CAPTURE_UNAVAILABLE` before the owner driver or model task: the original
capture guard allowed document discovery, not the new explicit code-proposal
scenario. Core `81f5f9de3fa25e430357ca7b6b457522b2193063` adds only that missing
capture scope under `agent-jobs`, with actual-shell allow/deny regression checks.
The public CI pin advances to that reviewed fixture; the private 4B pin stays at
`1297f8f1`, and immutable public driver `f27576eb`, model, original tests, privacy
checks and deadlines remain unchanged. Network cleanup reports zero objects and
equal guest-root hashes. This fixes a reproduced instrumentation mismatch, not
the earlier unexplained inventory failure or a proven live coding result.
Original ZIP SHA-256: `2b415caf44bc7e98b6eb40d1a6d00e66a57ba21f3f42e33b68a9885f923b76d8`;
job `111485066863` log SHA-256: `a7358305bc82d419b39d576d9bc55d175d4e0e99e3e7d1c087c12fb69c2cf2d0`.

The subsequent [public trial `37220221345`](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37220221345)
on workflow `423c5e2f` / core `81f5f9de` **failed overall** at
`CODE_PROPOSAL_OBSERVER_STOP_FAILED`. Its original driver and worker-observer
receipts show actual Qwen0.6B peer execution, EOS, a raw 31-byte replacement,
the owner-approved edit and passing unchanged original tests plus the independent
check. Both captured phases separately pass the original path validators; the
final control receipt and complete evidence join were not reached. The exact
fixture stop allowlist omitted the newly introduced control observer and refused
it before invoking a service stop. The new public-only pin
`2a1b4ad347b7d9f12a6a4c2beee40ff8706bd477` admits that exact unit only in the
explicit code-proposal scope, retaining service-state, zero-PID and empty-cgroup
checks. Targeted shell/socket contracts pass; this is not a replacement live
pass, native OpenCode planner proof or private offload. The private 4B pin and
immutable driver remain unchanged. Original ZIP SHA-256:
`6459dc4ef5351558f6818cf552b507f57d1b98ccd05148282e27d9ee765ef458`;
job `111488876530` log SHA-256:
`9b0f259e574f7e9399d6751adcb3c7d5130ab36d6725fe3045b6f2ebbdaf10d9`.

The original [public trial `37221727043`](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37221727043),
attempt 1, **passes the complete bounded public acceptance**. It binds workflow
Code `54af18cc5d30a880e3be298192af150daf01b805` (tree
`eef18e2ce8c135e6daab29dbc80fbbd086f85d5a`), core
`2a1b4ad347b7d9f12a6a4c2beee40ff8706bd477` (tree
`cb999c2ae1419407211e97ba05366d9c6a4301ab`) and unchanged public driver
`f27576ebd7e7ded2f1319186f34df87f48e970d7`. All eight expected relay/exit
advertisements were observed after 235 inventory queries. The real Qwen0.6B
worker on relay4 returned its
original EOS-complete 31-byte replacement after 12 tokens. The fixture's
original tests failed before the edit; the separately approved edit/check and
unchanged original tests plus independent check then passed. No local planner
or output repair supplied the answer.

The separate discovery and task captures pass their original provider/path and
privacy validators. The final byte-preserving control receipt joins all eight
exchanges with zero active requests; all private cleanup flags pass, no owned
network objects remain and guest network snapshots match. This is a public
owner-helper/peer/model result, **not** evidence of native editor operation, a
complete OpenCode planning loop, general coding quality or confidential private
offload. Earlier runs retain their original failed outcomes.

Original artifact ZIP SHA-256:
`8a17e92c2bc4148093651a020cf0a2daaf46b2e14fcad74a4e4343024de02d11`;
job `111493248899` log SHA-256:
`0dbc4650b89ba5d6bb8a3474f886ff4016feb1a0042d88b52c9e5391776fee26`.

Remote conversation execution needs a suitable typed task family; confidential
execution additionally requires actual protection against the executing host.

Local subagents, TLS, split prompts, peer signatures and immune labels do not
prove that protection. Reuse upstream clients through the common provider, but
do not claim additional platforms tested here. The target remains cooperative
network execution and shared improvement, not a permanently local-only product.

## Evidence boundaries

Focused fixtures cover HTTP/Unix framing, tool identity, cancellation, public
snapshot enrollment, editor consent, child-session scope, late approvals, process
failure and cleanup. Python checks cover the builder and namespace proxy mount.
Model and OpenCode server responses in the unit fixtures are synthetic.

The separate native smoke uses the **actual source-built OpenCode process**,
production launcher, HTTP/SSE client and Chat Completions adapter, with only the
core/model responses simulated. It observes one approved command creating a
disposable file, correlated tool-result history on the next turn, final output
and session/process cleanup. It creates no real inference or peer-execution
claim. Run explicitly with an existing Node executable:

```sh
/absolute/node tests/real_opencode_smoke.cjs --execute \
  --node /absolute/node \
  --build-report /absolute/build/opencode-runtime/build-report.json
```

Its `native-smoke-report.json` is written beside the build record and is not
overwritten. The 2026-10-02 trial used Node v24.19.0 and the OpenCode binary with
SHA-256 `86b944fd0a279c7a24f7396e55aec0cca39685f5d32496a26941cec8ee2cc0bf`.

The actual-runtime terminal-error regression also passes: both `invalid_output`
and `wire_truncated` produce exactly one coding submission, no regeneration, no
tool approvals or project changes, and confirmed session/process cleanup. Core
outputs are deliberately synthetic; this does not explain the older VM03 failure
or prove real model-driven editing. Run without downloading a model:

```sh
/absolute/node tests/real_opencode_provider_errors.cjs --execute \
  --node /absolute/node \
  --build-report /absolute/build/opencode-runtime/build-report.json \
  --report /absolute/build/opencode-runtime/native-errors-terminal.json
```

The native cooperative smoke also passes with this actual runtime. Both complete
and incomplete answers traverse the trusted custom tool, single-use owner proxy
and public-core adapter. The next actual OpenCode model request contains the
original result and call IDs; a private sentinel is absent from public requests.
An approved sandbox check confirms that the limited proxy exists and the raw
public core socket is unavailable. Model and public-core replies remain simulated:
the report explicitly records `model_inference: false` and `peer_execution: false`.

```sh
/absolute/node tests/real_opencode_cooperative_smoke.cjs --execute \
  --node /absolute/node \
  --build-report /absolute/build/opencode-runtime/build-report.json
```

Its `native-cooperative-smoke-report.json` is separate from the local-tool report.
Neither report may be relabelled as real inference or immune-policy proof.
Actual model-driven coding, native editor UI operation, confidential peer
execution and full immune supervision remain unproved.

## Real public-core integration driver

`scripts/smoke_opencode_cooperation.cjs` uses the production OpenCode runtime and
enrolled proxy against an **externally supplied public-serve endpoint**, rather
than generating public-core replies. It runs only as `vpci` or `volparossa` inside
the explicitly identified disposable KVM guest. The launcher supports the exact
`volparossa` service account home by creating an empty namespace directory; it
does not expose the account's host files.

```sh
/absolute/node scripts/smoke_opencode_cooperation.cjs --execute --yes \
  --node /absolute/node --build-report /absolute/runtime/build-report.json \
  --public-socket /absolute/owner/public.sock \
  --snapshot /absolute/owner/public-snapshot.json --snapshot-sha256 EXACT_SHA256 \
  --project-parent /absolute/owner/new-projects --output /absolute/owner/new-report.json
```

The hash-bound JSON snapshot contains `question`, `context`, `license`,
`public_content: true` and `rights_confirmed: true`. Only the private planning
turns are synthetic, to exercise exactly one native delegation without claiming
model-driven planning. Success requires a complete original result naming at
least two execution providers, an unchanged tool-result round trip and confirmed
runtime/task cleanup. The report contains bounded status, IDs and hashes, not
the submitted text or answer. The parent topology must independently join these
to the real workers, retained receipts, protected traffic and VM cleanup. The
driver and its eight focused checks are **not a completed live-peer proof**.

The core's `agent-cooperative-code` disposable topology consumes an explicit
offline bundle rather than fetching or executing an unreviewed editor runtime.
Capture committed Code files and an already source-built OpenCode runtime:

```sh
python3 -B scripts/pack_opencode_cooperation.py --execute \
  --code-revision b3a4cfe79158d24e1dd61dcb56d37123f9d3d55c \
  --node /absolute/prepared/node \
  --build-report /absolute/build/opencode-runtime/build-report.json \
  --output /absolute/code-worktree/build/opencode-cooperative-inputs-01
```

The manifest binds all 25 source/runtime/license files by hash, size and mode.
The packer reads source blobs at the selected commit, not uncommitted changes,
and verifies the existing source-build record and pinned Node distribution. It
does not download or launch anything. Pass this new directory and the reported
manifest SHA-256 to the core VM runner with `--code-bundle` and
`--code-manifest-sha256`. Bundle capture and transfer are input preparation,
not proof of real model execution, peer success or private-task confidentiality.

## Real-model trial driver

### Requested generation behavior

OpenCode's `temperature:0` now requests the core's explicitly negotiated
`greedy_v1` policy. The adapter first sends `conversation_capabilities` with
`generation_policy_version:1`, requires the advertised policy, and binds the
result's `generation_policy` to the submitted input. Missing capability or
missing/conflicting result evidence is an error, not a sampled fallback.
An older ordinary conversation client can still use its unchanged handshake;
omitting the policy retains the core's previous profile behavior.

An actual-runtime regression exposed an additional configuration mismatch:
pinned OpenCode omits temperature unless the custom model advertises that
capability. Setting only `agent.temperature:0` did not select greedy execution.
Both supported profiles now explicitly set model `temperature:true`, retaining
the existing zero setting on every coding role. Prompts, model identities,
permissions and resource budgets are unchanged; this corrects which generation
policy actually reaches the core, rather than proving better model quality.

The pinned native runtime has now been exercised with the production launcher
and provider but **synthetic** core/model replies. Each of `invalid_output`,
`wire_truncated` and `execution_budget_exceeded` made exactly one coding request,
with observed `greedy_v1`, no native retry, no approval and confirmed session
cleanup; the disposable project remained unchanged. The terminal budget error
was not counted as a completed or incomplete model result. The synthetic result
fixture mirrors only the policy actually present on the request; negotiated
support alone is not a selected policy. This proves runtime policy forwarding
and terminal-error behavior, not actual inference or private peer execution.
Local report `native-errors-budget-greedy-df481-20261004.json` was captured on
the explicitly modified `df481f3f` candidate; SHA-256:
`a08f26ab2c61b2653949dadf06f45b9402066383ee651d573a5b14f9623e3786`.
Earlier real-model failures retain their original sources and outcomes.

An earlier adapter correction addressed a separate contract mismatch: it accepted
zero temperature while the Qwen worker used its sampled 0.7/0.8/20 profile.
The worker's greedy path passes `do_sample:false,num_beams:1`; model, token budgets,
tool permissions, task and independent success checks remain unchanged.
Protocol/backend-double checks verify the wiring, not model quality. The earlier
[run `37066003771`](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37066003771)
remains failed: one completed native read, then an assistant stop, without an edit
or passing independent check. The mismatch is not a proven explanation for that
stop, and greedy generation does not guarantee a completed coding task.

### Disposable execution

`scripts/smoke_opencode_inference.py` prepares one explicit disposable Debian 13
KVM trial; it does not install or run the model on the development host. Its
`pack` mode captures each Code source/runtime file by hash and the exact core
archive selected by its explicit model profile. Both current profiles pin core
`6a517b576baa17e7329661ee0476d1848081d114`, while retaining their different
models and resource profiles. Historical 0.6B trials used `845cc84d`; the last
4B trial used `1297f8f1a5d163d802efd066c51a950b95588fa5`, including the bounded
provisioning-timeout recovery from `3aa0e2d0`. Neither those historical outcomes
nor the synthetic native-runtime probe proves the current real-model candidate.

The earlier `a5246942` candidate's
[Quality run `37225595367`](https://github.com/VOLPAROSSA/volparossa/actions/runs/37225595367)
remains **failed**: strict Clippy rejected two 103-line diagnostic functions.
No native model trial was dispatched for that pair. The follow-up extracts the
existing snapshot parser and moves byte-identical Python test assertions into a
constant, without changing validation, model behavior, resources or acceptance
criteria. Its source checks are pending; this is not a rerun or a passing
real-model result. Original job `111504476222` log SHA-256:
`1ef3aca56b4052b9b56e2f9a469543e07cfdb1718d5a8706750c286f40f6d41c`.

The previous `37209881216` attempt remains failed before model
execution. [Trial `37217032474`](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37217032474)
on the previous core `f25352df` completed the pinned 4B provisioning and returned one actual model result,
but the native task failed at `invalid_output` after 152,995 ms. No tools, edits
or checks ran; the original source remained unchanged. Runtime/guest cleanup and
normalized host routes/DNS checks passed, while raw host-route bytes differed.
The raw model text and rejection subtype were not retained; neither a precise
parse cause nor useful model-guided coding is established by this result.
The new core accepts the pinned native template's assistant preface followed by
one complete tagged tool proposal, while retaining strict JSON, offered-tool,
EOS, resource and owner-approval checks. This is a demonstrated adapter
compatibility fix, not a proven explanation of that failed result. Its opt-in
closed diagnostics distinguish rejection categories without retaining private
model text; repeated validation observations do not count as extra executions.

The subsequent [native 4B trial `37218791500`](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37218791500)
on Code `693516f8c5f3b7bab10fe83a6462f955af5a8c3e` and core `1297f8f1`
**failed**. Pinned provisioning completed; three attempts reached generation
begin after about 20 seconds but exceeded the unchanged 600-second execution
budget. Their confirmed-cleanup `execution_failed` replies became HTTP 503,
which the pinned OpenCode runtime retried. The overall 40-minute task deadline
cancelled a fourth attempt. No completed model response, EOS, tool, edit or
passing check was observed. The retained observations do not distinguish first
forward computation from later decoding and do not establish the stall's cause.
Private/runtime/guest and QEMU/scratch cleanup passed; normalized host routes
and DNS matched, while raw route bytes differed. This does not become a pass
because the separate public owner-command trial succeeded.

Original artifact ZIP SHA-256:
`56ef70bf28c08458b78ad61539495bcfdf45d990fd9563f366dac65652a768c2`;
job `111484703730` log SHA-256:
`dbef2bd19983b4c84a3fe5bdf413ea0863984c472c88348b6f09b4923278f8b2`.

A dirty source capture is
labelled as such, not attributed to an unchanged Git HEAD. The guest provisions
only that pinned profile using the existing guarded core provisioner.

```sh
python3 -B scripts/smoke_opencode_inference.py
python3 -B scripts/smoke_opencode_inference.py pack \
  --core /absolute/core-at-required-revision \
  --node /absolute/prepared/node \
  --output /absolute/code-worktree/build/opencode-inference-inputs-01.tar.gz
python3 -B scripts/smoke_opencode_inference.py execute --yes \
  --core /absolute/core-at-required-revision \
  --tools /absolute/verified-workspace-vm-tools \
  --image /absolute/pinned/debian-13-genericcloud-amd64-20260826-2582.qcow2 \
  --bundle /absolute/code-worktree/build/opencode-inference-inputs-01.tar.gz \
  --output /absolute/code-worktree/build/opencode-inference-vm-01
```

Inputs must already exist and match their pins; output paths must be new. The
runner prints a no-execution preview without a mode. Actual execution requires
usable KVM, no other QEMU instance and at least 8 GiB of currently available host
memory. It owns a 6 GiB/two-vCPU headless guest in a bounded no-swap user cgroup;
it never closes the owner's applications or changes host routing/DNS/firewall.
The explicit 4B profile instead requires at least 14 GiB available host memory,
uses a 12 GiB/two-vCPU guest with a 13 GiB no-swap cgroup, and reserves a
40 GiB virtual disk with a 20 GiB provisioning budget. Select the same
`--model-profile qwen3-4b-instruct-2507-v1` for both `pack` and `execute`;
the larger profile does not replace the default or relax the coding task.

The actual runtime/model must read and edit a disposable Python project and run
its existing tests. A separate sandbox independently checks the result using
unchanged tests; a generated success message alone is not success. Only bounded
read/test commands and edits to the selected fixture can be approved. The reports
separate task execution, model provenance and guest/resource cleanup. Four
JavaScript and five Python driver checks pass; these checks and a successfully
packed source bundle are **not** evidence that the real-model trial passes.

The completed `opencode-inference-vm-03` attempt provisioned the real Qwen model
and observed five supervised worker results, but did not complete a native coding
turn, edit or test. Its original task error was obscured by a subsequent
`cleanup_unconfirmed` label; the guest units and QEMU were nevertheless stopped,
private state removed and host route/DNS snapshots unchanged. The current driver
preserves the first closed task-error category separately from session and runtime
cleanup failures, plus bounded provider result/error counters. It exports no raw
prompt, code, model answer or exception text. This diagnostic correction does not
turn the original failed trial into a pass.

The subsequent `opencode-inference-vm-04` trial used Code
`11a7063f178a3094c0d6f2d1052894f1fef8dc4a` and the same exact core revision. The real
Qwen worker reached an EOS-complete, non-truncated output that failed the strict
conversation decoder: one submitted turn, `invalid_output`, no retry and no
approved edit or test. The original `opencode_task_incomplete` error remained
visible; runtime cleanup was confirmed, guest processes/private state and QEMU
scratch were removed, and observed host routes/DNS were unchanged. The retained
closed diagnostics do not identify the malformed output shape; raw output was
not exported. The parallel-prompt conflict above is a verified integration issue,
**not a proven explanation of this particular failure**. Its correction still
requires a new real-model trial; VM04 remains failed.

The owner-verification trial
[`37076283235`](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37076283235)
on Code `40d89016c3e0155f054026c5553b5e8224b9cf9f` and core
`845cc84d0d0b766ab1c5227231dbf6c8eaeb8cc3` also **failed**. Three actual owner
checks and two same-session continuations ran, but only one native read completed;
no edit or test command was requested, the fixture was unchanged and the final
independent check failed. Five core requests produced one execution failure and
four results: one function call and three assistant responses. The report did not
export model text, so it does not establish why the model stopped without editing.

That original report also marks runtime cleanup unconfirmed: its provider counted
only the four successful-result cleanups, not the first admitted terminal
execution failure. The transport accounting correction above preserves that
failure while retaining its actual cleanup receipt. Socket/provider regressions
exercise the correction; they do not retroactively change the failed trial or
prove coding success. Guest private state and owned units were removed, QEMU was
joined and its scratch removed; the outer host route/DNS comparison was false,
so this run is not evidence of unchanged host state. Original artifact ZIP SHA-256:
`9ac899f449239debc07817df803216891639836c03e3b8533e71e315399eccf9`.

The first explicit 4B trial
[`37204436941`](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37204436941),
on Code `0295710c6e93bcdf989f5b1527f4ffde746ab16e` and core
`39bfc0d14bd45563957c8a41e8183592e7ee7a73`, **failed during model provisioning**.
The guest compiled the real core but never confirmed model installation or
started a coding task. Its closed report retains only `model-provision` /
`stage_failed`, not the failing provisioning operation; neither model quality
nor coding completion can be inferred from this attempt. Guest private state
and owned processes were cleaned up, QEMU was joined and its scratch removed.
The guest network snapshot matched, but the outer CI host's IPv6-route hash
changed; this is not proof of unchanged outer host state. Original artifact ZIP
SHA-256: `41e48432b0b36f409517895b3fbf47b0832d222c369187a797fdd9e77539ad98`.

Subsequent trials retain closed provisioning diagnostics: the substage, process
and HTTP status, fixed failure categories, and pin-validated ordered download
starts—not completed downloads. Raw logs, URLs and error text stay private and
are removed during cleanup. This does not establish the original failure's
cause or change any resource limit, coding task or success condition.

The next original [4B trial 37205549602](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37205549602),
on Code `5a3cc386eaeda892b99947ac9476840d5d32c143` and the same core, confirms
the exact model/runtime provisioning, but still fails the coding task. After
2,400,233 ms there are five provider submissions, four cleanup-confirmed execution
failures, zero completed model responses and no read/edit/test operations. Three
closed service events are deadlines, one is unclassified and the last is owner
cancellation. The low observed core-memory peak and absence of OOM do not prove
that weights loaded or generation began; the failed run retained no worker-stage
or pause-state observations. The fixture is unchanged. Private state, owned
processes, VM scratch and QEMU are cleaned up, and both guest and outer-host
routes/DNS comparisons pass. Original ZIP SHA-256:
`5d448d5ee42402d91d5428b1abb2c104b4f0067f8f7b505e76a2f118fcdc1537`;
original job-log SHA-256:
`29b0ccf0deb8272d905a4b5ce7f000901c5966af93a5e51bb6cbd0e70975c9ea`.
This is successful provisioning, not a working 4B coding loop.

The current 4B candidate adds closed failure-state observations from the core:
the last validated worker stage and its begin/complete state, capacity decision
and pressure, issued versus acknowledged owner controls, and observed peak RSS.
This distinguishes an owner-gate pause from model loading or generation without
exporting prompts, code, model output, paths or request IDs. A stage entry is not
successful execution, and these observations do not retrospectively explain the
previous failure. Worker/task deadlines, resources and acceptance remain unchanged.

New host observations retain all three raw hashes and separately compare the
IPv6 route multiset excluding only the kernel's reference-count column. Every
other field and duplicate remains significant; IPv4-route and `resolv.conf`
bytes must still match exactly. Unknown formats fail the observation without
skipping VM/scratch cleanup. This checks only the proc-visible routes and DNS
file, not all host networking or firewall state; it cannot retrospectively
explain the earlier hash changes. The column definition comes from the
[Linux IPv6 route emitter](https://github.com/torvalds/linux/blob/v6.12/net/ipv6/ip6_fib.c#L2395-L2423).

The manual `opencode-inference.yml` workflow adds an explicit GitHub-hosted
Ubuntu 24.04 host-tool profile for that same trial. It requires the dispatched
Code SHA, a clean checkout, the fixed core revision and newly verified runtime
inputs. The guest task is unchanged: actual OpenCode/core/Qwen must request
approved tool work, edit the disposable project and run its check. It is not
a mocked provider or a private-peer execution proof.

The workflow checks KVM and effective user-cgroup limits before source-building
OpenCode. Its default retains the 8 GiB admission threshold, 6 GiB/two-vCPU guest,
7 GiB cgroup, disabled swap and disposable cleanup. The explicit 4B choice uses
the separate source and resource profile described above. Only on the ephemeral CI host,
official packages and narrowly scoped KVM ACL/AppArmor changes are permitted;
the owned changes must be restored. Only closed provenance/result/cleanup
receipts are exported. The existing pinned Debian workspace-tool path is
unchanged. Focused offline contracts and shell/syntax checks pass; hosted
admission has been exercised, but actual coding completion remains unproved.

For pre-merge testing, the manual workflow must be registered on the default
branch. Dispatch the reviewed candidate branch and supply its exact commit as
`expected_code_sha`; the [selected ref identifies the workflow version](https://cli.github.com/manual/gh_workflow_run).
An unprepared branch cannot pass the source guard and must not install tools or
launch a guest. There is no automatic inference run on push or pull request.

### Explicit native CPU candidate

The later original [4B trial 37228603308](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37228603308)
on Code `714904a3ec452b8e10d8b40be6ac85107606ca3b` and core
`6a517b576baa17e7329661ee0476d1848081d114` remains **failed**. One request
reached the first model-forward start with 4,572 prompt tokens, then exhausted
its execution budget without a completed forward, token, EOS, edit or test.
The negotiated terminal error stopped blind retries. Cleanup was confirmed;
the observations do not prove that all weights became resident or identify the
stall's cause. Original artifact ZIP SHA-256:
`fabcc8ba08f47f28f85614b645679654b70f83f02c85c4f8be8722c0d1d5978c`.

An explicitly selected `--inference-backend llama_cpp_bf16_v1` now prepares a
different CPU executor for that same original 4B task. It pins core
`36d616fb6d79a36fe7c8ee95c4ad84bd56b561ae` and llama.cpp source
`7fe450e19305b828c199d602c23a8337aaa1f03b`. The default `torch` backend and
both existing model profiles retain their previous core pins. Native selection
is refused for the smaller profile; there is no silent backend fallback.

The previous candidate core `f7e2c3b9c2abd710682a2ec51d4b5dfbc46b9d8f`
failed [source Quality run 37235233676](https://github.com/VOLPAROSSA/volparossa/actions/runs/37235233676)
in four full command-tree tests because two flattened Clap argument groups
shared the name `Options`. No native inference trial was dispatched. The new
pin gives the native options a unique group ID; targeted command-tree and
absent/complete/incomplete flag-pair regressions pass. That fixes the reproduced
CLI construction error, not the earlier model-forward stall. The original
failed source run remains failure evidence; the new source still requires its
own passing CI before any trial.

That core's source checks subsequently passed. The first explicitly native
[trial 37239050033](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37239050033)
on Code `77fc08a88237ca8dd74d403222dd0e1548ffb46c` remains **failed** at
`native-source-build`. The original report records an active build unit with
result `success` and status `0`, but no completed resource observation or retained
build-manifest binding. No model was provisioned and no coding task ran. Owned
guest units/private files and outer QEMU/scratch cleanup passed; the recorded
outer routes/DNS comparison was unchanged. Original artifact ZIP SHA-256:
`ed5f8c699806fc1f4f7438ca2ffc3ded2e26a8cd7d95e445204cd9c815ac2e07`.

The fixture had read cgroup resource files only after helper exit. systemd may
[prune that empty cgroup even while keeping the unit active/exited](https://github.com/systemd/systemd/blob/v257/src/core/service.c#L1203-L1206).
An inert reproduction gives the same missing-resource report shape. The original
exception and substate were not retained, so this is not a uniquely established
retrospective cause. The follow-up uses a bounded, source-bound local socket
ready/release handshake: after joining the compiler and checking provenance,
the helper stays alive while its parent checks the exact unit, sole remaining
helper PID and actual cgroup counters. Only then may it exit, still requiring
status `0` and an empty unit. The same absolute 1,800-second build deadline
includes the handshake. Missing/mismatched/late messages, unavailable counters
and failed exits remain failures. Closed substate, stage and exception-category
diagnostics expose no raw logs or private paths.

The original follow-up [trial37614132814](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37614132814)
on Code `01c5c591b16ed34226341e04fe673a35a7a169de` and core `7308371b`
now proves that source build and handshake complete: a verified library/manifest,
successful exit and observed build peak of 1,031,565,312 bytes with zero swap/OOM.
The trial nevertheless **failed** at `model-provision` with `native_conversion`,
process status 1. Wheel-graph and runtime-import checks passed first; the generic
conversion marker does not preserve the failed substage or exception. Those
build counters are not conversion resource measurements. No inference or coding
task was reached. All reported private-data, unit, process-group, QEMU and scratch
cleanup checks pass, with scoped routes/DNS unchanged. Original ZIP SHA-256:
`d4b32d66e90d4c76568b2fa989cbab5e49bbb736283868a03a81f9ae0303a254`;
job `112768290137` log SHA-256:
`6e561f75a15560a56f3d98c1a49e518c52ad543646ea1463c7f475e5ec2d0ce6`.
The follow-up adds bounded conversion diagnostics without exporting raw logs,
paths or model content; it is not a demonstrated conversion fix.
Native-only detail distinguishes absent, invalid, unknown and reported failure;
it cannot report success. Duplicate fields/markers, malformed values and a
claimed child failure without a nonzero integer exit status are rejected.
All sixty-one native, smoke and CI fixture checks pass, independently repeated
by root. Default Torch summaries and all trial limits remain unchanged.

The subsequent [trial 37623495917](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37623495917)
on Code `61d2c0c52468eee7728cf6f32a107baca5bae240` and core
`7739206361aa0aeb7cf0b20d9f8cf1cc9da5c81b` also **failed**. The converter
child exited successfully, but verification reported `stage=verify` and
`failure=contract`; no verified model or inference followed. All reported
guest-unit, private-file, QEMU and scratch cleanup checks passed, with scoped
routes/DNS unchanged. The separate raw host-route byte comparison was false.
Original artifact ZIP SHA-256:
`50ad3ba19fe9811e132f2dad7ee3c49407d5fcecc86a65a816d7a0637eab996e`;
job `112799334236` log SHA-256:
`24bcefeb3279b24e011008fecca2037a0808dac2af82587527c1d378759c86a3`.

The new core pin corrects one source-proven verifier mismatch: the pinned
Qwen3 converter omits `qwen3.rope.dimension_count`, and its loader uses the
validated attention key length when that optional value is absent. Verification
now follows the same rule while still rejecting an incorrect explicit rotary
length or any missing required model parameter. This is a targeted correction,
not retrospective proof of the first failed assertion or a successful conversion.
Tensor, tokenizer, prompt and resource checks remain unchanged.

After both exact-source checks passed, [trial 37631532611](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37631532611)
on Code `8a7034d5e09cf34f8ac67742f347eb657f769440` and core
`10fd16dc78a0c91dee627b9d8bdab2226f2cc415` **failed during the OpenCode
task**. Source build, conversion and model provisioning now succeed, with a
verified 8,051,283,488-byte BF16 GGUF. The worker reports
`compute_control_ack_deadline` at `verify_files/begin`: an I/O-pressure pause
was not acknowledged while hashing the full original weights. Source review
found missing execution-thread checkpoints in that hash loop and subsequent
native verification. The new core pin processes controls between unchanged
1 MiB reads during preparation, native bundle validation and post-execution
rehashing. All 138 targeted core worker/native checks pass, independently
repeated, including real-file/owner-pipe pause, resume, cancel and unchanged
deadline tests. No integrity checks, resources or deadlines were relaxed.
A single blocking read can still exceed the control deadline; a new actual
large-model trial is required before claiming that execution succeeds.

No native model turn or tool call completed. Six requests failed within this
single workflow, with cleanup confirmed for all six. Core peak memory was
2,303,844,352 bytes, with zero OOM kills and swap. All reported owned-unit,
process-group, private-data, QEMU and scratch cleanup passed; scoped host-state
files match. No raw model output was exported. Conversion is now demonstrated,
but inference, successful coding and protected peer execution remain unproved.
Original artifact ZIP SHA-256:
`78c4732774fc93dae9872df0460e2addf7f3849a6a190f803069fbc7d6a6e9c8`;
job `112826781182` log SHA-256:
`ef7d5c7bbeeebf497ec9a42881746a782b36f7c7bddc9febef11d7af373cb44f`.
The consumed dispatch receipts and all earlier failures remain unchanged;
there has been no repeat dispatch or main merge.

The new owner-responsive verification [trial 37641148934](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37641148934),
attempt 1 on Code `d48801a6` / core `773d6377`, **fails** after build, conversion
and provisioning succeed with the same complete BF16 model. The worker now
acknowledges all 20 issued owner controls and reaches `model_load/begin`, then
reports `worker_other`. This closed diagnostic does not identify the precise
native load failure. No native turn, tool call or coding task completes; six
failed runtime requests have confirmed cleanup.

Core cgroup peak is 8,106,295,296 bytes within the 11 GiB limit, with zero swap
and OOM kills. Owned units, processes, private data, QEMU and scratch cleanup
pass. Normalized route/DNS observations match; raw IPv6 route bytes differ in
the excluded counter column, not a byte-identical snapshot. No raw model output
was exported. Original artifact `11492792961` ZIP SHA-256:
`b2621c8918f1304848fcc4a7b9e736fab2379cdf19c29de9ab11606e5c9e9cfc`;
job `112860150266` log SHA-256:
`4e32650af9e373e5e28ec93663777f1fe833feee419a5fe604fcfdfa6b7ec438`.
This follow-up has its own consumed once-only receipts; no repeat was sent.

The current source candidate bounds tensor validation in both upstream loading
paths to one execution thread, while still validating every tensor on success.
Owner controls are serviced between tensors; a single tensor remains
non-interruptible, and cancellation rejects the whole load. Closed native
load-stage diagnostics expose no raw model output or exception text. This
corrects a source-proven unbounded validation launch; it does not retrospectively
establish the cause of the preceding trial's failure.

Code now requires the core's build-manifest v2, including original/effective
loader and patch provenance, and verifies the actual compiled loader source.
The core checkout stays unchanged. Its builder imports the exact sibling
contract afresh, without changing the module search path or retaining a
temporary import binding. Old v1 manifests, altered patches, mismatched compile
sources and changed copied build reports are rejected. The native library ABI
remains version 1; the build-manifest version is a separate contract.

Focused inert checks cover the source-pinned import, provenance, tampering and
unchanged resource profile. A separate core source-only build passes its narrow
ABI and validation checks. Neither proved a full model load or successful coding
task at that source-only checkpoint. The following actual trial remains failed.
The model, original prompt, precision, deadlines and memory limits are unchanged.

The subsequent [trial 37654339995](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37654339995),
attempt 1 on Code `8b5d5b6a` / core `f4cd8bd7`, **fails** after native source
build, conversion and provisioning complete. One submitted request returns one
cleanup-confirmed incomplete model result (`invalid_output`), with no usable
turn, tool call, permission request or completed command. The provider records
`invalid_model_output` once; execution-failure, token-limit and wire-truncation
counters remain zero. Core observes `result_observed` once and
`conversation_native_json` twice: repeated validation of the same report, not
two model executions. The tagged tool body failed typed JSON deserialization;
the exact syntax/schema cause is unknown. No raw model output was exported.

Core cgroup peak is 4,555,878,400 bytes within 11 GiB, with zero OOM kills and
swap. Task-memory and graceful-core-stop fields are absent, not passing or zero
observations. Reported owned units/process-group/private data and QEMU/scratch
cleanup pass. Normalized route/DNS observations match; raw IPv6 route hashes
differ, so byte-identical host state or a full firewall audit is not claimed.
Original artifact `11499080343` ZIP SHA-256:
`c7d3ed9150e8eb8e7d58a65ed46b0179c997a74f2191c621cf0109552278b6dd`;
job `112905525075` decoded log SHA-256:
`fd62b12408eee3e4bbf6c994a84a9cede4fd088806103525782cf428f1ff6610`.
All original failed runs and consumed one-shot receipts remain unchanged.

The new exact core pin is a diagnostic-only candidate. After the unchanged
private report binding, it exports only Serde's closed `syntax`, `data`, `eof`
or `io` category, never parser messages, field names, positions or output
fragments. Historical generic JSON codes remain readable. This does not repair
or accept the rejected output, establish a unique prompt/template cause, or
prove another model execution. The wire result remains `invalid_output`; the
single-call contract, complete prompt/model, resources and deadlines are unchanged.
No model trial had run at this diagnostic checkpoint; the actual follow-up is
recorded below.

The exact pin includes main's independently verified public-filter snapshot
milestone. Its only merge conflict was two adjacent implementation-status
sections; both are retained. Native inference and diagnostics remain byte-for-byte
identical to `bccd7f3e`. This integration required fresh exact-source CI; earlier
CodeQL results were not substituted for an absent Quality run on the conflicted
parent branch.

The diagnostic follow-up [trial 37671030306](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37671030306),
attempt 1 on Code `2b2687fec5376b6e49f8266dff71cc7935845e99` / core
`36d616fb6d79a36fe7c8ee95c4ad84bd56b561ae`, **fails at the execution
deadline**. Native source build, conversion and provisioning complete. Unlike the
previous JSON rejection, this request ends with core `compute_deadline` and one
provider `execution_budget_exceeded` error, with cleanup confirmed. The worker
records 44 generated tokens and an internal generation completion at 518,788 ms;
`verify_after/begin` follows at 519,120 ms. Its last state is paused under
`quiet_hold`, with 31 controls issued and acknowledged, the last being pause.
Those tokens never become a verified result delivered to the native runtime.

The task ends after 603,331 ms without a completed native turn, observed tool
call, approved read/edit/test or completed command. The fixture is unchanged and
independent verification is not reached. Core cgroup peak is 9,466,974,208 bytes
within 11 GiB, with zero OOM kills and swap. These observations do not measure
total pause time or identify a unique cause of the overrun. Reported runtime,
project, guest-unit/private-data, QEMU/scratch and owned CI-host cleanup pass.
Normalized route/DNS observations match, but raw hashes differ; no byte-identical
host-state or complete firewall-audit claim follows. Raw model output remains
excluded.

Original artifact `11505764017` ZIP SHA-256:
`935e115a86abf1da83fe0e3d68ebac90d37ecbe399c7dcc79f055ff26dc33e83`;
job `112962546447` original raw log, 68,786 bytes, SHA-256:
`369407954fff82728d2ff41d5d0e229c78726ea8ae487bf2112964138ca492d8`.
The original bytes are retained without decoding or newline normalization. This
failed run does not replace or relabel any earlier result or relax model, task,
integrity, resource or deadline checks.

The subsequent source correction used core
`9e9086ee873f7162f498e8647e6f6f438273e6ce` (tree
`ecda529c486e4f759f15d107b5e09a7710bcbfa6`). Native execution now retains the actual
complete initial source-shard measurement rather than reading the unused
conversion-source shards again after generation. The used GGUF is still fully
hashed before loading and after closing the native handle. Its required internal
`verification_scope` states this distinction; the core rejects missing, extra,
old or different scope. This is an explicit native verification-contract change,
not successful execution evidence. Ordinary PyTorch checks and the complete
model, task, resource, governor and deadline settings remain unchanged.

The pin includes main's filter broker and four-validator TEST milestone; the
merge preserves both independent third-party provenance sections. A new actual
trial requires fresh exact-source CI and preflight. Its actual follow-up is
recorded below; the original failures above remain unchanged.

Select the native backend consistently for source selection, packing and
execution, with `--model-profile qwen3-4b-instruct-2507-v1`. The manual workflow
exposes the same explicit choice. It must be registered and dispatched against
the exact reviewed Code commit; a source pin is not evidence of a successful run.

Only the disposable guest fetches and compiles the pinned native source. The
new source-build service has two build jobs, low priority, the existing 11 GiB
guest-service limit, no swap and a 1,800-second ceiling; the outer VM/SSH budgets
are unchanged. Conversion stays within the original 20 GiB/1,800-second
provisioning budget. It adds one pinned converter dependency, verifies all
original tensor values and authorizes the measured backend manifest explicitly.
The original model, full prompt, greedy policy, two worker threads, 600-second
request budget, coding task and independent tests are unchanged. This is not
quantization, a smaller model, confidential remote execution or a new app-level
peer scheduler.

Fifty-seven targeted Python fixture checks pass; the unchanged consumer/session
code retains its earlier forty-seven passing Node checks. These checks cover
exact source/backend/artifact bindings, negative cases,
unchanged defaults, measured resource limits and cleanup contracts. The actual
build-shell selector now forwards the explicit backend choice too; an inert
shell-prefix regression reproduces the previous mismatch before any profile,
privileged operation or build. Source-only CI also covers stacked pull requests,
with unchanged checks and permissions. The real trials above now demonstrate
conversion, provisioning and one cleanup-confirmed incomplete native model result.
Neither that result nor the latest deadline during post-generation verification
proves a usable native turn or successful coding loop.
The core's retained full upstream sanitizer failure on a disallowed quantized
path also remains explicit; separate BF16/F32 checks do not erase that failure.

The follow-up [trial `37683661957`](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/37683661957)
on Code `45510055` / core `9e9086ee` passes native build, conversion and
provisioning, then produces one cleanup-confirmed `invalid_output` result.
Its task stops after 475,006 ms with no usable native turn, tool action, approved
read/edit/test or completed command. The fixture is unchanged and independent
verification is not reached. Runtime, project and guest-unit cleanup complete.
This is not the earlier execution-deadline failure or a successful coding loop.
The original artifact ZIP SHA-256 is
`93edd2b2b92db78a807a1de11a431afb38ede10443b965c9c4fe523eac75573f`;
original job log SHA-256 is
`e0b7f8f2c8073ade7ee168c2ef9a4efddc2f5b710f9686c8621fbdf68eb2cd17`.

The next selected-output trial is described under
[core-selected coding profiles](#core-selected-coding-profiles). Its Code
source-check run `38672991166` passes 296 Node tests (one skip), seven build
contracts, 92 Python OpenCode checks (two explicit retained-source skips) and
ten session-selection checks. The actual checkout `9f79e931` merges `689c7dd`
into `714904a3` and has the exact candidate tree. Original log ZIP SHA-256:
`8b59657a74190a61d8d0cf9177d96c0d488aec064e38faa54c30c5bd710ea978`.

The selected-output [trial `38675278393`](https://github.com/VOLPAROSSA/volparossa-code/actions/runs/38675278393)
on Code `6aa6291a1d7e591d1bfaff1b276ca2695a3c5d93` / core
`9d044921f7e684737f9b10868429de42bc5416c9` remains **failed**, with a new
partial result: one model-generated function call reaches the actual OpenCode
runtime and its `read` tool completes. Native build, conversion and provisioning
pass with backend manifest v2/build v3 and `qwen_tagged_tool_json_v1`.

Provider counters record seven submitted requests: one completed function call
and six `execution_failed` errors, with cleanup confirmed for all seven.
Invalid-output and execution-budget-error counters are zero. The retained core
diagnostic contains only `result_observed`; it does not identify why the six
requests failed. The read tool's pending/running/completed counters are observed
transitions of one call, not three different reads.

The task stops after 588,147 ms with `opencode_task_incomplete`, no changed
fixture, edit, test or independent verification, and no completed native turn.
`approved_read` remains zero: a completed runtime read is not a separately
approved read event. Core cgroup peak is 7,632,764,928 bytes within 11 GiB, with
zero OOM kills and swap. No raw model output is exported.

Reported runtime/project, provisioning-group, guest-unit/private-data,
QEMU/scratch and owned CI-host cleanup complete. Scoped normalized route/DNS
observations match; raw IPv6 route bytes differ. This is not byte-identical host
state, a complete firewall audit, general coding quality or protected peer
execution. The prior invalid-output and deadline failures remain unchanged.

Original artifact `11946278747` ZIP SHA-256:
`487bee78bb4857c6a5b48df7d69df21ceeb608ded9d9264122668480f62afa74`;
original job-log ZIP SHA-256:
`5ff8a4055bf966f192f80b366cbeb8428d77793c6ee6525b3109eecf292af36e`.
