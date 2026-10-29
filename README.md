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

## iPhone (Safari userscript)

The CLI needs Node and Chromium, which iOS can't run. On iPhone the same browser-stage logic runs as a Safari
userscript: `userscript/link-resolver.user.js`. It skips encoded-param hops, speeds up countdowns, blocks popups and
taps "Get Link / Continue / Skip". A bar at the bottom of the page shows what it's doing. CAPTCHAs you solve yourself,
and then it carries on.

1. Install **Userscripts** (free, App Store).
2. Settings → Apps → Safari → Extensions → Userscripts: turn it on and allow it on **All Websites**.
3. Open the Userscripts app once and pick its scripts folder (e.g. iCloud Drive → Userscripts).
4. In Safari (signed in to GitHub, since the repo is private) open `userscript/link-resolver.user.js` on GitHub and tap
   **Raw**. Then tap the extensions icon in the address bar → Userscripts → **Install**. Or save the file into the
   scripts folder with the Files app.
5. Open your shortener link in Safari.

It only runs on the hosts in its `@match` list. To add a site, add it to `SHORTENER_HOSTS` in `resolve.js` and run
`npm run build:userscript`, or add an `// @match *://*.example.com/*` line to the script in the Userscripts app.
If a site opens the real destination in a popup, the bar shows it as "Blocked popup: …". Tap it to go there.

For plain shorteners only (bit.ly, tinyurl, no ad pages) the built-in Shortcuts app is enough: a shortcut with
*Receive URLs from Share Sheet* → *Expand URL* → *Show Result*.
