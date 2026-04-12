// Smoke tests: playbook rule "ALWAYS test before deploying".
// Offline tests: schema validation, banned words, code structure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const actorRoot = resolve(here, '..');

test('actor.json parses and has required fields', () => {
    const actorJson = JSON.parse(readFileSync(resolve(actorRoot, '.actor/actor.json'), 'utf8'));
    assert.equal(actorJson.actorSpecification, 1);
    assert.equal(actorJson.name, 'booking-review-intelligence');
    assert.ok(actorJson.title && actorJson.title.length > 0);
    assert.ok(Array.isArray(actorJson.categories));
    assert.ok(actorJson.categories.includes('TRAVEL'));
});

test('actor title follows outcome naming, not "scraper"', () => {
    const actorJson = JSON.parse(readFileSync(resolve(actorRoot, '.actor/actor.json'), 'utf8'));
    assert.doesNotMatch(actorJson.title, /scraper/i);
    assert.doesNotMatch(actorJson.title, /crawler/i);
    assert.doesNotMatch(actorJson.title, /extractor/i);
});

test('no banned words in actor metadata', () => {
    const banned = /\b(absolutely|landscape|leverage|delve|comprehensive|robust)\b/i;
    const actorJson = readFileSync(resolve(actorRoot, '.actor/actor.json'), 'utf8');
    const inputSchema = readFileSync(resolve(actorRoot, '.actor/input_schema.json'), 'utf8');
    assert.doesNotMatch(actorJson, banned, 'actor.json contains banned word');
    assert.doesNotMatch(inputSchema, banned, 'input_schema.json contains banned word');
});

test('no hyphens or em dashes in actor description', () => {
    const actorJson = JSON.parse(readFileSync(resolve(actorRoot, '.actor/actor.json'), 'utf8'));
    assert.doesNotMatch(actorJson.description, /[\u2014\u2013]/, 'em/en dash in description');
    assert.doesNotMatch(actorJson.description, / - /, 'hyphen space separator in description');
});

test('input schema parses and has expected fields', () => {
    const schema = JSON.parse(readFileSync(resolve(actorRoot, '.actor/input_schema.json'), 'utf8'));
    assert.equal(schema.schemaVersion, 1);
    assert.ok(schema.properties.hotelUrls);
    assert.ok(schema.properties.maxReviews);
    assert.ok(schema.properties.sortBy);
    assert.ok(schema.properties.travelerType);
    const proxyGroups = schema.properties.proxyConfiguration?.prefill?.apifyProxyGroups;
    assert.deepEqual(proxyGroups, ['BUYPROXIES94952']);
});

test('sortBy enum matches Booking.com API values', () => {
    const schema = JSON.parse(readFileSync(resolve(actorRoot, '.actor/input_schema.json'), 'utf8'));
    const sortValues = schema.properties.sortBy.enum;
    assert.ok(sortValues.includes('NEWEST_FIRST'));
    assert.ok(sortValues.includes('OLDEST_FIRST'));
    assert.ok(sortValues.includes('MOST_RELEVANT'));
    assert.ok(sortValues.includes('SCORE_DESC'));
    assert.ok(sortValues.includes('SCORE_ASC'));
});

test('travelerType enum matches Booking.com API values', () => {
    const schema = JSON.parse(readFileSync(resolve(actorRoot, '.actor/input_schema.json'), 'utf8'));
    const types = schema.properties.travelerType.enum;
    assert.ok(types.includes('ALL'));
    assert.ok(types.includes('FAMILIES'));
    assert.ok(types.includes('COUPLES'));
    assert.ok(types.includes('SOLO_TRAVELLERS'));
    assert.ok(types.includes('BUSINESS_TRAVELLERS'));
});

test('main.js entrypoint has expected API calls', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /Actor\.init\(\)/);
    assert.match(src, /PlaywrightCrawler/);
    assert.match(src, /Actor\.pushData/);
    assert.match(src, /Actor\.exit\(\)/);
    assert.match(src, /Actor\.charge/);
    assert.match(src, /ReviewList/);
    assert.match(src, /reviewListFrontend/);
});

test('maxReviews cap is enforced in code', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /totalPushed\s*>=\s*targetCount/);
});

test('free tier constant matches README pricing', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /FREE_TIER_REVIEWS\s*=\s*50/);
});
