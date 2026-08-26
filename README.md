# MiniMax H3 视频生成工作流

一个 Node.js 服务。它会把图片（及可选音频）转为 data URL 调用 AUTODL 的 H3 工作流；收到 `task_id` 后保存提示词、原始上传文件和任务信息到本机 MySQL。后台每 15 秒查询 `QUEUED` / `RUNNING` 任务。成功后会立刻下载 `results` 内的 URL 到本地，防止临时链接失效。

## 启动

```bash
npm install
cp .env.example .env
# 编辑 .env，填写 AUTODL 与 MySQL 凭据
npm start
```

访问 `http://localhost:3000`。任务数据在 MySQL，上传文件和下载结果在 `data/`。

MySQL 连接信息和 AUTODL 令牌从未提交的 `.env` 读取，不发送给浏览器。

## 接口约定

- 提交：`POST /api/tasks`。服务端会在请求头加入 `Authorization` 和 `Content-Type: application/json`。
- 查询：`GET https://autodl.art/api/v1/comfyui/comfyui_workflow/result/{task_id}`，由后端定时调用。
- 可选音频按 `ref_audio_0` 发送。若目标接口实际字段名不同，只需修改 [server.mjs](server.mjs) 中这一行即可。

令牌只留在服务端 `.env` 中，不会写入数据库或发送给浏览器。
