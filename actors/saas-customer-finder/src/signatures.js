// Technology signatures, precision-first. Each entry:
//   name, category
//   html:    lowercase substrings matched against homepage HTML
//   header:  [headerName, lowercase substring] pairs matched against response headers
//   cookie:  lowercase substrings matched against set-cookie names
// A technology is detected if ANY of its patterns match. Substrings are chosen
// to be vendor-hosted asset URLs, unique globals, or vendor headers, so a
// mention in prose does not trigger a false positive.

export const SIGNATURES = [
    // CMS
    { name: 'WordPress', category: 'cms', html: ['/wp-content/', '/wp-includes/', 'content="wordpress'] },
    { name: 'Drupal', category: 'cms', html: ['drupal.settings', '/sites/default/files/', 'content="drupal'], header: [['x-generator', 'drupal']] },
    { name: 'Joomla', category: 'cms', html: ['content="joomla', '/media/jui/'] },
    { name: 'Ghost', category: 'cms', html: ['content="ghost', '/ghost/assets/'], header: [['x-ghost-cache-status', '']] },
    { name: 'Squarespace', category: 'cms', html: ['static1.squarespace.com'], header: [['server', 'squarespace']] },
    { name: 'Wix', category: 'cms', html: ['static.parastorage.com', 'wix.com/website-builder'], header: [['x-wix-request-id', '']] },
    { name: 'Webflow', category: 'cms', html: ['assets.website-files.com', 'content="webflow'] },
    { name: 'Duda', category: 'cms', html: ['cdn.dudamobile.com', 'dudaone'] },
    { name: 'Weebly', category: 'cms', html: ['cdn2.editmysite.com'] },
    { name: 'TYPO3', category: 'cms', html: ['content="typo3', '/typo3conf/', '/typo3temp/'] },
    { name: 'Contentful', category: 'cms', html: ['ctfassets.net'] },
    { name: 'Sanity', category: 'cms', html: ['cdn.sanity.io'] },
    { name: 'Blogger', category: 'cms', html: ['content="blogger"'] },
    { name: 'HubSpot CMS', category: 'cms', html: ['content="hubspot"', '_hcms/'] },

    // Ecommerce
    { name: 'Shopify', category: 'ecommerce', html: ['cdn.shopify.com', 'shopify.theme'], header: [['x-shopify-stage', ''], ['x-shopid', '']] },
    { name: 'WooCommerce', category: 'ecommerce', html: ['/plugins/woocommerce/', 'woocommerce-page'] },
    { name: 'Magento', category: 'ecommerce', html: ['/static/version', 'mage/cookies', 'magento_'], cookie: ['x-magento-vary'] },
    { name: 'BigCommerce', category: 'ecommerce', html: ['cdn11.bigcommerce.com'] },
    { name: 'PrestaShop', category: 'ecommerce', html: ['prestashop = ', '/themes/classic/assets/'], cookie: ['prestashop-'] },
    { name: 'OpenCart', category: 'ecommerce', html: ['catalog/view/theme', 'index.php?route=common'] },
    { name: 'Salesforce Commerce Cloud', category: 'ecommerce', html: ['demandware.static', 'demandware.store'] },
    { name: 'Ecwid', category: 'ecommerce', html: ['app.ecwid.com'] },
    { name: 'Snipcart', category: 'ecommerce', html: ['cdn.snipcart.com'] },

    // Analytics
    { name: 'Google Analytics', category: 'analytics', html: ['googletagmanager.com/gtag/js', 'google-analytics.com/analytics.js', 'google-analytics.com/ga.js'] },
    { name: 'Google Tag Manager', category: 'analytics', html: ['googletagmanager.com/gtm.js', 'googletagmanager.com/ns.html'] },
    { name: 'Meta Pixel', category: 'analytics', html: ['fbevents.js', 'facebook.com/tr?'] },
    { name: 'Hotjar', category: 'analytics', html: ['static.hotjar.com'] },
    { name: 'Mixpanel', category: 'analytics', html: ['cdn.mxpnl.com', 'mixpanel.init'] },
    { name: 'Segment', category: 'analytics', html: ['cdn.segment.com/analytics.js'] },
    { name: 'Plausible', category: 'analytics', html: ['plausible.io/js/'] },
    { name: 'Fathom', category: 'analytics', html: ['cdn.usefathom.com'] },
    { name: 'Matomo', category: 'analytics', html: ['matomo.js', 'piwik.js'] },
    { name: 'Microsoft Clarity', category: 'analytics', html: ['clarity.ms/tag'] },
    { name: 'Amplitude', category: 'analytics', html: ['cdn.amplitude.com'] },
    { name: 'Heap', category: 'analytics', html: ['cdn.heapanalytics.com'] },
    { name: 'PostHog', category: 'analytics', html: ['posthog.init', 'i.posthog.com', 'us.posthog.com', 'eu.posthog.com'] },
    { name: 'Snowplow', category: 'analytics', html: ['snowplowanalytics', 'sp.js"'] },

    // Marketing, CRM and chat
    { name: 'HubSpot', category: 'marketing', html: ['js.hs-scripts.com', 'js.hsforms.net', 'js.hs-analytics.net'] },
    { name: 'Marketo', category: 'marketing', html: ['munchkin.js'] },
    { name: 'Mailchimp', category: 'marketing', html: ['chimpstatic.com', 'list-manage.com'] },
    { name: 'Klaviyo', category: 'marketing', html: ['static.klaviyo.com', 'klaviyo.js'] },
    { name: 'Intercom', category: 'marketing', html: ['widget.intercom.io', 'js.intercomcdn.com'] },
    { name: 'Drift', category: 'marketing', html: ['js.driftt.com'] },
    { name: 'Zendesk', category: 'marketing', html: ['static.zdassets.com'] },
    { name: 'Crisp', category: 'marketing', html: ['client.crisp.chat'] },
    { name: 'Tawk.to', category: 'marketing', html: ['embed.tawk.to'] },
    { name: 'LiveChat', category: 'marketing', html: ['cdn.livechatinc.com'] },
    { name: 'Freshchat', category: 'marketing', html: ['wchat.freshchat.com'] },
    { name: 'ActiveCampaign', category: 'marketing', html: ['trackcmp.net'] },
    { name: 'Pardot', category: 'marketing', html: ['pi.pardot.com', 'pardot.com/pd.js'] },
    { name: 'Tidio', category: 'marketing', html: ['code.tidio.co'] },
    { name: 'Gorgias', category: 'marketing', html: ['config.gorgias.chat'] },

    // JavaScript frameworks
    { name: 'Next.js', category: 'framework', html: ['__next_data__', '/_next/static/'] },
    { name: 'React', category: 'framework', html: ['data-reactroot', 'react-dom'] },
    { name: 'Nuxt', category: 'framework', html: ['__nuxt__', '/_nuxt/'] },
    { name: 'Vue.js', category: 'framework', html: ['data-v-app', 'vue.global.js', 'vue.runtime'] },
    { name: 'Angular', category: 'framework', html: ['ng-version='] },
    { name: 'Svelte', category: 'framework', html: ['svelte-h', 'data-sveltekit'] },
    { name: 'Gatsby', category: 'framework', html: ['___gatsby'] },
    { name: 'Remix', category: 'framework', html: ['__remixcontext'] },
    { name: 'Astro', category: 'framework', html: ['astro-island', 'data-astro-'] },
    { name: 'Ember.js', category: 'framework', html: ['ember-cli', 'data-ember-'] },
    { name: 'jQuery', category: 'framework', html: ['jquery.min.js', 'jquery.js', 'jquery-'] },
    { name: 'Bootstrap', category: 'framework', html: ['bootstrap.min.css', 'bootstrap.bundle', 'bootstrapcdn.com'] },
    { name: 'Alpine.js', category: 'framework', html: ['alpinejs', 'cdn.min.js" defer x-'] },
    { name: 'htmx', category: 'framework', html: ['htmx.org', 'htmx.min.js'] },

    // Hosting and CDN (mostly headers)
    { name: 'Cloudflare', category: 'hosting', header: [['server', 'cloudflare'], ['cf-ray', '']] },
    { name: 'Amazon CloudFront', category: 'hosting', header: [['x-amz-cf-id', ''], ['via', 'cloudfront']] },
    { name: 'Fastly', category: 'hosting', header: [['x-served-by', 'cache-'], ['x-fastly-request-id', '']] },
    { name: 'Akamai', category: 'hosting', header: [['server', 'akamai'], ['x-akamai-transformed', '']] },
    { name: 'Netlify', category: 'hosting', header: [['x-nf-request-id', ''], ['server', 'netlify']] },
    { name: 'Vercel', category: 'hosting', header: [['x-vercel-id', ''], ['server', 'vercel']] },
    { name: 'Fly.io', category: 'hosting', header: [['fly-request-id', '']] },
    { name: 'GitHub Pages', category: 'hosting', header: [['server', 'github.com']] },
    { name: 'Amazon S3', category: 'hosting', header: [['server', 'amazons3']] },
    { name: 'Render', category: 'hosting', header: [['x-render-origin-server', '']] },
    { name: 'Azure', category: 'hosting', header: [['x-azure-ref', '']] },
    { name: 'Kinsta', category: 'hosting', header: [['x-kinsta-cache', '']] },
    { name: 'WP Engine', category: 'hosting', header: [['x-powered-by', 'wp engine']] },
    { name: 'Pantheon', category: 'hosting', header: [['x-pantheon-styx-hostname', '']] },

    // Web servers and languages
    { name: 'Nginx', category: 'server', header: [['server', 'nginx']] },
    { name: 'Apache', category: 'server', header: [['server', 'apache']] },
    { name: 'Microsoft IIS', category: 'server', header: [['server', 'microsoft-iis']] },
    { name: 'LiteSpeed', category: 'server', header: [['server', 'litespeed']] },
    { name: 'Express', category: 'server', header: [['x-powered-by', 'express']] },
    { name: 'PHP', category: 'server', header: [['x-powered-by', 'php']], cookie: ['phpsessid'] },
    { name: 'ASP.NET', category: 'server', header: [['x-powered-by', 'asp.net'], ['x-aspnet-version', '']], cookie: ['asp.net_sessionid'] },
    { name: 'Laravel', category: 'server', cookie: ['laravel_session'] },
    { name: 'Django', category: 'server', cookie: ['csrftoken'] },
    { name: 'Phusion Passenger', category: 'server', header: [['x-powered-by', 'phusion passenger']] },

    // Payments
    { name: 'Stripe', category: 'payments', html: ['js.stripe.com'] },
    { name: 'PayPal', category: 'payments', html: ['paypal.com/sdk/js', 'paypalobjects.com'] },
    { name: 'Klarna', category: 'payments', html: ['x.klarnacdn.net', 'klarna.com/lib'] },
    { name: 'Afterpay', category: 'payments', html: ['portal.afterpay.com', 'static.afterpay.com'] },
    { name: 'Square', category: 'payments', html: ['js.squareup.com', 'web.squarecdn.com'] },
    { name: 'Razorpay', category: 'payments', html: ['checkout.razorpay.com'] },
    { name: 'Braintree', category: 'payments', html: ['js.braintreegateway.com'] },

    // Consent, security and misc
    { name: 'reCAPTCHA', category: 'security', html: ['google.com/recaptcha', 'recaptcha.net'] },
    { name: 'hCaptcha', category: 'security', html: ['hcaptcha.com/1/api.js'] },
    { name: 'Cloudflare Turnstile', category: 'security', html: ['challenges.cloudflare.com/turnstile'] },
    { name: 'Sentry', category: 'security', html: ['browser.sentry-cdn.com', 'sentry.init'] },
    { name: 'Cookiebot', category: 'security', html: ['consent.cookiebot.com'] },
    { name: 'OneTrust', category: 'security', html: ['cdn.cookielaw.org'] },
    { name: 'CookieYes', category: 'security', html: ['cdn-cookieyes.com'] },

    // Media and misc tools
    { name: 'YouTube embed', category: 'media', html: ['youtube.com/embed/', 'youtube-nocookie.com/embed/'] },
    { name: 'Vimeo embed', category: 'media', html: ['player.vimeo.com'] },
    { name: 'Wistia', category: 'media', html: ['fast.wistia.com', 'fast.wistia.net'] },
    { name: 'Google Fonts', category: 'media', html: ['fonts.googleapis.com'] },
    { name: 'Adobe Fonts', category: 'media', html: ['use.typekit.net'] },
    { name: 'Font Awesome', category: 'media', html: ['fontawesome.com', 'font-awesome'] },
    { name: 'Optimizely', category: 'testing', html: ['cdn.optimizely.com'] },
    { name: 'VWO', category: 'testing', html: ['dev.visualwebsiteoptimizer.com'] },
    { name: 'Algolia', category: 'search', html: ['algolianet.com', 'algolia.net/1/'] },
];
