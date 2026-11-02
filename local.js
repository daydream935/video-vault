/* ============================================================
   视频库 · 本机版（local.js）
   ------------------------------------------------------------
   视频存在这台手机本地：优先 OPFS（Origin Private File System），
   不支持时降级到 IndexedDB。完全不联网，打开即用。

   数据：
     IndexedDB  'vault-local' / 'videos'  → 元数据
     OPFS       media/<id>.<ext>          → 视频原文件
     OPFS       thumbs/<id>.jpg           → 封面
   ============================================================ */

/* ---------------- 小工具 ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer = null;
function toast(msg, ms = 2000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function fmtDur(s) {
  s = Math.round(Number(s) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

function fmtSize(b) {
  if (b == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = Number(b);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
}

function fmtDate(ms) {
  const d = new Date(ms || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function safeTitle(name) {
  const base = String(name || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').trim();
  return (base || '未命名').slice(0, 120);
}

function extOf(file) {
  const m = String(file.name || '').match(/\.([a-z0-9]+)$/i);
  if (m) return m[1].toLowerCase();
  const t = String(file.type || '');
  if (t.includes('mp4')) return 'mp4';
  if (t.includes('quicktime')) return 'mov';
  if (t.includes('webm')) return 'webm';
  if (t.includes('matroska')) return 'mkv';
  return 'mp4';
}

/* ---------------- 状态 ---------------- */
const state = {
  videos: [],
  query: '',
  activeTag: null,
  onlyStar: false,
  currentId: null,
  importTags: [],
  storage: { usage: 0, quota: 0, persisted: false },
};

function findVideo(id) {
  return state.videos.find((v) => v.id === id) || null;
}

/* ============================================================
   IndexedDB
   ============================================================ */
const DB_NAME = 'vault-local';
const DB_VER = 1;
let db = null;

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('videos')) d.createObjectStore('videos', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readonly').objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function idbPut(store, value, key) {
  return new Promise((resolve, reject) => {
    const os = db.transaction(store, 'readwrite').objectStore(store);
    const r = key === undefined ? os.put(value) : os.put(value, key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function idbDel(store, key) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

function idbAll(store) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  });
}

/* ============================================================
   文件存储：OPFS 优先，IndexedDB 兜底
   ============================================================ */
const opfs = { ok: false, media: null, thumbs: null };

async function initOPFS() {
  try {
    if (!navigator.storage || !navigator.storage.getDirectory) return false;
    const root = await navigator.storage.getDirectory();
    const media = await root.getDirectoryHandle('media', { create: true });
    const thumbs = await root.getDirectoryHandle('thumbs', { create: true });

    // 探针：确认 createWritable 真的能写（Safari 16.4 之前不支持）
    const probe = await root.getDirectoryHandle('__probe', { create: true });
    const fh = await probe.getFileHandle('t', { create: true });
    const w = await fh.createWritable();
    await w.write(new Blob(['ok']));
    await w.close();
    await root.removeEntry('__probe', { recursive: true });

    opfs.ok = true;
    opfs.media = media;
    opfs.thumbs = thumbs;
    return true;
  } catch (e) {
    console.warn('[opfs] 不可用，降级到 IndexedDB：', e);
    opfs.ok = false;
    return false;
  }
}

async function putBlob(kind, key, blob) {
  if (opfs.ok) {
    const dir = kind === 'media' ? opfs.media : opfs.thumbs;
    const fh = await dir.getFileHandle(key, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  } else {
    await idbPut('blobs', blob, kind + '/' + key);
  }
}

async function getBlob(kind, key) {
  if (!key) return null;
  if (opfs.ok) {
    const dir = kind === 'media' ? opfs.media : opfs.thumbs;
    try {
      const fh = await dir.getFileHandle(key);
      return await fh.getFile();
    } catch {
      return null;
    }
  }
  return (await idbGet('blobs', kind + '/' + key)) || null;
}

async function delBlob(kind, key) {
  if (!key) return;
  try {
    if (opfs.ok) {
      const dir = kind === 'media' ? opfs.media : opfs.thumbs;
      await dir.removeEntry(key);
    } else {
      await idbDel('blobs', kind + '/' + key);
    }
  } catch (e) {
    console.warn('[delBlob]', key, e);
  }
}

/* 缩略图的 objectURL 缓存（很小，可以长期留着） */
const thumbUrls = new Map();

async function thumbUrl(v) {
  if (!v.thumbKey) return null;
  if (thumbUrls.has(v.id)) return thumbUrls.get(v.id);
  const blob = await getBlob('thumbs', v.thumbKey);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  thumbUrls.set(v.id, url);
  return url;
}

function dropThumbUrl(id) {
  const u = thumbUrls.get(id);
  if (u) { URL.revokeObjectURL(u); thumbUrls.delete(id); }
}

/* ============================================================
   数据读写
   ============================================================ */
async function loadAll() {
  const vids = await idbAll('videos');
  state.videos = vids.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function rebuildTags() {
  const m = new Map();
  for (const v of state.videos) {
    for (const t of (v.tags || [])) m.set(t, (m.get(t) || 0) + 1);
  }
  state.tags = [...m.entries()].map(([name, count]) => ({ name, count }));
}

async function saveVideo(v) {
  await idbPut('videos', v);
  const i = state.videos.findIndex((x) => x.id === v.id);
  if (i >= 0) state.videos[i] = v; else state.videos.unshift(v);
  rebuildTags();
}

async function removeVideo(v) {
  // 链接收藏没有本地文件，不用删 blob
  if (v.kind !== 'link') {
    await delBlob('media', v.fileKey);
    await delBlob('thumbs', v.thumbKey);
  }
  dropThumbUrl(v.id);
  await idbDel('videos', v.id);
  state.videos = state.videos.filter((x) => x.id !== v.id);
  rebuildTags();
}

/* ============================================================
   渲染
   ============================================================ */
function visibleVideos() {
  const q = state.query.trim().toLowerCase();
  const list = state.videos.filter((v) => {
    if (state.onlyStar && !v.starred) return false;
    if (state.activeTag && !(v.tags || []).includes(state.activeTag)) return false;
    if (!q) return true;
    if ((v.title || '').toLowerCase().includes(q)) return true;
    return (v.tags || []).some((t) => t.toLowerCase().includes(q));
  });
  // 标星的排前面；sort 是稳定的，其余之间顺序不变
  return list.slice().sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0));
}

function renderTags() {
  const bar = $('#tagbar');
  bar.innerHTML = '';

  const all = document.createElement('button');
  all.className = 'chip' + (!state.activeTag && !state.onlyStar ? ' active' : '');
  all.textContent = '全部';
  all.onclick = () => { state.activeTag = null; state.onlyStar = false; renderTags(); renderGrid(); };
  bar.appendChild(all);

  const star = document.createElement('button');
  star.className = 'chip star' + (state.onlyStar ? ' active' : '');
  star.textContent = '★';
  star.setAttribute('aria-label', '只看标星');
  star.onclick = () => {
    state.onlyStar = !state.onlyStar;
    renderTags();
    renderGrid();
  };
  bar.appendChild(star);

  if (!state.tags || !state.tags.length) return;

  for (const t of state.tags) {
    const b = document.createElement('button');
    b.className = 'chip' + (state.activeTag === t.name ? ' active' : '');
    b.textContent = t.name;
    b.onclick = () => {
      state.activeTag = state.activeTag === t.name ? null : t.name;
      renderTags();
      renderGrid();
    };
    bar.appendChild(b);
  }
}

function placeholderCover() {
  const d = document.createElement('div');
  d.className = 'cover';
  d.style.display = 'grid';
  d.style.placeItems = 'center';
  d.style.color = '#3b3b46';
  d.innerHTML = `<svg viewBox="0 0 24 24" style="width:26px;height:26px;stroke-width:1.6">
    <path d="M8 6.5v11l9-5.5z"/></svg>`;
  return d;
}

/* 链接收藏的封面：外站图片加载不了（比如 YouTube 在国内）时，
   显示带站点名的色块，而不是一块空白 */
function linkCover(v) {
  const d = document.createElement('div');
  let cls = 'web', label = v.site || '网页';
  if (v.source === 'youtube') { cls = 'yt'; label = 'YouTube'; }
  else if (v.source === 'bilibili') { cls = 'bili'; label = 'B站'; }
  else if (v.source === 'direct') { cls = 'direct'; label = v.site || '直链'; }
  d.className = 'cover link-cover ' + cls;
  const s = document.createElement('span');
  s.className = 'lc-label';
  s.textContent = label;
  d.appendChild(s);
  return d;
}

function cardEl(v) {
  const el = document.createElement('button');
  el.className = 'card';
  el.dataset.id = v.id;
  el.setAttribute('aria-label', v.title);

  if (v.thumbKey) {
    const img = document.createElement('img');
    img.className = 'cover';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    el.appendChild(img);
    thumbUrl(v).then((u) => {
      if (u) img.src = u;
      else { img.remove(); el.prepend(placeholderCover()); }
    });
  } else if (v.kind === 'link') {
    // 链接收藏：有封面图就先试着加载，加载不出来（外网被挡）就用站点色块
    if (v.thumb) {
      const img = document.createElement('img');
      img.className = 'cover';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = v.thumb;
      img.onerror = () => { img.remove(); el.prepend(linkCover(v)); };
      el.appendChild(img);
    } else {
      el.appendChild(linkCover(v));
    }
  } else {
    el.appendChild(placeholderCover());
  }

  const shade = document.createElement('div');
  shade.className = 'shade';
  el.appendChild(shade);

  const tags = (v.tags || []);
  if (tags.length || v.kind === 'link') {
    const wrap = document.createElement('div');
    wrap.className = 'c-tags';
    if (v.kind === 'link') {
      const s = document.createElement('span');
      s.className = 'c-tag c-site';
      s.textContent = v.source === 'youtube' ? 'YouTube'
        : v.source === 'bilibili' ? 'B站'
        : v.source === 'direct' ? '直链'
        : (v.site || '网页');
      wrap.appendChild(s);
    }
    for (const t of tags.slice(0, v.kind === 'link' ? 1 : 2)) {
      const s = document.createElement('span');
      s.className = 'c-tag';
      s.textContent = t;
      wrap.appendChild(s);
    }
    el.appendChild(wrap);
  }

  if (v.duration) {
    const d = document.createElement('div');
    d.className = 'dur';
    d.textContent = fmtDur(v.duration);
    el.appendChild(d);
  }

  const title = document.createElement('div');
  title.className = 'c-title';
  title.textContent = v.title;
  el.appendChild(title);

  if (v.starred) {
    el.classList.add('starred');
    const s = document.createElement('div');
    s.className = 'c-star';
    s.textContent = '★';
    el.appendChild(s);
  }

  /* 长按 480ms 弹出操作菜单（标星 / 编辑 / 删除）。
     手指移动超过 10px 就取消，避免滚动时误触。 */
  let pressTimer = null;
  let longPressed = false;
  let sx = 0, sy = 0;

  const clearPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    longPressed = false;
    sx = e.clientX; sy = e.clientY;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      longPressed = true;
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch {} }
      openCardMenu(v.id);
    }, 480);
  });
  el.addEventListener('pointermove', (e) => {
    if (!pressTimer) return;
    if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) clearPress();
  });
  el.addEventListener('pointerup', clearPress);
  el.addEventListener('pointercancel', clearPress);
  el.addEventListener('pointerleave', clearPress);
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  el.onclick = () => {
    if (longPressed) { longPressed = false; return; }
    // 普通网页收藏：嵌入不了，直接去原网站，少点一次
    if (v.kind === 'link' && v.source === 'web') {
      window.open(v.url, '_blank', 'noopener');
      return;
    }
    openPlayer(v.id);
  };
  return el;
}

function renderGrid() {
  const grid = $('#grid');
  const list = visibleVideos();
  grid.innerHTML = '';

  const emptyEl = $('#empty');
  if (!state.videos.length) {
    emptyEl.hidden = false;
    emptyEl.querySelector('.empty-title').textContent = '还没有视频';
    emptyEl.querySelector('.empty-sub').textContent = '点右下角的 ＋ 导入第一条';
    return;
  }
  if (!list.length) {
    emptyEl.hidden = false;
    emptyEl.querySelector('.empty-title').textContent = '没有匹配的';
    emptyEl.querySelector('.empty-sub').textContent =
      state.activeTag ? `「${state.activeTag}」下暂无视频` : '换个关键词试试';
    return;
  }
  emptyEl.hidden = true;

  const frag = document.createDocumentFragment();
  for (const v of list) frag.appendChild(cardEl(v));
  grid.appendChild(frag);
}

/* ============================================================
   搜索
   ============================================================ */
$('#btnSearch').onclick = () => {
  const w = $('#searchWrap');
  w.classList.toggle('open');
  if (w.classList.contains('open')) setTimeout(() => $('#q').focus(), 120);
  else { $('#q').value = ''; state.query = ''; w.classList.remove('has-text'); renderGrid(); }
};
$('#q').oninput = (e) => {
  state.query = e.target.value;
  $('#searchWrap').classList.toggle('has-text', !!state.query);
  renderGrid();
};
$('#btnSearchClear').onclick = () => {
  $('#q').value = ''; state.query = '';
  $('#searchWrap').classList.remove('has-text');
  renderGrid(); $('#q').focus();
};
window.addEventListener('scroll', () => {
  const bar = document.querySelector('.topbar');
  if (bar) bar.classList.toggle('scrolled', window.scrollY > 4);
}, { passive: true });

/* ============================================================
   抽屉
   ============================================================ */
function openSheet(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeSheet(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('open');
  document.body.style.overflow = '';
}
document.querySelectorAll('[data-close]').forEach((b) => {
  b.onclick = () => closeSheet(b.dataset.close);
});
document.querySelectorAll('.sheet').forEach((s) => {
  s.addEventListener('click', (e) => { if (e.target === s) closeSheet(s.id); });
});
$('#fab').onclick = () => {
  openSheet('importSheet');
  try { renderImportTags(); } catch (e) { console.warn(e); }
  refreshStorage();
};

/* ============================================================
   导入时选标签
   ============================================================ */
function renderImportTags() {
  const box = $('#importTags');
  if (!box) return;
  box.innerHTML = '';
  const names = [...new Set([...(state.tags || []).map((t) => t.name), ...state.importTags])];
  if (!names.length) {
    const p = document.createElement('span');
    p.className = 'chip-hint';
    p.textContent = '还没有标签，下面新建一个';
    box.appendChild(p);
    return;
  }
  for (const name of names) {
    const b = document.createElement('button');
    const on = state.importTags.includes(name);
    b.className = 'chip' + (on ? ' active' : '');
    b.textContent = name;
    b.onclick = () => {
      if (state.importTags.includes(name)) {
        state.importTags = state.importTags.filter((x) => x !== name);
      } else {
        state.importTags.push(name);
      }
      renderImportTags();
    };
    box.appendChild(b);
  }
}

function addImportTag() {
  const input = $('#importNewTag');
  const name = String(input.value || '').trim().slice(0, 24);
  if (!name) return;
  if (!state.importTags.includes(name)) state.importTags.push(name);
  input.value = '';
  renderImportTags();
}
$('#importAddTag').onclick = addImportTag;
$('#importNewTag').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addImportTag(); } };

/* ============================================================
   抽帧：拿时长、分辨率、封面
   ============================================================ */
function analyze(file) {
  return new Promise((resolve) => {
    const out = { thumbBlob: null, duration: 0, width: 0, height: 0 };
    let url = null;
    let video = null;
    let settled = false;
    let timer = null;
    const t0 = performance.now();

    const finish = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (video) { video.removeAttribute('src'); video.load(); }
      } catch {}
      if (url) URL.revokeObjectURL(url);
      out.ms = Math.round(performance.now() - t0);
      out.why = why || 'timeout';
      try {
        window.__vault.lastAnalyze = {
          ms: out.ms, why: out.why,
          duration: Math.round(out.duration),
          size: out.width + 'x' + out.height,
          hasThumb: !!out.thumbBlob,
          thumbSize: out.thumbBlob ? out.thumbBlob.size : 0,
        };
      } catch {}
      resolve(out);
    };

    timer = setTimeout(() => finish('timeout'), 15000);

    try {
      url = URL.createObjectURL(file);
      video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.src = url;

      video.onloadedmetadata = () => {
        out.duration = Number.isFinite(video.duration) ? video.duration : 0;
        out.width = video.videoWidth || 0;
        out.height = video.videoHeight || 0;
        if (!out.width || !out.duration) { finish('no-dim'); return; }
        const t = Math.min(Math.max(out.duration * 0.12, 0.1), Math.max(out.duration - 0.15, 0.1));
        try { video.currentTime = t; } catch { finish(); }
      };

      video.onseeked = () => {
        try {
          const maxW = 640;
          const vw = video.videoWidth || 640;
          const vh = video.videoHeight || 360;
          const w = Math.min(vw, maxW);
          const h = Math.max(1, Math.round(w * vh / vw));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          ctx.drawImage(video, 0, 0, w, h);
          c.toBlob((b) => { if (b) out.thumbBlob = b; finish('ok'); }, 'image/jpeg', 0.72);
        } catch {
          finish();
        }
      };

      video.onerror = finish;
    } catch {
      finish();
    }
  });
}

/* ============================================================
   导入（本地写入，不走网络）
   ============================================================ */
function queueItem(name) {
  const box = $('#uploadQueue');
  const el = document.createElement('div');
  el.className = 'qitem';
  el.innerHTML = `
    <div class="qitem-top">
      <span class="qitem-name"></span>
      <span class="qitem-pct">0%</span>
    </div>
    <div class="qbar"><i></i></div>`;
  el.querySelector('.qitem-name').textContent = name;
  box.appendChild(el);
  return {
    set(pct, st) {
      el.querySelector('.qitem-pct').textContent =
        st === 'done' ? '完成' : st === 'err' ? '失败' : Math.round(pct) + '%';
      el.querySelector('.qbar i').style.width = Math.max(2, Math.min(100, pct)) + '%';
      if (st) el.classList.add(st);
    },
    remove() { setTimeout(() => el.remove(), 1400); },
  };
}

async function importOne(file, tags) {
  const item = queueItem(file.name);
  try {
    item.set(8);
    const meta = await analyze(file);
    item.set(45);

    const id = (crypto.randomUUID && crypto.randomUUID()) ||
      (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
    const fileKey = id + '.' + extOf(file);

    await putBlob('media', fileKey, file);
    item.set(82);

    let thumbKey = null;
    if (meta.thumbBlob) {
      thumbKey = id + '.jpg';
      await putBlob('thumbs', thumbKey, meta.thumbBlob);
    }
    item.set(96);

    const v = {
      id,
      title: safeTitle(file.name),
      tags: [...tags],
      duration: meta.duration || 0,
      width: meta.width || 0,
      height: meta.height || 0,
      size: file.size || 0,
      mime: file.type || '',
      fileKey,
      thumbKey,
      starred: false,
      createdAt: Date.now(),
    };
    await saveVideo(v);
    item.set(100, 'done');
    item.remove();
    return v;
  } catch (e) {
    console.error('[import]', e);
    item.set(100, 'err');
    item.remove();
    throw e;
  }
}

let importing = false;

/* ============================================================
   从链接收藏
   ============================================================ */

/* 认链接：YouTube / 哔哩哔哩 / 视频直链 / 普通网页 */
function parseUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;

  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const full = u.href;

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') {
    let vid = u.searchParams.get('v');
    if (!vid && host === 'youtu.be') vid = u.pathname.slice(1).split('/')[0];
    if (!vid && u.pathname.startsWith('/shorts/')) vid = u.pathname.split('/')[2];
    if (!vid && u.pathname.startsWith('/embed/')) vid = u.pathname.split('/')[2];
    if (vid && /^[\w-]{6,20}$/.test(vid)) {
      return {
        source: 'youtube',
        site: 'YouTube',
        embed: 'https://www.youtube-nocookie.com/embed/' + vid + '?rel=0&playsinline=1',
        thumb: 'https://i.ytimg.com/vi/' + vid + '/mqdefault.jpg',
      };
    }
  }

  const bv = full.match(/BV[0-9A-Za-z]{10}/);
  if (host.endsWith('bilibili.com') && bv) {
    return {
      source: 'bilibili',
      site: '哔哩哔哩',
      embed: 'https://player.bilibili.com/player.html?bvid=' + bv[0] + '&autoplay=0',
      thumb: null,
    };
  }

  if (/\.(mp4|m4v|webm|mov|ogv|ogg)$/i.test(u.pathname)) {
    return { source: 'direct', site: host, embed: full, thumb: null };
  }

  return { source: 'web', site: host, embed: full, thumb: null };
}

/* 先试着真的下载下来；下不了（跨域被挡 / 不是视频）就存成书签 */
async function importLink(raw, tags) {
  const info = parseUrl(raw);
  if (!info) throw new Error('这不像一个网址（要 http:// 或 https:// 开头）');

  if (info.source === 'direct' || info.source === 'web') {
    const item = queueItem('试着下载 ' + info.site);
    try {
      item.set(12);
      const res = await fetch(info.embed, { mode: 'cors', credentials: 'omit' });
      const ct = String(res.headers.get('content-type') || '').toLowerCase();
      if (res.ok && ct.startsWith('video/')) {
        item.set(40);
        const blob = await res.blob();
        item.set(72);
        let name = '视频.mp4';
        try {
          const seg = decodeURIComponent(new URL(info.embed).pathname.split('/').pop() || '');
          if (/\.(mp4|m4v|webm|mov|ogv|ogg)$/i.test(seg)) name = seg;
        } catch {}
        const file = new File([blob], name, { type: ct.split(';')[0] });
        const v = await importOne(file, tags);
        v.fromUrl = info.embed;
        v.source = info.source;
        v.site = info.site;
        await saveVideo(v);
        item.set(100, 'done');
        item.remove();
        return v;
      }
      item.remove();
    } catch (e) {
      // 跨域被挡，或者对方不是视频 —— 落到下面存书签
      item.remove();
    }
  }

  const id = (crypto.randomUUID && crypto.randomUUID()) ||
    (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

  const v = {
    id,
    kind: 'link',
    url: info.embed,
    source: info.source,
    site: info.site,
    thumb: info.thumb,
    title: info.site + ' 视频',
    tags: [...tags],
    duration: 0, width: 0, height: 0, size: 0,
    starred: false,
    createdAt: Date.now(),
  };
  await saveVideo(v);
  return v;
}

async function handleFiles(fileList) {
  const files = [...(fileList || [])].filter((f) => {
    return f && (f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|avi|mpe?g|3gp|ts)$/i.test(f.name));
  });
  if (!files.length) { toast('没选到视频文件'); return; }
  if (importing) { toast('上一批还在导入'); return; }

  importing = true;
  $('#uploadQueue').innerHTML = '';
  const tags = [...state.importTags];
  let ok = 0, bad = 0;
  let bytes = 0;

  for (const f of files) {
    try {
      await importOne(f, tags);
      ok++;
      bytes += f.size || 0;
    } catch (e) {
      bad++;
      if (String(e && e.name) === 'QuotaExceededError' || /quota/i.test(String(e && e.message))) {
        toast('存储空间不够了，先删一些视频', 4000);
        break;
      }
    }
  }

  importing = false;
  if (ok) {
    renderTags();
    renderGrid();
    await refreshStorage();
    toast(`已存入 ${ok} 个${bytes ? '，' + fmtSize(bytes) : ''}${bad ? `，失败 ${bad} 个` : ''}`, 2800);
  } else if (bad) {
    toast(`全部失败（${bad} 个）`, 3000);
  }
}

$('#fileInput').onchange = async (e) => {
  // 必须先拷贝成数组：下面清空 value 会把这个 FileList 一起清空
  const files = [...e.target.files];
  e.target.value = '';
  await handleFiles(files);
};

/* ============================================================
   导入面板：切换「从手机选 / 贴链接」
   ============================================================ */
document.querySelectorAll('.seg-btn').forEach((b) => {
  b.onclick = async () => {
    document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    const target = b.dataset.pane;
    document.querySelectorAll('#importSheet [id^="pane"]').forEach((p) => {
      p.hidden = p.id !== target;
    });
    if (target === 'paneLink') {
      const input = $('#linkInput');
      // 切过来时如果剪贴板里有网址，自动填进（省得手动粘贴）
      if (!input.value) {
        try {
          const text = (await navigator.clipboard.readText()).trim();
          if (/^https?:\/\/\S+$/i.test(text)) {
            input.value = text;
            toast('已从剪贴板填入', 1400);
          }
        } catch {}
      }
      setTimeout(() => input.focus(), 140);
    }
  };
});

$('#linkInput').onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#linkAdd').click(); }
};

$('#linkAdd').onclick = async () => {
  const url = String($('#linkInput').value || '').trim();
  if (!url) { toast('先粘贴一个链接'); return; }
  const btn = $('#linkAdd');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    const v = await importLink(url, [...state.importTags]);
    $('#linkInput').value = '';
    renderTags();
    renderGrid();
    await refreshStorage();
    toast(v.kind === 'link'
      ? `已收藏链接（${v.site || '网页'}）`
      : '已下载到手机', 2600);
    closeSheet('importSheet');
  } catch (e) {
    toast(String((e && e.message) || '收藏失败'), 3400);
  } finally {
    btn.disabled = false;
    btn.textContent = '收藏';
  }
};

/* ============================================================
   播放
   ============================================================ */
const pv = $('#pv');
const pframe = $('#pframe');
let playerUrl = null;

function renderStarBtn(v) {
  const b = $('#pStar');
  if (!b) return;
  b.classList.toggle('on', !!(v && v.starred));
  b.setAttribute('aria-label', v && v.starred ? '取消标星' : '标星');
}

async function toggleStar(v) {
  if (!v) return;
  v.starred = !v.starred;
  await saveVideo(v);
  renderGrid();
  if (state.currentId === v.id) renderStarBtn(v);
  toast(v.starred ? '★ 已标星' : '已取消标星', 1300);
}

/* 长按卡片弹出的操作菜单 */
let menuId = null;

function openCardMenu(id) {
  const v = findVideo(id);
  if (!v) return;
  menuId = id;
  $('#cmTitle').textContent = v.title;
  const starBtn = $('#cmStar');
  starBtn.classList.toggle('on', !!v.starred);
  starBtn.querySelector('.action-ico').textContent = v.starred ? '★' : '☆';
  starBtn.querySelector('.action-label').textContent = v.starred ? '取消标星' : '标星';
  openSheet('cardMenu');
}

$('#cmStar').onclick = async () => {
  const v = findVideo(menuId);
  closeSheet('cardMenu');
  if (v) await toggleStar(v);
};

$('#cmEdit').onclick = () => {
  const id = menuId;
  closeSheet('cardMenu');
  if (id) openEditor(id);
};

$('#cmDelete').onclick = async () => {
  const v = findVideo(menuId);
  closeSheet('cardMenu');
  if (!v) return;
  if (!confirm(`删除「${v.title}」？\n文件会从这台手机上一起删掉，不能恢复。`)) return;
  await removeVideo(v);
  renderTags();
  renderGrid();
  await refreshStorage();
  toast('已删除');
};

$('#pStar').onclick = () => {
  const v = findVideo(state.currentId);
  if (v) toggleStar(v);
};

function renderPlayerMeta(v) {
  if (v.kind === 'link') {
    $('#pMeta').textContent = (v.site || '链接') + ' · 链接收藏 · ' + fmtDate(v.createdAt);
    return;
  }
  const parts = [];
  if (v.size) parts.push(fmtSize(v.size));
  if (v.width && v.height) parts.push(v.width + '×' + v.height);
  parts.push(fmtDate(v.createdAt));
  $('#pMeta').textContent = parts.join(' · ');
}

function renderPlayerTags(v) {
  const box = $('#pTags');
  box.innerHTML = '';
  for (const t of (v.tags || [])) {
    const s = document.createElement('span');
    s.className = 'chip';
    s.textContent = t;
    box.appendChild(s);
  }
}

async function openPlayer(id) {
  const v = findVideo(id);
  if (!v) return;

  /* ---------- 链接收藏 ---------- */
  if (v.kind === 'link') {
    state.currentId = id;
    try { pv.pause(); } catch {}
    pv.removeAttribute('src');
    try { pv.load(); } catch {}
    if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }

    $('#pTitle').textContent = v.title;
    renderPlayerMeta(v);
    renderPlayerTags(v);
    renderStarBtn(v);

    const tip = $('#pLinkTip');
    const visit = $('#pVisitSite');
    visit.hidden = false;
    visit.href = v.url;
    if (v.source === 'youtube' || v.source === 'bilibili') {
      pv.hidden = true; tip.hidden = true;
      pframe.hidden = false; pframe.src = v.url;
    } else if (v.source === 'direct') {
      pframe.hidden = true; pframe.removeAttribute('src');
      tip.hidden = true;
      pv.hidden = false; pv.src = v.url; pv.load();
    } else {
      // 普通网页：不给嵌，给个跳转
      pv.hidden = true;
      pframe.hidden = true; pframe.removeAttribute('src');
      tip.hidden = false;
      $('#pLinkOpen').href = v.url;
    }

    const list = visibleVideos();
    const idx = list.findIndex((x) => x.id === id);
    $('#playerCounter').textContent = list.length > 1 ? `${idx + 1} / ${list.length}` : '';

    $('#player').classList.add('open');
    document.body.style.overflow = 'hidden';
    return;
  }

  /* ---------- 本地视频 ---------- */
  $('#pLinkTip').hidden = true;
  $('#pVisitSite').hidden = true;
  pframe.hidden = true;
  pframe.removeAttribute('src');
  pv.hidden = false;

  const blob = await getBlob('media', v.fileKey);
  if (!blob) {
    toast('这个视频的文件不在了', 3000);
    return;
  }

  state.currentId = id;
  if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
  playerUrl = URL.createObjectURL(blob);

  pv.src = playerUrl;
  pv.load();

  $('#pTitle').textContent = v.title;
  renderPlayerMeta(v);
  renderPlayerTags(v);
  renderStarBtn(v);

  const list = visibleVideos();
  const idx = list.findIndex((x) => x.id === id);
  $('#playerCounter').textContent = list.length > 1 ? `${idx + 1} / ${list.length}` : '';

  $('#player').classList.add('open');
  document.body.style.overflow = 'hidden';
  pv.play().catch(() => {});
}

function closePlayer() {
  $('#player').classList.remove('open');
  document.body.style.overflow = '';
  try { pv.pause(); } catch {}
  pv.removeAttribute('src');
  try { pv.load(); } catch {}
  pframe.hidden = true;
  pframe.removeAttribute('src');
  pv.hidden = false;
  const tip = $('#pLinkTip');
  if (tip) tip.hidden = true;
  const visit = $('#pVisitSite');
  if (visit) visit.hidden = true;
  if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
  state.currentId = null;
}

$('#playerClose').onclick = closePlayer;

pv.onerror = () => {
  const code = pv.error && pv.error.code;
  if (code === 4) {
    toast('这个格式这台设备解不了（常见于 HEVC / MKV），文件还在', 4500);
  } else if (code === 3) {
    toast('视频文件读不出来', 3000);
  }
};

/* ============================================================
   编辑
   ============================================================ */
let editingId = null;

function renderEditorTags() {
  const box = $('#eTags');
  box.innerHTML = '';
  for (const name of (state.tags || []).map((t) => t.name)) {
    const b = document.createElement('button');
    const on = (findVideo(editingId)?.tags || []).includes(name);
    b.className = 'chip' + (on ? ' active' : '');
    b.textContent = name;
    b.onclick = () => {
      const v = findVideo(editingId);
      if (!v) return;
      v.tags = v.tags || [];
      if (v.tags.includes(name)) v.tags = v.tags.filter((x) => x !== name);
      else v.tags.push(name);
      renderEditorTags();
    };
    box.appendChild(b);
  }
  if (!state.tags.length) {
    const p = document.createElement('span');
    p.className = 'chip-hint';
    p.textContent = '还没有标签，下面新建一个';
    box.appendChild(p);
  }
}

function openEditor(id) {
  const v = findVideo(id || state.currentId);
  if (!v) return;
  editingId = v.id;
  $('#eTitle').value = v.title;
  renderEditorTags();
  openSheet('editor');
}

$('#pEdit').onclick = () => openEditor();

$('#eAddTag').onclick = () => {
  const input = $('#eNewTag');
  const name = String(input.value || '').trim().slice(0, 24);
  if (!name) return;
  const v = findVideo(editingId);
  if (v) {
    v.tags = v.tags || [];
    if (!v.tags.includes(name)) v.tags.push(name);
  }
  input.value = '';
  renderEditorTags();
};
$('#eNewTag').onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#eAddTag').click(); }
};

$('#eSave').onclick = async () => {
  const v = findVideo(editingId);
  if (!v) return;
  v.title = String($('#eTitle').value || '').trim().slice(0, 120) || '未命名';
  await saveVideo(v);
  editingId = null;
  closeSheet('editor');

  if (state.currentId === v.id) {
    $('#pTitle').textContent = v.title;
    renderPlayerTags(v);
    renderPlayerMeta(v);
  }
  renderTags();
  renderGrid();
  toast('已保存');
};

/* ============================================================
   删除
   ============================================================ */
$('#pDelete').onclick = async () => {
  const v = findVideo(state.currentId);
  if (!v) return;
  if (!confirm(`删除「${v.title}」？\n文件会从这台手机上一起删掉。`)) return;
  await removeVideo(v);
  closePlayer();
  renderTags();
  renderGrid();
  await refreshStorage();
  toast('已删除');
};

/* ============================================================
   存储容量
   ============================================================ */
async function refreshStorage() {
  const el = $('#storageInfo');
  if (!el) return;
  if (!navigator.storage || !navigator.storage.estimate) {
    el.textContent = '这个浏览器不支持存储信息查询';
    return;
  }
  try {
    const est = await navigator.storage.estimate();
    state.storage.usage = est.usage || 0;
    state.storage.quota = est.quota || 0;
    let persisted = false;
    try { persisted = await navigator.storage.persisted(); } catch {}
    state.storage.persisted = persisted;

    const mode = opfs.ok ? '文件系统' : 'IndexedDB（较慢）';
    const pct = state.storage.quota ? (state.storage.usage / state.storage.quota) * 100 : 0;

    el.innerHTML =
      `已用 <b>${fmtSize(state.storage.usage)}</b> · 可用 <b>${fmtSize(state.storage.quota)}</b>` +
      `<br>存储方式：${esc(mode)}` +
      (pct > 80 ? `<span class="storage-warn">空间快满了（${pct.toFixed(0)}%），建议删一些</span>` : '') +
      (persisted
        ? `<span class="storage-ok">已申请长期存储，系统不会自动清理</span>`
        : `<span class="storage-warn">还没拿到长期存储权限，系统在空间紧张时可能清理数据</span>`);
  } catch (e) {
    el.textContent = '读不到存储信息';
  }
}

/* ============================================================
   启动
   ============================================================ */
async function boot() {
  try {
    db = await idbOpen();
  } catch (e) {
    console.error('[db]', e);
    document.body.innerHTML =
      '<p style="padding:40px 24px;color:#ff6b6b;font-size:15px;line-height:1.8">' +
      '这个浏览器不允许本地存储，用不了本机版。<br>试试换成 Chrome / Safari 最新版。</p>';
    return;
  }

  await initOPFS();

  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted().catch(() => false);
      if (!already) await navigator.storage.persist().catch(() => {});
    }
  } catch {}

  await loadAll();
  // 老数据没有 starred 字段，补成 false
  for (const v of state.videos) if (typeof v.starred !== 'boolean') v.starred = false;
  rebuildTags();
  renderTags();
  renderGrid();
  await refreshStorage();

  window.__vault.ready = true;

  if ('serviceWorker' in navigator) {
    // 相对路径：放在根目录、子目录、GitHub Pages 项目路径下都能用
    navigator.serviceWorker.register('./sw.js').catch((e) => {
      console.warn('[sw]', e);
    });
  }
}

// 测试钩子（只暴露纯函数，不影响使用）
window.__vault = { analyze, importOne, state, removeVideo, loadAll };

boot();