// Parse a House Periodic Transaction Report (PTR) PDF into transactions.
//
// E-filed PTRs are generated from one template: a table whose columns sit at
// fixed x positions (ID, Owner, Asset, Transaction type, Date, Notification
// date, Amount, Cap. gains). An asset name and an amount range can wrap onto
// the following lines, and each transaction is followed by labelled detail
// lines (Filing status, Subholding of, Description, Comments). The template's
// label font has no text mapping for most glyphs, so a label reads as
// "F\0\0\0 S\0\0 :" -- the first letter survives and identifies it.
//
// Handwritten paper filings are scanned images with no text layer; they come
// back as { scanned: true } rather than a guess.

import { getDocumentProxy } from 'unpdf';

const COL = {
    owner: [50, 95],
    asset: [95, 255],
    type: [255, 320],
    date: [320, 375],
    notified: [375, 430],
    amount: [430, 515],
};
const inCol = (x, [a, b]) => x >= a && x < b;
const DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const TYPE = /^(P|S|S \(partial\)|E)$/;
const LABELS = { F: 'filingStatus', S: 'subholdingOf', D: 'description', C: 'comments', L: 'location' };

export async function parsePtr(bytes) {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p += 1) {
        const page = await pdf.getPage(p);
        const { items } = await page.getTextContent();
        const byY = new Map();
        for (const it of items) {
            if (!it.str || !it.str.trim()) continue;
            const y = Math.round(it.transform[5]);
            // Items a point apart belong to the same visual line.
            const key = [...byY.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
            if (!byY.has(key)) byY.set(key, []);
            byY.get(key).push({ x: Math.round(it.transform[4]), s: it.str });
        }
        for (const y of [...byY.keys()].sort((a, b) => b - a)) {
            lines.push(byY.get(y).sort((a, b) => a.x - b.x));
        }
    }
    const allText = lines.map((l) => l.map((c) => c.s).join(' ')).join('\n');
    if (!allText.trim()) return { scanned: true, header: {}, transactions: [] };

    const header = {
        name: matchAfter(lines, /^Name:$/),
        status: matchAfter(lines, /^Status:$/),
        stateDistrict: matchAfter(lines, /^State\/District:$/),
    };

    const txs = [];
    let cur = null;
    let mode = 'none'; // what an unlabelled continuation line belongs to
    for (const cells of lines) {
        const first = cells[0];
        const firstText = clean(first.s);
        // Column header row and filing-ID line repeat on each page. Skip them
        // without resetting mode: an asset name or amount can wrap across the
        // page break and continue under the next page's header.
        if (cells.some((c) => c.s === 'Owner') && cells.some((c) => c.s === 'Asset')) continue;
        if (/^Filing ID #/.test(firstText)) continue;
        if (cells.every((c) => ['Type', 'Date', 'Gains >', '$200?'].includes(c.s.trim()))) continue;

        const typeCell = cells.find((c) => inCol(c.x, COL.type) && TYPE.test(c.s.trim()));
        const dateCell = cells.find((c) => inCol(c.x, COL.date) && DATE.test(c.s.trim()));
        if (typeCell && dateCell) {
            cur = {
                owner: cells.filter((c) => inCol(c.x, COL.owner)).map((c) => c.s.trim()).join(' ') || null,
                asset: cells.filter((c) => inCol(c.x, COL.asset)).map((c) => c.s.trim()).join(' '),
                type: typeCell.s.trim(),
                date: dateCell.s.trim(),
                notified: cells.find((c) => inCol(c.x, COL.notified) && DATE.test(c.s.trim()))?.s.trim() || null,
                amount: cells.filter((c) => inCol(c.x, COL.amount)).map((c) => c.s.trim()).join(' '),
            };
            txs.push(cur);
            mode = 'asset';
            continue;
        }
        if (!cur) continue;

        // A labelled detail line: "F S : New", "S O : Brokerage", "D : ...".
        if (/\0/.test(first.s) || /^[A-Z]\s{2,}.*:/.test(first.s)) {
            const field = LABELS[firstText[0]];
            const value = clean(first.s.slice(first.s.indexOf(':') + 1)) || cells.slice(1).map((c) => clean(c.s)).join(' ');
            if (field) { cur[field] = [cur[field], value].filter(Boolean).join(' ') || null; mode = field === 'description' || field === 'comments' ? field : 'none'; }
            else mode = 'none';
            continue;
        }
        // Any other text at the left margin ends the table (certification,
        // investment vehicle details, footnotes).
        if (first.x < 50) { mode = 'none'; cur = null; continue; }

        for (const c of cells) {
            if (mode === 'asset' && inCol(c.x, COL.asset)) cur.asset = `${cur.asset} ${c.s.trim()}`.trim();
            else if (mode === 'asset' && inCol(c.x, COL.amount) && /-\s*$|^\s*\$/.test(`${cur.amount}|${c.s}`)) cur.amount = `${cur.amount} ${c.s.trim()}`.trim();
            else if ((mode === 'description' || mode === 'comments') && inCol(c.x, [95, 600])) cur[mode] = `${cur[mode] || ''} ${clean(c.s)}`.trim();
        }
    }
    return { scanned: false, header, transactions: txs.map(normalise) };
}

function matchAfter(lines, re) {
    for (const cells of lines) {
        const i = cells.findIndex((c) => re.test(c.s.trim()));
        if (i >= 0 && cells[i + 1]) return cells[i + 1].s.trim();
    }
    return null;
}

const clean = (s) => String(s || '').replace(/\0/g, '').replace(/\s+/g, ' ').trim();

const OWNER = { SP: 'Spouse', JT: 'Joint', DC: 'Dependent child' };
const TYPE_NAME = { P: 'Purchase', S: 'Sale', 'S (partial)': 'Partial sale', E: 'Exchange' };
export const ASSET_TYPES = {
    ST: 'Stock', OP: 'Stock option', GS: 'Government security', MF: 'Mutual fund', EF: 'Exchange traded fund',
    CS: 'Corporate bond', OT: 'Other', HN: 'Hedge fund / private equity', CT: 'Cryptocurrency', PS: 'Private stock',
    RS: 'Restricted stock', SA: 'Stock appreciation right', AB: 'Asset-backed security', FN: 'Futures', OI: 'Ownership interest',
    PE: 'Private equity', RE: 'Real estate', BA: 'Bank account', DB: 'Defined benefit plan', IH: 'IRA', ET: 'Exchange traded note',
    WU: 'Whole life insurance', VA: 'Variable annuity', FA: 'Fixed annuity', DO: 'Debts owed', EQ: 'Equity index-linked note',
    IR: 'Interest rate swap', MA: 'Managed account', PM: 'Precious metals', TR: 'Trust', CO: 'Collectible', OL: 'Operating LLC',
    DS: 'Deferred stock', CE: 'Certificate of deposit', FU: 'Farm', HE: 'Health savings account', PP: 'Personal property',
    '5C': '529 college savings plan', '5F': '529 prepaid tuition', '5P': '529 portfolio', RP: 'Retirement plan', MO: 'Money market',
};

function toIso(mdy) {
    const m = String(mdy || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

function parseAmount(a) {
    const s = clean(a);
    const nums = [...s.matchAll(/\$([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, '')));
    if (/over/i.test(s)) return { min: nums[0] ?? null, max: null };
    if (nums.length >= 2) return { min: nums[0], max: nums[1] };
    if (nums.length === 1) return { min: nums[0], max: nums[0] };
    return { min: null, max: null };
}

function normalise(t) {
    const assetRaw = clean(t.asset);
    const code = (assetRaw.match(/\[([A-Z0-9]{2})\]\s*$/) || [])[1] || null;
    const ticker = (assetRaw.match(/\(([A-Z][A-Z0-9.\-]{0,9})\)\s*(?:\[[A-Z0-9]{2}\])?\s*$/) || [])[1] || null;
    const asset = assetRaw.replace(/\s*\[[A-Z0-9]{2}\]\s*$/, '').replace(/\s*\([A-Z][A-Z0-9.\-]{0,9}\)\s*$/, '').trim();
    const amt = parseAmount(t.amount);
    return {
        owner: OWNER[t.owner] || (t.owner ? t.owner : 'Self'),
        asset,
        ticker,
        assetTypeCode: code,
        assetType: code ? ASSET_TYPES[code] || code : null,
        transactionType: TYPE_NAME[t.type] || t.type,
        transactionDate: toIso(t.date),
        notificationDate: toIso(t.notified),
        amountRange: clean(t.amount) || null,
        amountMin: amt.min,
        amountMax: amt.max,
        description: t.description || null,
        comments: t.comments || null,
        subholdingOf: t.subholdingOf || null,
        filingStatus: t.filingStatus || null,
    };
}
