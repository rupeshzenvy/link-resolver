#!/usr/bin/env node
// Follows a chain of (ad) link shorteners to the final destination URL.
//
// Stage 1 (fast, no browser): HTTP 3xx, Refresh header, <meta refresh>,
//   simple JS redirects, and target URLs embedded in query params (plain,
//   URL-encoded or base64).
// Stage 2 (headless Chromium): for interstitial pages with countdowns and
//   "Get link / Continue / Skip" buttons. Popups and ad requests are blocked,
//   timers are sped up, and buttons are clicked until we leave the shortener.
//
// Does not solve CAPTCHAs: if one blocks the chain it stops and reports the
// URL it got stuck on.
//
// Usage: node resolve.js <url> [--json] [--max-hops 25] [--no-browser] [--show]

const MAX_HOPS_DEFAULT = 25;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Hosts that are known redirectors / ad shorteners. Anything else that we land
// on and that doesn't itself redirect is treated as the final destination.
const SHORTENER_HOSTS = [
  'bit.ly', 'bitly.com', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'v.gd',
  'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at', 'rb.gy', 't.ly', 'tiny.cc',
  'adf.ly', 'j.gs', 'q.gs', 'shorte.st', 'sh.st', 'ouo.io', 'ouo.press', 'bc.vc',
  'linkvertise.com', 'link-to.net', 'exe.io', 'exey.io', 'shrinkme.io', 'shrinke.me',
  'shrinkearn.com', 'gplinks.co', 'gplinks.in', 'droplink.co', 'adfoc.us', 'za.gl',
  'clk.sh', 'clk.wiki', 'fc.lc', 'fc-lc.com', 'link1s.com', 'short.pe', 'shortzon.com',
  'cuty.io', 'cuttlinks.com', 'mboost.me', 'boost.ink', 'sub2unlock.com', 'lnk2.cc',
  'shortest.link', 'adshrink.it', 'shrtfly.com', 'try2link.com', 'earnow.online',
  'urlshortx.com', 'tnshort.net', 'indianshortner.com', 'modijiurl.com', 'xpshort.com',
  'linksfly.me', 'upshrink.com', 'atglinks.com', 'kingurl.in', 'ez4short.com',
];
const EXTRA_HOSTS = (process.env.SHORTENER_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);

// Requests to these are dropped in the browser stage (ads/trackers/popunders).
const BLOCKED_REQUEST_RE =
  /(doubleclick|googlesyndication|adservice|adnxs|popads|popcash|propellerads|adsterra|exoclick|juicyads|onclkds|hilltopads|monetag|a-ads|clickadu|adcash|mgid|taboola|outbrain|revcontent|pushame|push-notification|notix)\./i;

const CONTINUE_RE =
  /^\s*(get\s*link|get\s*the\s*link|continue|skip(\s*ad)?|proceed|go\s*to\s*link|open\s*link|click\s*here(\s*to\s*continue)?|next|i('|’)?m\s*not\s*a\s*robot|verify|unlock|visit\s*link|download|go\s*to\s*destination|get\s*download\s*link)\b/i;

const URL_PARAM_KEYS = ['url', 'u', 'link', 'target', 'dest', 'destination', 'redirect', 'redirect_url', 'r', 'to', 'go', 'out', 'q', 'href', 'l', 'k', 'id', 'token', 'api'];

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function isShortener(u) {
  const h = hostOf(u);
  return [...SHORTENER_HOSTS, ...EXTRA_HOSTS].some(s => h === s || h.endsWith('.' + s));
}

function looksLikeUrl(s) {
  if (typeof s !== 'string' || !/^https?:\/\/[^\s"'<>]+$/i.test(s.trim())) return false;
  try { return !!new URL(s.trim()).hostname; } catch { return false; }
}

function tryDecode(s) {
  const out = [];
  if (!s) return out;
  let v = s;
  for (let i = 0; i < 3; i++) { // handle double/triple URL-encoding
    try { const d = decodeURIComponent(v); if (d === v) break; v = d; } catch { break; }
  }
  out.push(v);
  for (const cand of [v, v.split('').reverse().join('')]) {
    if (/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(cand)) {
      try {
        const b = Buffer.from(cand.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        out.push(b);
        try { out.push(decodeURIComponent(b)); } catch {}
      } catch {}
    }
  }
  return out;
}

// A destination URL hidden in the current URL's query string / hash.
function embeddedUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch { return null; }
  const params = new URLSearchParams(parsed.search);
  if (parsed.hash.length > 1) {
    const h = parsed.hash.slice(1);
    for (const [k, v] of new URLSearchParams(h)) params.append(k, v);
    params.append('#', h);
  }
  const ordered = [...params].sort(([a], [b]) => {
    const ia = URL_PARAM_KEYS.indexOf(a.toLowerCase()), ib = URL_PARAM_KEYS.indexOf(b.toLowerCase());
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const [, v] of ordered) {
    for (const d of tryDecode(v)) {
      if (looksLikeUrl(d) && hostOf(d) !== parsed.hostname.replace(/^www\./, '')) return d.trim();
    }
  }
  return null;
}

function resolveRel(target, base) {
  try { return new URL(target.replace(/&amp;/g, '&'), base).href; } catch { return null; }
}

// Redirect target from an HTML body (meta refresh / trivial JS redirect).
function htmlRedirect(html, base) {
  const meta = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?\s*\d+\s*;\s*url=['"]?([^"'>\s]+)/i)
    || html.match(/<meta[^>]+content=["']?\s*\d+\s*;\s*url=['"]?([^"'>\s]+)[^>]*http-equiv=["']?refresh/i);
  if (meta) return resolveRel(meta[1], base);
  const js = html.match(/(?:window\.|document\.|top\.|self\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i)
    || html.match(/location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/i);
  if (js) return resolveRel(js[1], base);
  return null;
}

async function httpStage(start, maxHops, log) {
  let url = start;
  const chain = [url];
  for (let i = 0; i < maxHops; i++) {
    const emb = embeddedUrl(url);
    if (emb) { log(`  [param]   ${emb}`); url = emb; chain.push(url); continue; }

    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        headers: { 'user-agent': UA, accept: 'text/html,*/*' },
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      log(`  [http]    fetch failed: ${e.cause?.message || e.message}`);
      return { url, chain, needsBrowser: true };
    }

    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      url = resolveRel(loc, url); log(`  [${res.status}]     ${url}`); chain.push(url); continue;
    }
    const refresh = res.headers.get('refresh')?.match(/url=(.+)$/i);
    if (refresh) { url = resolveRel(refresh[1].trim(), url); log(`  [refresh] ${url}`); chain.push(url); continue; }

    const type = res.headers.get('content-type') || '';
    if (!type.includes('html')) return { url, chain, needsBrowser: false };
    const html = await res.text();
    const next = htmlRedirect(html, url);
    if (next && next !== url) { url = next; log(`  [html]    ${url}`); chain.push(url); continue; }

    // Plain page with no redirect: done unless it's a known interstitial.
    return { url, chain, needsBrowser: isShortener(url) || res.status >= 400 };
  }
  return { url, chain, needsBrowser: false };
}

// Injected before page scripts: makes countdown timers run ~20x faster and
// suppresses window.open popunders.
const INIT_SCRIPT = `
(() => {
  const k = 20;
  const st = window.setTimeout, si = window.setInterval;
  window.setTimeout = (f, d, ...a) => st(f, Math.max(0, (d || 0) / k), ...a);
  window.setInterval = (f, d, ...a) => si(f, Math.max(10, (d || 0) / k), ...a);
  window.open = () => null;
})();`;

async function browserStage(start, maxHops, log, { show, fastTimers }) {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch {
    throw new Error('playwright not installed: run `npm install` in this folder');
  }
  const proxyEnv = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch({
    headless: !show,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    ...(proxyEnv ? { proxy: { server: proxyEnv, bypass: process.env.NO_PROXY || process.env.no_proxy || '' } } : {}),
  });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  if (fastTimers) await ctx.addInitScript(INIT_SCRIPT);
  await ctx.route('**/*', r => (BLOCKED_REQUEST_RE.test(r.request().url()) ? r.abort() : r.continue()));

  const page = await ctx.newPage();
  ctx.on('page', p => { if (p !== page) p.close().catch(() => {}); }); // kill popups/new tabs
  page.on('dialog', d => d.dismiss().catch(() => {}));

  const chain = [start];
  page.on('framenavigated', f => {
    if (f === page.mainFrame() && f.url() !== chain[chain.length - 1] && f.url() !== 'about:blank') {
      chain.push(f.url()); log(`  [nav]     ${f.url()}`);
    }
  });

  let status = 'ok', note = '';
  try {
    await page.goto(start, { waitUntil: 'domcontentloaded', timeout: 45000 });
    let idleRounds = 0;
    for (let step = 0; step < maxHops * 3; step++) {
      await page.waitForTimeout(1500);
      const cur = page.url();

      const emb = embeddedUrl(cur);
      if (emb && isShortener(cur)) { log(`  [param]   ${emb}`); await page.goto(emb, { waitUntil: 'domcontentloaded' }).catch(() => {}); continue; }

      const captcha = await page.$('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile');
      const clicked = await clickContinue(page);
      if (clicked) { log(`  [click]   "${clicked}"`); idleRounds = 0; continue; }

      if (!isShortener(cur) && !captcha) { if (++idleRounds >= 2) break; continue; }
      if (captcha && ++idleRounds >= 4) { status = 'blocked'; note = 'CAPTCHA required on this page'; break; }
      if (++idleRounds >= 10) { status = 'stuck'; note = 'no redirect or continue button found'; break; }
    }
  } catch (e) {
    status = 'error'; note = e.message.split('\n')[0];
  }
  const url = page.url();
  await browser.close();
  return { url, chain, status, note };
}

// Clicks the most likely "continue" control. Returns its label or null.
async function clickContinue(page) {
  for (const frame of page.frames()) {
    const handle = await frame.evaluateHandle((reSrc) => {
      const re = new RegExp(reSrc, 'i');
      const els = [...document.querySelectorAll('a, button, input[type=submit], input[type=button], [role=button], div[onclick], span[onclick]')];
      const vis = el => {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.1;
      };
      return els.find(el => {
        const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
        return t.length < 60 && re.test(t) && vis(el) && !el.disabled && !el.classList.contains('disabled');
      }) || null;
    }, CONTINUE_RE.source).catch(() => null);
    const el = handle?.asElement();
    if (!el) continue;
    const label = ((await el.innerText().catch(() => '')) || (await el.getAttribute('value')) || 'button').trim();
    await el.click({ timeout: 3000 }).catch(() => el.evaluate(n => n.click()).catch(() => {}));
    return label;
  }
  return null;
}

async function resolve(url, opts = {}) {
  const maxHops = opts.maxHops ?? MAX_HOPS_DEFAULT;
  const log = opts.quiet ? () => {} : (m) => process.stderr.write(m + '\n');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  log(`→ ${url}`);
  const http = await httpStage(url, maxHops, log);
  if (!http.needsBrowser || opts.noBrowser) {
    return { start: url, final: http.url, chain: http.chain, status: http.needsBrowser ? 'incomplete' : 'ok', stage: 'http' };
  }
  log(`  … interstitial at ${http.url}, opening browser`);
  const br = await browserStage(http.url, maxHops, log, { show: opts.show, fastTimers: opts.fastTimers ?? true });
  return { start: url, final: br.url, chain: [...http.chain, ...br.chain.slice(1)], status: br.status, note: br.note, stage: 'browser' };
}

module.exports = { resolve, embeddedUrl, htmlRedirect, isShortener };

if (require.main === module) {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a));
  if (!url) { console.error('usage: node resolve.js <url> [--json] [--max-hops N] [--no-browser] [--show] [--real-timers]'); process.exit(2); }
  const mh = args.indexOf('--max-hops');
  resolve(url, {
    maxHops: mh >= 0 ? +args[mh + 1] : undefined,
    noBrowser: args.includes('--no-browser'),
    show: args.includes('--show'),
    fastTimers: !args.includes('--real-timers'),
  }).then(r => {
    if (args.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else {
      console.error(`\nstatus: ${r.status}${r.note ? ` (${r.note})` : ''}, ${r.chain.length - 1} hop(s)`);
      console.log(r.final);
    }
    process.exit(r.status === 'ok' ? 0 : 1);
  }).catch(e => { console.error('error:', e.message); process.exit(1); });
}
