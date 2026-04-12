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
    assert.equal(actorJson.name, 'trustpilot-brand-reputation');
    assert.ok(actorJson.title && actorJson.title.length > 0);
    assert.ok(Array.isArray(actorJson.categories));
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

test('no em dashes in actor description', () => {
    const actorJson = JSON.parse(readFileSync(resolve(actorRoot, '.actor/actor.json'), 'utf8'));
    assert.doesNotMatch(actorJson.description, /[\u2014\u2013]/, 'em/en dash in description');
});

test('input schema parses and has expected fields', () => {
    const schema = JSON.parse(readFileSync(resolve(actorRoot, '.actor/input_schema.json'), 'utf8'));
    assert.equal(schema.schemaVersion, 1);
    assert.ok(schema.properties.businessUrls);
    assert.ok(schema.properties.maxReviews);
    assert.ok(schema.properties.sortBy);
    assert.ok(schema.properties.filterByStars);
    const proxyGroups = schema.properties.proxyConfiguration?.prefill?.apifyProxyGroups;
    assert.deepEqual(proxyGroups, ['BUYPROXIES94952']);
});

test('sortBy enum matches Trustpilot URL values', () => {
    const schema = JSON.parse(readFileSync(resolve(actorRoot, '.actor/input_schema.json'), 'utf8'));
    const sortValues = schema.properties.sortBy.enum;
    assert.ok(sortValues.includes('NEWEST_FIRST'));
    assert.ok(sortValues.includes('MOST_RELEVANT'));
});

test('filterByStars is a stringList (Apify schema rule: no enum on array items)', () => {
    const schema = JSON.parse(readFileSync(resolve(actorRoot, '.actor/input_schema.json'), 'utf8'));
    assert.equal(schema.properties.filterByStars.type, 'array');
    assert.equal(schema.properties.filterByStars.editor, 'stringList');
    // Validation happens at runtime in main.js, not in the schema.
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /new Set\(\['1', '2', '3', '4', '5'\]\)/);
});

test('main.js entrypoint has expected API calls', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /Actor\.init\(\)/);
    assert.match(src, /PlaywrightCrawler/);
    assert.match(src, /Actor\.pushData/);
    assert.match(src, /Actor\.exit\(\)/);
    assert.match(src, /Actor\.charge/);
    assert.match(src, /__NEXT_DATA__/);
    assert.match(src, /pageProps\?\.reviews/);
});

test('maxReviews cap is enforced per business', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /pushedPerBusiness/);
    assert.match(src, /currentCount\s*>=\s*reviewCap/);
});

test('free tier constant matches README pricing', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /FREE_TIER_REVIEWS\s*=\s*100/);
});

test('pagination URL builder uses recency and relevance', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /'recency'/);
    assert.match(src, /'relevance'/);
    assert.match(src, /searchParams\.set\('page'/);
});
