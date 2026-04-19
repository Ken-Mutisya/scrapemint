import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync('/Users/ken/Scrapemint/actors/upwork-opportunity-alert/storage/key_value_stores/default/INPUT.json', 'utf8'));
const cookies = Array.isArray(input.sessionCookies) ? input.sessionCookies : JSON.parse(input.sessionCookies);
const cookieHeader = cookies.filter((c) => /upwork\.com$/.test(c.domain.replace(/^\./, ''))).map((c) => `${c.name}=${c.value}`).join('; ');

async function fetchIds(url) {
    const res = await gotScraping({ url, headers: { cookie: cookieHeader }, followRedirect: false, throwHttpErrors: false });
    const $ = cheerio.load(res.body);
    const ids = [];
    $('div[data-test="job-tile-list"] > section').each((_, el) => {
        const id = $(el).attr('data-ev-opening_uid');
        if (id) ids.push(id);
    });
    return { status: res.statusCode, bytes: res.body.length, ids };
}

for (const url of [
    'https://www.upwork.com/nx/find-work/most-recent',
    'https://www.upwork.com/nx/find-work/most-recent?page=2',
    'https://www.upwork.com/nx/find-work/most-recent?page=3',
    'https://www.upwork.com/nx/find-work/most-recent?paging=10%3B20',
    'https://www.upwork.com/nx/find-work/most-recent?per_page=50',
]) {
    const { status, bytes, ids } = await fetchIds(url);
    console.log(`${url}\n  status ${status} bytes ${bytes} ids ${ids.length}: ${ids.slice(0,3).join(',')}...`);
}
