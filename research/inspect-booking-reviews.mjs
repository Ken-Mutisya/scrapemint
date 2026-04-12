// Dump the full GraphQL ReviewList response structure
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

let reviewData = null;
page.on('response', async (res) => {
    if (res.url().includes('graphql') && res.status() === 200) {
        try {
            const body = JSON.parse(res.request().postData() || '{}');
            if (body.operationName === 'ReviewList') {
                reviewData = await res.json();
            }
        } catch {}
    }
});

await page.goto('https://www.booking.com/hotel/us/ace-new-york.html#tab-reviews', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);

// Scroll to reviews to trigger load
await page.evaluate(() => {
    const el = document.querySelector('[data-testid="PropertyReviewsRegionBlock"]');
    if (el) el.scrollIntoView();
});
await page.waitForTimeout(5000);

if (reviewData) {
    writeFileSync('research/booking-review-sample.json', JSON.stringify(reviewData, null, 2));
    console.log('Saved review data to research/booking-review-sample.json');
    // Show first review structure
    const reviews = reviewData?.data?.reviewListFrontend?.reviews;
    if (reviews?.length > 0) {
        console.log('\nFirst review keys:', Object.keys(reviews[0]));
        console.log('\nFirst review:', JSON.stringify(reviews[0], null, 2).slice(0, 2000));
    }
    console.log('\nTotal reviews in response:', reviews?.length);
} else {
    console.log('No ReviewList response captured. Trying DOM fallback...');
}

await browser.close();
