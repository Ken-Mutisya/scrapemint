import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

test('package.json is valid and declares expected deps', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'upwork-opportunity-alert');
    assert.equal(pkg.type, 'module');
    assert.ok(pkg.dependencies.apify);
    assert.ok(pkg.dependencies['got-scraping']);
    assert.ok(!pkg.dependencies.playwright, 'playwright should have been removed');
});

test('actor.json title and description meet Apify length limits', () => {
    const actor = JSON.parse(readFileSync(join(root, '.actor/actor.json'), 'utf8'));
    assert.equal(actor.name, 'upwork-opportunity-alert');
    assert.ok(actor.title.length <= 100, `title length ${actor.title.length} exceeds 100`);
    assert.ok(actor.description.length <= 300, `description length ${actor.description.length} exceeds 300`);
    assert.ok(Array.isArray(actor.categories) && actor.categories.length > 0);
});

test('input_schema declares required sessionCookies and feed enum', () => {
    const schema = JSON.parse(readFileSync(join(root, '.actor/input_schema.json'), 'utf8'));
    assert.ok(schema.required?.includes('sessionCookies'), 'sessionCookies must be required');
    const feedEnum = schema.properties.feed.enum;
    for (const v of ['BEST_MATCHES', 'MOST_RECENT', 'BOTH']) {
        assert.ok(feedEnum.includes(v), `feed enum missing ${v}`);
    }
});

test('main.js parses without syntax errors', async () => {
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, ['--check', join(root, 'src/main.js')]);
});
