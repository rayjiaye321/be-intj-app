# INTJ 知识卡片

手机端 PWA + Node 后端。用于把网页文章或直接粘贴的正文提炼成极简知识卡片，并在手机端和电脑端共用同一份服务端卡片库。

## 当前能力

- 服务端密码登录。
- Kimi API 配置保存到服务器。
- 网页文章正文提取。
- 直接粘贴正文提炼。
- 卡片统一保存到服务端，手机和电脑同步。
- 已加载过的卡片会保留在浏览器本地，断网时可继续查看旧卡片。

## 卡片结构

公开卡片只保留三项：

- 核心知识点
- 案例
- 分类

来源链接、原始正文等只作为后台元数据保存，不作为卡片列表展示内容。

## 本地运行

```bash
npm install
cp .env.example .env
npm start
```

打开：

```text
http://127.0.0.1:4173
```

## 环境变量

```env
PORT=4173
APP_PASSWORD=your-6-digit-password
KIMI_API_KEY=replace-with-your-kimi-api-key
KIMI_BASE_URL=https://api.moonshot.cn/v1
KIMI_MODEL=kimi-k2.6
```

## 服务器更新

```bash
cd /home/ubuntu/be-intj-app
git pull origin main
npm install
pm2 restart be-intj
```

更新后，手机和电脑页面各刷新一次，让新的 PWA 缓存生效。

## 数据位置

- 卡片库：`data/cards.json`
- Kimi 配置：`data/server-settings.json`

`data/` 目录不会提交到 GitHub，更新代码不会覆盖服务器上的卡片数据。
