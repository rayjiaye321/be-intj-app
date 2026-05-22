# INTJ 知识卡片

手机端 PWA + Node 后端。手机负责访问、操作和本地卡片保存；服务器负责网页文章、公众号文章和粘贴正文的提炼。

## 运行结构

- 前端：`index.html`、`app.js`、`styles.css`、`sw.js`
- 后端：`server.js`
- 部署脚本：`deploy/setup-ubuntu.sh`
- Nginx 示例：`deploy/nginx.be-intj.conf`
- PM2 配置：`ecosystem.config.cjs`

## 本地运行

```bash
npm install
npm start
```

打开：

```text
http://127.0.0.1:4173
```

`.env` 必填：

```env
APP_PASSWORD=123456
KIMI_API_KEY=replace-with-your-kimi-api-key
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MODEL=kimi-k2.6
```

## GitHub 私有仓库

```bash
git init
git add .
git commit -m "Initial deployable app"
git branch -M main
git remote add origin <your-private-repo-url>
git push -u origin main
```

不要提交：

- `.env`
- `node_modules/`
- `data/`
- `.playwright-mcp/`
- 日志文件

## 阿里云轻量服务器部署

推荐 Ubuntu 22.04/24.04。最低 2 核 4G。
控制台放行：`22`、`80`、`443`。

服务器上执行：

```bash
git clone <your-private-repo-url>
cd be-intj
chmod +x deploy/setup-ubuntu.sh
bash deploy/setup-ubuntu.sh
cp .env.example .env
nano .env
npm install
npx playwright install --with-deps chromium
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

`.env` 示例：

```env
PORT=4173
APP_PASSWORD=你的6位数字密码
KIMI_API_KEY=你的Kimi Key
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MODEL=kimi-k2.6
```

测试：

```bash
curl http://127.0.0.1:4173
```

手机先访问：

```text
http://服务器公网IP:4173
```

## Nginx

```bash
sudo cp deploy/nginx.be-intj.conf /etc/nginx/sites-available/be-intj
sudo ln -s /etc/nginx/sites-available/be-intj /etc/nginx/sites-enabled/be-intj
sudo nginx -t
sudo systemctl reload nginx
```

## 更新

```bash
cd be-intj
git pull
npm install
pm2 restart be-intj
```

## 说明

- 登录密码由服务器 `.env` 控制。
- Kimi Key 只放服务器端。
- 卡片保存在手机浏览器本地。
- 当前仅支持网页文章、公众号文章和直接粘贴正文。
