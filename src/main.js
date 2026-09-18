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
      <h1>文章網址連線檢查</h1>
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
            <tr><th style="width:60px">序號</th><th style="width:170px">檔案</th><th style="width:120px">PDF 頁碼</th><th>網址</th><th style="width:120px">結果</th></tr>
          </thead>
          <tbody id="tbody"><tr><td colspan="5" class="empty">尚無檢查結果</td></tr></tbody>
        </table>
      </div>
      <div class="note">同一檔案中的相同網址只保留一列；PDF 頁碼欄會列出該網址在同一份 PDF 出現的全部頁數，例如 3、7。文件內容會在你的瀏覽器本機解析；後端只會收到擷取後的網址，不會收到 PDF 或 Word 檔案本身。</div>
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
const DOMAIN_CORE = `(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z]{2,63}`;
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
    const lineAwareText = content.items
      .map((item) => `${item.str || ''}${item.hasEOL ? '\n' : ''}`)
      .join('');

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
    tbody.innerHTML = '<tr><td colspan="5" class="empty">尚無檢查結果</td></tr>';
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
      for (const row of batch) results.push({ ...row, ok: Boolean(byUrl.get(row.url)) });
      done += batch.length;
      setProgress(done, rows.length);
      renderResults();
    }
    statusText.textContent = `完成，共 ${rows.length} 筆不重複網址`;
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
  const rows = [['序號', '來源檔案', 'PDF 頁碼', '網址', '結果']];
  results.forEach((r, i) => rows.push([i + 1, (r.sources || [r.source]).join('、'), r.pages?.length ? r.pages.join('、') : '', r.url, r.ok ? '可連線' : '無法連線']));
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
