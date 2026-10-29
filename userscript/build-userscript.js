#!/usr/bin/env node
// Builds link-resolver.user.js from template.js, taking the shortener host list
// and button patterns from resolve.js so the CLI and the userscript stay in sync.
const fs = require('fs');
const path = require('path');
const { SHORTENER_HOSTS, CONTINUE_RE, URL_PARAM_KEYS } = require('../resolve');

const tpl = fs.readFileSync(path.join(__dirname, 'template.js'), 'utf8');
const matches = SHORTENER_HOSTS.map(h => `// @match        *://*.${h}/*`).join('\n');
const out = tpl
  .replace('/*@@MATCHES@@*/', matches)
  .replace("/*@@CONTINUE_RE@@*/''", JSON.stringify(CONTINUE_RE.source))
  .replace('/*@@PARAM_KEYS@@*/[]', JSON.stringify(URL_PARAM_KEYS));

fs.writeFileSync(path.join(__dirname, 'link-resolver.user.js'), out);
console.log(`wrote userscript/link-resolver.user.js (${SHORTENER_HOSTS.length} hosts)`);
