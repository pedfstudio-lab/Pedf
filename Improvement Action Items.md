# Improvement Action Items

**Action items must be followed in the exact order listed below.**

## User Experience

We are adding an **Offline tab inside the existing PDF chat dialog**. Users will be able to choose between the current Online assistant and answering questions locally on their device. This is a planned change, not an already available feature.

1. **Open chat as usual.** The dialog opens on **Online**, using the existing Sarvam experience without waiting for a local model to download. Normal network and provider response times still apply.
2. **Choose Offline when local PDF reasoning is wanted.** On a compatible desktop/laptop Chrome or Edge browser, selecting Offline starts downloading the model if it is not already cached. The top of that tab shows download size, progress, Cancel and Retry. The preferred model has about 963 MB of weights, plus supporting files; the displayed total must include them. There is no two-minute download limit, and cached assets can be reused across PDFs while available.
3. **Keep working while it prepares.** Users can edit the PDF and type a question during download, model loading and document preparation. Offline Send and Enter submission stay disabled until both the model and current document are ready; voice also requires permission. Online does not wait for this preparation.
4. **Choose whether voice may use the cloud.** The Offline tab includes **Allow cloud AI for voice**, initially checked. Checked allows permitted cloud speech services while PDF reasoning stays local. Unchecking disables voice and cloud dialogue processing, leaving local text chat available once ready. The disclosure will read:

	> Spoken questions and answer text, including information from this PDF, may be sent to Sarvam.

5. **Ask questions about the current PDF.** The local assistant will answer in English, explain passages and summarize selectable text across English PDFs up to 50 MB, including confirmed edits. Clickable page references will take users to supporting passages. It will acknowledge missing evidence or unreadable images instead of inventing an answer; OCR and image understanding are not included.
6. **Keep control when something fails.** Unsupported devices and preparation failures will show a reason or recovery option without losing edits or silently sending a local question to Online. Automatic cloud location detection will be removed, and document-derived Search, Maps and Calendar actions will be disabled while Offline is selected.

**Privacy distinction:** Offline with cloud voice checked is local PDF reasoning with remote speech, not a wholly offline conversation. Offline with voice unchecked keeps PDF questions and answers local after preparation. Initial asset downloads still need internet; opening the whole application from scratch without a connection is not promised. Manual editing and export remain local in both tabs.

## Plan Status

**Updated:** 2026-09-20  
**Document status:** Implementation plan; the new tabs, local model and privacy controls are not implemented or validated.  
**Ownership:** Assign an owner and record evidence against each acceptance check before marking it complete.

The obsolete AI-001 model-replacement proposal has been removed. Its same-model parity requirement, hosted comparison trial, toolbar mode selector and fully local voice proposal are superseded. AI-002 retains its original identifier but moves after the new local-processing work. Follow the order shown, not numerical identifier order. Local prototypes must remain private until the final release gate passes.

## Implementation Summary

Each action and sub-action below pairs **what changes** with **how we will make it happen**, in execution order. The detailed Why/What/How sections and acceptance checks follow. Recommendations and provider choices marked for confirmation are not settled requirements.

| Item | What We Are Doing | How We Will Do It |
| --- | --- | --- |
| **AI-003: Model qualification** | Establish a viable browser-local model before committing to production. | Test a pinned SmolLM2-1.7B Q4/WebLLM package on representative passages and Chrome/Edge devices; approve it only against measured criteria. |
| AI-003.1 | Pin the evaluation package. | Fix model, runtime, tokenizer and compiled-library versions; verify licenses/integrity and run local streaming tests with public or synthetic text. |
| AI-003.2 | Establish quality and hardware baselines. | Define expected answers and pass/fail thresholds; measure download, loading, indexing and answer latency separately on representative devices. |
| **AI-004: Privacy enforcement** | Prevent unintended cloud processing in every route. | Remove automatic location requests and enforce a capability-level policy before any reasoning, speech or external action. |
| AI-004.1 | Remove automatic cloud location detection globally. | Remove the viewer's detection trigger, provider-backed detector and dependent automatic overlays/state; retain unrelated local features. |
| AI-004.2 | Route capabilities by tab and voice permission. | Replace implicit provider fallback with explicit dispatch: Online reasoning to Sarvam, Offline reasoning to WebLLM, and remote speech only when permitted. |
| AI-004.3 | Guard links, logs and policy transitions. | Apply policy checks to external actions and telemetry; abort incompatible work and use operation/revision IDs to discard late results. |
| **AI-005: Model lifecycle** | Prepare the local model without delaying Online. | Use lazy WebLLM loading, a versioned browser cache and worker-based inference with observable preparation states. |
| AI-005.1 | Detect unsupported browsers or hardware. | Check WebGPU, required features and storage locally during the greeting; handle actual load failures without blocking Online or editing. |
| AI-005.2 | Download only when Offline is selected and assets are missing. | Connect loader progress to the top-panel size/status, Cancel and Retry controls; deduplicate downloads and recover without cloud fallback. |
| AI-005.3 | Reuse assets and manage resources. | Use WebLLM worker/cache APIs, separate model assets from PDFs/history, and support safe unload, eviction recovery and model removal. |
| **AI-006: Document context** | Make the whole current PDF available to local answers. | Build revisioned, page-anchored text chunks and a local search index instead of using the truncated document string. |
| AI-006.1 | Extract all supported English text from PDFs up to 50 MB. | Reuse page extraction without the 50,000-character cap; track unreadable pages and explain limitations without adding OCR. |
| AI-006.2 | Include confirmed edits and page changes. | Combine extracted text with edit/page-plan state; reindex affected chunks on confirmation, Undo/Redo or page changes, excluding drafts. |
| AI-006.3 | Retrieve relevant passages and track readiness. | Index page-anchored chunks locally, test paraphrase retrieval, and enable submission only when the active document revision and model are ready. |
| **AI-007: Grounded generation** | Produce PDF-supported answers, summaries and references. | Feed local evidence to WebLLM within its token budget, validate source references and summarize longer documents section by section. |
| AI-007.1 | Implement streamed local discussion. | Adapt WebLLM to the existing provider interface and text-delta callback; budget instructions, passages, output and up to eight recent messages. |
| AI-007.2 | Validate answers and clickable citations. | Give passages source IDs before generation, map citations to current local anchors, check claim support and abstain when evidence is insufficient. |
| AI-007.3 | Summarize the whole document. | Summarize all readable sections, combine their results with source IDs, and report missing coverage or cancellation explicitly. |
| **AI-008: Chat interface** | Add Online/Offline tabs with accurate preparation feedback. | Extend the existing chat component and bind controls to active tab, capability, model and document-readiness state. |
| AI-008.1 | Keep Online as the immediate default. | Reset the active tab to Online whenever chat opens; render the greeting locally and keep Online independent of local preparation. |
| AI-008.2 | Show Offline preparation at the top. | Connect download/loading/indexing state to progress, Cancel, Retry and errors; observe local readiness without cloud polling or artificial delay. |
| AI-008.3 | Prevent premature submissions. | Use one readiness/permission guard for Send, Enter and voice; allow drafts and editing, and provide accessible focus/status behavior. |
| **AI-009: Cloud voice consent** | Offer optional cloud speech while keeping Offline reasoning local. | Route permitted audio/translation/playback separately from WebLLM and enforce the same consent at every speech entry point. |
| AI-009.1 | Add the agreed checkbox and disclosure. | Show the initially checked Allow cloud AI for voice option with the Sarvam disclosure before microphone use; bind it to voice policy. |
| AI-009.2 | Connect speech to local PDF answers. | Transcribe/translate the utterance with Sarvam if permitted, answer locally, then translate/speak that answer without uploading hidden PDF context. |
| AI-009.3 | Stop remote dialogue when permission is removed. | Gate and cancel recording, translation, playback, fillers, queued work and retries; do not use unverified browser speech as a fallback. |
| **AI-010: History and transitions** | Resolve tab history, saved voice permission and cancellation behavior. | Confirm the proposed defaults, then isolate in-memory histories and restore only approved preferences through existing project storage. |
| AI-010.1 | Keep private history out of Online requests. | Confirm separate session-only tab histories; construct requests from the appropriate history and clear it on refresh or document change. |
| AI-010.2 | Preserve voice denial while retaining Online-on-open. | Confirm per-saved-PDF permission persistence; store only that preference through project state/autosave, not chat or the active tab. |
| AI-010.3 | Make switches and closing chat recoverable. | Confirm download continuation/cancellation rules; preserve drafts and edits, cancel incompatible tasks and reject completions from inactive operations. |
| **AI-002: Cloud access controls** | Protect application-funded services without blocking local text inference. | After the preceding work and policy approval, add server-verified identity, atomic usage controls and protected production speech transport. |
| AI-002.1 | Confirm access policy and hosting. | Approve or revise Supabase, login scope, budgets and voice scope; verify whether Cloudflare API requests reach Pages/Workers backend code. |
| AI-002.2 | Add identity, account data and login recovery. | If approved, use Supabase/Google OAuth with minimal scopes, row-level security and stable user IDs; preserve files, edits and drafts across sign-in. |
| AI-002.3 | Secure requests and bound spending. | Verify sessions in the proxy, keep secrets server-side, atomically reserve/reconcile quotas and enforce request/audio/concurrency limits. |
| AI-002.4 | Complete protected live speech transport. | Add an authenticated WebSocket relay with origin and usage checks; close recording and connections on denial, expiry, cancellation or quota exhaustion. |
| AI-002.5 | Explain cloud use and verify controls. | Add clear disclosure/error states and test invalid sessions, user isolation and concurrent quotas; keep PDF content out of account data and routine logs. |
| **AI-011: Release validation** | Approve release using tested quality, privacy and operational evidence. | Run focused automated checks and real-browser scenarios, inspect network traffic, and stage deployment with an explicit release/rollback gate. |
| AI-011.1 | Verify quality and performance end to end. | Test representative PDFs, current edits, citations and summaries on target devices; measure the five-second routine answer-start target after preparation. |
| AI-011.2 | Verify privacy under normal and failing conditions. | Inspect HTTP, sockets, workers, navigation and retries in all modes; block network access after preparation and test local answers and transitions. |
| AI-011.3 | Document and stage the release. | Run tests/typecheck/lint/build/export verification, update operational docs and budgets, and approve rollout/rollback without rerouting local requests to cloud AI. |

**Optional authentication follow-up:** add email/password only if approved, using Supabase's supported verification/recovery/linking flows and a production SMTP sender rather than implementing authentication ourselves.

## Agreed Direction

| Area | Requirement |
| --- | --- |
| Chat navigation | Two tabs inside the chat dialog: **Online** and **Offline**. Online is selected whenever the dialog opens. No separate toolbar mode selector. |
| Online | Retain the existing Sarvam chat experience without waiting for local-model preparation. Normal extraction, network and provider latency still apply. |
| Offline | Generate PDF answers locally in desktop/laptop Chrome and Edge, with no installed companion application. |
| Local model | Preferred evaluation candidate: **SmolLM2-1.7B-Instruct, Q4, through WebLLM**. Production selection remains conditional on testing. Exclude Chinese-developed models. |
| Offline voice | Show **Allow cloud AI for voice**, checked by default for a new choice. Checked permits the disclosed remote voice path, not cloud PDF reasoning. Unchecked disables voice and remote dialogue processing. |
| Disclosure | **Spoken questions and answer text, including information from this PDF, may be sent to Sarvam.** Show this next to the voice checkbox. Offline with voice enabled is a hybrid workflow, not wholly offline. |
| Download | Selecting Offline starts the model download only when required assets are not cached. Show size, progress and Cancel at the top of the Offline panel; no additional approval dialog. |
| Download timing | The former two-minute initial-download limit is removed. Duration depends on the connection; downloads do not block manual PDF editing or Online chat. |
| Local document scope | English-only PDFs and English answers; all selectable text across the whole document, including confirmed edits. Maximum **50 MB per PDF for local AI analysis**, not a new limit on manual editing. |
| Local answers | Generate explanations, summaries and cross-page synthesis grounded only in the current PDF, with clickable references to supporting passages. No OCR, image understanding or outside-knowledge answers. |
| Ready state | Permit drafting while preparing, but block Offline Send, Enter submission and voice until both the model and current document index are ready. Voice additionally requires permission. |
| Response target | First meaningful routine answer text within **five seconds after submission once ready**, on qualified devices. This is a test target, not a measured guarantee or full-answer deadline; whole-book summaries may take longer. |
| Privacy | No automatic cloud fallback. Remove automatic cloud location detection globally. Disable document-derived Search, Maps and Calendar actions while Offline is selected, including with cloud voice enabled. |
| History | Session-only; clear on refresh or document change, do not save chat with the project. Preserve the existing last-eight-messages history behavior within the available token budget. |

**Recommendations pending confirmation:** keep separate session-only histories for the tabs; remember the voice permission per saved PDF, applying checked-by-default only to new PDFs and preserving explicit denial. Do not restore a saved Offline selection over the new Online-on-open default. Regardless of presentation, private Offline history must never be automatically included in a cloud request.

**Not implied by this plan:** identical Online/Offline models or capabilities, offline speech recognition/TTS, AI-driven editing commands, mobile local AI, cloud PDF synchronization, or guaranteed cold-start operation without internet. Local text inference after preparation must not require cloud services; installation and asset downloads require connectivity. Manual editing and export remain local and available.

## AI-003: Qualify the Local Model and Browser Runtime

**Status:** Not started; model files and public metadata have been researched, but inference has not been tested.  
**Depends on:** The agreed direction above.  
**Purpose:** Establish a viable local baseline before building the complete user workflow.

### AI-003.1: Pin the Evaluation Package

- **Why:** A model name or vendor benchmark does not establish the quality of a particular browser conversion.
- **What:** Evaluate `SmolLM2-1.7B-Instruct-q4f16_1-MLC` through WebLLM without changing the Online Sarvam provider.
- **How:** Pin compatible runtime, model revision, tokenizer and compiled WebGPU library; verify their availability, licenses and integrity. Record generation settings and artifact provenance. Use public or synthetic English passages locally, not private PDFs in hosted demos.

Metadata checked on 2026-09-20: approximately **962.79 MB of model weights**, a WebLLM context override of **4,096 tokens**, `shader-f16` support, and an estimated **1,774.19 MB of GPU memory**. These are not total application download/storage/RAM requirements or certified minimum hardware. Include supporting assets in the UI's measured download size. The model's Apache-2.0 license requires compliance; its published IFEval score of 56.7 is an average instruction-following metric, not our quantized PDF accuracy.

### AI-003.2: Establish Quality and Device Baselines

- **Why:** The local option must provide useful generated answers, not merely load successfully or quote passages.
- **What:** A reproducible browser evaluation covering direct questions, summaries, cross-page evidence, numerical facts, follow-ups and unsupported questions.
- **How:** Agree pass/fail thresholds before testing; record failures and first-meaningful-text latency on representative Chrome/Edge devices. Measure cold download, initialization, indexing and warm answer generation separately. Keep minimum RAM/GPU/storage requirements provisional until measured. If the model fails, return for a non-Chinese candidate decision rather than silently changing capability or falling back to cloud reasoning.

### Acceptance

- [ ] Exact artifacts and license notices are recorded and a local streaming response runs on target browsers.
- [ ] Baseline quality results, limits and provisional supported devices are documented; production selection is not claimed from public scores alone.

## AI-004: Enforce Privacy Routing and Remove Automatic Cloud Detection

**Status:** Not started.  
**Depends on:** AI-003; implement these boundaries before exposing a local workflow.

### AI-004.1: Remove the Automatic Location Feature Globally

- **Why:** Opening a PDF currently can send text remotely without any chat submission.
- **What:** Remove the automatic cloud location-detection feature in both tabs, not just disable it in Offline.
- **How:** Remove the trigger in [PdfViewer](src/components/PdfViewer.tsx), the provider-backed path in [locationDetect](src/lib/smart/locationDetect.ts), and dependent automatic overlays/state/tests as appropriate. Do not substitute another background cloud extractor. Preserve unrelated local date detection and manual editing; any remaining external actions must obey AI-004.3.

### AI-004.2: Route Each Capability by Active Policy

- **Why:** The current sequential [provider chain](src/lib/providers/index.ts) starts with Sarvam; adding a local provider to that chain would not enforce privacy.
- **What:** Explicit routes for Online, Offline with cloud voice, and Offline text-only.
- **How:** Reuse the [provider interface](src/lib/providers/types.ts), but authorize each method before dispatch. Offline `discuss` and any document-derived reasoning always stay local. Only voice-related audio and the dialogue needed for permitted translation/playback may leave in hybrid mode; never attach the full PDF, retrieved passages or hidden history to those requests. Text-only denies all remote dialogue calls, retries, speech preloads and fallbacks. Asset downloads are separate from content-bearing requests. Opening a document or chat, showing the greeting, checking compatibility or selecting a tab must not itself send document or dialogue content.

| Active Policy | Reasoning Context | Remote Voice/Dialogue |
| --- | --- | --- |
| Online | Sarvam receives the context needed for an explicitly submitted request. | Existing supported Sarvam voice flow, subject to permission and access controls. |
| Offline, voice allowed | Local model and local document index only. | Only disclosed, user-triggered voice/translation/playback data; generated answers can contain PDF-derived information. |
| Offline, voice denied | Local model and local document index only. | None; disable input voice and remote speech output. |

### AI-004.3: Guard Side Effects and Policy Changes

- **Why:** External URLs, logs and already-running tasks can bypass an apparently local chat interface.
- **What:** One policy applied to all content egress, not only the visible Send and microphone controls.
- **How:** Disable document-derived Search, Maps and Calendar links/actions in Offline regardless of voice permission. Audit requests, WebSockets, analytics, error reports and logs without recording private contents. On tab/permission/document changes, stop incompatible recording/playback, abort requests where possible and reject stale completions using operation/revision identifiers. Already-transmitted data cannot be recalled. Never upload Offline history automatically or route a failed local request online.

### Acceptance

- [ ] Document/chat opening sends no document or dialogue content remotely; automatic cloud location detection is removed in all modes.
- [ ] Routing tests reject forbidden methods and prove failures, retries and tab changes cannot trigger cloud fallback or history leakage.
- [ ] Offline external actions and content-bearing telemetry are blocked, including while cloud voice is allowed.

## AI-005: Implement Model Download, Caching and Lifecycle

**Status:** Not started.  
**Depends on:** AI-004.

### AI-005.1: Check Compatibility Without Delaying Online

- **Why:** Unsupported hardware must be detected without penalizing users who keep the current Online experience.
- **What:** Lightweight browser/WebGPU/feature/storage checks, followed by real load-time error handling.
- **How:** Run local capability checks during the greeting without downloading weights. Keep Offline preparation unavailable while checking; show a reason if unsupported, using "Local AI is unavailable because this device does not meet the minimum requirements." Keep Online and manual editing usable. Do not claim exact free GPU memory can be determined reliably; handle initialization failure even after an initial pass.

### AI-005.2: Download Only on Offline Selection

- **Why:** Nearly 1 GB of weights should not be downloaded for default Online users or once per PDF.
- **What:** A shared, lazy model loader with visible size, byte progress, cancellation, retry and cached reuse.
- **How:** Start or attach to one active preparation operation when Offline is selected and compatible. Display progress at the top of the Offline panel; distinguish downloading, loading and preparing the PDF. Measure all required assets rather than using weight bytes alone. Do not impose the removed two-minute timeout or add an approval modal. Handle network loss, partial/corrupt cache and storage exhaustion; preserve drafts and edits. Deduplicate loads and use resumable caching only where supported and verified.

### AI-005.3: Manage Cache and Worker Resources

- **Why:** A downloaded model is not necessarily loaded, and browser storage can be cleared or evicted.
- **What:** Versioned cache, off-main-thread inference, recoverable unload/reload and a way to remove downloaded model assets.
- **How:** Reuse WebLLM's supported worker/cache APIs. Validate a pinned asset manifest; keep model assets separate from PDF projects and conversation state. Reuse the cache across PDFs in the same browser profile. Do not promise permanent storage or persist private conversation/KV state with model weights. Release GPU/worker resources safely and recover from device loss. Model removal must not delete PDFs, and deleting a PDF must not require downloading the shared model again. Validate asset hosting limits, CORS/CSP and distribution bandwidth costs before release.

### Acceptance

- [ ] Online never waits for or initiates a model download; compatible Offline selection starts preparation with top-panel progress and Cancel.
- [ ] Cached, uncached, cancelled, interrupted, evicted, corrupt and low-storage cases preserve work and expose actionable recovery without cloud fallback.

## AI-006: Build Whole-Document, Current-Edit-Aware Local Context

**Status:** Not started.  
**Depends on:** AI-005.

### AI-006.1: Extract All Supported Text

- **Why:** The current [document text helper](src/lib/pdf/documentText.ts) supplies a `full` string capped at 50,000 characters; that cannot represent an entire book reliably.
- **What:** Complete selectable English text from every relevant page for local analysis of PDFs up to 50 MB.
- **How:** Reuse page extraction, but build a separate whole-document context/index rather than pass the truncated `full` field. Track page coverage and extraction errors. Apply the size limit only to local analysis; settle the exact MB byte convention before implementation. Identify image-only or partly unreadable documents without adding OCR. Do not report missing topics as proven absent when pages were not readable. Keep all extraction/index data local.

### AI-006.2: Reflect Confirmed Edits and Page Changes

- **Why:** Answers based on pristine import bytes can contradict what the user now sees.
- **What:** A revisioned representation of current confirmed text and page order; exclude uncommitted drafts.
- **How:** Combine extracted content with the authoritative edit and page-plan state, including replacement/addition/removal, Undo/Redo, inserted/deleted/reordered/duplicated pages, and corresponding source anchors. Do not count both covered original text and its confirmed replacement as current content. Keep original bytes immutable; this is not secure redaction. Invalidate affected chunks and reject responses from stale revisions. Test that older chat claims cannot override the current document.

### AI-006.3: Index Locally and Track Readiness

- **Why:** A whole PDF and eight chat messages will often exceed a 4,096-token model budget.
- **What:** Page-anchored chunks, local passage retrieval and full-document coverage metadata.
- **How:** Choose a lightweight existing retrieval approach and test paraphrases and multi-page questions. If embeddings are needed, include their model assets in the download, licensing and readiness budgets. Track model readiness independently from document-index readiness. Reindex changes without blocking editing, and disable Offline submission until the active revision is ready. Do not confuse a 50 MB file-size limit with a guarantee of bounded extracted-text memory or preparation time.

### Acceptance

- [ ] Questions about text beyond the old character cap work; every readable page is represented without silent truncation.
- [ ] Confirmed edits, Undo/Redo and page changes update context and references; unconfirmed drafts do not affect answers.
- [ ] Oversized, image-only and extraction-failure cases explain limitations instead of hanging or fabricating absence.

## AI-007: Generate Grounded Answers, Summaries and Page References

**Status:** Not started.  
**Depends on:** AI-006.

### AI-007.1: Implement the Local Discussion Provider

- **Why:** [BrowserProvider](src/lib/providers/browser.ts) is currently a shell with no supported methods.
- **What:** Local English generation with streamed answer text and explicit unsupported capabilities.
- **How:** Adapt the qualified WebLLM package to `discuss` and `onTextDelta`, with an explicit local route. Supply only the relevant passages, question and permitted session history. Budget system instructions, up to the last eight messages, retrieved evidence and output together; trim older context when necessary and clarify ambiguous references instead of guessing. Treat PDF text as untrusted evidence, not instructions. Do not enable editing tools or external browsing for this release.

### AI-007.2: Ground Responses and Validate Citations

- **Why:** A fluent answer or a model-generated `grounded` flag is not proof of source support.
- **What:** Explanations and cross-page answers based only on supported current-document evidence, with clickable page references.
- **How:** Assign source IDs before generation and map returned references to real page/passage anchors; reject invented IDs and stale revisions. Check support for important claims, numbers and names. Use "I do not see any mention about this topic in the PDF." only when coverage and retrieval justify it; otherwise explain that no supporting answer could be located or that text was unreadable. For image-based questions, say "I cannot read images in this PDF." Do not fill gaps with outside knowledge. Clicking a citation navigates locally to its supporting passage.

### AI-007.3: Summarize Across the Whole Document

- **Why:** A top-ranked handful of passages cannot establish a whole-book summary.
- **What:** Section/chunk summaries combined into a grounded final summary with traceable evidence.
- **How:** Cover all readable sections, carry source IDs through intermediate steps, and distinguish section summaries from whole-book summaries. Report omissions, cancellation and unreadable pages. Longer summaries may take longer than routine questions; show honest progress and never substitute a partial result as complete coverage.

### Acceptance

- [ ] Direct, follow-up, cross-page, numerical and missing-topic tests pass agreed quality thresholds without outside-knowledge substitution.
- [ ] Citations resolve to current supporting passages; false grounding, fabricated citations and stale responses are detected in tests.
- [ ] Whole-book summaries cover all readable sections and disclose incomplete coverage.

## AI-008: Add Online/Offline Chat Tabs and Readiness States

**Status:** Not started.  
**Depends on:** AI-007.

### AI-008.1: Keep Online the Immediate Default

- **Why:** Existing users should not encounter local download or compatibility waits for Online chat.
- **What:** Accessible Online and Offline tabs inside [PdfChat](src/components/PdfChat.tsx), with Online selected whenever the dialog opens.
- **How:** Keep [Toolbar](src/components/Toolbar.tsx) Ask available only after the PDF is fully open. Preserve current Online submission and supported voice behavior, except for the intentional privacy fixes and future access controls. Never gate Online on Offline readiness or show a fake zero-latency promise. Render the greeting locally: "Hello, your PDF agent is here to help you. What is the question?" The greeting animation and background capability check must not block Online or issue cloud requests.

### AI-008.2: Present Offline Setup at the Top

- **Why:** Downloading, loading and document preparation are different states the user must understand.
- **What:** Top-panel size/progress/status, Cancel and Retry, followed by the agreed voice permission checkbox and disclosure.
- **How:** Bind the panel to AI-005 and AI-006 state; reuse cached assets without redundant downloads. Show "Your PDF agent is getting ready..." while required preparation is incomplete. Keep the editor and question draft usable. Observe local readiness at least every second without cloud polling or an artificial delay. Distinguish unsupported device, download failure and unreadable-document states; show model available separately from document ready.

### AI-008.3: Gate Every Submission Path

- **Why:** Disabling one button does not stop Enter, continuous voice or stale asynchronous submissions.
- **What:** A single readiness/policy check for Send, keyboard submission and all voice entry points.
- **How:** Enable Offline text submission only when the model and active document revision are ready. Enable voice only when those conditions and cloud voice permission hold. Keep it disabled when permission is unchecked even after preparation. Handle rapid tab changes, unmounts and keyboard activation consistently. Provide accessible labels, focus order, progress announcements and reduced-motion behavior without changing the established visual design.

### Acceptance

- [ ] Every dialog opening defaults to Online with no added model wait; selecting Offline exposes the preparation state at the top.
- [ ] Users can draft/edit during preparation but no Offline submission path bypasses readiness or permission.
- [ ] Unsupported/error/retry/cancel states are accessible and do not lose edits or drafts.

## AI-009: Add Consent-Controlled Cloud Voice to Offline Chat

**Status:** Not started.  
**Depends on:** AI-008; production transport and authorization also require AI-002 before release.

### AI-009.1: Apply the Agreed Consent Wording and Polarity

- **Why:** "Offline" with cloud voice enabled does not mean conversation content stays entirely on the device.
- **What:** A checkbox labeled **Allow cloud AI for voice**, initially checked, with the accepted disclosure immediately beside/below it.
- **How:** Display **Spoken questions and answer text, including information from this PDF, may be sent to Sarvam.** Make the hybrid behavior explicit before microphone use. Checked permits only the voice workflow; it does not authorize sending the document/index to a remote reasoning model. Unchecked means local text-only and disables microphone/Conversation controls and cloud read-aloud.

### AI-009.2: Separate Speech From Local Reasoning

- **Why:** Audio services can be remote while answers are still generated from the PDF locally.
- **What:** Permitted flow: user audio -> Sarvam transcription/English translation if needed -> local PDF reasoning -> permitted answer translation/TTS for playback.
- **How:** Reuse supported Sarvam speech components without calling Sarvam `discuss` for Offline answers. Keep the canonical local answer in English. Implement and test any missing translation bridge explicitly; existing translation stubs are not working features. Send only the utterance or answer needed for that speech operation, never hidden retrieved context. Preserve typed chat if translation, speech or network fails.

### AI-009.3: Stop All Remote Dialogue When Permission Is Removed

- **Why:** Disabling the microphone alone leaves TTS, fillers, queued work and browser speech fallbacks as possible content leaks.
- **What:** Permission enforcement across recording, transcription, translation, acknowledgments, speech queues, read-aloud and retries.
- **How:** Gate these operations before requests; stop recording/playback and invalidate queued/in-flight work on uncheck or policy change. Do not preload cloud speech merely when the dialog opens. Browser/OS speech must not be assumed local; with voice denied, do not use it as a fallback. Re-enabling permission must not automatically transmit previously drafted or queued private dialogue.

### Acceptance

- [ ] Checked Offline voice uses cloud speech plus local reasoning, with accurate disclosure and no document-context upload.
- [ ] Unchecked Offline is text-only with no cloud dialogue requests, including background, playback and retry paths.
- [ ] Speech failures, permission revocation and disconnections preserve usable local text chat.

## AI-010: Define Tab History, Saved Preferences and Transition Behavior

**Status:** Not started; the specific history presentation and migrated preference defaults need confirmation.  
**Depends on:** AI-009.

### AI-010.1: Isolate Private History

- **Why:** A later Online question could leak previous Offline messages if both tabs share the same request history.
- **What:** Recommended implementation: separate in-memory histories per tab, using the agreed session-only retention.
- **How:** Confirm this presentation before implementation. Independently enforce that Online prompts never automatically include Offline turns. Supply up to the last eight messages from the relevant history, within the model's context budget. Clear both on refresh or document change; do not persist them in IndexedDB, account storage, telemetry or model caches. Clearly associate visible answers/drafts with their tab.

### AI-010.2: Preserve Voice Denial Without Restoring the Wrong Tab

- **Why:** A checked default for new PDFs must not silently override a user's previous explicit denial.
- **What:** Recommended adaptation of the earlier saved-project preference requirement: persist cloud voice permission per saved PDF, but always open chat on Online.
- **How:** Confirm the migrated setting and unsaved-document defaults. Extend existing [project state](src/lib/projects/projectState.ts) and autosave only for the permission, not chat. Restore it before any Offline voice operation. Model cache readiness is shared and independent of that permission. Do not reintroduce the removed local-processing checkbox or a remembered active tab contrary to Online-on-open.

### AI-010.3: Make Transitions Recoverable

- **Why:** Downloads, answers and audio can complete after a user switches tabs, closes chat or changes documents.
- **What:** Deterministic cancellation and operation ownership across transitions.
- **How:** Preserve manual edits and unsent drafts, prevent duplicate model loads, release inactive resources and discard late completions. Define whether an explicit model download continues after switching to Online or closing chat; recommended default is to stop unnecessary work while retaining valid cached assets. Never cancel into a cloud retry, silently resend a draft or auto-share private history.

### Acceptance

- [ ] Recommended history/preference/transition behaviors are confirmed and tested without treating them as already implemented.
- [ ] Online-on-open, session-only history, saved voice denial and shared model caching remain independent.
- [ ] Rapid switches, close/reopen and document replacement cannot leak history or render stale answers.

## AI-002: Website Login and Controlled Online AI Access

**Date:** 2026-09-15  
**Updated:** 2026-09-20  
**Status:** Deferred until the preceding items are resolved; implementation and deployment have not started.  
**Priority:** After AI-010, before public release of application-funded cloud services.  
**Depends on:** AI-003 through AI-010 and approval of the account/access policy.  
**Planning direction:** Supabase Auth + PostgreSQL and the Cloudflare API layer remain proposed; Sarvam remains the Online provider.  
**Owner:** To be assigned.

> **Scope update, 2026-09-20:** Online chat remains Sarvam-backed. Permitted cloud voice in the Offline tab is also a remote, billable service and must receive the same authorization and usage controls. Local text reasoning, local model reuse, and manual PDF tools must not depend on live login or cloud quota checks. Supabase, login methods and allowances require approval; unprotected application-funded endpoints must not be publicly released while those decisions are pending.

### What We Are Trying to Do

Allow users to use approved application-funded Sarvam services without supplying their own provider API key. Supabase remains a proposed option for authentication and managed PostgreSQL account/usage data, subject to approval after the local architecture work. This applies to Online chat and to permitted cloud voice in Offline, not to local text inference.

- Start with an app-branded login screen and **Continue with Google** if authentication is approved.
- Design around the Supabase user ID and session so email/password login can be added without changing backend authorization. Treat that login method as an optional follow-up, not committed initial scope.
- Keep the selected provider's application API key on the server. Website login identifies the user; it does not replace provider credentials.
- Track online AI allowances and consumption per authenticated user, with an application-wide spending cutoff.
- Proposed access policy: require login for provider-backed online AI, while keeping local PDF viewing, editing, tools, and export available without an account. Confirm this policy before implementation.
- Keep the domain registered at GoDaddy. No GoDaddy database or hosting purchase is required just because the domain is registered there.

### Why We Proposed This Method

- **Authentication and SQL together:** Supabase manages login identities and supplies PostgreSQL for profiles, preferences, and usage records. A separate database purchase is unnecessary for the initial scope.
- **Low initial recurring cost:** Google and email/password authentication are both included in Supabase Free. The free tier is not a time-limited trial, but its usage and resource limits still apply.
- **Lower published per-user cost for a returning audience:** Supabase Pro includes 100,000 monthly active users and charges USD 0.00325 per additional MAU. Clerk includes fewer users on Pro and has higher published marginal rates. This is not universal: Clerk excludes first-day-only users from its monthly retained-user count, so a mostly one-time audience can cost less there.
- **Own login UI:** A small React screen can match the existing application without buying a prebuilt login UI subscription. Google still controls its account-selection and consent screens.
- **Less security maintenance than self-hosting authentication:** The team does not implement password hashing or operate the identity service. It still owns application authorization, data access policies, usage controls, and secure integration.
- **Fits the existing code:** Production HTTP calls already use a same-origin Sarvam proxy. Reuse suitable proxy patterns for the selected online provider instead of replacing the PDF editor or provider interface.

### Current Starting Point

- [Provider configuration](src/lib/providers/config.ts) selects direct Sarvam calls during development and `/api/sarvam` in production; production does not return a Sarvam key to the client.
- [Proxy handler](src/server/sarvamProxy.ts) restricts HTTP endpoints and injects the server key, but has no user-session validation. Its rate-limit hook is optional, and its body-size check trusts `Content-Length`.
- [Pages endpoint](functions/api/sarvam/%5B%5Bpath%5D%5D.ts) supplies the server key and optional allowed origins, but does not supply authentication or a rate limiter.
- [Streaming provider methods](src/lib/providers/sarvam.ts) explicitly reject production streaming speech until WebSocket proxy support exists. Website login alone will not make live voice work in production.
- [Saved projects](src/lib/projects/projectStore.ts) use browser IndexedDB, not cloud storage or an account-scoped database.

### AI-002.1: Confirm Access Policy and Hosting

- **Why:** Retaining cloud services creates ongoing credential, abuse and spending risks even with a local reasoning option.
- **What:** Approved login scope, provider budgets, production voice scope and a verified Cloudflare deployment path.
- **How:** After AI-010, approve or revise Supabase, Google-only initial login and the policy for cloud voice in Offline. Check whether the actual deployment is Pages or Workers: [Wrangler configuration](wrangler.jsonc) describes static assets while the API is a Pages Function. Verify requests reach backend code, not the SPA fallback. Keep protected staging separate from public release.

### AI-002.2: Configure Identity, SQL and Login Recovery

- **Why:** User identity must be verified without losing the document or putting PDF data into account storage.
- **What:** Minimal account/usage tables and an app-branded sign-in, callback, logout and recovery flow.
- **How:** If Supabase is approved, configure Google with only `openid`, email and profile scopes and restricted callback origins. Use its maintained SDK and stable user ID. Enable row-level security; forbid client changes to allowances or consumption. Do not duplicate passwords or retain unnecessary Google tokens. Preserve open files, unsaved edits and drafts across OAuth. Define deletion and revocation behavior; existing IndexedDB projects are not automatically isolated by account.

### AI-002.3: Protect Cloud Requests and Bound Spending

- **Why:** A frontend checkbox or login screen cannot protect an application-funded API.
- **What:** Server-side authentication, authorization, per-user allowances and application-wide spending limits for every remote capability.
- **How:** Validate session signature, expiry, issuer/audience as applicable, derive identity server-side and reject unauthorized requests before Sarvam calls. Keep provider and privileged Supabase secrets out of `VITE_*`, browser bundles, URLs and logs. Atomically reserve/reconcile usage in PostgreSQL across concurrent tabs/instances. Limit actual streamed body bytes, audio duration, output tokens, concurrency and timeouts. Track speech and reasoning separately, including permitted cloud voice from Offline. Fail closed for remote calls when auth/quota checks fail, while leaving local text inference and manual tools usable.

### AI-002.4: Complete Production Speech Transport

- **Why:** Current production streaming speech explicitly rejects use until a WebSocket relay exists; HTTP login protection does not fix that.
- **What:** Protected live speech transport for all included voice workflows, with clear handling for unsupported/deferred capabilities.
- **How:** Authenticate the relay via a secure handshake or short-lived single-use ticket, never a provider key in the browser. Validate origin, messages, connection count, duration and audio volume. Close microphone capture and upstream connections on logout, expiry, cancellation, permission denial or quota exhaustion. Preserve supported batch speech where policy permits, but never use fallback speech when Offline cloud voice is unchecked. Verify the hybrid route still generates answers locally.

### AI-002.5: Disclose Cloud Use and Verify Access Controls

- **Why:** Users need accurate distinctions between local documents, cloud dialogue, account data and service failures.
- **What:** Clear signed-out, expired-session, exhausted-allowance and provider-error states plus security validation.
- **How:** Keep document contents out of routine logs and SQL usage metadata; define retention/deletion. Test wrong-project, revoked and malformed sessions, two-user row isolation, concurrent budget exhaustion and staging OAuth/voice flows. Preserve local text chat when account services fail. Feed results into the final AI-011 release gate rather than declaring readiness after a prototype.

**Proposed remote request flow:** Website login -> Supabase session -> Cloudflare session validation -> SQL allowance reservation -> Sarvam with server credentials -> response and usage reconciliation. This applies to approved cloud requests from either tab, never to local inference itself.

### Optional Email/Password Follow-Up

Supabase Free supports email/password authentication alongside Google; no paid upgrade is required solely to enable it. Add signup, email verification before online AI access, login, forgot-password, reset-password, and tested account-linking behavior. Use supported identity-linking flows; never merge accounts merely because the client supplies matching email strings.

Configure a production SMTP sender for verification and recovery messages. Supabase's default sender is testing-only, including on paid projects. An external sender can have a free allowance, but daily/monthly limits and email delivery costs must be budgeted separately. Ordinary password login does not send an email every time; email OTP/magic-link login does.

### Expected Impact

| Area | Expected Change | Boundary or Risk |
| --- | --- | --- |
| User experience | Users sign in normally and never configure personal provider credentials. | Google-only initially excludes people who do not want to use a Google account; authentication must not lose document work. |
| Security | Server-verified identity and usage controls protect the application-funded API. | Login alone does not prevent abuse, multiple-account creation, or excessive AI spend. |
| User data | SQL stores account metadata and online usage allowances in one managed platform. | Row-level security, restricted quota writes, deletion, and retention must be configured correctly. |
| PDF behavior | Existing editing, export, and local saved-project behavior remain unchanged. | Login does not add cloud file sync or isolate existing IndexedDB files between accounts sharing a browser profile. |
| Privacy | Local PDF reasoning remains local; remote dialogue use is disclosed separately. | Account data is stored in Supabase; Online context and permitted Offline voice/answer text cross the network. Do not claim the Offline tab is wholly private while cloud voice is checked. |
| Operations | Managed authentication reduces identity-service maintenance. | Online chat and permitted cloud voice depend on account services; local text inference remains independent. Monitoring and recovery remain team responsibilities. |
| Scope | Reuse React/Vite, the provider interface, and Cloudflare rather than migrate frameworks. | Production online voice may need its own protected relay; do not mark it complete after implementing HTTP authentication. |

### Cost and Effort

Published prices checked **2026-09-15**, in USD before tax; confirm again before provisioning.

| Item | Initial Allowance or Cost | Growth Consideration |
| --- | --- | --- |
| Supabase Free | USD 0; 50,000 MAU and a 500 MB PostgreSQL database. | These are separate limits, not concurrent-user capacity. Free projects can pause after one week of inactivity; automatic backups and an uptime SLA are not included. |
| Supabase Pro | From USD 25/month; 100,000 MAU included. | USD 0.00325 per additional MAU. The baseline assumes one Micro project covered by compute credits; additional projects, compute, storage, or traffic can add costs. |
| Custom login page and Google sign-in | No required UI subscription or Google per-login fee. | The app's website can use its GoDaddy-registered domain. A custom Supabase API/auth hostname is an optional paid feature, currently USD 10/month on a paid plan; the default callback hostname may remain visible otherwise. |
| Email/password delivery | A separate SMTP provider may offer a free tier. | Verification, recovery, and resend volume can create delivery charges independently of authentication MAU. |
| Cloudflare, online AI, and domain | Separate from Supabase pricing. | Cloudflare free-tier limits must be validated; online inference is billed by the selected provider, and domain renewal continues. |

MAU counts distinct users who sign in or refresh a session within the billing cycle, not all registered accounts or each login attempt. Supabase's Pro spend cap covers selected usage categories, not every infrastructure charge and not the external AI provider bill.

**Historical authentication-only estimate, to be reassessed after AI-010:** 3-4 developer-days for Google login plus a protected-chat prototype; 8-12 total developer-days for a tested beta including production voice and usage controls. Email/password support adds approximately 2-4 days. These estimates assumed one experienced full-stack developer and a working baseline, excluding external approvals, payments and cloud PDF synchronization. They do not cover the new local-model, indexing, citation, tab or privacy work. Do not use them as an estimate for this complete plan; the prototype is not a public-release security gate.

### Acceptance Criteria

- [ ] AI-003 through AI-010 have resolved the local architecture and UX, and the AI-002 access policy has been explicitly approved.
- [ ] A user can sign in with Google, reload, and sign out without entering a provider key or losing the open document and unsaved work.
- [ ] Unauthenticated, expired, revoked according to the defined policy, malformed, and wrong-project sessions cannot access protected online AI endpoints or trigger upstream calls.
- [ ] Two users cannot access each other's restricted SQL data, and neither can change their own allowance or usage counters through client requests.
- [ ] Concurrent requests cannot exceed reserved allowance; oversized streamed bodies and over-budget requests are blocked before an unintended provider call.
- [ ] The application-wide cutoff works; authentication/quota failure blocks cloud chat and cloud voice from either tab, while leaving local text processing and PDF tools usable.
- [ ] No provider key, Google client secret, or Supabase privileged key appears in the browser bundle, browser request URLs, or logs; website session credentials are not sent to AI providers.
- [ ] Included online chat and speech flows work in production mode; logout, expiry, disconnect, and cancellation release microphone and upstream resources. Deferred voice work remains explicitly tracked.
- [ ] AI data disclosure, local-file limitations, account deletion, cost monitoring, and free-tier restrictions are documented accurately.
- [ ] Focused tests, typecheck, lint, production build, and the existing PDF export verification harness pass before release; any pre-existing failures are recorded separately.
- [ ] If email/password is included, verified signup, recovery, account linking, and email rate-limit/error paths pass production-sender tests.

### Decisions Before Authentication Implementation

- Approve Supabase or another access-control approach for retained application-funded Sarvam services; no unprotected public release.
- Confirm AI-only login gating, including cloud voice in Offline, without making local text inference depend on live authentication.
- Confirm Google-only first release versus including email/password immediately.
- Set per-user text/speech allowances, concurrency limits, global budget, and the quota-exhaustion experience for approved online services.
- Confirm the actual Pages/Workers deployment, online voice release scope, and acceptance of free-tier inactivity and default callback-hostname limitations.

### References

- [Supabase pricing](https://supabase.com/pricing)
- [Supabase monthly active user billing](https://supabase.com/docs/guides/platform/manage-your-usage/monthly-active-users)
- [Supabase Google sign-in setup](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase production email delivery](https://supabase.com/docs/guides/auth/auth-smtp)
- [Supabase cost controls](https://supabase.com/docs/guides/platform/cost-control)
- [Clerk pricing and retained-user definition](https://clerk.com/pricing)

## AI-011: Validate the Complete Workflow and Release Safely

**Status:** Not started.  
**Depends on:** All preceding items, including approved cloud access controls in AI-002.

### AI-011.1: Run End-to-End Quality and Performance Tests

- **Why:** Component tests and vendor benchmarks cannot establish a usable browser PDF assistant.
- **What:** Evidence for the production model choice, device baseline, source fidelity and readiness/response targets.
- **How:** Reuse existing Vitest/Testing Library tests and the PDF verification harness, adding targeted tests for the touched modules. Exercise real Chrome/Edge with public/synthetic PDFs up to the local-analysis limit, long text beyond 50,000 characters, scans, mixed readable/unreadable pages, current edits and page changes. Measure model download separately from loading, indexing, routine answer start and complete summaries. Test the five-second first-meaningful-text target on supported hardware, with actual evidence and citations rather than filler. Do not run public benchmark scores as product acceptance substitutes.

### AI-011.2: Verify Network Privacy and Mode Transitions

- **Why:** Static source scans do not cover dependencies, workers, speech sockets or background retries.
- **What:** Runtime network evidence for Online, Offline with voice allowed, and Offline text-only.
- **How:** Inspect fetch/XHR, WebSockets, beacons, workers, speech, navigation and error reporting. Verify no document/dialogue request on import or chat opening; no automatic cloud location extraction anywhere; no document/index upload or private-history transfer from Offline. With voice allowed, only explicitly permitted speech/dialogue payloads may leave. With voice denied, no content-bearing requests may leave. After preparation, block external network access and test local text answers without live login; do not confuse this with a guaranteed offline cold launch. Exercise cache eviction, cancelled downloads, permission changes, multiple tabs and late responses.

### AI-011.3: Document, Stage and Approve Release

- **Why:** Published claims, hosting limits and rollback behavior must match what was actually tested.
- **What:** Updated architecture/progress records, deployment runbook, cost budget and an explicit release decision.
- **How:** Update [ARCHITECTURE.md](ARCHITECTURE.md), [PROJECT_PROGRESS.md](PROJECT_PROGRESS.md) and [TASKS.md](TASKS.md) after implementation. Record pinned model/runtime versions, all asset sizes, licenses, storage controls, support matrix, privacy disclosures and known limitations. Budget model distribution bandwidth, hosting, Sarvam reasoning/speech and approved account services separately; local inference has no hosted per-question fee but is not cost-free. Keep GoDaddy as domain registrar; no model, database or hosting purchase is implied by domain registration. Stage the deployment, validate the API route and assets, and provide rollback that never reroutes a local request to cloud AI. If quality or hardware goals fail, keep local AI unavailable and report the issue rather than weaken privacy or claim readiness.

### Release Acceptance

- [ ] Online opens by default and retains its existing supported experience without any Offline preparation wait.
- [ ] Offline preparation shows accurate top-panel status, size, Cancel and Retry; cached reuse works without a two-minute download deadline.
- [ ] Offline text-only has no remote content processing; permitted hybrid voice uses the accepted disclosure and never cloud PDF reasoning.
- [ ] Whole-document coverage, confirmed edits, reliable citations, summaries and missing-topic/image limitations pass the agreed evaluation.
- [ ] Minimum hardware and browser support are measured; the five-second routine answer-start target is met or release is explicitly held.
- [ ] Tab/permission transitions, session-only history, cancellation and saved-preference behavior cannot expose private dialogue or stale answers.
- [ ] Runtime privacy checks, account authorization, concurrent quotas, production voice and failure recovery pass before public access.
- [ ] `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` and the existing PDF export verification harness pass; unrelated pre-existing failures are recorded separately.
- [ ] No regression to manual editing, local saved projects, PDF tools or export, including on devices without local AI support.
- [ ] Documentation, license notices, operating budget and rollout/rollback are reviewed; remaining limitations are disclosed accurately.

## Remaining Decisions and Evidence

| Item | State / Next Action |
| --- | --- |
| Local model | SmolLM2-1.7B Q4 + WebLLM is the preferred trial, not a proven production winner; qualify in AI-003 and approve using AI-011 results. |
| Download limit | Resolved: no two-minute cap. Display size, progress, cancellation and connection-dependent duration. |
| History and preferences | Confirm separate tab histories, per-saved-PDF voice permission, and download behavior on tab switch/close in AI-010. |
| Device and document limits | Measure minimum devices, RAM/GPU/storage and preparation times; define 50 MB in bytes consistently. No additional page/text cap is approved. |
| Quality thresholds | Establish representative expected answers and acceptable grounding/citation/summary failure thresholds before model testing. |
| Cloud access | Approve authentication, allowances, production speech transport and budgets in AI-002. Local text inference remains independent. |
| Fully disconnected startup | Not part of the current commitment. Separately scope application-asset caching/PWA support before advertising offline cold-start availability. |

## Local Processing References

- [SmolLM2-1.7B-Instruct model card, limitations and license](https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct)
- [MLC Q4/F16 model package](https://huggingface.co/mlc-ai/SmolLM2-1.7B-Instruct-q4f16_1-MLC)
- [MLC weight manifest used to calculate model bytes](https://huggingface.co/mlc-ai/SmolLM2-1.7B-Instruct-q4f16_1-MLC/resolve/main/ndarray-cache.json)
- [WebLLM prebuilt model registry and context overrides](https://github.com/mlc-ai/web-llm/blob/main/src/config.ts)
- [WebLLM documentation](https://webllm.mlc.ai/docs/)
- [Sarvam pricing; recheck before budgeting or provisioning](https://docs.sarvam.ai/api/getting-started/pricing)