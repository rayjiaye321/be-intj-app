import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const root = process.cwd();
const mediaDir = join(root, "data", "media");
loadEnvFile();

const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const pythonCommand = process.env.PYTHON || "python";
const whisperModel = process.env.WHISPER_MODEL || "base";
const port = Number(process.env.PORT || 4173);
const appPassword = process.env.APP_PASSWORD || (process.env.NODE_ENV === "production" ? "" : "123456");
const dataDir = join(root, "data");
const serverSettingsPath = join(dataDir, "server-settings.json");
const defaultKimiSettings = {
  kimiApiKey: process.env.KIMI_API_KEY || "",
  kimiBaseUrl: process.env.KIMI_BASE_URL || "https://api.moonshot.cn/v1",
  kimiModel: process.env.KIMI_MODEL || "kimi-k2.6",
};
let runtimeServerSettings = { ...defaultKimiSettings };
const maxBodyBytes = 1024 * 1024;
const maxPageBytes = 2 * 1024 * 1024;
let sharedBrowser = null;
const jobs = new Map();
const jobTtlMs = 30 * 60 * 1000;
const sessions = new Map();
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;

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

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `${command} exited with code ${code}`));
    });
  });
}

async function ensureMediaDir() {
  await mkdir(mediaDir, { recursive: true });
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

function getDouyinAwemeId(url) {
  const text = String(url || "");
  const match = text.match(/douyin\.com\/video\/(\d+)/i) || text.match(/[?&]modal_id=(\d+)/i) || text.match(/[?&]item_id=(\d+)/i);
  return match?.[1] || "";
}

function cleanText(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u3000/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const douyinNoise = [
  /open app|login|captcha|copyright|privacy|terms/i,
  /打开App|打开 app|登录|注册|验证码|扫码|推荐|关注|评论|分享|举报|隐私政策|用户服务协议|广告投放|站点地图/,
  /抖音网页版|抖音短视频|抖音官网|下载客户端|推荐视频|热门|加载更多/,
  /^下载抖音精选$/,
  /^内容由AI生成$/,
  /^展开\d*条回复$/,
  /^全部评论$/,
  /ICP备|公网安备|许可证|京B2|京网文|网络谣言|互联网|药品医疗|广播电视节目|©/,
  /开启读屏标签|读屏标签已关闭|因浏览器限制|大家都在搜|发布时间|粉丝|获赞|合集/,
  /^第\d+集\s*\|/,
  /^@?豆包\s/,
  /^[\d.]+万?$/,
  /^\d+[天小时分钟秒]前/,
  /^(\d{1,2}:)?\d{1,2}:\d{2}(?:\s*\/\s*(\d{1,2}:)?\d{1,2}:\d{2})?$/,
];

function isUsefulChineseText(value) {
  const text = cleanText(value);
  return text.length >= 6 && /[\u4e00-\u9fa5]/.test(text) && !douyinNoise.some((pattern) => pattern.test(text));
}

function collectTextDeep(value, output = [], seen = new WeakSet(), depth = 0) {
  if (!value || output.length > 180 || depth > 6) return output;
  if (typeof value === "string") {
    const text = cleanText(safeDecodeUnicode(value));
    if (isUsefulChineseText(text)) output.push(text);
    return output;
  }
  if (typeof value !== "object") return output;
  if (seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectTextDeep(item, output, seen, depth + 1);
    return output;
  }
  for (const item of Object.values(value)) collectTextDeep(item, output, seen, depth + 1);
  return output;
}

function uniqueUsefulLines(text, limit = 120) {
  const relevantText = String(text || "").split(/大家都在搜|全部评论|推荐视频|合集\s*·|打开「抖音APP」|留下你的精彩评论/)[0] || "";
  const lines = relevantText
    .split(/\n+/)
    .map((line) => cleanText(line))
    .filter(isUsefulChineseText);
  const result = [];
  const seen = new Set();
  for (const line of lines) {
    const key = line.replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line);
    if (result.length >= limit) break;
  }
  return result.join("\n");
}

function buildDouyinTextResult({ title = "", pageText = "", scriptText = "", stateText = "", sourceUrl = "", extractor = "douyin" }) {
  const body = uniqueUsefulLines([stateText, pageText, scriptText].filter(Boolean).join("\n"), 140);
  const titleLine = cleanText(title).replace(/\s*-\s*抖音.*$/i, "").trim();
  const text = uniqueUsefulLines([titleLine, body].filter(Boolean).join("\n"), 140);
  return {
    title: titleLine || title || "抖音视频",
    text,
    pageText: uniqueUsefulLines(pageText, 80),
    transcript: body,
    length: text.length,
    sourceUrl,
    extractor,
  };
}

function extractJsonText(value, output = []) {
  if (!value || output.length > 24) return output;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length >= 12 && /[\u4e00-\u9fa5]/.test(text)) output.push(text);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractJsonText(item, output);
    return output;
  }
  if (typeof value === "object") {
    for (const key of ["desc", "title", "text", "content", "caption", "nickname"]) {
      if (value[key]) extractJsonText(value[key], output);
    }
    return output;
  }
  return output;
}

async function fetchDouyinMetadata(url) {
  const awemeId = getDouyinAwemeId(url);
  if (!awemeId) return null;

  const candidates = [
    `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${awemeId}`,
    `https://www.douyin.com/web/api/v2/aweme/iteminfo/?item_ids=${awemeId}`,
    `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&aid=6383&device_platform=webapp`,
  ];

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
          Referer: url,
          Accept: "application/json,text/plain,*/*",
        },
      });
      const raw = await response.text();
      if (!raw) continue;
      const payload = JSON.parse(raw);
      if (payload.status_msg === "encrypt_data_miss") continue;
      const texts = [...new Set(collectTextDeep(payload))];
      if (texts.length > 0) {
        return buildDouyinTextResult({
          title: texts[0],
          pageText: texts.join("\n"),
          stateText: texts.join("\n"),
          sourceUrl: url,
          extractor: "douyin-metadata",
        });
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function getBrowser() {
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  sharedBrowser = await chromium.launch({ headless: true });
  return sharedBrowser;
}

function pickUsefulDouyinText(text) {
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.length >= 8)
    .filter((line) => !/打开App|扫码|登录|注册|客户端|抖音网页版|验证码|推荐|关注|评论|分享/.test(line));
  return [...new Set(lines)].slice(0, 20).join("\n");
}

function safeDecodeUnicode(text) {
  const value = String(text || "");
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
  }
}

async function renderDouyinPage(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1365, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const data = await page.evaluate(() => {
      const metas = Array.from(document.querySelectorAll("meta")).map((meta) => ({
        name: meta.getAttribute("name") || meta.getAttribute("property") || "",
        content: meta.getAttribute("content") || "",
      }));
      const scripts = Array.from(document.scripts)
        .map((script) => script.textContent || "")
        .filter((text) => /desc|aweme|caption|subtitle|title|INITIAL_STATE|REHYDRATION|UNIVERSAL|video|detail/i.test(text))
        .slice(0, 28);
      const stateTexts = [];
      const seen = new Set();
      const push = (value) => {
        if (typeof value !== "string") return;
        const text = value.replace(/\s+/g, " ").trim();
        if (text.length < 6 || seen.has(text)) return;
        if (!/[\u4e00-\u9fa5]/.test(text)) return;
        seen.add(text);
        stateTexts.push(text);
      };
      const walk = (value, depth = 0) => {
        if (!value || depth > 5 || stateTexts.length > 160) return;
        if (typeof value === "string") {
          push(value);
          return;
        }
        if (typeof value !== "object") return;
        if (Array.isArray(value)) {
          for (const item of value) walk(item, depth + 1);
          return;
        }
        for (const item of Object.values(value)) walk(item, depth + 1);
      };
      for (const key of [
        "__INITIAL_STATE__",
        "__GLOBAL_STATE__",
        "__UNIVERSAL_DATA_FOR_REHYDRATION__",
        "__NEXT_DATA__",
        "__NUXT__",
        "__INITIAL_PROPS__",
      ]) {
        try {
          walk(window[key]);
        } catch {}
      }
      return {
        title: document.title || "",
        mainText: document.querySelector("main")?.innerText || "",
        bodyText: document.body?.innerText || "",
        metas,
        scripts,
        stateTexts,
      };
    });

    const metaText = data.metas
      .filter((meta) => /title|description|og:title|og:description|keywords/i.test(meta.name))
      .map((meta) => meta.content)
      .filter(Boolean)
      .join("\n");
    const scriptText = data.scripts.map((script) => safeDecodeUnicode(script)).join("\n");
    const stateText = data.stateTexts.join("\n");
    const result = buildDouyinTextResult({
      title: data.title || "抖音视频",
      pageText: [metaText, data.mainText, data.bodyText].filter(Boolean).join("\n"),
      scriptText,
      stateText,
      sourceUrl: url,
      extractor: "douyin-render",
    });
    if (result.text.length >= 20) {
      return result;
    }
    return null;
  } finally {
    await context.close();
  }
}

async function captureDouyinMedia(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1365, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  });
  const page = await context.newPage();
  const candidates = [];
  page.on("dialog", async (dialog) => {
    try {
      await dialog.dismiss();
    } catch {}
  });
  page.on("response", async (response) => {
    const responseUrl = response.url();
    const headers = response.headers();
    const contentType = headers["content-type"] || "";
    const contentLength = Number(headers["content-length"] || 0);
    const resourceType = response.request().resourceType();
    const looksLikeMedia =
      resourceType === "media" ||
      /video|audio|octet|mpegurl|m3u8/i.test(contentType) ||
      /video|audio|m3u8|playwm|playurl|aweme|snssdk|douyinvod|byte|stream|segment|manifest/i.test(responseUrl);
    if (!looksLikeMedia) return;
    const isAudio = /audio/i.test(contentType) || /audio/i.test(responseUrl) || /mime_type=audio/i.test(responseUrl);
    const isVideo = !isAudio;
    candidates.push({
      url: responseUrl,
      contentType,
      contentLength,
      kind: isAudio ? "audio" : "video",
      status: response.status(),
      resourceType,
      headers,
    });
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await dismissDouyinLoginWall(page);
    await startDouyinPlayback(page);
    await page.waitForTimeout(2000);
    await dismissDouyinLoginWall(page);
    await startDouyinPlayback(page);
    await page.waitForTimeout(5000);
    const domHints = await collectDouyinMediaHints(page);
    candidates.push(...domHints);
  } finally {
    await context.close();
  }
  const unique = [];
  const seen = new Set();
  for (const item of candidates) {
    const key = item.url.replace(/&dy_q=[^&]+/i, "");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  unique.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "audio" ? -1 : 1;
    if (a.resourceType !== b.resourceType) {
      if (a.resourceType === "media") return -1;
      if (b.resourceType === "media") return 1;
    }
    return (b.contentLength || 0) - (a.contentLength || 0);
  });
  return unique;
}

async function collectDouyinMediaHints(page) {
  return page.evaluate(() => {
    const results = [];
    const push = (url, kind = "video", source = "dom") => {
      if (!url || typeof url !== "string") return;
      if (url.startsWith("blob:")) return;
      if (!/https?:\/\//i.test(url)) return;
      results.push({
        url,
        kind,
        contentType: "",
        contentLength: 0,
        status: 0,
        resourceType: source,
        headers: {},
      });
    };

    for (const video of Array.from(document.querySelectorAll("video"))) {
      push(video.currentSrc || video.src || "", "video", "video");
      for (const source of Array.from(video.querySelectorAll("source"))) {
        push(source.src || source.getAttribute("src") || "", "video", "source");
      }
    }

    for (const entry of performance.getEntriesByType("resource")) {
      const name = entry.name || "";
      if (!/https?:\/\//i.test(name)) continue;
      if (!/video|audio|m3u8|playwm|playurl|aweme|snssdk|douyinvod|byte|stream|segment|manifest/i.test(name)) continue;
      push(name, /audio/i.test(name) ? "audio" : "video", "performance");
    }

    return results;
  });
}

async function clickFirstMatch(page, selectors, timeout = 1200) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: "visible", timeout });
      await locator.click({ timeout, force: true });
      return true;
    } catch {}
  }
  return false;
}

async function dismissDouyinLoginWall(page) {
  const selectors = [
    'button:has-text("取消")',
    'button:has-text("关闭")',
    'button:has-text("稍后")',
    'button:has-text("以后再说")',
    'button:has-text("下次再说")',
    'button:has-text("暂不")',
    'button:has-text("我知道了")',
    '[role="button"]:has-text("取消")',
    '[role="button"]:has-text("关闭")',
    '[role="button"]:has-text("稍后")',
    '[role="button"]:has-text("以后再说")',
    '[role="button"]:has-text("下次再说")',
    '[role="button"]:has-text("暂不")',
    '[role="button"]:has-text("我知道了")',
    'a:has-text("取消")',
    'a:has-text("关闭")',
    'a:has-text("稍后")',
    'a:has-text("以后再说")',
    'a:has-text("下次再说")',
    'a:has-text("暂不")',
  ];
  await clickFirstMatch(page, selectors, 1000);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(800);
}

async function startDouyinPlayback(page) {
  const selectors = [
    'button:has-text("播放")',
    '[aria-label*="播放"]',
    '[class*="play"]',
    'video',
  ];
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: "visible", timeout: 1200 });
      await locator.click({ timeout: 1200, force: true }).catch(() => {});
      break;
    } catch {}
  }
  try {
    await page.mouse.click(680, 450);
  } catch {}
  try {
    await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll("video"));
      for (const video of videos) {
        try {
          video.muted = true;
          video.play?.();
        } catch {}
      }
    });
  } catch {}
  await page.keyboard.press("Space").catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
}

async function downloadMedia(media, url, awemeId) {
  if (!media?.url) throw new Error("没有捕获到可下载的媒体地址。");
  await ensureMediaDir();
  const baseName = `douyin_${awemeId || Date.now()}_${media.kind}_${Date.now()}`;
  const sourcePath = join(mediaDir, `${baseName}.mp4`);
  const wavPath = join(mediaDir, `${baseName}.wav`);
  const response = await fetch(media.url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      Referer: url,
      Range: "bytes=0-",
    },
  });
  if (!response.ok && response.status !== 206) throw new Error(`媒体下载失败：${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 64 * 1024) throw new Error("下载到的媒体文件过小，可能已过期或被平台拦截。");
  await writeFile(sourcePath, buffer);
  await runCommand(ffmpegPath, ["-y", "-i", sourcePath, "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", wavPath]);
  return { sourcePath, wavPath, bytes: buffer.length };
}

async function transcribeAudio(wavPath) {
  const outputPath = `${wavPath}.json`;
  await runCommand(pythonCommand, [join(root, "transcribe.py"), wavPath, outputPath, whisperModel], {
    cwd: root,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  const payload = JSON.parse(await readFile(outputPath, "utf8"));
  return payload;
}

async function transcribeDouyin(url) {
  const awemeId = getDouyinAwemeId(url);
  try {
    const mediaCandidates = await captureDouyinMedia(url);
    const media = mediaCandidates.find((item) => item.kind === "audio") || mediaCandidates[0];
    if (!media) throw new Error("没有捕获到视频音频流，请确认该抖音链接可以在网页端播放。");
    const files = await downloadMedia(media, url, awemeId);
    const transcript = await transcribeAudio(files.wavPath);
    return {
      ok: true,
      sourceUrl: url,
      awemeId,
      method: "audio-asr",
      media: {
        kind: media.kind,
        contentType: media.contentType,
        contentLength: media.contentLength,
        savedBytes: files.bytes,
      },
      files,
      transcript,
    };
  } catch (error) {
    const subtitle = await ocrDouyinSubtitles(url);
    return {
      ok: true,
      sourceUrl: url,
      awemeId,
      method: "subtitle-ocr",
      media: null,
      files: null,
      transcript: subtitle.transcript,
      subtitleFrames: subtitle.frames || [],
      fallbackError: error.message || "音频流提取失败，已改为字幕识别",
    };
  }
}

async function ocrDouyinSubtitles(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1365, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  });
  const page = await context.newPage();
  const frames = [];
  page.on("dialog", async (dialog) => {
    try {
      await dialog.dismiss();
    } catch {}
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await dismissDouyinLoginWall(page);
    await startDouyinPlayback(page);
    await page.waitForTimeout(1500);
    await captureSubtitleFrames(page, frames);
    if (frames.length < 2) {
      await page.waitForTimeout(1500);
      await captureSubtitleFrames(page, frames);
    }
  } finally {
    await context.close();
  }

  if (!frames.length) {
    throw new Error("没有识别到可用字幕画面");
  }

  const subtitleText = await transcribeSubtitleFrames(frames);
  const cleaned = cleanText(subtitleText);
  if (cleaned.length < 20) {
    throw new Error("字幕识别结果过短，未能提取到有效文案");
  }

  return {
    ok: true,
    sourceUrl: url,
    method: "subtitle-ocr",
    transcript: {
      text: cleaned,
      model: "rapidocr-onnxruntime",
      segments: [],
      duration: 0,
    },
    frames,
  };
}

async function captureSubtitleFrames(page, frames) {
  const viewport = page.viewportSize() || { width: 1365, height: 900 };
  const shot = await page.screenshot({
    clip: {
      x: 0,
      y: Math.floor(viewport.height * 0.42),
      width: viewport.width,
      height: Math.ceil(viewport.height * 0.58),
    },
  });
  await ensureMediaDir();
  const baseName = `douyin_subtitle_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const pngPath = join(mediaDir, `${baseName}.png`);
  await writeFile(pngPath, shot);
  frames.push(pngPath);
}

async function transcribeSubtitleFrames(framePaths) {
  const scriptPath = join(root, "ocr_subtitles.py");
  const outputPath = join(mediaDir, `ocr_${Date.now()}_${Math.random().toString(16).slice(2)}.json`);
  await runCommand(pythonCommand, [scriptPath, outputPath, ...framePaths], {
    cwd: root,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  const payload = JSON.parse(await readFile(outputPath, "utf8"));
  return payload.text || "";
}

async function fetchPage(url) {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("只支持 http 或 https 链接");

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

    if (!response.ok) throw new Error(`页面返回 ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    if (!/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error("链接不是可解析文本页面");
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

async function extractUrlContent(url, timing = createTiming(), onProgress = () => {}) {
  if (!url) throw new Error("缺少链接");

  if (/douyin\.com/i.test(url)) {
    onProgress("读取抖音页面信息");
    const [douyin, rendered] = await timedStep(timing, "douyin-page-metadata", async () =>
      Promise.all([fetchDouyinMetadata(url), renderDouyinPage(url)])
    );
    const result = rendered || douyin || { title: "", text: "", sourceUrl: url, extractor: "douyin-asr" };

    onProgress("提取音频并转写逐字稿");
    let transcription;
    let fullTranscript = "";
    let transcriptSource = "audio";
    try {
      transcription = await timedStep(timing, "douyin-asr-transcribe", () => transcribeDouyin(url));
      fullTranscript = cleanText(transcription.transcript?.text || "");
    } catch (error) {
      timing.steps.push({ name: "douyin-asr-failed", ms: 0, ok: false, error: error.message });
      onProgress("音频失败，改为识别字幕");
      const subtitle = await timedStep(timing, "douyin-subtitle-ocr", () => ocrDouyinSubtitles(url));
      transcription = subtitle;
      fullTranscript = cleanText(subtitle.transcript?.text || "");
      transcriptSource = "subtitle-ocr";
    }
    if (fullTranscript.length < 20) {
      throw new Error("逐字稿内容过短，未能提取到有效文案");
    }

    return {
      ...result,
      text: fullTranscript,
      fullTranscript,
      transcriptMeta: {
        source: transcriptSource,
        model: transcription.transcript?.model || whisperModel,
        duration: transcription.transcript?.duration || 0,
        segments: transcription.transcript?.segments?.length || 0,
        media: transcription.media,
        frames: transcription.frames?.length || 0,
      },
      sourceType: "douyin",
      timing,
    };
  }

  onProgress("读取网页正文");
  const html = await timedStep(timing, "fetch-page", () => fetchPage(url));
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

function buildDynamicViewpointPrompt({ sourceText, sourceType, transcriptMeta }) {
  const isTranscript = sourceType === "douyin" || sourceType === "social" || transcriptMeta?.source === "faster-whisper";
  const typeLabel = isTranscript ? "短视频口播逐字稿" : sourceType === "page" ? "网页文章" : "粘贴正文";
  return [
    `素材类型：${typeLabel}`,
    "",
    "请先在内部完成 ASR 转写纠错，再把素材提炼成知识总结卡片。",
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
    "- 纠正明显 ASR 错字、同音词、断句问题和概念误写。",
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
            content: "你是知识提炼助手，擅长纠正中文口播 ASR 错字，并把内容去情绪化、去营销化，压缩成可复用知识卡片。",
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

  if (req.method === "POST" && url.pathname === "/api/douyin/transcribe") {
    try {
      const body = await readJsonBody(req);
      const target = String(body.url || "").trim();
      if (!target) {
        send(res, 400, { error: "缺少链接" });
        return;
      }
      send(res, 200, await transcribeDouyin(target));
    } catch (error) {
      send(res, 500, { error: error.message || "转写失败" });
    }
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
