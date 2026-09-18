import dns from 'node:dns/promises';
import net from 'node:net';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return (
      p[0] === 10 || p[0] === 127 || p[0] === 0 || p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168)
    );
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || /^fe[89ab]/.test(x);
  }
  return true;
}

async function assertPublicUrl(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('unsupported_protocol');
  if (u.username || u.password) throw new Error('credentials_not_allowed');

  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('local_host');

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('private_ip');
  } else {
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) throw new Error('private_ip');
  }
  return u;
}

function isChwaHlink(rawUrl) {
  try {
    const u = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.toLowerCase();

    let hlId = '';
    for (const [key, value] of u.searchParams.entries()) {
      if (key.toLowerCase() === 'hlid') {
        hlId = value;
        break;
      }
    }

    return host === 'chwa.com.tw' &&
      path.endsWith('/chwahlink.asp') &&
      /^\d+$/.test(hlId);
  } catch {
    return false;
  }
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function decodeJsUrl(value) {
  return decodeHtmlEntities(value)
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, '/')
    .trim();
}

function toAbsoluteTarget(rawTarget, baseUrl) {
  const cleaned = decodeJsUrl(rawTarget)
    .replace(/^['"]|['"]$/g, '')
    .replace(/;\s*$/, '')
    .trim();

  if (!cleaned || cleaned === '#' || /^javascript:/i.test(cleaned)) return null;

  try {
    const target = new URL(cleaned, baseUrl);
    if (!['http:', 'https:'].includes(target.protocol)) return null;
    return target.href;
  } catch {
    return null;
  }
}

function extractClientRedirect(html, baseUrl) {
  const source = String(html || '').slice(0, 600000);

  // 1) Meta Refresh：
  // <meta http-equiv="refresh" content="0; url=https://example.com/...">
  for (const meta of source.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = meta[0];
    if (!/http-equiv\s*=\s*(?:"refresh"|'refresh'|refresh)/i.test(tag)) continue;

    const contentMatch =
      tag.match(/content\s*=\s*"([^"]*)"/i) ||
      tag.match(/content\s*=\s*'([^']*)'/i) ||
      tag.match(/content\s*=\s*([^\s>]+)/i);

    const decodedContent = decodeHtmlEntities(contentMatch?.[1] || '');

    // 先把 &amp; 解碼後再取 url= 後方全部內容，
    // 避免把網址 query string 中的 &amp; 誤當成結束符號。
    const urlMatch = decodedContent.match(
      /(?:^|;)\s*url\s*=\s*(?:"([^"]+)"|'([^']+)'|(.+))$/i
    );

    const candidate = urlMatch?.[1] || urlMatch?.[2] || urlMatch?.[3];
    const target = toAbsoluteTarget(candidate, baseUrl);
    if (target) return target;
  }

  // 2) JavaScript location 導向
  const patterns = [
    /(?:window\.|top\.|parent\.|document\.)?location(?:\.href)?\s*=\s*(["'])(.*?)\1/gi,
    /(?:window\.|top\.|parent\.|document\.)?location\.(?:replace|assign)\s*\(\s*(["'])(.*?)\1\s*\)/gi,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const target = toAbsoluteTarget(match[2], baseUrl);
      if (target) return target;
    }
  }

  return null;
}

async function probe(raw, timeoutMs = 9000) {
  let current = raw;
  const maxHops = 8;
  const visited = new Set();

  for (let hop = 0; hop <= maxHops; hop += 1) {
    let url;

    try {
      url = await assertPublicUrl(current);
    } catch (error) {
      const code = error?.code || '';
      const message = String(error?.message || '');

      if (
        ['ENOTFOUND', 'ENODATA'].includes(code) ||
        ['unsupported_protocol', 'credentials_not_allowed', 'local_host', 'private_ip'].includes(message)
      ) {
        return { status: 'bad' };
      }

      return { status: 'uncertain', probeUrl: current };
    }

    if (visited.has(url.href)) {
      return { status: 'uncertain', probeUrl: url.href };
    }
    visited.add(url.href);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8',
        },
      });

      clearTimeout(timer);

      // 標準 HTTP 301 / 302 / 307 / 308 等轉址
      if (response.status >= 300 && response.status < 400) {
        try { await response.body?.cancel(); } catch {}
        const location = response.headers.get('location');
        if (!location) return { status: 'ok' };

        current = new URL(location, url).href;
        continue;
      }

      // 明確不存在
      if ([404, 410].includes(response.status)) {
        try { await response.body?.cancel(); } catch {}
        return { status: 'bad' };
      }

      if (response.status >= 200 && response.status < 300) {
        // CHWA hlink 是中介網址：
        // 若回 200，仍需檢查 HTML 是否以 Meta Refresh / JavaScript 再導向。
        if (isChwaHlink(url)) {
          let html = '';
          try {
            html = await response.text();
          } catch {
            try { await response.body?.cancel(); } catch {}
            return { status: 'uncertain', probeUrl: url.href };
          }

          const target = extractClientRedirect(html, url);

          if (target && target !== url.href) {
            current = target;
            continue;
          }

          // hlink 中介頁本身有回應，但無法解析實際目的網址：
          // 不直接當成目的頁有效，改列「需人工確認」。
          return { status: 'uncertain', probeUrl: url.href };
        }

        try { await response.body?.cancel(); } catch {}
        return { status: 'ok' };
      }

      // 延續 v1.5.5：401 / 403 / 429 / 5xx 等至少表示伺服器有實際回應。
      try { await response.body?.cancel(); } catch {}
      return { status: 'ok' };
    } catch {
      clearTimeout(timer);

      // 如果已經從 CHWA 轉到實際目的網址，probeUrl 就會是該目的網址，
      // 前端的瀏覽器二次驗證也會改測真正目的地。
      return { status: 'uncertain', probeUrl: current };
    }
  }

  return { status: 'uncertain', probeUrl: current };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  if (!urls.length || urls.length > 25) {
    return res.status(400).json({ error: 'invalid_urls' });
  }

  const clean = urls
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim())
    .slice(0, 25);

  const results = await Promise.all(
    clean.map(async (url) => ({ url, ...(await probe(url)) }))
  );

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ results });
}
