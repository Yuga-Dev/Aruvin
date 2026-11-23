/**
 * ============================================================================
 * FILE: oauth-callback-page.ts
 * LOCATION: backend/src/plugins/web-search/oauth-callback-page.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Serve a static CSP-protected web-search OAuth completion document.
 *
 * ROLE IN PROJECT:
 *    Bridges a provider's cross-site redirect onto Aurvin's origin without
 *    echoing the callback query or claiming a connection from a GET.
 *
 * KEY COMPONENTS:
 *    - oauthCallbackCsp: SHA-256 hash of the exact fixed script.
 *    - oauthCallbackPage: Static provider-specific bridge HTML.
 * ============================================================================
 */

import { createHash } from 'node:crypto';
import type { WebSearchProvider } from '../../contracts/web-search-policy.js';
import { WEB_SEARCH_ROUTES } from '../../contracts/web-search-wire.js';

const scriptFor = (provider: WebSearchProvider): string => `(async()=>{
const rawQuery=location.search.slice(1);history.replaceState(null,'',location.pathname);
try{const r=await fetch(${JSON.stringify('/api' + WEB_SEARCH_ROUTES.oauthComplete(provider))},{
method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
body:JSON.stringify({protocolVersion:1,rawQuery})});
if(!r.ok)throw Error();const x=await r.json();
if(!['connected','denied','expired','failed'].includes(x.outcome))throw Error();
location.replace('/?plugin=web-search&oauth='+encodeURIComponent(x.outcome));
}catch{document.getElementById('status').textContent='Sign in to Aurvin and start the connection again.';}
})();`;

export function oauthCallbackCsp(provider: WebSearchProvider): string {
  const hash = createHash('sha256').update(scriptFor(provider)).digest('base64');
  return `default-src 'none'; script-src 'sha256-${hash}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`;
}

export function oauthCallbackPage(provider: WebSearchProvider): string {
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<title>Completing web search connection</title><p id="status">Completing web search connection…</p>
<script>${scriptFor(provider)}</script>`;
}
