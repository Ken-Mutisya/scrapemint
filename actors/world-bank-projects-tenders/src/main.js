// World Bank Projects & Tenders: Funded Work by Country
//
// What it does
// ------------
// Development finance turned into something you can act on: the projects the
// bank has approved, how much money is behind them, and the live procurement
// notices calling for bids and expressions of interest, with the deadline and
// the contact who receives them.
//
//   notices   one row per procurement notice: deadline, method, bid reference
//             and the contact name, organisation, email and phone
//   projects  one row per funded project: commitment, approval and closing
//             dates, borrower and implementing agency
//   countries one row per country: how many projects and how much money
//
// Two filter behaviours worth knowing about
// -----------------------------------------
// The two endpoints fail in OPPOSITE directions when a filter name is wrong.
// On projects an unrecognised parameter is ignored silently and the full
// 28,000 project set comes back looking like a filtered result. On notices a
// wrong parameter returns nothing at all. Both are quietly wrong answers, so
// every filter here is verified against the rows that come back, and a filter
// that did not take effect is reported rather than passed off as data.
//
// Pay per event
// -------------
//   record_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 60000;
const PAGE_SIZE = 100;
const SPACING_MS = 500;
const PROJECTS_API = 'https://search.worldbank.org/api/v3/projects';
const NOTICES_API = 'https://search.worldbank.org/api/v2/procnotices';
const UA = 'Scrapemint/1.0 (Apify actor; https://apify.com/scrapemint)';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 45000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'notices',
    country = '',
    searchTerm = '',
    noticeType = '',
    onlyOpen = true,
    status = '',
    minAmountUsd = 0,
    approvedSince = '',
    maxResults = 100,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const clean = (v) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s || null; };
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => {
    const s = String(v ?? '').replace(/[,$\s]/g, '');
    if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
};

const theMode = ['notices', 'projects', 'countries'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'notices';
const wantCountry = clean(country);
const wantNoticeTypes = asList(noticeType).map((s) => s.toLowerCase());
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxResults) || 100));
const amountFloor = Math.max(0, Number(minAmountUsd) || 0);
const sinceDate = /^\d{4}-\d{2}-\d{2}$/.test(String(approvedSince).trim()) ? String(approvedSince).trim() : null;

async function getJson(url, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA, accept: 'application/json' } });
        const text = await res.text();
        if (!text.trimStart().startsWith('{')) return null;
        return JSON.parse(text);
    } catch (err) {
        if (attempt < 2) { await sleep(1200 * (attempt + 1)); return getJson(url, attempt + 1); }
        log.warning(`fetch failed: ${url.slice(0, 120)} (${err?.message})`);
        return null;
    } finally { clearTimeout(timer); }
}

let rowsPushed = 0;
let notePushed = false;
async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'record_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

let emitted = 0;
const push = async (row) => {
    if (emitted >= cap) return false;
    await flushRow(row);
    emitted += 1;
    return true;
};

// Notice dates arrive as "27-Jul-2026" while the deadline on the same record
// is a full ISO timestamp. One format per field, not per file.
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseNoticeDate(v) {
    const s = String(v ?? '').trim();
    const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (m) {
        const month = MONTHS[m[2].toLowerCase()];
        if (month == null) return null;
        return new Date(Date.UTC(Number(m[3]), month, Number(m[1]))).toISOString().slice(0, 10);
    }
    const iso = Date.parse(s);
    return Number.isFinite(iso) ? new Date(iso).toISOString().slice(0, 10) : null;
}

function deadlineInstant(dateIso, timeText) {
    if (!dateIso) return null;
    const base = String(dateIso).slice(0, 10);
    const t = String(timeText || '').match(/^(\d{1,2}):(\d{2})$/);
    const hh = t ? t[1].padStart(2, '0') : '23';
    const mm = t ? t[2] : '59';
    const parsed = Date.parse(`${base}T${hh}:${mm}:00Z`);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function fetchPaged(baseUrl, key, wanted) {
    const collected = [];
    let offset = 0;
    let total = null;
    while (collected.length < wanted) {
        if (deadlineMs && Date.now() > deadlineMs) { log.warning('run deadline reached'); break; }
        const rows = Math.min(PAGE_SIZE, wanted - collected.length);
        const json = await getJson(`${baseUrl}&rows=${rows}&os=${offset}`);
        await sleep(SPACING_MS);
        if (!json) break;
        if (total == null) total = num(json.total);
        const payload = json[key];
        const batch = Array.isArray(payload) ? payload : Object.values(payload || {});
        if (!batch.length) break;
        collected.push(...batch);
        offset += batch.length;
        if (total != null && offset >= total) break;
    }
    return { records: collected, total };
}

log.info(`World Bank ${theMode}${wantCountry ? ` | country ${wantCountry}` : ''}${searchTerm ? ` | search "${searchTerm}"` : ''}`);

if (theMode === 'notices') {
    // Only the free text parameter filters this endpoint reliably; the named
    // country and notice type parameters return zero rather than filtering.
    const terms = [clean(searchTerm), wantCountry].filter(Boolean).join(' ');
    const url = `${NOTICES_API}?format=json${terms ? `&qterm=${encodeURIComponent(terms)}` : ''}`;
    // The search matches globally, so a country filter discards much of what
    // comes back. Pull deeper when one is set, or the run under delivers.
    const fetchTarget = Math.min(wantCountry || wantNoticeTypes.length ? cap * 10 : cap * 3, 1000);
    const { records, total } = await fetchPaged(url, 'procnotices', fetchTarget);
    log.info(`${records.length} notice(s) retrieved of ${total ?? 'unknown'} matching`);

    const now = Date.now();
    let rows = records.map((n) => {
        const deadlineIso = deadlineInstant(n.submission_deadline_date, n.submission_deadline_time);
        const msLeft = deadlineIso ? Date.parse(deadlineIso) - now : null;
        return {
            mode: 'notices',
            noticeId: clean(n.id),
            noticeType: clean(n.notice_type),
            noticeStatus: clean(n.notice_status),
            publishedDate: parseNoticeDate(n.noticedate),
            submissionDeadline: deadlineIso,
            daysUntilDeadline: msLeft == null ? null : round(msLeft / 86400000, 1),
            isOpen: msLeft == null ? null : msLeft > 0,
            country: clean(n.project_ctry_name),
            projectId: clean(n.project_id),
            projectName: clean(n.project_name),
            bidReference: clean(n.bid_reference_no),
            description: clean(n.bid_description),
            procurementMethod: clean(n.procurement_method_name),
            procurementGroup: clean(n.procurement_group),
            language: clean(n.notice_lang_name),
            contactName: clean(n.contact_name),
            contactOrganisation: clean(n.contact_organization),
            contactEmail: clean(n.contact_email),
            contactPhone: clean(n.contact_phone_no),
            contactAddress: clean(n.contact_address),
            contactCountry: clean(n.contact_ctry_name),
            hasContactEmail: Boolean(clean(n.contact_email)),
            source: 'World Bank',
            scrapedAt: new Date().toISOString(),
        };
    });

    // The free text search matches anywhere in the record, so a country term
    // can return notices from elsewhere. Country is enforced here instead of
    // trusted to the query.
    if (wantCountry) {
        const before = rows.length;
        rows = rows.filter((r) => String(r.country || '').toLowerCase().includes(wantCountry.toLowerCase()));
        if (before && !rows.length) {
            log.warning(`the search matched ${before} notice(s) but none are for ${wantCountry}`);
        }
    }
    if (wantNoticeTypes.length) rows = rows.filter((r) => wantNoticeTypes.some((t) => String(r.noticeType || '').toLowerCase().includes(t)));
    // A contract award carries no submission deadline because the work is
    // already assigned. It is not an open opportunity, so it goes when the
    // buyer asks for open notices only.
    if (onlyOpen) rows = rows.filter((r) => r.isOpen === true);

    rows.sort((a, b) => (a.daysUntilDeadline ?? 9999) - (b.daysUntilDeadline ?? 9999));
    for (const row of rows) { if (!(await push(row))) break; }

    if (!emitted) {
        await flushRow({
            type: 'note', found: false, retrieved: records.length,
            note: records.length
                ? 'notices were found but none matched the country, notice type or open deadline filters; clear onlyOpen to include closed notices; not charged'
                : 'no notices matched that search; try a broader term, or a country name on its own; not charged',
            hint: onlyOpen ? 'onlyOpen excludes contract awards and anything past its deadline' : undefined,
        }, false);
    }
} else {
    // countryshortname_exact filters correctly; countrycode does NOT and is
    // ignored silently, which is why the result is checked below.
    const params = ['format=json', 'fl=id,project_name,countryshortname,regionname,status,totalamt,curr_ibrd_commitment,idacommamt,grantamt,lendprojectcost,boardapprovaldate,closingdate,borrower,impagency,project_abstract,url'];
    if (wantCountry) params.push(`countryshortname_exact=${encodeURIComponent(wantCountry)}`);
    if (clean(status)) params.push(`status_exact=${encodeURIComponent(clean(status))}`);
    if (clean(searchTerm)) params.push(`qterm=${encodeURIComponent(clean(searchTerm))}`);
    const wanted = theMode === 'countries' ? Math.min(HARD_CAP, 1000) : cap * 2;
    let { records, total } = await fetchPaged(`${PROJECTS_API}?${params.join('&')}`, 'projects', wanted);
    // The source spells some countries its own way: "Viet Nam", not
    // "Vietnam". An exact name that matches nothing therefore falls back to a
    // free text search, which is then verified below, rather than telling the
    // buyer their country has no projects when it has 240.
    let resolvedCountry = wantCountry;
    if (wantCountry && !records.length) {
        log.info(`no exact match for "${wantCountry}"; retrying as a free text search in case the source spells it differently`);
        const fallback = params.filter((x) => !x.startsWith('countryshortname_exact='));
        fallback.push(`qterm=${encodeURIComponent(wantCountry)}`);
        const retry = await fetchPaged(`${PROJECTS_API}?${fallback.join('&')}`, 'projects', wanted);
        records = retry.records;
        total = retry.total;
        const seen = [...new Set(records.map((r) => clean(r.countryshortname)).filter(Boolean))];
        const near = seen.find((n) => n.toLowerCase().replace(/\s+/g, '') === wantCountry.toLowerCase().replace(/\s+/g, ''));
        if (near) {
            resolvedCountry = near;
            log.info(`the source calls it "${near}"`);
        }
    }
    log.info(`${records.length} project(s) retrieved of ${total ?? 'unknown'} matching`);

    let rows = records.map((p) => {
        const abstract = clean(p.project_abstract);
        return {
            projectId: clean(p.id),
            projectName: clean(p.project_name),
            country: clean(p.countryshortname),
            region: clean(p.regionname),
            status: clean(p.status),
            totalCommitmentUsd: num(p.totalamt),
            ibrdCommitmentUsd: num(p.curr_ibrd_commitment),
            idaCommitmentUsd: num(p.idacommamt),
            grantAmountUsd: num(p.grantamt),
            totalProjectCostUsd: num(p.lendprojectcost),
            boardApprovalDate: p.boardapprovaldate ? String(p.boardapprovaldate).slice(0, 10) : null,
            closingDate: p.closingdate ? String(p.closingdate).slice(0, 10) : null,
            borrower: clean(p.borrower),
            implementingAgency: clean(p.impagency),
            summary: abstract ? abstract.slice(0, 600) : null,
            url: clean(p.url),
            source: 'World Bank',
            scrapedAt: new Date().toISOString(),
        };
    });

    // Verify the country filter actually applied, because an unrecognised
    // parameter here returns the whole catalogue instead of an error.
    let filterIgnored = false;
    if (wantCountry) {
        const target = (resolvedCountry || wantCountry).toLowerCase();
        const matching = rows.filter((r) => String(r.country || '').toLowerCase() === target);
        if (matching.length !== rows.length) {
            filterIgnored = true;
            log.warning(`the country filter did not take effect at the source (${matching.length} of ${rows.length} rows are ${resolvedCountry || wantCountry}); filtering here instead`);
            rows = matching;
        }
    }
    if (amountFloor) rows = rows.filter((r) => (r.totalCommitmentUsd ?? 0) >= amountFloor);
    if (sinceDate) rows = rows.filter((r) => r.boardApprovalDate && r.boardApprovalDate >= sinceDate);

    if (theMode === 'countries') {
        const byCountry = new Map();
        for (const r of rows) {
            const key = r.country || 'unknown';
            if (!byCountry.has(key)) byCountry.set(key, { projects: 0, committed: 0, grants: 0, region: r.region, latest: null, withAmount: 0 });
            const c = byCountry.get(key);
            c.projects += 1;
            if (r.totalCommitmentUsd != null) { c.committed += r.totalCommitmentUsd; c.withAmount += 1; }
            if (r.grantAmountUsd != null) c.grants += r.grantAmountUsd;
            if (r.boardApprovalDate && (!c.latest || r.boardApprovalDate > c.latest)) c.latest = r.boardApprovalDate;
        }
        const out = [...byCountry.entries()].map(([name, c]) => ({
            mode: 'countries',
            country: name,
            region: c.region,
            projects: c.projects,
            // Only projects that report a commitment are summed, and the count
            // is given so the average is not read off the wrong denominator.
            projectsWithReportedAmount: c.withAmount,
            totalCommitmentUsd: round(c.committed, 2),
            totalGrantsUsd: round(c.grants, 2),
            averageCommitmentUsd: c.withAmount ? round(c.committed / c.withAmount, 2) : null,
            latestApprovalDate: c.latest,
            sampleSize: rows.length,
            source: 'World Bank',
            scrapedAt: new Date().toISOString(),
        })).sort((a, b) => b.totalCommitmentUsd - a.totalCommitmentUsd);
        for (const row of out) { if (!(await push(row))) break; }
    } else {
        rows.sort((a, b) => String(b.boardApprovalDate).localeCompare(String(a.boardApprovalDate)));
        for (const row of rows) { if (!(await push({ mode: 'projects', ...row })) ) break; }
    }

    if (!emitted) {
        await flushRow({
            type: 'note', found: false, retrieved: records.length, countryFilterIgnoredBySource: filterIgnored,
            note: records.length
                ? 'projects were retrieved but none survived the filters; lower minAmountUsd, widen approvedSince, or check the country spelling against the source, which uses short names such as "Congo, Democratic Republic of"; not charged'
                : 'no projects matched; check the country name spelling; not charged',
        }, false);
    }
}

if (!emitted && !notePushed) {
    await flushRow({ type: 'note', found: false, note: 'nothing returned; not charged' }, false);
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
