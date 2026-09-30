// DNS signatures: what a company's own DNS says it has signed up for.
//
// SaaS vendors make a customer prove domain ownership by publishing a TXT
// record, and every email sender has to be listed in SPF. Those records are
// public, so they reveal internal tools a homepage never shows (Atlassian,
// DocuSign, OpenAI, Slack) as well as the email stack. Each entry:
//   txt: lowercase prefixes matched against the start of a TXT record
//   spf: lowercase substrings matched inside the v=spf1 record
//   mx:  lowercase substrings matched against MX exchange hosts
// Patterns are vendor verification tokens and vendor hostnames, so a match is
// a record the company published on purpose, not a guess.

export const DNS_SIGNATURES = [
    // Collaboration and productivity
    { name: 'Atlassian', category: 'collaboration', txt: ['atlassian-domain-verification'], spf: ['_spf.atlassian.net'] },
    { name: 'Slack', category: 'collaboration', txt: ['slack-domain-verification'] },
    { name: 'Zoom', category: 'collaboration', txt: ['zoom-domain-verification', 'zoom_verify_'] },
    { name: 'Webex', category: 'collaboration', txt: ['webexdomainverification', 'cisco-ci-domain-verification'] },
    { name: 'Miro', category: 'collaboration', txt: ['miro-verification'] },
    { name: 'Dropbox', category: 'collaboration', txt: ['dropbox-domain-verification'] },
    { name: 'Box', category: 'collaboration', txt: ['box-domain-verification'] },
    { name: 'Smartsheet', category: 'collaboration', txt: ['smartsheet-site-validation'] },
    { name: 'Airtable', category: 'collaboration', txt: ['airtable-verification'] },
    { name: 'Canva', category: 'collaboration', txt: ['canva-site-verification'] },
    { name: 'Whimsical', category: 'collaboration', txt: ['whimsical='] },
    { name: 'Workplace from Meta', category: 'collaboration', txt: ['workplace-domain-verification'] },
    { name: 'DocuSign', category: 'collaboration', txt: ['docusign='] },
    { name: 'Adobe', category: 'collaboration', txt: ['adobe-idp-site-verification', 'adobe-sign-verification'] },

    // Engineering and AI
    { name: 'Linear', category: 'engineering', txt: ['linear-domain-verification'] },
    { name: 'Postman', category: 'engineering', txt: ['postman-domain-verification'] },
    { name: 'Docker', category: 'engineering', txt: ['docker-verification'] },
    { name: 'Cursor', category: 'engineering', txt: ['cursor-domain-verification'] },
    { name: 'MongoDB Atlas', category: 'engineering', txt: ['mongodb-site-verification'] },
    { name: 'Dynatrace', category: 'engineering', txt: ['dynatrace-site-verification'] },
    { name: 'Vercel', category: 'hosting', txt: ['vercel-domain-verification'] },
    { name: 'Fastly', category: 'cdn', txt: ['fastly-domain-delegation'] },
    { name: 'OpenAI', category: 'ai', txt: ['openai-domain-verification'] },
    { name: 'Anthropic', category: 'ai', txt: ['anthropic-domain-verification'] },
    { name: 'ElevenLabs', category: 'ai', txt: ['elevenlabs='] },

    // Security and IT
    { name: 'HackerOne', category: 'security', txt: ['h1-domain-verification'] },
    { name: 'KnowBe4', category: 'security', txt: ['knowbe4-site-verification'] },
    { name: 'Jamf', category: 'security', txt: ['jamf-site-verification'] },
    { name: 'TeamViewer', category: 'security', txt: ['teamviewer-sso-verification'] },
    { name: 'GlobalSign', category: 'security', txt: ['globalsign-domain-verification', '_globalsign-domain-verification'] },
    { name: 'Citrix', category: 'security', txt: ['citrix-verification-code'] },
    { name: 'GoTo (LogMeIn)', category: 'security', txt: ['logmein-verification-code'] },
    { name: 'OneTrust', category: 'privacy', txt: ['onetrust-domain-verification'] },
    { name: 'Proofpoint', category: 'email-security', spf: ['pphosted.com'], mx: ['pphosted.com'] },
    { name: 'Mimecast', category: 'email-security', spf: ['mimecast'], mx: ['mimecast'] },
    { name: 'Barracuda', category: 'email-security', mx: ['barracudanetworks.com'] },

    // Email hosting
    { name: 'Google Workspace', category: 'email-hosting', spf: ['_spf.google.com'], mx: ['aspmx.l.google.com', 'googlemail.com', 'smtp.google.com'] },
    { name: 'Microsoft 365', category: 'email-hosting', txt: ['ms='], spf: ['spf.protection.outlook.com'], mx: ['mail.protection.outlook.com'] },
    { name: 'Zoho Mail', category: 'email-hosting', txt: ['zoho-verification'], spf: ['zoho.com', 'zohomail'], mx: ['zoho.com', 'zoho.eu', 'zoho.in'] },
    { name: 'Proton Mail', category: 'email-hosting', txt: ['protonmail-verification'], mx: ['protonmail.ch'] },

    // Sales, marketing and support (merged with the homepage signatures of the same name)
    { name: 'Salesforce', category: 'crm', spf: ['_spf.salesforce.com'] },
    { name: 'HubSpot', category: 'marketing', spf: ['hubspotemail.net'] },
    { name: 'Marketo', category: 'marketing', spf: ['mktomail.com'] },
    { name: 'Mailchimp', category: 'marketing', spf: ['servers.mcsv.net', 'spf.mandrillapp.com'] },
    { name: 'Brevo', category: 'marketing', txt: ['brevo-code:', 'sendinblue-code:'], spf: ['spf.brevo.com', 'spf.sendinblue.com'] },
    { name: 'Campaign Monitor', category: 'marketing', spf: ['_spf.createsend.com'] },
    { name: 'Constant Contact', category: 'marketing', spf: ['spf.constantcontact.com'] },
    { name: 'Segment', category: 'analytics', txt: ['segment-site-verification'] },
    { name: 'Ahrefs', category: 'marketing', txt: ['ahrefs-site-verification'] },
    { name: 'LiveRamp', category: 'marketing', txt: ['liveramp-site-verification'] },
    { name: 'Meta Business', category: 'marketing', txt: ['facebook-domain-verification'] },
    { name: 'Pinterest Business', category: 'marketing', txt: ['pinterest-site-verification'] },
    { name: 'Apple Business', category: 'marketing', txt: ['apple-domain-verification'] },
    { name: 'Zendesk', category: 'support', spf: ['mail.zendesk.com'] },
    { name: 'Freshdesk', category: 'support', spf: ['email.freshdesk.com'] },
    { name: 'Help Scout', category: 'support', spf: ['helpscoutemail.com'] },
    { name: 'Intercom', category: 'support', spf: ['mail.intercom.io'] },
    { name: 'Qualtrics', category: 'support', spf: ['qualtrics.com'] },
    { name: 'Greenhouse', category: 'hr', spf: ['greenhouse'] },
    { name: 'NetSuite', category: 'finance', spf: ['netsuite.com'] },
    { name: 'Stripe', category: 'payments', txt: ['stripe-verification'], spf: ['stripe.com'] },
    { name: 'Twilio', category: 'engineering', txt: ['twilio-domain-verification'] },

    // Transactional email
    { name: 'Amazon SES', category: 'email-delivery', txt: ['amazonses:'], spf: ['amazonses.com'] },
    { name: 'SendGrid', category: 'email-delivery', spf: ['sendgrid.net'] },
    { name: 'Mailgun', category: 'email-delivery', spf: ['mailgun.org'] },
    { name: 'Postmark', category: 'email-delivery', spf: ['spf.mtasv.net'] },
    { name: 'SparkPost', category: 'email-delivery', spf: ['sparkpostmail.com'] },
];

// What buyers type, mapped to the name a signature carries.
export const ALIASES = {
    jira: 'Atlassian', confluence: 'Atlassian', bitbucket: 'Atlassian',
    chatgpt: 'OpenAI', 'chatgpt enterprise': 'OpenAI', claude: 'Anthropic',
    'office 365': 'Microsoft 365', o365: 'Microsoft 365', outlook: 'Microsoft 365', 'microsoft outlook': 'Microsoft 365',
    'g suite': 'Google Workspace', gsuite: 'Google Workspace', gmail: 'Google Workspace',
    zoho: 'Zoho Mail', protonmail: 'Proton Mail', proton: 'Proton Mail',
    sendinblue: 'Brevo', mandrill: 'Mailchimp', ses: 'Amazon SES', 'aws ses': 'Amazon SES',
    facebook: 'Meta Business', 'facebook pixel': 'Meta Pixel', logmein: 'GoTo (LogMeIn)', goto: 'GoTo (LogMeIn)',
    docusign: 'DocuSign', 'hub spot': 'HubSpot', sfdc: 'Salesforce', mongodb: 'MongoDB Atlas',
    'google analytics 4': 'Google Analytics', ga4: 'Google Analytics', gtm: 'Google Tag Manager',
};
