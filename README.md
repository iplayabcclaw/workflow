# MiniMax H3 视频工作流

一个可直接部署的单体 Node.js 应用：浏览器页面、登录鉴权、用户管理、视频任务接口和后台轮询运行在同一个进程中。MySQL 保存用户和任务，上传素材与生成结果保存在本机 `data/`。

## 主要能力

- Cookie 登录会话：密码使用 Node.js `scrypt` 哈希；登录 Cookie 为 `HttpOnly`、`SameSite=Lax` 的 HMAC 签名令牌。
- 角色鉴权：任务、素材和结果文件接口均需要登录；普通用户仅能访问自己的任务，管理员可查看所有任务并创建用户。
- 积分：管理员可设置用户积分并查看扣除日志；视频仅在生成成功后按“时长 × 900”扣除积分，GPT‑Image2 仅在生成成功后扣除 1000 积分，失败不扣。
- GPT‑Image2：通过 GRSAI 异步生图接口提交与轮询，支持参考图和服务商规格选择；成功后仅保存并展示服务商返回的图片地址，不下载图片到本机。
- 单体部署：不需要单独部署前端，也不会将 AUTODL Token 发给浏览器。
- 启动时自动建表和创建初始管理员；未归属的历史任务仅管理员可见。

## 启动

```bash
npm ci
cp .env.example .env
# 编辑 .env：至少填写 MySQL、AUTODL_TOKEN、AUTH_SECRET 和初始管理员账号密码
npm run check
npm start
```

访问 `http://localhost:3000`，使用 `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` 登录。管理员可在页面中的“用户管理”创建普通用户或管理员；密码至少需要 8 位。

生产环境请设置 `NODE_ENV=production`，使用 HTTPS 反向代理，并为 `AUTH_SECRET` 生成高熵随机值（如 `openssl rand -hex 32`）。初始管理员只会在用户名不存在时创建；不要提交 `.env`。

## 项目结构

```text
server.mjs        HTTP 入口、任务领域逻辑与路由
src/auth.mjs      密码哈希、会话令牌与 Cookie
src/http.mjs      HTTP 响应和请求体工具
public/           同仓库静态页面
test/             不依赖数据库的安全单元测试
data/             运行时上传与下载文件（不提交）
```

## 常用命令

```bash
npm run dev
npm run check
npm test
```
