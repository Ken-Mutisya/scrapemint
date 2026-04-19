// Recon script. Launches Playwright with the same cookies as the actor,
// navigates to logged in Upwork pages, and logs every API/XHR request so
// we can see which endpoint serves the job feed and what payload shape it
// expects. Output goes to recon/captured.jsonl (one request per line).
//
// Usage: node recon/capture-api.mjs
// Input: storage/key_value_stores/default/INPUT.json (same file the actor uses)

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outPath = resolve(here, 'captured.jsonl');
const inputPath = resolve(root, 'storage/key_value_stores/default/INPUT.json');

if (!existsSync(inputPath)) {
    console.error(`INPUT.json missing at ${inputPath}`);
    process.exit(1);
}

const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const rawCookies = input.sessionCookies;
if (!rawCookies) {
    console.error('sessionCookies missing in INPUT.json');
    process.exit(1);
}

const cookies = (Array.isArray(rawCookies) ? rawCookies : JSON.parse(rawCookies)).map((c) => {
    const out = {
        name: c.name,
        value: c.value,
        domain: c.domain || '.upwork.com',
        path: c.path || '/',
        httpOnly: !!c.httpOnly,
        secure: c.secure !== false,
    };
    if (typeof c.expirationDate === 'number') out.expires = Math.floor(c.expirationDate);
    const ss = (c.sameSite || '').toString().toLowerCase();
    if (ss === 'lax') out.sameSite = 'Lax';
    else if (ss === 'strict') out.sameSite = 'Strict';
    else if (ss === 'none' || ss === 'no_restriction') out.sameSite = 'None';
    return out;
});

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, '');

const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
});

try {
    const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
    });
    await context.addCookies(cookies);

    const page = await context.newPage();

    // Capture every request that looks like API traffic (XHR/fetch, json, graphql).
    page.on('request', async (req) => {
        const url = req.url();
        const rt = req.resourceType();
        if (rt !== 'xhr' && rt !== 'fetch') return;
        if (!/upwork\.com/.test(url)) return;
        const entry = {
            stage: 'request',
            time: Date.now(),
            method: req.method(),
            url,
            headers: req.headers(),
            postData: req.postData() || null,
        };
        appendFileSync(outPath, JSON.stringify(entry) + '\n');
    });

    page.on('response', async (res) => {
        const url = res.url();
        const req = res.request();
        const rt = req.resourceType();
        if (rt !== 'xhr' && rt !== 'fetch') return;
        if (!/upwork\.com/.test(url)) return;
        let body = null;
        try {
            const ct = res.headers()['content-type'] || '';
            if (/json|graphql/.test(ct)) {
                body = (await res.text()).slice(0, 20_000); // cap
            }
        } catch {}
        const entry = {
            stage: 'response',
            time: Date.now(),
            status: res.status(),
            url,
            headers: res.headers(),
            body,
        };
        appendFileSync(outPath, JSON.stringify(entry) + '\n');
    });

    const url = 'https://www.upwork.com/nx/find-work/most-recent';
    console.log(`\n=== Navigating to ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try {
        await page.waitForSelector('[data-test="job-tile-list"]', { timeout: 30_000 });
    } catch {}
    // Scroll to trigger lazy loading of additional tiles.
    for (let i = 0; i < 6; i++) {
        await page.evaluate(() => window.scrollBy(0, 1500));
        await page.waitForTimeout(1500);
    }
    // Click the Next page button if present.
    const nextBtn = await page.$('a[data-test="pagination-next-btn"], button[data-test="pagination-next-btn"], [aria-label="Next page"]');
    if (nextBtn) {
        console.log('Clicking next page...');
        await nextBtn.click().catch(() => {});
        await page.waitForTimeout(5000);
    } else {
        console.log('No next-page button found.');
    }
    await page.waitForTimeout(3000);
    console.log(`Final URL: ${page.url()}`);
    console.log(`Title: ${await page.title()}`);

    console.log(`\nCapture complete. See ${outPath}`);
} finally {
    await browser.close();
}
