import { gotScraping } from 'got-scraping';
import { readFileSync, writeFileSync } from 'node:fs';

const input = JSON.parse(readFileSync('/Users/ken/Scrapemint/actors/upwork-opportunity-alert/storage/key_value_stores/default/INPUT.json', 'utf8'));
const cookies = Array.isArray(input.sessionCookies) ? input.sessionCookies : JSON.parse(input.sessionCookies);
const cookieHeader = cookies
    .filter((c) => /upwork\.com$/.test(c.domain.replace(/^\./, '')))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

const res = await gotScraping({
    url: 'https://www.upwork.com/nx/find-work/best-matches',
    headers: { cookie: cookieHeader },
    followRedirect: false,
    throwHttpErrors: false,
});
writeFileSync('/tmp/best-matches.html', res.body);
console.log('saved', res.body.length, 'bytes');
