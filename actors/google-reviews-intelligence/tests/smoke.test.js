// Smoke tests: playbook rule "ALWAYS test before deploying".
// Offline checks: schema validation, banned words, naming, code structure.

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
    assert.equal(actorJson.name, 'google-reviews-intelligence');
    assert.ok(actorJson.title && actorJson.title.length > 0);
    assert.ok(Array.isArray(actorJson.categories));
});

test('actor title follows outcome naming, not "scraper"', () => {
    const actorJson = JSON.parse(readFileSync(resolve(actorRoot, '.actor/actor.json'), 'utf8'));
    assert.doesNotMatch(actorJson.title, /scraper/i);
    assert.doesNotMatch(actorJson.title, /crawler/i);
    assert.doesNotMatch(actorJson.title, /extractor/i);
});

test('actor description is within Apify 300 char limit', () => {
    const actorJson = JSON.parse(readFileSync(resolve(actorRoot, '.actor/actor.json'), 'utf8'));
    assert.ok(actorJson.description.length <= 300, `description is ${actorJson.description.length} chars`);
});

test('no banned words in actor metadata', () => {
    const banned = /\b(absolutely|landscape|leverage|delve|comprehensive|robust)\b/i;
    const actorJson = readFileSync(resolve(actorRoot, '.actor/actor.json'), 'utf8');
    const inputSchema = readFileSync(resolve(actorRoot, '.actor/input_schema.json'), 'utf8');
    assert.doesNotMatch(actorJson, banned);
    assert.doesNotMatch(inputSchema, banned);
});

test('no em or en dashes in actor description', () => {
    const actorJson = JSON.parse(readFileSync(resolve(actorRoot, '.actor/actor.json'), 'utf8'));
    assert.doesNotMatch(actorJson.description, /[\u2014\u2013]/);
});

test('input schema parses and has expected fields', () => {
    const schema = JSON.parse(readFileSync(resolve(actorRoot, '.actor/input_schema.json'), 'utf8'));
    assert.equal(schema.schemaVersion, 1);
    assert.ok(schema.properties.placeUrls);
    assert.ok(schema.properties.maxReviews);
    assert.ok(schema.properties.sortBy);
    assert.ok(schema.properties.filterByRating);
    const proxyGroups = schema.properties.proxyConfiguration?.prefill?.apifyProxyGroups;
    assert.deepEqual(proxyGroups, ['RESIDENTIAL']);
});

test('sortBy enum matches documented values', () => {
    const schema = JSON.parse(readFileSync(resolve(actorRoot, '.actor/input_schema.json'), 'utf8'));
    const sortValues = schema.properties.sortBy.enum;
    for (const v of ['NEWEST', 'MOST_RELEVANT', 'HIGHEST_RATING', 'LOWEST_RATING']) {
        assert.ok(sortValues.includes(v), `missing sort option: ${v}`);
    }
});

test('filterByRating is a stringList (Apify schema rule: no enum on array items)', () => {
    const schema = JSON.parse(readFileSync(resolve(actorRoot, '.actor/input_schema.json'), 'utf8'));
    assert.equal(schema.properties.filterByRating.type, 'array');
    assert.equal(schema.properties.filterByRating.editor, 'stringList');
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /\/\^\[1-5\]\$\//);
});

test('main.js entrypoint has expected API calls', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /Actor\.init\(\)/);
    assert.match(src, /PlaywrightCrawler/);
    assert.match(src, /Actor\.pushData/);
    assert.match(src, /Actor\.exit\(\)/);
    assert.match(src, /Actor\.charge/);
    assert.match(src, /data-review-id/);
});

test('maxReviews cap is enforced per place', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /pushedPerPlace/);
    assert.match(src, /currentCount\s*>=\s*maxReviews/);
});

test('free tier constant matches README pricing', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /FREE_TIER_REVIEWS\s*=\s*100/);
});

test('placeKey derivation handles Maps place URLs and CID links', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /\/maps\/place\//);
    assert.match(src, /searchParams\.get\('cid'\)/);
});

test('banned content rules apply to main.js too (no em dashes)', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.doesNotMatch(src, /[\u2014\u2013]/);
});
