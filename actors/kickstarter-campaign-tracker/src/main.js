// Kickstarter Campaign Intelligence
//
// Strategy
// --------
// Kickstarter ships a JSON variant of the discover/advanced search page at
//   https://www.kickstarter.com/discover/advanced?format=json&state=live&...
// which returns up to 12 projects per page with id, name, blurb, creator,
// category, pledged, goal, backers_count, launched_at, deadline, state,
// country, urls, photo, spotlight, staff_pick, and more. Kickstarter sits
// behind Cloudflare so we use Playwright to pass the JS challenge naturally,
// then read the JSON payload from document.body.innerText.
//
// We seed one discover URL per (state, category, sort, country, term)
// combination and walk pages until either has_more is false, the seed cap
// is reached, or the global maxCampaigns cap is reached. Optional
// enrichments hit the project HTML page, the rewards page, or the creator
// profile to pull pledge tiers, update counts, and creator history.
//
// Pay per event
// -------------
//   campaign_row ($0.005) charged when a campaign row is pushed.
//   First 5 rows per run are free so buyers can validate output.

import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

const KS_BASE = 'https://www.kickstarter.com';
const FREE_TIER = 5;

const CATEGORY_IDS = {
    art: 1,
    comics: 3,
    crafts: 26,
    dance: 6,
    design: 7,
    fashion: 9,
    'film-video': 11,
    food: 10,
    games: 12,
    journalism: 13,
    music: 14,
    photography: 15,
    publishing: 18,
    technology: 16,
    theater: 17,
};

const SORT_MAP = {
    magic: 'magic',
    popularity: 'popularity',
    newest: 'newest',
    end_date: 'end_date',
    most_funded: 'most_funded',
    most_backed: 'most_backed',
};

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    queries = [],
    categories = [],
    projectUrls = [],
    states = ['live'],
    sort = 'magic',
    country = '',
    minPercentFunded = 0,
    minBackers = 0,
    minPledgedUsd = 0,
    launchedAfterDays = 0,
    fetchRewards = false,
    fetchUpdates = false,
    fetchCreator = false,
    maxCampaigns = 100,
    maxPagesPerSeed = 5,
    dedupe = true,
    navigationDelayMs = 2000,
    concurrency = 3,
    proxyConfiguration: proxyInput,
} = input;

const cap = Number(maxCampaigns) > 0 ? Number(maxCampaigns) : Infinity;
const pagesPerSeed = Math.max(1, Math.min(200, Number(maxPagesPerSeed) || 5));
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
const seenStore = dedupe ? await Actor.openKeyValueStore('kickstarter-campaign-tracker-seen') : null;
const seenIds = new Set(seenStore ? (await seenStore.getValue('seen-projects')) || [] : []);
let pushedRows = 0;

const queryList = (Array.isArray(queries) ? queries : []).map((q) => String(q).trim()).filter(Boolean);
const categoryList = (Array.isArray(categories) ? categories : []).map((c) => String(c).trim().toLowerCase()).filter((c) => CATEGORY_IDS[c]);
const stateList = (Array.isArray(states) && states.length > 0 ? states : ['live']).map((s) => String(s).trim().toLowerCase());
const projectUrlList = (Array.isArray(projectUrls) ? projectUrls : []).map((u) => String(u).trim()).filter((u) => /^https?:\/\/(www\.)?kickstarter\.com\/projects\//i.test(u));
const sortKey = SORT_MAP[String(sort).toLowerCase()] || 'magic';
const countryCode = String(country || '').trim().toUpperCase();

const launchedAfterTs = Number(launchedAfterDays) > 0
    ? Math.floor((Date.now() - Number(launchedAfterDays) * 86400_000) / 1000)
    : 0;

if (queryList.length === 0 && categoryList.length === 0 && projectUrlList.length === 0) {
    log.warning('No input. Falling back to top live campaigns across all categories.');
}

function buildDiscoverUrl({ state, categorySlug, term, page }) {
    const params = new URLSearchParams();
    params.set('format', 'json');
    params.set('page', String(page));
    params.set('sort', sortKey);
    params.set('state', state);
    if (categorySlug) params.set('category_id', String(CATEGORY_IDS[categorySlug]));
    if (term) params.set('term', term);
    if (countryCode) params.set('country', countryCode);
    return `${KS_BASE}/discover/advanced?${params.toString()}`;
}

const seeds = [];

if (queryList.length === 0 && categoryList.length === 0 && projectUrlList.length === 0) {
    for (const state of stateList) {
        seeds.push({
            url: buildDiscoverUrl({ state, categorySlug: null, term: '', page: 1 }),
            userData: { label: 'discover', state, categorySlug: null, term: '', page: 1 },
            uniqueKey: `discover:${state}:all::1`,
        });
    }
}

for (const state of stateList) {
    for (const term of queryList) {
        seeds.push({
            url: buildDiscoverUrl({ state, categorySlug: null, term, page: 1 }),
            userData: { label: 'discover', state, categorySlug: null, term, page: 1 },
            uniqueKey: `discover:${state}:all:${term}:1`,
        });
    }
    for (const slug of categoryList) {
        seeds.push({
            url: buildDiscoverUrl({ state, categorySlug: slug, term: '', page: 1 }),
            userData: { label: 'discover', state, categorySlug: slug, term: '', page: 1 },
            uniqueKey: `discover:${state}:${slug}::1`,
        });
        for (const term of queryList) {
            seeds.push({
                url: buildDiscoverUrl({ state, categorySlug: slug, term, page: 1 }),
                userData: { label: 'discover', state, categorySlug: slug, term, page: 1 },
                uniqueKey: `discover:${state}:${slug}:${term}:1`,
            });
        }
    }
}

for (const url of projectUrlList) {
    const projectKey = projectKeyFromUrl(url);
    if (!projectKey) continue;
    seeds.push({
        url: stripQuery(url),
        userData: { label: 'detail-only', projectKey, baseRow: { sourceUrl: url } },
        uniqueKey: `detail:${projectKey}`,
    });
}

log.info(`Seeds: ${seeds.length} (states=${stateList.join(',')}, queries=${queryList.length}, categories=${categoryList.length}, projectUrls=${projectUrlList.length}, sort=${sortKey}).`);

const wantsDetail = fetchRewards || fetchUpdates || fetchCreator;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxConcurrency: Math.max(1, Math.min(16, Number(concurrency) || 3)),
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    maxRequestRetries: 3,
    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled'],
        },
    },
    async requestHandler(ctx) {
        const { request, page } = ctx;
        const { label } = request.userData;
        if (navigationDelayMs > 0) await page.waitForTimeout(navigationDelayMs);

        if (label === 'discover') return handleDiscover(ctx);
        if (label === 'detail') return handleDetail(ctx);
        if (label === 'detail-only') return handleDetailOnly(ctx);
        if (label === 'rewards') return handleRewards(ctx);
        if (label === 'creator') return handleCreator(ctx);
        log.warning(`Unknown label: ${label}`);
    },
    failedRequestHandler({ request, error }) {
        log.warning(`Failed: ${request.url} -> ${error?.message}`);
    },
});

async function handleDiscover({ request, page, log: ll }) {
    if (pushedRows >= cap) return;
    const { state, categorySlug, term, page: pageIdx } = request.userData;

    await page.waitForSelector('pre, body', { timeout: 25000 }).catch(() => {});
    const text = await page.evaluate(() => document.body?.innerText || '');
    let payload;
    try { payload = JSON.parse(text); } catch (e) {
        ll.warning(`Could not parse discover JSON for ${request.url} (got ${text.slice(0, 120)}...): ${e.message}`);
        return;
    }
    const projects = Array.isArray(payload?.projects) ? payload.projects : [];
    const hasMore = !!payload?.has_more;
    ll.info(`[discover] state=${state} cat=${categorySlug || 'all'} term="${term || ''}" page=${pageIdx}: ${projects.length} projects, hasMore=${hasMore}.`);

    let pushedThisPage = 0;
    for (const project of projects) {
        if (pushedRows >= cap) break;
        if (!project || !project.id) continue;
        const projectId = String(project.id);
        if (dedupe && seenIds.has(projectId)) continue;

        const row = mapDiscoverProject(project, { state, categorySlug, term });
        if (!passesFilters(row)) continue;

        if (wantsDetail) {
            const detailUrl = stripQuery(row.url);
            await crawler.addRequests([{
                url: detailUrl,
                userData: { label: 'detail', projectKey: row.projectKey, baseRow: row },
                uniqueKey: `detail:${row.projectKey}`,
            }]);
        } else {
            await pushRow(row);
        }
        pushedThisPage += 1;
    }

    if (pushedThisPage === 0 || !hasMore) return;
    if (pageIdx >= pagesPerSeed) return;
    if (pushedRows >= cap) return;

    await crawler.addRequests([{
        url: buildDiscoverUrl({ state, categorySlug, term, page: pageIdx + 1 }),
        userData: { label: 'discover', state, categorySlug, term, page: pageIdx + 1 },
        uniqueKey: `discover:${state}:${categorySlug || 'all'}:${term || ''}:${pageIdx + 1}`,
    }]);
}

async function handleDetail({ request, page, log: ll }) {
    const { baseRow, projectKey } = request.userData;
    const enrichment = await extractDetailFromPage(page);
    const row = { ...baseRow, ...enrichment };

    if (fetchRewards) {
        await crawler.addRequests([{
            url: `${KS_BASE}${row.projectPath}/rewards`,
            userData: { label: 'rewards', projectKey, baseRow: row },
            uniqueKey: `rewards:${projectKey}`,
        }]);
        return;
    }
    if (fetchCreator && row.creatorSlug) {
        await crawler.addRequests([{
            url: `${KS_BASE}/profile/${row.creatorSlug}`,
            userData: { label: 'creator', projectKey, baseRow: row },
            uniqueKey: `creator:${projectKey}`,
        }]);
        return;
    }
    await pushRow(row);
    ll.info(`[detail] ${projectKey}: ${row.updateCount ?? '?'} updates, ${row.commentCount ?? '?'} comments.`);
}

async function handleDetailOnly({ request, page, log: ll }) {
    const { baseRow = {}, projectKey } = request.userData;
    const enrichment = await extractDetailFromPage(page);
    const merged = { ...baseRow, ...enrichment, projectKey };

    if (fetchRewards) {
        await crawler.addRequests([{
            url: `${request.loadedUrl || request.url}/rewards`,
            userData: { label: 'rewards', projectKey, baseRow: merged },
            uniqueKey: `rewards:${projectKey}`,
        }]);
        return;
    }
    if (fetchCreator && merged.creatorSlug) {
        await crawler.addRequests([{
            url: `${KS_BASE}/profile/${merged.creatorSlug}`,
            userData: { label: 'creator', projectKey, baseRow: merged },
            uniqueKey: `creator:${projectKey}`,
        }]);
        return;
    }
    await pushRow(merged);
    ll.info(`[detail-only] ${projectKey}.`);
}

async function handleRewards({ request, page, log: ll }) {
    const { baseRow, projectKey } = request.userData;
    const rewards = await extractRewardsFromPage(page);
    const merged = { ...baseRow, rewards };
    if (fetchCreator && merged.creatorSlug) {
        await crawler.addRequests([{
            url: `${KS_BASE}/profile/${merged.creatorSlug}`,
            userData: { label: 'creator', projectKey, baseRow: merged },
            uniqueKey: `creator:${projectKey}`,
        }]);
        return;
    }
    await pushRow(merged);
    ll.info(`[rewards] ${projectKey}: ${rewards.length} tiers.`);
}

async function handleCreator({ request, page, log: ll }) {
    const { baseRow, projectKey } = request.userData;
    const creator = await extractCreatorFromPage(page);
    await pushRow({ ...baseRow, ...creator });
    ll.info(`[creator] ${projectKey}: launched ${creator.creatorLaunchedCount ?? '?'}, backed ${creator.creatorBackedCount ?? '?'}.`);
}

// ---------- mapping ----------

function mapDiscoverProject(p, { state, categorySlug, term }) {
    const launchedAt = p.launched_at ? new Date(p.launched_at * 1000).toISOString() : null;
    const deadline = p.deadline ? new Date(p.deadline * 1000).toISOString() : null;
    const createdAt = p.created_at ? new Date(p.created_at * 1000).toISOString() : null;
    const stateChangedAt = p.state_changed_at ? new Date(p.state_changed_at * 1000).toISOString() : null;

    const pledged = Number(p.pledged) || 0;
    const goal = Number(p.goal) || 0;
    const usdRate = Number(p.static_usd_rate) || 1;
    const usdPledged = Number(p.usd_pledged ?? pledged * usdRate) || 0;
    const percentFunded = goal > 0 ? Math.round((pledged / goal) * 1000) / 10 : 0;

    const daysLeft = p.deadline
        ? Math.max(0, Math.round((p.deadline * 1000 - Date.now()) / 86400_000))
        : null;

    const webProject = p.urls?.web?.project || `${KS_BASE}/projects/${p.creator?.slug || ''}/${p.slug || ''}`;
    const projectPath = webProject.replace(KS_BASE, '').replace(/\?.*$/, '');

    return {
        projectId: String(p.id),
        projectKey: `${p.creator?.slug || 'unknown'}/${p.slug || String(p.id)}`,
        name: p.name || null,
        slug: p.slug || null,
        blurb: p.blurb || null,
        url: webProject,
        projectPath,
        state: p.state || state,
        country: p.country || null,
        countryName: p.country_displayable_name || null,
        currency: p.currency || null,
        currencySymbol: p.currency_symbol || null,
        pledged,
        goal,
        usdPledged: Math.round(usdPledged * 100) / 100,
        percentFunded,
        backers: Number(p.backers_count) || 0,
        spotlight: !!p.spotlight,
        staffPick: !!p.staff_pick,
        launchedAt,
        deadline,
        daysLeft,
        createdAt,
        stateChangedAt,
        category: p.category?.name || null,
        categorySlug: p.category?.slug || categorySlug || null,
        parentCategory: p.category?.parent_name || null,
        creatorId: p.creator?.id ?? null,
        creatorName: p.creator?.name || null,
        creatorSlug: p.creator?.slug || null,
        creatorUrl: p.creator?.urls?.web?.user || null,
        photo: p.photo?.full || p.photo?.ed || p.photo?.med || null,
        location: p.location?.displayable_name || null,
        sourceState: state,
        sourceCategorySlug: categorySlug || null,
        sourceTerm: term || null,
        scrapedAt: new Date().toISOString(),
    };
}

function passesFilters(row) {
    if (minPercentFunded > 0 && row.percentFunded < minPercentFunded) return false;
    if (minBackers > 0 && row.backers < minBackers) return false;
    if (minPledgedUsd > 0 && row.usdPledged < minPledgedUsd) return false;
    if (launchedAfterTs > 0 && row.launchedAt) {
        const launchedTs = Math.floor(new Date(row.launchedAt).getTime() / 1000);
        if (launchedTs < launchedAfterTs) return false;
    }
    return true;
}

async function pushRow(row) {
    if (pushedRows >= cap) return;
    if (dedupe && row.projectId && seenIds.has(row.projectId)) return;
    await Actor.pushData(row);
    pushedRows += 1;
    if (row.projectId) seenIds.add(row.projectId);
    if (pushedRows > FREE_TIER) {
        await Actor.charge({ eventName: 'campaign_row' }).catch((err) => log.warning(`charge failed: ${err?.message}`));
    }
}

// ---------- page extraction ----------

async function extractDetailFromPage(page) {
    await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
    return await page.evaluate(() => {
        const out = {};
        const txt = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
        const attr = (sel, a) => document.querySelector(sel)?.getAttribute(a) || null;
        const parseCount = (s) => {
            if (!s) return null;
            const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([kmb])?/i);
            if (!m) return null;
            let n = parseFloat(m[1]);
            if (!Number.isFinite(n)) return null;
            const u = (m[2] || '').toLowerCase();
            if (u === 'k') n *= 1000;
            else if (u === 'm') n *= 1000000;
            else if (u === 'b') n *= 1000000000;
            return Math.round(n);
        };

        out.updateCount = parseCount(txt('a[data-content="updates"], a[href*="/updates"] .count, a[href*="/updates"] [data-counter]'));
        out.commentCount = parseCount(txt('a[data-content="comments"], a[href*="/comments"] .count, a[href*="/comments"] [data-counter]'));
        out.faqCount = parseCount(txt('a[data-content="faqs"], a[href*="/faqs"] .count, a[href*="/faqs"] [data-counter]'));

        const ldNodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        for (const node of ldNodes) {
            try {
                const d = JSON.parse(node.textContent || '');
                if (d['@type'] === 'Product' || d['@type'] === 'CrowdFundingProject') {
                    out.descriptionLd = d.description || null;
                    out.ldImage = typeof d.image === 'string' ? d.image : null;
                }
            } catch {}
        }

        const initialEl = document.querySelector('[data-initial]');
        if (initialEl) {
            try {
                const init = JSON.parse(initialEl.getAttribute('data-initial'));
                const p = init?.project || init;
                if (p) {
                    out.video = p.video?.high || p.video?.base || null;
                    out.fxRate = p.fx_rate ?? null;
                    out.creatorLaunchedCount = p.creator?.launched_projects_count ?? null;
                    out.creatorBackedCount = p.creator?.backed_projects_count ?? null;
                }
            } catch {}
        }
        return out;
    }).catch(() => ({}));
}

async function extractRewardsFromPage(page) {
    await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
    return await page.evaluate(() => {
        const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const parseCount = (s) => {
            if (!s) return null;
            const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([kmb])?/i);
            if (!m) return null;
            let n = parseFloat(m[1]);
            if (!Number.isFinite(n)) return null;
            const u = (m[2] || '').toLowerCase();
            if (u === 'k') n *= 1000;
            else if (u === 'm') n *= 1000000;
            else if (u === 'b') n *= 1000000000;
            return Math.round(n);
        };
        const parseMoney = (s) => {
            if (!s) return null;
            const m = String(s).replace(/,/g, '').match(/([\d.]+)/);
            if (!m) return null;
            const n = parseFloat(m[1]);
            return Number.isFinite(n) ? n : null;
        };

        const out = [];
        const nodes = document.querySelectorAll('.pledge, .NS_projects__rewards_list .reward, [data-reward-id], .reward__container');
        nodes.forEach((el) => {
            const id = el.getAttribute('data-reward-id') || el.id || null;
            const title = clean(el.querySelector('.pledge__title, .reward__title, h3')?.textContent || '');
            const amountText = clean(el.querySelector('.pledge__amount, .reward__amount, .money')?.textContent || '');
            const description = clean(el.querySelector('.pledge__description, .reward__description, .full-description')?.textContent || '');
            const backersText = clean(el.querySelector('.pledge__backer-count, .reward__backer-count')?.textContent || '');
            const limitText = clean(el.querySelector('.pledge__limit, .reward__limit')?.textContent || '');
            const deliveryText = clean(el.querySelector('.pledge__detail--delivery-date time, .reward__detail--delivery time, [data-test-id="reward-delivery"]')?.textContent || '');
            const shippingText = clean(el.querySelector('.pledge__detail--shipping-summary, .reward__detail--shipping-summary')?.textContent || '');
            if (!title && !amountText) return;
            out.push({
                id,
                title: title || null,
                priceText: amountText || null,
                priceUsd: parseMoney(amountText),
                description: description || null,
                backers: parseCount(backersText),
                limitText: limitText || null,
                estimatedDelivery: deliveryText || null,
                shipping: shippingText || null,
            });
        });
        return out;
    }).catch(() => []);
}

async function extractCreatorFromPage(page) {
    await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
    return await page.evaluate(() => {
        const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const parseCount = (s) => {
            if (!s) return null;
            const m = String(s).replace(/,/g, '').match(/([\d.]+)\s*([kmb])?/i);
            if (!m) return null;
            let n = parseFloat(m[1]);
            if (!Number.isFinite(n)) return null;
            const u = (m[2] || '').toLowerCase();
            if (u === 'k') n *= 1000;
            else if (u === 'm') n *= 1000000;
            else if (u === 'b') n *= 1000000000;
            return Math.round(n);
        };
        const launched = parseCount(clean(document.querySelector('a[href*="/created"], a[data-tab="created"]')?.textContent || ''));
        const backed = parseCount(clean(document.querySelector('a[href*="/backed"], a[data-tab="backed"]')?.textContent || ''));
        const joinedText = document.querySelector('time[data-format="long"], .joined time, [itemprop="dateCreated"]')?.getAttribute('datetime') || null;
        return {
            creatorLaunchedCount: launched,
            creatorBackedCount: backed,
            creatorJoinedAt: joinedText || null,
        };
    }).catch(() => ({}));
}

// ---------- helpers ----------

function projectKeyFromUrl(url) {
    const m = String(url).match(/\/projects\/([^\/]+)\/([^\/?#]+)/i);
    if (!m) return null;
    return `${m[1]}/${m[2]}`;
}

function stripQuery(url) {
    return String(url).split('?')[0];
}

await crawler.addRequests(seeds);
await crawler.run();

if (seenStore) {
    await seenStore.setValue('seen-projects', [...seenIds]);
}

log.info(`Run complete. Seeds: ${seeds.length}. Rows pushed: ${pushedRows}.`);
await Actor.exit();
