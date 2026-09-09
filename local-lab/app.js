const $ = (id) => document.getElementById(id);
let state;
let busy = false;
let initialized = false;
const verdicts = { reset_confirmed: "Сброс подтверждён", not_reset: "Не сброс", uncertain: "Неоднозначно" };
const eligibility = { initial_seed: "Исходная история · без уведомления", historical: "Вне окна 24 ч · без уведомления", eligible: "В окне уведомления" };
const outcomes = { seeded: "Исходная история создана", processed: "Новые твиты обработаны", no_tweets: "Нет подходящих твитов", no_new_tweets: "Нет новых твитов", locked: "Монитор занят" };
const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const date = (value) => new Date(value).toLocaleString("ru-RU");
const empty = (title, description) => `<div class="empty"><strong>${title}</strong><p>${description}</p></div>`;
function feedback(message, error = false) { $("feedback").textContent = message; $("feedback").classList.toggle("error", error); }
function countdown() {
  if (!state) return;
  $("countdown").textContent = state.running ? "Анализ…" : state.nextRunAt ? `${Math.max(0, Math.ceil((state.nextRunAt - Date.now()) / 1000))} сек` : "На паузе";
  $("timer-note").textContent = state.running && state.progress
    ? `Прошло ${Math.floor((Date.now() - state.progress.startedAt) / 1000)} сек · готово ${state.progress.completed} · твит ${state.progress.tweetId || "—"}`
    : "Таймер работает на сервере";
}
function render() {
  countdown();
  $("toggle").textContent = state.settings.enabled ? "Приостановить" : "Запустить таймер";
  $("mode-badge").textContent = state.settings.mode === "offline" ? "Офлайн · симуляция" : "OpenRouter · модель";
  $("tweet-count").textContent = state.tweets.length;
  $("alert-count").textContent = state.alerts.length;
  $("credentials").textContent = state.openRouterAvailable ? "Ключ OpenRouter настроен на сервере." : "Для OpenRouter: добавьте OPENROUTER_API_KEY в .env.lab и перезапустите сервер.";
  document.querySelector('#mode option[value="openrouter"]').disabled = !state.openRouterAvailable;
  document.querySelectorAll("button").forEach((button) => { if (!button.dataset.tab) button.disabled = busy || state.running; });
  if (!initialized) {
    $("interval").value = state.settings.intervalSeconds;
    $("mode").value = state.settings.mode;
    $("model").value = state.settings.model;
    initialized = true;
  }
  const decisions = new Map(state.monitor.recentDecisions.map((decision) => [decision.tweetId, decision]));
  $("tweets").innerHTML = [...state.tweets].reverse().map((tweet) => {
    const decision = decisions.get(tweet.id);
    return `<article class="entry"><div class="entry-head"><span class="author">@${escape(tweet.authorUsername)}${tweet.isReply ? " · ответ" : ""}</span><span class="date">${escape(date(tweet.createdAt))}</span></div><p class="tweet-text">${escape(tweet.fullText)}</p>${tweet.quotedText ? `<p class="quote">${escape(tweet.quotedText)}</p>` : ""}<div class="decision">${decision ? `<span class="verdict ${decision.verdict}">${verdicts[decision.verdict]}</span><span class="meta">Уверенность ${Math.round(decision.confidence * 100)}% · ${escape(decision.model)}</span><p>${escape(decision.rationale)}</p><span class="meta">${eligibility[decision.alertEligibility] || ""}${decision.deliveryMode === "direct" ? " · локальное уведомление записано" : ""}${decision.usage ? ` · ${decision.usage.totalTokens} токенов` : ""}</span>` : `<span class="meta">${["sama", "thsottiaux"].includes(tweet.authorUsername) ? "Ожидает анализа" : "Пропущен: автор не отслеживается"}</span>`}</div></article>`;
  }).join("") || empty("Лента готова к тесту", "Добавьте первый твит слева или выберите пример. Затем запустите анализ.");
  $("alerts").innerHTML = state.alerts.map((alert) => `<article class="entry"><div class="entry-head"><strong class="reset_confirmed">Локальное уведомление</strong><span class="date">${escape(date(alert.at))}</span></div><p class="tweet-text">${escape(alert.tweet.fullText)}</p><p class="hint">${escape(alert.classification.rationale)}</p><span class="meta">@${escape(alert.tweet.authorUsername)} · ${escape(alert.classification.model)}</span></article>`).join("") || empty("Уведомлений пока нет", "После первого прохода добавьте свежий твит о сбросе лимитов и снова запустите анализ.");
  $("runs").innerHTML = state.runs.map((run) => `<div class="run-row"><span class="date">${escape(date(run.at))}</span><strong class="${run.error ? "error" : ""}">${escape(run.error || outcomes[run.outcome?.outcome])}</strong>${run.outcome ? `<div class="meta">Обработано: ${run.outcome.processedCount}</div>` : ""}</div>`).join("") || empty("Запусков пока нет", "Запустите анализ вручную или включите таймер.");
  if (state.persistenceError) feedback(`Ошибка сохранения: ${state.persistenceError}`, true);
  else if (!state.running && state.monitor.lastError) feedback(state.monitor.lastError, true);
}
async function refresh() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error("Не удалось загрузить состояние");
    state = await response.json(); render();
  } catch (error) { feedback(`Нет связи с сервером: ${error.message}`, true); }
}
async function action(path, body, message) {
  if (busy) return false;
  busy = true; if (state) render(); feedback("Выполняется…");
  try {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Ошибка запроса");
    state = data; feedback(message); return true;
  } catch (error) { feedback(error.message, true); return false; }
  finally { busy = false; if (state) render(); }
}
$("tweet-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
  const body = Object.fromEntries(data); body.isReply = data.has("isReply");
  if (body.createdAt) body.createdAt = new Date(body.createdAt).toISOString();
  if (await action("/api/tweets", body, "Твит добавлен. Он попадёт в следующий анализ.")) { form.elements.fullText.value = ""; form.elements.quotedText.value = ""; }
});
$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const body = Object.fromEntries(new FormData(event.currentTarget)); body.intervalSeconds = Number(body.intervalSeconds);
  await action("/api/settings", body, "Настройки сохранены. Отсчёт таймера обновлён.");
});
$("run").onclick = () => action("/api/run", {}, "Анализ завершён. Результаты обновлены.");
$("toggle").onclick = () => state && action("/api/settings", { enabled: !state.settings.enabled }, state.settings.enabled ? "Таймер приостановлен." : "Таймер запущен.");
$("reset").onclick = async () => { if (confirm("Удалить все локальные твиты, решения и уведомления и сбросить настройки?")) { initialized = false; await action("/api/reset", {}, "Локальное окружение сброшено."); } };
document.querySelectorAll("[data-example]").forEach((button) => { button.onclick = () => { $("tweet-form").elements.fullText.value = { reset: "Codex rate limits have been reset for everyone.", question: "When will Codex rate limits reset?", other: "New Codex launch notes are live." }[button.dataset.example]; $("tweet-form").elements.fullText.focus(); }; });
const tabs = [...document.querySelectorAll("[data-tab]")];
tabs.forEach((button, index) => {
  button.onclick = () => tabs.forEach((tab) => { const selected = tab === button; tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; $(`${tab.dataset.tab}-panel`).hidden = !selected; });
  button.tabIndex = index ? -1 : 0;
  button.onkeydown = (event) => { if (["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length; tabs[next].click(); tabs[next].focus(); } };
});
void refresh(); setInterval(refresh, 2000); setInterval(countdown, 250);
