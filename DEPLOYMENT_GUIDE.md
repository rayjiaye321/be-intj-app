# 阿里云轻量服务器上线路线

目标：把当前项目作为 PWA + 云后端跑起来。手机负责使用，服务器负责网页文章、公众号文章和粘贴正文的提炼。

## 1. 先准备账号和资源

- [你来做] 打开阿里云控制台：`https://home.console.aliyun.com/`
- [你来做] 购买轻量应用服务器，推荐 Ubuntu 22.04 或 24.04
- [你来做] 准备 6 位数字密码和 Kimi API Key
- [你来做] 记录服务器公网 IP 和登录方式

## 2. 创建 GitHub 私有仓库

- [你来做] 打开 GitHub 新建仓库：`https://github.com/new`
- [你来做] 仓库设为 `Private`
- [我可独立完成] 整理代码结构，确保可部署

## 3. 服务器放行端口

- `22`：SSH 登录
- `80`：HTTP
- `443`：HTTPS
- 临时测试可以先开 `4173`

## 4. 服务器安装

```bash
sudo apt update
sudo apt install -y git curl nginx
```

如果没有 Node.js 20+，再装 Node。

## 5. 拉代码和配置

```bash
git clone <your-private-repo-url>
cd be-intj
cp .env.example .env
nano .env
```

`.env` 内容：

```env
PORT=4173
APP_PASSWORD=你的6位数字密码
KIMI_API_KEY=你的Kimi Key
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MODEL=kimi-k2.6
```

## 6. 安装依赖并启动

```bash
npm install
npx playwright install --with-deps chromium
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## 7. 先用 IP 打开

手机浏览器访问：

```text
http://服务器公网IP:4173
```

先确认能登录、能提炼网页文章、能粘贴正文提炼。

## 8. Nginx

```bash
sudo cp deploy/nginx.be-intj.conf /etc/nginx/sites-available/be-intj
sudo ln -s /etc/nginx/sites-available/be-intj /etc/nginx/sites-enabled/be-intj
sudo nginx -t
sudo systemctl reload nginx
```

## 9. 更新

```bash
cd be-intj
git pull
npm install
pm2 restart be-intj
```

## 我可以做

- 改代码
- 清理配置
- 写部署命令
- 排查日志
- 判断是代码问题还是部署问题

## 你需要做

- 阿里云账号、实名、买服务器
- GitHub 私有仓库创建
- 服务器登录和执行命令
- 提供公网 IP、密码、Kimi Key
