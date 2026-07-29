// Crypto Token Security Check: Honeypot, Taxes and Owner Risk
//
// What it does
// ------------
// Before buying a token, the questions are always the same: can I sell it
// again, what will it tax me, and what can the owner still do to me. This
// reads a public contract security service and returns those answers as rows.
//
//   tokens    one row per token: taxes, honeypot and sell restrictions,
//             what powers the owner keeps, liquidity, holder concentration,
//             and every risk flag actually raised
//   holders   one row per top holder and liquidity provider: size, share,
//             whether the position is locked
//   address   one row per wallet or contract address: known involvement in
//             phishing, laundering, cybercrime and similar
//
// Chains: Ethereum, BNB Chain, Polygon, Base, Arbitrum, Optimism, Avalanche
// and Solana. Keyless.
//
// What this is NOT
// ----------------
// This reports what a third party security service found. It does not certify
// any token as safe, and no score is invented here. Some flags are perfectly
// normal for a legitimate token: a centrally issued stablecoin is mintable
// and freezable by design.
//
// Pay per event
// -------------
//   security_row ($0.004) charged per row pushed. First 2 rows per run free.
//   Note rows are never charged.

import { Actor, log } from 'apify';

const FREE_TIER_ROWS = 2;
const HARD_CAP = 2000;
const FETCH_TIMEOUT_MS = 25000;
const SPACING_MS = 400;
const UA = 'Mozilla/5.0 (compatible; Scrapemint/1.0; +https://apify.com)';
const API = 'https://api.gopluslabs.io/api/v1';

const timeoutAtMs = process.env.ACTOR_TIMEOUT_AT ? Date.parse(process.env.ACTOR_TIMEOUT_AT) : null;
const deadlineMs = timeoutAtMs ? timeoutAtMs - 30000 : null;
const pastDeadline = () => deadlineMs && Date.now() > deadlineMs;

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    mode = 'tokens',
    chain = 'ethereum',
    tokenAddresses = [
        '0xdac17f958d2ee523a2206206994597c13d831ec7',
        '0x6b175474e89094c44da98b954eedeac495271d0f',
        '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
    ],
    walletAddresses = [],
    topHolders = 10,
    maxRows = 200,
} = input;

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,\s]/))
    .map((s) => String(s || '').trim()).filter(Boolean);
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const numOrNull = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
// The service answers "1" for yes and "0" for no, but an ABSENT field means it
// did not assess that property at all. Absent must never collapse to "no", or
// an unchecked contract reads as a clean one.
const flagOf = (v) => (v === '1' || v === 1 ? true : (v === '0' || v === 0 ? false : null));

const theMode = ['tokens', 'holders', 'address'].includes(String(mode).toLowerCase())
    ? String(mode).toLowerCase() : 'tokens';
const holderLimit = Math.max(1, Math.min(50, Number(topHolders) || 10));
const rowCap = Math.max(1, Math.min(HARD_CAP, Number(maxRows) || 200));

const CHAINS = {
    ethereum: { id: '1', name: 'Ethereum', model: 'evm' },
    bsc: { id: '56', name: 'BNB Chain', model: 'evm' },
    polygon: { id: '137', name: 'Polygon', model: 'evm' },
    base: { id: '8453', name: 'Base', model: 'evm' },
    arbitrum: { id: '42161', name: 'Arbitrum', model: 'evm' },
    optimism: { id: '10', name: 'Optimism', model: 'evm' },
    avalanche: { id: '43114', name: 'Avalanche', model: 'evm' },
    solana: { id: 'solana', name: 'Solana', model: 'solana' },
};
const chainAliases = { eth: 'ethereum', mainnet: 'ethereum', bnb: 'bsc', binance: 'bsc', matic: 'polygon', arb: 'arbitrum', op: 'optimism', avax: 'avalanche', sol: 'solana' };
const chainKey = (() => {
    const raw = String(chain || '').toLowerCase().trim();
    return CHAINS[raw] ? raw : (chainAliases[raw] || null);
})();

// Every EVM property that is checked, with the wording a buyer can act on and
// whether it is the kind of thing that can cost them everything.
const EVM_FLAGS = [
    ['is_honeypot', true, 'honeypot: the contract prevents selling'],
    ['cannot_sell_all', true, 'cannot sell the entire balance'],
    ['transfer_pausable', true, 'transfers can be paused by the owner'],
    ['can_take_back_ownership', true, 'ownership can be reclaimed after being renounced'],
    ['hidden_owner', true, 'the contract has a hidden owner'],
    ['selfdestruct', true, 'the contract can destroy itself'],
    ['owner_change_balance', true, 'the owner can change balances'],
    ['cannot_buy', false, 'the token cannot currently be bought'],
    ['is_blacklisted', false, 'the contract can blacklist addresses'],
    ['is_whitelisted', false, 'a whitelist controls who can trade'],
    ['slippage_modifiable', false, 'the tax rate can be changed by the owner'],
    ['personal_slippage_modifiable', false, 'a different tax can be set per address'],
    ['trading_cooldown', false, 'a trading cooldown is enforced'],
    ['anti_whale_modifiable', false, 'the maximum transaction size can be changed'],
    ['is_mintable', false, 'more supply can be minted'],
    ['is_proxy', false, 'the contract is an upgradeable proxy'],
    ['external_call', false, 'the contract calls external contracts'],
];

const SOLANA_FLAGS = [
    ['balance_mutable_authority', true, 'an authority can change balances'],
    ['freezable', true, 'accounts can be frozen'],
    ['non_transferable', true, 'the token cannot be transferred'],
    ['closable', false, 'token accounts can be closed by an authority'],
    ['mintable', false, 'more supply can be minted'],
    ['metadata_mutable', false, 'the token metadata can be changed'],
    ['transfer_hook', false, 'a transfer hook program runs on every transfer'],
    ['transfer_hook_upgradable', false, 'the transfer hook can be changed'],
    ['transfer_fee_upgradable', false, 'the transfer fee can be changed'],
    ['default_account_state_upgradable', false, 'the default account state can be changed'],
];

let emitted = 0;
let rowsPushed = 0;
let notePushed = false;

async function flushRow(row, charge = true) {
    await Actor.pushData(row);
    if (!charge) { notePushed = true; return; }
    rowsPushed += 1;
    if (rowsPushed > FREE_TIER_ROWS) {
        try { await Actor.charge({ eventName: 'security_row' }); }
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

async function getJson(url, attempt = 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { accept: 'application/json', 'User-Agent': UA },
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) return { error: `HTTP ${res.status}` };
        const body = await res.json();
        // The envelope carries its own code: an unsupported chain answers 2022
        // inside an HTTP 200, and a result of null with code 1 means the
        // service holds nothing for that address, NOT that it is clean.
        if (String(body.code) !== '1') return { error: `${body.message || 'error'} (code ${body.code})` };
        return { data: body.result };
    } catch (err) {
        if (attempt < 2) {
            await sleep(900 * (attempt + 1));
            return getJson(url, attempt + 1);
        }
        return { error: err?.message || 'fetch failed' };
    } finally { clearTimeout(timer); }
}

// One address per request. Passing several comma separated addresses looks
// like it works and silently returns only the first, which would leave a
// caller believing the rest do not exist.
async function fetchToken(key, address) {
    const c = CHAINS[key];
    const url = c.model === 'solana'
        ? `${API}/solana/token_security?contract_addresses=${address}`
        : `${API}/token_security/${c.id}?contract_addresses=${encodeURIComponent(address)}`;
    const res = await getJson(url);
    if (res.error) return { error: res.error };
    const result = res.data;
    if (!result || typeof result !== 'object') return { error: 'no security record for this address' };
    const found = Object.entries(result).find(([k]) => k.toLowerCase() === address.toLowerCase())
        || Object.entries(result)[0];
    if (!found) return { error: 'no security record for this address' };
    return { token: found[1] };
}

const evmRow = (key, address, t) => {
    const raised = [];
    const critical = [];
    const notAssessed = [];
    for (const [field, isCritical, wording] of EVM_FLAGS) {
        const v = flagOf(t[field]);
        if (v === null) { notAssessed.push(field); continue; }
        if (v) { raised.push(wording); if (isCritical) critical.push(wording); }
    }
    const openSource = flagOf(t.is_open_source);
    if (openSource === false) { raised.push('the contract source code is not verified'); critical.push('the contract source code is not verified'); }
    else if (openSource === null) notAssessed.push('is_open_source');

    // Published as a ratio, so 0.05 is a five per cent tax.
    const buyRatio = numOrNull(t.buy_tax);
    const sellRatio = numOrNull(t.sell_tax);
    const holders = Array.isArray(t.holders) ? t.holders : [];
    const topShare = holders.slice(0, 10)
        .reduce((a, h) => a + (numOrNull(h.percent) || 0), 0);
    const lpHolders = Array.isArray(t.lp_holders) ? t.lp_holders : [];
    const lockedLp = lpHolders.reduce((a, h) => a + (flagOf(h.is_locked) ? (numOrNull(h.percent) || 0) : 0), 0);
    const dex = Array.isArray(t.dex) ? t.dex : [];

    return {
        tokenName: t.token_name || null,
        tokenSymbol: t.token_symbol || null,
        totalSupply: numOrNull(t.total_supply),
        holderCount: numOrNull(t.holder_count),
        buyTaxPercent: buyRatio != null ? round(buyRatio * 100, 4) : null,
        sellTaxPercent: sellRatio != null ? round(sellRatio * 100, 4) : null,
        isHoneypot: flagOf(t.is_honeypot),
        cannotSellAll: flagOf(t.cannot_sell_all),
        transfersPausable: flagOf(t.transfer_pausable),
        isOpenSource: openSource,
        isProxy: flagOf(t.is_proxy),
        isMintable: flagOf(t.is_mintable),
        canTakeBackOwnership: flagOf(t.can_take_back_ownership),
        hiddenOwner: flagOf(t.hidden_owner),
        ownerAddress: t.owner_address || null,
        ownerPercent: numOrNull(t.owner_percent) != null ? round(numOrNull(t.owner_percent) * 100, 4) : null,
        creatorAddress: t.creator_address || null,
        creatorPercent: numOrNull(t.creator_percent) != null ? round(numOrNull(t.creator_percent) * 100, 4) : null,
        // How much of the supply the largest holders control, which the
        // service reports per holder but never totals.
        top10HolderPercent: holders.length ? round(topShare * 100, 3) : null,
        holdersReported: holders.length,
        isInDex: flagOf(t.is_in_dex),
        dexPairs: dex.length,
        liquidityUsd: dex.length
            ? round(dex.reduce((a, d) => a + (numOrNull(d.liquidity) || 0), 0), 2) : null,
        lpHolderCount: numOrNull(t.lp_holder_count),
        lockedLiquidityPercent: lpHolders.length ? round(lockedLp * 100, 3) : null,
        riskFlags: raised,
        riskFlagCount: raised.length,
        criticalFlags: critical,
        criticalFlagCount: critical.length,
        // Naming what was not looked at is the difference between "clean" and
        // "unchecked", which the raw response does not distinguish.
        propertiesNotAssessed: notAssessed,
        propertiesNotAssessedCount: notAssessed.length,
    };
};

const solStatus = (v) => (v && typeof v === 'object' ? flagOf(v.status) : flagOf(v));

const solanaRow = (t) => {
    const raised = [];
    const critical = [];
    const notAssessed = [];
    for (const [field, isCritical, wording] of SOLANA_FLAGS) {
        const v = solStatus(t[field]);
        if (v === null) { notAssessed.push(field); continue; }
        if (v) { raised.push(wording); if (isCritical) critical.push(wording); }
    }
    const holders = Array.isArray(t.holders) ? t.holders : [];
    const topShare = holders.slice(0, 10).reduce((a, h) => a + (numOrNull(h.percent) || 0), 0);
    const lpHolders = Array.isArray(t.lp_holders) ? t.lp_holders : [];
    const dex = Array.isArray(t.dex) ? t.dex : [];
    const fee = t.transfer_fee && typeof t.transfer_fee === 'object' ? t.transfer_fee : null;

    return {
        tokenName: t.metadata?.name || null,
        tokenSymbol: t.metadata?.symbol || null,
        totalSupply: numOrNull(t.total_supply),
        holderCount: numOrNull(t.holder_count),
        buyTaxPercent: null,
        sellTaxPercent: null,
        transferFeePercent: fee && numOrNull(fee.fee_rate) != null ? round(numOrNull(fee.fee_rate) * 100, 4) : null,
        isMintable: solStatus(t.mintable),
        isFreezable: solStatus(t.freezable),
        isClosable: solStatus(t.closable),
        metadataMutable: solStatus(t.metadata_mutable),
        balanceMutableByAuthority: solStatus(t.balance_mutable_authority),
        nonTransferable: solStatus(t.non_transferable),
        // The service marks widely used tokens; a centrally issued stablecoin
        // is legitimately mintable and freezable, and this is what keeps the
        // output from implying otherwise.
        isTrustedToken: flagOf(t.trusted_token),
        creators: Array.isArray(t.creators) ? t.creators.length : null,
        top10HolderPercent: holders.length ? round(topShare * 100, 3) : null,
        holdersReported: holders.length,
        dexPairs: dex.length,
        liquidityUsd: dex.length
            ? round(dex.reduce((a, d) => a + (numOrNull(d.tvl) || numOrNull(d.liquidity) || 0), 0), 2) : null,
        lpHolderCount: lpHolders.length || null,
        riskFlags: raised,
        riskFlagCount: raised.length,
        criticalFlags: critical,
        criticalFlagCount: critical.length,
        propertiesNotAssessed: notAssessed,
        propertiesNotAssessedCount: notAssessed.length,
    };
};

const base = (key, address) => ({
    chain: CHAINS[key].name,
    chainKey: key,
    chainModel: CHAINS[key].model,
    contractAddress: address,
    assessmentSource: 'GoPlus Labs token security service',
    sourceUrl: 'https://gopluslabs.io',
    disclaimer: 'these are flags reported by a third party security service, not a verdict on whether a token is safe to buy; some flags are normal for legitimate tokens',
    scrapedAt: new Date().toISOString(),
});

log.info(`Token security ${theMode} | chain ${chainKey || chain}`);
if (!chainKey) {
    await note({
        requestedChain: chain,
        note: `not a covered chain: ${chain}; covered chains are ${Object.keys(CHAINS).join(', ')}; not charged`,
    });
} else if (theMode === 'address') {
    const addresses = asList(walletAddresses);
    if (!addresses.length) {
        await note({ note: 'address mode needs at least one wallet or contract address in walletAddresses; not charged' });
    }
    for (const address of addresses) {
        if (emitted >= rowCap || pastDeadline()) break;
        const res = await getJson(`${API}/address_security/${encodeURIComponent(address)}?chain_id=${CHAINS[chainKey].id}`);
        if (res.error || !res.data) {
            await note({ address, note: `no address record returned for ${address}: ${res.error || 'the service holds nothing for this address, which is not the same as it being clean'}; not charged` });
            await sleep(SPACING_MS);
            continue;
        }
        const d = res.data;
        const raised = [];
        for (const [field, wording] of [
            ['phishing_activities', 'linked to phishing activity'],
            ['blackmail_activities', 'linked to blackmail activity'],
            ['stealing_attack', 'linked to a theft attack'],
            ['fake_kyc', 'linked to fake identity verification'],
            ['malicious_mining_activities', 'linked to malicious mining'],
            ['darkweb_transactions', 'linked to dark web transactions'],
            ['cybercrime', 'linked to cybercrime'],
            ['money_laundering', 'linked to money laundering'],
            ['financial_crime', 'linked to financial crime'],
            ['blacklist_doubt', 'appears on a blacklist'],
            ['honeypot_related_address', 'associated with honeypot contracts'],
            ['sanctioned', 'appears on a sanctions list'],
        ]) { if (flagOf(d[field])) raised.push(wording); }
        await push({
            mode: 'address',
            ...base(chainKey, address),
            isContract: flagOf(d.contract_address),
            maliciousContractsCreated: numOrNull(d.number_of_malicious_contracts_created),
            riskFlags: raised,
            riskFlagCount: raised.length,
            hasAnyReportedRisk: raised.length > 0,
            dataSource: d.data_source || null,
        });
        await sleep(SPACING_MS);
    }
} else {
    const addresses = asList(tokenAddresses);
    if (!addresses.length) {
        await note({ note: 'no token addresses supplied; not charged' });
    }
    for (const address of addresses) {
        if (emitted >= rowCap || pastDeadline()) break;
        const res = await fetchToken(chainKey, address);
        if (res.error) {
            await note({
                contractAddress: address, chain: CHAINS[chainKey].name,
                note: `${address} on ${CHAINS[chainKey].name}: ${res.error}; an address the service holds no record for is UNASSESSED, not confirmed clean; not charged`,
            });
            await sleep(SPACING_MS);
            continue;
        }
        const t = res.token;
        const shaped = CHAINS[chainKey].model === 'solana' ? solanaRow(t) : evmRow(chainKey, address, t);
        if (theMode === 'tokens') {
            await push({ mode: 'tokens', ...base(chainKey, address), ...shaped });
        } else {
            const holders = Array.isArray(t.holders) ? t.holders : [];
            const lp = Array.isArray(t.lp_holders) ? t.lp_holders : [];
            const rows = [
                ...holders.slice(0, holderLimit).map((h, i) => ({ h, i, kind: 'token_holder' })),
                ...lp.slice(0, holderLimit).map((h, i) => ({ h, i, kind: 'liquidity_provider' })),
            ];
            if (!rows.length) {
                await note({ contractAddress: address, note: `no holder detail published for ${address}; not charged` });
            }
            for (const { h, i, kind } of rows) {
                if (emitted >= rowCap) break;
                await push({
                    mode: 'holders',
                    ...base(chainKey, address),
                    tokenSymbol: shaped.tokenSymbol,
                    holderKind: kind,
                    rank: i + 1,
                    holderAddress: h.address || null,
                    balance: numOrNull(h.balance),
                    percentOfSupply: numOrNull(h.percent) != null ? round(numOrNull(h.percent) * 100, 4) : null,
                    isContract: flagOf(h.is_contract),
                    isLocked: flagOf(h.is_locked),
                    tag: h.tag || null,
                });
            }
        }
        await sleep(SPACING_MS);
    }
}

if (!emitted && !notePushed) {
    await note({ note: 'no rows returned; check the chain and addresses requested; not charged' });
}

log.info(`Done. ${emitted} row(s) pushed (${Math.max(0, rowsPushed - FREE_TIER_ROWS)} chargeable).`);
await Actor.exit();
