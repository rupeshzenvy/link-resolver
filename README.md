# link-resolver

Follows a chain of link shorteners (including ad/interstitial ones) and prints the final destination URL.

```bash
npm install                 # installs playwright
npx playwright install chromium   # once, on your own machine
node resolve.js https://short.link/abc          # prints final URL, hop log on stderr
node resolve.js https://short.link/abc --json   # full chain as JSON
```

Flags: `--max-hops N` (default 25), `--no-browser` (HTTP stage only, fast),
`--show` (visible browser window, so you can solve a CAPTCHA yourself), `--real-timers` (don't speed up countdowns).
Env: `SHORTENER_HOSTS=a.com,b.net` adds hosts to treat as intermediate hops; `CHROMIUM_PATH` uses an existing Chromium.

How it works:
1. **HTTP stage**: 3xx, `Refresh` header, `<meta refresh>`, inline `location.href=...`, and destination URLs hidden in
   query params (plain, URL-encoded, base64, reversed base64). Most plain shorteners finish here in well under a second.
2. **Browser stage** (only for interstitials): headless Chromium with ad/popunder requests blocked, `window.open`
   disabled, timers sped up 20x, and "Get Link / Continue / Skip" buttons clicked until it lands on a non-shortener page.

Exit code 0 = resolved; 1 = stuck/blocked (the last URL reached is still printed). CAPTCHAs are not solved: it stops
and reports `blocked`. Rerun with `--show` to solve it by hand. If a site checks countdown timing on the server, use `--real-timers`.

Test: `npm test` (local fake chain, no internet needed).
