// Funded Startup Lead Pipeline
//
// Turns SEC Form D filings (the form a company files right after it raises private
// money) into B2B sales / recruiting / VC leads, optionally enriched with the
// company's website, phone, and contact emails.
//
// Stage 1 (inline EDGAR, keyless): full-text search Form D filings in the date
//   window, fetch each primary_doc.xml, and parse the issuer name, industry,
//   amount offered / sold, named executives and directors (the decision makers),
//   and the issuer city/state. Pooled investment funds (SPVs, VC fund vehicles)
//   are filtered out by industryGroupType so leads are operating companies that
//   just raised and are likely to be spending.
// Stage 2 (optional child, batched): for the top leads, call
//   scrapemint/google-maps-scraper (enrichFromWebsite OFF for speed) to attach a
//   website and phone, then the parent scrapes contact emails from those sites in
//   a bounded parallel pool. The Maps child is driven with a hard parent deadline
//   (START -> waitForFinish -> ABORT) so a slow child can never hang the run.
// Stage 3: score lead quality 0-100 (raise size, recency, named decision makers,
//   contactability), tier hot_lead / qualified_lead / lead, push, charge.
//
// The funding side is plain EDGAR HTTP/JSON (no browser, no proxy). The Maps child
// also bills its own per-place usage to the buyer; the README documents this.

import { Actor, log } from 'apify';
import dns from 'node:dns/promises';

const FREE_TIER_HOT = 1;
const EDGAR_RATE_SLEEP_MS = 130;
// Stage 1 walks up to 400 filings one at a time, each with its own retry sleeps.
// When EDGAR throttles (it answers slow or empty rather than erroring) that walk
// alone can eat the whole run budget, and because rows are only pushed in stage 3
// the run then dies TIMED-OUT with zero rows and zero charges. Every stage-1 loop
// checks this reserve and returns what it has instead.
const STAGE1_RESERVE_WITH_CONTACTS_SECS = 700;
const STAGE1_RESERVE_NO_CONTACTS_SECS = 200;
const SITE_FETCH_TIMEOUT_MS = 6000;
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9._\-]+\.[a-z]{2,}/gi;
const EMAIL_SHAPE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i;
const PACKAGE_VERSION = /^[^@\s]+@\d+(\.\d+){1,}(-[\w.]+)?$/;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    maxAgeDays = 30,
    minAmountSoldUsd = 0,
    states = [],
    industries = [],
    includeFunds = false,
    // Off by default. Measured 2026-07-22 on the prefill input: 37 companies
    // queried, 14 Maps places back, 1 lead matched, 0 emails found, for 820s of
    // the 944s run and 65% of its compute. Tiering runs off raise size, recency
    // and the Form D executives, so the stage changed no tier. Buyers who want
    // contacts can still turn it on.
    includeContacts = false,
    maxLeads = 100,
    maxContactLookups = 40,
    userAgent: userAgentInput = '',
    proxyConfiguration: proxyInput,
} = input;

const maxAgeMs = Math.max(1, Number(maxAgeDays) || 30) * 864e5;
const minAmount = Math.max(0, Number(minAmountSoldUsd) || 0);
const leadCap = Math.max(1, Math.min(1000, Number(maxLeads) || 100));
const contactCap = Math.max(0, Math.min(200, Number(maxContactLookups) || 40));
const wantStates = new Set((Array.isArray(states) ? states : [states]).map((s) => String(s || '').trim().toUpperCase()).filter(Boolean));
// Industry include-filter (empty = all operating industries). Matched loosely
// against Form D industryGroupType so "technology" hits "Other Technology" and
// "health" hits "Other Health Care". Use it to skew leads toward real startups.
const wantIndustries = (Array.isArray(industries) ? industries : [industries])
    .map((s) => String(s || '').trim().toLowerCase()).filter(Boolean);

const userAgent = String(userAgentInput).trim()
    || 'scrapemint-funded-startup-lead research@scrapemint.example';
if (!/@/.test(userAgent)) {
    log.warning('SEC requires an email in the User-Agent. Your value lacks an @ which may cause 403 responses.');
}
const headers = { 'User-Agent': userAgent, Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' };

// Wall-clock budget shared by every stage. Derived from the run's ACTUAL timeout
// so buyer-set short timeouts are respected too (never hardcode the budget).
const runTimeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const secsUntilTimeout = () => (runTimeoutAtMs ? Math.max(0, Math.floor((runTimeoutAtMs - Date.now()) / 1000)) : Infinity);
const stage1Reserve = (includeContacts && Number(maxContactLookups) > 0)
    ? STAGE1_RESERVE_WITH_CONTACTS_SECS
    : STAGE1_RESERVE_NO_CONTACTS_SECS;

const startdt = new Date(Date.now() - maxAgeMs).toISOString().slice(0, 10);
const enddt = new Date(Date.now() + 864e5).toISOString().slice(0, 10);

// ---------- Stage 1: Form D filings ----------
log.info(`Stage 1: EDGAR Form D filings ${startdt} .. ${enddt}.`);
let leads = await fetchFormDLeads();
log.info(`Parsed ${leads.length} operating-company Form D leads after filtering.`);
if (leads.length === 0) {
    log.warning('No Form D leads in range after filters. Nothing to score.');
    await Actor.exit();
}
// Rank by amount sold (biggest fresh raises first), then recency.
leads.sort((a, b) => (b.amountSold || 0) - (a.amountSold || 0) || (b.fileDateMs || 0) - (a.fileDateMs || 0));
leads = leads.slice(0, leadCap);

// ---------- Stage 2: contact enrichment (optional) ----------
if (includeContacts && contactCap > 0) {
    await enrichContacts(leads.slice(0, contactCap));
} else {
    log.info('Contact enrichment disabled (includeContacts=false or maxContactLookups=0).');
}

// ---------- Stage 3: score, tier, push, charge ----------
log.info(`Scoring ${leads.length} leads.`);
let hotCharged = 0; let hotFree = 0; let qualified = 0; let basic = 0;

for (const L of leads) {
    const amountScore = scoreAmount(L.amountSold);
    const recScore = recency(L.fileDateMs);
    const dmScore = scoreDecisionMakers(L.executives);
    const contactScore = scoreContact(L);
    const leadScore = Math.min(100, Math.round(amountScore + recScore + dmScore + contactScore));

    const recentDays = L.fileDateMs ? (Date.now() - L.fileDateMs) / 864e5 : Infinity;
    const hasContact = Boolean(L.website || L.phone || (L.emails && L.emails.length));
    const hasDM = (L.executives || []).length > 0;

    let tier;
    if ((L.amountSold || 0) >= 1_000_000 && recentDays <= 45 && (hasContact || hasDM)) tier = 'hot_lead';
    else if ((L.amountSold || 0) >= 250_000 || (hasDM && hasContact)) tier = 'qualified_lead';
    else tier = 'lead';

    const row = {
        company: L.company,
        cik: L.cik,
        tier,
        leadScore,
        scoreBreakdown: { amount: amountScore, recency: recScore, decisionMakers: dmScore, contact: contactScore },
        funding: {
            amountOfferedUsd: L.amountOffered,
            amountSoldUsd: L.amountSold,
            percentSold: L.amountOffered ? Math.round(100 * (L.amountSold || 0) / L.amountOffered) : null,
            industry: L.industry,
            isAmendment: L.isAmendment,
            fileDate: L.fileDate,
            daysAgo: L.fileDateMs ? Math.round(recentDays) : null,
            filingUrl: L.filingUrl,
        },
        location: { city: L.city, state: L.state },
        executives: (L.executives || []).slice(0, 8),
        contact: {
            website: L.website || null,
            websiteReachable: L.websiteReachable ?? null,
            phone: L.phone || null,
            emails: L.emails || [],
            likelyContactEmails: L.likelyContactEmails || [],
        },
        scoredAt: new Date().toISOString(),
    };

    await Actor.pushData(row);

    if (tier === 'hot_lead') {
        if (hotFree + hotCharged < FREE_TIER_HOT) hotFree += 1;
        else { await charge('hot_lead'); hotCharged += 1; }
    } else if (tier === 'qualified_lead') {
        await charge('qualified_lead'); qualified += 1;
    } else {
        await charge('lead'); basic += 1;
    }
}

log.info(`Done. hot_lead charged=${hotCharged} free=${hotFree}, qualified_lead=${qualified}, lead=${basic}.`);
await Actor.exit();

// ---------- Stage 1 helpers ----------

async function fetchFormDLeads() {
    const out = [];
    const seenAcc = new Set();
    // Pull more raw hits than leadCap because funds get filtered out.
    const maxHits = Math.min(1000, leadCap * 4);
    for (let from = 0; from < maxHits && out.length < leadCap * 2; from += 10) {
        if (secsUntilTimeout() < stage1Reserve) {
            log.warning(`Stage 1 budget reached at ${out.length} leads (${secsUntilTimeout()}s left); continuing with what was parsed so far.`);
            break;
        }
        const url = `https://efts.sec.gov/LATEST/search-index?q=&forms=D&startdt=${startdt}&enddt=${enddt}&from=${from}`;
        const data = await fetchJsonWithRetry(url);
        const hits = data?.hits?.hits || [];
        if (hits.length === 0) break;

        for (const h of hits) {
            if (secsUntilTimeout() < stage1Reserve) break;
            const id = String(h._id || '');
            const accession = id.split(':')[0];
            const doc = id.split(':')[1] || 'primary_doc.xml';
            if (!accession || seenAcc.has(accession)) continue;
            seenAcc.add(accession);

            const s = h._source || {};
            const display = (s.display_names && s.display_names[0]) || '';
            const cikM = display.match(/CIK\s*(\d+)/i);
            const cik = cikM ? cikM[1].replace(/^0+/, '') : null;
            if (!cik) continue;

            const xml = await fetchText(`https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/${doc}`);
            if (!xml) continue;
            const lead = parseFormD(xml, { cik, accession, fileDate: s.file_date || null, rootForms: s.root_forms || [] });
            if (!lead) continue;

            if (!includeFunds && /pooled investment fund/i.test(lead.industry || '')) continue;
            if ((lead.amountSold || 0) < minAmount) continue;
            if (wantStates.size > 0 && (!lead.state || !wantStates.has(lead.state.toUpperCase()))) continue;
            if (wantIndustries.length > 0) {
                const ind = String(lead.industry || '').toLowerCase();
                if (!ind || !wantIndustries.some((w) => ind.includes(w) || w.includes(ind))) continue;
            }

            out.push(lead);
        }
        if (hits.length < 10) break;
    }
    return out;
}

function parseFormD(xml, meta) {
    const tag = (name, scope = xml) => {
        const m = scope.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
        return m ? m[1].trim() : null;
    };
    const entityName = tag('entityName');
    if (!entityName) return null;

    // Issuer address block (first issuerAddress), so we don't pick up a person's city.
    const addrBlock = (xml.match(/<issuerAddress>([\s\S]*?)<\/issuerAddress>/i) || [])[1] || '';
    const city = tag('city', addrBlock);
    const state = tag('stateOrCountry', addrBlock);

    const industry = tag('industryGroupType');
    const amountOffered = parseAmount(tag('totalOfferingAmount'));
    const amountSold = parseAmount(tag('totalAmountSold'));

    const isAmendment = /true/i.test(tag('isAmendment') || '')
        || (Array.isArray(meta.rootForms) && meta.rootForms.some((f) => /D\/A/i.test(f)));

    // Related persons: name + relationship list, each in a relatedPersonInfo block.
    const executives = [];
    for (const m of xml.matchAll(/<relatedPersonInfo>([\s\S]*?)<\/relatedPersonInfo>/gi)) {
        const block = m[1];
        const first = (block.match(/<firstName>([^<]*)<\/firstName>/i) || [])[1] || '';
        const last = (block.match(/<lastName>([^<]*)<\/lastName>/i) || [])[1] || '';
        const name = `${first} ${last}`.replace(/\s+/g, ' ').trim();
        if (!name) continue;
        const rels = [...block.matchAll(/<relationship>([^<]*)<\/relationship>/gi)].map((r) => r[1].trim()).filter(Boolean);
        executives.push({ name, roles: rels });
    }

    return {
        company: entityName,
        cik: meta.cik,
        industry,
        amountOffered,
        amountSold,
        isAmendment,
        city,
        state,
        executives,
        fileDate: meta.fileDate,
        fileDateMs: Date.parse(meta.fileDate || '') || null,
        filingUrl: `https://www.sec.gov/Archives/edgar/data/${meta.cik}/${meta.accession.replace(/-/g, '')}/${meta.accession}-index.htm`,
    };
}

// Form D amounts can be "Indefinite" (open-ended funds) -> null.
function parseAmount(v) {
    if (v == null) return null;
    const n = Number(String(v).replace(/[,$]/g, ''));
    return Number.isFinite(n) ? n : null;
}

// ---------- Stage 2 helpers: Maps child + parent email enrichment ----------

async function enrichContacts(targets) {
    const queries = targets.map((L) => {
        const loc = [L.city, L.state].filter(Boolean).join(', ');
        return loc ? `${L.company}, ${loc}` : L.company;
    });
    const dedupedQueries = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
    log.info(`Stage 2: contact lookup for ${dedupedQueries.length} companies via Google Maps.`);

    const CHILD_TIMEOUT_SECS = 900; // child self-cap (belt)
    const CHILD_WAIT_SECS = 1200; // parent hard deadline (suspenders)
    // The static wait must also respect the run's ACTUAL timeout (buyers set
    // custom, often shorter, timeouts): clamp so enrichment + push always fit
    // before ACTOR_TIMEOUT_AT, else short buyer runs are TIMED-OUT by design.
    const POST_CHILD_RESERVE_SECS = 300;
    const effectiveChildWait = Math.max(60, Math.min(CHILD_WAIT_SECS, secsUntilTimeout() - POST_CHILD_RESERVE_SECS));
    let mapsRun = null;
    try {
        const started = await Actor.start(
            'scrapemint/google-maps-scraper',
            {
                searchQueries: dedupedQueries,
                maxPlacesPerQuery: 1,
                maxPlacesTotal: dedupedQueries.length,
                scrapeReviews: false,
                scrapeImages: false,
                enrichFromWebsite: false,
                dedupe: true,
                proxyConfiguration: proxyInput,
            },
            // 1024MB hangs the Maps browser child (tile rendering starves);
            // 2048 is the verified-stable floor from the gmaps margin fix.
            { memory: 2048, build: 'latest', timeout: CHILD_TIMEOUT_SECS },
        );
        const runClient = Actor.apifyClient.run(started.id);
        mapsRun = await runClient.waitForFinish({ waitSecs: effectiveChildWait });
        if (mapsRun && (mapsRun.status === 'RUNNING' || mapsRun.status === 'READY')) {
            log.warning(`Maps child still ${mapsRun.status} after ${effectiveChildWait}s; aborting and using partial dataset.`);
            try { mapsRun = await runClient.abort({ gracefully: true }); }
            catch (e) { log.warning(`Abort failed: ${e?.message}`); }
        }
        if (mapsRun && !mapsRun.defaultDatasetId) mapsRun.defaultDatasetId = started.defaultDatasetId;
    } catch (err) {
        log.warning(`Maps stage error (continuing without contacts): ${err?.message}`);
        return;
    }
    if (!mapsRun?.defaultDatasetId) { log.warning('Maps stage returned no dataset; skipping contacts.'); return; }

    const mapsDataset = await Actor.openDataset(mapsRun.defaultDatasetId, { forceCloud: true });
    const places = (await mapsDataset.getData()).items ?? [];
    log.info(`Maps returned ${places.length} places. Matching + scraping emails.`);

    // Match each place to a lead by core-name containment.
    const placeByCore = new Map();
    for (const p of places) {
        const nm = coreName(p.name || p.title);
        if (nm && !placeByCore.has(nm)) placeByCore.set(nm, p);
    }
    const matched = [];
    for (const L of targets) {
        const core = coreName(L.company);
        let place = placeByCore.get(core);
        if (!place && core) {
            for (const [k, p] of placeByCore) { if (k.includes(core) || core.includes(k)) { place = p; break; } }
        }
        if (place) {
            L.website = place.website || place.websiteUrl || null;
            L.phone = place.phone || place.phoneNumber || null;
            matched.push(L);
        }
    }
    log.info(`Matched ${matched.length} leads to a Maps listing. Scraping emails from sites.`);

    await mapWithConcurrency(matched, 10, async (L) => {
        const domain = extractDomain(L.website);
        const { reachable, emails } = L.website ? await fetchSite(L.website) : { reachable: false, emails: [] };
        L.websiteReachable = reachable;
        L.emails = emails;
        L.likelyContactEmails = inferContactEmails(domain, emails);
        if (reachable && domain) L.mxFound = await hasMx(domain);
        return L;
    });
}

function extractDomain(urlOrHost) {
    if (!urlOrHost) return null;
    try {
        const u = String(urlOrHost).trim();
        const withProto = /^https?:\/\//i.test(u) ? u : `http://${u}`;
        return new URL(withProto).hostname.toLowerCase().replace(/^www\./, '');
    } catch { return null; }
};

async function fetchSite(websiteUrl) {
    if (!websiteUrl) return { reachable: false, emails: [] };
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SITE_FETCH_TIMEOUT_MS);
        const res = await fetch(websiteUrl, {
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadEnrich/1.0)' },
        });
        clearTimeout(timer);
        const reachable = res.status < 500;
        let emails = [];
        if (reachable && (res.headers.get('content-type') || '').includes('text')) {
            emails = extractEmailsFromHtml((await res.text()).slice(0, 300000));
        }
        return { reachable, emails };
    } catch { return { reachable: false, emails: [] }; }
};

async function hasMx(domain) {
    if (!domain) return false;
    try {
        const records = await Promise.race([
            dns.resolveMx(domain),
            new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
        ]);
        return Array.isArray(records) && records.length > 0;
    } catch { return false; }
};

function extractEmailsFromHtml(html) {
    if (!html) return [];
    const set = new Set();
    for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
        const e = decodeURIComponent(m[1]).toLowerCase().trim();
        if (EMAIL_SHAPE.test(e) && !PACKAGE_VERSION.test(e)) set.add(e);
    }
    for (const m of html.matchAll(EMAIL_RE)) {
        const e = m[0].toLowerCase();
        if (!EMAIL_SHAPE.test(e) || PACKAGE_VERSION.test(e)) continue;
        if (/\.(png|jpe?g|gif|svg|webp|css|js|json|woff2?)$/i.test(e)) continue;
        if (/@(?:sentry|wixpress|example|email)\./i.test(e)) continue;
        set.add(e);
    }
    return [...set];
};

function inferContactEmails(domain, existing) {
    const set = new Set();
    for (const e of (Array.isArray(existing) ? existing : [])) {
        if (typeof e !== 'string' || PACKAGE_VERSION.test(e) || !EMAIL_SHAPE.test(e)) continue;
        set.add(e.toLowerCase());
    }
    if (domain) for (const local of ['info', 'contact', 'hello']) set.add(`${local}@${domain}`);
    return [...set];
};

async function mapWithConcurrency(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
    return out;
};

// ---------- scoring ----------

function scoreAmount(sold) {
    const v = sold || 0;
    if (v >= 10_000_000) return 45;
    if (v >= 5_000_000) return 38;
    if (v >= 1_000_000) return 30;
    if (v >= 250_000) return 20;
    if (v >= 100_000) return 12;
    return v > 0 ? 6 : 0;
}

function scoreDecisionMakers(execs) {
    const list = Array.isArray(execs) ? execs : [];
    if (list.length === 0) return 0;
    let s = list.length >= 3 ? 12 : list.length === 2 ? 9 : 6;
    if (list.some((e) => (e.roles || []).some((r) => /executive officer/i.test(r)))) s += 8;
    return Math.min(20, s);
}

function scoreContact(L) {
    let s = 0;
    if (L.website && L.websiteReachable) s += 6;
    else if (L.website) s += 3;
    if (L.phone) s += 4;
    if ((L.emails || []).length > 0) s += 5;
    return Math.min(15, s);
}

function recency(ms) {
    if (!ms) return 3;
    const d = (Date.now() - ms) / 864e5;
    if (d <= 7) return 20;
    if (d <= 21) return 14;
    if (d <= 45) return 8;
    return 3;
}

// ---------- shared helpers ----------

function coreName(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[.,&]/g, ' ')
        .replace(/\b(inc|incorporated|corp|corporation|co|company|ltd|limited|llc|lp|llp|plc|holdings|holding|group|the)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function fetchJsonWithRetry(url, attempts = 4) {
    for (let i = 0; i < attempts; i++) {
        await sleep(EDGAR_RATE_SLEEP_MS + i * 400);
        try {
            const res = await fetch(url, { headers });
            if (res.ok) return await res.json();
            if (res.status >= 500 || res.status === 429) continue;
            log.warning(`EDGAR HTTP ${res.status} for ${url}`);
            return null;
        } catch (err) {
            if (i === attempts - 1) log.warning(`EDGAR fetch failed for ${url}: ${err?.message}`);
        }
    }
    return null;
}

async function fetchText(url) {
    for (let i = 0; i < 3; i++) {
        await sleep(EDGAR_RATE_SLEEP_MS + i * 300);
        try {
            const res = await fetch(url, { headers });
            if (res.ok) return await res.text();
            if (res.status >= 500 || res.status === 429) continue;
            return null;
        } catch { /* retry */ }
    }
    return null;
}

async function charge(eventName) {
    try { await Actor.charge({ eventName }); }
    catch (err) { log.warning(`charge ${eventName} failed (continuing): ${err?.message}`); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
