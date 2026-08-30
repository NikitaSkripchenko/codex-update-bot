import { classifyTweet, isOpenRouterFallbackRationale } from "./classifier";
import { dispatchAlert, dispatchSubscriberAlertNow } from "./delivery-queue";
import { getEnvString, isPublicSubscriptionsEnabled, jsonResponse } from "./env";
import { appendRecentDecision, patchMonitorState, readMonitorState } from "./state";
import { getSubscriptionStats } from "./subscriptions";
import type { Classification, DispatchResult, Env, MonitorDecision, MonitorState, Tweet } from "./types";

const escapeHtml = (value: string | null | undefined): string =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatDate = (value: string | null): string => {
  if (!value) {
    return "Not recorded";
  }

  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium" })
    : value;
};

const formatVerdict = (verdict: MonitorDecision["verdict"]): string =>
  ({ reset_confirmed: "Reset confirmed", not_reset: "Not reset", uncertain: "Uncertain" })[verdict];

const formatDelivery = (decision: MonitorDecision): string => {
  if (decision.deliveryMode === "direct") {
    return `Delivered${decision.deliveredCount === undefined ? "" : ` to ${decision.deliveredCount}`}`;
  }

  if (decision.deliveryMode === "queued") {
    return `Queued${decision.queuedCount === undefined ? "" : ` for ${decision.queuedCount}`}`;
  }

  return "Cached only";
};

const getAuthorUsername = (tweetUrl: string): string => {
  try {
    return new URL(tweetUrl).pathname.split("/").filter(Boolean)[0] || "unknown";
  } catch {
    return "unknown";
  }
};

const decisionToTweet = (decision: MonitorDecision): Tweet => ({
  id: decision.tweetId,
  url: decision.tweetUrl,
  createdAt: decision.tweetCreatedAt,
  fullText: decision.tweetText || "",
  authorUsername: getAuthorUsername(decision.tweetUrl),
  isReply: false,
  isRetweet: false,
});

const createReevaluatedDecision = (
  decision: MonitorDecision,
  classification: Classification,
  dispatchResult: DispatchResult | null,
): MonitorDecision => ({
  tweetId: decision.tweetId,
  tweetUrl: decision.tweetUrl,
  tweetCreatedAt: decision.tweetCreatedAt,
  tweetText: decision.tweetText,
  verdict: classification.verdict,
  confidence: classification.confidence,
  rationale: classification.rationale,
  model: classification.model,
  usage: classification.usage,
  alertedAt: new Date().toISOString(),
  deliveryMode: dispatchResult?.mode || decision.deliveryMode,
  deliveredCount: dispatchResult?.mode === "direct" ? dispatchResult.deliveredCount : decision.deliveredCount,
  queuedCount: dispatchResult?.mode === "queued" ? dispatchResult.queuedCount : decision.queuedCount,
  alertEligibility: dispatchResult ? "eligible" : decision.alertEligibility,
});

const isResetTransition = (previous: MonitorDecision, next: Classification): boolean =>
  previous.verdict !== "reset_confirmed" && next.verdict === "reset_confirmed";

const isFreshDecision = (decision: MonitorDecision): boolean => {
  const publishedAt = new Date(decision.tweetCreatedAt).valueOf();
  const ageMs = Date.now() - publishedAt;
  return Number.isFinite(publishedAt) && ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000;
};

export type DashboardDeps = {
  classify?: (env: Env, tweet: Tweet) => Promise<Classification>;
  dispatch?: (env: Env, tweet: Tweet, classification: Classification) => Promise<DispatchResult>;
};

export const getDashboardData = async (env: Env): Promise<{
  state: MonitorState;
  model: string;
  source: string;
  subscribers: number;
}> => {
  const [state, subscriptionStats] = await Promise.all([readMonitorState(env.MONITOR_STATE), getSubscriptionStats(env)]);

  return {
    state,
    model: getEnvString(env.OPENROUTER_MODEL, "default OpenRouter model"),
    source: "Cloudflare KV binding: MONITOR_STATE",
    subscribers: subscriptionStats.active,
  };
};

export const dashboardJsonResponse = async (env: Env): Promise<Response> => jsonResponse(await getDashboardData(env));

export const dashboardReevaluateResponse = async (request: Request, env: Env, deps: DashboardDeps = {}): Promise<Response> => {
  if (!getEnvString(env.OPENROUTER_API_KEY)) {
    return jsonResponse({ ok: false, error: "OPENROUTER_API_KEY is required to re-evaluate locally." }, { status: 400 });
  }

  const state = await readMonitorState(env.MONITOR_STATE);
  const body = await request.json().catch(() => null) as { tweetId?: unknown; replayConfirmed?: unknown } | null;
  const tweetId = typeof body?.tweetId === "string" ? body.tweetId : "";
  const replayConfirmed = body?.replayConfirmed === true;

  if (body?.replayConfirmed !== undefined && typeof body.replayConfirmed !== "boolean") {
    return jsonResponse({ ok: false, error: "replayConfirmed must be a boolean." }, { status: 400 });
  }

  if (!tweetId) {
    return jsonResponse({ ok: false, error: "Select a cached tweet to re-evaluate." }, { status: 400 });
  }

  const latestDecision = state.recentDecisions.find((decision) => decision.tweetId === tweetId);

  if (!latestDecision) {
    return jsonResponse({ ok: false, error: "The selected cached decision no longer exists." }, { status: 404 });
  }

  if (!latestDecision.tweetText) {
    return jsonResponse(
      { ok: false, error: "The selected cached decision has no tweet text and cannot be re-evaluated." },
      { status: 400 },
    );
  }

  const tweet = decisionToTweet(latestDecision);
  const classification = await (deps.classify || classifyTweet)(env, tweet);

  if (isOpenRouterFallbackRationale(classification.rationale)) {
    return jsonResponse(
      {
        ok: false,
        error: `Re-evaluation was not saved because ${classification.rationale}`,
      },
      { status: 503 },
    );
  }

  if (replayConfirmed) {
    if (latestDecision.verdict !== "reset_confirmed" || classification.verdict !== "reset_confirmed") {
      return jsonResponse({ ok: false, error: "Only a confirmed reset decision can be replayed." }, { status: 409 });
    }

    if (latestDecision.alertEligibility === "initial_seed" || latestDecision.alertEligibility === "historical" || !isFreshDecision(latestDecision)) {
      return jsonResponse({ ok: false, error: "This reset is no longer eligible for a subscriber alert." }, { status: 409 });
    }
  }

  const dispatch = deps.dispatch || (isPublicSubscriptionsEnabled(env) ? dispatchSubscriberAlertNow : dispatchAlert);
  const shouldDispatch =
    isFreshDecision(latestDecision) &&
    (isResetTransition(latestDecision, classification) ||
      (replayConfirmed && latestDecision.deliveryMode === "cached"));
  const dispatchResult = shouldDispatch
    ? await dispatch(env, tweet, classification)
    : null;
  const updatedDecision = createReevaluatedDecision(latestDecision, classification, dispatchResult);
  const updatedState = await patchMonitorState(env.MONITOR_STATE, (current) => ({
    ...current,
    recentDecisions: appendRecentDecision(current, updatedDecision, Math.max(current.recentDecisions.length, 1)).recentDecisions,
  }));

  return jsonResponse({ ok: true, replayed: Boolean(replayConfirmed && dispatchResult), decision: updatedState.recentDecisions[0] });
};

const renderLatestDecision = (decision: MonitorDecision | undefined): string => {
  if (!decision) {
    return `<section class="latest empty"><p>No cached decisions yet.</p><span>Run the monitor to populate the Cloudflare KV record.</span></section>`;
  }

  const usage = decision.usage
    ? `${decision.usage.inputTokens} input / ${decision.usage.outputTokens} output / ${decision.usage.totalTokens} total tokens`
    : "Token usage not recorded";
  const recheckDisabled = decision.tweetText ? "" : "disabled";
  const recheckHelp = decision.tweetText ? "" : " title=\"Tweet text was not saved for this decision\"";

  return `<section class="latest">
    <div class="latest-heading">
      <div><span class="eyebrow">Latest decision</span><h2>${escapeHtml(formatVerdict(decision.verdict))}</h2></div>
      <span class="verdict ${escapeHtml(decision.verdict)}">${escapeHtml(Math.round(decision.confidence * 100).toString())}% confidence</span>
    </div>
    <p class="tweet">${escapeHtml(decision.tweetText || "Tweet text was not cached.")}</p>
    <p class="rationale">${escapeHtml(decision.rationale)}</p>
    <dl class="facts">
      <div><dt>Tweet</dt><dd><a href="${escapeHtml(decision.tweetUrl)}" target="_blank" rel="noopener noreferrer">Open on X</a></dd></div>
      <div><dt>Classified</dt><dd>${escapeHtml(formatDate(decision.alertedAt))}</dd></div>
      <div><dt>Model</dt><dd>${escapeHtml(decision.model || "Not recorded")}</dd></div>
      <div><dt>Usage</dt><dd>${escapeHtml(usage)}</dd></div>
    </dl>
    <button type="button" data-reevaluate-tweet-id="${escapeHtml(decision.tweetId)}" ${recheckDisabled}${recheckHelp}>Re-evaluate this decision</button>
    <p id="action-result" class="action-result" role="status" aria-live="polite"></p>
  </section>`;
};

const renderDecisionRows = (decisions: MonitorDecision[]): string => {
  if (decisions.length === 0) {
    return `<tr><td colspan="6" class="no-data">Cloudflare KV has no cached decisions.</td></tr>`;
  }

  return decisions
    .map(
      (decision) => {
        const canReevaluate = Boolean(decision.tweetText);
        const action = canReevaluate
          ? `<button type="button" class="table-action" data-reevaluate-tweet-id="${escapeHtml(decision.tweetId)}">Re-evaluate</button>`
          : `<button type="button" class="table-action" disabled title="Tweet text was not saved for this decision">Unavailable</button>`;

        return `<tr>
        <td><span class="table-verdict ${escapeHtml(decision.verdict)}">${escapeHtml(formatVerdict(decision.verdict))}</span></td>
        <td class="tweet-cell">${escapeHtml(decision.tweetText || "Tweet text was not cached.")}</td>
        <td>${escapeHtml(Math.round(decision.confidence * 100).toString())}%</td>
        <td>${escapeHtml(formatDelivery(decision))}</td>
        <td><a href="${escapeHtml(decision.tweetUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(formatDate(decision.tweetCreatedAt))}</a></td>
        <td>${action}</td>
      </tr>`;
      },
    )
    .join("");
};

export const dashboardHtmlResponse = async (env: Env): Promise<Response> => {
  const { state, model, source, subscribers } = await getDashboardData(env);
  const rawState = JSON.stringify(state, null, 2);
  const status = state.lastError ? "Attention needed" : "Healthy";
  const statusClass = state.lastError ? "error" : "healthy";

  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="120">
  <title>Cloudflare Monitor Data</title>
  <style>
    :root { color-scheme: light; --ink: #172330; --muted: #607080; --line: #d6e0e7; --paper: #f7f9f9; --panel: #fff; --blue: #005a8b; --teal: #007d78; --orange: #c74d16; --red: #b42318; }
    * { box-sizing: border-box; }
    body { background: var(--paper); color: var(--ink); font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 0; }
    main { margin: 0 auto; max-width: 1440px; padding: 28px; }
    header { align-items: end; border-bottom: 3px solid var(--ink); display: flex; gap: 24px; justify-content: space-between; padding-bottom: 20px; }
    h1, h2, p { margin: 0; } h1, h2 { font-family: Arial, Helvetica, sans-serif; letter-spacing: -0.045em; }
    h1 { font-size: clamp(2.3rem, 6vw, 4.5rem); line-height: .92; } h1 em { color: var(--blue); font-style: normal; }
    h2 { font-size: clamp(1.65rem, 3vw, 2.6rem); } .kicker, .eyebrow { color: var(--muted); font-size: .75rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    .source { color: var(--muted); max-width: 390px; text-align: right; } .source strong { color: var(--ink); display: block; }
    .summary { display: grid; gap: 1px; grid-template-columns: repeat(5, 1fr); margin: 24px 0; background: var(--line); border: 1px solid var(--line); }
    .stat { background: var(--panel); min-height: 116px; padding: 17px; } .stat dt { color: var(--muted); font-size: .72rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; } .stat dd { font-family: Arial, Helvetica, sans-serif; font-size: 1.1rem; font-weight: 700; letter-spacing: -.025em; margin: 12px 0 0; overflow-wrap: anywhere; }
    .healthy { color: var(--teal); } .error { color: var(--red); }
    .latest { background: var(--panel); border: 1px solid var(--line); border-left: 6px solid var(--blue); padding: clamp(20px, 4vw, 38px); } .latest.empty { border-left-color: var(--orange); }
    .latest-heading { align-items: center; display: flex; gap: 18px; justify-content: space-between; } .verdict, .table-verdict { border: 1px solid currentColor; color: var(--muted); display: inline-block; font-size: .76rem; font-weight: 800; padding: 5px 7px; text-transform: uppercase; white-space: nowrap; }
    .reset_confirmed { color: var(--teal); } .uncertain { color: var(--orange); } .not_reset { color: var(--muted); }
    .tweet { font-family: Arial, Helvetica, sans-serif; font-size: clamp(1.15rem, 2.2vw, 1.65rem); line-height: 1.3; margin: 28px 0 14px; max-width: 1000px; white-space: pre-wrap; } .rationale { border-left: 2px solid var(--line); color: #3f4f5e; padding-left: 14px; }
    .facts { border-top: 1px solid var(--line); display: grid; gap: 12px; grid-template-columns: repeat(4, 1fr); margin: 30px 0 22px; padding-top: 16px; } .facts div { min-width: 0; } .facts dt { color: var(--muted); font-size: .7rem; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; } .facts dd { margin: 5px 0 0; overflow-wrap: anywhere; }
    a { color: var(--blue); } button { background: var(--ink); border: 0; color: #fff; cursor: pointer; font: inherit; font-weight: 800; padding: 12px 15px; } button:hover { background: var(--blue); } button:disabled { background: #9caab3; cursor: not-allowed; } .table-action { font-size: .76rem; padding: 7px 9px; } .action-result { color: var(--muted); margin-top: 12px; min-height: 1.5em; } .action-result.error { color: var(--red); }
    .section-heading { align-items: baseline; display: flex; gap: 16px; justify-content: space-between; margin: 44px 0 12px; } .section-heading h2 { font-size: 1.55rem; } .section-heading span { color: var(--muted); font-size: .8rem; }
    .table-wrap { background: var(--panel); border: 1px solid var(--line); overflow-x: auto; } table { border-collapse: collapse; min-width: 900px; width: 100%; } th { background: #edf2f4; color: var(--muted); font-size: .7rem; letter-spacing: .1em; text-align: left; text-transform: uppercase; } th, td { border-bottom: 1px solid var(--line); padding: 13px 14px; vertical-align: top; } tr:last-child td { border-bottom: 0; } .tweet-cell { max-width: 640px; white-space: pre-wrap; } .no-data { color: var(--muted); text-align: center; }
    details { background: var(--ink); color: #deebee; margin-top: 24px; padding: 16px; } summary { cursor: pointer; font-weight: 800; } pre { font-size: .78rem; overflow: auto; white-space: pre-wrap; word-break: break-word; }
    @media (max-width: 820px) { main { padding: 18px; } header { align-items: flex-start; flex-direction: column; } .source { text-align: left; } .summary { grid-template-columns: repeat(2, 1fr); } .facts { grid-template-columns: 1fr 1fr; } .latest-heading { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div><p class="kicker">Local-only monitor inspector</p><h1>Cloudflare<br><em>data view</em></h1></div>
      <p class="source"><strong>${escapeHtml(source)}</strong>Rendered by the local Wrangler development server. The deployed Worker does not serve this route.</p>
    </header>
    <section class="summary" aria-label="Cloudflare monitor summary">
      <dl class="stat"><dt>Monitor status</dt><dd class="${statusClass}">${escapeHtml(status)}</dd></dl>
      <dl class="stat"><dt>Active subscribers</dt><dd>${escapeHtml(subscribers.toString())}</dd></dl>
      <dl class="stat"><dt>Cached decisions</dt><dd>${escapeHtml(state.recentDecisions.length.toString())}</dd></dl>
      <dl class="stat"><dt>Last KV update</dt><dd>${escapeHtml(formatDate(state.lastCheckAt))}</dd></dl>
      <dl class="stat"><dt>Configured model</dt><dd>${escapeHtml(model)}</dd></dl>
    </section>
    ${state.lastError ? `<p class="error">Latest monitor error: ${escapeHtml(state.lastError)}</p>` : ""}
    ${renderLatestDecision(state.recentDecisions[0])}
    <section>
      <div class="section-heading"><h2>Cached decision log</h2><span>${escapeHtml(state.recentDecisions.length.toString())} records in MONITOR_STATE</span></div>
      <div class="table-wrap"><table><thead><tr><th>Verdict</th><th>Tweet</th><th>Confidence</th><th>Delivery</th><th>Tweeted</th><th>Action</th></tr></thead><tbody>${renderDecisionRows(state.recentDecisions)}</tbody></table></div>
    </section>
    <details><summary>Inspect raw Cloudflare KV state</summary><pre>${escapeHtml(rawState)}</pre></details>
  </main>
  <script>
    const result = document.getElementById("action-result");
    document.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-reevaluate-tweet-id]");
      if (!button) return;
      const buttons = document.querySelectorAll("button[data-reevaluate-tweet-id]");
      buttons.forEach((control) => control.disabled = true);
      result.classList.remove("error");
      result.textContent = "Re-evaluating the selected cached tweet. Subscribers are notified only if it changes to reset confirmed.";
      try {
        const response = await fetch("/dashboard/re-evaluate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tweetId: button.dataset.reevaluateTweetId }) });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Re-evaluation failed.");
        result.textContent = "Re-evaluation saved to Cloudflare KV. Refreshing...";
        window.setTimeout(() => window.location.reload(), 550);
      } catch (error) {
        result.classList.add("error");
        result.textContent = error instanceof Error ? error.message : "Re-evaluation failed.";
        buttons.forEach((control) => control.disabled = false);
      }
    });
  </script>
</body>
</html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
};
