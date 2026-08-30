# Missed reset alert investigation and implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task. This document authorizes planning only; no implementation, deployment, or subscriber messages were performed in the investigation.

**Goal:** Ensure fresh confirmed reset announcements produce subscriber alerts even when discovered through cache backfill, with safe retries and no accidental historical broadcasts.

**Architecture:** Retain the existing Worker, KV monitor state, D1 subscriptions/delivery ledger, and Cloudflare Queue. Treat classification, alert eligibility, queue acceptance, and successful delivery as separate facts. Make normal polling and cache backfill follow the same alert eligibility policy.

**Tech stack:** TypeScript, Cloudflare Workers/KV/D1/Queues, OpenRouter, Telegram Bot API, Vitest.

**Spec:** The user's request: identify why reset status changed without a Telegram alert and plan the fix. The incident evidence and acceptance criteria below define the scope.

## Implementation result

Approved and completed on August 30, 2026:

- Deployed Worker version `23d009b8-c2ba-4bd2-bfae-f78a5906457c`.
- Added persisted alert eligibility, monotonic watermark handling, delayed/backfilled reset delivery, and pending-alert retry.
- Added explicit local-only recovery for fresh confirmed legacy decisions while preserving D1 recipient idempotency.
- Replayed `2093801758665715784:reset_confirmed` to four active subscribers. D1 records four `delivered` rows, all on attempt 1; KV records `deliveryMode: direct` and `deliveredCount: 4`.
- Added structured delivery logs and enabled Worker observability.
- Verification passed: TypeScript, 9 test files / 67 tests, bundle dry run, production deployment metadata, KV state, and D1 delivery rows.
- Remaining concern: a post-deployment manual monitor run still failed because every configured tweet source ultimately fell through to Rettiwt, which failed for both monitored accounts. This was not the cause of the already-classified incident and remains separate follow-up work.

## Constraints

- Keep application code unchanged during this investigation; implement only in a subsequent task.
- Keep existing public subscription behavior: confirmed reset announcements trigger alerts. Expiration of the 24-hour status and unrelated posts do not trigger broadcasts.
- Preserve first-run historical suppression, existing public routes, and `alert_id = tweetId:reset_confirmed`.
- Use existing dependencies and storage. Do not move this fix to another platform or add a new delivery service.
- Do not clear the watermark, erase D1 delivery rows, or toggle the saved verdict to force a resend.
- Production inspection is read-only. Resending requires explicit authorization to send subscriber messages.

## Production evidence, August 30, 2026

| Observation | Recorded value |
| --- | --- |
| Missed post | `https://x.com/thsottiaux/status/2093801758665715784` |
| Post opening | “We are reseting usage for all paid users of Codex and ChatGPT Work.” |
| Published | August 29, 20:43:34 UTC / 23:43:34 Kyiv |
| Stored decision timestamp (`alertedAt`) | August 30, 00:01:01.845 UTC / 03:01:01.845 Kyiv |
| Verdict | `reset_confirmed`, confidence `0.99` |
| Model | `nvidia/nemotron-3-ultra-550b-a55b:free` |
| Delivery mode | `cached`; no `queuedCount` or `deliveredCount` |
| Exact alert's D1 delivery rows | `0` for `2093801758665715784:reset_confirmed` |
| Active subscribers | `4`, all with subscription timestamps before this post |
| Other delivery records | `76` total; all `delivered` |
| Most recent prior delivered alert | `2091688655828246890:reset_confirmed`, delivered to four chats on August 24 at 07:01 UTC |
| Active deployed version | `8939d84f-0c1f-48b5-a646-0eeccbaca5d5`, deployed August 24 at 11:16 UTC |

The deployed version has scheduled, queue, and fetch handlers, the expected KV/D1/Queue bindings, and `PUBLIC_SUBSCRIPTIONS_ENABLED=true`.

The latest KV snapshot also reports a tweet-provider failure at August 30, 07:01:05 UTC: Rettiwt failed for both configured usernames. That later failure is an additional operational concern; it does not explain why the already classified reset was cached without delivery.

No subscriber chat IDs or credentials are included in this report. D1 confirmed `rows_written=0` and `changed_db=false` for investigation queries.

## Finding and confidence

**Confirmed failure:** Production has a fresh confirmed reset stored as cached only, with no corresponding delivery records. The classifier recognized the reset correctly. The status calculation considers that cached decision active, while the delivery path has no corresponding recorded work.

**Code mechanism:**

1. `src/state.ts:116` (`getLatestActiveReset`) derives active reset status from any confirmed decision published within the last 24 hours, regardless of delivery mode.
2. `src/monitor.ts:102` (`appendMissingCachedDecisions`) classifies missing posts and always calls `createCachedDecision`; it never dispatches a confirmed reset. `runMonitor` calls it during cache backfill at line 263.
3. Other monitor branches can route valid recent announcements into this gap: timestamp filtering at lines 288/315 drops delayed posts when a newer post exists; the historical-source-jump branch at line 290 can classify a recent post as historical because of the gap from the previous post, rather than the age of this post.
4. Cache backfill at line 267 can move the watermark backwards when a stale provider response arrives. A single watermark shared by both accounts also cannot establish that all earlier posts were actually processed.
5. `src/dashboard.ts:80` only dispatches when a verdict changes from non-confirmed to confirmed. Re-evaluating this already-confirmed, unsent post does not repair delivery. Lines 74–77 also replace previous delivery metadata with `cached` on a re-evaluation that does not dispatch.

**Evidence limit:** KV retains the latest document, not the sequence of prior watermarks or branch decisions. We did not retrieve historical execution logs. The exact path taken at 00:01 UTC is not proven. Cache/backfill suppression is a reproduced explanation matching the stored outcome, not a claim that a specific historical branch was observed. A cached marker alone is not proof of non-delivery because re-evaluation can overwrite it; the independent zero-row D1 query is important.

## Reproduction and existing coverage

The pre-fix diagnostic used real application functions with memory KV, injected classifications, and mocked Telegram requests. Its permanent cases were converted into the Vitest suites during implementation.

Verified current defects:

1. Delayed reset plus a newer unrelated post: watermark advances, reset is later cached, dispatch count remains zero.
2. Cached OpenRouter fallback: three monitor runs make only one classification call; the cached uncertain verdict is never refreshed after model recovery.
3. Recent reset after a quiet period: monitor returns `no_new_tweets` and makes no dispatch call.
4. Queue transport failure: an immediate retry encounters the active delivery claim and ACKs without another send attempt; the row is still undelivered.
5. Production post replay through cache backfill: status is active, delivery mode is cached, dispatch count is zero, and re-evaluation still sends nothing. A stale response also lowers the watermark.

Pre-fix baseline: TypeScript passed; 9 test files and 62 tests passed. Post-fix verification is recorded in the implementation result above.

## Implementation plan

### 1. Add incident acceptance tests

**Files:** `tests/monitor.test.ts`, `tests/http.test.ts`, `tests/state.test.ts`.

- [ ] Freeze time to `2026-08-30T00:02:00.000Z`; use the incident post ID/date and an already initialized monitor.
- [ ] Test a fresh missing reset whose ID is below the current watermark. Assert one queued dispatch for four recipients and no watermark regression.
- [ ] Test a delayed reset together with a newer unrelated post. Assert the reset is dispatched regardless of `lastCheckAt`.
- [ ] Test a recent reset after a >24-hour gap between authored posts. Assert the post's own age determines eligibility.
- [ ] Test that first-run seeds and posts at least 24 hours old remain suppressed on both the initial and subsequent runs.
- [ ] Test same-confirmed dashboard re-evaluation: eligible unsent alerts can recover; already queued/delivered decisions retain their metadata.

Core expectation to add using the existing `createTweet`, `createEnv`, and memory KV helpers:

```ts
vi.useFakeTimers();
vi.setSystemTime(new Date("2026-08-30T00:02:00.000Z"));
const env = createEnv();
await writeMonitorState(env.MONITOR_STATE, {
  lastSeenTweetId: "2093801838504186008",
  lastSeenTweetUrl: "https://x.com/thsottiaux/status/2093801838504186008",
  lastCheckAt: "2026-08-29T23:00:00.000Z",
  lastError: null,
  recentDecisions: [],
});
const post = {
  ...createTweet("2093801758665715784"),
  createdAt: "2026-08-29T20:43:34.000Z",
  fullText: "We are reseting usage for all paid users of Codex and ChatGPT Work.",
};
const dispatch = vi.fn(async () => ({ mode: "queued" as const, queuedCount: 4 }));
await runMonitor(env, {
  fetchTweets: async () => [post],
  classify: async () => ({ verdict: "reset_confirmed", confidence: 0.99, rationale: "Usage resets announced." }),
  dispatch,
});
expect(dispatch).toHaveBeenCalledTimes(1);
const result = await readMonitorState(env.MONITOR_STATE);
expect(result.lastSeenTweetId).toBe("2093801838504186008");
expect(result.recentDecisions.find(d => d.tweetId === post.id)).toMatchObject({ deliveryMode: "queued", queuedCount: 4 });
vi.useRealTimers();
```

Use `afterEach(vi.useRealTimers)` in the implemented suite so assertion failures cannot leak the fake clock. Run the new cases first and confirm they fail on existing code.

### 2. Centralize fresh-post eligibility and keep progress monotonic

**Files:** `src/monitor.ts`, `src/state.ts`, `src/types.ts`; tests from step 1.

- [ ] Add optional persisted `alertEligibility: "eligible" | "initial_seed" | "historical"` to `MonitorDecision` and its normalization. Missing fields on legacy KV must remain distinguishable from an explicit suppression.
- [ ] Use a single freshness predicate matching status semantics: valid publication timestamp, not in the future, and `0 <= now - publishedAt < 24 hours`.
- [ ] On initialization, mark all seeded decisions `initial_seed`; keep that marker on subsequent polls and re-evaluations. This prevents a reconciliation loop from broadcasting seeded history one hour later.
- [ ] For an initialized monitor, process missing/retryable decisions even when their IDs are below the watermark. Fresh newly discovered posts become `eligible`; expired posts become `historical`.
- [ ] Remove `lastCheckAt` as a delivery gate and stop using the gap between post IDs/timestamps as proof that a recent post is historical.
- [ ] Keep the watermark equal to the maximum of its existing valid value and observed tweet IDs. Do not lower it while caching stale responses. Preserve explicit invalid-watermark recovery behavior.
- [ ] Dispatch fresh confirmed eligible decisions through the same path from normal polling and cache backfill, and persist the actual dispatch result.

Proposed helper contracts, to be implemented and covered by step 1:

```ts
type AlertEligibility = "eligible" | "initial_seed" | "historical";
const isFreshResetPost = (tweet: Tweet, now: number): boolean => {
  const publishedAt = Date.parse(tweet.createdAt);
  return Number.isFinite(publishedAt) && publishedAt <= now && now - publishedAt < 86_400_000;
};
```

Reuse `compareTweetIds` for watermark updates. Do not widen the provider lookback, change the model, or introduce per-account storage migrations as part of this step.

### 3. Keep delivery retryable independently of classification

**Files:** `src/monitor.ts`, `src/state.ts`, `src/types.ts`, `tests/monitor.test.ts`.

- [ ] Save a fresh confirmed eligible decision before dispatch; `deliveryMode: "cached"` plus `alertEligibility: "eligible"` represents pending dispatch, not successful delivery.
- [ ] At the beginning of subsequent monitor runs, reconcile persisted eligible confirmed decisions still lacking successful dispatch metadata, before depending on another provider fetch. A transient provider failure must not prevent retrying an already known alert.
- [ ] After queue acceptance, persist `deliveryMode: "queued"` and recipient count. Record queued-zero distinctly; do not repeatedly broadcast an old event to people who subscribe later.
- [ ] On dispatch failure, retain the eligible decision and record the error. On an uncertain enqueue/KV-write outcome, reuse the same alert ID so the existing D1 recipient ledger suppresses completed deliveries.
- [ ] Do not automatically replay legacy `cached` decisions without eligibility metadata: they may be intentional seeds or previous deliveries with overwritten metadata. Handle this incident explicitly in step 6.
- [ ] Add tests for dispatch rejection, provider failure after a pending decision exists, repeated polls, zero active subscribers, expiration while pending, and successful enqueue followed by KV write failure.

Acceptance: no eligible fresh confirmed decision can become permanently invisible solely because the global watermark advanced.

### 4. Preserve delivery history and enable explicit recovery

**Files:** `src/dashboard.ts`, `tests/http.test.ts`; reuse existing `dispatchSubscriberAlertNow` and `getAlertId`.

- [ ] Preserve `deliveryMode`, counts, delivery timestamp, and `alertEligibility` when re-evaluation does not send. Add a separate decision-evaluation timestamp if needed rather than erasing evidence.
- [ ] Extend the existing local re-evaluation operation to recover an eligible fresh confirmed unsent decision even if its verdict was already confirmed. Keep historical/seeded decisions suppressed and already dispatched decisions idempotent.
- [ ] For legacy cached decisions, allow recovery only through an explicit operator selection and an explicit replay flag in the existing request body; never infer replay authorization from routine re-evaluation. Validate that flag is a boolean, require a fresh confirmed result, and show the recipient count before the operator acts.
- [ ] D1, not a mutable KV label, must decide whether an individual chat already received `tweetId:reset_confirmed`.
- [ ] Keep the existing local-host restriction. Do not add an unauthenticated public broadcast route.
- [ ] Test same-verdict recovery, re-evaluation after prior delivery, blocked stale recovery, and partial success followed by retry.

### 5. Add focused observability and validate the bundle

**Files:** `src/monitor.ts`, `src/delivery-queue.ts`, `wrangler.toml`, `README.md`; affected tests.

- [ ] Emit structured events with tweet/alert ID, decision origin, eligibility/suppression reason, queue acceptance, and aggregate delivered/retryable/permanent-failure counts. Do not log bot tokens or raw subscriber chat IDs.
- [ ] Log queue consumer exceptions before retry instead of silently catching them. Configure Workers observability with an explicit retention/sampling decision; verify current configuration support against the installed schema.
- [ ] Document that status means a fresh confirmed reset exists; queued count is not delivered count. Explain the recovery operation and its authorization boundary.
- [ ] Run the targeted suites, full check, and bundle dry run:

```sh
npm test -- tests/monitor.test.ts tests/http.test.ts tests/state.test.ts tests/delivery-queue.test.ts
npm run check
WRANGLER_LOG_PATH=/tmp/codexlimit-plan-validation.log node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/codexlimit-plan-validation-dist
```

There is no lint script in the current package; do not claim lint passed. Cloudflare command reference: https://developers.cloudflare.com/workers/wrangler/commands/

### 6. Recover this incident only after authorization

- [ ] Re-read the specific decision, active subscriber count, and D1 delivery rows immediately before recovery. Do not assume the August 30 snapshot is still current.
- [ ] If authorized while the announcement is still fresh, replay only `2093801758665715784:reset_confirmed` to currently active subscribers, preserving completed recipient records. The observed snapshot has four active subscribers and zero deliveries.
- [ ] If recovery occurs at or after August 30, 20:43:34 UTC, the normal 24-hour active window has expired. Do not send the normal “retry now” alert as if it were current; require a separately approved historical notification or skip replay.
- [ ] Verify successful deliveries in D1; reconcile failures without deleting claims or history. Run recovery again against mocks to prove already delivered recipients are skipped, not by sending a second live broadcast.
- [ ] Deploy only when subsequently authorized. Do not invoke `/run` during this planning task: it can enqueue real subscriber messages.

Read-only verification query:

```sh
node_modules/.bin/wrangler d1 execute codex-limit-telegram-subscriptions --remote --command "SELECT status, COUNT(*) AS count FROM telegram_deliveries WHERE alert_id = '2093801758665715784:reset_confirmed' GROUP BY status;" --json
```

### 7. Verify the next real event and record completion

- [ ] For the next authorized live validation, verify the entire chain: decision eligible, queue accepted, then delivery ledger terminal outcomes for intended recipients.
- [ ] Verify cache/backfill detection and re-evaluation through mocks without sending extra live messages.
- [ ] Confirm first-run seeding, stale posts, repeated polls, and status expiration cause no unintended broadcasts.
- [ ] Report exact deployed version and D1 totals. A green `/health` response alone is not sufficient evidence of delivery.

## Separate findings, not established causes of this incident

- **Fallback refresh is broken:** `shouldRefreshCachedDecision` permits refresh but `appendMissingCachedDecisions` skips every existing ID. A future fix should persist retry provenance and original tweet context, refresh pending fallback verdicts even after newer posts arrive, and reuse the eligibility/delivery logic above. This incident used a successful 99% model verdict, so changing the model does not address it.
- **Queue claim can lose retries:** `claimDelivery` returns the same `false` for already-delivered work and a still-active claim. A transport exception leaves the claim alive; a quick retry then skips it and ACKs. A separate delivery-hardening change should return `claimed`, `complete`, or `busy`, use conditional atomic reclaim SQL, retry busy work after lease expiry, and release claims on transport errors. Test against real local D1 semantics and do not promise exactly-once delivery across Telegram success followed by a D1 failure.
- **Provider partial/stale responses:** the first nonempty provider result can omit one account or newer posts. Current failure logs confirm fragility but not the exact provider response during this incident. Preserve per-account source/error evidence before considering broader provider changes.
- **KV coordination:** the lock uses non-atomic KV reads/writes; do not claim globally exactly-once polling. Existing D1 delivery IDs reduce duplicate sends but are not a general solution to external-send crash windows.

These deserve follow-up work, but should not obscure the confirmed status/delivery gap or turn its fix into a broad rewrite.

## Acceptance criteria

- Fresh confirmed announcements discovered after initialization dispatch to eligible subscribers, including late/backfilled posts below the watermark.
- The incident fixture changes status to active and enqueues four recipients; repeated polls do not enqueue again once acceptance is saved.
- Watermarks do not regress because a provider returns older data.
- First-run and expired history remain suppressed across subsequent polls and re-evaluation.
- A pending confirmed decision survives transient dispatch/provider failure and can be retried while fresh.
- Re-evaluation preserves delivery evidence and explicit recovery respects the D1 recipient ledger.
- All current and new tests pass, TypeScript passes, and the Worker bundles successfully.
- No production messages, configuration changes, or deployments occur as part of investigation/planning.
