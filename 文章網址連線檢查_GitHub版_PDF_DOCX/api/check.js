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

async function probe(raw, timeoutMs = 9000) {
  let current = raw;
  const maxRedirects = 6;

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    let url;
    try {
      url = await assertPublicUrl(current);
    } catch {
      return false;
    }

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
      try { await response.body?.cancel(); } catch {}

      // 對「網址是否仍可使用」做寬鬆判定：
      // 2xx：正常；3xx：跟隨轉址；401/403/429：站點仍存在，只是限制自動存取，因此視為可連線。
      if (response.status >= 200 && response.status < 300) return true;
      if ([401, 403, 429].includes(response.status)) return true;

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return true;
        current = new URL(location, url).href;
        continue;
      }

      return false;
    } catch {
      clearTimeout(timer);
      return false;
    }
  }

  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  if (!urls.length || urls.length > 25) return res.status(400).json({ error: 'invalid_urls' });

  const clean = urls.filter((x) => typeof x === 'string').map((x) => x.trim()).slice(0, 25);
  const results = await Promise.all(clean.map(async (url) => ({ url, ok: await probe(url) })));

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ results });
}
