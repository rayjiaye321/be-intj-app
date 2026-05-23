import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const tempRoot = await mkdtemp(join(tmpdir(), "be-intj-check-"));
const port = String(4900 + Math.floor(Math.random() * 600));
const password = "112233";
const baseUrl = `http://127.0.0.1:${port}`;

let server;
let cookie = "";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {}),
    },
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const raw = await response.text();
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { raw };
  }
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} failed: ${response.status} ${raw}`);
  return body;
}

async function waitForServer() {
  for (let index = 0; index < 80; index += 1) {
    try {
      await request("/api/auth/status");
      return;
    } catch {
      await wait(150);
    }
  }
  throw new Error("server did not start");
}

async function main() {
  server = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: port,
      APP_PASSWORD: password,
      KIMI_API_KEY: "",
      BE_INTJ_DATA_DIR: tempRoot,
    },
    stdio: "ignore",
  });

  await waitForServer();

  await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });

  const card = {
    id: "self-check-card",
    sourceType: "text",
    coreKnowledge: "主题：自检\n观点1：服务端卡片接口可以保存、分类、备份和恢复。",
    caseText: "自检脚本创建一张卡片，执行备份、分类改名、删除和恢复。",
    category: "自检",
  };

  let payload = await request("/api/cards", {
    method: "POST",
    body: JSON.stringify({ card }),
  });
  if (payload.cards.length !== 1) throw new Error("card save failed");

  payload = await request("/api/backups", { method: "POST", body: JSON.stringify({}) });
  const manualBackupId = payload.backup?.id;
  if (!manualBackupId) throw new Error("manual backup failed");

  payload = await request("/api/cards/categories/rename", {
    method: "POST",
    body: JSON.stringify({ from: "自检", to: "自检已改名" }),
  });
  if (payload.changed !== 1 || payload.cards[0].category !== "自检已改名") throw new Error("category rename failed");

  payload = await request("/api/cards/self-check-card", { method: "DELETE" });
  if (payload.cards.length !== 0) throw new Error("delete failed");

  payload = await request(`/api/backups/${encodeURIComponent(manualBackupId)}/restore`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (payload.cards.length !== 1 || payload.cards[0].category !== "自检") throw new Error("restore failed");

  payload = await request("/api/backups");
  if (!Array.isArray(payload.backups) || payload.backups.length < 3) throw new Error("automatic backups missing");

  console.log("self-check passed");
}

try {
  await main();
} finally {
  if (server) server.kill();
  await rm(tempRoot, { recursive: true, force: true });
}
