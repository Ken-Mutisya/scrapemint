// One reader per state. Each returns notices in the same shape:
//   { company, city, county, address, noticeDate, receivedDate, effectiveDate,
//     employees, type, permanent, industry, reason, noticeUrl }
// Dates are ISO (YYYY-MM-DD). Every source was checked on 2026-10-01 to answer
// a plain request with no key, login or proxy. States whose only publication
// is a dashboard (New York's Tableau, Illinois) or that refuse automated
// requests (Florida, Arizona, Michigan, Utah, Kansas) are not included.

import XLSX from 'xlsx';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

async function fetchRaw(url, init = {}) {
    const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': UA, Accept: '*/*', ...(init.headers || {}) },
        redirect: 'follow',
        signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res;
}
const text = async (url, init) => (await fetchRaw(url, init)).text();

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: '-', mdash: '-', eacute: 'é' };
export function clean(s) {
    return String(s ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
            if (e[0] === '#') return String.fromCharCode(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
            return ENT[e.toLowerCase()] ?? m;
        })
        .replace(/\s+/g, ' ')
        .trim();
}

export function isoDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
    if (m) {
        const y = m[3].length === 2 ? `20${m[3]}` : m[3];
        return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    }
    return null;
}

const num = (v) => { const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) && String(v ?? '').match(/\d/) ? Math.round(n) : null; };

function classify(raw) {
    const s = String(raw || '').toLowerCase();
    return {
        type: /clos/.test(s) ? 'Closure' : /relocat/.test(s) ? 'Relocation' : /layoff|reduction|mass/.test(s) ? 'Layoff' : null,
        permanent: /temporar/.test(s) ? false : /permanent|no recall/.test(s) ? true : null,
    };
}

function tableRows(html, tableRe = /<table[\s\S]*?<\/table>/i) {
    const tb = html.match(tableRe);
    if (!tb) return [];
    return [...tb[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((tr) => [...tr[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1]));
}

export function parseCsv(s) {
    const rows = [];
    let row = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < s.length; i += 1) {
        const c = s[i];
        if (q) {
            if (c === '"' && s[i + 1] === '"') { cur += '"'; i += 1; } else if (c === '"') q = false; else cur += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') {
            if (c === '\r' && s[i + 1] === '\n') i += 1;
            row.push(cur); rows.push(row); row = []; cur = '';
        } else cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows;
}

function byHeader(rows, want) {
    const hi = rows.findIndex((r) => want.every((w) => r.some((c) => clean(c).toLowerCase().replace(/\s+/g, ' ').includes(w))));
    if (hi < 0) throw new Error(`header not found (${want.join(', ')})`);
    const head = rows[hi].map((c) => clean(c).toLowerCase().replace(/\s+/g, ' '));
    const col = (name) => head.findIndex((h) => h.includes(name));
    return { body: rows.slice(hi + 1), col };
}

// ---------- California: EDD's fiscal-year spreadsheet, updated twice a week ----------
async function california() {
    const src = 'https://edd.ca.gov/siteassets/files/jobs_and_training/warn/warn_report1.xlsx';
    const wb = XLSX.read(Buffer.from(await (await fetchRaw(src)).arrayBuffer()), { cellDates: true });
    const sheet = wb.SheetNames.find((n) => /detailed warn/i.test(n));
    if (!sheet) throw new Error('Detailed WARN Report sheet missing');
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: false, dateNF: 'yyyy-mm-dd' });
    const { body, col } = byHeader(rows, ['company', 'notice']);
    const c = { county: col('county'), notice: col('notice'), rec: col('processed'), eff: col('effective'), co: col('company'), type: col('layoff'), emp: col('employees'), addr: col('address'), ind: col('industry') };
    return body.filter((r) => clean(r[c.co])).map((r) => {
        const k = classify(r[c.type]);
        const addr = clean(r[c.addr]);
        return {
            company: clean(r[c.co]), city: (addr.match(/\s{1,}([A-Za-z .'-]+?)\s+CA\s+\d{5}/) || [])[1]?.trim() || null,
            county: clean(r[c.county]).replace(/ County$/, '') || null, address: addr || null,
            noticeDate: isoDate(r[c.notice]), receivedDate: isoDate(r[c.rec]), effectiveDate: isoDate(r[c.eff]),
            employees: num(r[c.emp]), ...k, industry: c.ind >= 0 ? clean(r[c.ind]).replace(/^[\d-]+\s+/, '') || null : null,
            reason: null, rawType: clean(r[c.type]) || null, noticeUrl: null, source: src,
        };
    });
}

// ---------- Texas: TWC's WARN dataset on data.texas.gov ----------
async function texas(sinceIso) {
    const src = 'https://data.texas.gov/resource/8w53-c4f6.json';
    const q = `?$limit=5000&$order=notice_date%20DESC&$where=notice_date%20%3E%3D%20'${sinceIso}T00:00:00'`;
    const rows = JSON.parse(await text(src + q));
    return rows.map((r) => ({
        company: clean(r.job_site_name), city: clean(r.city_name) || null, county: clean(r.county_name) || null, address: null,
        noticeDate: isoDate(r.notice_date), receivedDate: isoDate(r.wfdd_received_date), effectiveDate: isoDate(r.layoff_date),
        employees: num(r.total_layoff_number), type: null, permanent: null, industry: null, reason: null, rawType: null,
        noticeUrl: null, source: 'https://data.texas.gov/d/8w53-c4f6',
    }));
}

// ---------- Washington: ESD's WARN database, newest first, ASP.NET paging ----------
async function washington(sinceIso) {
    const url = 'https://fortress.wa.gov/esd/file/WARN/Public/SearchWARN.aspx';
    let cookie = '';
    let html = '';
    const out = [];
    for (let page = 1; page <= 40; page += 1) {
        let res;
        if (page === 1) res = await fetchRaw(url);
        else {
            const fields = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" id="[^"]*" value="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]));
            res = await fetchRaw(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
                body: new URLSearchParams({ ...fields, __EVENTTARGET: 'ucPSW$gvMain', __EVENTARGUMENT: `Page$${page}` }).toString(),
            });
        }
        cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ') || cookie;
        html = await res.text();
        const grid = html.split('id="ucPSW_gvMain"')[1] || '';
        const rows = [...grid.matchAll(/<tr>\s*<td>([\s\S]*?)<\/tr>/g)].map((m) => `<td>${m[1]}`)
            .map((tr) => ({ cells: [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]), link: (tr.match(/href='([^']+)'/) || [])[1] }))
            .filter((r) => r.cells.length >= 7 && isoDate(clean(r.cells[6])));
        if (!rows.length) break;
        let older = false;
        for (const { cells, link } of rows) {
            const received = isoDate(clean(cells[6]));
            if (received < sinceIso) { older = true; continue; }
            const k = classify(`${clean(cells[4])} ${clean(cells[5])}`);
            out.push({
                company: clean(cells[0]), city: clean(cells[1]) || null, county: null, address: null,
                noticeDate: received, receivedDate: received, effectiveDate: isoDate(clean(cells[2])),
                employees: num(cells[3]), ...k, industry: null, reason: null, rawType: `${clean(cells[4])} ${clean(cells[5])}`.trim(),
                noticeUrl: link ? `https://fortress.wa.gov${link.replace(/&amp;/g, '&')}` : null, source: url,
            });
        }
        if (older) break;
    }
    return out;
}

// ---------- Virginia: Virginia Works publishes the list as a CSV ----------
async function virginia() {
    const page = 'https://virginiaworks.gov/warn-notices/';
    const html = await text(page);
    const csvPath = (html.match(/href="([^"]*warn_notices_\d+\.csv)"/) || [])[1];
    if (!csvPath) throw new Error('CSV link not found');
    const rows = parseCsv(await text(new URL(csvPath, page).href));
    const { body, col } = byHeader(rows, ['company', 'notice date']);
    const c = { co: col('company'), notice: col('notice date'), eff: col('impact'), emp: col('employees'), loc: col('location'), type: col('notice type') };
    return body.filter((r) => clean(r[c.co])).map((r) => {
        const loc = clean(r[c.loc]);
        return {
            company: clean(r[c.co]), city: loc.replace(/,?\s*VA\s*$/i, '') || null, county: null, address: null,
            noticeDate: isoDate(r[c.notice]), receivedDate: null, effectiveDate: isoDate(r[c.eff]),
            employees: num(r[c.emp]), ...classify(r[c.type]), industry: null, reason: null, rawType: clean(r[c.type]) || null,
            noticeUrl: null, source: page,
        };
    });
}

// ---------- Colorado: CDLE's "Real-Time" Google Sheet for the current year ----------
async function colorado() {
    const page = 'https://cdle.colorado.gov/employers/layoff-separations/layoff-warn-list';
    const html = await text(page);
    const links = [...html.matchAll(/<a[^>]+href="(https:\/\/docs\.google\.com\/spreadsheets\/d\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: m[1], label: clean(m[2]) }));
    const cur = links.find((l) => /real-?time/i.test(l.label)) || links.find((l) => l.label.includes(String(new Date().getUTCFullYear())));
    if (!cur) throw new Error('current-year sheet link not found');
    const id = cur.href.match(/\/d\/([^/]+)/)[1];
    const gid = (cur.href.match(/gid=(\d+)/) || [])[1];
    const rows = parseCsv(await text(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`));
    const { body, col } = byHeader(rows, ['company', 'warn date']);
    const c = { co: col('company'), notice: col('warn date'), rec: col('received'), co_emp: col('co notifications'), tot: col('total notified'), naics: col('naics'), area: col('workforce area'), perm: col('# permanent'), temp: col('#temp'), begin: col('begin date'), reason: col('reason') };
    return body.filter((r) => clean(r[c.co]) && isoDate(clean(r[c.notice]))).map((r) => {
        const reason = clean(r[c.reason]);
        const perm = num(r[c.perm]);
        const temp = num(r[c.temp]);
        return {
            company: clean(r[c.co]), city: null, county: clean(r[c.area]) || null, address: null,
            noticeDate: isoDate(clean(r[c.notice])), receivedDate: isoDate(clean(r[c.rec])), effectiveDate: isoDate(clean(r[c.begin])),
            employees: num(r[c.co_emp]) ?? num(r[c.tot]),
            type: /clos/i.test(reason) ? 'Closure' : 'Layoff', permanent: perm && !temp ? true : temp && !perm ? false : null,
            industry: clean(r[c.naics]).replace(/^[\d,:\s]+/, '') || null, reason: reason || null, rawType: reason || null,
            noticeUrl: null, source: page,
        };
    });
}

// ---------- Maryland: an HTML table on the Labor department's WARN page ----------
async function maryland() {
    const page = 'https://www.dllr.state.md.us/employment/warn.shtml';
    const rows = tableRows(await text(page));
    const { body, col } = byHeader(rows, ['notice date', 'company']);
    const c = { notice: col('notice date'), naics: col('naics'), co: col('company'), loc: col('location'), area: col('local area'), emp: col('total'), eff: col('effective'), type: col('type') };
    return body.filter((r) => clean(r[c.co])).map((r) => {
        const loc = clean(r[c.loc]);
        return {
            company: clean(r[c.co]), city: (loc.match(/([A-Za-z .'-]+),?\s+MD\s+\d{5}/) || [])[1]?.trim().split(/\s{2,}/).pop() || null,
            county: clean(r[c.area]) || null, address: loc || null,
            noticeDate: isoDate(clean(r[c.notice])), receivedDate: null, effectiveDate: isoDate(clean(r[c.eff])),
            employees: num(r[c.emp]), ...classify(r[c.type]), industry: null, reason: null, rawType: clean(r[c.type]) || null,
            noticeUrl: null, source: page,
        };
    });
}

// ---------- Tennessee: the current year's table on TDLWD's reports page ----------
async function tennessee() {
    const page = 'https://www.tn.gov/workforce/general-resources/major-publications0/major-publications-redirect/reports.html';
    const rows = tableRows(await text(page)); // first table is the current year
    const { body, col } = byHeader(rows, ['date of posting', 'company']);
    const c = { posted: col('date of posting'), co: col('company'), county: col('county'), emp: col('affected'), eff: col('closure/layoff'), no: col('notice') };
    return body.filter((r) => clean(r[c.co])).map((r) => {
        const link = (String(r[c.no] || r[c.co] || '').match(/href="([^"]+)"/) || [])[1];
        return {
            company: clean(r[c.co]), city: null, county: clean(r[c.county]) || null, address: null,
            noticeDate: isoDate(clean(r[c.posted])), receivedDate: null, effectiveDate: isoDate(clean(r[c.eff])),
            employees: num(r[c.emp]), type: null, permanent: null, industry: null, reason: null, rawType: null,
            noticeUrl: link ? new URL(link, page).href : null, source: page,
        };
    });
}

export const STATES = {
    CA: { name: 'California', read: california },
    TX: { name: 'Texas', read: texas, lagNote: 'Texas publishes its WARN data with a delay of up to several months.' },
    WA: { name: 'Washington', read: washington },
    VA: { name: 'Virginia', read: virginia },
    CO: { name: 'Colorado', read: colorado },
    MD: { name: 'Maryland', read: maryland },
    TN: { name: 'Tennessee', read: tennessee },
};
