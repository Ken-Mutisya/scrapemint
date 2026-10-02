// https://{tenant}.wd5.myworkdayjobs.com/en-US/{site}/job/...  -> {host, tenant, site}
// https://wd3.myworkdaysite.com/recruiting/{tenant}/{site}/... -> same
export function parseWorkdayUrl(raw) {
    let u;
    try { u = new URL(raw); } catch { return null; }
    const host = u.hostname.toLowerCase();
    const segs = u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
    const isLocale = (s) => /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(s);
    if (/\.myworkdayjobs\.com$/.test(host) && host.split('.').length === 4) {
        const tenant = host.split('.')[0];
        const rest = segs.filter((s, i) => !(i === 0 && isLocale(s)));
        const site = rest[0];
        if (!site || /^(wday|job|details)$/i.test(site)) return null;
        return { host, tenant, site };
    }
    if (/^wd\d+\.myworkdaysite\.com$/.test(host) && segs[0] === 'recruiting' && segs[1] && segs[2]) {
        return { host, tenant: segs[1].toLowerCase(), site: segs[2] };
    }
    return null;
}
