// AI Model Prices: Cost, Speed and Uptime by Provider
//
// What it does
// ------------
// What every large language model costs to run, in money rather than
// scientific notation, and which company hosting it is cheapest, fastest and
// most reliable right now.
//
//   models     one row per model: price per million tokens in and out, cache
//              rates, the cost of a realistic request, context window,
//              modalities, knowledge cutoff and retirement date
//   providers  one row per model per hosting provider: its own price,
//              measured latency and throughput, uptime, quantisation
//   compare    one row per model summarising the providers behind it: the
//              cheapest, the fastest, the most reliable, and how wide the
//              price spread is
//
// Keyless, no account, no browser.
//
// Pay per event
// -------------
//   model_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 3000;
const FETCH_TIMEOUT_MS = 25000;
const SPACING_MS = 300;
const UA = 'Mozilla/5.0 (compatible; Scrapemint/1.0; +https://apify.com)';
const API = 'https://openrouter.ai/api/v1';
const PER_MILLION = 1e6;

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'models',
    models = [],
    vendors = [],
    promptTokens = 10000,
    completionTokens = 1000,
    minContextLength = 0,
    maxInputPricePerMillion = 0,
    includeFree = true,
    includeRetiring = true,
    expandModels = 15,
    maxRows = 100,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Prices arrive as strings. An ABSENT key means that kind of usage is not
// priced for this model at all, which is not the same as it being free, so a
// missing rate stays null rather than collapsing to zero.
const rate = (pricing, key) => {
    if (!pricing || !(key in pricing)) return null;
    const n = Number(pricing[key]);
    return Number.isFinite(n) ? n : null;
};
const perMillion = (v) => (v == null ? null : round(v * PER_MILLION, 6));
// The measured metrics are null on providers the aggregator has not sampled.
// Number(null) is 0, which would publish an unmeasured endpoint as zero
// tokens per second and zero latency, reading as a broken provider.
const metric = (v, dp) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? round(n, dp) : null;
};

const theMode = ['models', 'providers', 'compare'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'models';
const wantModels = asList(models).map((m) => m.toLowerCase());
const wantVendors = asList(vendors).map((v) => v.toLowerCase());
const inTokens = Math.max(0, Math.min(10000000, Number(promptTokens) || 0));
const outTokens = Math.max(0, Math.min(1000000, Number(completionTokens) || 0));
const minContext = Math.max(0, Number(minContextLength) || 0);
const maxInputPrice = Math.max(0, Number(maxInputPricePerMillion) || 0);
const expandLimit = Math.max(1, Math.min(100, Number(expandModels) || 15));
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 100));

let emitted = 0;
let rowsPushed = 0;
let notePushed = false;

async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'model_row' }); }
        catch (err) { log.warning(`charge failed: ${err?.message}`); }
    }
}

const push = async (row) => {
    if (emitted >= rowCap) return false;
    await flushRow(row);
    emitted += 1;
    return true;
};

const note = async (row) => { await flushRow({ type: 'note', found: false, ...row }, false); };

async function getJson(path, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${API}/${path}`, {
            signal: controller.signal,
            headers: { accept: 'application/json', 'User-Agent': UA },
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (res.status === 404) return { error: 'not published under that identifier' };
        if (!res.ok) return { error: `HTTP ${res.status}` };
        return { data: await res.json() };
    } catch (err) {
        if (attempt < 2) {
            await sleep(1200 * (attempt + 1));
            return getJson(path, attempt + 1);
        }
        return { error: err?.message || 'fetch failed' };
    } finally { clearTimeout(timer); }
}

// Long prompts are billed at a higher rate above published thresholds. The
// headline price only applies below the first one, so the cost of a request
// has to be worked out at the tier that request actually falls into.
function tierFor(pricing, tokens) {
    const overrides = Array.isArray(pricing?.overrides) ? pricing.overrides : [];
    let chosen = null;
    for (const o of overrides) {
        const min = Number(o.min_prompt_tokens);
        if (Number.isFinite(min) && tokens >= min) {
            if (!chosen || min > Number(chosen.min_prompt_tokens)) chosen = o;
        }
    }
    return chosen;
}

const costOfRequest = (pricing, inTok, outTok) => {
    const tier = tierFor(pricing, inTok);
    const prompt = tier ? rate(tier, 'prompt') : rate(pricing, 'prompt');
    const completion = tier ? rate(tier, 'completion') : rate(pricing, 'completion');
    if (prompt == null && completion == null) return { cost: null, tier };
    return { cost: (prompt || 0) * inTok + (completion || 0) * outTok, tier };
};

const shapeTiers = (pricing) => (Array.isArray(pricing?.overrides) ? pricing.overrides : []).map((o) => ({
    appliesFromPromptTokens: Number(o.min_prompt_tokens) || null,
    inputPerMillion: perMillion(rate(o, 'prompt')),
    outputPerMillion: perMillion(rate(o, 'completion')),
    cacheReadPerMillion: perMillion(rate(o, 'input_cache_read')),
})).sort((a, b) => (a.appliesFromPromptTokens || 0) - (b.appliesFromPromptTokens || 0));

log.info(`AI model prices ${theMode} | request sized ${inTokens} in / ${outTokens} out`);

const listRes = await getJson('models');
const all = Array.isArray(listRes.data?.data) ? listRes.data.data : [];
if (!all.length) {
    await note({ note: `could not read the model catalogue: ${listRes.error || 'empty response'}; not charged` });
} else {
    const matches = (m) => {
        const id = String(m.id || '').toLowerCase();
        const name = String(m.name || '').toLowerCase();
        if (wantModels.length && !wantModels.some((w) => id.includes(w) || name.includes(w))) return false;
        if (wantVendors.length && !wantVendors.includes(id.split('/')[0])) return false;
        const promptRate = rate(m.pricing, 'prompt');
        const isFree = promptRate === 0 && rate(m.pricing, 'completion') === 0;
        if (!includeFree && isFree) return false;
        if (!includeRetiring && m.expiration_date) return false;
        if (minContext && Number(m.context_length || 0) < minContext) return false;
        if (maxInputPrice && promptRate != null && promptRate * PER_MILLION > maxInputPrice) return false;
        return true;
    };
    const selected = all.filter(matches);
    log.info(`${selected.length} of ${all.length} models matched`);
    if (!selected.length) {
        await note({
            catalogueSize: all.length,
            note: 'no model matched the filters; clear the vendor or model filter, or raise the maximum price; not charged',
        });
    }

    const shapeModel = (m) => {
        const p = m.pricing || {};
        const { cost, tier } = costOfRequest(p, inTokens, outTokens);
        const promptRate = rate(p, 'prompt');
        const completionRate = rate(p, 'completion');
        const arch = m.architecture || {};
        return {
            modelId: m.id,
            modelName: m.name || null,
            vendor: String(m.id || '').split('/')[0] || null,
            // Published per token; per million is how the industry quotes it.
            inputPricePerMillionTokens: perMillion(promptRate),
            outputPricePerMillionTokens: perMillion(completionRate),
            cacheReadPricePerMillionTokens: perMillion(rate(p, 'input_cache_read')),
            cacheWritePricePerMillionTokens: perMillion(rate(p, 'input_cache_write')),
            imagePricePerThousand: rate(p, 'image') != null ? round(rate(p, 'image') * 1000, 6) : null,
            webSearchPricePerThousand: rate(p, 'web_search') != null ? round(rate(p, 'web_search') * 1000, 6) : null,
            reasoningPricePerMillionTokens: perMillion(rate(p, 'internal_reasoning')),
            isFree: promptRate === 0 && completionRate === 0,
            // Absent rates mean that usage is not offered, not that it costs
            // nothing, so they are reported as unpriced rather than zero.
            unpricedUsageTypes: ['input_cache_read', 'image', 'web_search', 'internal_reasoning', 'audio']
                .filter((k) => !(k in p)),
            requestSizeInputTokens: inTokens,
            requestSizeOutputTokens: outTokens,
            costOfRequestUsd: cost != null ? round(cost, 8) : null,
            costPer1000RequestsUsd: cost != null ? round(cost * 1000, 4) : null,
            hasTieredPricing: Array.isArray(p.overrides) && p.overrides.length > 0,
            tierAppliedToThisRequest: tier ? Number(tier.min_prompt_tokens) || null : null,
            pricingTiers: shapeTiers(p),
            contextLengthTokens: Number(m.context_length) || null,
            maxOutputTokens: Number(m.top_provider?.max_completion_tokens) || null,
            inputModalities: arch.input_modalities || null,
            outputModalities: arch.output_modalities || null,
            supportsTools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : null,
            supportsReasoning: !!m.reasoning,
            knowledgeCutoff: m.knowledge_cutoff || null,
            retiresOn: m.expiration_date || null,
            isRetiring: !!m.expiration_date,
            isModerated: m.top_provider?.is_moderated ?? null,
            sourceName: 'OpenRouter model catalogue',
            sourceUrl: `https://openrouter.ai/${m.id}`,
            pricingCaveat: 'prices are as listed by this aggregator and change often; they may differ from a provider\'s own direct pricing',
            scrapedAt: new Date().toISOString(),
        };
    };

    if (theMode === 'models') {
        const shaped = selected.map(shapeModel)
            .sort((a, b) => (a.costOfRequestUsd ?? Infinity) - (b.costOfRequestUsd ?? Infinity));
        for (let i = 0; i < shaped.length; i += 1) {
            if (emitted >= rowCap || pastDeadline()) break;
            await push({ mode: 'models', ...shaped[i], costRankCheapestFirst: i + 1, modelsCompared: shaped.length });
        }
    } else {
        // Provider detail costs one request per model, so the expansion is
        // capped and the cheapest matching models are expanded first.
        const ordered = selected.map((m) => ({ m, shaped: shapeModel(m) }))
            .sort((a, b) => (a.shaped.costOfRequestUsd ?? Infinity) - (b.shaped.costOfRequestUsd ?? Infinity))
            .slice(0, expandLimit);
        if (selected.length > ordered.length) {
            log.info(`expanding provider detail for ${ordered.length} of ${selected.length} matched models`);
        }
        for (const { m, shaped } of ordered) {
            if (emitted >= rowCap || pastDeadline()) break;
            const res = await getJson(`models/${m.id}/endpoints`);
            const endpoints = Array.isArray(res.data?.data?.endpoints) ? res.data.data.endpoints : [];
            if (!endpoints.length) {
                await note({ modelId: m.id, note: `no provider detail published for ${m.id}: ${res.error || 'empty response'}; not charged` });
                await sleep(SPACING_MS);
                continue;
            }
            const rows = endpoints.map((e) => {
                const { cost } = costOfRequest(e.pricing || {}, inTokens, outTokens);
                return {
                    providerName: e.provider_name || e.name || null,
                    inputPricePerMillionTokens: perMillion(rate(e.pricing, 'prompt')),
                    outputPricePerMillionTokens: perMillion(rate(e.pricing, 'completion')),
                    cacheReadPricePerMillionTokens: perMillion(rate(e.pricing, 'input_cache_read')),
                    costOfRequestUsd: cost != null ? round(cost, 8) : null,
                    contextLengthTokens: Number(e.context_length) || null,
                    maxOutputTokens: Number(e.max_completion_tokens) || null,
                    quantisation: e.quantization && e.quantization !== 'unknown' ? e.quantization : null,
                    // Measured by the aggregator over a short recent window,
                    // so these move between runs.
                    throughputTokensPerSecond: metric(e.throughput_last_30m, 2),
                    latencySeconds: metric(e.latency_last_30m, 3),
                    uptimeLast5mPercent: metric(e.uptime_last_5m, 2),
                    uptimeLast30mPercent: metric(e.uptime_last_30m, 2),
                    uptimeLast24hPercent: metric(e.uptime_last_1d, 2),
                    supportsImplicitCaching: e.supports_implicit_caching ?? null,
                    speedMeasured: e.throughput_last_30m != null || e.latency_last_30m != null,
                    statusCode: Number.isFinite(Number(e.status)) ? Number(e.status) : null,
                    isDegraded: Number.isFinite(Number(e.status)) ? Number(e.status) !== 0 : null,
                };
            });

            if (theMode === 'providers') {
                // Ranked by identity, not by name: a model is often served by
                // the same company more than once at different prices, and
                // matching on the name gives two endpoints the same rank.
                const ranks = new Map();
                rows.filter((r) => r.costOfRequestUsd != null)
                    .sort((a, b) => a.costOfRequestUsd - b.costOfRequestUsd)
                    .forEach((r, i) => ranks.set(r, i + 1));
                for (const r of rows) {
                    if (emitted >= rowCap) break;
                    const rank = ranks.get(r) || null;
                    await push({
                        mode: 'providers',
                        modelId: m.id,
                        modelName: shaped.modelName,
                        vendor: shaped.vendor,
                        ...r,
                        costRankCheapestFirst: rank || null,
                        providersForThisModel: rows.length,
                        requestSizeInputTokens: inTokens,
                        requestSizeOutputTokens: outTokens,
                        sourceName: 'OpenRouter provider endpoints',
                        sourceUrl: `https://openrouter.ai/${m.id}/providers`,
                        measurementCaveat: 'latency, throughput and uptime are the aggregator\'s own measurements over a short recent window and move between runs',
                        scrapedAt: new Date().toISOString(),
                    });
                }
            } else {
                const priced = rows.filter((r) => r.costOfRequestUsd != null);
                const cheapest = priced.slice().sort((a, b) => a.costOfRequestUsd - b.costOfRequestUsd)[0] || null;
                const dearest = priced.slice().sort((a, b) => b.costOfRequestUsd - a.costOfRequestUsd)[0] || null;
                const fastest = rows.filter((r) => Number.isFinite(r.throughputTokensPerSecond))
                    .sort((a, b) => b.throughputTokensPerSecond - a.throughputTokensPerSecond)[0] || null;
                const steadiest = rows.filter((r) => Number.isFinite(r.uptimeLast24hPercent))
                    .sort((a, b) => b.uptimeLast24hPercent - a.uptimeLast24hPercent)[0] || null;
                await push({
                    mode: 'compare',
                    modelId: m.id,
                    modelName: shaped.modelName,
                    vendor: shaped.vendor,
                    providerCount: rows.length,
                    cheapestProvider: cheapest ? cheapest.providerName : null,
                    cheapestRequestCostUsd: cheapest ? cheapest.costOfRequestUsd : null,
                    mostExpensiveProvider: dearest ? dearest.providerName : null,
                    mostExpensiveRequestCostUsd: dearest ? dearest.costOfRequestUsd : null,
                    // How much choosing badly costs, which is the point of
                    // looking at providers at all.
                    priceSpreadPercent: cheapest && dearest && cheapest.costOfRequestUsd > 0
                        ? round(((dearest.costOfRequestUsd - cheapest.costOfRequestUsd) / cheapest.costOfRequestUsd) * 100, 2) : null,
                    fastestProvider: fastest ? fastest.providerName : null,
                    fastestThroughputTokensPerSecond: fastest ? fastest.throughputTokensPerSecond : null,
                    mostReliableProvider: steadiest ? steadiest.providerName : null,
                    mostReliableUptime24hPercent: steadiest ? steadiest.uptimeLast24hPercent : null,
                    degradedProviders: rows.filter((r) => r.isDegraded).map((r) => r.providerName),
                    cheapestIsAlsoFastest: cheapest && fastest ? cheapest.providerName === fastest.providerName : null,
                    requestSizeInputTokens: inTokens,
                    requestSizeOutputTokens: outTokens,
                    sourceName: 'OpenRouter provider endpoints',
                    sourceUrl: `https://openrouter.ai/${m.id}/providers`,
                    measurementCaveat: 'latency, throughput and uptime are the aggregator\'s own measurements over a short recent window and move between runs',
                    scrapedAt: new Date().toISOString(),
                });
            }
            await sleep(SPACING_MS);
        }
    }
}

if (!emitted && !notePushed) {
    await note({ note: 'no rows returned; clear the filters or pick different models; not charged' });
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
