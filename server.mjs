import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import mysql from 'mysql2/promise';
import COS from 'cos-nodejs-sdk-v5';
import { authIsConfigured, clearSessionCookie, createSessionToken, hashPassword, publicUser, readSession, sessionCookie, verifyPassword } from './src/auth.mjs';
import { body, contentType, json } from './src/http.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of (await readFile(envFile, 'utf8')).split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
const DATA_DIR = join(ROOT, 'data');
const RESULT_DIR = join(DATA_DIR, 'results');
const IMAGE_RESULT_DIR = join(DATA_DIR, 'image-results');
const SUBMIT_URL = 'https://autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_image_audio_to_video_v2_15s';
const TEXT_SUBMIT_URL = 'https://autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_lightx2v_no_pic';
const RESULT_URL = 'https://autodl.art/api/v1/comfyui/comfyui_workflow/result/';
const GRSAI_SUBMIT_URL = process.env.GRSAI_IMAGE_ENDPOINT || process.env.GRASI_IMAGE_ENDPOINT || 'https://grsai.dakka.com.cn/v1/draw/completions';
const GRSAI_RESULT_URL = process.env.GRSAI_IMAGE_RESULT_ENDPOINT || process.env.GRASI_IMAGE_RESULT_ENDPOINT || 'https://grsai.dakka.com.cn/v1/draw/result';
const GRSAI_TOKEN = process.env.GRSAI_IMAGE_API_KEY || process.env.GRASI_IMAGE_API_KEY;
const COS_REGION = process.env.COS_REGION;
const COS_BUCKET = process.env.COS_BUCKET;
const COS_SECRET_ID = process.env.COS_SECRET_ID;
const COS_SECRET_KEY = process.env.COS_SECRET_KEY;
const COS_URL = process.env.COS_URL?.replace(/\/+$/, '');
const COS_UPLOAD_PREFIX = (process.env.COS_UPLOAD_PREFIX || 'h3-workflow').replace(/^\/+|\/+$/g, '');
const VIDEO_POINTS_PER_SECOND = 900;
const IMAGE_POINTS_PER_TASK = 1000;
const REGISTRATION_BONUS_POINTS = 10_000;
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
const cos = COS_REGION && COS_BUCKET && COS_SECRET_ID && COS_SECRET_KEY ? new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY }) : null;

await Promise.all([mkdir(RESULT_DIR, { recursive: true }), mkdir(IMAGE_RESULT_DIR, { recursive: true })]);
if (!authIsConfigured()) throw new Error('请在 .env 中配置 AUTH_SECRET、INITIAL_ADMIN_USERNAME 和 INITIAL_ADMIN_PASSWORD');
if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(process.env.INITIAL_ADMIN_USERNAME)) throw new Error('INITIAL_ADMIN_USERNAME 需为 3–64 位字母、数字或 ._-');
if (process.env.INITIAL_ADMIN_PASSWORD.length < 8) throw new Error('INITIAL_ADMIN_PASSWORD 至少需要 8 位');
await db.execute(`CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  role ENUM('admin','user') NOT NULL DEFAULT 'user',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
try { await db.execute('ALTER TABLE users ADD COLUMN points_balance BIGINT NOT NULL DEFAULT 0'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
await db.execute(`CREATE TABLE IF NOT EXISTS points_ledger (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  delta BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  type VARCHAR(30) NOT NULL,
  reference_id VARCHAR(100) NULL,
  note VARCHAR(255) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_points_reference (type, reference_id),
  KEY idx_points_ledger_user_created (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
const [adminRows] = await db.execute('SELECT id FROM users WHERE username=?', [process.env.INITIAL_ADMIN_USERNAME]);
if (!adminRows.length) {
  await db.execute('INSERT INTO users (username,password_hash,display_name,role) VALUES (?,?,?,?)', [process.env.INITIAL_ADMIN_USERNAME, await hashPassword(process.env.INITIAL_ADMIN_PASSWORD), process.env.INITIAL_ADMIN_USERNAME, 'admin']);
  console.log(`Initial administrator created: ${process.env.INITIAL_ADMIN_USERNAME}`);
}
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
  user_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
try { await db.execute('ALTER TABLE video_tasks ADD COLUMN user_id BIGINT UNSIGNED NULL'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
try { await db.execute('ALTER TABLE video_tasks ADD COLUMN points_cost INTEGER NOT NULL DEFAULT 0'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
try { await db.execute('ALTER TABLE video_tasks ADD COLUMN points_charged_at DATETIME NULL'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
const [taskIndexes] = await db.execute("SHOW INDEX FROM video_tasks WHERE Key_name='idx_video_tasks_user_created'");
if (!taskIndexes.length) await db.execute('CREATE INDEX idx_video_tasks_user_created ON video_tasks (user_id, created_at)');
await db.execute(`CREATE TABLE IF NOT EXISTS image_tasks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id VARCHAR(100) UNIQUE NOT NULL,
  prompt TEXT NOT NULL,
  aspect_ratio VARCHAR(30) NOT NULL,
  image_path TEXT NULL,
  status VARCHAR(30) NOT NULL,
  remote_response JSON NOT NULL,
  result_json JSON NULL,
  downloaded_files JSON NULL,
  points_cost INTEGER NOT NULL DEFAULT 1000,
  points_charged_at DATETIME NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_image_tasks_user_created (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
try { await db.execute('ALTER TABLE image_tasks ADD COLUMN points_cost INTEGER NOT NULL DEFAULT 1000'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }
try { await db.execute('ALTER TABLE image_tasks ADD COLUMN points_charged_at DATETIME NULL'); } catch (error) { if (error.code !== 'ER_DUP_FIELDNAME') throw error; }

function resultContentType(file) {
  const extension = file.split('.').pop()?.toLowerCase();
  return ({ mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[extension] || 'application/octet-stream';
}
function localFileContentType(file) {
  const extension = file.split('.').pop()?.toLowerCase();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp3: 'audio/mpeg', mpeg: 'audio/mpeg', mpga: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg' })[extension] || 'application/octet-stream';
}
function isRemoteUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
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
function randomSeed() { return Math.floor(Math.random() * MAX_SEED) + 1; }
function headers() {
  if (!TOKEN) throw new Error('服务器未配置 AUTODL_TOKEN');
  return { Authorization: TOKEN, 'Content-Type': 'application/json' };
}
function grsaiHeaders() {
  if (!GRSAI_TOKEN) throw new Error('服务器未配置 GRSAI_IMAGE_API_KEY');
  return { Authorization: `Bearer ${GRSAI_TOKEN}`, 'Content-Type': 'application/json' };
}
function cosPublicUrl(key) {
  if (!COS_URL) throw new Error('服务器未配置 COS_URL');
  return `${COS_URL}/${key.split('/').map(encodeURIComponent).join('/')}`;
}
async function uploadDataUrlToCos(dataUrl, prefix) {
  if (!cos || !COS_URL) throw new Error('服务器未完整配置 COS（COS_REGION、COS_BUCKET、COS_SECRET_ID、COS_SECRET_KEY、COS_URL）');
  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!match) throw new Error('上传文件格式无效');
  const subtype = match[1].split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
  const datePart = new Date().toISOString().slice(0, 10).replaceAll('-', '/');
  const key = `${COS_UPLOAD_PREFIX}/${prefix}/${datePart}/${crypto.randomUUID()}.${subtype}`;
  await new Promise((resolve, reject) => cos.putObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: key, Body: Buffer.from(match[2], 'base64'), ContentType: match[1] }, (error) => error ? reject(error) : resolve()));
  return cosPublicUrl(key);
}
async function reusableReferenceUrls(paths) {
  return Promise.all(paths.map(async path => isRemoteUrl(path) ? path : localFileDataUrl(path)));
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
  const { image_path, audio_path, user_id, remote_response, result_json, ...safeTask } = task;
  return { ...safeTask, remote_response: remoteResponse, result_json: resultJson, downloaded_files: Array.isArray(downloadedFiles) ? downloadedFiles : [] };
}
function imageRow(task) {
  const { image_path, remote_response, result_json, downloaded_files, ...safeTask } = task;
  return { ...safeTask, remote_response: decodeJson(remote_response, {}), result_json: decodeJson(result_json, null), downloaded_files: filePathList(downloaded_files) };
}
function ledgerRow(record) {
  const type = String(record.type || '');
  const isImage = type === 'image_success';
  const isVideo = type === 'video_success';
  const request = isImage
    ? { model: 'gpt-image-2', prompt: record.image_prompt || '', aspectRatio: record.image_aspect_ratio || '', reference_images: filePathList(decodeJson(record.image_reference_paths, [])) }
    : isVideo
      ? { workflow_type: record.video_workflow_type || '', prompt: record.video_prompt || '', duration: record.video_duration || null, resolution: record.video_resolution || '', reference_images: filePathList(decodeJson(record.video_image_paths, [])), reference_audio: filePathList(decodeJson(record.video_audio_paths, [])) }
      : { action: type === 'register_bonus' ? '新用户注册赠送积分' : '管理员设置积分', note: record.note || '' };
  const resultUrls = isImage
    ? filePathList(decodeJson(record.image_downloaded_files, []))
    : isVideo
      ? remoteUrls(decodeJson(record.video_result_json, {}))
      : [];
  const isRegistrationBonus = type === 'register_bonus';
  return { ...record, model_name: isImage ? 'gpt-image-2' : isVideo ? `MiniMax H3 · ${record.video_workflow_type || '视频'}` : isRegistrationBonus ? '新用户注册赠送' : '管理员设置积分', result_type: isImage || isVideo ? '成功' : '已设置', completion_seconds: isImage || isVideo ? Number(record.completion_seconds || 0) : null, request, result_urls: resultUrls };
}
function canAccessTask(user, task) {
  return user.role === 'admin' || Number(task.user_id) === Number(user.id);
}
function taskScope(user) {
  return user.role === 'admin' ? { clause: '', values: [] } : { clause: ' WHERE user_id=?', values: [user.id] };
}
async function reservedPoints(executor, userId) {
  const [videoRows] = await executor.execute("SELECT COALESCE(SUM(points_cost),0) AS total FROM video_tasks WHERE user_id=? AND points_charged_at IS NULL AND status IN ('SUBMITTING','QUEUED','RUNNING')", [userId]);
  const [imageRows] = await executor.execute("SELECT COALESCE(SUM(points_cost),0) AS total FROM image_tasks WHERE user_id=? AND points_charged_at IS NULL AND status IN ('QUEUED','RUNNING')", [userId]);
  return Number(videoRows[0]?.total || 0) + Number(imageRows[0]?.total || 0);
}
async function findAccessibleTask(user, taskId) {
  const [rows] = await db.execute('SELECT * FROM video_tasks WHERE task_id=?', [taskId]);
  const task = rows[0];
  return task && canAccessTask(user, task) ? task : null;
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
  if (status === 'SUCCESS') await settleVideoPoints(task.task_id);
  console.log('[poll:database] updated', { taskId: task.task_id, status, files });
}
async function settleVideoPoints(taskId) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [tasks] = await connection.execute('SELECT * FROM video_tasks WHERE task_id=? FOR UPDATE', [taskId]);
    const task = tasks[0];
    if (!task || task.status !== 'SUCCESS' || task.points_charged_at || !task.user_id || !task.points_cost) { await connection.commit(); return; }
    const [users] = await connection.execute('SELECT id,points_balance FROM users WHERE id=? FOR UPDATE', [task.user_id]);
    const account = users[0];
    if (!account) throw new Error('任务所属用户不存在');
    const balance = Number(account.points_balance) - Number(task.points_cost);
    await connection.execute('UPDATE users SET points_balance=? WHERE id=?', [balance, task.user_id]);
    await connection.execute('INSERT INTO points_ledger (user_id,delta,balance_after,type,reference_id,note) VALUES (?,?,?,?,?,?)', [task.user_id, -Number(task.points_cost), balance, 'video_success', task.task_id, `视频生成成功，${task.duration} 秒 × ${VIDEO_POINTS_PER_SECOND} 积分`]);
    await connection.execute('UPDATE video_tasks SET points_charged_at=NOW() WHERE task_id=?', [taskId]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}
function grsaiTaskId(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const result = payload?.result && typeof payload.result === 'object' ? payload.result : {};
  return String(payload?.id || payload?.task_id || payload?.taskId || data.id || data.task_id || data.taskId || result.id || '').trim();
}
function normalizeImageStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['succeeded', 'success', 'done', 'completed', 'complete'].includes(status)) return 'SUCCESS';
  if (['failed', 'fail', 'error', 'cancelled', 'canceled'].includes(status)) return 'FAILED';
  return 'RUNNING';
}
async function pollImageOne(task) {
  const response = await fetch(GRSAI_RESULT_URL, { method: 'POST', headers: grsaiHeaders(), body: JSON.stringify({ id: task.task_id }) });
  const raw = await response.text();
  let result; try { result = JSON.parse(raw); } catch { throw new Error(`生图查询接口返回非 JSON 响应（HTTP ${response.status}）`); }
  if (!response.ok || (Number.isFinite(Number(result.code)) && Number(result.code) !== 0)) throw new Error(result.msg || `生图查询失败 (${response.status})`);
  const data = result.data && typeof result.data === 'object' ? result.data : result;
  const status = normalizeImageStatus(data.status || result.status);
  let resultUrls = filePathList(task.downloaded_files);
  if (status === 'SUCCESS' && !resultUrls.length) resultUrls = remoteUrls(result?.data?.results ?? result?.data ?? result?.results ?? result);
  if (status === 'SUCCESS' && !resultUrls.length) throw new Error('生图任务成功但未返回图片下载地址');
  await db.execute('UPDATE image_tasks SET status=?, result_json=?, downloaded_files=? WHERE task_id=?', [status, JSON.stringify(result), JSON.stringify(resultUrls), task.task_id]);
  if (status === 'SUCCESS') await settleImagePoints(task.task_id);
}
async function settleImagePoints(taskId) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [tasks] = await connection.execute('SELECT * FROM image_tasks WHERE task_id=? FOR UPDATE', [taskId]);
    const task = tasks[0];
    if (!task || task.status !== 'SUCCESS' || task.points_charged_at || !task.points_cost) { await connection.commit(); return; }
    const [users] = await connection.execute('SELECT id,points_balance FROM users WHERE id=? FOR UPDATE', [task.user_id]);
    const account = users[0];
    if (!account) throw new Error('任务所属用户不存在');
    const balance = Number(account.points_balance) - Number(task.points_cost);
    await connection.execute('UPDATE users SET points_balance=? WHERE id=?', [balance, task.user_id]);
    await connection.execute('INSERT INTO points_ledger (user_id,delta,balance_after,type,reference_id,note) VALUES (?,?,?,?,?,?)', [task.user_id, -Number(task.points_cost), balance, 'image_success', task.task_id, 'GPT-Image2 生成成功，扣除 1000 积分']);
    await connection.execute('UPDATE image_tasks SET points_charged_at=NOW() WHERE task_id=?', [taskId]);
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}
async function pollPending() {
  if (!TOKEN) return;
  const [tasks] = await db.query("SELECT * FROM video_tasks WHERE status IN ('QUEUED','RUNNING')");
  console.log('[poll] pending tasks', { count: tasks.length, taskIds: tasks.map(task => task.task_id) });
  for (const task of tasks) try { await pollOne(task); } catch (error) { console.error('[poll:error]', { taskId: task.task_id, message: error.message, stack: error.stack }); }
}
async function settlePendingVideoPoints() {
  const [tasks] = await db.query("SELECT task_id FROM video_tasks WHERE status='SUCCESS' AND points_charged_at IS NULL AND points_cost > 0");
  for (const task of tasks) try { await settleVideoPoints(task.task_id); } catch (error) { console.error('[points:settle-error]', { taskId: task.task_id, message: error.message }); }
}
async function settlePendingImagePoints() {
  const [tasks] = await db.query("SELECT task_id FROM image_tasks WHERE status='SUCCESS' AND points_charged_at IS NULL AND points_cost > 0");
  for (const task of tasks) try { await settleImagePoints(task.task_id); } catch (error) { console.error('[points:image-settle-error]', { taskId: task.task_id, message: error.message }); }
}
async function pollPendingImages() {
  if (!GRSAI_TOKEN) return;
  const [tasks] = await db.query("SELECT * FROM image_tasks WHERE status IN ('QUEUED','RUNNING')");
  for (const task of tasks) try { await pollImageOne(task); } catch (error) { console.error('[image-poll:error]', { taskId: task.task_id, message: error.message }); }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const input = await body(req);
      const username = String(input.username || '').trim();
      const password = String(input.password || '');
      const [users] = await db.execute('SELECT * FROM users WHERE username=?', [username]);
      const user = users[0];
      if (!user || !(await verifyPassword(password, user.password_hash))) return json(res, 401, { error: '用户名或密码错误' });
      return json(res, 200, { user: publicUser(user) }, { 'set-cookie': sessionCookie(createSessionToken(user)) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      const input = await body(req);
      const username = String(input.username || '').trim();
      const password = String(input.password || '');
      const displayName = String(input.display_name || username).trim();
      if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) throw new Error('用户名需为 3–64 位字母、数字或 ._-');
      if (password.length < 8) throw new Error('密码至少 8 位');
      if (!displayName || displayName.length > 100) throw new Error('显示名称需为 1–100 位');
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const [created] = await connection.execute('INSERT INTO users (username,password_hash,display_name,role,points_balance) VALUES (?,?,?,?,?)', [username, await hashPassword(password), displayName, 'user', REGISTRATION_BONUS_POINTS]);
        await connection.execute('INSERT INTO points_ledger (user_id,delta,balance_after,type,note) VALUES (?,?,?,?,?)', [created.insertId, REGISTRATION_BONUS_POINTS, REGISTRATION_BONUS_POINTS, 'register_bonus', '新用户注册赠送积分']);
        const [users] = await connection.execute('SELECT * FROM users WHERE id=?', [created.insertId]);
        await connection.commit();
        return json(res, 201, { user: publicUser(users[0]) }, { 'set-cookie': sessionCookie(createSessionToken(users[0])) });
      } catch (error) {
        await connection.rollback();
        if (error.code === 'ER_DUP_ENTRY') return json(res, 409, { error: '用户名已存在' });
        throw error;
      } finally { connection.release(); }
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') return json(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie() });
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { configured: Boolean(TOKEN), grsai_configured: Boolean(GRSAI_TOKEN), cos_configured: Boolean(cos && COS_URL), auth_configured: authIsConfigured(), poll_interval_ms: POLL_INTERVAL_MS });
    if (req.method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/files/')) {
      const name = url.pathname === '/' ? 'public/index.html' : `public${url.pathname}`;
      const path = resolve(ROOT, name);
      if (path.startsWith(resolve(ROOT, 'public') + '/') && existsSync(path)) {
        res.writeHead(200, { 'content-type': contentType(path) });
        return res.end(await readFile(path));
      }
      return json(res, 404, { error: 'Not found' });
    }
    const session = readSession(req);
    if (!session) return json(res, 401, { error: '请先登录' });
    const [currentUsers] = await db.execute('SELECT * FROM users WHERE id=?', [session.sub]);
    const user = currentUsers[0];
    if (!user) return json(res, 401, { error: '当前用户不存在，请重新登录' }, { 'set-cookie': clearSessionCookie() });
    if (req.method === 'GET' && url.pathname === '/api/auth/me') return json(res, 200, { user: publicUser(user) });
    if (req.method === 'POST' && url.pathname === '/api/users') {
      if (user.role !== 'admin') return json(res, 403, { error: '仅管理员可创建用户' });
      const input = await body(req);
      const username = String(input.username || '').trim();
      const password = String(input.password || '');
      const displayName = String(input.display_name || username).trim();
      const role = input.role === 'admin' ? 'admin' : 'user';
      if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(username)) throw new Error('用户名需为 3–64 位字母、数字或 ._-');
      if (password.length < 8) throw new Error('密码至少 8 位');
      if (!displayName || displayName.length > 100) throw new Error('显示名称需为 1–100 位');
      try {
        const [created] = await db.execute('INSERT INTO users (username,password_hash,display_name,role) VALUES (?,?,?,?)', [username, await hashPassword(password), displayName, role]);
        const [users] = await db.execute('SELECT * FROM users WHERE id=?', [created.insertId]);
        return json(res, 201, { user: publicUser(users[0]) });
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return json(res, 409, { error: '用户名已存在' });
        throw error;
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/users') {
      if (user.role !== 'admin') return json(res, 403, { error: '仅管理员可查看用户' });
      const [users] = await db.query('SELECT id,username,display_name,role,points_balance,created_at FROM users ORDER BY id DESC');
      return json(res, 200, users);
    }
    if (req.method === 'PUT' && /^\/api\/users\/\d+\/points$/.test(url.pathname)) {
      if (user.role !== 'admin') return json(res, 403, { error: '仅管理员可设置积分' });
      const userId = Number(url.pathname.split('/')[3]);
      const input = await body(req);
      const points = Number(input.points);
      const note = String(input.note || '').trim();
      if (!Number.isSafeInteger(points) || points < 0) throw new Error('积分必须是非负整数');
      if (note.length > 255) throw new Error('备注不能超过 255 个字符');
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const [accounts] = await connection.execute('SELECT * FROM users WHERE id=? FOR UPDATE', [userId]);
        const account = accounts[0];
        if (!account) { await connection.rollback(); return json(res, 404, { error: '用户不存在' }); }
        const before = Number(account.points_balance || 0);
        await connection.execute('UPDATE users SET points_balance=? WHERE id=?', [points, userId]);
        await connection.execute('INSERT INTO points_ledger (user_id,delta,balance_after,type,note,created_by) VALUES (?,?,?,?,?,?)', [userId, points - before, points, 'admin_set', note || '管理员设置积分', user.id]);
        await connection.commit();
        return json(res, 200, { user_id: userId, points_balance: points });
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    }
    if (req.method === 'GET' && url.pathname === '/api/points/records') {
      const type = String(url.searchParams.get('type') || '').trim();
      if (type && type !== 'deduction') return json(res, 400, { error: '不支持的流水类型' });
      if (type === 'deduction' && user.role !== 'admin') return json(res, 403, { error: '仅管理员可查看积分扣除日志' });
      if (type === 'deduction') {
        const [records] = await db.execute(`SELECT p.*,u.display_name,u.username,
          COALESCE(v.task_id,i.task_id,p.reference_id) AS task_id,
          COALESCE(TIMESTAMPDIFF(SECOND,v.created_at,v.updated_at),TIMESTAMPDIFF(SECOND,i.created_at,i.updated_at)) AS completion_seconds,
          v.prompt AS video_prompt,v.duration AS video_duration,v.resolution AS video_resolution,v.seed AS video_seed,v.workflow_type AS video_workflow_type,v.image_path AS video_image_paths,v.audio_path AS video_audio_paths,v.result_json AS video_result_json,
          i.prompt AS image_prompt,i.aspect_ratio AS image_aspect_ratio,i.image_path AS image_reference_paths,i.downloaded_files AS image_downloaded_files
          FROM points_ledger p
          JOIN users u ON u.id=p.user_id
          LEFT JOIN video_tasks v ON p.type='video_success' AND v.task_id=p.reference_id
          LEFT JOIN image_tasks i ON p.type='image_success' AND i.task_id=p.reference_id
          WHERE p.type IN ('video_success','image_success','admin_set','register_bonus')
          ORDER BY p.id DESC LIMIT 200`);
        return json(res, 200, records.map(ledgerRow));
      }
      const targetUserId = user.role === 'admin' && /^\d+$/.test(url.searchParams.get('user_id') || '') ? Number(url.searchParams.get('user_id')) : user.id;
      const [records] = await db.execute('SELECT p.*,u.display_name,u.username FROM points_ledger p JOIN users u ON u.id=p.user_id WHERE p.user_id=? ORDER BY p.id DESC LIMIT 200', [targetUserId]);
      return json(res, 200, records);
    }
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const scope = taskScope(user);
      const [tasks] = await db.execute(`SELECT * FROM video_tasks${scope.clause} ORDER BY id DESC LIMIT 100`, scope.values);
      return json(res, 200, tasks.map(row));
    }
    if (req.method === 'GET' && url.pathname === '/api/image-tasks') {
      const scope = taskScope(user);
      const [tasks] = await db.execute(`SELECT * FROM image_tasks${scope.clause} ORDER BY id DESC LIMIT 100`, scope.values);
      return json(res, 200, tasks.map(imageRow));
    }
    if (req.method === 'POST' && url.pathname === '/api/image-tasks') {
      if (!GRSAI_TOKEN) throw new Error('服务器未配置 GRSAI_IMAGE_API_KEY');
      const input = await body(req);
      const prompt = String(input.prompt || '').trim();
      const aspectRatio = String(input.aspect_ratio || '').trim();
      const allowedRatios = ['auto', '1024x1024', '1672x941', '941x1672', '1443x1090', '1090x1443', '1536x1024', '1024x1536', '1408x1120', '1120x1408', '1920x832', '832x1920', '1792x896', '896x1792'];
      if (!prompt) throw new Error('请填写图片提示词');
      if (!allowedRatios.includes(aspectRatio)) throw new Error('不支持的图片规格');
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const [accounts] = await connection.execute('SELECT points_balance FROM users WHERE id=? FOR UPDATE', [user.id]);
        const balance = Number(accounts[0]?.points_balance || 0);
        const reserved = await reservedPoints(connection, user.id);
        if (balance - reserved < IMAGE_POINTS_PER_TASK) throw new Error(`积分不足：本次需要 ${IMAGE_POINTS_PER_TASK} 积分，当前可用 ${Math.max(0, balance - reserved)} 积分`);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
      const refs = Array.isArray(input.image_data_urls) ? input.image_data_urls : [];
      const imageUrls = await Promise.all(refs.map(image => uploadDataUrlToCos(image, 'gpt-image-reference')));
      const payload = { model: 'gpt-image-2', prompt, aspectRatio, webHook: '-1', shutProgress: false, ...(imageUrls.length ? { urls: imageUrls } : {}) };
      const remote = await fetch(GRSAI_SUBMIT_URL, { method: 'POST', headers: grsaiHeaders(), body: JSON.stringify(payload) });
      const raw = await remote.text();
      let response; try { response = JSON.parse(raw); } catch { return json(res, 502, { error: `生图提交接口返回非 JSON 响应（HTTP ${remote.status}）` }); }
      const taskId = grsaiTaskId(response);
      if (!remote.ok || (Number.isFinite(Number(response.code)) && Number(response.code) !== 0) || !taskId) return json(res, 422, { error: response.msg || `生图提交失败 (${remote.status})`, remote_response: response });
      const statusData = response.data && typeof response.data === 'object' ? response.data : response;
      const status = normalizeImageStatus(statusData.status || response.status);
      await db.execute('INSERT INTO image_tasks (task_id,prompt,aspect_ratio,image_path,status,remote_response,user_id,points_cost) VALUES (?,?,?,?,?,?,?,?)', [taskId, prompt, aspectRatio, imageUrls.length ? JSON.stringify(imageUrls) : null, status === 'SUCCESS' ? 'RUNNING' : status, JSON.stringify(response), user.id, IMAGE_POINTS_PER_TASK]);
      return json(res, 201, { task_id: taskId, status });
    }
    if (req.method === 'POST' && /^\/api\/image-tasks\/[^/]+\/refresh$/.test(url.pathname)) {
      const taskId = decodeURIComponent(url.pathname.split('/')[3]);
      const [tasks] = await db.execute('SELECT * FROM image_tasks WHERE task_id=?', [taskId]);
      const task = tasks[0];
      if (!task || !canAccessTask(user, task)) return json(res, 404, { error: '生图任务不存在' });
      await pollImageOne(task);
      const [updated] = await db.execute('SELECT * FROM image_tasks WHERE task_id=?', [taskId]);
      return json(res, 200, imageRow(updated[0]));
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
      let imagePaths = await Promise.all(imageDataUrls.map(image => uploadDataUrlToCos(image, 'video-reference-image')));
      let audioPaths = await Promise.all(audioDataUrls.map(audio => uploadDataUrlToCos(audio, 'video-reference-audio')));
      imageDataUrls = imagePaths;
      audioDataUrls = audioPaths;
      if (!isTextWorkflow && input.reuse_task_id) {
        if (!/^[a-f0-9-]{36}$/i.test(input.reuse_task_id)) throw new Error('复用任务 ID 无效');
        const source = await findAccessibleTask(user, input.reuse_task_id);
        if (!source) throw new Error('复用的历史任务不存在');
        const selectedReuseImageUrls = Array.isArray(input.reuse_image_urls) ? input.reuse_image_urls : null;
        if (imageDataUrls.length === 0 && source.image_path) {
          const sourcePaths = filePathList(source.image_path);
          const reusePaths = selectedReuseImageUrls === null ? sourcePaths : selectedReuseImageUrls;
          if (!reusePaths.every(path => typeof path === 'string' && sourcePaths.includes(path))) throw new Error('复用图片必须来自原任务');
          imageDataUrls = await reusableReferenceUrls(reusePaths);
          imagePaths = reusePaths;
        }
        if (audioDataUrls.length === 0 && source.audio_path) { const sourcePaths = filePathList(source.audio_path); audioDataUrls = await reusableReferenceUrls(sourcePaths); audioPaths = sourcePaths; }
        if (source.image_path && imageDataUrls.some(image => !image)) throw new Error('历史参考图片已不可用');
        if (source.audio_path && audioDataUrls.some(audio => !audio)) throw new Error('历史参考音频已不可用');
      }
      const payload = isTextWorkflow
        ? { prompt: input.prompt.trim(), duration, resolution: input.resolution }
        : { duration, prompt: input.prompt.trim(), resolution: input.resolution, seed };
      imageDataUrls.forEach((image, index) => { if (image) payload[`ref_image_${index}`] = image; });
      audioDataUrls.forEach((audio, index) => { if (audio) payload[`ref_audio_${index}`] = audio; });
      const pointsCost = duration * VIDEO_POINTS_PER_SECOND;
      const provisionalTaskId = crypto.randomUUID();
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        const [accounts] = await connection.execute('SELECT points_balance FROM users WHERE id=? FOR UPDATE', [user.id]);
        const balance = Number(accounts[0]?.points_balance || 0);
        const reserved = await reservedPoints(connection, user.id);
        if (balance - reserved < pointsCost) throw new Error(`积分不足：本次需要 ${pointsCost} 积分，当前可用 ${Math.max(0, balance - reserved)} 积分`);
        await connection.execute('INSERT INTO video_tasks (task_id,prompt,duration,resolution,seed,image_path,audio_path,status,remote_response,workflow_type,user_id,points_cost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [provisionalTaskId, payload.prompt, duration, payload.resolution, isTextWorkflow ? null : payload.seed, imagePaths.length ? JSON.stringify(imagePaths) : null, audioPaths.length ? JSON.stringify(audioPaths) : null, 'SUBMITTING', '{}', input.workflow_type, user.id, pointsCost]);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
      const submitUrl = isTextWorkflow ? TEXT_SUBMIT_URL : SUBMIT_URL;
      console.log('[submit:request]', { workflow: input.workflow_type, url: submitUrl, payload: submissionLogPayload(payload) });
      let remote;
      try { remote = await fetch(submitUrl, { method: 'POST', headers: headers(), body: JSON.stringify(payload) }); }
      catch (error) { await db.execute("UPDATE video_tasks SET status='SUBMIT_FAILED',remote_response=? WHERE task_id=?", [JSON.stringify({ error: error.message }), provisionalTaskId]); throw error; }
      const rawResponse = await remote.text();
      console.log('[submit:response:raw]', { workflow: input.workflow_type, httpStatus: remote.status, contentType: remote.headers.get('content-type'), body: rawResponse });
      let response;
      try { response = JSON.parse(rawResponse); } catch { await db.execute("UPDATE video_tasks SET status='SUBMIT_FAILED',remote_response=? WHERE task_id=?", [JSON.stringify({ raw: rawResponse }), provisionalTaskId]); return json(res, 502, { error: `提交接口返回了空或非 JSON 响应（HTTP ${remote.status}）` }); }
      console.log('[submit:response:parsed]', { workflow: input.workflow_type, response });
      if (!remote.ok || response.code !== 'Success' || !response.data?.task_id) {
        await db.execute("UPDATE video_tasks SET status='SUBMIT_FAILED',remote_response=? WHERE task_id=?", [JSON.stringify(response), provisionalTaskId]);
        const safePayload = { ...payload };
        for (const key of ['ref_image_0', 'ref_audio_0']) if (safePayload[key]) safePayload[key] = '[base64 文件内容已省略]';
        return json(res, 422, { error: response.msg || `提交失败 (${remote.status})`, request_payload: safePayload, remote_response: response });
      }
      await db.execute('UPDATE video_tasks SET task_id=?,status=?,remote_response=? WHERE task_id=?', [response.data.task_id, response.data.status || 'QUEUED', JSON.stringify(response), provisionalTaskId]);
      return json(res, 201, { task_id: response.data.task_id, status: response.data.status || 'QUEUED' });
    }
    if (req.method === 'POST' && /^\/api\/tasks\/[^/]+\/refresh$/.test(url.pathname)) {
      const taskId = decodeURIComponent(url.pathname.split('/')[3]);
      const task = await findAccessibleTask(user, taskId);
      if (!task) return json(res, 404, { error: '任务不存在' });
      await pollOne(task);
      const [updated] = await db.execute('SELECT * FROM video_tasks WHERE task_id=?', [taskId]);
      return json(res, 200, row(updated[0]));
    }
    if (req.method === 'POST' && /^\/api\/tasks\/[^/]+\/open-folder$/.test(url.pathname)) {
      if (user.role !== 'admin') return json(res, 403, { error: '仅管理员可在服务器上打开文件夹' });
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
      const original = await findAccessibleTask(user, taskId);
      if (!original) return json(res, 404, { error: '原任务不存在' });
      const workflowType = original.workflow_type || 'image_audio';
      const imagePaths = filePathList(original.image_path);
      const audioPaths = filePathList(original.audio_path);
      return json(res, 200, { task_id: taskId, workflow_type: workflowType, prompt: original.prompt, duration: original.duration, resolution: original.resolution, seed: workflowType === 'text' ? null : Number(original.seed), image_name: imagePaths[0] ? basename(imagePaths[0]) : null, image_names: imagePaths.map(file => basename(file)), image_urls: imagePaths.filter(isRemoteUrl), audio_name: audioPaths[0] ? basename(audioPaths[0]) : null, audio_names: audioPaths.map(file => basename(file)), can_reuse_image: imagePaths.length > 0 && imagePaths.every(file => isRemoteUrl(file) || existsSync(file)), can_reuse_audio: audioPaths.length > 0 && audioPaths.every(file => isRemoteUrl(file) || existsSync(file)) });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      const relativePath = decodeURIComponent(url.pathname.slice('/files/'.length));
      const path = resolve(DATA_DIR, relativePath);
      const dataRoot = resolve(DATA_DIR);
      if (!path.startsWith(dataRoot + '/') || !existsSync(path)) return json(res, 404, { error: '文件不存在' });
      const taskId = /^results\/([a-f0-9-]{36})\//i.exec(relativePath)?.[1];
      const imageTaskId = /^image-results\/([^/]+)\//i.exec(relativePath)?.[1];
      let allowed = taskId ? await findAccessibleTask(user, taskId) : null;
      if (!allowed && imageTaskId) {
        const [imageTasks] = await db.execute('SELECT * FROM image_tasks WHERE task_id=?', [imageTaskId]);
        allowed = imageTasks[0] && canAccessTask(user, imageTasks[0]);
      }
      if (!allowed) return json(res, 403, { error: '无权访问该文件' });
      res.writeHead(200, { 'content-type': resultContentType(path), 'content-disposition': `inline; filename="${basename(path)}"` });
      return res.end(await readFile(path));
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) { console.error(error); return json(res, 400, { error: error.message || '请求失败' }); }
});

server.listen(PORT, () => console.log(`Open http://localhost:${PORT}  | token: ${TOKEN ? 'configured' : 'missing'}`));
setInterval(pollPending, POLL_INTERVAL_MS).unref();
setInterval(pollPendingImages, POLL_INTERVAL_MS).unref();
setInterval(settlePendingVideoPoints, POLL_INTERVAL_MS).unref();
setInterval(settlePendingImagePoints, POLL_INTERVAL_MS).unref();
pollPending();
pollPendingImages();
settlePendingVideoPoints();
settlePendingImagePoints();
