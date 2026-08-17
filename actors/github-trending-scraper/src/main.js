// GitHub Trending Scraper & Repo Mover Tracker
//
// Strategy
// --------
// GitHub trending lives at https://github.com/trending and is plain server
// rendered HTML. No auth, no anti bot of consequence. The page exposes one
// <article class="Box-row"> per repo with all the fields we need: owner,
// name, description, primary language, total stars, stars added in the
// active window, fork count, and the avatar row of top contributors.
//
// Discovery
// ---------
//   timeframes        daily, weekly, monthly  (one URL per timeframe)
//   languages         programming language filters (one URL per language)
//   spokenLanguageCode  optional spoken language filter applied to all URLs
//
// Pay-per-event:
//   repo_row ($0.005) charged when a repo row is pushed.
//   First 1 repo per run is free so buyers can validate output.

import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';

const FREE_TIER_REPOS = 1;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    timeframes = ['daily'],
    languages = [],
    spokenLanguageCode = '',
    maxReposPerList = 25,
    includeContributors = true,
    proxyConfiguration: proxyInput,
} = input;

const validTimeframes = ['daily', 'weekly', 'monthly'];
const cleanTimeframes = [...new Set(timeframes)].filter((t) => validTimeframes.includes(t));
if (cleanTimeframes.length === 0) cleanTimeframes.push('daily');

const cleanLanguages = [];
for (const raw of languages) {
    const v = typeof raw === 'string' ? raw : raw?.value || '';
    const slug = String(v).trim().toLowerCase().replace(/\s+/g, '-');
    if (slug && !cleanLanguages.includes(slug)) cleanLanguages.push(slug);
}

const spoken = String(spokenLanguageCode || '').trim().toLowerCase();
const perListCap = Number(maxReposPerList) > 0 ? Math.min(25, Number(maxReposPerList)) : 25;

const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const reposPushed = new Set();
const initialRequests = [];

for (const timeframe of cleanTimeframes) {
    if (cleanLanguages.length === 0) {
        initialRequests.push(buildRequest(timeframe, null, spoken));
    } else {
        for (const lang of cleanLanguages) {
            initialRequests.push(buildRequest(timeframe, lang, spoken));
        }
    }
}

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxConcurrency: 4,
    navigationTimeoutSecs: 30,
    requestHandlerTimeoutSecs: 45,
    maxRequestRetries: 3,
    additionalMimeTypes: ['text/html'],
    preNavigationHooks: [
        async ({ request }) => {
            request.headers = {
                ...(request.headers || {}),
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            };
        },
    ],
    async requestHandler({ $, request }) {
        const { timeframe, language, spokenLanguage } = request.userData;

        const rows = $('article.Box-row, article[class*="Box-row"]').toArray();
        if (rows.length === 0) {
            log.warning(`No rows on ${request.url}.`);
            return;
        }

        let pushedFromThisList = 0;
        for (let i = 0; i < rows.length; i += 1) {
            if (pushedFromThisList >= perListCap) break;
            const el = $(rows[i]);

            const titleAnchor = el.find('h2 a, h2.h3 a, h1 a').first();
            const href = titleAnchor.attr('href') || '';
            const fullName = href.replace(/^\/+/, '').trim();
            if (!fullName || !fullName.includes('/')) continue;
            const [owner, name] = fullName.split('/');

            const repoKey = `${timeframe}:${language || 'all'}:${spokenLanguage || 'all'}:${fullName}`;
            if (reposPushed.has(repoKey)) continue;

            const description = cleanText(el.find('p.col-9, p.col-9.color-fg-muted').first().text());

            const langEl = el.find('[itemprop="programmingLanguage"]').first();
            const langName = cleanText(langEl.text()) || null;
            const langColor = el.find('.repo-language-color').first().attr('style');
            const langColorHex = langColor ? (langColor.match(/#[0-9a-f]{3,8}/i) || [null])[0] : null;

            const starAnchor = el.find(`a[href$="${fullName}/stargazers"]`).first();
            const forkAnchor = el.find(`a[href$="${fullName}/forks"]`).first();
            const starsTotal = parseStarCount(starAnchor.text());
            const forks = parseStarCount(forkAnchor.text());

            const periodText = cleanText(el.find('span.float-sm-right, span.d-inline-block.float-sm-right').first().text());
            const starsInPeriod = parsePeriodStars(periodText);

            const contributors = includeContributors
                ? el.find('span.d-inline-block a.d-inline-block, a.mr-2 img.avatar').toArray().map((c) => {
                    const cEl = $(c);
                    const aEl = cEl.is('a') ? cEl : cEl.parent('a');
                    const username = (aEl.attr('href') || '').replace(/^\/+/, '').split('/')[0] || null;
                    const img = aEl.find('img').first();
                    const avatarUrl = img.attr('src') || null;
                    if (!username) return null;
                    return {
                        username,
                        profileUrl: `https://github.com/${username}`,
                        avatarUrl,
                    };
                }).filter(Boolean)
                : [];

            const dedupedContributors = [];
            const seenContrib = new Set();
            for (const c of contributors) {
                if (seenContrib.has(c.username)) continue;
                seenContrib.add(c.username);
                dedupedContributors.push(c);
            }

            const row = {
                rank: i + 1,
                fullName,
                owner,
                name,
                url: `https://github.com/${fullName}`,
                description: description || null,
                language: langName,
                languageColor: langColorHex,
                starsTotal,
                starsInPeriod,
                forks,
                timeframe,
                languageFilter: language || null,
                spokenLanguageCode: spokenLanguage || null,
                builtBy: dedupedContributors,
                scrapedAt: new Date().toISOString(),
            };

            reposPushed.add(repoKey);
            await Actor.pushData(row);
            if (reposPushed.size > FREE_TIER_REPOS) {
                await Actor.charge({ eventName: 'repo_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
            }
            pushedFromThisList += 1;
        }

        log.info(`Pushed ${pushedFromThisList} repos from ${request.url}.`);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

await crawler.addRequests(initialRequests);
await crawler.run();

log.info(`Run complete. Lists: ${initialRequests.length}. Repos pushed: ${reposPushed.size}.`);
await Actor.exit();

// ---------- URL helpers ----------

function buildRequest(timeframe, language, spokenLanguage) {
    const base = language
        ? `https://github.com/trending/${encodeURIComponent(language)}`
        : 'https://github.com/trending';
    const params = new URLSearchParams({ since: timeframe });
    if (spokenLanguage) params.set('spoken_language_code', spokenLanguage);
    const url = `${base}?${params.toString()}`;
    return {
        url,
        userData: { timeframe, language, spokenLanguage },
        uniqueKey: `list:${timeframe}:${language || 'all'}:${spokenLanguage || 'all'}`,
    };
}

// ---------- Parsing helpers ----------

function cleanText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

function parseStarCount(text) {
    if (!text) return null;
    const m = cleanText(text).replace(/,/g, '').match(/([\d.]+)\s*([kmb])?/i);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    const unit = (m[2] || '').toLowerCase();
    if (unit === 'k') n *= 1000;
    else if (unit === 'm') n *= 1000000;
    else if (unit === 'b') n *= 1000000000;
    return Math.round(n);
}

function parsePeriodStars(text) {
    if (!text) return null;
    const m = cleanText(text).replace(/,/g, '').match(/([\d.]+)\s*([kmb])?\s*stars?/i);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    const unit = (m[2] || '').toLowerCase();
    if (unit === 'k') n *= 1000;
    else if (unit === 'm') n *= 1000000;
    else if (unit === 'b') n *= 1000000000;
    return Math.round(n);
}
