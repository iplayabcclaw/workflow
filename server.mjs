import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import mysql from 'mysql2/promise';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of (await readFile(envFile, 'utf8')).split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
const DATA_DIR = join(ROOT, 'data');
const UPLOAD_DIR = join(DATA_DIR, 'uploads');
const RESULT_DIR = join(DATA_DIR, 'results');
const SUBMIT_URL = 'https://autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_image_audio_to_video_v2_15s';
const TEXT_SUBMIT_URL = 'https://autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_lightx2v_no_pic';
const RESULT_URL = 'https://autodl.art/api/v1/comfyui/comfyui_workflow/result/';
const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60000);
const MAX_SEED = 999_999_999_999_999;
function launchFolder(folder) {
  if (process.platform === 'win32') {
    // /select forces Explorer to resolve the path in the interactive desktop.
    execFile('explorer.exe', ['/select,', folder], { windowsHide: false }, () => {});
    return;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(command, [folder], () => {});
}
const TOKEN = process.env.AUTODL_TOKEN;
const db = mysql.createPool({ host: process.env.MYSQL_HOST || '127.0.0.1', port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE || 'minimax_h3_workflow', waitForConnections: true, connectionLimit: 5, charset: 'utf8mb4' });

await Promise.all([mkdir(UPLOAD_DIR, { recursive: true }), mkdir(RESULT_DIR, { recursive: true })]);
await db.execute(`CREATE TABLE IF NOT EXISTS video_tasks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id VARCHAR(100) UNIQUE NOT NULL,
  prompt TEXT NOT NULL,
  duration INTEGER NOT NULL,
  resolution VARCHAR(30) NOT NULL,
  seed VARCHAR(32) NULL,
  image_path TEXT NULL,
  audio_path TEXT,
  status VARCHAR(30) NOT NULL,
  remote_response JSON NOT NULL,
  result_json JSON NULL,
  downloaded_files JSON NULL,
  workflow_type VARCHAR(30) NOT NULL DEFAULT 'image_audio',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}
function contentType(file) {
  return file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8';
}
function resultContentType(file) {
  const extension = file.split('.').pop()?.toLowerCase();
  return ({ mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[extension] || 'application/octet-stream';
}
function localFileContentType(file) {
  const extension = file.split('.').pop()?.toLowerCase();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp3: 'audio/mpeg', mpeg: 'audio/mpeg', mpga: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg' })[extension] || 'application/octet-stream';
}
async function localFileDataUrl(file) {
  if (!file || !existsSync(file)) return null;
  return `data:${localFileContentType(file)};base64,${(await readFile(file)).toString('base64')}`;
}
function filePathList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed; } catch { /* legacy single path */ }
    return [value];
  }
  return [];
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 35 * 1024 * 1024) throw new Error('文件或请求超过 35MB'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function randomSeed() { return Math.floor(Math.random() * MAX_SEED) + 1; }
function headers() {
  if (!TOKEN) throw new Error('服务器未配置 AUTODL_TOKEN');
  return { Authorization: TOKEN, 'Content-Type': 'application/json' };
}
async function saveDataUrl(dataUrl, prefix) {
  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!match) throw new Error('上传文件格式无效');
  const subtype = match[1].split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
  const name = `${prefix}-${Date.now()}-${crypto.randomUUID()}.${subtype}`;
  const path = join(UPLOAD_DIR, name);
  await writeFile(path, Buffer.from(match[2], 'base64'));
  return path;
}
function decodeJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  let decoded = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  if (typeof decoded === 'string') {
    try { decoded = JSON.parse(decoded); } catch { return fallback; }
  }
  if (typeof decoded === 'string') {
    try { decoded = JSON.parse(decoded); } catch { return fallback; }
  }
  return decoded;
}
function row(task) {
  const remoteResponse = decodeJson(task.remote_response, {});
  const resultJson = decodeJson(task.result_json, null);
  const downloadedFiles = decodeJson(task.downloaded_files, []);
  return { ...task, remote_response: remoteResponse, result_json: resultJson, downloaded_files: Array.isArray(downloadedFiles) ? downloadedFiles : [] };
}
function remoteUrls(value, found = []) {
  if (typeof value === 'string' && /^https?:\/\//.test(value)) found.push(value);
  else if (Array.isArray(value)) value.forEach(x => remoteUrls(x, found));
  else if (value && typeof value === 'object') Object.values(value).forEach(x => remoteUrls(x, found));
  return [...new Set(found)];
}
function submissionLogPayload(payload) {
  const summary = { ...payload };
  for (const key of ['ref_image_0', 'ref_audio_0']) {
    if (!summary[key]) continue;
    const [prefix] = String(summary[key]).split(',', 1);
    summary[key] = { data_url_prefix: prefix, characters: String(summary[key]).length };
  }
  return summary;
}
async function downloadResults(taskId, result) {
  const urls = remoteUrls(result?.data?.results ?? result?.results);
  console.log('[poll:download] result URLs', { taskId, urls });
  const folder = join(RESULT_DIR, taskId);
  await mkdir(folder, { recursive: true });
  const files = [];
  for (let i = 0; i < urls.length; i++) {
    console.log('[poll:download] downloading', { taskId, index: i, url: urls[i] });
    const response = await fetch(urls[i]);
    if (!response.ok) throw new Error(`下载结果失败 (${response.status})`);
    const rawName = basename(new URL(urls[i]).pathname) || `result-${i}`;
    const file = join(folder, `${i}-${rawName.replace(/[^\w.-]/g, '_')}`);
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    files.push(file);
    console.log('[poll:download] saved', { taskId, index: i, file });
  }
  return files;
}
function parseStoredJson(value, fallback, taskId, field) {
  console.log('[poll:stored] field', { taskId, field, type: typeof value, isBuffer: Buffer.isBuffer(value), value });
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  let parsed = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  try { parsed = JSON.parse(parsed); } catch { throw new Error(`数据库字段 ${field} 不是有效 JSON`); }
  // Some MySQL drivers/configurations return a JSON string containing JSON text.
  if (typeof parsed === 'string') {
    if (parsed === '') return fallback;
    try { parsed = JSON.parse(parsed); } catch { throw new Error(`数据库字段 ${field} 的嵌套 JSON 无效`); }
  }
  console.log('[poll:stored] parsed', { taskId, field, parsed });
  return parsed;
}
async function pollOne(task) {
  const queryUrl = RESULT_URL + encodeURIComponent(task.task_id);
  console.log('[poll:request] begin', { taskId: task.task_id, queryUrl, previousStatus: task.status });
  const response = await fetch(queryUrl, { headers: headers() });
  const raw = await response.text();
  console.log('[poll:response] raw', { taskId: task.task_id, httpStatus: response.status, contentType: response.headers.get('content-type'), body: raw });
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error(`查询接口返回了空或非 JSON 响应（HTTP ${response.status}）`); }
  console.log('[poll:response] parsed', { taskId: task.task_id, result });
  if (!response.ok || result.code !== 'Success') throw new Error(result.msg || `查询失败 (${response.status})`);
  const status = result.data?.status || task.status;
  console.log('[poll:status]', { taskId: task.task_id, status, results: result.data?.results });
  let files = parseStoredJson(task.downloaded_files, [], task.task_id, 'downloaded_files');
  if (status === 'SUCCESS' && files.length === 0) files = await downloadResults(task.task_id, result);
  await db.execute('UPDATE video_tasks SET status=?, result_json=?, downloaded_files=? WHERE task_id=?', [status, JSON.stringify(result), JSON.stringify(files), task.task_id]);
  console.log('[poll:database] updated', { taskId: task.task_id, status, files });
}
async function pollPending() {
  if (!TOKEN) return;
  const [tasks] = await db.query("SELECT * FROM video_tasks WHERE status IN ('QUEUED','RUNNING')");
  console.log('[poll] pending tasks', { count: tasks.length, taskIds: tasks.map(task => task.task_id) });
  for (const task of tasks) try { await pollOne(task); } catch (error) { console.error('[poll:error]', { taskId: task.task_id, message: error.message, stack: error.stack }); }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { configured: Boolean(TOKEN), poll_interval_ms: POLL_INTERVAL_MS });
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const [tasks] = await db.query('SELECT * FROM video_tasks ORDER BY id DESC LIMIT 100');
      tasks.map(row);
      return json(res, 200, tasks);
    }
    if (req.method === 'POST' && url.pathname === '/api/tasks') {
      const input = await body(req);
      if (!input.prompt?.trim()) throw new Error('请填写提示词');
      if (!['image_audio', 'text'].includes(input.workflow_type)) throw new Error('不支持的工作流类型');
      const duration = Number(input.duration);
      if (!Number.isInteger(duration) || duration < 1 || duration > 15) throw new Error('时长需为 1–15 秒');
      const isTextWorkflow = input.workflow_type === 'text';
      if (!['768p横', '768p竖'].includes(input.resolution)) throw new Error('画幅仅支持 768p横 或 768p竖');
      const seed = isTextWorkflow ? null : (input.seed === '' || input.seed === undefined || input.seed === null ? randomSeed() : Number(input.seed));
      if (!isTextWorkflow && (!Number.isSafeInteger(seed) || seed < 1 || seed > MAX_SEED)) throw new Error(`seed 必须是 1–${MAX_SEED} 的整数`);
      let imageDataUrls = !isTextWorkflow ? (Array.isArray(input.image_data_urls) ? input.image_data_urls : input.image_data_url ? [input.image_data_url] : []) : [];
      let audioDataUrls = !isTextWorkflow ? (Array.isArray(input.audio_data_urls) ? input.audio_data_urls : input.audio_data_url ? [input.audio_data_url] : []) : [];
      let imagePaths = await Promise.all(imageDataUrls.map(image => saveDataUrl(image, 'image')));
      let audioPaths = await Promise.all(audioDataUrls.map(audio => saveDataUrl(audio, 'audio')));
      if (!isTextWorkflow && input.reuse_task_id) {
        if (!/^[a-f0-9-]{36}$/i.test(input.reuse_task_id)) throw new Error('复用任务 ID 无效');
        const [sourceRows] = await db.execute('SELECT image_path, audio_path FROM video_tasks WHERE task_id=?', [input.reuse_task_id]);
        const source = sourceRows[0];
        if (!source) throw new Error('复用的历史任务不存在');
        if (imageDataUrls.length === 0 && source.image_path) { const sourcePaths = filePathList(source.image_path); imageDataUrls = await Promise.all(sourcePaths.map(localFileDataUrl)); imagePaths = sourcePaths; }
        if (audioDataUrls.length === 0 && source.audio_path) { const sourcePaths = filePathList(source.audio_path); audioDataUrls = await Promise.all(sourcePaths.map(localFileDataUrl)); audioPaths = sourcePaths; }
        if (source.image_path && imageDataUrls.some(image => !image)) throw new Error('历史参考图片已不在本地');
        if (source.audio_path && audioDataUrls.some(audio => !audio)) throw new Error('历史参考音频已不在本地');
      }
      const payload = isTextWorkflow
        ? { prompt: input.prompt.trim(), duration, resolution: input.resolution }
        : { duration, prompt: input.prompt.trim(), resolution: input.resolution, seed };
      imageDataUrls.forEach((image, index) => { if (image) payload[`ref_image_${index}`] = image; });
      audioDataUrls.forEach((audio, index) => { if (audio) payload[`ref_audio_${index}`] = audio; });
      const submitUrl = isTextWorkflow ? TEXT_SUBMIT_URL : SUBMIT_URL;
      console.log('[submit:request]', { workflow: input.workflow_type, url: submitUrl, payload: submissionLogPayload(payload) });
      const remote = await fetch(submitUrl, { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
      const rawResponse = await remote.text();
      console.log('[submit:response:raw]', { workflow: input.workflow_type, httpStatus: remote.status, contentType: remote.headers.get('content-type'), body: rawResponse });
      let response;
      try { response = JSON.parse(rawResponse); } catch { return json(res, 502, { error: `提交接口返回了空或非 JSON 响应（HTTP ${remote.status}）` }); }
      console.log('[submit:response:parsed]', { workflow: input.workflow_type, response });
      if (!remote.ok || response.code !== 'Success' || !response.data?.task_id) {
        const safePayload = { ...payload };
        for (const key of ['ref_image_0', 'ref_audio_0']) if (safePayload[key]) safePayload[key] = '[base64 文件内容已省略]';
        return json(res, 422, { error: response.msg || `提交失败 (${remote.status})`, request_payload: safePayload, remote_response: response });
      }
      await db.execute('INSERT INTO video_tasks (task_id,prompt,duration,resolution,seed,image_path,audio_path,status,remote_response,workflow_type) VALUES (?,?,?,?,?,?,?,?,?,?)', [response.data.task_id, payload.prompt, duration, payload.resolution, isTextWorkflow ? null : payload.seed, imagePaths.length ? JSON.stringify(imagePaths) : null, audioPaths.length ? JSON.stringify(audioPaths) : null, response.data.status || 'QUEUED', JSON.stringify(response), input.workflow_type]);
      return json(res, 201, { task_id: response.data.task_id, status: response.data.status || 'QUEUED' });
    }
    if (req.method === 'POST' && /^\/api\/tasks\/[^/]+\/refresh$/.test(url.pathname)) {
      const taskId = decodeURIComponent(url.pathname.split('/')[3]);
      const [rows] = await db.execute('SELECT * FROM video_tasks WHERE task_id=?', [taskId]);
      const task = rows[0];
      if (!task) return json(res, 404, { error: '任务不存在' });
      await pollOne(task);
      const [updated] = await db.execute('SELECT * FROM video_tasks WHERE task_id=?', [taskId]);
      return json(res, 200, row(updated[0]));
    }
    if (req.method === 'POST' && /^\/api\/tasks\/[^/]+\/open-folder$/.test(url.pathname)) {
      const taskId = decodeURIComponent(url.pathname.split('/')[3]);
      if (!/^[a-f0-9-]{36}$/i.test(taskId)) return json(res, 400, { error: '任务 ID 无效' });
      const folder = join(RESULT_DIR, taskId);
      if (!existsSync(folder)) return json(res, 404, { error: '该任务尚未下载任何本地文件' });
      launchFolder(folder);
      return json(res, 200, { folder });
    }
    if (req.method === 'GET' && /^\/api\/tasks\/[^/]+\/retry-data$/.test(url.pathname)) {
      const taskId = decodeURIComponent(url.pathname.split('/')[3]);
      if (!/^[a-f0-9-]{36}$/i.test(taskId)) return json(res, 400, { error: '任务 ID 无效' });
      const [rows] = await db.execute('SELECT * FROM video_tasks WHERE task_id=?', [taskId]);
      const original = rows[0];
      if (!original) return json(res, 404, { error: '原任务不存在' });
      const workflowType = original.workflow_type || 'image_audio';
      const imagePaths = filePathList(original.image_path);
      const audioPaths = filePathList(original.audio_path);
      return json(res, 200, { task_id: taskId, workflow_type: workflowType, prompt: original.prompt, duration: original.duration, resolution: original.resolution, seed: workflowType === 'text' ? null : Number(original.seed), image_name: imagePaths[0] ? basename(imagePaths[0]) : null, image_names: imagePaths.map(file => basename(file)), audio_name: audioPaths[0] ? basename(audioPaths[0]) : null, audio_names: audioPaths.map(file => basename(file)), can_reuse_image: imagePaths.length > 0 && imagePaths.every(file => existsSync(file)), can_reuse_audio: audioPaths.length > 0 && audioPaths.every(file => existsSync(file)) });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      const relativePath = decodeURIComponent(url.pathname.slice('/files/'.length));
      const path = join(DATA_DIR, relativePath);
      if (!path.startsWith(DATA_DIR) || !existsSync(path)) return json(res, 404, { error: '文件不存在' });
      res.writeHead(200, { 'content-type': resultContentType(path), 'content-disposition': `inline; filename="${basename(path)}"` });
      return res.end(await readFile(path));
    }
    if (req.method === 'GET') {
      const name = url.pathname === '/' ? 'public/index.html' : `public${url.pathname}`;
      const path = join(ROOT, name);
      if (path.startsWith(join(ROOT, 'public')) && existsSync(path)) { res.writeHead(200, { 'content-type': contentType(path) }); return res.end(await readFile(path)); }
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) { console.error(error); return json(res, 400, { error: error.message || '请求失败' }); }
});

server.listen(PORT, () => console.log(`Open http://localhost:${PORT}  | token: ${TOKEN ? 'configured' : 'missing'}`));
setInterval(pollPending, POLL_INTERVAL_MS).unref();
pollPending();
