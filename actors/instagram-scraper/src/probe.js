import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const url = input.url || 'https://www.instagram.com/humansofny/';
const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 120,
    maxRequestRetries: 1,
    async requestHandler({ page, request }) {
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(3000);
        for (let i = 0; i < 4; i++) {
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.2));
            await page.waitForTimeout(1200);
        }
        const diag = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href]')).map((a) => a.href);
            const postLinks = links.filter((h) => /\/(p|reel)\//.test(h)).slice(0, 5);
            return {
                title: document.title,
                finalUrl: window.location.href,
                postLinkCount: postLinks.length,
                postLinksSample: postLinks,
                dataE2E: [...new Set(Array.from(document.querySelectorAll('[data-testid]')).slice(0, 20).map((n) => n.getAttribute('data-testid')))],
                loginBoxVisible: !!document.querySelector('input[name="username"]'),
                hasHeader: !!document.querySelector('header'),
                bodyTextLen: document.body.innerText.length,
                bodyTextSample: document.body.innerText.slice(0, 300),
            };
        });
        log.info(`DIAG: ${JSON.stringify(diag, null, 2)}`);
    },
    failedRequestHandler({ error }) {
        log.warning(`Failed: ${error?.message}`);
    },
});
await crawler.addRequests([{ url }]);
await crawler.run();
await Actor.exit();
