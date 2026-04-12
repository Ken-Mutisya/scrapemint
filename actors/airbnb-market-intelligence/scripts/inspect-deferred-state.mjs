// One-shot exploration: dump the deferred-state JSON blob from a real Airbnb
// search page so we can map findStaysResults to the actual shape.
// Not part of the test suite. Run manually, inspect output, delete after.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const url = 'https://www.airbnb.com/s/Joshua-Tree%2C-CA/homes?adults=2&currency=USD';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#data-deferred-state-0, [data-testid="card-container"]', {
    timeout: 20_000,
}).catch(() => {});

const raw = await page.$eval('#data-deferred-state-0', (el) => el.textContent).catch(() => null);
if (!raw) {
    console.log('NO DEFERRED STATE BLOB FOUND');
    await browser.close();
    process.exit(0);
}

writeFileSync('/tmp/airbnb-deferred.json', raw);

const json = JSON.parse(raw);

// Walk and report every array-of-objects whose objects look listing-ish.
const hits = [];
function walk(node, path, depth) {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) {
        if (node.length > 0 && node[0] && typeof node[0] === 'object') {
            const keys = Object.keys(node[0]);
            const looksLikeResult = keys.some((k) => /listing|pricing|stay/i.test(k));
            if (looksLikeResult) {
                hits.push({ path, length: node.length, sampleKeys: keys.slice(0, 20) });
            }
        }
        node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
        return;
    }
    if (typeof node === 'object') {
        for (const k of Object.keys(node)) {
            walk(node[k], path ? `${path}.${k}` : k, depth + 1);
        }
    }
}
walk(json, '', 0);

console.log(`Top level keys: ${Object.keys(json).slice(0, 10).join(', ')}`);
console.log(`\nListing-shaped arrays found: ${hits.length}`);
for (const hit of hits.slice(0, 5)) {
    console.log(`\npath: ${hit.path}`);
    console.log(`  length: ${hit.length}`);
    console.log(`  sample keys: ${hit.sampleKeys.join(', ')}`);
}

console.log(`\nFull JSON written to /tmp/airbnb-deferred.json (${(raw.length / 1024).toFixed(0)} KB)`);
await browser.close();
