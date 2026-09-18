import './style.css';
import JSZip from 'jszip';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const app = document.querySelector('#app');
app.innerHTML = `
  <main class="wrap">
    <section class="header">
      <h1>文章網址連線檢查 v1.5.4</h1>
      <p>上傳 PDF 或 Word（DOCX），系統會在瀏覽器中擷取網址，再逐一檢查是否可開啟。結果只分成「可連線」與「無法連線」。</p>
    </section>

    <section class="card">
      <div id="dropzone" class="dropzone">
        <strong>拖曳 PDF／DOCX 到這裡</strong>
        <span>或按下方按鈕選擇檔案，可一次上傳多個檔案</span>
      </div>
      <input id="fileInput" class="hidden" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple />
      <div class="actions">
        <button id="chooseBtn" class="btn btn-secondary">選擇 PDF／Word</button>
        <button id="checkBtn" class="btn btn-primary" disabled>開始檢查</button>
        <button id="clearBtn" class="btn btn-danger" disabled>全部清除</button>
        <span id="fileMeta" class="meta">尚未加入檔案</span>
      </div>
      <div id="fileList" class="file-list"></div>
      <div class="note">Word 支援 .docx；舊式 .doc 請先在 Word 另存為 .docx。本工具以可複製文字層與文件內建超連結為主，並支援網址緊接中文、全形標點及常見換行切斷情況。</div>
    </section>

    <section class="card">
      <div class="stats">
        <div class="stat"><span>共檢查</span><b id="total">0</b></div>
        <div class="stat"><span>可連線</span><b id="ok">0</b></div>
        <div class="stat"><span>無法連線</span><b id="bad">0</b></div>
      </div>
      <div class="progress"><div id="progressBar"></div></div>
    </section>

    <section class="card">
      <div class="toolbar">
        <button id="exportBtn" class="btn btn-secondary" disabled>匯出 CSV</button>
        <button id="copyBadBtn" class="btn btn-secondary" disabled>複製無法連線網址</button>
        <span id="statusText" class="status">等待檢查</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th style="width:60px">序號</th><th style="width:170px">檔案</th><th style="width:120px">PDF 頁碼</th><th>網址</th><th style="width:120px">結果</th><th style="width:190px">YouTube 影片</th></tr>
          </thead>
          <tbody id="tbody"><tr><td colspan="6" class="empty">尚無檢查結果</td></tr></tbody>
        </table>
      </div>
      <div class="note">同一檔案中的相同網址只保留一列；PDF 頁碼欄會列出該網址在同一份 PDF 出現的全部頁數，例如 3、7。YouTube 網址會再以官方播放器 API 判斷影片是否可嵌入播放；一般網址維持「可連線／無法連線」。文件內容會在你的瀏覽器本機解析；後端只會收到擷取後的網址，不會收到 PDF 或 Word 檔案本身。</div>
    </section>
  </main>
`;

const el = (id) => document.getElementById(id);
const dropzone = el('dropzone');
const fileInput = el('fileInput');
const chooseBtn = el('chooseBtn');
const checkBtn = el('checkBtn');
const clearBtn = el('clearBtn');
const fileList = el('fileList');
const fileMeta = el('fileMeta');
const exportBtn = el('exportBtn');
const copyBadBtn = el('copyBadBtn');
const statusText = el('statusText');
const tbody = el('tbody');
const progressBar = el('progressBar');

let files = [];
let results = [];

const HIDDEN_CHAR_RE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
// 教材／書稿中的網址大多為 ASCII URL。刻意不把中文字納入網址主體，
// 因此「請至https://example.com查詢」也能只抓到真正網址。
const URL_BODY = `[A-Za-z0-9\\-._~:/?#\\[\\]@$&'()*+=%]`;
const PROTOCOL_RE = new RegExp(`https?:\\/\\/${URL_BODY}+`, 'giu');
const WWW_RE = new RegExp(`www\\d*\\.${URL_BODY}+`, 'giu');
// 裸網域採較保守判定：至少三段，例如 moe.gov.tw、ghg.tgpf.org.tw。
// 這可避免把正文中的品牌／詞語（如 d.school、d.manifesto）誤判成網址。
// 若只有兩段網域，但文件明確寫成 https://example.com 或 www.example.com，仍會正常辨識。
const DOMAIN_LABEL = `[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?`;
const DOMAIN_CORE = `(?:${DOMAIN_LABEL}\\.){2,}[A-Za-z]{2,63}`;
const BARE_DOMAIN_RE = new RegExp(`${DOMAIN_CORE}(?:\\/${URL_BODY}*)?`, 'gu');
const BARE_DOMAIN_FULL_RE = new RegExp(`^${DOMAIN_CORE}(?:\\/${URL_BODY}*)?$`, 'iu');
const SIMPLE_TRAILING_RE = /[.,;:!?，。；：！？、」』】》〉〕]+$/u;

function normalizeDocumentText(text) {
  return String(text || '')
    .replace(HIDDEN_CHAR_RE, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n');
}

function trimUnbalancedClosers(value) {
  let u = value;
  const pairs = [['(', ')'], ['[', ']'], ['{', '}']];
  for (const [open, close] of pairs) {
    while (u.endsWith(close)) {
      const openCount = [...u].filter((c) => c === open).length;
      const closeCount = [...u].filter((c) => c === close).length;
      if (closeCount <= openCount) break;
      u = u.slice(0, -1);
    }
  }
  return u;
}

function cleanUrl(raw) {
  let u = normalizeDocumentText(raw).trim().replace(/^[<「『【《〈〔]+/u, '');
  u = u.replace(SIMPLE_TRAILING_RE, '');
  u = trimUnbalancedClosers(u);

  if (/^www\d*\./i.test(u)) {
    u = `https://${u}`;
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u) && BARE_DOMAIN_FULL_RE.test(u)) {
    u = `https://${u}`;
  }

  try {
    const parsed = new URL(u);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    if (!parsed.hostname || !parsed.hostname.includes('.')) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

function repairLikelyBrokenUrls(text) {
  // 只修復「已經進入網址、而且網址結構符號後換行」的情況，
  // 不會把一般段落中的兩行文字任意接起來。
  let s = normalizeDocumentText(text);
  let previous;
  do {
    previous = s;
    s = s.replace(
      /(https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@$&'()*+=%]{0,500}[\/.?&=#_%~-])[ \t]*\n[ \t]*(?=[A-Za-z0-9%])/giu,
      '$1',
    );
    s = s.replace(
      /(www\d*\.[A-Za-z0-9\-._~:/?#\[\]@$&'()*+=%]{0,500}[\/.?&=#_%~-])[ \t]*\n[ \t]*(?=[A-Za-z0-9%])/giu,
      '$1',
    );
  } while (s !== previous);
  return s;
}

function collectCandidateMatches(text) {
  const normalized = normalizeDocumentText(text);
  const repaired = repairLikelyBrokenUrls(normalized);
  const view = repaired;
  const matches = [];

  function overlaps(start, end) {
    return matches.some((m) => start < m.end && end > m.start);
  }

  function addMatches(re, kind, skipOverlap = true) {
    re.lastIndex = 0;
    for (const match of view.matchAll(re)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (skipOverlap && overlaps(start, end)) continue;
      matches.push({ raw: match[0], start, end, kind });
    }
  }

  // 依優先順序收集，避免同一個 https://www.example.com
  // 又被 www 規則、裸網域規則重複計算。
  addMatches(PROTOCOL_RE, 'protocol', true);
  addMatches(WWW_RE, 'www', true);
  addMatches(BARE_DOMAIN_RE, 'domain', true);

  return matches.sort((a, b) => a.start - b.start || b.end - a.end);
}

function extractUrlsFromText(text, source, location = '') {
  const out = [];
  for (const match of collectCandidateMatches(text)) {
    const url = cleanUrl(match.raw);
    if (url) {
      out.push({
        url,
        source,
        location,
        offset: match.start,
      });
    }
  }
  return out;
}

function extractWordXmlText(xml) {
  const doc = new DOMParser().parseFromString(String(xml || ''), 'application/xml');
  if (doc.querySelector('parsererror')) return [String(xml || '').replace(/<[^>]+>/g, ' ')];
  const paragraphs = [...doc.getElementsByTagNameNS('*', 'p')];
  if (!paragraphs.length) return [doc.documentElement?.textContent || ''];
  return paragraphs.map((p) => p.textContent || '');
}

async function extractDocx(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const found = [];

  const entries = Object.keys(zip.files).filter((name) =>
    /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/i.test(name),
  );

  for (const name of entries) {
    const xml = await zip.file(name)?.async('text');
    if (!xml) continue;
    for (const paragraphText of extractWordXmlText(xml)) {
      found.push(...extractUrlsFromText(paragraphText, file.name, name));
    }
  }

  const relEntries = Object.keys(zip.files).filter((name) => /^word\/.*\.rels$/i.test(name));
  for (const name of relEntries) {
    const xml = await zip.file(name)?.async('text');
    if (!xml) continue;
    const targetRe = /<Relationship\b[^>]*\bTarget="([^"]+)"[^>]*>/gi;
    for (const m of xml.matchAll(targetRe)) {
      const decoded = m[1]
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      const url = cleanUrl(decoded);
      if (url) found.push({ url, source: file.name, location: 'Word 超連結' });
    }
  }

  return found;
}


function buildPositionAwarePdfText(items) {
  let out = '';
  let previous = null;

  for (const item of items) {
    const str = item?.str || '';
    if (!str) {
      if (item?.hasEOL) out += '\n';
      previous = item || previous;
      continue;
    }

    const t = Array.isArray(item.transform) ? item.transform : [];
    const x = Number(t[4]);
    const y = Number(t[5]);
    const width = Number(item.width) || 0;
    const height = Math.max(
      Math.abs(Number(t[3]) || 0),
      Math.abs(Number(item.height) || 0),
      1,
    );

    if (previous) {
      const pt = Array.isArray(previous.transform) ? previous.transform : [];
      const px = Number(pt[4]);
      const py = Number(pt[5]);
      const pwidth = Number(previous.width) || 0;
      const pheight = Math.max(
        Math.abs(Number(pt[3]) || 0),
        Math.abs(Number(previous.height) || 0),
        1,
      );

      if (previous.hasEOL) {
        out += '\n';
      } else if (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(px) &&
        Number.isFinite(py)
      ) {
        const lineTolerance = Math.max(height, pheight) * 0.45;
        const sameLine = Math.abs(y - py) <= lineTolerance;

        if (!sameLine) {
          // PDF.js 有時沒有 hasEOL；Y 座標已有明顯變化時仍視為換行。
          out += '\n';
        } else {
          const previousEndX = px + pwidth;
          const gap = x - previousEndX;
          const gapThreshold = Math.max(2, Math.min(height, pheight) * 0.28);

          if (gap > gapThreshold) {
            // 同一列但相隔明顯：通常是表格另一欄或下一個文字區塊。
            // 插入空白，避免「網址 + 下一欄文字」被黏成假的網址路徑。
            out += ' ';
          }
          // gap 很小或略為負值時不插空白：
          // 保留 PDF 將同一網址拆成多個相鄰文字 item 時的重組能力。
        }
      } else {
        // 缺少座標資料時採保守做法，避免任意黏字。
        out += ' ';
      }
    }

    out += str;
    previous = item;
  }

  return out;
}

async function extractPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const found = [];

  function countByUrl(rows) {
    const counts = new Map();
    for (const row of rows) {
      counts.set(row.url, (counts.get(row.url) || 0) + 1);
    }
    return counts;
  }

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();

    // 同一頁使用兩種文字排列策略，提高網址跨文字區塊時的辨識率。
    // 最終不把兩種策略的結果相加，而是取同一 URL 的較大出現次數，
    // 避免同一個實際網址被解析器自己重複計算。
    const spacedText = content.items.map((item) => item.str || '').join(' ');
    const lineAwareText = buildPositionAwarePdfText(content.items);

    const spacedRows = extractUrlsFromText(spacedText, file.name, `第 ${pageNo} 頁`);
    const lineRows = extractUrlsFromText(lineAwareText, file.name, `第 ${pageNo} 頁`);

    const spacedCounts = countByUrl(spacedRows);
    const lineCounts = countByUrl(lineRows);

    const annotationCounts = new Map();
    const annotations = await page.getAnnotations();
    for (const a of annotations) {
      const candidate = a.url || a.unsafeUrl || '';
      const url = cleanUrl(candidate);
      if (url) {
        annotationCounts.set(url, (annotationCounts.get(url) || 0) + 1);
      }
    }

    const urls = new Set([
      ...spacedCounts.keys(),
      ...lineCounts.keys(),
      ...annotationCounts.keys(),
    ]);

    for (const url of urls) {
      const count = Math.max(
        spacedCounts.get(url) || 0,
        lineCounts.get(url) || 0,
        annotationCounts.get(url) || 0,
      );

      for (let occurrence = 1; occurrence <= count; occurrence += 1) {
        found.push({
          url,
          source: file.name,
          location: `第 ${pageNo} 頁`,
          page: pageNo,
          occurrence,
        });
      }
    }
  }

  return found;
}

async function extractFile(file) {
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext === 'pdf') return extractPdf(file);
  if (ext === 'docx') return extractDocx(file);
  throw new Error('只支援 PDF 與 DOCX');
}

function mergeByFileAndUrl(items) {
  const map = new Map();

  for (const item of items) {
    const key = `${item.source}@@${item.url}`;

    if (!map.has(key)) {
      map.set(key, {
        ...item,
        sources: [item.source],
        pages: new Set(),
      });
    }

    const row = map.get(key);
    if (Number.isInteger(item.page)) {
      row.pages.add(item.page);
    }
  }

  return [...map.values()].map((row) => ({
    ...row,
    pages: [...row.pages].sort((a, b) => a - b),
  }));
}

const YOUTUBE_HOST_RE = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;
let youtubeApiPromise = null;
const youtubeStatusCache = new Map();

function getYouTubeVideoId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!YOUTUBE_HOST_RE.test(host)) return '';

    let id = '';
    if (host === 'youtu.be') {
      id = url.pathname.split('/').filter(Boolean)[0] || '';
    } else if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (url.pathname === '/watch') {
        id = url.searchParams.get('v') || '';
      } else {
        const parts = url.pathname.split('/').filter(Boolean);
        if (['shorts', 'live', 'embed'].includes(parts[0])) id = parts[1] || '';
      }
    }

    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
  } catch {
    return '';
  }
}

function isYouTubeUrl(url) {
  return Boolean(getYouTubeVideoId(url));
}

function loadYouTubeIframeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;

  youtubeApiPromise = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    const timeout = setTimeout(() => reject(new Error('YouTube Player API 載入逾時')), 12000);

    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout);
      try { previousReady?.(); } catch {}
      resolve(window.YT);
    };

    const existing = document.querySelector('script[data-youtube-iframe-api]');
    if (!existing) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.dataset.youtubeIframeApi = '1';
      script.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('YouTube Player API 無法載入'));
      };
      document.head.appendChild(script);
    }
  });

  return youtubeApiPromise;
}

function youtubeErrorStatus(code) {
  if (code === 100) return '影片不存在／私人';
  if (code === 101 || code === 150) return '存在但禁止嵌入播放';
  if (code === 5) return '無法在播放器播放';
  if (code === 2) return '影片 ID 無效';
  if (code === 153) return '無法確認（播放器識別限制）';
  return '無法確認';
}

async function checkYouTubePlayable(url) {
  const videoId = getYouTubeVideoId(url);
  if (!videoId) return '—';
  if (youtubeStatusCache.has(videoId)) return youtubeStatusCache.get(videoId);

  const checkPromise = (async () => {
    let host;
    let player;
    let settled = false;

    try {
      const YT = await loadYouTubeIframeApi();

      return await new Promise((resolve) => {
        const finish = (status) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { player?.destroy(); } catch {}
          try { host?.remove(); } catch {}
          resolve(status);
        };

        host = document.createElement('div');
        host.className = 'yt-probe';
        document.body.appendChild(host);

        const timer = setTimeout(() => finish('無法確認'), 12000);

        player = new YT.Player(host, {
          width: '200',
          height: '200',
          videoId,
          playerVars: {
            playsinline: 1,
            controls: 0,
            origin: window.location.origin,
          },
          events: {
            onReady: (event) => {
              try { event.target.cueVideoById(videoId); }
              catch { finish('無法確認'); }
            },
            onStateChange: (event) => {
              if (event.data === YT.PlayerState.CUED) finish('可播放');
            },
            onError: (event) => finish(youtubeErrorStatus(Number(event.data))),
          },
        });
      });
    } catch {
      try { player?.destroy(); } catch {}
      try { host?.remove(); } catch {}
      return '無法確認';
    }
  })();

  youtubeStatusCache.set(videoId, checkPromise);
  const status = await checkPromise;
  youtubeStatusCache.set(videoId, status);
  return status;
}

async function enrichYouTubeStatuses(rows, onProgress) {
  const targets = rows.filter((row) => isYouTubeUrl(row.url));
  if (!targets.length) return rows.map((row) => ({ ...row, youtubeStatus: '—' }));

  const statusById = new Map();
  const unique = [];
  for (const row of targets) {
    const id = getYouTubeVideoId(row.url);
    if (id && !statusById.has(id)) {
      statusById.set(id, null);
      unique.push({ id, url: row.url });
    }
  }

  let done = 0;
  for (const item of unique) {
    const status = await checkYouTubePlayable(item.url);
    statusById.set(item.id, status);
    done += 1;
    onProgress?.(done, unique.length);
  }

  return rows.map((row) => {
    const id = getYouTubeVideoId(row.url);
    return { ...row, youtubeStatus: id ? (statusById.get(id) || '無法確認') : '—' };
  });
}

function youtubeBadgeClass(status) {
  if (status === '可播放') return 'yt-ok';
  if (status === '—') return 'yt-na';
  if (status === '無法確認' || status.startsWith('無法確認')) return 'yt-warn';
  return 'yt-bad';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function renderFiles() {
  fileList.innerHTML = files.map((file, i) => `
    <div class="file-item">
      <div><div class="name">${escapeHtml(file.name)}</div><div class="sub">${formatBytes(file.size)}</div></div>
      <button type="button" data-remove="${i}">移除</button>
    </div>
  `).join('');

  fileMeta.textContent = files.length ? `已加入 ${files.length} 個檔案` : '尚未加入檔案';
  checkBtn.disabled = files.length === 0;
  clearBtn.disabled = files.length === 0;

  fileList.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      files.splice(Number(btn.dataset.remove), 1);
      renderFiles();
    });
  });
}

function addFiles(fileListLike) {
  for (const file of [...fileListLike]) {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.pdf') && !lower.endsWith('.docx')) continue;
    const duplicate = files.some((f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified);
    if (!duplicate) files.push(file);
  }
  renderFiles();
}

function setProgress(done, total) {
  progressBar.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
}

function renderResults() {
  el('total').textContent = results.length;
  const ok = results.filter((r) => r.ok).length;
  el('ok').textContent = ok;
  el('bad').textContent = results.length - ok;

  if (!results.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">尚無檢查結果</td></tr>';
    exportBtn.disabled = true;
    copyBadBtn.disabled = true;
    return;
  }

  tbody.innerHTML = results.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml((r.sources || [r.source]).join('、'))}</td>
      <td>${r.pages?.length ? escapeHtml(r.pages.join('、')) : '—'}</td>
      <td class="url">${escapeHtml(r.url)}</td>
      <td><span class="badge ${r.ok ? 'ok' : 'bad'}">${r.ok ? '可連線' : '無法連線'}</span></td>
      <td><span class="badge ${youtubeBadgeClass(r.youtubeStatus || '—')}">${escapeHtml(r.youtubeStatus || '—')}</span></td>
    </tr>
  `).join('');

  exportBtn.disabled = false;
  copyBadBtn.disabled = results.every((r) => r.ok);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function checkBatch(rows) {
  const response = await fetch('/api/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: rows.map((r) => r.url) }),
  });
  if (!response.ok) throw new Error('伺服器檢查失敗');
  return response.json();
}

chooseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('drag');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  addFiles(e.dataTransfer.files);
});
dropzone.addEventListener('click', () => fileInput.click());

clearBtn.addEventListener('click', () => {
  files = [];
  results = [];
  renderFiles();
  renderResults();
  setProgress(0, 0);
  statusText.textContent = '等待檢查';
});

checkBtn.addEventListener('click', async () => {
  checkBtn.disabled = true;
  chooseBtn.disabled = true;
  clearBtn.disabled = true;
  exportBtn.disabled = true;
  copyBadBtn.disabled = true;
  results = [];
  renderResults();
  setProgress(0, 0);

  try {
    statusText.textContent = '正在從文件擷取網址…';
    let extracted = [];
    for (let i = 0; i < files.length; i += 1) {
      statusText.textContent = `解析文件 ${i + 1} / ${files.length}：${files[i].name}`;
      extracted.push(...await extractFile(files[i]));
    }

    const rows = mergeByFileAndUrl(extracted);
    if (!rows.length) {
      statusText.textContent = '文件中沒有找到可辨識的網址';
      return;
    }

    const batchSize = 15;
    let done = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      statusText.textContent = `檢查中 ${done} / ${rows.length}`;
      const data = await checkBatch(batch);
      const byUrl = new Map(data.results.map((r) => [r.url, r.ok]));
      for (const row of batch) results.push({ ...row, ok: Boolean(byUrl.get(row.url)), youtubeStatus: isYouTubeUrl(row.url) ? '檢查中…' : '—' });
      done += batch.length;
      setProgress(done, rows.length);
      renderResults();
    }
    const youtubeCount = results.filter((row) => isYouTubeUrl(row.url)).length;
    if (youtubeCount) {
      statusText.textContent = `正在檢查 YouTube 影片…`;
      results = await enrichYouTubeStatuses(results, (ytDone, ytTotal) => {
        statusText.textContent = `檢查 YouTube 影片 ${ytDone} / ${ytTotal}`;
        renderResults();
      });
      renderResults();
    }

    statusText.textContent = `完成，共 ${rows.length} 筆不重複網址${youtubeCount ? `，其中 ${youtubeCount} 筆為 YouTube 網址` : ''}`;
  } catch (error) {
    console.error(error);
    statusText.textContent = '處理失敗';
    alert(`處理失敗：${error.message}`);
  } finally {
    chooseBtn.disabled = false;
    checkBtn.disabled = files.length === 0;
    clearBtn.disabled = files.length === 0;
    renderResults();
  }
});

exportBtn.addEventListener('click', () => {
  const rows = [['序號', '來源檔案', 'PDF 頁碼', '網址', '結果', 'YouTube 影片狀態']];
  results.forEach((r, i) => rows.push([i + 1, (r.sources || [r.source]).join('、'), r.pages?.length ? r.pages.join('、') : '', r.url, r.ok ? '可連線' : '無法連線', r.youtubeStatus || '—']));
  const csv = '\uFEFF' + rows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = '網址連線檢查結果.csv';
  a.click();
  URL.revokeObjectURL(href);
});

copyBadBtn.addEventListener('click', async () => {
  const text = results.filter((r) => !r.ok).map((r) => r.url).join('\n');
  await navigator.clipboard.writeText(text);
  const old = copyBadBtn.textContent;
  copyBadBtn.textContent = '已複製';
  setTimeout(() => { copyBadBtn.textContent = old; }, 1200);
});

renderFiles();
renderResults();
