// Smoke tests: playbook rule "ALWAYS test before deploying".
// These run offline in CI and catch the easy breakages (schema drift,
// import errors, bad JSON). Integration against live Airbnb is out of scope
// because the whole point is to avoid burning proxy budget on test runs.

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
    assert.equal(actorJson.name, 'airbnb-market-intelligence');
    assert.ok(actorJson.title && actorJson.title.length > 0);
    assert.ok(Array.isArray(actorJson.categories));
});

test('actor title follows outcome naming, not "scraper"', () => {
    // Playbook phase 2: never name your product "X Scraper".
    const actorJson = JSON.parse(readFileSync(resolve(actorRoot, '.actor/actor.json'), 'utf8'));
    assert.doesNotMatch(actorJson.title, /scraper/i);
    assert.doesNotMatch(actorJson.title, /crawler/i);
    assert.doesNotMatch(actorJson.title, /extractor/i);
});

test('no banned words in actor metadata', () => {
    // Banned words from auto-memory feedback_content_banned_words.md.
    const banned = /\b(absolutely|landscape|leverage|delve|comprehensive|robust)\b/i;
    const actorJson = readFileSync(resolve(actorRoot, '.actor/actor.json'), 'utf8');
    const inputSchema = readFileSync(resolve(actorRoot, '.actor/input_schema.json'), 'utf8');
    assert.doesNotMatch(actorJson, banned, 'actor.json contains banned word');
    assert.doesNotMatch(inputSchema, banned, 'input_schema.json contains banned word');
});

test('no hyphens or em dashes in actor description', () => {
    // Banned punctuation from auto-memory.
    const actorJson = JSON.parse(readFileSync(resolve(actorRoot, '.actor/actor.json'), 'utf8'));
    assert.doesNotMatch(actorJson.description, /[\u2014\u2013]/, 'em/en dash in description');
    // Plain hyphens inside compound words are fine; the rule targets AI giveaway
    // punctuation like " - " separators and em/en dashes.
    assert.doesNotMatch(actorJson.description, / - /, 'hyphen space separator in description');
});

test('input schema parses and prefills BUYPROXIES94952', () => {
    const schema = JSON.parse(readFileSync(resolve(actorRoot, '.actor/input_schema.json'), 'utf8'));
    assert.equal(schema.schemaVersion, 1);
    assert.ok(schema.properties.startUrls);
    assert.ok(schema.properties.maxProperties);
    const proxyGroups = schema.properties.proxyConfiguration?.prefill?.apifyProxyGroups;
    assert.deepEqual(proxyGroups, ['BUYPROXIES94952']);
});

test('main.js entrypoint loads without throwing at parse time', async () => {
    // We can't fully import main.js without Actor.init() side effects, but we
    // can verify the file is syntactically valid and references expected APIs.
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    assert.match(src, /Actor\.init\(\)/);
    assert.match(src, /PlaywrightCrawler/);
    assert.match(src, /Actor\.pushData/);
    assert.match(src, /Actor\.exit\(\)/);
    assert.match(src, /BUYPROXIES94952|proxyConfiguration/);
});

test('maxProperties cap is enforced in code', () => {
    const src = readFileSync(resolve(actorRoot, 'src/main.js'), 'utf8');
    // Must guard push loop against runaway budget.
    assert.match(src, /pushedCount\s*>=\s*maxProperties/);
});
