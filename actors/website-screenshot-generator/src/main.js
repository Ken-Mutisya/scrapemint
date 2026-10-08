// Website Screenshot Generator: bulk screenshots of any URL, full page or
// viewport, on desktop, laptop, tablet and phone, as PNG, JPEG, WebP or PDF.
//
// Strategy
// --------
// One headless Chrome (Playwright), one context per device, several pages in
// parallel. Each capture: load, optional scroll to trigger lazy images, hide
// cookie banners and chat widgets, then screenshot (or page.pdf). Images go to
// the run's key-value store; the dataset row carries the public URL to it.
// No proxy: the browser loads the target site directly, as a visitor would.
//
// Pay per event
// -------------
//   screenshot           ($0.003) one above-the-fold or single-element image
//   full_page_screenshot ($0.005) one full-page image, or a PDF
// Full pages cost up to 4x more to render and encode (measured 2026-10-08:
// $0.0026 vs $0.0006 per capture at 4 GB). No start fee. A URL that fails to
// load, or answers 4xx/5xx (a block or error page), is returned free.

import { Actor, log } from 'apify';
import { chromium, devices as pwDevices } from 'playwright';

const DEVICES = {
    desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    laptop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    'desktop-hd': { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
    tablet: pwDevices['iPad (gen 7)'],
    mobile: pwDevices['iPhone 13'],
    android: pwDevices['Pixel 7'],
};

// Consent banners and chat bubbles that cover the page. Hidden with CSS, so
// nothing is clicked and no consent is given.
const HIDE_CSS = [
    '#onetrust-consent-sdk', '#onetrust-banner-sdk', '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay',
    '.fc-consent-root', '#usercentrics-root', '#didomi-host', '#didomi-popup', '.qc-cmp2-container', '#qc-cmp2-container',
    '#truste-consent-track', '.truste_overlay', '.truste_box_overlay', '#cookie-law-info-bar', '.cky-consent-container', '.cky-overlay',
    '#cmpbox', '#cmpbox2', '.cmpboxBG', '#sp_message_container', '[id^="sp_message_container"]', '.osano-cm-window', '#iubenda-cs-banner',
    '#hs-eu-cookie-confirmation', '.cc-window', '.cc-banner', '#cookie-banner', '#cookieBanner', '#cookie-notice', '#cookies-banner',
    '.cookie-banner', '.cookie-consent', '.cookie-notice', '.cookies-banner', '#gdpr-banner', '.gdpr-banner', '#consent-banner',
    '[aria-label="cookieconsent"]', '[class*="CookieBanner"]', '[class*="cookieBanner"]', '[id*="cookie-consent"]',
    '#intercom-container', '.intercom-lightweight-app', '#hubspot-messages-iframe-container', '#drift-widget-container',
    '#launcher', '.crisp-client', '#tidio-chat', '#zsiq_float', 'iframe[title*="chat" i]',
];

const BLOCK_HOSTS = /(^|\.)(doubleclick\.net|googlesyndication\.com|googletagservices\.com|adservice\.google\.com|amazon-adsystem\.com|adnxs\.com|criteo\.com|taboola\.com|outbrain\.com|moatads\.com|scorecardresearch\.com|hotjar\.com|facebook\.net|ads-twitter\.com|quantserve\.com|rubiconproject\.com|pubmatic\.com|openx\.net)$/i;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    urls = [],
    devices = ['desktop'],
    customWidth = 0,
    customHeight = 0,
    fullPage = true,
    format = 'png',
    quality = 80,
    retina = false,
    darkMode = false,
    waitUntil = 'load',
    delayMs = 1000,
    scrollToBottom = true,
    hideCookieBanners = true,
    blockAds = true,
    hideSelectors = [],
    elementSelector = '',
    pdfFormat = 'A4',
    maxPageHeight = 16000,
    concurrency = 3,
    timeoutSecs = 45,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
const targets = [...new Set(list(urls).map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`)))];
const fmt = ['png', 'jpeg', 'webp', 'pdf'].includes(String(format).toLowerCase()) ? String(format).toLowerCase() : 'png';
const deviceNames = list(devices).map((d) => d.toLowerCase()).filter((d) => DEVICES[d] || d === 'custom');
if (Number(customWidth) > 0 && !deviceNames.includes('custom')) deviceNames.push('custom');
if (!deviceNames.length) deviceNames.push('desktop');

if (!targets.length) {
    await Actor.pushData({ rowType: 'note', note: 'Add at least one URL. Not charged.' });
    await Actor.exit();
}

// Only public http(s) hosts: no file://, no localhost or private ranges.
function allowed(u) {
    let url;
    try { url = new URL(u); } catch { return false; }
    if (!/^https?:$/.test(url.protocol)) return false;
    const h = url.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === '[::1]') return false;
    return true;
}

const kv = await Actor.openKeyValueStore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slugify = (s) => s.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80);

const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--hide-scrollbars'] });

function contextOptions(name) {
    const base = name === 'custom'
        ? { viewport: { width: Number(customWidth) || 1440, height: Number(customHeight) || 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false }
        : { ...DEVICES[name] };
    if (retina && !base.isMobile) base.deviceScaleFactor = 2;
    return { ...base, colorScheme: darkMode ? 'dark' : 'light', locale: 'en-US', ignoreHTTPSErrors: true };
}

const contexts = {};
for (const name of deviceNames) {
    const ctx = await browser.newContext(contextOptions(name));
    if (blockAds) {
        await ctx.route('**/*', (route) => {
            let host = '';
            try { host = new URL(route.request().url()).hostname; } catch {}
            // Video and audio never show in a still image; skipping them saves most of the bandwidth.
            return BLOCK_HOSTS.test(host) || route.request().resourceType() === 'media' ? route.abort() : route.continue();
        });
    }
    contexts[name] = ctx;
}

const hideCss = [...(hideCookieBanners ? HIDE_CSS : []), ...list(hideSelectors)];

async function capture(url, device) {
    const ctx = contexts[device];
    const page = await ctx.newPage();
    const started = Date.now();
    try {
        const resp = await page.goto(url, { waitUntil: ['load', 'domcontentloaded', 'networkidle'].includes(waitUntil) ? waitUntil : 'load', timeout: Number(timeoutSecs) * 1000 });
        if (hideCss.length) await page.addStyleTag({ content: `${hideCss.join(',')}{display:none!important;visibility:hidden!important}html,body{overflow:auto!important}` }).catch(() => {});
        if (scrollToBottom && fullPage) {
            await page.evaluate(async (max) => {
                const step = window.innerHeight;
                for (let y = 0; y < Math.min(document.body.scrollHeight, max); y += step) {
                    window.scrollTo(0, y);
                    await new Promise((r) => setTimeout(r, 100));
                }
                window.scrollTo(0, 0);
            }, Number(maxPageHeight) || 16000).catch(() => {});
            await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
        }
        if (Number(delayMs) > 0) await sleep(Math.min(30000, Number(delayMs)));

        let buf;
        let size = null;
        if (fmt === 'pdf') {
            await page.emulateMedia({ media: 'screen' });
            buf = await page.pdf({ format: pdfFormat || 'A4', printBackground: true });
        } else {
            // Phones render at 3x; without Retina the image is kept at CSS pixels,
            // which is 9x fewer pixels to encode and what most people expect.
            const opts = { type: fmt === 'webp' ? 'png' : fmt, animations: 'disabled', caret: 'hide', scale: retina ? 'device' : 'css', timeout: 90_000 };
            if (fmt === 'jpeg') opts.quality = Math.max(1, Math.min(100, Number(quality) || 80));
            if (elementSelector) {
                const el = await page.$(elementSelector);
                if (!el) throw new Error(`Element not found: ${elementSelector}`);
                buf = await el.screenshot(opts);
            } else {
                if (fullPage) {
                    const h = await page.evaluate(() => Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight));
                    const vp = page.viewportSize();
                    // A clip below the fold only works together with fullPage.
                    opts.fullPage = true;
                    if (h > (Number(maxPageHeight) || 16000)) opts.clip = { x: 0, y: 0, width: vp.width, height: Number(maxPageHeight) || 16000 };
                }
                buf = await page.screenshot(opts);
            }
            if (fmt === 'webp') {
                // Chrome encodes WebP natively through CDP; Playwright's screenshot does not.
                const cdp = await ctx.newCDPSession(page);
                const vp = page.viewportSize();
                const dims = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight) }));
                const height = fullPage ? Math.min(dims.h, Number(maxPageHeight) || 16000) : vp.height;
                const r = await cdp.send('Page.captureScreenshot', { format: 'webp', quality: Math.max(1, Math.min(100, Number(quality) || 80)), captureBeyondViewport: fullPage, clip: { x: 0, y: 0, width: vp.width, height, scale: 1 } });
                buf = Buffer.from(r.data, 'base64');
                await cdp.detach().catch(() => {});
            }
            size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight) })).catch(() => null);
        }
        const ext = fmt === 'jpeg' ? 'jpg' : fmt;
        const key = `${slugify(url)}-${device}-${Date.now().toString(36)}.${ext}`;
        const contentType = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' }[ext];
        await kv.setValue(key, buf, { contentType });
        return {
            url,
            finalUrl: page.url(),
            statusCode: resp?.status() ?? null,
            title: await page.title().catch(() => null),
            device,
            viewport: page.viewportSize(),
            pageSize: size,
            fullPage: !!fullPage && !elementSelector,
            format: fmt,
            bytes: buf.length,
            screenshotUrl: kv.getPublicUrl(key),
            key,
            loadMs: Date.now() - started,
        };
    } finally {
        await page.close().catch(() => {});
    }
}

let shots = 0;
let failed = 0;
let keepGoing = true;
const failures = [];
const jobs = [];
for (const url of targets) for (const device of deviceNames) jobs.push({ url, device });
log.info(`${targets.length} URL(s) x ${deviceNames.length} device(s) = ${jobs.length} capture(s), ${fmt}${fullPage ? ', full page' : ''}.`);

async function worker() {
    while (keepGoing && jobs.length) {
        const { url, device } = jobs.shift();
        if (!allowed(url)) {
            failed += 1;
            await Actor.pushData({ url, device, error: 'Only public http(s) URLs are allowed. Not charged.', capturedAt: new Date().toISOString() });
            continue;
        }
        let row = null;
        let lastErr;
        for (let attempt = 0; attempt < 2 && !row; attempt++) {
            try { row = await capture(url, device); } catch (err) { lastErr = err; }
        }
        if (row) {
            const errorPage = row.statusCode != null && row.statusCode >= 400;
            await Actor.pushData({ ...row, error: errorPage ? `The site answered HTTP ${row.statusCode}; the image shows its error or block page. Not charged.` : null, capturedAt: new Date().toISOString() });
            if (errorPage) { failed += 1; continue; }
            shots += 1;
            const eventName = fmt === 'pdf' || (fullPage && !elementSelector) ? 'full_page_screenshot' : 'screenshot';
            try {
                const r = await Actor.charge({ eventName });
                if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); keepGoing = false; }
            } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
        } else {
            failed += 1;
            const msg = String(lastErr?.message || lastErr).split('\n')[0];
            log.warning(`${url} [${device}]: ${msg}`);
            failures.push({ url, device, error: msg });
            await Actor.pushData({ url, device, error: `${msg} Not charged.`, capturedAt: new Date().toISOString() });
        }
    }
}

await Promise.all(Array.from({ length: Math.max(1, Math.min(10, Number(concurrency) || 4)) }, worker));
await browser.close().catch(() => {});

await Actor.setValue('SUMMARY', { screenshots: shots, failed, failures });
log.info(`Done. ${shots} screenshot(s)${failed ? `, ${failed} failed (free)` : ''}.`);
await Actor.exit();
