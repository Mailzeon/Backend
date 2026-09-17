// ─── IndexNow ────────────────────────────────────────────────────────────
// IndexNow (https://www.indexnow.org) is a shared protocol Bing, Yandex,
// and a growing list of other search engines all honor — one ping tells
// every participant at once "this URL changed, come look", instead of
// each of them discovering it independently on their own crawl schedule
// (which, for a small/new site with little crawl budget allocated to it,
// can take days to weeks). Google doesn't participate in IndexNow itself,
// so this is purely a Bing/Yandex/etc. accelerant — Google Search Console
// still needs its own "Request Indexing" for that engine specifically.
//
// The key file this reads matches the plain-text key file that must be
// published at the site root for a submission to be trusted at all — see
// frontend's public/e5c9d5958219182aee62babd09310fda.txt (the filename
// IS the key). If that key ever needs rotating, regenerate both the key
// file and this constant together — a mismatched key makes every
// submission silently rejected.
const INDEXNOW_KEY = 'e5c9d5958219182aee62babd09310fda';
const SITE_HOST     = 'mailzeon.shop';

/**
 * Submits one or more URLs to IndexNow. Fire-and-forget by design — a
 * failed submission here should never block or fail whatever triggered
 * it (an admin clicking a button, a deploy hook, etc.); it only ever logs.
 * Returns true if the submission was accepted (IndexNow returns 200 or
 * 202 on success), false otherwise.
 */
export async function submitToIndexNow(urls: string[]): Promise<boolean> {
  if (urls.length === 0) return true;

  try {
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: SITE_HOST,
        key: INDEXNOW_KEY,
        keyLocation: `https://${SITE_HOST}/${INDEXNOW_KEY}.txt`,
        urlList: urls,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const ok = res.status === 200 || res.status === 202;
    if (!ok) console.error(`[IndexNow] Submission returned ${res.status}`);
    return ok;
  } catch (err) {
    console.error('[IndexNow] Submission failed:', err);
    return false;
  }
}

// Every real public page — same list as frontend's app/sitemap.ts, kept
// in sync manually since they live in different repos. Used for the
// one-time/occasional "submit everything" admin action rather than
// per-page granular submission, since this whole site is a small, mostly-
// static set of marketing pages rather than something with per-item URLs
// (like per-product pages) that would benefit from submitting just the
// one that changed.
export const ALL_PUBLIC_URLS = [
  `https://${SITE_HOST}/`,
  `https://${SITE_HOST}/pricing`,
  `https://${SITE_HOST}/contact`,
  `https://${SITE_HOST}/terms`,
  `https://${SITE_HOST}/refund-policy`,
];
