// Verify that the Nuxt SSR payload on /nx/find-work/* routes embeds the
// full job list (not just the ~2 SSR'd tiles). If true, we can ditch
// cheerio tile parsing entirely and read structured data.

import { gotScraping } from 'got-scraping';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync('/Users/ken/Scrapemint/actors/upwork-opportunity-alert/storage/key_value_stores/default/INPUT.json', 'utf8'));
const cookies = Array.isArray(input.sessionCookies) ? input.sessionCookies : JSON.parse(input.sessionCookies);
const cookieHeader = cookies
    .filter((c) => /upwork\.com$/.test(c.domain.replace(/^\./, '')))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

function extractNuxt(html) {
    const m = html.match(/window\.__NUXT__\s*=\s*/);
    if (!m) return null;
    const start = m.index + m[0].length;
    const end = html.indexOf('</script>', start);
    const payload = html.slice(start, end);
    const ctx = { window: {} };
    vm.createContext(ctx);
    vm.runInContext(`window.__NUXT__ = ${payload}`, ctx);
    return ctx.window.__NUXT__;
}

for (const path of [
    '/nx/find-work/best-matches',
    '/nx/find-work/most-recent',
    '/nx/find-work/most-recent?page=2',
    '/nx/find-work/domestic',
]) {
    const url = `https://www.upwork.com${path}`;
    const res = await gotScraping({
        url,
        headers: { cookie: cookieHeader },
        followRedirect: false,
        throwHttpErrors: false,
    });
    if (res.statusCode !== 200) {
        console.log(`${path}\n  status ${res.statusCode}`);
        continue;
    }
    const nuxt = extractNuxt(res.body);
    const state = nuxt?.state || {};
    const summary = {};
    for (const k of ['feedBestMatch', 'feedMostRecent', 'feedDomestic', 'feedMy']) {
        const jobs = state[k]?.jobs;
        const paging = state[k]?.paging;
        if (Array.isArray(jobs)) summary[k] = { jobs: jobs.length, paging };
    }
    console.log(`${path}\n  status ${res.statusCode} bytes ${res.body.length}`);
    console.log('  feeds:', JSON.stringify(summary, null, 2).split('\n').map(l => '  ' + l).join('\n'));
}
