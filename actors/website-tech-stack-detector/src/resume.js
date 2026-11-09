// Stops a restarted run from pushing and charging the same results twice.
//
// Apify can move a run to another server, which restarts the script from the
// top. This module saves what the run has already pushed and charged in the
// run's own store, then skips that work after a restart.
//
// Usage, directly after `await Actor.init()`:
//     import { installResume } from './resume.js';
//     await installResume(Actor);
//
// Charges replay by count per event, so a customer is never billed twice even
// if a live value changed between attempts. Rows replay by content, ignoring
// scrape timestamps, and are only compared with what an earlier attempt pushed,
// so identical rows within one attempt are all kept.

import { createHash } from 'node:crypto';

const STATE_KEY = 'RESUME_STATE';
const SAVE_EVERY = 25;
const VOLATILE_FIELD = /^(scrapedAt|fetchedAt|retrievedAt|checkedAt|collectedAt|enrichedAt|timestamp)$/;

function rowHash(row) {
    const stable = Object.fromEntries(Object.entries(row).filter(([k]) => !VOLATILE_FIELD.test(k)));
    return createHash('sha1').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

export async function installResume(Actor) {
    const saved = (await Actor.getValue(STATE_KEY)) || { rows: [], charges: {} };
    const pushedRows = [...saved.rows];
    const fromEarlierAttempt = new Map();
    for (const hash of saved.rows) fromEarlierAttempt.set(hash, (fromEarlierAttempt.get(hash) || 0) + 1);
    const charges = { ...saved.charges };
    const toReplay = { ...saved.charges };
    const realPush = Actor.pushData.bind(Actor);
    const realCharge = Actor.charge.bind(Actor);
    let dirty = 0;
    let migrating = false;

    const save = () => Actor.setValue(STATE_KEY, { rows: pushedRows, charges });
    const tick = async () => {
        dirty += 1;
        if (dirty >= SAVE_EVERY) {
            dirty = 0;
            await save();
        }
    };
    // Called between results, so the saved position is exact. The platform
    // stops this container shortly; carry on only if it does not.
    const pauseIfMigrating = async () => {
        if (!migrating) return;
        await save();
        await new Promise((resolve) => { setTimeout(resolve, 120000); });
        migrating = false;
    };

    Actor.on('migrating', () => { migrating = true; });
    Actor.on('persistState', save);

    Actor.pushData = async (data, ...rest) => {
        await pauseIfMigrating();
        const rows = (Array.isArray(data) ? data : [data]).filter((row) => {
            const hash = rowHash(row);
            const left = fromEarlierAttempt.get(hash) || 0;
            if (left > 0) {
                fromEarlierAttempt.set(hash, left - 1);
                return false;
            }
            pushedRows.push(hash);
            return true;
        });
        if (!rows.length) return undefined;
        const result = await realPush(Array.isArray(data) ? rows : rows[0], ...rest);
        await tick();
        return result;
    };

    Actor.charge = async (options, ...rest) => {
        const { eventName, count = 1 } = options;
        const replayed = Math.min(toReplay[eventName] || 0, count);
        if (replayed > 0) toReplay[eventName] -= replayed;
        const fresh = count - replayed;
        if (fresh === 0) return { eventChargeLimitReached: false, chargedCount: 0, chargeableWithinLimit: {} };
        charges[eventName] = (charges[eventName] || 0) + fresh;
        const result = await realCharge({ ...options, count: fresh }, ...rest);
        await tick();
        return result;
    };
}
