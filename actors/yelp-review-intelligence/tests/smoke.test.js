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
    assert.equal(actorJson.name, 'yelp-review-intelligence');
    assert.ok(actorJson.title && actorJson.title.length > 0);
    assert.ok(Array.isArray(actorJson.categories));
});

test('actor title follows outcome naming', () => {
    const actorJson = JSON.parse(readFileSync(resolve(actorRoot, '.actor/actor.json'), 'utf8'));
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
    assert.ok(schema.properties.businessUrls);
    assert.ok(schema.properties.maxReviews);
    assert.ok(schema.properties.sortBy);
    assert.ok(schema.properties.language);
    const proxyGroups = schema.properties.proxyConfiguration?.prefill?.apifyProxyGroups;
    assert.deepEqual(proxyGroups, ['BUYPROXIES94952']);
});

test('sortBy enum includes all expected values', () => {
    const schema = JSON.parse(readFileSync(resolve(actorRoot, '.actor/input_schema.json'), 'utf8'));
    const sortValues = schema.properties.sortBy.enum;
    assert.ok(sortValues.includes('NEWEST_FIRST'));
    assert.ok(sortValues.includes('OLDEST_FIRST'));
    assert.ok(sortValues.includes('HIGHEST_RATED'));
    assert.ok(sortValues.includes('LOWEST_RATED'));
    assert.ok(sortValues.includes('ELITES'));
    assert.ok(sortValues.includes('MOST_HELPFUL'));
});

test('main.js entrypoint has expected API calls', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /Actor\.init\(\)/);
    assert.match(src, /PlaywrightCrawler/);
    assert.match(src, /Actor\.pushData/);
    assert.match(src, /Actor\.exit\(\)/);
    assert.match(src, /Actor\.charge/);
});

test('maxReviews cap is enforced in code', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /totalPushed\s*>=\s*maxReviews/);
});

test('free tier constant matches common pricing', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /FREE_TIER_REVIEWS\s*=\s*50/);
});

test('sort map covers every enum value', () => {
    const schema = JSON.parse(readFileSync(resolve(actorRoot, '.actor/input_schema.json'), 'utf8'));
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    for (const val of schema.properties.sortBy.enum) {
        assert.match(src, new RegExp(`${val}\\s*:`), `SORT_MAP missing ${val}`);
    }
});

test('block detection is implemented', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /detectBlock/);
    assert.match(src, /captcha/i);
});
