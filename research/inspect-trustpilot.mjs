// Inspect Trustpilot review page structure.
// Goal: find the cleanest extraction path (embedded JSON vs DOM vs API).
//
// Usage: node research/inspect-trustpilot.mjs [trustpilot-url]

import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const url = process.argv[2] || 'https://www.trustpilot.com/review/booking.com';
const OUT_JSON = resolve(import.meta.dirname, 'trustpilot-sample.json');
const OUT_HTML = resolve(import.meta.dirname, 'trustpilot-sample.html');

console.log(`Inspecting: ${url}`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
});
const page = await context.newPage();

// Capture network: look for review-loading XHR/GraphQL
const apiCalls = [];
page.on('request', (req) => {
    const u = req.url();
    if (u.includes('trustpilot.com') && (u.includes('/api/') || u.includes('graphql') || u.includes('reviews'))) {
        apiCalls.push({ url: u, method: req.method() });
    }
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(5000);

// Scroll to trigger lazy-load if any
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(3000);

const findings = {
    url,
    title: await page.title(),
    hasNextData: false,
    nextDataShape: null,
    hasTrustbox: false,
    reviewCountDom: null,
    firstReviewText: null,
    apiCalls: [...new Set(apiCalls.map(c => `${c.method} ${c.url.split('?')[0]}`))],
};

// Check for Next.js __NEXT_DATA__ (Trustpilot uses this)
const nextDataRaw = await page.evaluate(() => {
    const el = document.getElementById('__NEXT_DATA__');
    return el ? el.textContent : null;
});

if (nextDataRaw) {
    findings.hasNextData = true;
    try {
        const nextData = JSON.parse(nextDataRaw);
        // Walk the structure to find reviews
        const reviewPaths = [];
        function walk(node, path) {
            if (!node || typeof node !== 'object' || path.length > 10) return;
            if (Array.isArray(node)) {
                // Look for arrays that look like review lists (have objects with rating/text/consumer fields)
                if (node.length > 0 && typeof node[0] === 'object' && node[0] !== null) {
                    const keys = Object.keys(node[0]);
                    if (keys.some(k => /rating|stars|score/i.test(k)) && keys.some(k => /text|content|body|title/i.test(k))) {
                        reviewPaths.push({ path: path.join('.'), count: node.length, sampleKeys: keys, firstItem: node[0] });
                    }
                }
                for (let i = 0; i < Math.min(node.length, 5); i++) walk(node[i], [...path, `[${i}]`]);
            } else {
                for (const key of Object.keys(node)) walk(node[key], [...path, key]);
            }
        }
        walk(nextData, []);
        findings.nextDataShape = {
            topKeys: Object.keys(nextData),
            props: nextData.props ? Object.keys(nextData.props) : [],
            pageProps: nextData.props?.pageProps ? Object.keys(nextData.props.pageProps) : [],
            reviewArraysFound: reviewPaths,
        };
        writeFileSync(OUT_JSON, JSON.stringify(nextData, null, 2));
        console.log(`Wrote __NEXT_DATA__ to ${OUT_JSON}`);
    } catch (err) {
        findings.nextDataShape = { parseError: err.message };
    }
}

// DOM probes
findings.reviewCountDom = await page.$$eval('article[data-service-review-card-paper], article[class*="reviewCard"], [data-service-review]', (els) => els.length).catch(() => 0);
findings.firstReviewText = await page.$eval('article h2, article [data-service-review-title-typography]', (el) => el.textContent?.trim()?.slice(0, 120)).catch(() => null);

// Pagination
findings.paginationLinks = await page.$$eval('a[name="pagination-button-next"], [data-pagination-button-next-link]', (els) => els.map(a => a.href)).catch(() => []);

console.log('\n=== FINDINGS ===');
console.log(JSON.stringify(findings, null, 2));

const html = await page.content();
writeFileSync(OUT_HTML, html);
console.log(`\nWrote HTML to ${OUT_HTML} (${html.length} chars)`);

await browser.close();
