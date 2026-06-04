// Emerging Launch Radar Pipeline
//
// Surfaces software products gaining real traction RIGHT NOW by joining two
// independent, antibot-free public signals and (optionally) a third:
//
// Stage 1: scrapemint/github-trending-scraper  -> repos with stars-in-period
//          velocity (the build-side signal). Pure GitHub trending HTML.
// Stage 2: scrapemint/hn-lead-monitor          -> Hacker News Show/front-page
//          stories with points + comments (the attention-side signal). Pure
//          HN Firebase/Algolia, no token.
// Stage 3: (optional, opt-in) scrapemint/producthunt-launch-tracker for a
//          third corroborating signal. OFF by default: it needs the BUYER's
//          own Product Hunt developer token, so the core stays token-free.
// Stage 4: Join entities across sources on canonical GitHub owner/name, then
//          registrable domain, then a normalized product-name token.
// Stage 5: (optional, opt-in) scrapemint/domain-intelligence on the product
//          domains for WHOIS + MX so each row is outreach-ready.
// Stage 6: Score momentum 0-100, tier as breakout / momentum / mention, and
//          charge the matching event. First N breakout rows per run are free.
//
// Nested billing: each child actor also bills the buyer for its own per-event
// usage (github repo_row, hn item, producthunt launch, domain lookup). The
// README documents the combined cost.

import { Actor, log } from 'apify';

const FREE_TIER_BREAKOUT = 3;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    keywords = [],
    githubTimeframes = ['daily'],
    githubLanguages = [],
    hnFeeds = ['show', 'top'],
    hnMaxAgeHours = 168,
    minStarsInPeriod = 10,
    minHnPoints = 10,
    maxItemsPerSource = 150,
    includeDomainEnrichment = false,
    includeProductHunt = false,
    productHuntToken = '',
    productHuntTopics = [],
    proxyConfiguration: proxyInput,
} = input;

const cleanKeywords = [...new Set((keywords || []).map((k) => String(k).trim()).filter(Boolean))];
const perSource = Math.max(20, Math.min(500, Number(maxItemsPerSource) || 150));

// ---------- Stage 1: GitHub trending (build-side velocity) ----------
log.info('Stage 1: pulling GitHub trending repos.');
const ghRun = await Actor.call(
    'scrapemint/github-trending-scraper',
    {
        timeframes: Array.isArray(githubTimeframes) && githubTimeframes.length ? githubTimeframes : ['daily'],
        languages: Array.isArray(githubLanguages) ? githubLanguages : [],
        maxReposPerList: Math.min(25, perSource), // github-trending-scraper hard caps this at 25 per list
        includeContributors: false,
        proxyConfiguration: proxyInput,
    },
    { memory: 1024, build: 'latest' },
);
const ghRows = await readDataset(ghRun, 'GitHub trending');

// ---------- Stage 2: Hacker News (attention-side signal) ----------
log.info('Stage 2: pulling Hacker News launch / front-page stories.');
const hnRun = await Actor.call(
    'scrapemint/hn-lead-monitor',
    {
        searchQueries: cleanKeywords,
        feeds: Array.isArray(hnFeeds) ? hnFeeds : ['show', 'top'],
        keywords: cleanKeywords,
        searchType: 'stories',
        sortBy: 'popularity',
        maxAgeHours: Math.max(24, Number(hnMaxAgeHours) || 168),
        minScore: 0,
        maxItemsPerSource: perSource,
        maxItemsTotal: perSource * 2,
        dedupe: false,
        proxyConfiguration: proxyInput,
    },
    { memory: 1024, build: 'latest' },
);
const hnRows = await readDataset(hnRun, 'Hacker News');

// ---------- Stage 3: Product Hunt (optional, buyer token) ----------
let phRows = [];
if (includeProductHunt && String(productHuntToken).trim()) {
    log.info('Stage 3: Product Hunt enrichment ON.');
    try {
        const phRun = await Actor.call(
            'scrapemint/producthunt-launch-tracker',
            {
                developerToken: String(productHuntToken).trim(),
                topics: Array.isArray(productHuntTopics) ? productHuntTopics : [],
                keywords: cleanKeywords,
                sortBy: 'VOTES',
                postedWithin: 'DAY_7',
                maxLaunchesTotal: perSource,
                dedupe: true,
                proxyConfiguration: proxyInput,
            },
            { memory: 1024, build: 'latest' },
        );
        phRows = await readDataset(phRun, 'Product Hunt');
    } catch (err) {
        log.warning(`Product Hunt stage failed (continuing without it): ${err?.message}`);
    }
} else if (includeProductHunt) {
    log.warning('Product Hunt requested but no productHuntToken supplied. Skipping that source.');
}

// ---------- Stage 4: join across sources ----------
const entities = [];
const byGithub = new Map(); // owner/name -> entity
const byDomain = new Map(); // registrable domain -> entity
const byName = new Map();   // normalized name token -> entity

function newEntity(seed) {
    const e = {
        name: seed.name || null,
        description: seed.description || null,
        githubUrl: null,
        repoFullName: null,
        language: null,
        website: null,
        domains: new Set(),
        sources: new Set(),
        github: null,
        hn: [],
        producthunt: null,
        domainInfo: null,
    };
    entities.push(e);
    return e;
}

// GitHub repos first: they own the canonical owner/name key.
for (const r of ghRows) {
    const owner = (r.owner || '').toString().trim();
    const name = (r.name || '').toString().trim();
    if (!owner || !name) continue;
    const ghKey = `${owner}/${name}`.toLowerCase();
    let e = byGithub.get(ghKey);
    if (!e) {
        e = newEntity({ name, description: r.description });
        byGithub.set(ghKey, e);
        indexName(name, e);
    }
    e.sources.add('github');
    e.githubUrl = r.url || `https://github.com/${owner}/${name}`;
    e.repoFullName = r.fullName || `${owner}/${name}`;
    e.language = r.language || e.language;
    if (!e.description) e.description = r.description || null;
    e.github = {
        repo: e.repoFullName,
        url: e.githubUrl,
        language: r.language || null,
        starsInPeriod: Number(r.starsInPeriod) || 0,
        starsTotal: Number(r.starsTotal) || 0,
        forks: Number(r.forks) || 0,
        timeframe: r.timeframe || null,
    };
}

// HN stories: try github match, then domain, then name token; else standalone.
for (const s of hnRows) {
    if (s.itemType && s.itemType !== 'story') continue;
    const extUrl = s.url || null;
    const host = hostOf(extUrl);
    let e = null;

    const ghPath = githubOwnerName(extUrl);
    if (ghPath) e = byGithub.get(ghPath);

    let dom = null;
    if (!e && host && !isGithubHost(host)) {
        dom = registrable(host);
        if (dom) e = byDomain.get(dom);
    }

    const nk = normName(s.title);
    if (!e && nk.length >= 4) e = byName.get(nk);

    if (!e) {
        e = newEntity({ name: productName(s.title) });
        e.website = extUrl;
        if (dom) { e.domains.add(dom); byDomain.set(dom, e); }
        indexName(productName(s.title), e);
    } else if (dom) {
        e.domains.add(dom);
        if (!byDomain.has(dom)) byDomain.set(dom, e);
        if (!e.website) e.website = extUrl;
    }

    e.sources.add('hn');
    e.hn.push({
        title: s.title || null,
        permalink: s.permalink || null,
        url: extUrl,
        points: Number(s.points) || 0,
        numComments: Number(s.numComments) || 0,
        createdAt: s.createdAt || null,
    });
}

// Product Hunt: match by domain, then name; else standalone.
for (const p of phRows) {
    const website = p.website || null;
    const dom = registrable(hostOf(website));
    const nk = normName(p.name);
    let e = (dom && byDomain.get(dom)) || (nk.length >= 4 && byName.get(nk)) || null;
    if (!e) {
        e = newEntity({ name: p.name, description: p.tagline });
        e.website = website;
        if (dom) { e.domains.add(dom); byDomain.set(dom, e); }
        indexName(p.name, e);
    } else {
        if (dom) e.domains.add(dom);
        if (!e.website) e.website = website;
        if (!e.description) e.description = p.tagline || null;
    }
    e.sources.add('producthunt');
    e.producthunt = {
        name: p.name || null,
        tagline: p.tagline || null,
        url: p.url || null,
        website,
        votes: Number(p.votesCount) || 0,
    };
}

// ---------- Stage 5: optional domain enrichment ----------
if (includeDomainEnrichment) {
    const domains = [...new Set(entities.flatMap((e) => [...e.domains]))].filter(Boolean).slice(0, 500);
    if (domains.length) {
        log.info(`Stage 5: domain enrichment ON for ${domains.length} domains.`);
        try {
            const domRun = await Actor.call(
                'scrapemint/domain-intelligence',
                { domains, includeWhois: true, includeDns: true, includeDmarc: false },
                { memory: 512, build: 'latest' },
            );
            const domRows = await readDataset(domRun, 'domain intelligence');
            const byDom = new Map(domRows.map((d) => [String(d.domain || '').toLowerCase(), d]));
            for (const e of entities) {
                for (const d of e.domains) {
                    const info = byDom.get(String(d).toLowerCase());
                    if (info) { e.domainInfo = info; break; }
                }
            }
        } catch (err) {
            log.warning(`Domain enrichment failed (continuing): ${err?.message}`);
        }
    }
}

// ---------- Stage 6: score, tier, push, charge ----------
log.info(`Joined ${entities.length} candidate projects across sources. Scoring.`);

let breakoutCharged = 0; let breakoutFree = 0; let momentumCharged = 0; let mentionCharged = 0; let skipped = 0;

for (const e of entities) {
    const bestHnPoints = e.hn.reduce((m, h) => Math.max(m, h.points || 0), 0);
    const sp = e.github ? e.github.starsInPeriod : 0;
    const hasPh = e.producthunt && (e.producthunt.votes || 0) > 0;

    // Noise gate: must clear at least one minimum to be worth a row.
    if (sp < minStarsInPeriod && bestHnPoints < minHnPoints && !hasPh) { skipped += 1; continue; }

    const ghScore = scoreGithub(e.github);
    const hnScore = scoreHn(e.hn);
    const phScore = scorePh(e.producthunt);
    const momentumScore = Math.min(100, Math.round(ghScore + hnScore + phScore));

    const platforms = [...e.sources];
    const crossPlatform = platforms.length >= 2;

    let tier;
    if (crossPlatform && momentumScore >= 65) tier = 'breakout';
    else if (momentumScore >= 45 || crossPlatform) tier = 'momentum';
    else tier = 'mention';

    const hn = e.hn.length
        ? {
            topPoints: bestHnPoints,
            totalComments: e.hn.reduce((a, h) => a + (h.numComments || 0), 0),
            threadCount: e.hn.length,
            threads: e.hn
                .slice()
                .sort((a, b) => (b.points || 0) - (a.points || 0))
                .slice(0, 3)
                .map((h) => ({ title: h.title, permalink: h.permalink, points: h.points, comments: h.numComments, createdAt: h.createdAt })),
        }
        : null;

    const row = {
        project: e.name || e.repoFullName || (e.domains.size ? [...e.domains][0] : null),
        url: e.githubUrl || e.website || (e.hn[0] && e.hn[0].permalink) || null,
        momentumScore,
        tier,
        platforms,
        crossPlatform,
        description: e.description || (e.producthunt && e.producthunt.tagline) || null,
        github: e.github,
        hackerNews: hn,
        productHunt: e.producthunt,
        domain: e.domains.size ? [...e.domains][0] : null,
        domainIntel: e.domainInfo
            ? {
                domain: e.domainInfo.domain || null,
                registrar: e.domainInfo.registrar || null,
                createdDate: e.domainInfo.createdDate || e.domainInfo.creationDate || null,
                ageDays: e.domainInfo.ageDays ?? null,
                hasMx: e.domainInfo.hasMx ?? (Array.isArray(e.domainInfo.mx) ? e.domainInfo.mx.length > 0 : null),
            }
            : null,
        scoredAt: new Date().toISOString(),
    };

    await Actor.pushData(row);

    if (tier === 'breakout') {
        if (breakoutFree + breakoutCharged < FREE_TIER_BREAKOUT) breakoutFree += 1;
        else { await charge('breakout_project'); breakoutCharged += 1; }
    } else if (tier === 'momentum') {
        await charge('momentum_project'); momentumCharged += 1;
    } else {
        await charge('mention_project'); mentionCharged += 1;
    }
}

log.info(`Done. breakout charged=${breakoutCharged} free=${breakoutFree}, momentum=${momentumCharged}, mention=${mentionCharged}, skipped(noise)=${skipped}.`);
await Actor.exit();

// ---------- helpers ----------

async function readDataset(run, label) {
    if (!run?.defaultDatasetId) {
        log.warning(`${label} stage returned no dataset. Continuing with what we have.`);
        return [];
    }
    const ds = await Actor.openDataset(run.defaultDatasetId, { forceCloud: true });
    const items = (await ds.getData()).items ?? [];
    log.info(`${label} stage: ${items.length} rows from ${run.defaultDatasetId}.`);
    return items;
}

function indexName(name, e) {
    const nk = normName(name);
    if (nk.length >= 4 && !byName.has(nk)) byName.set(nk, e);
}

function scoreGithub(g) {
    if (!g) return 0;
    const sp = g.starsInPeriod || 0;
    const base = sp >= 2000 ? 42 : sp >= 1000 ? 35 : sp >= 500 ? 27 : sp >= 200 ? 18 : sp >= 50 ? 10 : sp > 0 ? 4 : 0;
    const total = g.starsTotal || 0;
    const totalBonus = total >= 20000 ? 8 : total >= 5000 ? 5 : total >= 1000 ? 2 : 0;
    return Math.min(50, base + totalBonus);
}

function scoreHn(hnArr) {
    if (!hnArr || !hnArr.length) return 0;
    const pts = hnArr.reduce((m, h) => Math.max(m, h.points || 0), 0);
    const base = pts >= 500 ? 32 : pts >= 200 ? 24 : pts >= 100 ? 16 : pts >= 50 ? 9 : pts >= 20 ? 4 : pts > 0 ? 2 : 0;
    const comments = hnArr.reduce((a, h) => a + (h.numComments || 0), 0);
    const cBonus = comments >= 300 ? 6 : comments >= 100 ? 4 : comments >= 30 ? 2 : 0;
    const recent = hnArr.some((h) => h.createdAt && (Date.now() - Date.parse(h.createdAt)) < 7 * 864e5) ? 4 : 0;
    return Math.min(50, base + cBonus + recent);
}

function scorePh(ph) {
    if (!ph) return 0;
    const v = ph.votes || 0;
    return v >= 1000 ? 20 : v >= 500 ? 14 : v >= 200 ? 9 : v >= 50 ? 4 : v > 0 ? 2 : 0;
}

function hostOf(url) {
    if (!url) return null;
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
    catch { return null; }
}

function isGithubHost(host) {
    return host === 'github.com' || host === 'www.github.com';
}

function githubOwnerName(url) {
    if (!url) return null;
    try {
        const u = new URL(url);
        if (!isGithubHost(u.hostname.toLowerCase())) return null;
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length < 2) return null;
        return `${parts[0]}/${parts[1]}`.toLowerCase();
    } catch { return null; }
}

function registrable(host) {
    if (!host) return null;
    const labels = host.split('.').filter(Boolean);
    if (labels.length <= 2) return host;
    // Keep last two labels (good enough for outreach grouping; co.uk etc. kept as 3 below).
    const twoCc = new Set(['co', 'com', 'org', 'net', 'gov', 'ac']);
    if (labels.length >= 3 && twoCc.has(labels[labels.length - 2]) && labels[labels.length - 1].length === 2) {
        return labels.slice(-3).join('.');
    }
    return labels.slice(-2).join('.');
}

function productName(title) {
    if (!title) return null;
    let t = String(title).trim();
    t = t.replace(/^(show|ask|tell|launch)\s+hn\s*:?\s*/i, '');
    const cut = t.split(/\s+[–—|:-]\s+| \(/)[0];
    return (cut || t).trim();
}

function normName(s) {
    if (!s) return '';
    return productName(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function charge(eventName) {
    try { await Actor.charge({ eventName }); }
    catch (err) { log.warning(`charge ${eventName} failed (continuing): ${err?.message}`); }
}
