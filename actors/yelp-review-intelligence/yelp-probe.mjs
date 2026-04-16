import { chromium } from 'playwright';

const session = `yelp${Date.now()}`;
const proxyUser = `groups-RESIDENTIAL,session-${session}`;

const browser = await chromium.launch({
    headless: false,
    proxy: {
        server: 'http://proxy.apify.com:8000',
        username: proxyUser,
        password: process.env.APIFY_PROXY_PASSWORD,
    },
    args: ['--disable-blink-features=AutomationControlled'],
});
const context = await browser.newContext({
    viewport: { width: 1366, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    locale: 'en-US',
});

await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
});

const page = await context.newPage();
try {
    const resp = await page.goto('https://www.yelp.com/biz/the-halal-guys-new-york', { waitUntil: 'domcontentloaded', timeout: 45000 });
    console.log('status:', resp?.status());
    console.log('title:', await page.title());
    const html = await page.content();
    console.log('html size:', html.length);
    console.log('has DataDome blocker:', /var dd=.*'cid'/i.test(html));
    console.log('has reviews string:', /review/i.test(html));
    console.log('has h1:', /<h1/i.test(html));
    console.log('first 300 chars:', html.slice(0, 300).replace(/\n/g, ' '));
} catch (err) {
    console.log('nav error:', err.message);
}
await page.waitForTimeout(6000);
await browser.close();
