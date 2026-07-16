// Bulk QR Code Generator: URLs & Text to PNG or SVG
//
// Strategy
// --------
// Fully offline (phone-checker/postal-checker/iban-checker pattern): render
// one QR code per input line with the qrcode npm library, save each image to
// the run's key-value store, and push one dataset row per code with the
// content, options used, and a direct download URL. Zero network calls means
// zero source risk and nothing to break.
//
// Pay per event
// -------------
//   qr_code ($0.002) charged per QR code generated. Empty or too-long lines
//   are free note rows. First 2 codes per run are free.

import { Actor, log } from 'apify';
import QRCode from 'qrcode';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
// QR version 40 fits ~2953 bytes; leave headroom and refuse absurd inputs.
const MAX_CONTENT_BYTES = 2900;
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 60000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    items = [],
    format = 'png',
    size = 512,
    margin = 2,
    errorCorrection = 'M',
    darkColor = '#000000',
    lightColor = '#ffffff',
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/\n/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const contents = asList(items).slice(0, HARD_CAP);
const fmt = String(format).toLowerCase() === 'svg' ? 'svg' : 'png';
const width = Math.max(128, Math.min(2048, Number(size) || 512));
const quietZone = Math.max(0, Math.min(20, Number(margin) ?? 2));
const ecLevel = ['L', 'M', 'Q', 'H'].includes(String(errorCorrection).toUpperCase())
    ? String(errorCorrection).toUpperCase() : 'M';
const hex = (v, fallback) => (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(String(v || '').trim()) ? String(v).trim() : fallback);
const dark = hex(darkColor, '#000000');
const light = hex(lightColor, '#ffffff');

if (!contents.length) {
    log.warning('No items given. Provide one URL or text per line in "items".');
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
            await Actor.charge({ eventName: 'qr_code' });
        } catch (err) {
            log.warning(`charge failed: ${err?.message}`);
        }
    }
}

const opts = {
    errorCorrectionLevel: ecLevel,
    margin: quietZone,
    width,
    color: { dark, light },
};

log.info(`Generating ${contents.length} QR code(s): ${fmt.toUpperCase()}, ${width}px, EC level ${ecLevel}.`);

let n = 0;
for (const content of contents) {
    if (deadlineMs && Date.now() > deadlineMs) {
        log.warning('Approaching run timeout; stopping early with results so far.');
        break;
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
        await flushRow({ content: `${content.slice(0, 80)}...`, note: `Content exceeds ${MAX_CONTENT_BYTES} bytes and cannot fit in a QR code.` }, false);
        continue;
    }
    const key = `qr-${String(n).padStart(4, '0')}.${fmt}`;
    try {
        if (fmt === 'svg') {
            const svg = await QRCode.toString(content, { ...opts, type: 'svg' });
            await store.setValue(key, svg, { contentType: 'image/svg+xml' });
        } else {
            const buf = await QRCode.toBuffer(content, { ...opts, type: 'png' });
            await store.setValue(key, buf, { contentType: 'image/png' });
        }
    } catch (err) {
        await flushRow({ content, note: `Could not encode: ${err?.message}` }, false);
        continue;
    }
    await flushRow({
        content,
        format: fmt,
        sizePx: fmt === 'png' ? width : null,
        errorCorrection: ecLevel,
        darkColor: dark,
        lightColor: light,
        fileName: key,
        imageUrl: `https://api.apify.com/v2/key-value-stores/${storeId}/records/${key}`,
        generatedAt: new Date().toISOString(),
    });
    n += 1;
}

log.info(`Done. ${n} QR code(s) generated, ${rowsPushed} charged row(s) max ${Math.max(0, rowsPushed - FREE_TIER_ROWS)}.`);
await Actor.exit();
