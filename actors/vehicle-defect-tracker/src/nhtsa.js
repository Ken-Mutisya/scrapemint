// Shaping helpers for NHTSA defect data.
//
// Split out of main.js because three of these decide whether the numbers are
// real. NHTSA's complaint and recall endpoints disagree with each other about
// model names and about date order, and the complaint endpoint returns the same
// complaint under several model names.

/**
 * Complaint dates are MM/DD/YYYY. Recall dates are DD/MM/YYYY. Same API.
 *
 * Verified against live data: across one model year the first segment of
 * `dateOfIncident` tops out at 12 and the second at 31, while the first segment
 * of a recall's `ReportReceivedDate` reaches 28 and the second stops at 12.
 *
 * This matters more than a format quirk. `new Date('17/12/2020')` is Invalid
 * Date, which is at least loud, but `new Date('10/11/2021')` parses happily as
 * 11 October when the recall means 10 November. A month-shifted recall date
 * silently corrupts any before/after comparison against complaints.
 */
/* A complaint with no recorded incident date comes back as the Unix epoch
 * rather than as empty. It is rare, roughly 1 in 700, but it lands in the
 * earliest slot of every aggregate it touches and makes a component look like
 * it has been failing since 1969. Treated as absent, which is what it means. */
const EPOCH_SENTINELS = new Set(['1969-12-31', '1970-01-01']);

export function parseDate(raw, order) {
    const s = String(raw ?? '').trim();
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) {
        /* Some fields already arrive ISO; anything else is not a date we can
         * stand behind, so it becomes null rather than a guess. */
        const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!iso) return null;
        return EPOCH_SENTINELS.has(iso[0]) ? null : iso[0];
    }
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = Number(m[3]);
    const month = order === 'DMY' ? b : a;
    const day = order === 'DMY' ? a : b;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const pad = (n) => String(n).padStart(2, '0');
    const out = `${year}-${pad(month)}-${pad(day)}`;
    return EPOCH_SENTINELS.has(out) ? null : out;
}

export const parseComplaintDate = (v) => parseDate(v, 'MDY');
export const parseRecallDate = (v) => parseDate(v, 'DMY');

/** Whole days between two ISO dates, or null when either is missing. */
export function daysBetween(fromIso, toIso) {
    if (!fromIso || !toIso) return null;
    const a = Date.parse(`${fromIso}T00:00:00Z`);
    const b = Date.parse(`${toIso}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.round((b - a) / 86400000);
}

/**
 * Model names that cover a requested model on a given endpoint.
 *
 * NHTSA splits some models into body-style entries, and the two endpoints
 * disagree about which name is valid. For a 2021 Ford F-150 the complaint
 * endpoint rejects "F-150" with HTTP 400 but serves "F-150 SUPER CREW"; the
 * recall endpoint does the opposite. So the caller's name is tried first and
 * the variants are only used when it is refused.
 *
 * The list itself repeats names, so it is deduped before use.
 */
export function variantsFor(models, model) {
    const want = String(model ?? '').trim().toUpperCase();
    if (!want) return [];
    const seen = new Set();
    const out = [];
    for (const raw of models) {
        const name = String(raw ?? '').trim().toUpperCase();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        if (name === want || name.startsWith(`${want} `)) out.push(name);
    }
    return out;
}

/**
 * Complaints keyed by ODI number.
 *
 * A complaint is filed against a vehicle, not a body style, so NHTSA returns
 * the same ODI number under every variant it applies to. For a 2021 F-150 the
 * six variants return 5,026 rows covering 1,202 distinct complaints: 956 of
 * them appear five times each. Adding the per-variant counts, which is the
 * obvious way to combine them, overstates the real figure by roughly four
 * times. Deduping on the ODI number is the only way to get a number that means
 * anything.
 */
export function dedupeComplaints(batches) {
    const byOdi = new Map();
    for (const { model, results } of batches) {
        for (const c of results) {
            const odi = c?.odiNumber;
            if (odi === null || odi === undefined) continue;
            const existing = byOdi.get(odi);
            if (existing) {
                if (!existing.variants.includes(model)) existing.variants.push(model);
            } else {
                byOdi.set(odi, { complaint: c, variants: [model] });
            }
        }
    }
    return [...byOdi.values()];
}

/**
 * Complaint components arrive as a comma-separated string; recall components
 * arrive as a colon-delimited hierarchy ("POWER TRAIN:DRIVELINE:DRIVESHAFT").
 * The top level is the only shared vocabulary, so that is what the two sides
 * are matched on.
 */
export function splitComplaintComponents(raw) {
    return String(raw ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
}

export function topLevelComponent(raw) {
    const s = String(raw ?? '').trim().toUpperCase();
    if (!s) return null;
    return s.split(':')[0].trim() || null;
}

/**
 * Severity of one complaint, worst first.
 *
 * These counts are genuinely zero rather than absent when nothing happened --
 * NHTSA returns an integer on every complaint -- so `none` is a real finding,
 * not a gap in the data.
 */
export function severityOf(c) {
    const deaths = intOrNull(c?.numberOfDeaths);
    const injuries = intOrNull(c?.numberOfInjuries);
    if (deaths !== null && deaths > 0) return 'fatal';
    if (injuries !== null && injuries > 0) return 'injury';
    if (c?.fire === true) return 'fire';
    if (c?.crash === true) return 'crash';
    return 'none';
}

const SEVERITY_RANK = { fatal: 4, injury: 3, fire: 2, crash: 1, none: 0 };
export function meetsSeverity(severity, minimum) {
    if (!minimum || minimum === 'all') return true;
    const floor = minimum === 'injuryOrDeath' ? 3 : minimum === 'crashOrFire' ? 1 : 0;
    return (SEVERITY_RANK[severity] ?? 0) >= floor;
}

export function intOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : (Number.isFinite(n) ? Math.round(n) : null);
}

/**
 * Roll complaints up per component, and mark the components that owners keep
 * reporting while no recall covers them.
 *
 * That gap is the whole point of joining the two endpoints. A component with
 * many complaints and a matching recall is a known, handled problem; the same
 * component with no recall is the thing a safety researcher or a plaintiff
 * firm is looking for.
 */
export function componentTrends(rows, recalls) {
    const recallByComponent = new Map();
    for (const r of recalls) {
        const top = topLevelComponent(r.component);
        if (!top) continue;
        if (!recallByComponent.has(top)) recallByComponent.set(top, []);
        recallByComponent.get(top).push(r);
    }

    const acc = new Map();
    for (const row of rows) {
        for (const comp of (row.components ?? [])) {
            if (!acc.has(comp)) {
                acc.set(comp, {
                    component: comp,
                    complaintCount: 0,
                    crashCount: 0,
                    fireCount: 0,
                    injuryComplaintCount: 0,
                    deathComplaintCount: 0,
                    totalInjuries: 0,
                    totalDeaths: 0,
                    incidentDates: [],
                });
            }
            const a = acc.get(comp);
            a.complaintCount += 1;
            if (row.crash === true) a.crashCount += 1;
            if (row.fire === true) a.fireCount += 1;
            if ((row.numberOfInjuries ?? 0) > 0) a.injuryComplaintCount += 1;
            if ((row.numberOfDeaths ?? 0) > 0) a.deathComplaintCount += 1;
            a.totalInjuries += row.numberOfInjuries ?? 0;
            a.totalDeaths += row.numberOfDeaths ?? 0;
            if (row.dateOfIncident) a.incidentDates.push(row.dateOfIncident);
        }
    }

    return [...acc.values()]
        .map((a) => {
            const dates = a.incidentDates.sort();
            const matching = recallByComponent.get(a.component) ?? [];
            const { incidentDates, ...rest } = a;
            return {
                ...rest,
                firstIncidentDate: dates.length ? dates[0] : null,
                latestIncidentDate: dates.length ? dates[dates.length - 1] : null,
                datedComplaintCount: dates.length,
                hasMatchingRecall: matching.length > 0,
                matchingRecallCampaigns: matching.length
                    ? matching.map((r) => r.campaignNumber).filter(Boolean) : null,
                matchingRecallComponents: matching.length
                    ? [...new Set(matching.map((r) => r.component).filter(Boolean))] : null,
                /* Complaints with no recall on that component. Not proof of a
                 * defect and not a prediction that a recall is coming, just the
                 * gap worth a human looking at. */
                unaddressedByRecall: matching.length === 0,
            };
        })
        .sort((x, y) => y.complaintCount - x.complaintCount);
}
