# INTJ 知识卡片

手机端 PWA + Node 云后端。手机负责访问、操作和本地卡片保存；服务器负责链接提取、抖音音频处理、Whisper 转写和 Kimi 提炼。

## 运行结构

- 前端：`index.html`、`app.js`、`styles.css`、`sw.js`
- 后端：`server.js`
- 转写脚本：`transcribe.py`
- 部署脚本：`deploy/setup-ubuntu.sh`
- Nginx 示例：`deploy/nginx.be-intj.conf`
- PM2 配置：`ecosystem.config.cjs`

卡片目前仍保存在手机浏览器 localStorage。换手机前需要在“整理”页面导出备份，再在新手机导入。

## 本地运行

```bash
npm install
copy .env.example .env
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
```

本地如果要转写抖音视频，还需要安装 ffmpeg，并确认 `.env` 里的 `FFMPEG_PATH` 指向可执行文件。Windows 示例：`FFMPEG_PATH=C:\ffmpeg\bin\ffmpeg.exe`。

## GitHub 私有仓库

建议先在 GitHub 新建一个 private repository，然后在本机项目目录执行：

```bash
git init
git add .
git commit -m "Initial deployable app"
git branch -M main
git remote add origin <your-private-repo-url>
git push -u origin main
```

不要提交这些内容：

- `.env`
- `node_modules/`
- `data/`
- `.playwright-mcp/`
- 日志文件

这些已写入 `.gitignore`。

## 阿里云轻量服务器部署

推荐 Ubuntu 22.04/24.04。最低 2 核 4G；经常处理长视频建议 4 核 8G。

阿里云控制台需要开放：

- `22`：SSH 登录
- `80`：HTTP
- `443`：HTTPS
- `4173`：临时测试端口，Nginx 配好后可以关闭

登录服务器后执行：

```bash
git clone <your-private-repo-url>
cd be-intj
bash deploy/setup-ubuntu.sh
cp .env.example .env
nano .env
```

`.env` 示例：

```env
PORT=4173
APP_PASSWORD=你的6位数字密码
KIMI_API_KEY=你的Kimi Key
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MODEL=kimi-k2.6
FFMPEG_PATH=ffmpeg
PYTHON=.venv/bin/python
WHISPER_MODEL=base
```

启动：

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

测试服务器本机访问：

```bash
curl http://127.0.0.1:4173
```

临时用手机访问：

```text
http://服务器公网IP:4173
```

## Nginx 反向代理

用 80 端口访问时，复制配置：

```bash
sudo cp deploy/nginx.be-intj.conf /etc/nginx/sites-available/be-intj
sudo ln -s /etc/nginx/sites-available/be-intj /etc/nginx/sites-enabled/be-intj
sudo nginx -t
sudo systemctl reload nginx
```

然后访问：

```text
http://服务器公网IP
```

如果以后绑定域名，把 `deploy/nginx.be-intj.conf` 里的 `server_name _;` 改成你的域名。

中国内地服务器绑定域名正式访问通常需要 ICP 备案。备案完成后，配置 DNS A 记录指向服务器公网 IP，再申请 HTTPS 证书。

## 更新

服务器更新代码：

```bash
cd be-intj
git pull
npm install
pm2 restart be-intj
```

如果改了前端文件，要同步提升 `sw.js` 的 `CACHE_NAME`，避免手机继续使用旧缓存。

## 安全说明

- 登录密码由服务器 `.env` 里的 `APP_PASSWORD` 控制，前端代码不保存密码。
- `APP_PASSWORD` 必须是 6 位数字。生产环境没有配置时，登录会失败并提示服务器配置错误。
- Kimi API Key 只放服务器 `.env`，手机端不保存。
- 所有 `/api/*` 接口都需要先登录，登录态通过 HttpOnly cookie 保存。
- `data/` 会保存临时音频和转写文件，默认不提交 Git。

## 常用排错

查看服务状态：

```bash
pm2 status
pm2 logs be-intj
```

确认端口：

```bash
curl http://127.0.0.1:4173
```

确认 Nginx：

```bash
sudo nginx -t
sudo systemctl status nginx
```

手机打不开时，优先检查阿里云防火墙是否开放了对应端口。

Kimi 不可用时，检查 `.env` 里的 `KIMI_API_KEY`、`KIMI_BASE_URL`、`KIMI_MODEL`，然后在 App 设置页点“测试连接”。
