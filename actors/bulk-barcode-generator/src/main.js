// Bulk Barcode Generator: EAN, UPC, Code 128 to PNG or SVG
//
// Strategy
// --------
// Fully offline (same pattern as the QR generator): render one retail or
// logistics barcode per input line with bwip-js, save each image to the
// run's key-value store, and push one dataset row per barcode with a direct
// download URL. GTIN check digits (EAN-13, UPC-A, ITF-14) are validated
// with mod-10 BEFORE rendering: a wrong check digit means the seller's
// number is bad, and telling them so as a free note row is part of the
// product. Zero network calls, zero source risk.
//
// Pay per event
// -------------
//   barcode ($0.002) charged per barcode generated. Invalid numbers and
//   unencodable lines are free note rows. First 2 barcodes per run are free.

import { Actor, log } from 'apify';
import bwipjs from 'bwip-js';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    items = [],
    barcodeType = 'ean13',
    format = 'png',
    scale = 3,
    barHeight = 12,
    showText = true,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/\n/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const contents = asList(items).slice(0, HARD_CAP);
const fmt = String(format).toLowerCase() === 'svg' ? 'svg' : 'png';
const scl = Math.max(1, Math.min(8, Number(scale) || 3));
const height = Math.max(5, Math.min(40, Number(barHeight) || 12));

// GTIN mod-10: weights 3/1 from the rightmost digit (before the check digit).
function gtinCheckDigit(digits) {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        const d = digits.charCodeAt(digits.length - 1 - i) - 48;
        sum += d * (i % 2 === 0 ? 3 : 1);
    }
    return String((10 - (sum % 10)) % 10);
}

// Each type: bwip-js bcid, and a prepare() that validates/normalizes the
// value or returns { error } for a free note row. GTIN types accept the
// value without its check digit too (we compute it).
const TYPES = {
    ean13: {
        label: 'EAN-13', bcid: 'ean13',
        prepare: (v) => {
            const d = v.replace(/[\s-]/g, '');
            if (!/^\d{12,13}$/.test(d)) return { error: 'EAN-13 needs 12 or 13 digits.' };
            if (d.length === 12) return { text: d + gtinCheckDigit(d) };
            return d.slice(-1) === gtinCheckDigit(d.slice(0, 12))
                ? { text: d }
                : { error: `Wrong check digit: last digit should be ${gtinCheckDigit(d.slice(0, 12))}. The number as given would not scan as intended.` };
        },
    },
    upca: {
        label: 'UPC-A', bcid: 'upca',
        prepare: (v) => {
            const d = v.replace(/[\s-]/g, '');
            if (!/^\d{11,12}$/.test(d)) return { error: 'UPC-A needs 11 or 12 digits.' };
            if (d.length === 11) return { text: d + gtinCheckDigit(d) };
            return d.slice(-1) === gtinCheckDigit(d.slice(0, 11))
                ? { text: d }
                : { error: `Wrong check digit: last digit should be ${gtinCheckDigit(d.slice(0, 11))}.` };
        },
    },
    itf14: {
        label: 'ITF-14', bcid: 'itf14',
        prepare: (v) => {
            const d = v.replace(/[\s-]/g, '');
            if (!/^\d{13,14}$/.test(d)) return { error: 'ITF-14 needs 13 or 14 digits.' };
            if (d.length === 13) return { text: d + gtinCheckDigit(d) };
            return d.slice(-1) === gtinCheckDigit(d.slice(0, 13))
                ? { text: d }
                : { error: `Wrong check digit: last digit should be ${gtinCheckDigit(d.slice(0, 13))}.` };
        },
    },
    isbn: {
        label: 'ISBN', bcid: 'isbn',
        prepare: (v) => {
            const d = v.replace(/[\s]/g, '');
            return /^[\d-]{10,17}X?$/i.test(d) ? { text: d } : { error: 'ISBN should be a 10 or 13 digit ISBN, dashes allowed.' };
        },
    },
    code128: {
        label: 'Code 128', bcid: 'code128',
        prepare: (v) => (v.length <= 80 ? { text: v } : { error: 'Code 128 input capped at 80 characters.' }),
    },
    code39: {
        label: 'Code 39', bcid: 'code39',
        prepare: (v) => {
            const t = v.toUpperCase();
            return /^[A-Z0-9\-. $/+%]{1,43}$/.test(t)
                ? { text: t }
                : { error: 'Code 39 allows only A-Z, 0-9, space and - . $ / + % (max 43 chars).' };
        },
    },
};

const type = TYPES[String(barcodeType).toLowerCase().replace(/[^a-z0-9]/g, '')];
if (!type) {
    log.warning(`Unknown barcodeType. Supported: ${Object.keys(TYPES).join(', ')}.`);
    await Actor.exit();
}
if (!contents.length) {
    log.warning('No items given. Provide one barcode value per line in "items".');
    await Actor.exit();
}

const store = await Actor.openKeyValueStore();
const storeId = store.id;

let rowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row, chargeable = true) {
    await Actor.pushData(row);
    if (!chargeable) return;
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try {
            await Actor.charge({ eventName: 'barcode' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

log.info(`Generating ${contents.length} ${type.label} barcode(s): ${fmt.toUpperCase()}, scale ${scl}, height ${height}mm.`);

let n = 0;
for (const value of contents) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    const prep = type.prepare(value);
    if (prep.error) {
        await flushRow({ value, barcodeType: type.label, note: prep.error }, false);
        continue;
    }
    const opts = {
        bcid: type.bcid,
        text: prep.text,
        scale: scl,
        height,
        includetext: Boolean(showText),
        textxalign: 'center',
    };
    const key = `barcode-${String(n).padStart(4, '0')}.${fmt}`;
    try {
        if (fmt === 'svg') {
            const svg = bwipjs.toSVG(opts);
            await store.setValue(key, svg, { contentType: 'image/svg+xml' });
        } else {
            const buf = await bwipjs.toBuffer(opts);
            await store.setValue(key, buf, { contentType: 'image/png' });
        }
    } catch (err) {
        await flushRow({ value, barcodeType: type.label, note: `Could not encode: ${err?.message || err}` }, false);
        continue;
    }
    await flushRow({
        value,
        encodedText: prep.text,
        barcodeType: type.label,
        format: fmt,
        fileName: key,
        imageUrl: `https://api.apify.com/v2/key-value-stores/${storeId}/records/${key}`,
        generatedAt: new Date().toISOString(),
    });
    n += 1;
}

log.info(`Done. ${n} barcode(s) generated (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable max).`);
await Actor.exit();
