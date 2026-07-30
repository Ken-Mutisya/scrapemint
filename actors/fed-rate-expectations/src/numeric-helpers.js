/**
 * Null-safe numeric helpers. Copy into src/ when scaffolding a new actor.
 *
 * Actors are pushed to Apify as self-contained source directories, so a shared
 * import from outside the actor dir would not upload. This file is a template
 * to copy, not a module to import.
 *
 * The rule these enforce: absent and zero are different facts. `Number(null)`
 * is 0, so a bare cast turns "not measured" into a confident wrong number that
 * we then bill for. Every optional upstream metric goes through `num()`, and
 * anything a buyer might read as a measurement gets a companion `*Measured`
 * boolean so they can filter instead of guess.
 */

/** Number or null. Never 0-from-absent, never NaN. */
export function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** Rounded number or null. `dp` is decimal places. */
export function metric(v, dp = 2) {
    const n = num(v);
    return n === null ? null : +n.toFixed(dp);
}

/** True only when at least one of the underlying readings actually exists. */
export function measured(...values) {
    return values.some((v) => v !== null && v !== undefined && v !== '');
}

/**
 * Dense rank over rows, ties broken by a unique key.
 *
 * Ranking on a display field (provider name, company, title) collides whenever
 * the same entity appears twice, which happens more than it sounds: one company
 * often serves the same model at several prices. Pass a `uniqueKey` that is
 * genuinely unique per row (an id, an endpoint, a composite).
 */
export function rankBy(rows, valueFn, uniqueKey) {
    const ranked = rows
        .filter((r) => valueFn(r) !== null && valueFn(r) !== undefined)
        .sort((a, b) => {
            const d = valueFn(a) - valueFn(b);
            if (d !== 0) return d;
            return String(uniqueKey(a)).localeCompare(String(uniqueKey(b)));
        });
    const out = new Map();
    ranked.forEach((r, i) => out.set(uniqueKey(r), i + 1));
    return out;
}
