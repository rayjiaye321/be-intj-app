import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = process.cwd();
loadEnvFile();

const port = Number(process.env.PORT || 4173);
const appPassword = process.env.APP_PASSWORD || (process.env.NODE_ENV === "production" ? "" : "123456");
const dataDir = process.env.BE_INTJ_DATA_DIR ? normalize(process.env.BE_INTJ_DATA_DIR) : join(root, "data");
const serverSettingsPath = join(dataDir, "server-settings.json");
const cardsPath = join(dataDir, "cards.json");
const backupsDir = join(dataDir, "backups");
const defaultKimiSettings = {
  kimiApiKey: process.env.KIMI_API_KEY || "",
  kimiBaseUrl: process.env.KIMI_BASE_URL || "https://api.moonshot.cn/v1",
  kimiModel: process.env.KIMI_MODEL || "kimi-k2.6",
};
let runtimeServerSettings = { ...defaultKimiSettings };
const maxBodyBytes = 5 * 1024 * 1024;
const maxPageBytes = 2 * 1024 * 1024;
const maxBackupFiles = 20;
let sharedBrowser = null;
const jobs = new Map();
const jobTtlMs = 30 * 60 * 1000;
const sessions = new Map();
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;
let lastDailyBackupDate = "";

loadServerSettings();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".ico", "image/x-icon"],
]);

function loadEnvFile() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

function normalizeServerSettings(value = {}) {
  return {
    kimiApiKey: String(value.kimiApiKey || "").trim(),
    kimiBaseUrl: String(value.kimiBaseUrl || defaultKimiSettings.kimiBaseUrl).trim() || defaultKimiSettings.kimiBaseUrl,
    kimiModel: String(value.kimiModel || defaultKimiSettings.kimiModel).trim() || defaultKimiSettings.kimiModel,
  };
}

function loadServerSettings() {
  try {
    if (!existsSync(serverSettingsPath)) return;
    const raw = readFileSync(serverSettingsPath, "utf8");
    const parsed = JSON.parse(raw);
    runtimeServerSettings = normalizeServerSettings({ ...defaultKimiSettings, ...parsed });
  } catch {
    runtimeServerSettings = { ...defaultKimiSettings };
  }
}

function getKimiSettings() {
  return runtimeServerSettings;
}

async function saveServerSettings() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(serverSettingsPath, JSON.stringify(runtimeServerSettings, null, 2), "utf8");
}

function makeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `card-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeCardRecord(card = {}) {
  const now = new Date().toISOString();
  return {
    id: String(card.id || makeId()),
    sourceUrl: String(card.sourceUrl || ""),
    sourceType: String(card.sourceType || "text"),
    rawText: String(card.rawText || ""),
    coreKnowledge: String(card.coreKnowledge || "").trim(),
    caseText: String(card.caseText || "").trim(),
    category: String(card.category || "其他").trim() || "其他",
    cleanedText: String(card.cleanedText || card.coreKnowledge || "").trim(),
    createdAt: String(card.createdAt || now),
    updatedAt: String(card.updatedAt || now),
  };
}

function isUsableCardRecord(card) {
  return Boolean(card?.coreKnowledge && card?.caseText && card?.category);
}

function cardFingerprint(card) {
  return [card.coreKnowledge, card.caseText, card.category].join("::").replace(/\s+/g, "").toLowerCase();
}

async function loadCardsStore() {
  try {
    if (!existsSync(cardsPath)) return [];
    const raw = await readFile(cardsPath, "utf8");
    const parsed = JSON.parse(raw);
    const cards = Array.isArray(parsed) ? parsed : parsed.cards;
    return (Array.isArray(cards) ? cards : []).map(normalizeCardRecord).filter(isUsableCardRecord);
  } catch {
    return [];
  }
}

async function saveCardsStore(cards) {
  await mkdir(dataDir, { recursive: true });
  const normalized = (Array.isArray(cards) ? cards : []).map(normalizeCardRecord).filter(isUsableCardRecord);
  await writeFile(
    cardsPath,
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), cards: normalized }, null, 2),
    "utf8"
  );
  return normalized;
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function listCardBackups() {
  await mkdir(backupsDir, { recursive: true });
  const files = await readdir(backupsDir).catch(() => []);
  const backups = [];
  for (const file of files) {
    if (!/^cards-\d{4}-\d{2}-\d{2}T.*\.json$/.test(file)) continue;
    try {
      const raw = await readFile(join(backupsDir, file), "utf8");
      const parsed = JSON.parse(raw);
      const cards = Array.isArray(parsed.cards) ? parsed.cards : [];
      backups.push({
        id: file,
        createdAt: parsed.backedUpAt || parsed.updatedAt || file.replace(/^cards-/, "").replace(/\.json$/, ""),
        reason: parsed.reason || "manual",
        count: cards.length,
      });
    } catch {
      backups.push({ id: file, createdAt: file.replace(/^cards-/, "").replace(/\.json$/, ""), reason: "unknown", count: 0 });
    }
  }
  return backups.sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

async function pruneCardBackups() {
  const backups = await listCardBackups();
  const extra = backups.slice(maxBackupFiles);
  await Promise.all(extra.map((backup) => unlink(join(backupsDir, backup.id)).catch(() => {})));
}

async function createCardsBackup(reason = "manual") {
  const cards = await loadCardsStore();
  await mkdir(backupsDir, { recursive: true });
  const backup = {
    version: 1,
    reason,
    backedUpAt: new Date().toISOString(),
    count: cards.length,
    cards,
  };
  const filename = `cards-${backupTimestamp()}.json`;
  await writeFile(join(backupsDir, filename), JSON.stringify(backup, null, 2), "utf8");
  await pruneCardBackups();
  return { id: filename, createdAt: backup.backedUpAt, reason, count: cards.length };
}

async function ensureDailyCardsBackup() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastDailyBackupDate === today) return null;
  const cards = await loadCardsStore();
  if (cards.length === 0) {
    lastDailyBackupDate = today;
    return null;
  }
  lastDailyBackupDate = today;
  return createCardsBackup("daily-auto");
}

async function restoreCardsBackup(backupId) {
  if (!/^cards-\d{4}-\d{2}-\d{2}T.*\.json$/.test(backupId || "")) {
    throw new Error("备份编号无效");
  }
  const raw = await readFile(join(backupsDir, backupId), "utf8");
  const parsed = JSON.parse(raw);
  const sourceCards = Array.isArray(parsed.cards) ? parsed.cards : [];
  await createCardsBackup("before-restore");
  const cards = await saveCardsStore(sourceCards);
  return cards;
}

function mergeCards(existing, incoming) {
  const merged = [];
  const byId = new Map();
  const byFingerprint = new Set();
  for (const card of [...incoming, ...existing].map(normalizeCardRecord).filter(isUsableCardRecord)) {
    const fingerprint = cardFingerprint(card);
    if (byId.has(card.id) || byFingerprint.has(fingerprint)) continue;
    byId.set(card.id, card);
    byFingerprint.add(fingerprint);
    merged.push(card);
  }
  return merged.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function isSecureRequest(req) {
  return req.headers["x-forwarded-proto"] === "https";
}

function makeSessionCookie(token, req) {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `be_intj_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}${secure}`;
}

function clearSessionCookie() {
  return "be_intj_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
}

function cleanupSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

function getSession(req) {
  cleanupSessions();
  const token = parseCookies(req).be_intj_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function requireAuth(req, res) {
  if (getSession(req)) return true;
  send(res, 401, { error: "未登录或登录已过期" });
  return false;
}

function safeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function createSession() {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, {
    createdAt: Date.now(),
    expiresAt: Date.now() + sessionTtlMs,
  });
  return token;
}

function nowMs() {
  return Date.now();
}

function durationMs(start) {
  return Date.now() - start;
}

function createTiming() {
  return {
    startedAt: new Date().toISOString(),
    steps: [],
  };
}

async function timedStep(timing, name, fn) {
  const start = nowMs();
  try {
    const result = await fn();
    timing.steps.push({ name, ms: durationMs(start), ok: true });
    return result;
  } catch (error) {
    timing.steps.push({ name, ms: durationMs(start), ok: false, error: error.message });
    throw error;
  }
}

function finishTiming(timing) {
  timing.finishedAt = new Date().toISOString();
  timing.totalMs = new Date(timing.finishedAt).getTime() - new Date(timing.startedAt).getTime();
  return timing;
}

function createJob(type) {
  const id = `${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const job = {
    id,
    type,
    status: "queued",
    message: "等待处理",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
    error: null,
    timing: createTiming(),
  };
  jobs.set(id, job);
  return job;
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
}

function cleanupJobs() {
  const cutoff = Date.now() - jobTtlMs;
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff) jobs.delete(id);
  }
}

function normalizeRoute(pathname) {
  const clean = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(root, clean));
  if (!filePath.startsWith(root)) return null;
  return filePath;
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function extractMeta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1].trim());
  }
  return "";
}

function extractTitle(html) {
  const metaTitle = extractMeta(html, "og:title") || extractMeta(html, "twitter:title");
  if (metaTitle) return metaTitle;
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlEntities(match[1].replace(/\s+/g, " ").trim()) : "";
}

function stripHtml(html) {
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const candidate = articleMatch?.[1] || mainMatch?.[1] || bodyMatch?.[1] || html;

  return decodeHtmlEntities(
    candidate
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<(nav|footer|header|aside|form|svg|canvas)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

async function getBrowser() {
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  sharedBrowser = await chromium.launch({ headless: true });
  return sharedBrowser;
}

async function fetchPage(url) {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("链接必须以 http 或 https 开头");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(target, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        Accept: "text/html,text/plain;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });

    if (!response.ok) throw new Error(`页面返回 ${response.status}，无法直接读取正文`);
    const contentType = response.headers.get("content-type") || "";
    if (!/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error(`目标内容不是网页正文：${contentType || "未知类型"}`);
    }

    const reader = response.body?.getReader();
    if (!reader) return await response.text();
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxPageBytes) break;
      chunks.push(value);
    }
    return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timeout);
  }
}

async function renderTextPage(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1365, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1200);

    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const html = await page.content();
        const title = extractTitle(html);
        const description = extractMeta(html, "description") || extractMeta(html, "og:description");
        const text = stripHtml(html);
        const combined = [title, description, text].filter(Boolean).join("\n\n");
        if (combined.trim().length >= 20) return combined;
      } catch (error) {
        lastError = error;
        if (!/Execution context was destroyed|navigation|Target closed|closed/i.test(error.message || "")) {
          throw error;
        }
      }
      await page.waitForTimeout(1200);
    }
    throw lastError || new Error("未能提取页面正文");
  } finally {
    await context.close();
  }
}

async function extractUrlContent(url, timing = createTiming(), onProgress = () => {}) {
  if (!url) throw new Error("缺少链接");

  onProgress("读取网页正文");
  let html;
  try {
    html = await timedStep(timing, "fetch-page", () => fetchPage(url));
  } catch (error) {
    timing.steps.push({ name: "fetch-page-failed", ms: 0, ok: false, error: error.message });
    onProgress("页面抓取失败，改用浏览器读取");
    html = await timedStep(timing, "render-page", () => renderTextPage(url));
  }
  const title = extractTitle(html);
  const description = extractMeta(html, "description") || extractMeta(html, "og:description");
  const text = stripHtml(html);
  const combined = [title, description, text].filter(Boolean).join("\n\n");
  if (combined.trim().length < 20) throw new Error("没有提取到足够正文");

  return {
    title,
    text: combined,
    length: combined.length,
    sourceUrl: url,
    sourceType: "page",
    timing,
  };
}
async function handleExtract(req, res) {
  const timing = createTiming();
  try {
    const body = await readJsonBody(req);
    const url = String(body.url || "").trim();
    const result = await extractUrlContent(url, timing);
    send(res, 200, { ...result, timing: finishTiming(timing) });
  } catch (error) {
    send(res, 500, { error: error.message || "链接解析失败", timing: finishTiming(timing) });
  }
}

async function handleLogin(req, res) {
  try {
    const body = await readJsonBody(req);
    const password = String(body.password || "");
    if (!/^\d{6}$/.test(appPassword)) {
      send(res, 500, { error: "服务器 APP_PASSWORD 必须是 6 位数字" });
      return;
    }
    if (!safeEqualText(password, appPassword)) {
      send(res, 401, { error: "密码错误" });
      return;
    }
    const token = createSession();
    send(res, 200, { ok: true }, { "Set-Cookie": makeSessionCookie(token, req) });
  } catch (error) {
    send(res, 500, { error: error.message || "登录失败" });
  }
}

function handleAuthStatus(req, res) {
  const kimiSettings = getKimiSettings();
  send(res, 200, {
    authenticated: Boolean(getSession(req)),
    kimiConfigured: Boolean(kimiSettings.kimiApiKey),
    kimiBaseUrl: kimiSettings.kimiBaseUrl,
    kimiModel: kimiSettings.kimiModel,
  });
}

async function handleSaveKimiSettings(req, res) {
  try {
    const body = await readJsonBody(req);
    const current = getKimiSettings();
    const next = normalizeServerSettings({
      kimiApiKey:
        typeof body.kimiApiKey === "string"
          ? body.kimiApiKey
          : body.clearKimiApiKey || body.clearKimiKey
            ? ""
            : current.kimiApiKey,
      kimiBaseUrl: typeof body.kimiBaseUrl === "string" ? body.kimiBaseUrl : current.kimiBaseUrl,
      kimiModel: typeof body.kimiModel === "string" ? body.kimiModel : current.kimiModel,
    });
    runtimeServerSettings = next;
    await saveServerSettings();
    send(res, 200, {
      ok: true,
      kimiConfigured: Boolean(next.kimiApiKey),
      kimiBaseUrl: next.kimiBaseUrl,
      kimiModel: next.kimiModel,
    });
  } catch (error) {
    send(res, 500, { error: error.message || "Kimi 配置保存失败" });
  }
}

function handleLogout(req, res) {
  const token = parseCookies(req).be_intj_session;
  if (token) sessions.delete(token);
  send(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
}

async function handleCardsList(req, res) {
  try {
    await ensureDailyCardsBackup();
    const cards = await loadCardsStore();
    send(res, 200, { cards });
  } catch (error) {
    send(res, 500, { error: error.message || "读取卡片库失败" });
  }
}

async function handleCardsMerge(req, res) {
  try {
    const body = await readJsonBody(req);
    const existing = await loadCardsStore();
    const incoming = Array.isArray(body.cards) ? body.cards : [];
    const cards = await saveCardsStore(mergeCards(existing, incoming));
    send(res, 200, { cards });
  } catch (error) {
    send(res, 500, { error: error.message || "合并卡片库失败" });
  }
}

async function handleCardSave(req, res) {
  try {
    const body = await readJsonBody(req);
    const card = normalizeCardRecord(body.card || body);
    if (!isUsableCardRecord(card)) {
      send(res, 400, { error: "卡片缺少核心知识点、案例或分类" });
      return;
    }
    const now = new Date().toISOString();
    const existing = await loadCardsStore();
    const nextCard = { ...card, updatedAt: now, createdAt: card.createdAt || now };
    const cards = existing.filter((item) => item.id !== nextCard.id && cardFingerprint(item) !== cardFingerprint(nextCard));
    cards.unshift(nextCard);
    const saved = await saveCardsStore(cards);
    send(res, 200, { card: nextCard, cards: saved });
  } catch (error) {
    send(res, 500, { error: error.message || "保存卡片失败" });
  }
}

async function handleCardDelete(req, res, pathname) {
  try {
    const id = decodeURIComponent(pathname.split("/").pop() || "");
    if (!id) {
      send(res, 400, { error: "缺少卡片编号" });
      return;
    }
    const existing = await loadCardsStore();
    if (existing.some((card) => card.id === id)) await createCardsBackup("before-delete");
    const cards = await saveCardsStore(existing.filter((card) => card.id !== id));
    send(res, 200, { cards });
  } catch (error) {
    send(res, 500, { error: error.message || "删除卡片失败" });
  }
}

async function handleCardsClear(req, res) {
  try {
    const existing = await loadCardsStore();
    if (existing.length > 0) await createCardsBackup("before-clear");
    const cards = await saveCardsStore([]);
    send(res, 200, { cards });
  } catch (error) {
    send(res, 500, { error: error.message || "清空卡片库失败" });
  }
}

async function handleCardsCategoryRename(req, res) {
  try {
    const body = await readJsonBody(req);
    const from = String(body.from || "").trim();
    const to = String(body.to || "").trim();
    if (!from || !to) {
      send(res, 400, { error: "请填写原分类和新分类" });
      return;
    }
    if (from === to) {
      const cards = await loadCardsStore();
      send(res, 200, { cards, changed: 0 });
      return;
    }
    const existing = await loadCardsStore();
    const changed = existing.filter((card) => card.category === from).length;
    if (changed === 0) {
      send(res, 404, { error: "没有找到该分类下的卡片" });
      return;
    }
    await createCardsBackup("before-category-rename");
    const now = new Date().toISOString();
    const cards = await saveCardsStore(
      existing.map((card) => (card.category === from ? { ...card, category: to, updatedAt: now } : card))
    );
    send(res, 200, { cards, changed });
  } catch (error) {
    send(res, 500, { error: error.message || "分类整理失败" });
  }
}

async function handleBackupsList(req, res) {
  try {
    const backups = await listCardBackups();
    send(res, 200, { backups });
  } catch (error) {
    send(res, 500, { error: error.message || "读取备份失败" });
  }
}

async function handleBackupCreate(req, res) {
  try {
    const backup = await createCardsBackup("manual");
    const backups = await listCardBackups();
    send(res, 200, { backup, backups });
  } catch (error) {
    send(res, 500, { error: error.message || "创建备份失败" });
  }
}

async function handleBackupRestore(req, res, pathname) {
  try {
    const backupId = decodeURIComponent(pathname.split("/").slice(-2, -1)[0] || "");
    const cards = await restoreCardsBackup(backupId);
    const backups = await listCardBackups();
    send(res, 200, { cards, backups });
  } catch (error) {
    send(res, 500, { error: error.message || "恢复备份失败" });
  }
}

async function handleExtractJobStart(req, res) {
  cleanupJobs();
  try {
    const body = await readJsonBody(req);
    const url = String(body.url || "").trim();
    if (!url) {
      send(res, 400, { error: "缺少链接" });
      return;
    }

    const job = createJob("extract");
    updateJob(job, { status: "running", message: "开始处理链接" });
    extractUrlContent(url, job.timing, (message) => updateJob(job, { message }))
      .then((result) => {
        updateJob(job, {
          status: "done",
          message: "链接正文已提取",
          result: { ...result, timing: finishTiming(job.timing) },
        });
      })
      .catch((error) => {
        updateJob(job, {
          status: "error",
          message: "链接提取失败",
          error: error.message || "链接解析失败",
          timing: finishTiming(job.timing),
        });
      });

    send(res, 202, { jobId: job.id, status: job.status, message: job.message });
  } catch (error) {
    send(res, 500, { error: error.message || "任务启动失败" });
  }
}

function handleJobStatus(req, res, pathname) {
  cleanupJobs();
  const id = decodeURIComponent(pathname.split("/").pop() || "");
  const job = jobs.get(id);
  if (!job) {
    send(res, 404, { error: "任务不存在或已过期" });
    return;
  }
  send(res, 200, {
    id: job.id,
    type: job.type,
    status: job.status,
    message: job.message,
    result: job.result,
    error: job.error,
    timing: job.result?.timing || job.timing,
  });
}

function buildDynamicViewpointPrompt({ sourceText, sourceType }) {
  const typeLabel = sourceType === "page" ? "网页文章" : "粘贴正文";
  return [
    `素材类型：${typeLabel}`,
    "",
    "请把素材提炼成知识总结卡片。",
    "只输出 JSON，不要输出 Markdown。",
    "JSON 必须包含 coreKnowledge、caseText、category 三个字段。",
    "",
    "coreKnowledge 必须使用如下格式：",
    "主题：一句话概括全文主题",
    "观点1：第一个核心观点",
    "观点2：第二个核心观点",
    "观点N：按文案实际观点数量继续输出",
    "",
    "观点数量要求：",
    "- 不固定为 3 个。",
    "- 文案有几个独立核心观点，就输出几个观点。",
    "- 不要为了凑数量编造观点。",
    "- 每个观点必须是提炼后的结论，不要复制逐字稿长句。",
    "",
    "纠错和清洗要求：",
    "- 纠正明显错字、同音词、断句问题和概念误写。",
    "- 删除口水词、重复句、情绪化表达、引流话术、互动话术和平台噪声。",
    "- 不要凭空添加素材没有的信息。",
    "- 语言简洁、直接、结构清晰。",
    "",
    "caseText 只保留能说明观点的案例、例子、场景或论证材料；没有明确案例时，写“无明确案例”。",
    "category 必须是一个短分类，例如：认知、学习、决策、表达、效率、关系、商业、技术、心理、其他。",
    "",
    "素材：",
    String(sourceText || "").slice(0, 18000),
  ].join("\n");
}

function parseKimiJson(content) {
  const raw = String(content || "").trim();
  if (!raw) {
    throw new Error("Kimi 没有返回可解析内容");
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  if (!candidate) {
    throw new Error("Kimi 返回内容为空");
  }
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("Kimi 返回的不是有效 JSON");
  }

  const coreKnowledge = normalizeCoreKnowledge(parsed);
  const caseText = stringifyKimiField(parsed.caseText ?? parsed.case ?? parsed.cases ?? parsed.example ?? parsed.examples).trim();
  const category = stringifyKimiField(parsed.category ?? parsed.classification ?? parsed.type).trim() || "其他";

  return {
    coreKnowledge,
    caseText,
    category,
  };
}

function stringifyKimiField(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(stringifyKimiField).filter(Boolean).join("\n");
  if (typeof value === "object") {
    return Object.values(value).map(stringifyKimiField).filter(Boolean).join("\n");
  }
  return String(value);
}

function normalizeCoreKnowledge(parsed) {
  const source =
    parsed.coreKnowledge ??
    parsed.core_knowledge ??
    parsed["核心知识点"] ??
    parsed["核心知识"] ??
    parsed.summary ??
    parsed["总结"] ??
    parsed.knowledge ??
    parsed;
  if (typeof source === "object" && source !== null && !Array.isArray(source)) {
    const theme = stringifyKimiField(
      source.theme ??
        source.topic ??
        source.title ??
        source["主题"] ??
        source["标题"] ??
        parsed.theme ??
        parsed.topic ??
        parsed.title ??
        parsed["主题"] ??
        parsed["标题"]
    ).trim();
    const rawPoints =
      source.points ??
      source.viewpoints ??
      source.opinions ??
      source.arguments ??
      source["观点"] ??
      source["要点"] ??
      source["核心观点"] ??
      parsed.points ??
      parsed.viewpoints ??
      parsed.opinions ??
      parsed.arguments ??
      parsed["观点"] ??
      parsed["要点"] ??
      parsed["核心观点"] ??
      collectNumberedPoints(source) ??
      collectNumberedPoints(parsed) ??
      [];
    const points = normalizePointList(rawPoints);
    if (theme && points.length) {
      return [`主题：${theme}`, ...points.map((point, index) => `观点${index + 1}：${point}`)].join("\n");
    }
  }

  const text = stringifyKimiField(source).trim();
  if (!text) return "";
  const lines = text
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const themeLine = lines.find((line) => /^主题\s*[：:]/.test(line));
  const englishThemeLine = lines.find((line) => /^theme\s*[：:]/i.test(line));
  const pointLines = lines.filter((line) => /^观点\s*\d+\s*[：:]/.test(line));
  const englishPointLines = lines.filter((line) => /^point\s*\d+\s*[：:]/i.test(line));
  if (themeLine && pointLines.length) {
    const normalizedTheme = themeLine.replace(/^主题\s*[：:]\s*/, "主题：");
    const normalizedPoints = pointLines.map((line, index) =>
      line.replace(/^观点\s*\d+\s*[：:]\s*/, `观点${index + 1}：`)
    );
    return [normalizedTheme, ...normalizedPoints].join("\n");
  }
  if (englishThemeLine && englishPointLines.length) {
    const normalizedTheme = englishThemeLine.replace(/^theme\s*[：:]\s*/i, "主题：");
    const normalizedPoints = englishPointLines.map((line, index) =>
      line.replace(/^point\s*\d+\s*[：:]\s*/i, `观点${index + 1}：`)
    );
    return [normalizedTheme, ...normalizedPoints].join("\n");
  }

  const theme = stringifyKimiField(parsed.theme ?? parsed.topic ?? parsed.title ?? parsed["主题"] ?? parsed["标题"]).trim();
  const points = normalizePointList(
    parsed.points ??
      parsed.viewpoints ??
      parsed.opinions ??
      parsed.arguments ??
      parsed["观点"] ??
      parsed["要点"] ??
      parsed["核心观点"] ??
      collectNumberedPoints(parsed)
  );
  if (theme && points.length) {
    return [`主题：${theme}`, ...points.map((point, index) => `观点${index + 1}：${point}`)].join("\n");
  }

  return text;
}

function collectNumberedPoints(value) {
  if (typeof value !== "object" || value === null) return null;
  const entries = Object.entries(value)
    .map(([key, item]) => {
      const match = String(key).match(/^观点\s*(\d+)$/);
      return match ? [Number(match[1]), item] : null;
    })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item);
  return entries.length ? entries : null;
}

function normalizePointList(value) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  return list
    .map((item) => {
      if (typeof item === "object" && item !== null) {
        return stringifyKimiField(item.point ?? item.viewpoint ?? item.opinion ?? item.content ?? item.text ?? item.summary ?? item);
      }
      return stringifyKimiField(item);
    })
    .map((item) => item.replace(/^观点\s*\d+\s*[：:]\s*/, "").trim())
    .filter(Boolean);
}

function validateViewpointFormat(coreKnowledge) {
  const lines = String(coreKnowledge || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hasTheme = lines.some((line) => line.startsWith("主题") && /[：:].+/.test(line));
  const hasPoint = lines.some((line) => line.startsWith("观点") && /\d+/.test(line) && /[：:].+/.test(line));
  return hasTheme && hasPoint;
}

async function callKimi({ apiKey, baseUrl, model, messages, maxTokens = 700, temperature = 0.6, thinking = null }) {
  if (!apiKey) throw new Error("缺少 Kimi API Key");
  const endpoint = `${String(baseUrl || "https://api.moonshot.cn/v1").replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: model || "kimi-k2.6",
    messages,
    temperature,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
  };
  if (thinking) body.thinking = thinking;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || `Kimi 返回 ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

async function repairKimiCardFormat({ apiKey, baseUrl, model, rawContent }) {
  const payload = await callKimi({
    apiKey,
    baseUrl,
    model,
    maxTokens: 900,
    temperature: 0.6,
    thinking: { type: "disabled" },
    messages: [
      {
        role: "system",
        content: "你只负责把已有知识卡片改写成指定 JSON 格式，不新增原文没有的信息。",
      },
      {
        role: "user",
        content: [
          "把下面内容改成严格 JSON。",
          "JSON 必须只有 coreKnowledge、caseText、category 三个字段。",
          "coreKnowledge 必须是字符串，并严格使用：",
          "主题：一句话主题",
          "观点1：第一个观点",
          "观点2：第二个观点",
          "观点N：按已有观点继续编号",
          "不要增加新观点，不要输出 Markdown。",
          "",
          "待修复内容：",
          String(rawContent || "").slice(0, 8000),
        ].join("\n"),
      },
    ],
  });
  return payload?.choices?.[0]?.message?.content || "";
}

async function handleKimiRefine(req, res) {
  const timing = createTiming();
  try {
    const body = await readJsonBody(req);
    const kimiSettings = getKimiSettings();
    if (!kimiSettings.kimiApiKey) throw new Error("服务器未配置 KIMI_API_KEY");
    const payload = await timedStep(timing, "kimi-refine", () =>
      callKimi({
        apiKey: kimiSettings.kimiApiKey,
        baseUrl: kimiSettings.kimiBaseUrl,
        model: kimiSettings.kimiModel,
        maxTokens: 1200,
        temperature: 0.6,
        thinking: { type: "disabled" },
        messages: [
          {
            role: "system",
            content: "你是知识提炼助手，擅长把网页文章和正文压缩成去情绪化、去营销化的知识卡片。",
          },
          {
            role: "user",
            content: buildDynamicViewpointPrompt(body),
          },
        ],
      })
    );
    const content = payload?.choices?.[0]?.message?.content || "";
    let card = parseKimiJson(content);
    let repaired = false;
    if (!validateViewpointFormat(card.coreKnowledge)) {
      const repairedContent = await timedStep(timing, "kimi-format-repair", () =>
        repairKimiCardFormat({
          apiKey: kimiSettings.kimiApiKey,
          baseUrl: kimiSettings.kimiBaseUrl,
          model: kimiSettings.kimiModel,
          rawContent: content,
        })
      );
      card = parseKimiJson(repairedContent);
      repaired = true;
    }
    if (!card.coreKnowledge || !card.caseText || !card.category) {
      throw new Error("Kimi 返回内容缺少卡片字段");
    }
    if (!repaired && !validateViewpointFormat(card.coreKnowledge)) {
      throw new Error("Kimi 返回格式不符合“主题 + 观点”要求");
    }
    send(res, 200, { card, usage: payload.usage || null, timing: finishTiming(timing) });
  } catch (error) {
    send(res, 500, { error: error.message || "Kimi 提炼失败", timing: finishTiming(timing) });
  }
}

async function handleKimiTest(req, res) {
  try {
    const kimiSettings = getKimiSettings();
    if (!kimiSettings.kimiApiKey) throw new Error("服务器未配置 KIMI_API_KEY");
    await callKimi({
      apiKey: kimiSettings.kimiApiKey,
      baseUrl: kimiSettings.kimiBaseUrl,
      model: kimiSettings.kimiModel,
      maxTokens: 20,
      temperature: 0.6,
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: "只输出 JSON。" },
        { role: "user", content: '输出 {"ok":true}' },
      ],
    });
    send(res, 200, { ok: true });
  } catch (error) {
    send(res, 500, { error: error.message || "Kimi 连接失败" });
  }
}

async function serveStatic(req, res, pathname) {
  const filePath = normalizeRoute(pathname);
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes.get(extname(filePath)) || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    await handleLogin(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    handleLogout(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    handleAuthStatus(req, res);
    return;
  }

  if (url.pathname.startsWith("/api/") && !requireAuth(req, res)) {
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/extract") {
    await handleExtract(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/extract/jobs") {
    await handleExtractJobStart(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
    handleJobStatus(req, res, url.pathname);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cards") {
    await handleCardsList(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cards/merge") {
    await handleCardsMerge(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cards/categories/rename") {
    await handleCardsCategoryRename(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cards") {
    await handleCardSave(req, res);
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/cards/")) {
    await handleCardDelete(req, res, url.pathname);
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/cards") {
    await handleCardsClear(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/backups") {
    await handleBackupsList(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/backups") {
    await handleBackupCreate(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/backups/") && url.pathname.endsWith("/restore")) {
    await handleBackupRestore(req, res, url.pathname);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/kimi/refine") {
    await handleKimiRefine(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/kimi/test") {
    await handleKimiTest(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings/kimi") {
    await handleSaveKimiSettings(req, res);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, { error: "Method Not Allowed" });
    return;
  }

  await serveStatic(req, res, url.pathname);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`INTJ knowledge app running at http://0.0.0.0:${port}`);
});


