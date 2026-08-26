const $ = s => document.querySelector(s);
const readDataUrl = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const randomSeed = () => Math.floor(Math.random() * 999999999999999) + 1;
$('#form').insertAdjacentHTML('afterbegin', '<input id="reuseTaskId" name="reuse_task_id" type="hidden" value="">');
$('#referenceFields').insertAdjacentHTML('afterend', '<p id="reuseAssets" class="muted" hidden></p>');
function clearReuseAssets() { $('#reuseTaskId').value = ''; $('#reuseAssets').hidden = true; $('#reuseAssets').textContent = ''; }

function workflowFields(form, includeFiles = false) {
  const workflow = form.elements.workflow_type.value;
  const common = { prompt: form.elements.prompt.value.trim(), duration: Number(form.elements.duration.value), resolution: form.elements.resolution.value };
  if (workflow === 'text') return common;
  const seed = form.elements.seed.value ? Number(form.elements.seed.value) : randomSeed();
  if (!form.elements.seed.value) form.elements.seed.value = seed;
  const payload = { ...common, seed };
  if (!includeFiles) {
    const image = form.elements.image.files[0]; const audios = [...form.elements.audio.files];
    if (image) payload.ref_image_0 = `data:${image.type};base64,<已选文件 ${image.name}，${image.size} bytes>`;
    audios.forEach((audio, index) => { payload[`ref_audio_${index}`] = `data:${audio.type};base64,<已选文件 ${audio.name}，${audio.size} bytes>`; });
    if (!image && form.elements.reuse_task_id.value && $('#reuseAssets').textContent.includes('参考图：')) payload.ref_image_0 = '<复用历史任务的本地参考图片>';
    if (audios.length === 0 && form.elements.reuse_task_id.value && $('#reuseAssets').dataset.hasAudio === 'true') payload.ref_audio_0 = '<复用历史任务的本地参考音频>';
  }
  return payload;
}
function updatePreview() { $('#payloadPreview').textContent = JSON.stringify(workflowFields($('#form')), null, 2); }
async function requestBody(form) {
  const workflow_type = form.elements.workflow_type.value;
  const payload = workflowFields(form, true);
  if (workflow_type === 'image_audio' && form.elements.image.files[0]) payload.image_data_url = await readDataUrl(form.elements.image.files[0]);
  if (workflow_type === 'image_audio' && form.elements.audio.files.length) payload.audio_data_urls = await Promise.all([...form.elements.audio.files].map(readDataUrl));
  if (workflow_type === 'image_audio' && form.elements.reuse_task_id.value) payload.reuse_task_id = form.elements.reuse_task_id.value;
  return { ...payload, workflow_type };
}
function setWorkflow(workflow) {
  const form = $('#form'); const isText = workflow === 'text';
  form.elements.workflow_type.value = workflow;
  $('#referenceFields').hidden = isText; $('#seedField').hidden = isText; $('#seedField').style.display = isText ? 'none' : '';
  if (isText) { form.elements.seed.value = ''; form.elements.image.value = ''; form.elements.audio.value = ''; clearReuseAssets(); }
  $('#duration').value = 15; $('#duration').max = 15;
  $('#resolution').innerHTML = '<option>768p竖</option><option>768p横</option>';
  $('#previewHint').textContent = isText ? '文生工作流只发送 prompt、duration、resolution。' : '随填写内容实时更新；Base64 文件内容以摘要展示。';
  $('#notice').textContent = isText ? '文生视频不使用参考图片、音频和 seed。' : '';
  updatePreview();
}
async function setAppView(view) {
  const isHistory = view === 'history';
  document.querySelectorAll('.app-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
  $('#generationView').hidden = isHistory;
  $('#historyView').hidden = !isHistory;
  if (isHistory) await loadTasks();
}
async function loadTasks() {
  const tasks = await fetch('/api/tasks').then(r => r.json());
  $('#tasks').innerHTML = tasks.length ? tasks.map(t => { const files = Array.isArray(t.downloaded_files) ? t.downloaded_files : []; return `<article class="task"><div><span class="badge ${t.status}">${esc(t.status)}</span><time>${esc(t.created_at)}</time></div><details class="prompt-details"><summary>提示词（点击展开）</summary><p>${esc(t.prompt)}</p></details><small>${t.workflow_type === 'text' ? '文生视频' : `图生视频 · seed ${esc(t.seed)}`} · 任务 ID：${esc(t.task_id)} · ${esc(t.duration)} 秒 · ${esc(t.resolution)}</small>${files.length ? `<div class="files">${files.map(f => `<a target="_blank" rel="noopener" href="/files/${encodeURIComponent(f.replace(/^.*\/data\//, ''))}">打开 ${esc(f.split('/').pop())}</a>`).join('')}<button class="secondary open-folder" data-id="${esc(t.task_id)}">打开文件夹</button></div>` : ''}<button class="secondary retry" data-id="${esc(t.task_id)}">再来一条</button><button class="secondary refresh" data-id="${esc(t.task_id)}">立即查询</button></article>`; }).join('') : '<p class="muted">暂无任务</p>';
}
$('#form').addEventListener('input', updatePreview);
$('#form').addEventListener('change', updatePreview);
$('#form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = $('#submit');
  try { button.disabled = true; $('#notice').textContent = '正在上传并提交…';
    const submittedWorkflow = form.elements.workflow_type.value;
    const payload = await requestBody(form); updatePreview();
    const response = await fetch('/api/tasks', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload) }); const result = await response.json(); if (!response.ok) throw new Error(result.error);
    $('#notice').textContent = `已提交：${result.task_id}`; form.reset(); clearReuseAssets();
    document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.workflow === submittedWorkflow));
    setWorkflow(submittedWorkflow); await loadTasks();
  } catch (error) { $('#notice').textContent = `提交失败：${error.message}`; } finally { button.disabled = false; }
});
$('#reload').onclick = loadTasks;
document.querySelectorAll('.app-tab').forEach(tab => tab.addEventListener('click', () => setAppView(tab.dataset.view)));
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => { clearReuseAssets(); document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === tab)); setWorkflow(tab.dataset.workflow); }));
$('#tasks').addEventListener('click', async event => { if (!event.target.matches('.refresh, .open-folder, .retry')) return; event.target.disabled=true; try { const isRetry = event.target.matches('.retry'); const action = event.target.matches('.open-folder') ? 'open-folder' : isRetry ? 'retry-data' : 'refresh'; const response = await fetch(`/api/tasks/${encodeURIComponent(event.target.dataset.id)}/${action}`, {method: isRetry ? 'GET' : 'POST'}); const result = await response.json(); if (!response.ok) throw new Error(result.error); if (isRetry) { const form = $('#form'); await setAppView('generation'); form.reset(); document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.workflow === result.workflow_type)); setWorkflow(result.workflow_type); form.elements.prompt.value = result.prompt; form.elements.duration.value = result.duration; form.elements.resolution.value = result.resolution; if (result.workflow_type === 'image_audio') { form.elements.seed.value = result.seed || ''; form.elements.reuse_task_id.value = result.task_id; const assets = [result.can_reuse_image ? `参考图：${result.image_name}` : '', result.can_reuse_audio ? `参考音频：${result.audio_name}` : ''].filter(Boolean); $('#reuseAssets').textContent = assets.length ? `已复用历史素材（${assets.join('；')}），可直接修改参数后生成。` : '原任务没有可复用的参考素材。'; $('#reuseAssets').dataset.hasAudio = String(result.can_reuse_audio); $('#reuseAssets').hidden = false; } updatePreview(); $('#notice').textContent = '已从历史任务回填参数，请确认后点击生成。'; } else if (action === 'refresh') await loadTasks(); } catch (error) { alert(error.message); } finally { event.target.disabled=false; } });
fetch('/api/health').then(r=>r.json()).then(x => { $('#connection').textContent = x.configured ? `令牌已配置 · 每 ${x.poll_interval_ms/1000}s 查询` : '未配置 AUTODL_TOKEN'; $('#connection').classList.toggle('bad', !x.configured); });
setWorkflow('image_audio'); loadTasks(); setInterval(loadTasks, 15000);
