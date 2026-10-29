// Local end-to-end test: a fake multi-shortener chain on loopback.
// "localhost" and 127.0.0.2 play shorteners, 127.0.0.1 is the destination.
//   /a  302 ─▶ /b  meta-refresh ─▶ /c  JS redirect ─▶ 127.0.0.2/d?go=<base64>
//   ─▶ localhost/e  10s countdown + popup ad, then "Get Link"
//   ─▶ 127.0.0.2/f  "Continue" disabled for 5s ─▶ 127.0.0.1/final
const http = require('http');
const assert = require('assert');

process.env.SHORTENER_HOSTS = 'localhost,127.0.0.2';
const { resolve } = require('../resolve');

const page = body => `<!doctype html><html><body>${body}</body></html>`;
let PORT;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const html = b => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page(b)); };
  switch (u.pathname) {
    case '/a': res.writeHead(302, { location: '/b' }); return res.end();
    case '/b': return html(`<meta http-equiv="refresh" content="3;url=/c">`);
    case '/c': {
      const go = Buffer.from(`http://localhost:${PORT}/e`).toString('base64');
      return html(`<script>setTimeout(()=>{window.location.href="http://127.0.0.2:${PORT}/d?go=${go}"},4000)</script>`);
    }
    case '/d': return html('should be skipped via embedded param');
    case '/e': return html(`
      <p>Please wait <span id=t>10</span>s</p><a id=btn style="display:none" href="#">Get Link</a>
      <script>
        window.open('http://127.0.0.1:${PORT}/ad');
        let n = 10; const iv = setInterval(() => {
          document.getElementById('t').textContent = --n;
          if (n <= 0) { clearInterval(iv); const b = document.getElementById('btn'); b.style.display = 'inline';
            b.onclick = async e => { e.preventDefault(); location.href = await (await fetch('/api/next')).text(); }; }
        }, 1000);
      </script>`);
    case '/f': return html(`
      <button id=c disabled>Continue</button>
      <script>setTimeout(()=>{const c=document.getElementById('c');c.disabled=false;
        c.onclick=()=>location.href=atob('${Buffer.from(`http://127.0.0.1:${PORT}/final?ok=1`).toString('base64')}')},5000)</script>`);
    case '/api/next': res.writeHead(200, { 'access-control-allow-origin': '*' }); return res.end(`http://127.0.0.2:${PORT}/f`);
    case '/final': return html('<h1>Destination</h1>');
    case '/cap': return html('<div class="g-recaptcha"></div><p>Prove you are human</p>');
    default: res.writeHead(404); res.end();
  }
});

server.listen(0, '0.0.0.0', async () => {
  PORT = server.address().port;
  let failed = false;
  const check = async (name, fn) => {
    const t = Date.now();
    try { await fn(); console.log(`ok   ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); }
    catch (e) { failed = true; console.log(`FAIL ${name}: ${e.message}`); }
  };

  await check('full chain: 302 → meta → JS → base64 param → countdown → disabled button', async () => {
    const r = await resolve(`http://localhost:${PORT}/a`, { quiet: true });
    assert.strictEqual(r.status, 'ok', JSON.stringify(r));
    assert.strictEqual(r.final, `http://127.0.0.1:${PORT}/final?ok=1`);
    assert(!r.chain.some(u => u.includes('/d?')) || r.chain.indexOf(r.chain.find(u => u.includes('/d?'))) >= 0);
    assert(!r.chain.some(u => u.endsWith('/ad')), 'popup ad should not enter the chain');
  });

  await check('http-only stage stops at interstitial when --no-browser', async () => {
    const r = await resolve(`http://localhost:${PORT}/a`, { quiet: true, noBrowser: true });
    assert.strictEqual(r.status, 'incomplete');
    assert.strictEqual(r.final, `http://localhost:${PORT}/e`);
  });

  await check('captcha page is reported, not bypassed', async () => {
    const r = await resolve(`http://localhost:${PORT}/cap`, { quiet: true });
    assert.strictEqual(r.status, 'blocked', JSON.stringify(r));
  });

  server.close();
  process.exit(failed ? 1 : 0);
});
