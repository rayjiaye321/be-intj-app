# 部署与维护清单

当前方案：手机端 PWA + 云服务器后端。手机只负责访问和操作，服务器负责网页正文提取、Kimi 提炼、卡片同步和数据保存。

## 当前部署目标

- 系统：Ubuntu
- 运行环境：Node.js 20+
- 进程管理：PM2
- 项目目录：`/home/ubuntu/be-intj-app`
- 测试地址：`http://服务器公网IP:4173`

## 首次安装

在服务器终端执行：

```bash
sudo apt update
sudo apt install -y git curl nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

拉取代码并配置：

```bash
git clone <你的私有仓库地址> /home/ubuntu/be-intj-app
cd /home/ubuntu/be-intj-app
cp .env.example .env
nano .env
npm install
npx playwright install --with-deps chromium
pm2 start ecosystem.config.cjs
pm2 save
```

`.env` 里至少需要：

```env
PORT=4173
APP_PASSWORD=你的6位数字密码
KIMI_API_KEY=你的Kimi API Key
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MODEL=kimi-k2.6
```

## 日常更新

服务器上执行：

```bash
cd /home/ubuntu/be-intj-app
git pull origin main
npm install
pm2 restart be-intj
```

然后手机和电脑各刷新一次页面。

## 快速检查

```bash
git rev-parse --short HEAD
pm2 show be-intj
curl http://127.0.0.1:4173/api/auth/status
```

预期结果：

- `pm2 show be-intj` 显示进程在线。
- `/api/auth/status` 能返回 JSON。
- 未登录访问 `/api/cards` 应返回 401。
- 登录后 `/api/cards` 返回同一份卡片列表。

## 数据说明

卡片保存在服务器：

```text
data/cards.json
```

Kimi 设置保存在服务器：

```text
data/server-settings.json
```

`data/` 已被 `.gitignore` 忽略，代码更新不会覆盖卡片库。

## 当前注意事项

- 视频平台提取已移除，当前只支持网页文章和粘贴正文。
- Kimi 不可用时会直接提示并停止，不使用本地规则替代。
- PWA 缓存版本更新后，手机端需要刷新一次才能拿到最新页面。
