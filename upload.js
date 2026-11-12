// 相册自助上传：拖图片进来，打好标签，一次提交直接写进仓库。
// 需要一把 GitHub 细粒度密钥（只给 meme-library 仓库，Contents 读写 + Issues 读写），
// 密钥只存在你自己浏览器的 localStorage 里，不会发给任何第三方，只用来调 api.github.com。
// 传完还会自动发一个 Issue 告诉 Konata 有新图到了（同步通知）。
(function () {
  var REPO = 'murasaki-nin/meme-library';
  var API = 'https://api.github.com/repos/' + REPO;
  var LS_PAT = 'meme-library-pat-v1';
  var PREFIX = { 'naiwa': 'naiwa', 'blue-fish': 'bluefish' };
  var MAX_MB = 25;

  var pending = []; // {name, buf, format, md5, width, height, thumbB64, ext, duplicate}

  function $(id) { return document.getElementById(id); }
  function log(msg) {
    var el = $('upLog');
    el.textContent += msg + '\n';
    el.scrollTop = el.scrollHeight;
  }
  function todayLocal() {
    var d = new Date();
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }
  function getPat() { return (localStorage.getItem(LS_PAT) || '').trim(); }

  function bufToB64(buf) {
    var bytes = new Uint8Array(buf), out = '', i;
    for (i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(out);
  }
  function strAt(bytes, off, len) {
    var s = '';
    for (var i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i]);
    return s;
  }
  function detectFormat(buf) {
    var b = new Uint8Array(buf);
    if (b.length >= 6) {
      var h = strAt(b, 0, 6);
      if (h === 'GIF87a' || h === 'GIF89a') return 'gif';
    }
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg';
    if (b.length >= 12 && strAt(b, 0, 4) === 'RIFF' && strAt(b, 8, 4) === 'WEBP') return 'webp';
    if (b.length >= 8 && strAt(b, 4, 4) === 'ftyp') return 'mp4';
    return null;
  }
  function loadImageSize(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        URL.revokeObjectURL(url);
        resolve({ img: img, width: w, height: h });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片打不开')); };
      img.src = url;
    });
  }
  function makeThumb(img, maxW) {
    return new Promise(function (resolve) {
      var scale = Math.min(1, maxW / img.naturalWidth);
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (b) {
        if (!b) { resolve(null); return; }
        b.arrayBuffer().then(function (buf) { resolve(bufToB64(buf)); });
      }, 'image/jpeg', 0.8);
    });
  }

  function loadVideoMeta(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'metadata';
      v.onloadedmetadata = function () {
        var dur = v.duration;
        v.currentTime = Math.min(0.1, Math.max(0, (isFinite(dur) ? dur : 1) * 0.05));
      };
      v.onseeked = function () {
        try {
          var scale = Math.min(1, 240 / v.videoWidth);
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(v.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(v.videoHeight * scale));
          canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (b) {
            URL.revokeObjectURL(url);
            if (!b) { resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration, thumbB64: null }); return; }
            b.arrayBuffer().then(function (buf) {
              resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration, thumbB64: bufToB64(buf) });
            });
          }, 'image/jpeg', 0.8);
        } catch (e) {
          URL.revokeObjectURL(url);
          resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration, thumbB64: null });
        }
      };
      v.onerror = function () { URL.revokeObjectURL(url); reject(new Error('视频打不开')); };
      v.src = url;
    });
  }

  async function gh(path, method, body) {
    var pat = getPat();
    var r = await fetch(API + path, {
      method: method,
      headers: {
        'Authorization': 'Bearer ' + pat,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    var data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok) throw new Error((data && data.message) || ('HTTP ' + r.status));
    return data;
  }

  function renderPending() {
    var box = $('upPreview');
    box.innerHTML = '';
    $('upCount').textContent = pending.length ? ('待上传 ' + pending.length + ' 张') : '';
    pending.forEach(function (f, i) {
      var row = document.createElement('div');
      row.className = 'up-file';
      var tag = f.duplicate ? '<span class="up-dup">重复，已在库里</span>' : '';
      row.innerHTML = '<span>' + f.name + '（' + f.format + '，' + f.width + '×' + f.height + '）</span>' + tag
        + ' <button data-i="' + i + '">去掉</button>';
      row.querySelector('button').onclick = function () {
        pending.splice(i, 1);
        renderPending();
      };
      box.appendChild(row);
    });
  }

  async function addFiles(fileList) {
    for (var i = 0; i < fileList.length; i++) {
      var file = fileList[i];
      var isMp4Name = /\.mp4$/i.test(file.name);
      var isImage = !!file.type && file.type.indexOf('image/') === 0;
      var isMp4Type = file.type === 'video/mp4';
      if (!isImage && !isMp4Type && !isMp4Name) {
        log('跳过：' + file.name + ' 不是图片或 MP4');
        continue;
      }
      if (file.size > MAX_MB * 1024 * 1024) {
        log('跳过：' + file.name + ' 超过 ' + MAX_MB + 'MB');
        continue;
      }
      try {
        var buf = await file.arrayBuffer();
        var fmt = detectFormat(buf);
        if (!fmt) { log('跳过：' + file.name + ' 认不出是什么格式'); continue; }
        var md5 = SparkMD5.ArrayBuffer.hash(buf);
        if (pending.some(function (p) { return p.md5 === md5; })) {
          log('跳过：' + file.name + ' 和这一批里的另一张重复');
          continue;
        }
        var width, height, thumbB64, duration = null;
        if (fmt === 'mp4') {
          var meta = await loadVideoMeta(file);
          width = meta.width; height = meta.height; duration = meta.duration; thumbB64 = meta.thumbB64;
        } else {
          var size = await loadImageSize(file);
          width = size.width; height = size.height;
          thumbB64 = await makeThumb(size.img, 240);
        }
        var dup = false;
        if (window.__memeItems && window.__memeItems.length) {
          dup = window.__memeItems.some(function (it) { return it.md5 === md5; });
        }
        pending.push({
          name: file.name, buf: buf, format: fmt, md5: md5,
          width: width, height: height, thumbB64: thumbB64, duration: duration,
          ext: fmt === 'jpg' ? 'jpg' : fmt, duplicate: dup
        });
        log('已加入：' + file.name + '（' + fmt + '）' + (dup ? ' —— 库里已有这张，会跳过' : '') + (fmt === 'mp4' ? ' —— 传上去后会自动转成 GIF' : ''));
      } catch (e) {
        log('失败：' + file.name + ' —— ' + e.message);
      }
    }
    renderPending();
  }

  var uploading = false; // 上传进行中时，标签同步先让路
  async function doUpload() {
    var pat = getPat();
    if (!pat) {
      log('先粘贴 GitHub 密钥再上传（在下面输入框里，保存一次就行）。');
      $('patInput').focus();
      return;
    }
    var fresh = pending.filter(function (f) { return !f.duplicate; });
    if (!fresh.length) { log('没有可传的新图（都在库里了，或还没选图）。'); return; }
    var char = $('upChar').value;
    if (!char) { log('先选一个角色。'); return; }
    if (typeof window.__memeCharNames === 'undefined' || !window.__memeCharNames) {
      window.__memeCharNames = {};
    }
    var charName = window.__memeCharNames[char] || char;
    var tagText = $('upTags').value.trim();
    var tags = tagText ? tagText.split(/[,，、\s]+/).filter(function (t) { return t; }) : [charName];
    var btn = $('uploadBtn');
    btn.disabled = true;
    uploading = true;
    try {
      log('正在连 GitHub…');
      var ref = await gh('/git/ref/heads/main', 'GET');
      var commitSha = ref.object.sha;
      var commit = await gh('/git/commits/' + commitSha, 'GET');
      var baseTree = commit.tree.sha;

      var idxFile = await gh('/contents/index.json', 'GET');
      var raw = new TextDecoder('utf-8').decode(Uint8Array.from(atob(idxFile.content.replace(/\n/g, '')), function (c) { return c.charCodeAt(0); }));
      var indexData = JSON.parse(raw);
      var existingMd5 = new Set((indexData.items || []).map(function (it) { return it.md5; }));
      var prefix = PREFIX[char] || char;
      var added = [];
      var entries = [];

      for (var i = 0; i < fresh.length; i++) {
        var f = fresh[i];
        if (existingMd5.has(f.md5)) { log('跳过（库里已有）：' + f.name); continue; }
        var id = prefix + '-upload-' + f.md5.slice(0, 8);
        var filePath = 'stickers/' + char + '/' + id + '.' + f.ext;
        var thumbPath = 'thumbs/' + char + '/' + id + '.jpg';
        log('正在传：' + f.name + ' → ' + filePath);
        var blob = await gh('/git/blobs', 'POST', { content: bufToB64(f.buf), encoding: 'base64' });
        entries.push({ path: filePath, mode: '100644', type: 'blob', sha: blob.sha });
        if (f.thumbB64) {
          var tblob = await gh('/git/blobs', 'POST', { content: f.thumbB64, encoding: 'base64' });
          entries.push({ path: thumbPath, mode: '100644', type: 'blob', sha: tblob.sha });
        }
        var entry = {
          id: id, file: filePath, thumb: thumbPath, character: char,
          tags: tags, source: 'user-upload', added: todayLocal(),
          format: f.format, width: f.width, height: f.height,
          animated: f.format === 'gif' || f.format === 'mp4', md5: f.md5
        };
        if (f.format === 'mp4') {
          entry.converting = true;
          if (f.duration) entry.duration = Math.round(f.duration * 10) / 10;
        }
        added.push(entry);
      }
      if (!added.length) { log('没有新图入库。'); return; }

      indexData.items = (indexData.items || []).concat(added);
      indexData.count = indexData.items.length;
      indexData.updated = todayLocal();
      var idxBlob = await gh('/git/blobs', 'POST', { content: JSON.stringify(indexData, null, 2) + '\n', encoding: 'utf-8' });
      entries.push({ path: 'index.json', mode: '100644', type: 'blob', sha: idxBlob.sha });

      var tree = await gh('/git/trees', 'POST', { base_tree: baseTree, tree: entries });
      var newCommit = await gh('/git/commits', 'POST', {
        message: 'upload: ' + added.length + ' 张新图 (' + charName + ') via 相册上传',
        tree: tree.sha, parents: [commitSha]
      });
      await gh('/git/refs/heads/main', 'PATCH', { sha: newCommit.sha, force: false });
      log('已入库 ' + added.length + ' 张：' + added.map(function (a) { return a.id; }).join('、'));

      try {
        var body = '用户通过相册上传了 ' + added.length + ' 张新图（角色：' + charName + '，标签：' + tags.join('、') + '）。\n\n';
        var nMp4 = added.filter(function (a) { return a.format === 'mp4'; }).length;
        if (nMp4) body += '其中 ' + nMp4 + ' 个是 MP4，GitHub Action 会在后台自动转成 GIF，转好后相册里自动变成 GIF。\n\n';
        body += added.map(function (a) { return '- ' + a.id + ' (' + a.file + ')'; }).join('\n')
          + '\n\n```json\n' + JSON.stringify(added, null, 2) + '\n```';
        await gh('/issues', 'POST', { title: '[上传] ' + todayLocal() + ' ' + added.length + ' 张新图（' + charName + '）', body: body });
        log('已发 Issue 通知 Konata 同步。');
      } catch (e2) {
        log('注意：文件已入库，但通知 Konata 的 Issue 没发出去（' + e2.message + '），你告诉我一声就行。');
      }
      pending = [];
      renderPending();
      log('完成！点“刷新相册”就能看到新图了。');
      $('reloadBtn').style.display = '';
    } catch (e) {
      log('上传失败：' + e.message);
      if (/Bad credentials/i.test(e.message)) log('密钥不对或过期了：重新建一把粘进来再试。');
      if (/404/.test(e.message)) log('仓库或密钥权限不对：确认密钥给了 meme-library 的 Contents 读写权限。');
    } finally {
      uploading = false;
      btn.disabled = false;
    }
  }

  // —— 标签 / 不喜欢自动同步：用已存的密钥直接写回 index.json，不用再手动发 Issue ——
  // 打标签、标不喜欢后 5 秒自动同步一次（多次改动会合并成一次提交）。
  // 同步成功后本地标记就清掉，提示条只在失败 / 没存密钥时才出现。
  var LS_TAGS_SYNC = 'meme-library-my-tags-v1';
  var LS_DISLIKE_SYNC = 'meme-library-disliked-v1';
  var syncState = { phase: 'idle', error: '' };
  window.__memeSyncState = syncState;
  var syncTimer = null;

  function loadJSONObj(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) { return {}; }
  }
  function saveJSONObj(key, obj) {
    localStorage.setItem(key, JSON.stringify(obj));
  }
  function notifySyncBar() {
    if (typeof window.__memeUpdateSyncBar === 'function') window.__memeUpdateSyncBar();
    if (typeof window.__memeResetSyncDismiss === 'function' && syncState.phase === 'failed') {
      window.__memeResetSyncDismiss();
    }
  }
  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncTimer = null; doTagSync(); }, 5000);
    if (syncState.phase === 'idle') syncState.phase = 'pending';
    notifySyncBar();
  }
  function syncNow() {
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    doTagSync();
  }
  window.__memeScheduleSync = scheduleSync;
  window.__memeSyncNow = syncNow;

  async function applyTagSyncOnce(tags, bad) {
    var ref = await gh('/git/ref/heads/main', 'GET');
    var commitSha = ref.object.sha;
    var commit = await gh('/git/commits/' + commitSha, 'GET');
    var baseTree = commit.tree.sha;
    var idxFile = await gh('/contents/index.json', 'GET');
    var raw = new TextDecoder('utf-8').decode(Uint8Array.from(atob(idxFile.content.replace(/\n/g, '')), function (c) { return c.charCodeAt(0); }));
    var indexData = JSON.parse(raw);
    var items = indexData.items || [];
    var byId = {};
    items.forEach(function (it) { byId[it.id] = it; });
    var changed = false;
    var nTagged = 0, nRemoved = 0;
    Object.keys(tags).forEach(function (id) {
      var list = tags[id] || [];
      if (!list.length) return;
      var it = byId[id];
      if (!it) return;
      var repoTags = it.tags || [];
      var added = list.filter(function (t) { return repoTags.indexOf(t) === -1; });
      if (added.length) { it.tags = repoTags.concat(added); changed = true; nTagged++; }
    });
    var deleteIds = {};
    Object.keys(bad).forEach(function (id) {
      if (byId[id]) { deleteIds[id] = true; nRemoved++; }
    });
    var deletedPaths = [];
    Object.keys(deleteIds).forEach(function (id) {
      var it = byId[id];
      if (it.file) deletedPaths.push(it.file);
      if (it.thumb) deletedPaths.push(it.thumb);
    });
    if (Object.keys(deleteIds).length) changed = true;
    if (!changed) return { tagged: nTagged, removed: nRemoved };
    indexData.items = items.filter(function (it) { return !deleteIds[it.id]; });
    indexData.count = indexData.items.length;
    indexData.updated = todayLocal();
    var entries = [];
    var idxBlob = await gh('/git/blobs', 'POST', { content: JSON.stringify(indexData, null, 2) + '\n', encoding: 'utf-8' });
    entries.push({ path: 'index.json', mode: '100644', type: 'blob', sha: idxBlob.sha });
    deletedPaths.forEach(function (p) {
      entries.push({ path: p, mode: '100644', type: 'blob', sha: null });
    });
    var tree = await gh('/git/trees', 'POST', { base_tree: baseTree, tree: entries });
    var msgParts = [];
    if (nTagged) msgParts.push(nTagged + ' 项加标签');
    if (nRemoved) msgParts.push(nRemoved + ' 项删掉');
    var newCommit = await gh('/git/commits', 'POST', {
      message: 'gallery sync: ' + (msgParts.join('，') || '无改动'),
      tree: tree.sha, parents: [commitSha]
    });
    await gh('/git/refs/heads/main', 'PATCH', { sha: newCommit.sha, force: false });
    return { tagged: nTagged, removed: nRemoved };
  }

  async function doTagSync() {
    var tags = loadJSONObj(LS_TAGS_SYNC);
    var bad = loadJSONObj(LS_DISLIKE_SYNC);
    var tagIds = Object.keys(tags).filter(function (id) { return (tags[id] || []).length; });
    var badIds = Object.keys(bad);
    if (!tagIds.length && !badIds.length) {
      syncState.phase = 'idle'; syncState.error = '';
      notifySyncBar();
      return;
    }
    if (!getPat()) {
      syncState.phase = 'no-pat'; syncState.error = '';
      notifySyncBar();
      return;
    }
    if (uploading) {
      // 上传进行中，先让路，过 15 秒再试
      syncState.phase = 'pending';
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(function () { syncTimer = null; doTagSync(); }, 15000);
      notifySyncBar();
      return;
    }
    syncState.phase = 'syncing'; syncState.error = '';
    notifySyncBar();
    var result = null, lastErr = null;
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        result = await applyTagSyncOnce(tags, bad);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) {
      syncState.phase = 'failed';
      syncState.error = lastErr.message || String(lastErr);
      log('标签同步失败：' + syncState.error + '（可以点底下的重试，或用“提交给 Konata”走 Issue）');
      notifySyncBar();
      return;
    }
    // 成功：只清掉这次同步快照里的标签（同步中途新加的标签要留着，等下一次同步）
    var tags2 = loadJSONObj(LS_TAGS_SYNC);
    tagIds.forEach(function (id) {
      var cur = tags2[id] || [];
      var snap = tags[id] || [];
      var remaining = cur.filter(function (t) { return snap.indexOf(t) === -1; });
      if (remaining.length) tags2[id] = remaining; else delete tags2[id];
    });
    var bad2 = loadJSONObj(LS_DISLIKE_SYNC);
    badIds.forEach(function (id) { delete bad2[id]; });
    saveJSONObj(LS_TAGS_SYNC, tags2);
    saveJSONObj(LS_DISLIKE_SYNC, bad2);
    syncState.phase = 'idle'; syncState.error = '';
    notifySyncBar();
    if (typeof window.__memeAfterSync === 'function') {
      window.__memeAfterSync({ tags: tags, badIds: badIds });
    }
  }

  // —— 全页面拖拽：把图片拖进浏览器任意处，自动打开上传面板 ——
  var dragDepth = 0;
  function dragHasFiles(e) {
    var dt = e.dataTransfer;
    if (!dt || !dt.types) return false;
    for (var i = 0; i < dt.types.length; i++) {
      if (dt.types[i] === 'Files') return true;
    }
    return false;
  }
  window.addEventListener('dragenter', function (e) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    $('dropOverlay').classList.add('show');
  });
  window.addEventListener('dragover', function (e) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
  });
  window.addEventListener('dragleave', function (e) {
    if (!dragHasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropOverlay').classList.remove('show');
  });
  window.addEventListener('drop', function (e) {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').classList.remove('show');
    // 落在上传面板自己的拖放区里时，让面板自己的处理接手，避免重复加入
    var t = e.target;
    if (t && t.closest && t.closest('#uploadPanel')) return;
    var files = e.dataTransfer.files;
    if (!files || !files.length) return;
    var p = $('uploadPanel');
    if (p.style.display === 'none') {
      p.style.display = 'block';
      refreshPatHint();
    }
    addFiles(files);
    p.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // —— 绑定 UI ——
  $('uploadToggleBtn').onclick = function () {
    var p = $('uploadPanel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
    if (p.style.display === 'block') refreshPatHint();
  };
  $('dropZone').onclick = function () { $('fileInput').click(); };
  $('fileInput').onchange = function () { addFiles(this.files); this.value = ''; };
  var dz = $('dropZone');
  dz.ondragover = function (e) { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = function () { dz.classList.remove('over'); };
  dz.ondrop = function (e) {
    e.preventDefault();
    dz.classList.remove('over');
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  };
  $('uploadBtn').onclick = doUpload;
  $('clearFilesBtn').onclick = function () {
    pending = [];
    renderPending();
    log('已清空待传列表。');
  };
  $('savePatBtn').onclick = function () {
    var v = $('patInput').value.trim();
    if (!v) { log('先粘贴密钥。'); return; }
    localStorage.setItem(LS_PAT, v);
    $('patInput').value = '';
    refreshPatHint();
    log('密钥已保存在你这个浏览器里。');
    scheduleSync();
  };
  $('clearPatBtn').onclick = function () {
    localStorage.removeItem(LS_PAT);
    refreshPatHint();
    log('密钥已清除。');
  };
  $('reloadBtn').onclick = function () { location.reload(); };

  function refreshPatHint() {
    $('patHint').textContent = getPat() ? '密钥已保存 ✓' : '还没保存密钥';
  }
  refreshPatHint();
})();
