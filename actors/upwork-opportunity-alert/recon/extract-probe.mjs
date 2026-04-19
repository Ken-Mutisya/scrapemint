// Fetch most-recent HTML via got-scraping and extract job tiles with cheerio.

import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync('/Users/ken/Scrapemint/actors/upwork-opportunity-alert/storage/key_value_stores/default/INPUT.json', 'utf8'));
const cookies = Array.isArray(input.sessionCookies) ? input.sessionCookies : JSON.parse(input.sessionCookies);
const cookieHeader = cookies.filter((c) => /upwork\.com$/.test(c.domain.replace(/^\./, ''))).map((c) => `${c.name}=${c.value}`).join('; ');

const res = await gotScraping({
    url: 'https://www.upwork.com/nx/find-work/most-recent',
    headers: { cookie: cookieHeader },
    followRedirect: false,
    throwHttpErrors: false,
});
console.log('status', res.statusCode, 'bytes', res.body.length);

const $ = cheerio.load(res.body);

// Find tile containers. From earlier grep: [data-test="job-tile-list"] is the list,
// tiles likely have [data-ev-label="job_post_title"] or similar.
const tileSelectors = [
    'article[data-test="JobTile"]',
    'section[data-test="JobTile"]',
    'div[data-test="job-tile-list"] > *',
    '[data-test="feed-best-match"] > *',
    '.job-tile',
];
for (const sel of tileSelectors) {
    const count = $(sel).length;
    if (count > 0) console.log(`selector "${sel}" matched ${count}`);
}

// Dump first tile's full HTML to see what we can extract.
const first = $('div[data-test="job-tile-list"] > *').first();
console.log('\n--- First tile HTML ---');
console.log($.html(first));

// Dump all data-test values inside that tile.
const attrs = new Set();
first.find('[data-test]').each((_, el) => attrs.add($(el).attr('data-test')));
console.log('\n--- data-test values in first tile ---');
for (const a of [...attrs].sort()) console.log(' ', a);
