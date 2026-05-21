# 阿里云轻量服务器上线操作清单

目标：把当前项目按“PWA + 云后端”上线。手机负责访问和操作，阿里云轻量服务器负责链接解析、抖音处理、Whisper 转写和 Kimi 提炼。

## 1. 先准备账号和材料

- [你来做] 打开阿里云控制台首页：<https://home.console.aliyun.com/>
- [你来做] 打开轻量应用服务器产品页：<https://www.aliyun.com/product/swas>
- [你来做] 完成阿里云账号注册、实名认证、付款方式绑定。
- [你来做] 准备手机号、身份证信息、常用邮箱、6 位数字密码、Kimi API Key、域名。

成功标志：能正常登录阿里云控制台。

## 2. 建 GitHub 私有仓库

- [你来做] 打开 GitHub 新建仓库页：<https://github.com/new>
- [你来做] 仓库名建议：`be-intj`。
- [你来做] 选择 `Private`。
- [我来做] 我会继续帮你整理仓库应保留哪些文件、哪些不要上传。
- [你来做] 本机执行上传命令。

本机命令：

```bash
git init
git add .
git commit -m "Initial deployable app"
git branch -M main
git remote add origin <你的GitHub私有仓库地址>
git push -u origin main
```

成功标志：GitHub 上能看到项目文件，但看不到 `.env`、`data/`、`node_modules/`。

## 3. 先在本地确认项目可跑

- [我来做] 检查代码、启动逻辑、PWA、登录、Kimi 设置页、卡片保存、离线查找。
- [你来做] 用手机连同一个 Wi‑Fi，打开电脑局域网地址测试页面。
- [你来做] 如果手机打不开，先看地址写得对不对，再看电脑防火墙。

成功标志：手机能打开页面，能登录，能提取内容，能保存卡片。

## 4. 购买阿里云轻量服务器

- [你来做] 在阿里云控制台里找“轻量应用服务器”。
- [你来做] 购买时建议选 Ubuntu 22.04 或 24.04。
- [你来做] 规格建议：最低 2 核 4G；经常转写长视频建议 4 核 8G。
- [你来做] 先用中国内地地域，后面正式绑定域名要备案。

成功标志：你拿到服务器公网 IP 和登录方式。

## 5. 配防火墙

- [你来做] 打开轻量服务器控制台，找到服务器卡片。
- [你来做] 点击“防火墙”。
- [你来做] 放行 `22`、`80`、`443`。
- [你来做] 先测试时可以临时放行 `4173`，上线后再关掉。

成功标志：端口规则和部署方案一致。

## 6. 在服务器上安装运行环境

- [你来做] 用 SSH 连上服务器。
- [你来做] 执行：

```bash
sudo apt update
sudo apt install -y git curl ffmpeg python3 python3-pip python3-venv nginx
```

- [你来做] 如果没有 Node.js 20+，再安装 Node。

成功标志：服务器里有 `git`、`ffmpeg`、`python3`、`nginx`、`node`。

## 7. 拉代码和配置文件

- [你来做] 在服务器上拉 GitHub 私有仓库：

```bash
git clone <你的GitHub私有仓库地址>
cd be-intj
```

- [你来做] 复制环境文件：

```bash
cp .env.example .env
```

- [你来做] 编辑 `.env`：

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

成功标志：`.env` 已保存。

## 8. 安装依赖并启动

- [你来做] 在服务器项目目录执行：

```bash
bash deploy/setup-ubuntu.sh
npm install
npx playwright install --with-deps chromium
python3 -m venv .venv
source .venv/bin/activate
pip install faster-whisper
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

成功标志：`pm2 status` 里能看到 `be-intj` 在运行。

## 9. 先用 IP 访问

- [你来做] 手机浏览器打开：

```text
http://服务器公网IP:4173
```

- [你来做] 先登录，再试 Kimi 设置页，再试链接提取。

成功标志：手机能正常打开并操作。

## 10. 再上 Nginx 和 80 端口

- [你来做] 执行：

```bash
sudo cp deploy/nginx.be-intj.conf /etc/nginx/sites-available/be-intj
sudo ln -s /etc/nginx/sites-available/be-intj /etc/nginx/sites-enabled/be-intj
sudo nginx -t
sudo systemctl reload nginx
```

- [你来做] 然后访问：

```text
http://服务器公网IP
```

成功标志：不带端口也能打开页面。

## 11. 域名、备案、HTTPS

- [你来做] 把域名解析到服务器公网 IP。
- [你来做] 中国内地服务器正式绑定域名前，要走 ICP 备案。
- [你来做] 备案通过后申请 HTTPS 证书。

成功标志：`https://你的域名` 能打开。

## 12. 后续更新和维护

- [你来做] 更新时执行：

```bash
cd be-intj
git pull
npm install
pm2 restart be-intj
```

- [我来做] 如果前端改了，我会提醒你同步更新 `sw.js` 的缓存版本。

## 我负责的部分

- 代码改造和清理
- 后端认证、Kimi 配置持久化、PWA 兼容
- 部署脚本、PM2、Nginx 配置
- 检查日志和排错
- 给你写每一步命令

## 你负责的部分

- 阿里云账号、实名认证、买服务器
- 购买域名
- ICP 备案
- 提供服务器公网 IP、登录方式
- 在服务器上实际执行命令，或给我 SSH 访问
- Kimi API Key、6 位密码的最终值
- 手机端实际打开确认效果

