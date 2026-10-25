// Parser for the Google Jobs results page (google.com/search?udm=8).
// Kept apart from main.js so it can be tested against saved pages.
//
// Each job is a block carrying data-encoded-docid. Google repeats the docid
// on nested nodes (apply buttons, highlights), so the block with the longest
// text is the full card. Class names are obfuscated; the ones used here held
// across every page sampled on 2026-10-25, and parseHealth() reports when
// they stop matching so the run log says so instead of returning blanks.
// Real apply URLs are not in the anchors (those are /goto redirects); they
// sit in embedded JS as ["jobs_posting_urls", ...] next to
// ["jobs_encoded_docids", "<this job's docid>", ...].

import * as cheerio from 'cheerio';

const TYPE = /^(Full-time|Part-time|Contractor|Internship|Temp work|Per diem|Volunteer)$/i;
const isType = (t) => t.split(/,\s*(?:and\s+)?|\s+and\s+/).every((x) => TYPE.test(x.trim()));
const unesc = (s) => s.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&').replace(/\\u0027/g, "'").replace(/\\\//g, '/');

function applyUrlsByDocid(raw) {
    const map = new Map();
    const re = /\["jobs_posting_urls","([^"]*)"\],\["jobs_encoded_docids","([^"]*)"\]/g;
    for (const m of raw.matchAll(re)) {
        const urls = unesc(m[1]).split('\\n').map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u));
        const docid = unesc(m[2]).split('\\n').map((d) => d.trim()).filter(Boolean)[0];
        if (docid && urls.length && !map.has(docid)) map.set(docid, urls);
    }
    return map;
}

const cleanUrl = (u) => {
    try {
        const x = new URL(u);
        for (const k of [...x.searchParams.keys()]) if (/^utm_/.test(k)) x.searchParams.delete(k);
        return x.toString();
    } catch { return u; }
};

export function parseSalary(text) {
    if (!text) return null;
    const period = /hour/i.test(text) ? 'hour' : /day/i.test(text) ? 'day' : /week/i.test(text) ? 'week' : /month/i.test(text) ? 'month' : /year/i.test(text) ? 'year' : null;
    const nums = [...text.matchAll(/([\d.,]+)\s*([KkMm])?/g)]
        .map((m) => {
            const n = Number(m[1].replace(/,/g, ''));
            if (!Number.isFinite(n) || !m[1].match(/\d/)) return null;
            return m[2] ? n * (/k/i.test(m[2]) ? 1e3 : 1e6) : n;
        })
        .filter((n) => n != null && n > 0);
    if (!nums.length) return null;
    return { min: nums[0], max: nums[1] ?? nums[0], period, currency: /£/.test(text) ? 'GBP' : /€/.test(text) ? 'EUR' : /₹/.test(text) ? 'INR' : null, text };
}

export function postedAt(text, now = Date.now()) {
    const m = /(\d+)\+?\s*(minute|hour|day|week|month)s?\s+ago/i.exec(text || '');
    if (!m) return null;
    const unit = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[m[2].toLowerCase()];
    return new Date(now - Number(m[1]) * unit).toISOString();
}

export function parseJobsPage(raw, { query, now = Date.now() } = {}) {
    const urls = applyUrlsByDocid(raw);
    const $ = cheerio.load(raw);
    $('script,style,svg').remove();

    const best = new Map();
    $('div[data-encoded-docid]').each((_, el) => {
        const id = $(el).attr('data-encoded-docid');
        const len = $(el).text().length;
        if (!best.has(id) || len > best.get(id).len) best.set(id, { el, len });
    });

    const jobs = [];
    for (const [docid, { el }] of best) {
        const c = $(el);
        const txt = (x) => x.text().replace(/\s+/g, ' ').trim();
        const title = txt(c.find('div.IFnjPb').first()) || txt(c.find('[role="heading"]').first()) || null;
        if (!title) continue;
        // "Company · City, ST · via Source", as one span or several.
        const line = c.find('.wHYlTd').map((_, s) => txt($(s))).get().filter(Boolean).join(' · ');
        const segs = line.split(/\s*·\s*/).filter(Boolean);
        const viaSeg = segs.find((x) => /^via\s/i.test(x));
        const via = viaSeg ? viaSeg.replace(/^via\s+/i, '').trim() : null;
        const parts = segs.filter((x) => x !== viaSeg);

        let posted = null; let salaryText = null; let type = null; const tags = [];
        c.find('.gm8wac').each((_, g) => {
            const t = txt($(g));
            if (!t) return;
            if (/\bago$/i.test(t)) posted = t;
            else if (isType(t)) type = t;
            else if (/\d/.test(t) && /(year|month|week|day|hour)\b/i.test(t)) salaryText = t;
            else tags.push(t);
        });

        const highlights = {};
        c.find('h4').each((_, h) => {
            const key = txt($(h)).toLowerCase().replace(/\s+(.)/g, (_m, ch) => ch.toUpperCase());
            const items = $(h).parent().find('li').map((__, li) => txt($(li))).get().filter((t) => t && !/^\d+ more items?\(s\)$/i.test(t));
            if (key && items.length) highlights[key] = items;
        });

        const descHead = c.find('h2').filter((_, h) => /job description/i.test($(h).text())).first();
        let description = null;
        if (descHead.length) {
            const wrap = descHead.parent().clone();
            wrap.find('h2, [jsname="pqRzIf"]').remove();
            wrap.find('br').replaceWith('\n');
            description = wrap.text().replace(/Show full description|Report this listing/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() || null;
        }

        const sources = c.find('a[title^="Apply"]').map((_, a) => $(a).attr('title').replace(/^Apply (directly )?on\s+/i, '').trim()).get();
        const links = (urls.get(docid) || []).map(cleanUrl);
        const applyLinks = links.length
            ? links.map((u, i) => ({ source: sources[i] || null, url: u }))
            : sources.map((s) => ({ source: s, url: null }));

        jobs.push({
            jobId: docid,
            title,
            company: parts[0] || null,
            location: parts[1] || null,
            via,
            postedText: posted,
            postedAt: postedAt(posted, now),
            employmentType: type,
            salary: parseSalary(salaryText),
            tags,
            highlights,
            description,
            applyLinks,
            applyUrl: applyLinks.find((l) => l.url)?.url || null,
            googleJobsUrl: query ? `https://www.google.com/search?ibp=htl;jobs&q=${encodeURIComponent(query)}&htidocid=${encodeURIComponent(docid)}` : null,
        });
    }
    return jobs;
}

/** Docids on the page vs jobs parsed: a gap means the markup changed. */
export function parseHealth(raw, jobs) {
    const ids = new Set([...raw.matchAll(/data-encoded-docid="([^"]+)"/g)].map((m) => m[1]));
    return { docids: ids.size, parsed: jobs.length, withApplyUrl: jobs.filter((j) => j.applyUrl).length };
}

export function noJobsPage(raw) {
    return /aren(?:’|')t any ‘?Jobs’? matches|did not match any jobs/i.test(raw);
}
