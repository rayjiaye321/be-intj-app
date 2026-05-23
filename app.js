const STORAGE_KEY = "intj-knowledge-cards-v1";

const elements = {
  lockScreen: document.getElementById("lockScreen"),
  lockForm: document.getElementById("lockForm"),
  passwordInput: document.getElementById("passwordInput"),
  lockHint: document.getElementById("lockHint"),
  appShell: document.getElementById("appShell"),
  navTiles: [...document.querySelectorAll(".nav-tile")],
  viewPanels: [...document.querySelectorAll("[data-view-panel]")],
  form: document.getElementById("importForm"),
  sourceUrl: document.getElementById("sourceUrl"),
  sourceType: document.getElementById("sourceType"),
  rawText: document.getElementById("rawText"),
  kimiApiKey: document.getElementById("kimiApiKey"),
  kimiBaseUrl: document.getElementById("kimiBaseUrl"),
  kimiModel: document.getElementById("kimiModel"),
  kimiStatus: document.getElementById("kimiStatus"),
  saveKimiBtn: document.getElementById("saveKimiBtn"),
  testKimiBtn: document.getElementById("testKimiBtn"),
  clearKimiBtn: document.getElementById("clearKimiBtn"),
  pasteBtn: document.getElementById("pasteBtn"),
  demoBtn: document.getElementById("demoBtn"),
  coreKnowledge: document.getElementById("coreKnowledge"),
  caseText: document.getElementById("caseText"),
  category: document.getElementById("category"),
  categoryList: document.getElementById("categoryList"),
  extractBtn: document.getElementById("extractBtn"),
  extractTextBtn: document.getElementById("extractTextBtn"),
  autoSaveBtn: document.getElementById("autoSaveBtn"),
  clearDraftBtn: document.getElementById("clearDraftBtn"),
  cancelEditBtn: document.getElementById("cancelEditBtn"),
  importHint: document.getElementById("importHint"),
  searchInput: document.getElementById("searchInput"),
  categoryFilter: document.getElementById("categoryFilter"),
  resetFilterBtn: document.getElementById("resetFilterBtn"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  clearAllBtn: document.getElementById("clearAllBtn"),
  cardsList: document.getElementById("cardsList"),
  organizeCardsList: document.getElementById("organizeCardsList"),
  emptyState: document.getElementById("emptyState"),
  organizeEmptyState: document.getElementById("organizeEmptyState"),
  cardCount: document.getElementById("cardCount"),
  networkBadge: document.getElementById("networkBadge"),
  saveBtn: document.getElementById("saveBtn"),
  toast: document.getElementById("toast"),
};

let state = {
  cards: [],
  editingId: null,
  filters: {
    query: "",
    category: "",
  },
  activeView: "new",
};

let toastTimer = null;
const backupFileInput = document.createElement("input");
backupFileInput.type = "file";
backupFileInput.accept = "application/json";
backupFileInput.hidden = true;
document.body.appendChild(backupFileInput);

function uid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `card-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2200);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function unlockApp() {
  elements.lockScreen.classList.add("locked");
  elements.appShell.classList.remove("locked");
  elements.appShell.removeAttribute("aria-hidden");
  await refreshServerStatus();
  switchView("new");
}

async function handlePasswordSubmit(event) {
  event.preventDefault();
  const value = elements.passwordInput.value.trim();
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: value }),
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new Error(payload.error || "登录失败");
    await unlockApp();
  } catch (error) {
    elements.passwordInput.value = "";
    elements.lockHint.textContent = error.message || "密码错误。";
    showToast(error.message || "密码错误");
  }
}

function switchView(view) {
  state.activeView = view;
  elements.navTiles.forEach((tile) => tile.classList.toggle("active", tile.dataset.view === view));
  elements.viewPanels.forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === view));
  if (view !== "settings") elements.kimiApiKey.value = "";
  if (view === "search") renderSearchCards();
  if (view === "organize") renderOrganizeCards();
}

function loadCards() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isUsableCard).map(normalizeCard) : [];
  } catch {
    return [];
  }
}

function persistCards() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.cards));
}

function isUsableCard(card) {
  return Boolean(card?.coreKnowledge && card?.caseText && card?.category);
}

function normalizeCard(card) {
  const now = new Date().toISOString();
  return {
    id: card.id || uid(),
    sourceUrl: card.sourceUrl || "",
    sourceType: card.sourceType || "text",
    rawText: card.rawText || "",
    coreKnowledge: String(card.coreKnowledge || "").trim(),
    caseText: String(card.caseText || "").trim(),
    category: String(card.category || "其他").trim() || "其他",
    cleanedText: card.cleanedText || card.coreKnowledge || "",
    createdAt: card.createdAt || now,
    updatedAt: card.updatedAt || now,
  };
}

async function refreshServerStatus() {
  const response = await fetch("/api/auth/status");
  const payload = await readJsonResponse(response);
  if (!response.ok) return;
  elements.kimiApiKey.value = "";
  elements.kimiBaseUrl.value = payload.kimiBaseUrl || "";
  elements.kimiModel.value = payload.kimiModel || "";
  elements.kimiStatus.textContent = payload.kimiConfigured
    ? `Kimi 已配置：${payload.kimiModel}，${payload.kimiBaseUrl}`
    : "Kimi 未配置：请填写后保存到服务器";
}

function detectSourceType(sourceUrl, rawText = "") {
  const selected = elements.sourceType.value;
  if (selected && selected !== "auto") return selected;
  if (sourceUrl) return "page";
  if (rawText) return "text";
  return "text";
}

function normalizeBackendSourceType(type) {
  if (type === "page" || type === "text") return type;
  return "text";
}

async function readJsonResponse(response) {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`服务器返回了不可解析内容：${raw.slice(0, 120) || response.status}`);
  }
}

function formatMs(ms = 0) {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTiming(timing) {
  if (!timing?.steps?.length) return "";
  const steps = timing.steps.map((step) => `${step.name}${step.ok === false ? "失败" : ""} ${formatMs(step.ms)}`).join(" / ");
  return `耗时：${steps} / total ${formatMs(timing.totalMs)}`;
}

function formatFailureDetail(payload, fallbackMessage) {
  const parts = [payload?.error || fallbackMessage].filter(Boolean);
  const timingText = formatTiming(payload?.timing);
  if (timingText) parts.push(timingText);
  const failedStep = payload?.timing?.steps?.find((step) => step.ok === false);
  if (failedStep?.error && failedStep.error !== payload?.error) parts.push(`失败阶段：${failedStep.name}，${failedStep.error}`);
  return parts.join("；");
}

function normalizeFetchError(error, fallbackMessage) {
  if (error instanceof TypeError && /fetch/i.test(error.message || "")) {
    return new Error(`${fallbackMessage}：浏览器没有连到服务器。请检查手机网络、服务器是否在线、页面是否仍是 http://43.139.101.97。`);
  }
  return error;
}

async function fetchReadableText(url) {
  let startResponse;
  try {
    startResponse = await fetch("/api/extract/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
  } catch (error) {
    throw normalizeFetchError(error, "无法启动链接提取任务");
  }
  const startPayload = await readJsonResponse(startResponse);
  if (!startResponse.ok) throw new Error(formatFailureDetail(startPayload, "无法启动链接提取任务"));
  if (!startPayload.jobId) throw new Error("链接提取任务没有返回任务编号");

  const startedAt = Date.now();
  while (Date.now() - startedAt < 20 * 60 * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    let statusResponse;
    try {
      statusResponse = await fetch(`/api/jobs/${encodeURIComponent(startPayload.jobId)}`);
    } catch (error) {
      throw normalizeFetchError(error, "无法读取链接提取进度");
    }
    const statusPayload = await readJsonResponse(statusResponse);
    if (!statusResponse.ok) throw new Error(formatFailureDetail(statusPayload, "无法读取任务状态"));
    if (statusPayload.message) {
      elements.importHint.textContent = `${statusPayload.message}，已等待 ${formatMs(Date.now() - startedAt)}`;
    }
    if (statusPayload.status === "done") {
      const result = statusPayload.result;
      if (!result?.text) throw new Error("链接没有返回可提炼的正文");
      return {
        ...result,
        sourceType: normalizeBackendSourceType(result.sourceType),
      };
    }
    if (statusPayload.status === "error") {
      throw new Error(formatFailureDetail(statusPayload, "链接提取失败"));
    }
  }

  throw new Error("链接提取超时");
}

async function refineWithKimi(sourceText, sourceUrl, sourceType, metadata = {}) {
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch("/api/kimi/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceText,
        sourceUrl,
        sourceType,
        transcriptMeta: metadata.transcriptMeta || null,
      }),
    });
  } catch (error) {
    throw normalizeFetchError(error, "无法调用 Kimi 提炼接口");
  }
  const payload = await readJsonResponse(response);
  if (!response.ok) throw new Error(formatFailureDetail(payload, "Kimi 不可用或调用失败"));
  if (!isUsableCard(payload.card)) throw new Error("Kimi 返回内容缺少卡片字段");
  return {
    ...normalizeCard(payload.card),
    timing: {
      kimiRefineMs: Date.now() - startedAt,
      serverTiming: payload.timing || null,
      serverUsage: payload.usage || null,
    },
  };
}

async function testKimiConnection() {
  elements.testKimiBtn.disabled = true;
  elements.testKimiBtn.textContent = "测试中...";
  try {
    const response = await fetch("/api/kimi/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw new Error(payload.error || "连接失败");
    showToast("服务器 Kimi 连接正常");
  } catch (error) {
    showToast(error.message || "Kimi 连接失败");
  } finally {
    await refreshServerStatus();
    elements.testKimiBtn.disabled = false;
    elements.testKimiBtn.textContent = "测试连接";
  }
}

async function saveKimiSettings(clearKey = false) {
  const payload = {
    kimiBaseUrl: elements.kimiBaseUrl.value.trim(),
    kimiModel: elements.kimiModel.value.trim(),
  };
  if (clearKey) {
    payload.clearKimiApiKey = true;
  } else if (elements.kimiApiKey.value.trim()) {
    payload.kimiApiKey = elements.kimiApiKey.value.trim();
  }

  const response = await fetch("/api/settings/kimi", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await readJsonResponse(response);
  if (!response.ok) throw new Error(data.error || "保存失败");
  elements.kimiApiKey.value = "";
  await refreshServerStatus();
  showToast("Kimi 配置已保存");
}

function getCurrentDraft() {
  return {
    sourceUrl: elements.sourceUrl.value.trim(),
    sourceType: detectSourceType(elements.sourceUrl.value.trim(), elements.rawText.value.trim()),
    rawText: elements.rawText.value.trim(),
    coreKnowledge: elements.coreKnowledge.value.trim(),
    caseText: elements.caseText.value.trim(),
    category: elements.category.value.trim() || "其他",
  };
}

async function extractDraft(options = {}) {
  const sourceUrl = elements.sourceUrl.value.trim();
  const rawText = elements.rawText.value.trim();
  const sourceType = detectSourceType(sourceUrl, rawText);

  if (!sourceUrl && !rawText) {
    elements.importHint.textContent = "先输入链接或正文，再执行提炼。";
    return;
  }

  elements.extractBtn.disabled = true;
  elements.extractTextBtn.disabled = true;
  elements.autoSaveBtn.disabled = true;
  elements.extractBtn.textContent = "提炼中...";
  elements.importHint.textContent = "正在准备素材...";

  try {
    let extractedText = rawText;
    let title = "";
    let result = null;
    if (!options.textOnly && !extractedText && sourceUrl) {
      elements.importHint.textContent = "正在读取链接正文。";
      result = await fetchReadableText(sourceUrl);
      extractedText = result.text;
      title = result.title || "";
      if (result.sourceType) elements.sourceType.value = result.sourceType;
    }

    if (!extractedText) throw new Error("没有可提炼的正文");

    elements.importHint.textContent = "正在调用 Kimi 纠错并提炼观点。";
    const extractionType = normalizeBackendSourceType(result?.sourceType || sourceType);
    const draft = await refineWithKimi(extractedText, sourceUrl, extractionType, {
      transcriptMeta: result?.transcriptMeta || null,
    });

    elements.sourceType.value = extractionType;
    elements.rawText.value = extractedText;
    elements.coreKnowledge.value = draft.coreKnowledge;
    elements.caseText.value = draft.caseText;
    elements.category.value = draft.category;
    const timingText = [
      result?.timing ? formatTiming(result.timing) : "",
      draft.timing?.serverTiming ? formatTiming(draft.timing.serverTiming) : draft.timing ? `Kimi ${formatMs(draft.timing.kimiRefineMs)}` : "",
    ]
      .filter(Boolean)
      .join("；");
    elements.importHint.textContent = title
      ? `已用 Kimi 提炼《${title}》。${timingText}。请检查并确认后入库。`
      : `已用 Kimi 提炼完成。${timingText}。请检查并确认后入库。`;

    if (options.autoSave) saveCurrentCard();
  } catch (error) {
    elements.importHint.textContent = `提炼已停止：${error.message || "Kimi 不可用或调用失败"}`;
  } finally {
    elements.extractBtn.disabled = false;
    elements.extractTextBtn.disabled = false;
    elements.autoSaveBtn.disabled = false;
    elements.extractBtn.textContent = "提炼";
  }
}

function normalizeFingerprint(card) {
  return [card.coreKnowledge, card.caseText, card.category].join("::").replace(/\s+/g, "").toLowerCase();
}

function saveCurrentCard() {
  const draft = getCurrentDraft();
  if (!draft.coreKnowledge || !draft.caseText || !draft.category) {
    elements.importHint.textContent = "请补全核心知识点、案例和分类后再保存。";
    return;
  }

  const fingerprint = normalizeFingerprint(draft);
  const duplicate = state.cards.find(
    (card) => normalizeFingerprint(card) === fingerprint && card.id !== state.editingId
  );
  if (duplicate) {
    elements.importHint.textContent = "已存在相同卡片，无需重复保存。";
    showToast("重复卡片已拦截");
    return;
  }

  const now = new Date().toISOString();
  if (state.editingId) {
    state.cards = state.cards.map((card) =>
      card.id === state.editingId
        ? {
            ...card,
            ...draft,
            updatedAt: now,
          }
        : card
    );
    elements.importHint.textContent = "卡片已更新。";
    showToast("卡片已更新");
  } else {
    state.cards.unshift({
      id: uid(),
      ...draft,
      cleanedText: draft.coreKnowledge,
      createdAt: now,
      updatedAt: now,
    });
    elements.importHint.textContent = "卡片已入库。";
    showToast("卡片已入库");
  }

  persistCards();
  renderAllCardViews();
  resetForm();
}

function resetForm() {
  elements.form.reset();
  elements.coreKnowledge.value = "";
  elements.caseText.value = "";
  elements.category.value = "";
elements.sourceType.value = "auto";
  elements.sourceUrl.value = "";
  elements.rawText.value = "";
  state.editingId = null;
  elements.saveBtn.textContent = "保存卡片";
  elements.cancelEditBtn.classList.add("hidden");
  elements.importHint.textContent = navigator.onLine
    ? "等待输入内容。"
    : "当前离线，旧卡片可继续检索；新的链接解析需要恢复网络后再处理。";
}

function fillFormFromCard(card) {
  state.editingId = card.id;
  elements.sourceUrl.value = card.sourceUrl || "";
  elements.sourceType.value = card.sourceType || "auto";
  elements.rawText.value = card.rawText || "";
  elements.coreKnowledge.value = card.coreKnowledge || "";
  elements.caseText.value = card.caseText || "";
  elements.category.value = card.category || "";
  elements.saveBtn.textContent = "更新卡片";
  elements.cancelEditBtn.classList.remove("hidden");
  elements.importHint.textContent = "正在编辑现有卡片，确认后会覆盖当前记录。";
  switchView("new");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderCategoryOptions() {
  const categories = [...new Set(state.cards.map((card) => card.category).filter(Boolean))].sort();
  elements.categoryList.innerHTML = categories.map((category) => `<option value="${escapeHtml(category)}"></option>`).join("");

  const current = elements.categoryFilter.value;
  const options = ['<option value="">全部分类</option>']
    .concat(categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`))
    .join("");
  elements.categoryFilter.innerHTML = options;
  elements.categoryFilter.value = categories.includes(current) || current === "" ? current : "";
}

function applyFilters(cards) {
  const query = state.filters.query.trim().toLowerCase();
  const category = state.filters.category.trim();
  return cards.filter((card) => {
    const matchesCategory = !category || card.category === category;
    const haystack = [card.coreKnowledge, card.caseText, card.category].join(" ").toLowerCase();
    const matchesQuery = !query || haystack.includes(query);
    return matchesCategory && matchesQuery;
  });
}

function getCardListTitle(card) {
  const core = String(card.coreKnowledge || "").trim();
  const themeLine = core.split(/\r?\n/).find((line) => line.trim().startsWith("主题"));
  const theme = themeLine?.replace(/^主题\s*[：:]\s*/, "").trim();
  if (theme) return theme;
  return core.split(/\r?\n/).find(Boolean)?.trim() || card.category || "未命名卡片";
}

function renderCardList(target, cards, options = {}) {
  const { canDelete = false } = options;
  target.innerHTML = cards
    .map(
      (card) => `
      <article class="card-item compact-card" data-id="${card.id}">
        <button type="button" data-action="edit" data-id="${card.id}" class="card-open-btn">
          <span class="card-list-title">${escapeHtml(getCardListTitle(card))}</span>
        </button>
        ${
          canDelete
            ? `<button type="button" data-action="delete" data-id="${card.id}" class="card-delete-btn" aria-label="删除卡片" title="删除">×</button>`
            : ""
        }
      </article>
    `
    )
    .join("");
}

function renderSearchCards() {
  const filtered = applyFilters(state.cards);
  elements.cardCount.textContent = `${state.cards.length} 张`;
  elements.emptyState.style.display = state.cards.length === 0 || filtered.length === 0 ? "block" : "none";
  elements.emptyState.textContent =
    state.cards.length === 0 ? "还没有卡片。先新建一张。" : "没有匹配的结果，尝试清空搜索或切换分类。";
  renderCardList(elements.cardsList, filtered);
}

function renderOrganizeCards() {
  elements.cardCount.textContent = `${state.cards.length} 张`;
  elements.organizeEmptyState.style.display = state.cards.length === 0 ? "block" : "none";
  renderCardList(elements.organizeCardsList, state.cards, { canDelete: true });
}

function renderAllCardViews() {
  renderCategoryOptions();
  renderSearchCards();
  renderOrganizeCards();
}

function updateNetworkStatus() {
  const online = navigator.onLine;
  elements.networkBadge.textContent = online ? "在线" : "离线";
  elements.networkBadge.classList.toggle("online", online);
  elements.networkBadge.classList.toggle("offline", !online);
  if (!online) {
    elements.importHint.textContent = "当前离线，旧卡片可继续检索；新的链接解析需要恢复网络后再处理。";
  }
}

function importDemoCard() {
  elements.rawText.value =
    "决策的重点不是选出最好的答案，而是先识别问题边界，再比较可接受方案。例如同一项任务，若时间有限，应优先选择可验证、可交付的方案，而不是追求一次性完美。";
  elements.coreKnowledge.value =
    "主题：有限条件下的决策方法\n观点1：先明确问题边界，再比较方案。\n观点2：时间有限时，应优先选择可验证、可交付的方案。";
  elements.caseText.value = "同一项任务在时间有限时，选择可验证、可交付的方案，比追求一次性完美更稳定。";
  elements.category.value = "决策";
  elements.sourceType.value = "text";
  showToast("已填入示例内容");
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      showToast("剪贴板为空");
      return;
    }
    elements.rawText.value = text;
    showToast("已粘贴内容");
  } catch {
    showToast("当前环境不允许读取剪贴板");
  }
}

function exportBackup() {
  if (state.cards.length === 0) {
    showToast("没有可导出的卡片");
    return;
  }
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    cards: state.cards,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `intj-knowledge-cards-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast("已导出备份");
}

async function importBackupFile() {
  const readFile = async (file) => {
    const payload = JSON.parse(await file.text());
    const sourceCards = Array.isArray(payload) ? payload : payload.cards;
    const normalized = (Array.isArray(sourceCards) ? sourceCards : []).filter(isUsableCard).map(normalizeCard);
    if (normalized.length === 0) {
      showToast("备份文件中没有可导入的卡片");
      return;
    }

    const merged = [...normalized, ...state.cards];
    const unique = [];
    const seen = new Set();
    for (const card of merged) {
      const key = normalizeFingerprint(card);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(card);
    }
    state.cards = unique;
    persistCards();
    renderAllCardViews();
    showToast(`已导入 ${normalized.length} 张卡片`);
  };

  try {
    if ("showOpenFilePicker" in window) {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: "JSON 备份", accept: { "application/json": [".json"] } }],
      });
      await readFile(await handle.getFile());
      return;
    }

    await new Promise((resolve, reject) => {
      const handleChange = async () => {
        try {
          const file = backupFileInput.files?.[0];
          backupFileInput.value = "";
          if (file) await readFile(file);
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          backupFileInput.removeEventListener("change", handleChange);
        }
      };
      backupFileInput.addEventListener("change", handleChange);
      backupFileInput.click();
    });
  } catch (error) {
    if (error.name !== "AbortError") showToast("导入失败");
  }
}

function clearAllCards() {
  if (state.cards.length === 0) {
    showToast("没有可清空的卡片");
    return;
  }
  if (!window.confirm("确定清空全部卡片？该操作会删除本地全部知识库。")) return;
  state.cards = [];
  persistCards();
  renderAllCardViews();
  resetForm();
  showToast("已清空全部卡片");
}

function deleteCard(id) {
  const card = state.cards.find((item) => item.id === id);
  if (!card) return;
  if (!window.confirm(`删除该卡片？\n\n${card.category}`)) return;
  state.cards = state.cards.filter((item) => item.id !== id);
  if (state.editingId === id) resetForm();
  persistCards();
  renderAllCardViews();
}

function handleListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  const card = state.cards.find((item) => item.id === id);
  if (!card) return;
  if (action === "edit") fillFormFromCard(card);
  if (action === "delete") deleteCard(id);
}

function syncFilters() {
  state.filters.query = elements.searchInput.value;
  state.filters.category = elements.categoryFilter.value;
  renderSearchCards();
}

function handleBackupKeyboard() {
  window.addEventListener("keydown", (event) => {
    if (!event.altKey || event.key.toLowerCase() !== "b") return;
    event.preventDefault();
    if (event.shiftKey) clearAllCards();
    else exportBackup();
  });
}

async function bootstrap() {
  state.cards = loadCards();
  renderAllCardViews();
  updateNetworkStatus();
  elements.sourceType.value = "auto";
  elements.passwordInput.focus();
  try {
    const response = await fetch("/api/auth/status");
    const payload = await readJsonResponse(response);
    if (response.ok && payload.authenticated) await unlockApp();
  } catch {}

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("./sw.js")
      .then((registration) => registration.update())
      .catch(() => {});
  }
}

elements.lockForm.addEventListener("submit", handlePasswordSubmit);
elements.passwordInput.addEventListener("input", () => {
  elements.passwordInput.value = elements.passwordInput.value.replace(/\D/g, "").slice(0, 6);
});
elements.navTiles.forEach((tile) => tile.addEventListener("click", () => switchView(tile.dataset.view)));
elements.extractBtn.addEventListener("click", () => extractDraft());
elements.extractTextBtn.addEventListener("click", () => extractDraft({ textOnly: true }));
elements.autoSaveBtn.addEventListener("click", () => extractDraft({ autoSave: true }));
elements.saveKimiBtn.addEventListener("click", () =>
  saveKimiSettings().catch((error) => showToast(error.message || "保存失败"))
);
elements.testKimiBtn.addEventListener("click", testKimiConnection);
elements.clearKimiBtn.addEventListener("click", () =>
  saveKimiSettings(true).catch((error) => showToast(error.message || "清空失败"))
);
elements.pasteBtn.addEventListener("click", pasteFromClipboard);
elements.demoBtn.addEventListener("click", importDemoCard);
elements.clearDraftBtn.addEventListener("click", resetForm);
elements.cancelEditBtn.addEventListener("click", resetForm);
elements.exportBtn.addEventListener("click", exportBackup);
elements.importBtn.addEventListener("click", importBackupFile);
elements.clearAllBtn.addEventListener("click", clearAllCards);
elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  saveCurrentCard();
});
elements.searchInput.addEventListener("input", syncFilters);
elements.categoryFilter.addEventListener("change", syncFilters);
elements.resetFilterBtn.addEventListener("click", () => {
  elements.searchInput.value = "";
  elements.categoryFilter.value = "";
  syncFilters();
});
elements.cardsList.addEventListener("click", handleListClick);
elements.organizeCardsList.addEventListener("click", handleListClick);
window.addEventListener("online", updateNetworkStatus);
window.addEventListener("offline", updateNetworkStatus);
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  showToast("可安装为独立应用");
});

handleBackupKeyboard();
bootstrap();
