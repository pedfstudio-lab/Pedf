# Improvement Action Items

**Action items must be followed in the exact order listed below.**

## AI-001: Evaluate Qwen and Propose Online/Offline AI Modes

**Date:** 2026-09-16  
**Status:** Proposal and evaluation only; no model replacement or mode implementation has started.  
**Priority:** First; decide the model and processing architecture before authentication integration.  
**Candidate:** Qwen3.5-9B, compared with the existing Sarvam experience.  
**Next step:** Website trial comparing conversational quality and human touch.  
**Owner:** To be assigned.

**The complete implementation is yet to be finalized.** Qwen is a candidate, not the selected replacement. The desired outcome is the same model and supported capabilities in both modes, without an intentional quality downgrade offline. Feasibility, hardware requirements, and quality parity must be demonstrated before committing.

**Decision gate for AI-002:** After the model trial and architecture review, decide whether application-funded online inference, remote speech, or other account-backed services remain in scope. Only then confirm whether website authentication is needed and adapt that proposal to the selected provider. A local-only workflow does not need website login merely to run the model.

### What We Are Trying to Do

Create a secure PDF editor environment where users can work with private documents without sending those documents, extracted content, or stored conversation context to the cloud. A verifiable private offline experience can be the product's **unique selling proposition (USP)**.

Proposed USP wording, subject to successful verification: **"Private Offline mode: your PDF content and conversation are processed on your device."** This is a target, not a claim about the current application or its online mode. Local processing also needs secure application code, controlled storage, and data-deletion controls; a local model alone does not guarantee security.

### Why We Are Considering Another Model

- The current Sarvam chat path sends extracted PDF text and recent conversation to a hosted model. A server-side proxy protects credentials but does not keep that content on the user's device.
- [Location detection](src/lib/smart/locationDetect.ts) also sends extracted PDF text to AI, independently of chat. The [viewer](src/components/PdfViewer.tsx) starts it automatically on document load when provider configuration permits. Any offline boundary must cover this feature too.
- Qwen3.5-9B has downloadable Apache-2.0 weights and documented server deployment options, making it a candidate for both hosted and on-device processing. A complete browser build and its capabilities still need validation.
- Sarvam-105B also has open weights, but its much larger storage and hardware requirements make ordinary browser deployment impractical. The open checkpoint has not been verified as identical to the app's `sarvam-105b-conversations` API variant.
- Privacy, same-model deployment, and preservation of conversational quality drive this investigation. Lower online token prices are an additional benefit, not sufficient justification for sacrificing capability or human touch.

### Benchmark Comparison

Published developer-reported scores checked **2026-09-16**. Higher is better within each benchmark; these are not overall ratings or percentages of product readiness.

| Benchmark | What It Measures | Qwen3.5-9B | Sarvam-105B |
| --- | --- | ---: | ---: |
| MMLU-Pro | Knowledge and reasoning | 82.5 | 81.7 |
| GPQA Diamond | Difficult scientific reasoning | 81.7 | 78.7 |
| IFEval | Following explicit instructions | 91.5 | 84.8 |
| LiveCodeBench v6 | Coding problem solving | 65.6 | 71.7 |

These values come from separate vendor evaluations, not a controlled head-to-head. Prompts, generation budgets, inference settings, and evaluation procedures may differ. They do not establish equal PDF accuracy, Hindi/Tamil fluency, conversational warmth, or browser performance. The Sarvam scores describe the published 105B checkpoint, not a verified evaluation of our exact conversations endpoint. A quantized offline Qwen build must be evaluated separately; published full-model scores cannot simply be carried over.

| Product Requirement | Current Assessment |
| --- | --- |
| Natural conversation and human touch | Qwen is a plausible candidate; no verified comparison establishes that it feels as natural as the current Sarvam experience. |
| Hindi, Tamil, and mixed-language conversation | Sarvam has a specific Indian-language focus. Qwen's broad multilingual coverage does not prove equal quality for these languages. |
| PDF questions, citations, and location extraction | Both need testing with identical document context and expected answers. Correct numbers, names, and page references matter more than generic benchmark rankings. |
| Safe editing commands | Evaluate intent, target selection, structured proposals, clarification of ambiguity, and preservation of unrelated content. Voice-driven editing is not currently implemented. |
| Images, diagrams, and scans | Qwen supports image input at the model level, but the chosen local runtime and document pipeline must actually support it. This does not automatically solve OCR or PDF fidelity. |
| Voice quality | Qwen3.5-9B does not replace Sarvam's separate Saaras transcription or Bulbul speech-generation models. End-to-end voice capability needs its own decision and evaluation. |

### Cost Comparison

Published API rates checked **2026-09-16**. These are inference charges, separate from authentication, databases, application hosting, taxes, and currency-conversion fees. Confirm current rates and service terms before purchase.

| Model and API Host | Input per 1 Million Tokens | Output per 1 Million Tokens | Cached Input |
| --- | ---: | ---: | --- |
| Qwen3.5-9B, DeepInfra default tier | USD 0.10 | USD 0.15 | Not assumed in the comparison |
| Qwen3.5-9B, Together serverless | USD 0.17 | USD 0.25 | Not assumed in the comparison |
| Sarvam-105B / `sarvam-105b-conversations`, Sarvam | INR 29.28 | INR 73.20 | INR 10.98 per million qualifying cached input tokens |

**Illustrative workload:** 10,000 input tokens and 500 billed output tokens per request, no cache discounts, and an assumed **USD 1 = INR 90** for comparison only. This is not a live exchange rate or a traffic forecast.

| Requests per Month | Qwen on DeepInfra | Qwen on Together | Sarvam |
| ---: | ---: | ---: | ---: |
| 1,000 | INR 96.75 | INR 164.25 | INR 329.40 |
| 10,000 | INR 967.50 | INR 1,642.50 | INR 3,294.00 |
| 100,000 | INR 9,675.00 | INR 16,425.00 | INR 32,940.00 |

Input includes prompts, supplied document text, and history. Count all billed output, including reasoning where charged. Different tokenizers, response lengths, retries, and automatic extraction requests can change actual cost; equal request counts do not guarantee equal token usage.

- **Online speech remains separate:** Sarvam currently lists standard speech-to-text at INR 30 per audio hour, rounded up to whole seconds per request, and Bulbul v3 at INR 30 per 10,000 characters. Keeping those services while changing the reasoning model does not remove their charges.
- **Offline inference has no hosted per-request fee:** both published reasoning checkpoints have Apache-2.0 weights, subject to license compliance. Device compute, storage, power, distribution bandwidth, development, and maintenance are still costs. Sarvam-105B requires much more local hardware than Qwen3.5-9B.
- **Self-hosted online inference is another cost model:** GPU time, capacity, and operations must be budgeted. The current Cloudflare proxy is a gateway, not a GPU inference server. No fixed self-hosting quote is established yet.
- **Exact model parity can affect hosting choice:** the API prices above do not guarantee the same revision or quantization as the offline build. Matching them may require a controlled deployment rather than a generic hosted endpoint.

### Proposed Online and Offline Options

Add a top-toolbar **AI Mode: Online / Offline** segmented selector near Ask. It controls AI processing, not PDF editing: manual editing and export remain local in both modes. This selector does not exist yet.

| Behavior | Online Mode | Offline Mode |
| --- | --- | --- |
| Reasoning | Retain the current hosted flow while the candidate is evaluated; final online model is undecided. | Run a downloaded model on the user's device. |
| Document and conversation data | Hosted reasoning sends supplied context outside the device; require a clear disclosure and user authorization. | No document content, stored conversation, edit state, or derived content is sent to cloud services. |
| First use | Requires network and any agreed account configuration. | Requires a separate connected setup step with permission to download model and runtime assets. |
| Voice | Remote transcription and speech may be used under the online policy. | Requires local speech models or verified local speech services; feature parity must be tested before promising full offline voice. |
| Location detection and other background AI | Governed by the same online consent and provider policy. | Use local processing; do not leave the existing automatic cloud call enabled. |
| Failure | Show provider/network errors and preserve document work. | Never silently fall back to cloud AI; preserve manual editing if local AI cannot run. |

**Offline download proposal:** check browser/GPU compatibility and storage, then show the exact download size, storage requirements, supported capabilities, and Download/Cancel controls. Show progress and retry behavior; verify and version all required model, tokenizer, runtime, and application assets before marking Offline ready. Cache them in browser-managed storage for reuse, support removal, and handle storage eviction or cleared site data. Several GB may be necessary; an MB-sized download is not promised. Download size and working RAM/GPU memory are different requirements.

**Mode boundaries:** offline operation must not depend on live login or cloud usage checks. Stop and invalidate in-flight cloud requests and speech when switching offline, while explaining that already-sent data cannot be recalled. Preserve document edits and never automatically upload offline conversation when switching online. Gate external Search/Maps/Calendar actions and content-bearing logs as well as explicit model calls. Remote audio transcription with local reasoning is a hybrid workflow, not fully Offline: anything spoken can still reach the provider.

**Same-model goal:** if Qwen is selected, aim to run the same checkpoint in both modes, with matched quantization, tokenizer, prompts, retrieval, context budget, and editing schema. Retaining Sarvam online and Qwen offline would not meet that goal. Runtime differences may still affect results and latency. All PDF modifications must continue through deterministic validation, user confirmation, and the local edit/export system.

### Next Step: Website Trial for Human Touch

The immediate next step is **to try Qwen3.5-9B on a hosted website and compare its interaction with Sarvam**. This is an evaluation, not approval to replace the current model or begin full implementation.

1. Use a demo that explicitly identifies **Qwen3.5-9B**, such as the DeepInfra model page. General Qwen Chat can provide an initial impression but must not be treated as a 9B test unless the exact model is confirmed. Record the model name, provider, date, and available thinking/settings information.
2. Compare with the current Sarvam conversations experience using only public or synthetic excerpts and the same prompts/history. Do not upload private PDFs, private passages, or confidential conversation to either website. Use normal consent/account flows without exposing credentials in review notes.
3. Try English, Hindi, Tamil, and mixed-language conversations. Include greetings, a simple explanation, "make that shorter," clarification, a user correction, multi-turn references, document questions, and an ambiguous editing request.
4. Have reviewers score each response from 1 to 5 for naturalness/human touch, language fluency, relevance, concision, and continuity. Record factual/citation errors, invented claims, and response delay separately; pleasant wording must not hide incorrect answers. Blind A/B review is preferable where feasible.
5. Separate writing quality from voice quality. A text demo cannot establish spoken naturalness. If the candidate passes the text trial, compare both reasoning outputs through the same voice and playback settings in a controlled online test using public/synthetic content. Later test the complete local speech and reasoning path independently.
6. Record whether Qwen is better, comparable, or worse for each criterion and language, with example transcripts and test settings. Do not replace this with a single unsupported overall rating. A hosted website trial does not prove the offline quantized model will behave identically.

### Expected Impact and Finalization Gates

- **Product value:** a verified local-processing option can differentiate the editor for private books and documents. The USP must remain mode-specific while online processing can disclose content.
- **User experience:** users gain an explicit choice, but offline setup adds a download, hardware/storage checks, and possible device limitations. Do not silently reduce capabilities to fit weaker devices.
- **Quality:** preserve the conversational experience users value, while qualifying accuracy, language support, and safe edit behavior. No benchmark or website review yet establishes parity.
- **Engineering and cost:** keep the local PDF engine, but add model lifecycle management, mode-aware provider routing, local context preparation, and privacy testing. Hosted inference may become cheaper; offline model distribution and maintenance add work.
- **Not finalized:** exact model/revision, browser versus desktop runtime, quantization, minimum devices, speech stack, online hosting, authentication scope, default mode, consent behavior, download size, and implementation effort remain open. The deferred AI-002 authentication estimates do not cover this new offline implementation.

### Evaluation Checklist

- [ ] Complete the exact-model website trial and document the human-touch comparison with Sarvam.
- [ ] Establish acceptance thresholds for factual accuracy, languages, conversational quality, and latency; choose the model only after review.
- [ ] Validate the intended offline artifact, license/distribution terms, memory requirements, and supported capabilities on target devices.
- [ ] Test the same document questions, location extraction, and validated editing proposals online and offline; evaluate speech separately.
- [ ] Prove no offline content egress with external network access blocked after setup and with network-request inspection while connectivity is available, including automatic location detection, speech, navigation, and mode changes.
- [ ] Finalize and approve the complete architecture, release scope, cost budget, and implementation plan before development.
- [ ] Decide whether AI-002 is required for the chosen online/account services, or can be omitted for a local-only release.

### Comparison Sources

- [Qwen3.5-9B model card and benchmark tables](https://huggingface.co/Qwen/Qwen3.5-9B)
- [Sarvam-105B model card and benchmark tables](https://huggingface.co/sarvamai/sarvam-105b)
- [Sarvam evaluation methodology and Indian-language focus](https://www.sarvam.ai/blogs/sarvam-30b-105b)
- [DeepInfra Qwen3.5-9B pricing and demo](https://deepinfra.com/Qwen/Qwen3.5-9B)
- [Together API pricing](https://www.together.ai/pricing)
- [Sarvam API pricing, including the conversations variant and speech](https://docs.sarvam.ai/api/getting-started/pricing)

## AI-002: Website Login and Controlled Online AI Access

**Date:** 2026-09-15  
**Updated:** 2026-09-16  
**Status:** Deferred pending AI-001; implementation and deployment have not started.  
**Priority:** Second, only if the chosen architecture needs online/account services; complete required access controls before public access to application-funded AI.  
**Depends on:** AI-001 model evaluation and Online/Offline architecture decisions.  
**Planning direction:** Reassess Supabase Auth + PostgreSQL and the Cloudflare API layer after AI-001.  
**Owner:** To be assigned.

> **Scope update, 2026-09-16:** Do not start authentication integration before AI-001 resolves the model and online-service requirements. Authentication is not specific to Sarvam: hosted Qwen, paid speech, or other account-backed services may still need it. If the release is local-only and has no account-backed features, this item may be omitted. Offline processing must not require live login, cloud allowance checks, or a remote provider. The existing Sarvam implementation below is a reference point, not a commitment to retain that provider.

### What We Are Trying to Do

If online/account services remain in scope, allow users to sign in to this website and use its online PDF assistant without supplying their own provider API key. Supabase remains a proposed option for authentication and a managed PostgreSQL database for user-related application data, subject to the AI-001 decision gate.

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

### How to Implement It

1. **Confirm the dependency and release boundaries.** Proceed only after AI-001 identifies the selected model, hosting, and need for online/account services. Reassess the authentication provider and estimates. Agree on AI-only login gating, Google-only initial scope, initial allowances, and whether live voice is required at first release. Check the actual hosting setup: the repository has a Pages Functions endpoint but [Wrangler configuration](wrangler.jsonc) currently describes Workers static assets without an API entrypoint. Verify that deployed API requests reach backend code rather than the SPA fallback.
2. **Configure Supabase and Google if selected.** Create the free Supabase project and Google OAuth client. Request only basic identity scopes (`openid`, email, profile), configure app branding and the production audience, and allow only the required origins and callback URLs. Use a maintained Supabase SDK and its supported OAuth flow; keep the Google client secret in provider configuration, not in the browser.
3. **Define minimal SQL data and access policies.** Let Supabase Auth own identities. Add proposed application tables for `profiles` linked to `auth.users.id`, user preferences, and online AI allowance/usage records. Enable row-level security on exposed tables: users may access only their own permitted fields and must not edit their quota or consumption. Perform quota changes through restricted server operations. Do not duplicate passwords or retain Google access tokens that the application does not need.
4. **Add the website login experience.** Implement sign-in, callback completion, session restoration, logout, and cancellation/error states. Entering login from Ask must preserve the open PDF and unsaved edits across the OAuth flow. Use the stable Supabase user ID for account records, not an email address or Google-specific ID. Handle account deletion and a defined session-revocation policy.
5. **Protect the HTTP/SSE proxy.** Verify the session on every protected request using supported verification tooling, including signature, expiry, expected issuer and audience as applicable. Derive the user ID from verified identity; do not trust an ID supplied by the client. Reject missing or invalid sessions before contacting the selected online provider. Keep provider keys and Supabase privileged credentials server-side, never in `VITE_*` variables. Do not forward website session credentials to AI providers.
6. **Enforce allowances before online provider calls.** Use atomic PostgreSQL operations to reserve bounded usage before dispatch and reconcile it afterward. Limits must hold across concurrent requests, tabs, and backend instances. Add per-user and IP throttles, model/output limits, actual body-byte limits, audio-duration limits, timeouts, and an application-wide AI budget cutoff. Track text and speech usage separately. Fail closed when authorization or required online quota checks are unavailable; an in-memory counter or frontend limit is insufficient. These checks must not block offline processing.
7. **Complete protected online voice transport when in scope.** Authenticate live speech connections through a WebSocket relay; use a protected handshake or short-lived, single-use connection ticket, never a provider key in the browser. Validate origins, messages, connection count, duration, and audio volume. Close microphone capture and both sides of the connection on logout, expiry, cancellation, or quota exhaustion. Preserve supported online batch speech fallback and streaming chat behavior.
8. **Explain errors and data disclosure.** Show clear signed-out, expired-session, exhausted-allowance, and provider-unavailable states without discarding the document. Before online AI use, explain which document text or audio is sent to which provider. Store minimal account/usage metadata, define retention and deletion, and exclude document content and credentials from routine logs.
9. **Test, deploy, and update documentation.** Run authentication and proxy tests, database policy tests, concurrency tests, and real Google/selected-provider staging checks. Verify desktop/mobile login, microphone behavior, and existing PDF export. Update [architecture](ARCHITECTURE.md) and [progress tracking](PROJECT_PROGRESS.md) to reflect the new account/backend model after implementation. Document deployment, monitoring, key rotation, and rollback.

**Proposed online request flow:** Website login -> Supabase session -> Cloudflare session validation -> SQL allowance reservation -> selected online provider with server credentials -> response and usage reconciliation.

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
| Privacy | Ordinary document processing remains local; online AI disclosure becomes explicit. | Account data is stored in Supabase, and authorized online AI text/audio crosses the network. Do not claim the whole application is entirely local. |
| Operations | Managed authentication reduces identity-service maintenance. | Online account services depend on Supabase availability; offline processing must remain independent. Monitoring and recovery remain team responsibilities. |
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

**Earlier planning estimate, to be reassessed after AI-001:** 3-4 developer-days for Google login plus a protected-chat prototype; 8-12 total developer-days for a tested beta including production online voice and usage controls. Email/password support adds approximately 2-4 days. These estimates assumed the previous Sarvam-based online plan and one experienced full-stack developer with a working baseline, excluding external approval delays, payments, and cloud PDF synchronization. They do not cover offline implementation or a finalized new-provider integration. The prototype is not a public-release security gate.

### Acceptance Criteria

- [ ] AI-001 has resolved the model and processing architecture, and the need for AI-002 has been explicitly approved.
- [ ] A user can sign in with Google, reload, and sign out without entering a provider key or losing the open document and unsaved work.
- [ ] Unauthenticated, expired, revoked according to the defined policy, malformed, and wrong-project sessions cannot access protected online AI endpoints or trigger upstream calls.
- [ ] Two users cannot access each other's restricted SQL data, and neither can change their own allowance or usage counters through client requests.
- [ ] Concurrent requests cannot exceed reserved allowance; oversized streamed bodies and over-budget requests are blocked before an unintended provider call.
- [ ] The application-wide cutoff works, and failure of required authentication/quota services blocks online AI while leaving offline processing and local PDF tools usable.
- [ ] No provider key, Google client secret, or Supabase privileged key appears in the browser bundle, browser request URLs, or logs; website session credentials are not sent to AI providers.
- [ ] Included online chat and speech flows work in production mode; logout, expiry, disconnect, and cancellation release microphone and upstream resources. Deferred voice work remains explicitly tracked.
- [ ] AI data disclosure, local-file limitations, account deletion, cost monitoring, and free-tier restrictions are documented accurately.
- [ ] Focused tests, typecheck, lint, production build, and the existing PDF export verification harness pass before release; any pre-existing failures are recorded separately.
- [ ] If email/password is included, verified signup, recovery, account linking, and email rate-limit/error paths pass production-sender tests.

### Decisions Before Implementation

- Based on AI-001, confirm whether accounts and online access controls are needed at all; remove or narrow this item if they are not.
- Confirm AI-only login gating versus other online account requirements, without making offline processing depend on live authentication.
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