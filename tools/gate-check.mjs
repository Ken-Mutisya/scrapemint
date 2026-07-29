#!/usr/bin/env node
/**
 * gate-check.mjs — pre-publish static gate for Apify actors.
 *
 * Catches the classes of defect that silently cost money: a billed row that
 * looks valid but states a wrong fact, or a charge that never lands.
 *
 *   1. zero-coercion  Number(null) is 0, so an unsampled metric publishes as a
 *                     confident zero. Buyers cannot tell that apart from a
 *                     genuine zero, and we bill for it either way.
 *   2. rank-collision A rank derived from a non-unique sort key gives two rows
 *                     the same rank.
 *   3. missing-await  An un-awaited pushData/charge drops rows and revenue.
 *
 * Usage:
 *   node tools/gate-check.mjs actors/my-actor      # one actor, exit 1 on ERROR
 *   node tools/gate-check.mjs --all                # every actor under actors/
 *   node tools/gate-check.mjs --all --warn         # include WARN in output
 *
 * No dependencies. Regex-based on purpose: it must stay fast enough to run on
 * every build without anyone deciding to skip it.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

/* camelCase and snake_case have no word boundary mid-token, so `\bprovider\b`
 * never matches `providerName`. Split identifiers into words before testing. */
function words(s) {
    return s
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([a-zA-Z])(\d)/g, '$1 $2')
        .replace(/(\d)([a-zA-Z])/g, '$1 $2')
        .replace(/[_\-.]+/g, ' ')
        .toLowerCase();
}

function hasWord(s, list) {
    const w = ` ${words(s)} `;
    return list.some((t) => w.includes(` ${t} `) || new RegExp(`\\b${t}\\b`).test(w));
}

/* Output keys where 0 is a plausible-looking but wrong value. A count that is
 * legitimately 0 is fine; a *price* or *speed* of 0 is a false claim. */
const METRIC_WORDS = [
    'price', 'cost', 'fee', 'salary', 'amount', 'value', 'usd',
    'rate', 'yield', 'spread', 'apy', 'apr', 'pct', 'percent', 'ratio', 'change',
    'speed', 'latency', 'throughput', 'uptime', 'duration',
    'score', 'rating', 'rank', 'marketcap', 'tvl', 'volume', 'liquidity',
    'temp', 'distance', 'capacity', 'weight',
];

/* Constructs that prove the author handled absence. */
const NULL_SAFE = [
    '|| null', '||null', '?? null', '??null',
    '!= null', '!== null', '== null', '=== null',
    '!= undefined', '!== undefined',
    'Number.isFinite', 'isFinite(', '? ', // ternary handled more precisely below
];

/* Coercions that are safe-by-crash: they throw on null rather than yielding 0. */
const CRASHES_ON_NULL = ['.toFixed(', '.length', '.trim(', '.toUpperCase(', '.toLowerCase('];

const SORT_FN = /sort|compare|cmp|getter/i;
/* Sort keys that are not unique per row, so a rank built on them collides. */
const NON_UNIQUE_WORDS = [
    'name', 'title', 'label', 'provider', 'company', 'vendor',
    'author', 'owner', 'host', 'brand', 'group', 'category',
];

function enclosingFunctionName(lines, idx) {
    for (let i = idx; i >= 0 && i > idx - 400; i--) {
        const m = lines[i].match(/(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\())/);
        if (m) return m[1] || m[2] || '';
    }
    return '';
}

function stripComment(line) {
    const i = line.indexOf('//');
    return i === -1 ? line : line.slice(0, i);
}

function checkZeroCoercion(file, lines, findings) {
    lines.forEach((raw, i) => {
        const line = stripComment(raw);
        const t = line.trim();
        if (!t || t.startsWith('*') || t.startsWith('/*')) return;

        // Only object-literal properties: these are what end up in a billed row.
        const prop = t.match(/^([A-Za-z_$][\w$]*)\s*:\s*(.+?),?$/);
        if (!prop) return;
        const [, key, value] = prop;
        if (!hasWord(key, METRIC_WORDS)) return;

        // Already handled absence explicitly.
        if (NULL_SAFE.some((s) => s !== '? ' && value.includes(s))) return;
        // Ternary that yields null on the absent branch.
        if (/\?[\s\S]*:\s*null/.test(value)) return;
        if (CRASHES_ON_NULL.some((s) => value.includes(s))) return;

        const fn = enclosingFunctionName(lines, i);
        if (SORT_FN.test(fn)) return; // comparator: a missing value only affects order

        // Summing with `|| 0` is correct: a missing addend contributes nothing.
        if (/\.reduce\s*\(/.test(value)) return;

        const cast = value.match(/\b(Number|parseFloat|parseInt)\s*\(([^)]*)/);
        const orZero = /\|\|\s*0\b/.test(value);

        // A bare identifier is almost always an actor input, not upstream data.
        const castsUpstreamField = cast && /[.[]/.test(cast[2]);
        if (!castsUpstreamField && !(orZero && /[.[]/.test(value))) return;

        /* A *named* field (e.throughput_last_30m, t.price) carries meaning, so
         * absent means unknown and 0 is a false claim. A *positional* access
         * (m[2], p[3]) is a regex group or CSV column, where a 0 default is
         * usually the deliberate parse behaviour. Flag both, block only the
         * first. */
        const named = /\.[A-Za-z_$][\w$]*/.test(cast ? cast[2] : value);

        findings.push({
            level: named ? 'ERROR' : 'WARN',
            rule: 'zero-coercion',
            file,
            line: i + 1,
            text: t.slice(0, 110),
            why: orZero
                ? `"${key}" falls back to 0 when the upstream value is absent`
                : `${cast[1]}(null) is 0, so "${key}" publishes 0 for an unsampled value`,
        });
    });
}

function checkRankCollision(file, lines, findings) {
    lines.forEach((raw, i) => {
        const line = stripComment(raw);
        if (!/\brank\b/i.test(line)) return;
        if (!/=|:/.test(line)) return;

        // Look for the sort that feeds this rank.
        const window = lines.slice(Math.max(0, i - 12), i + 12).join('\n');
        if (!/\.sort\s*\(/.test(window)) return;
        const sortLine = window.match(/\.sort\s*\([^\n]*/);
        if (!sortLine) return;
        if (!hasWord(sortLine[0], NON_UNIQUE_WORDS)) return;
        // A tie-break on a second field makes the key unique enough.
        if (/\|\||&&|localeCompare[^\n]*\)\s*\|\|/.test(sortLine[0]) && /,/.test(sortLine[0])) return;

        findings.push({
            level: 'WARN',
            rule: 'rank-collision',
            file,
            line: i + 1,
            text: stripComment(raw).trim().slice(0, 110),
            why: `rank derived from a sort on a non-unique key (${sortLine[0].trim().slice(0, 60)}); two rows can share a rank`,
        });
    });
}

function checkMissingAwait(file, lines, findings) {
    lines.forEach((raw, i) => {
        const line = stripComment(raw);
        const t = line.trim();
        const m = t.match(/(?:Actor|actor)\.(pushData|charge)\s*\(|\.(charge)\s*\(/);
        if (!m) return;
        if (/\b(await|return|yield)\b/.test(t)) return;
        if (/^(const|let|var)\s|=\s*(?!=)/.test(t)) return; // assigned, likely awaited later
        if (/\.(then|catch)\s*\(/.test(t)) return;
        if (/function|=>/.test(t) && !/\(\s*\)/.test(t)) return; // a definition, not a call

        findings.push({
            level: 'ERROR',
            rule: 'missing-await',
            file,
            line: i + 1,
            text: t.slice(0, 110),
            why: 'un-awaited pushData/charge silently drops rows and revenue',
        });
    });
}

function scanActor(dir) {
    const srcDir = join(dir, 'src');
    if (!existsSync(srcDir)) return [];
    const findings = [];
    for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))) {
        const path = join(srcDir, f);
        const lines = readFileSync(path, 'utf8').split('\n');
        const rel = `${basename(dir)}/src/${f}`;
        checkZeroCoercion(rel, lines, findings);
        checkRankCollision(rel, lines, findings);
        checkMissingAwait(rel, lines, findings);
    }
    return findings;
}

/* ------------------------------- main ------------------------------- */

const args = process.argv.slice(2);
const showWarn = args.includes('--warn');
const all = args.includes('--all');
const targets = args.filter((a) => !a.startsWith('--'));

let dirs;
if (all) {
    dirs = readdirSync('actors')
        .map((d) => join('actors', d))
        .filter((d) => statSync(d).isDirectory());
} else if (targets.length) {
    dirs = targets;
} else {
    console.error('usage: node tools/gate-check.mjs <actor-dir>... | --all [--warn]');
    process.exit(2);
}

let errors = 0;
let warns = 0;
const byActor = new Map();

for (const d of dirs) {
    const f = scanActor(d);
    if (f.length) byActor.set(basename(d), f);
    errors += f.filter((x) => x.level === 'ERROR').length;
    warns += f.filter((x) => x.level === 'WARN').length;
}

for (const [actor, findings] of byActor) {
    const shown = findings.filter((f) => showWarn || f.level === 'ERROR');
    if (!shown.length) continue;
    console.log(`\n${actor}`);
    for (const f of shown) {
        console.log(`  ${f.level.padEnd(5)} ${f.rule.padEnd(15)} ${f.file}:${f.line}`);
        console.log(`        ${f.text}`);
        console.log(`        -> ${f.why}`);
    }
}

const scanned = dirs.length;
console.log(
    `\nscanned ${scanned} actor${scanned === 1 ? '' : 's'}: ` +
    `${errors} error${errors === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}` +
    `${warns && !showWarn ? ' (re-run with --warn to see warnings)' : ''}`,
);

process.exit(errors > 0 ? 1 : 0);
