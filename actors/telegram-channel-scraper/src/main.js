// Telegram Channel Scraper (No Login)
//
// Strategy
// --------
// Every public Telegram channel has a keyless web preview:
//   https://t.me/s/<channel>            latest ~20 messages as HTML
//   https://t.me/s/<channel>?before=<id> the 20 messages older than <id>
//   https://t.me/<channel>              channel card (title, bio, subscribers)
// No login, no API key, no phone number, no bot token. We parse the preview
// HTML with cheerio, walk ?before= pagination to the requested depth, and emit
// one row per message plus one free channel_info row per channel.
// Channels with previews disabled return no messages; those cost nothing.
//
// Pay per event
// -------------
//   message_row ($0.002) charged when a message row is pushed.
//   channel_info rows are free. First 10 message rows per run are free so
//   buyers can validate output.

import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';

const FREE_TIER_ROWS = 10;
const HARD_CAP = 10000;
const REQUEST_DELAY_MS = 400;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// Stop early on platform timeouts so pushed rows and charges are not lost.
const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    channels = [],
    maxMessagesPerChannel = 100,
    maxMessages = 500,
    includeChannelInfo = true,
    proxyConfiguration: proxyInput,
} = input;

const channelList = (Array.isArray(channels) ? channels : [channels])
    .map((c) => String(c || '').trim()
        .replace(/^https?:\/\/(www\.)?t(elegram)?\.me\/(s\/)?/i, '')
        .replace(/^@/, '')
        .split(/[/?]/)[0])
    .filter(Boolean);
if (!channelList.length) {
    log.warning('Provide "channels": public channel usernames or t.me links, e.g. ["durov", "https://t.me/telegram"].');
    await Actor.exit();
}
const perChannelCap = Math.max(1, Math.min(5000, Number(maxMessagesPerChannel) || 100));
const cap = Math.max(1, Math.min(HARD_CAP, Number(maxMessages) || 500));

let dispatcher = null;
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);
if (proxyConfiguration) {
    const proxyUrl = await proxyConfiguration.newUrl();
    if (proxyUrl) {
        try {
            const { ProxyAgent } = await import('undici');
            dispatcher = new ProxyAgent(proxyUrl);
        } catch (err) {
            log.warning(`Proxy requested but undici ProxyAgent unavailable, continuing direct: ${err?.message}`);
        }
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
        redirect: 'follow',
        ...(dispatcher ? { dispatcher } : {}),
    });
    if (!res.ok) throw new Error(`t.me HTTP ${res.status}`);
    return res.text();
}

// "11 862 837" (narrow spaces), "3.4M", "12.3K" -> integer
function parseCount(raw) {
    if (!raw) return null;
    const s = String(raw).replace(/[\s  ]/g, '').toLowerCase();
    const m = s.match(/^([\d.]+)([km]?)$/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (Number.isNaN(n)) return null;
    return Math.round(n * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1));
}

async function channelInfo(channel) {
    const html = await fetchHtml(`https://t.me/${channel}`);
    const $ = cheerio.load(html);
    const extra = $('.tgme_page_extra').text();
    const subs = extra.match(/([\d\s  .KM]+)\s+subscribers/i);
    return {
        type: 'channel_info',
        channel,
        title: $('meta[property="og:title"]').attr('content') || null,
        description: $('meta[property="og:description"]').attr('content') || null,
        subscribers: subs ? parseCount(subs[1]) : null,
        photoUrl: $('meta[property="og:image"]').attr('content') || null,
        url: `https://t.me/${channel}`,
    };
}

function parseMessages(html, channel) {
    const $ = cheerio.load(html);
    const out = [];
    for (const el of $('.tgme_widget_message').toArray()) {
        const msg = $(el);
        const post = msg.attr('data-post') || '';
        const id = Number(post.split('/')[1]);
        if (!id) continue;
        const textEl = msg.find('.tgme_widget_message_text').first();
        const links = [...new Set(textEl.find('a[href]').toArray()
            .map((a) => $(a).attr('href'))
            .filter((h) => h && /^https?:/i.test(h)))];
        const photos = msg.find('.tgme_widget_message_photo_wrap').toArray()
            .map((p) => ($(p).attr('style') || '').match(/url\('([^']+)'\)/)?.[1])
            .filter(Boolean);
        const video = msg.find('video').attr('src') || null;
        const fwd = msg.find('.tgme_widget_message_forwarded_from_name').first();
        out.push({
            type: 'message',
            channel,
            messageId: id,
            url: `https://t.me/${post}`,
            text: textEl.text().trim() || null,
            date: msg.find('.tgme_widget_message_date time').attr('datetime') || null,
            views: parseCount(msg.find('.tgme_widget_message_views').first().text()),
            links: links.length ? links : null,
            photoUrls: photos.length ? photos : null,
            videoUrl: video,
            forwardedFrom: fwd.length ? fwd.text().trim() : null,
            forwardedFromUrl: fwd.attr('href') || null,
            hasMedia: Boolean(photos.length || video),
        });
    }
    return out.sort((a, b) => b.messageId - a.messageId);
}

let messageRowsPushed = 0;
let totalRowsPushed = 0;
// pushData and charge are awaited so a fast exit cannot drop the write/charge.
async function flushRow(row) {
    await Actor.pushData({ ...row, scrapedAt: new Date().toISOString() });
    totalRowsPushed += 1;
    if (row.type === 'message') {
        messageRowsPushed += 1;
        if (messageRowsPushed > FREE_TIER_ROWS) {
            try {
                await Actor.charge({ eventName: 'message_row' });
            } catch (err) {
                log.warning(`charge failed: ${err?.message}`);
            }
        }
    }
}

log.info(`Scraping ${channelList.length} public channel(s), up to ${perChannelCap} message(s) each.`);

let stopped = false;
for (const channel of channelList) {
    if (stopped || messageRowsPushed >= cap) break;

    if (includeChannelInfo) {
        try {
            await flushRow(await channelInfo(channel));
        } catch (err) {
            log.warning(`Channel "${channel}" info failed: ${err?.message}`);
        }
        await sleep(REQUEST_DELAY_MS);
    }

    let before = null;
    let pushedForChannel = 0;
    const seen = new Set();
    while (pushedForChannel < perChannelCap && messageRowsPushed < cap) {
        if (deadlineMs && Date.now() > deadlineMs) {
            log.warning('Approaching run timeout; stopping early with results so far.');
            stopped = true;
            break;
        }
        let msgs;
        try {
            const url = `https://t.me/s/${channel}${before ? `?before=${before}` : ''}`;
            msgs = parseMessages(await fetchHtml(url), channel);
        } catch (err) {
            log.warning(`Channel "${channel}" page failed: ${err?.message}`);
            break;
        }
        const fresh = msgs.filter((m) => !seen.has(m.messageId));
        if (!fresh.length) {
            if (!pushedForChannel) log.warning(`Channel "${channel}": no messages (private, preview disabled, or does not exist). No charge.`);
            break;
        }
        for (const m of fresh) {
            if (pushedForChannel >= perChannelCap || messageRowsPushed >= cap) break;
            seen.add(m.messageId);
            await flushRow(m);
            pushedForChannel += 1;
        }
        before = Math.min(...[...seen]);
        if (before <= 1) break;
        await sleep(REQUEST_DELAY_MS);
    }
    log.info(`Channel "${channel}": ${pushedForChannel} message(s).`);
}

log.info(`Done. ${totalRowsPushed} row(s) (${messageRowsPushed} messages); ${Math.max(0, messageRowsPushed - FREE_TIER_ROWS)} chargeable.`);
await Actor.exit();
