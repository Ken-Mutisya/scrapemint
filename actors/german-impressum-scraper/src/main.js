// Impressum Scraper: the legal-notice page every German, Austrian and Swiss
// business website must publish (§ 5 DDG/TMG, § 5 ECG, Swiss UWG), parsed into
// company name, directors, address, phone, email, register and VAT ID.
//
// Strategy
// --------
// For each website: load the start page, pick the link whose text or URL
// says Impressum / Imprint / Legal notice / Anbieterkennzeichnung, and load
// it. One-page sites that carry the notice on the start page are read in
// place. If no link is found, common paths (/impressum, /imprint, ...) are
// tried. The page is reduced to text lines and the fields are read with
// label-based patterns (Geschäftsführer:, Registergericht:, USt-IdNr.: ...).
// Cloudflare-protected emails (data-cfemail) and "name [at] domain [dot] de"
// spellings are decoded. Pages in ISO-8859-1 / Windows-1252 are decoded by
// their declared charset.
// Sites that only render with JavaScript, or block datacenter traffic, come
// back with found=false and are not charged.
//
// No key, no proxy. Tested from Apify on 2026-10-25.
//
// Pay per event
// -------------
//   imprint ($0.002) one website whose Impressum yielded company data
// No start fee. Sites without a readable Impressum are free.

import { Actor, log } from 'apify';
import { toLines, findImpressumLink, LEGAL_MARKER, extract } from './extract.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const FALLBACK_PATHS = ['/impressum', '/impressum/', '/impressum.html', '/impressum.php', '/de/impressum', '/de/impressum/', '/imprint', '/imprint/', '/legal-notice', '/kontakt/impressum'];

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    websites = [],
    maxConcurrency = 8,
    requireEmail = false,
    maxResults = 1000,
} = input;

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,\s]+/)).map((x) => (typeof x === 'object' && x ? x.url : String(x)).trim()).filter(Boolean);
// An empty input (store health checks) runs the form's prefill.
const sites = [...new Set(list(websites).length ? list(websites) : ['https://www.heise.de'])].slice(0, Math.max(1, Number(maxResults) || 1000));
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const pastDeadline = () => timeoutAtMs && Date.now() > timeoutAtMs - 45_000;

// ---------- fetching ----------
function normalize(u) {
    let s = u.trim();
    if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
    try { return new URL(s).toString(); } catch { return null; }
}

async function fetchPage(url) {
    const r = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7' },
        redirect: 'follow',
        signal: AbortSignal.timeout(25_000),
    });
    const ct = r.headers.get('content-type') || '';
    if (ct && !/html|xml|text\/plain/i.test(ct)) return { status: r.status, url: r.url, html: '' };
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 4_000_000) return { status: r.status, url: r.url, html: '' };
    let cs = (ct.match(/charset=([\w-]+)/i) || [])[1];
    if (!cs) cs = (buf.subarray(0, 4000).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
    cs = (cs || 'utf-8').toLowerCase();
    let html;
    try { html = new TextDecoder(cs === 'iso-8859-1' || cs === 'latin1' ? 'windows-1252' : cs).decode(buf); } catch { html = buf.toString('utf8'); }
    return { status: r.status, url: r.url, html };
}

async function tryFetch(url) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const p = await fetchPage(url);
            if (p.status >= 500 && attempt === 0) continue;
            return p;
        } catch (err) {
            if (attempt === 1) return { status: 0, url, html: '', error: err.cause?.code || err.message };
        }
    }
    return { status: 0, url, html: '' };
}

// ---------- per site ----------
async function scrape(site) {
    const start = normalize(site);
    const base = { website: site, domain: null, found: false };
    if (!start) return { ...base, error: 'Not a valid URL' };
    const host = new URL(start).hostname.replace(/^www\./, '');
    base.domain = host;

    let page = await tryFetch(start);
    if (!page.html && /^https:/.test(start)) {
        const alt = await tryFetch(start.replace(/^https:/, 'http:'));
        if (alt.html) page = alt;
    }
    if (!page.html) return { ...base, error: page.error || `HTTP ${page.status || 'no response'}` };
    if (page.status >= 400) return { ...base, error: `HTTP ${page.status} (site blocks automated visits or page missing)` };

    let imp = null;
    const looksLikeImpressum = /impressum|imprint|legal/i.test(page.url) && LEGAL_MARKER.test(page.html);
    if (looksLikeImpressum) imp = page;
    else {
        const link = findImpressumLink(page.html, page.url);
        if (link) {
            const p = await tryFetch(link);
            if (p.html && p.status < 400) imp = p;
        }
        if (!imp && LEGAL_MARKER.test(page.html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')) && /Angaben gem|Registergericht|USt-?Id|Geschäftsführ/i.test(page.html)) imp = page;
        if (!imp) {
            const origin = new URL(page.url).origin;
            for (const p of FALLBACK_PATHS) {
                const r = await tryFetch(origin + p);
                if (r.html && r.status < 400 && LEGAL_MARKER.test(r.html)) { imp = r; break; }
            }
        }
    }
    if (!imp) return { ...base, error: 'No Impressum page found (the site may only render with JavaScript)' };

    const title = (imp.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const fields = extract(toLines(imp.html), imp.url, host, title);
    const found = !!(fields.companyName && (fields.street || fields.email || fields.phone || fields.registerNumber || fields.vatId));
    return {
        website: site,
        domain: host,
        found,
        companyName: fields.companyName || null,
        legalForm: fields.legalForm || null,
        managingDirectors: fields.managingDirectors,
        street: fields.street || null,
        postalCode: fields.postalCode || null,
        city: fields.city || null,
        country: fields.country || null,
        phone: fields.phone,
        fax: fields.fax,
        email: fields.email,
        emails: fields.emails,
        registerCourt: fields.registerCourt,
        registerNumber: fields.registerNumber,
        vatId: fields.vatId,
        taxNumber: fields.taxNumber,
        contentResponsible: fields.contentResponsible || null,
        profession: fields.profession,
        chamber: fields.chamber,
        impressumUrl: fields.impressumUrl,
        ...(found ? {} : { error: 'Impressum found but no company data could be read' }),
    };
}

// ---------- run ----------
let charged = 0;
let done = 0;
let stop = false;
const queue = [...sites];
const conc = Math.min(20, Math.max(1, Number(maxConcurrency) || 8));
log.info(`Reading the Impressum of ${sites.length} websites, ${conc} at a time.`);

async function worker() {
    while (queue.length && !stop && !pastDeadline()) {
        const site = queue.shift();
        let row;
        try { row = await scrape(site); } catch (err) { row = { website: site, found: false, error: err.message }; }
        const billable = row.found && (!requireEmail || row.email);
        if (requireEmail && row.found && !row.email) { row.found = false; row.error = 'No email in the Impressum'; }
        await Actor.pushData(billable ? row : { ...row, note: 'Not charged.' });
        done++;
        if (billable) {
            charged++;
            try {
                const r = await Actor.charge({ eventName: 'imprint' });
                if (r?.eventChargeLimitReached) { log.warning('Maximum cost per run reached; stopping.'); stop = true; }
            } catch (err) { log.warning(`charge failed (continuing): ${err?.message}`); }
        }
        if (done % 50 === 0) log.info(`${done}/${sites.length} sites, ${charged} with company data.`);
    }
}
await Promise.all(Array.from({ length: conc }, worker));

await Actor.setValue('SUMMARY', { websites: sites.length, processed: done, withCompanyData: charged });
log.info(`Done: ${done} sites, ${charged} with company data.`);
await Actor.exit();
