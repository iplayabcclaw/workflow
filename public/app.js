const $ = s => document.querySelector(s);
const readDataUrl = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const remoteUrls = (value, found = []) => { if (typeof value === 'string' && /^https?:\/\//i.test(value)) found.push(value); else if (Array.isArray(value)) value.forEach(item => remoteUrls(item, found)); else if (value && typeof value === 'object') Object.values(value).forEach(item => remoteUrls(item, found)); return [...new Set(found)]; };
let selectedImages = [];
let selectedAudios = [];
let selectedGptImages = [];
let reusedImageUrls = [];
let historyType = 'video';
const ledgerRecords = new Map();
const nativeFetch = window.fetch.bind(window);
function showLogin(message = '') { $('#appView').hidden = true; $('#loginView').hidden = false; $('#loginForm').hidden = false; $('#registerForm').hidden = true; $('#loginNotice').textContent = message; }
function showApp(user) { $('#loginView').hidden = true; $('#appView').hidden = false; $('#currentUser').textContent = `${user.display_name || user.username}（${user.role === 'admin' ? '管理员' : '用户'} · ${Number(user.points_balance || 0)} 积分）`; document.querySelectorAll('[data-admin-only]').forEach(item => { item.hidden = user.role !== 'admin'; }); if (user.role === 'admin') { loadUsers(); loadPoints(); } }
window.fetch = async (...args) => { const response = await nativeFetch(...args); if (response.status === 401 && !String(args[0]).includes('/api/auth/login')) showLogin('登录已过期，请重新登录。'); return response; };
$('#form').insertAdjacentHTML('afterbegin', '<input id="reuseTaskId" name="reuse_task_id" type="hidden" value="">');
$('#referenceFields').insertAdjacentHTML('afterend', '<p id="reuseAssets" class="muted" hidden></p>');
function clearReuseAssets() { $('#reuseTaskId').value = ''; $('#reuseAssets').hidden = true; $('#reuseAssets').textContent = ''; reusedImageUrls = []; updateAssetPreview(); }

function workflowFields(form, includeFiles = false) {
  const workflow = form.elements.workflow_type.value;
  const common = { prompt: form.elements.prompt.value.trim(), duration: Number(form.elements.duration.value), resolution: form.elements.resolution.value };
  if (workflow === 'text') return common;
  const payload = { ...common };
  if (!includeFiles) {
    const images = selectedImages; const audios = selectedAudios;
    images.forEach((image, index) => { payload[`ref_image_${index}`] = `<上传至 COS 后的 URL：${image.name}>`; });
    audios.forEach((audio, index) => { payload[`ref_audio_${index}`] = `<上传至 COS 后的 URL：${audio.name}>`; });
    if (images.length === 0 && form.elements.reuse_task_id.value && $('#reuseAssets').textContent.includes('参考图：')) payload.ref_image_0 = '<复用历史任务的本地参考图片>';
    if (audios.length === 0 && form.elements.reuse_task_id.value && $('#reuseAssets').dataset.hasAudio === 'true') payload.ref_audio_0 = '<复用历史任务的本地参考音频>';
  }
  return payload;
}
function updateAssetPreview() {
  const images = [...reusedImageUrls.map((url, index) => `<figure class="asset-image"><button type="button" class="remove-reused-image remove-asset" data-index="${index}" aria-label="删除历史参考图">×</button><img src="${esc(url)}" alt="历史参考图 ${index + 1}"><figcaption>历史参考图（COS）</figcaption></figure>`), ...selectedImages.map((file, index) => `<figure class="asset-image"><button type="button" class="remove-asset" data-kind="image" data-index="${index}" aria-label="删除 ${esc(file.name)}">×</button><img src="${URL.createObjectURL(file)}" alt="${esc(file.name)}"><figcaption>${esc(file.name)}</figcaption></figure>` )];
  const audios = selectedAudios.map((file, index) => `<div class="asset-audio"><span>♫</span><small>${esc(file.name)}</small><button type="button" class="remove-asset" data-kind="audio" data-index="${index}" aria-label="删除 ${esc(file.name)}">×</button></div>`);
  $('#imagePreview').innerHTML = images.join('');
  $('#audioPreview').innerHTML = audios.join('');
}
function addAssets(kind, files) { if (kind === 'image') { clearReuseAssets(); selectedImages = [...selectedImages, ...files.filter(file => file.type.startsWith('image/'))]; } else selectedAudios = [...selectedAudios, ...files.filter(file => file.type.startsWith('audio/'))]; updateAssetPreview(); updatePreview(); }
function updatePreview() { $('#payloadPreview').textContent = JSON.stringify(workflowFields($('#form')), null, 2); }
async function requestBody(form) {
  const workflow_type = form.elements.workflow_type.value;
  const payload = workflowFields(form, true);
  if (workflow_type === 'image_audio' && selectedImages.length) payload.image_data_urls = await Promise.all(selectedImages.map(readDataUrl));
  if (workflow_type === 'image_audio' && selectedAudios.length) payload.audio_data_urls = await Promise.all(selectedAudios.map(readDataUrl));
  if (workflow_type === 'image_audio' && form.elements.reuse_task_id.value) { payload.reuse_task_id = form.elements.reuse_task_id.value; payload.reuse_image_urls = reusedImageUrls; }
  return { ...payload, workflow_type };
}
function setWorkflow(workflow) {
  const form = $('#form'); const isText = workflow === 'text';
  form.elements.workflow_type.value = workflow;
  $('#referenceFields').hidden = isText;
  if (isText) { selectedImages = []; selectedAudios = []; $('#imageInput').value = ''; $('#audioInput').value = ''; updateAssetPreview(); clearReuseAssets(); }
  $('#duration').value = 15; $('#duration').max = 15;
  $('#resolution').innerHTML = '<option>768p竖</option><option>768p横</option>';
  $('#previewHint').textContent = isText ? '文生工作流只发送 prompt、duration、resolution。' : '素材会先上传至腾讯云 COS，接口实际接收 COS URL。';
  $('#notice').textContent = isText ? '文生视频不使用参考图片和音频。' : '';
  updatePreview();
}
async function setAppView(view) {
  const isHistory = view === 'history';
  const isImage = view === 'image-generation';
  const isUsers = view === 'users';
  const isPoints = view === 'points';
  document.querySelectorAll('.app-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
  $('#generationView').hidden = isHistory || isImage || isUsers || isPoints;
  $('#historyView').hidden = !isHistory;
  $('#imageGenerationView').hidden = !isImage;
  $('#usersView').hidden = !isUsers;
  $('#pointsView').hidden = !isPoints;
  if (isHistory) await loadHistory(historyType);
  if (isUsers) await loadUsers();
  if (isPoints) await loadPoints();
}
function renderVideoTask(task) {
  const files = Array.isArray(task.downloaded_files) ? task.downloaded_files : [];
  const providerUrls = remoteUrls(task.result_json?.data?.results ?? task.result_json?.results);
  const billing = Number(task.points_cost || 0) ? ` · ${task.points_charged_at ? `已扣 ${Number(task.points_cost)} 积分` : `成功后扣 ${Number(task.points_cost)} 积分`}` : '';
  const mediaCount = Math.max(files.length, providerUrls.length);
  const mediaActions = mediaCount ? `<div class="files">${Array.from({ length: mediaCount }, (_, index) => { const previewUrl = files[index] ? `/files/${encodeURIComponent(files[index].replace(/^.*\/data\//, ''))}` : providerUrls[index]; const downloadUrl = providerUrls[index] || previewUrl; const name = esc((files[index] || new URL(downloadUrl).pathname).split('/').pop() || `视频 ${index + 1}`); return `<span class="media-actions"><span class="media-name">${name}</span><a class="secondary" target="_blank" rel="noopener" href="${esc(previewUrl)}">预览</a><button class="secondary download-link" type="button" data-url="${esc(downloadUrl)}" data-name="${name}">下载</button></span>`; }).join('')}</div>` : '';
  return `<article class="task"><div><span class="badge ${task.status}">${esc(task.status)}</span><time>${esc(task.created_at)}</time></div><details class="prompt-details"><summary>提示词（点击展开）</summary><p>${esc(task.prompt)}</p></details><small>${task.workflow_type === 'text' ? '文生视频' : '图生视频'} · 任务 ID：${esc(task.task_id)} · ${esc(task.duration)} 秒 · ${esc(task.resolution)}${billing}</small>${mediaActions}<button class="secondary retry" data-id="${esc(task.task_id)}">再来一条</button><button class="secondary refresh" data-id="${esc(task.task_id)}">立即查询</button></article>`;
}
async function loadTasks(target = '#historyItems') {
  const tasks = await fetch('/api/tasks').then(r => r.json());
  $(target).innerHTML = tasks.length ? tasks.map(renderVideoTask).join('') : '<p class="muted">暂无任务</p>';
}
async function loadUsers() {
  const response = await fetch('/api/users');
  if (!response.ok) return;
  const users = await response.json();
  $('#users').innerHTML = users.map(user => `<article class="task"><strong>${esc(user.display_name)}</strong> <small>@${esc(user.username)} · ${user.role === 'admin' ? '管理员' : '普通用户'} · 当前 ${Number(user.points_balance || 0)} 积分 · 创建于 ${esc(user.created_at)}</small><form class="points-form" data-id="${esc(user.id)}"><input name="points" type="number" min="0" step="1" value="${Number(user.points_balance || 0)}" required><input name="note" placeholder="设置备注（可选）"><button class="secondary" type="submit">设置积分</button></form></article>`).join('') || '<p class="muted">暂无用户</p>';
}
async function loadPoints() {
  const response = await fetch('/api/points/records?type=deduction'); if (!response.ok) return;
  const records = await response.json();
  ledgerRecords.clear(); records.forEach(item => ledgerRecords.set(String(item.id), item));
  $('#pointsRecords').innerHTML = records.length ? `<div class="ledger-table-wrap"><table class="ledger-table"><thead><tr><th>任务 ID</th><th>模型名称</th><th>积分</th><th>完成耗时（秒）</th><th>结果类型</th><th>时间</th><th>详情</th></tr></thead><tbody>${records.map(item => { const isSuccess = item.result_type === '成功'; return `<tr><td title="${esc(item.task_id || item.reference_id || '')}">${esc(item.task_id || item.reference_id || '—')}</td><td>${esc(item.model_name)}</td><td class="${Number(item.delta) < 0 ? 'points-negative' : 'points-positive'}">${Number(item.delta) > 0 ? '+' : ''}${Number(item.delta)}</td><td>${item.completion_seconds === null ? '—' : `${Number(item.completion_seconds)}s`}</td><td><span class="result-pill ${isSuccess ? 'success' : 'set'}">${esc(item.result_type)}</span></td><td>${esc(item.created_at)}</td><td><button class="secondary ledger-details" type="button" data-id="${esc(item.id)}">◉ 查看详情</button></td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">暂无积分记录</p>';
}
function updateGptImagePreview() { $('#gptImagePreview').innerHTML = selectedGptImages.map((file, index) => `<figure class="asset-image"><button type="button" class="remove-gpt-image remove-asset" data-index="${index}">×</button><img src="${URL.createObjectURL(file)}" alt="${esc(file.name)}"><figcaption>${esc(file.name)}</figcaption></figure>`).join(''); }
function updateGptImagePreviewPayload() { $('#imagePayloadPreview').textContent = JSON.stringify({ model: 'gpt-image-2', prompt: $('#imageForm').elements.prompt.value.trim(), aspectRatio: $('#imageForm').elements.aspect_ratio.value, reference_images: selectedGptImages.map(file => ({ name: file.name, size: file.size })) }, null, 2); }
async function loadImageTasks(target = '#imageTasks') { const response = await fetch('/api/image-tasks'); const tasks = await response.json(); $(target).innerHTML = tasks.length ? tasks.map(t => { const urls = Array.isArray(t.downloaded_files) ? t.downloaded_files : []; const billing = Number(t.points_cost || 0) ? ` · ${t.points_charged_at ? `已扣 ${Number(t.points_cost)} 积分` : `成功后扣 ${Number(t.points_cost)} 积分`}` : ''; return `<article class="task"><div><span class="badge ${esc(t.status)}">${esc(t.status)}</span><time>${esc(t.created_at)}</time></div><details class="prompt-details"><summary>提示词（点击展开）</summary><p>${esc(t.prompt)}</p></details><small>GPT‑Image2 · ${esc(t.aspect_ratio)} · 任务 ID：${esc(t.task_id)}${billing}</small>${urls.length ? `<div class="files">${urls.map((url, index) => `<a target="_blank" rel="noopener" href="${esc(url)}">打开服务商图片 ${index + 1}</a>`).join('')}</div>` : ''}<button class="secondary image-refresh" data-id="${esc(t.task_id)}">立即查询</button></article>`; }).join('') : '<p class="muted">暂无任务</p>'; }
async function loadHistory(type = historyType) { historyType = type; document.querySelectorAll('[data-history-type]').forEach(tab => tab.classList.toggle('active', tab.dataset.historyType === type)); if (type === 'image') await loadImageTasks('#historyItems'); else await loadTasks('#historyItems'); }
$('#form').addEventListener('input', updatePreview);
$('#imagePicker').addEventListener('click', () => $('#imageInput').click());
$('#audioPicker').addEventListener('click', () => $('#audioInput').click());
$('#imageInput').addEventListener('change', event => { addAssets('image', [...event.target.files]); event.target.value = ''; });
$('#audioInput').addEventListener('change', event => { addAssets('audio', [...event.target.files]); event.target.value = ''; });
for (const [zoneId, kind] of [['imageZone', 'image'], ['audioZone', 'audio']]) {
  const zone = $(`#${zoneId}`);
  zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', event => { event.preventDefault(); zone.classList.remove('drag-over'); addAssets(kind, [...event.dataTransfer.files]); });
}
for (const selector of ['#imagePreview', '#audioPreview']) $(selector).addEventListener('click', event => { if (!event.target.matches('.remove-asset')) return; if (event.target.matches('.remove-reused-image')) reusedImageUrls.splice(Number(event.target.dataset.index), 1); else { const assets = event.target.dataset.kind === 'image' ? selectedImages : selectedAudios; assets.splice(Number(event.target.dataset.index), 1); } updateAssetPreview(); updatePreview(); });
$('#form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('#submit');
  try { button.disabled = true; $('#notice').textContent = '正在上传并提交…';
    const submittedWorkflow = form.elements.workflow_type.value;
    const payload = await requestBody(form); updatePreview();
    const response = await fetch('/api/tasks', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload) }); const result = await response.json(); if (!response.ok) throw new Error(result.error);
    $('#notice').textContent = `已提交：${result.task_id}`; form.reset(); selectedImages = []; selectedAudios = []; updateAssetPreview(); clearReuseAssets();
    document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.workflow === submittedWorkflow));
    setWorkflow(submittedWorkflow); await loadTasks();
  } catch (error) { $('#notice').textContent = `提交失败：${error.message}`; } finally { button.disabled = false; }
});
$('#reload').onclick = () => loadHistory(historyType);
$('#reloadPoints').onclick = loadPoints;
function closeLedgerDrawer() { $('#ledgerDrawer').hidden = true; $('#ledgerDrawerBackdrop').hidden = true; }
function openLedgerDrawer(item) { $('#ledgerDrawerModel').textContent = item.model_name; $('#ledgerDrawerTask').textContent = item.task_id || '管理员积分设置'; $('#ledgerDrawerPoints').textContent = `${Number(item.delta) > 0 ? '+' : ''}${Number(item.delta)}`; $('#ledgerDrawerElapsed').textContent = item.completion_seconds === null ? '—' : `${Number(item.completion_seconds)}s`; $('#ledgerDrawerStatus').textContent = item.result_type; $('#ledgerDrawerRequest').textContent = JSON.stringify(item.request || {}, null, 2); const urls = Array.isArray(item.result_urls) ? item.result_urls : []; $('#ledgerDrawerUrls').innerHTML = urls.length ? urls.map(url => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`).join('') : '<p class="muted">无结果 URL</p>'; $('#ledgerDrawer').hidden = false; $('#ledgerDrawerBackdrop').hidden = false; }
$('#pointsRecords').addEventListener('click', event => { if (!event.target.matches('.ledger-details')) return; const item = ledgerRecords.get(String(event.target.dataset.id)); if (item) openLedgerDrawer(item); });
$('#closeLedgerDrawer').onclick = closeLedgerDrawer;
$('#ledgerDrawerBackdrop').onclick = closeLedgerDrawer;
$('#toggleUserForm').onclick = () => { $('#userForm').hidden = !$('#userForm').hidden; };
$('#userForm').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); try { button.disabled = true; const response = await fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); $('#userNotice').textContent = `已创建用户：${result.user.username}`; form.reset(); await loadUsers(); } catch (error) { $('#userNotice').textContent = error.message; } finally { button.disabled = false; } });
$('#users').addEventListener('submit', async event => { if (!event.target.matches('.points-form')) return; event.preventDefault(); const form = event.target; const button = form.querySelector('button'); try { button.disabled = true; const response = await fetch(`/api/users/${encodeURIComponent(form.dataset.id)}/points`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); await Promise.all([loadUsers(), loadPoints()]); } catch (error) { alert(error.message); } finally { button.disabled = false; } });
$('#imageForm').addEventListener('input', updateGptImagePreviewPayload);
$('#gptImagePicker').onclick = () => $('#gptImageInput').click();
$('#gptImageInput').addEventListener('change', event => { selectedGptImages = [...selectedGptImages, ...[...event.target.files].filter(file => file.type.startsWith('image/'))]; event.target.value = ''; updateGptImagePreview(); updateGptImagePreviewPayload(); });
$('#gptImageZone').addEventListener('dragover', event => { event.preventDefault(); $('#gptImageZone').classList.add('drag-over'); });
$('#gptImageZone').addEventListener('dragleave', () => $('#gptImageZone').classList.remove('drag-over'));
$('#gptImageZone').addEventListener('drop', event => { event.preventDefault(); $('#gptImageZone').classList.remove('drag-over'); selectedGptImages = [...selectedGptImages, ...[...event.dataTransfer.files].filter(file => file.type.startsWith('image/'))]; updateGptImagePreview(); updateGptImagePreviewPayload(); });
$('#gptImagePreview').addEventListener('click', event => { if (!event.target.matches('.remove-gpt-image')) return; selectedGptImages.splice(Number(event.target.dataset.index), 1); updateGptImagePreview(); updateGptImagePreviewPayload(); });
$('#imageForm').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const button = $('#imageSubmit'); try { button.disabled = true; $('#imageNotice').textContent = '正在上传并提交…'; const payload = { prompt: form.elements.prompt.value.trim(), aspect_ratio: form.elements.aspect_ratio.value, image_data_urls: await Promise.all(selectedGptImages.map(readDataUrl)) }; const response = await fetch('/api/image-tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); $('#imageNotice').textContent = `已提交：${result.task_id}，可在历史记录 → 生图中查看结果。`; form.reset(); selectedGptImages = []; updateGptImagePreview(); updateGptImagePreviewPayload(); } catch (error) { $('#imageNotice').textContent = `提交失败：${error.message}`; } finally { button.disabled = false; } });
document.querySelectorAll('.app-tab').forEach(tab => tab.addEventListener('click', () => setAppView(tab.dataset.view)));
document.querySelectorAll('.generation-panel .tab').forEach(tab => tab.addEventListener('click', () => { clearReuseAssets(); document.querySelectorAll('.generation-panel .tab').forEach(x => x.classList.toggle('active', x === tab)); setWorkflow(tab.dataset.workflow); }));
document.querySelectorAll('[data-history-type]').forEach(tab => tab.addEventListener('click', () => loadHistory(tab.dataset.historyType)));
$('#historyItems').addEventListener('click', async event => { if (!event.target.matches('.image-refresh')) return; const button = event.target; try { button.disabled = true; const response = await fetch(`/api/image-tasks/${encodeURIComponent(button.dataset.id)}/refresh`, { method: 'POST' }); const result = await response.json(); if (!response.ok) throw new Error(result.error); await loadHistory('image'); } catch (error) { alert(error.message); } finally { button.disabled = false; } });
$('#historyItems').addEventListener('click', async event => { if (!event.target.matches('.download-link')) return; const button = event.target; try { button.disabled = true; const response = await fetch(button.dataset.url); if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`); const blob = await response.blob(); const blobUrl = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = blobUrl; link.download = button.dataset.name || 'video'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(blobUrl), 0); } catch (error) { alert(`无法直接下载服务商文件：${error.message}。请确认服务商 URL 已开启 CORS 下载支持。`); } finally { button.disabled = false; } });
$('#historyItems').addEventListener('click', async event => { if (!event.target.matches('.refresh, .open-folder, .retry')) return; event.target.disabled=true; try { const isRetry = event.target.matches('.retry'); const action = event.target.matches('.open-folder') ? 'open-folder' : isRetry ? 'retry-data' : 'refresh'; const response = await fetch(`/api/tasks/${encodeURIComponent(event.target.dataset.id)}/${action}`, {method: isRetry ? 'GET' : 'POST'}); const result = await response.json(); if (!response.ok) throw new Error(result.error); if (isRetry) { const form = $('#form'); await setAppView('generation'); form.reset(); document.querySelectorAll('.generation-panel .tab').forEach(tab => tab.classList.toggle('active', tab.dataset.workflow === result.workflow_type)); setWorkflow(result.workflow_type); form.elements.prompt.value = result.prompt; form.elements.duration.value = result.duration; form.elements.resolution.value = result.resolution; if (result.workflow_type === 'image_audio') { form.elements.reuse_task_id.value = result.task_id; reusedImageUrls = Array.isArray(result.image_urls) ? result.image_urls : []; updateAssetPreview(); const assets = [result.can_reuse_image ? `参考图：${result.image_name}` : '', result.can_reuse_audio ? `参考音频：${result.audio_name}` : ''].filter(Boolean); $('#reuseAssets').textContent = assets.length ? `已复用历史素材（${assets.join('；')}），可直接修改参数后生成。` : '原任务没有可复用的参考素材。'; $('#reuseAssets').dataset.hasAudio = String(result.can_reuse_audio); $('#reuseAssets').hidden = false; } updatePreview(); $('#notice').textContent = '已从历史任务回填参数，请确认后点击生成。'; } else if (action === 'refresh') await loadHistory('video'); } catch (error) { alert(error.message); } finally { event.target.disabled=false; } });
$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button');
  try { button.disabled = true; $('#loginNotice').textContent = '正在登录…'; const response = await nativeFetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || '登录失败'); showApp(result.user); await loadTasks(); $('#loginNotice').textContent = ''; form.reset(); } catch (error) { $('#loginNotice').textContent = error.message; } finally { button.disabled = false; }
});
$('#showRegister').onclick = () => { $('#loginForm').hidden = true; $('#registerForm').hidden = false; $('#registerNotice').textContent = '注册成功后自动获得 10,000 积分。'; };
$('#showLogin').onclick = () => { $('#registerForm').hidden = true; $('#loginForm').hidden = false; $('#loginNotice').textContent = ''; };
$('#registerForm').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button[type="submit"]'); try { button.disabled = true; $('#registerNotice').textContent = '正在注册…'; const response = await nativeFetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || '注册失败'); showApp(result.user); await loadTasks(); form.reset(); } catch (error) { $('#registerNotice').textContent = error.message; } finally { button.disabled = false; } });
$('#logout').addEventListener('click', async () => { await nativeFetch('/api/auth/logout', { method: 'POST' }); showLogin('已退出登录。'); });
async function boot() {
  const health = await nativeFetch('/api/health').then(r => r.json());
  $('#connection').textContent = health.configured ? `视频令牌已配置 · 每 ${health.poll_interval_ms / 1000}s 查询` : '未配置 AUTODL_TOKEN'; $('#connection').classList.toggle('bad', !health.configured);
  const response = await nativeFetch('/api/auth/me');
  if (!response.ok) return showLogin();
  const { user } = await response.json(); showApp(user); setWorkflow('image_audio'); await loadTasks();
}
boot(); setInterval(() => { if (!$('#appView').hidden && !$('#historyView').hidden) loadHistory(historyType); }, 60000);
