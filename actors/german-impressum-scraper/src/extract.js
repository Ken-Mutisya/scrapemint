// Impressum parsing: HTML to text lines, link discovery and field extraction.
// Kept apart from main.js so it can be tested without the Apify runtime.

// ---------- HTML to text ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', copy: '©', reg: '®', sect: '§', ndash: '–', mdash: '—', middot: '·', bull: '•', shy: '', zwnj: '', euro: '€', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', commat: '@', period: '.', ccedil: 'ç', agrave: 'à', ocirc: 'ô' };
export const decode = (s) => s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => (n in ENT ? ENT[n] : m));

function cfDecode(hex) {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
}

export function toLines(html) {
    let h = html
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style|noscript|svg|template|iframe|select)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<a[^>]+data-cfemail="([0-9a-f]+)"[^>]*>[\s\S]*?<\/a>/gi, (_, x) => cfDecode(x))
        .replace(/<[^>]+data-cfemail="([0-9a-f]+)"[^>]*>[\s\S]*?<\/[a-z]+>/gi, (_, x) => cfDecode(x))
        .replace(/<a[^>]+href=["']mailto:([^"'?]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi, (m, mail, inner) => {
            const t = inner.replace(/<[^>]+>/g, '').trim();
            return /@|\[at\]|\(at\)/i.test(t) ? t : `${t} ${decode(decodeURIComponent(mail))}`;
        })
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?(p|div|li|ul|ol|tr|table|h[1-6]|section|article|header|footer|address|dd|dt|dl|blockquote|figure|main|aside|nav|span class="?(?:line|row)[^>]*)\b[^>]*>/gi, '\n')
        .replace(/<\/?(td|th)\b[^>]*>/gi, ' | ')
        .replace(/<[^>]+>/g, ' ');
    h = decode(h);
    if (/&(?:amp;)?[a-z]+;?/i.test(h)) h = decode(h).replace(/&nbsp;?/gi, ' ');
    return h.split('\n').map((l) => l.replace(/[​­]/g, '').replace(/[ \t ]+/g, ' ').replace(/^\s*\|\s*|\s*\|\s*$/g, '').trim()).filter(Boolean);
}

// ---------- finding the Impressum ----------
export function findImpressumLink(html, base) {
    const links = [];
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        const href = m[1].trim();
        if (/^(mailto|tel|javascript):/i.test(href)) continue;
        const text = decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
        let score = 0;
        if (/^impressum$/i.test(text)) score = 10;
        else if (/^(imprint|legal notice|site notice|anbieterkennzeichnung|impressum\s*[&|/·•-]\s*datenschutz)$/i.test(text)) score = 9;
        else if (/impressum/i.test(text)) score = 8;
        else if (/impressum/i.test(href)) score = 7;
        else if (/imprint|legal[-_ ]?notice|anbieterkennzeichnung/i.test(text + ' ' + href)) score = 5;
        else if (/^(legal|rechtliches|legal information)$/i.test(text)) score = 2;
        if (!score) continue;
        try {
            const u = new URL(decode(href), base);
            if (!/^https?:$/.test(u.protocol)) continue;
            links.push({ url: u.toString(), score, sameHost: u.hostname.replace(/^www\./, '') === new URL(base).hostname.replace(/^www\./, '') });
        } catch { /* bad href */ }
    }
    links.sort((a, b) => (b.sameHost - a.sameHost) || (b.score - a.score));
    return links[0]?.url || null;
}

export const LEGAL_MARKER = /Angaben gem(?:ä|ae)ss?\s*§\s*5|§\s*5\s*(?:TMG|DDG|ECG)|Anbieterkennzeichnung|Diensteanbieter|Registergericht|Handelsregister|USt\.?-?Id|Umsatzsteuer-?Ident|Geschäftsführ|Vertretungsberechtigt|Inhaber(?:in)?:|Verantwortlich (?:für den Inhalt|i\.?\s?S\.?\s?d\.?)/i;

// ---------- field extraction ----------
const LEGAL_FORM = /\b(GmbH\s*&\s*Co\.?\s*KGaA|GmbH\s*&\s*Co\.?\s*KG|AG\s*&\s*Co\.?\s*KG|SE\s*&\s*Co\.?\s*KGaA|SE\s*&\s*Co\.?\s*KG|UG\s*&\s*Co\.?\s*KG|(?:in\s)?Partnerschaft\s*mbB|UG\s*\(haftungsbeschränkt\)(?:\s*&\s*Co\.?\s*KG)?|gGmbH|GmbH|Ges\.?\s?m\.\s?b\.\s?H\.?|GesmbH|m\.\s?b\.\s?H\.?|mbH|PartG\s*mbB|PartG|Partnerschaftsgesellschaft(?:\s*mbB)?|KGaA|Aktiengesellschaft|Kommanditgesellschaft|AG|SE|OHG|KG|GbR|e\.\s?K\.|e\.\s?Kfm\.|e\.\s?Kfr\.|e\.\s?V\.|eG|Ltd\.?|LLC|Inc\.?|S\.à\s?r\.l\.|Sàrl|Stiftung|Genossenschaft|Einzelunternehmen)(?=$|[\s,.;)|])/;
const NOT_NAME = /^(sitz|registergericht|handelsregister|amtsgericht|ust|umsatzsteuer|steuer|geschäftsführ|vertreten|vorstand|aufsichtsrat|inhaber|tel|fax|e-?mail|copyright|©|http|www\.|verantwortlich|haftung|datenschutz|quelle|bildnachweis|registernummer|hrb|hra|eingetragen|persönlich haftend|komplementär|berufs|zuständig|kammer|this|the|our|wir|unsere|die |der |das |mit |für |bei |angaben|impressum|kontakt|anschrift|adresse|postanschrift|streitschlichtung|plattform|verbraucher)/i;
const PLZ_CITY = /(?:^|[\s,|])(?:(D|DE|A|AT|CH)[-\s])?(\d{4,5})\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüßéèàâ.\-/() ]{1,40}?)\s*(?:$|[,|;]|\s{2}|\s+(?:Deutschland|Germany|Österreich|Austria|Schweiz|Switzerland)\b)/;
const STREET = /([A-ZÄÖÜ][\wÄÖÜäöüß.'\- ]{1,50}?(?:stra(?:ß|ss)e|str\.|weg|gasse|platz|allee|ring|damm|ufer|chaussee|steig|pfad|markt|hof|berg|feld|garten|park|brücke|kai|wall|graben|tor|zeile|promenade|Straße|Weg|Gasse|Platz|Allee|Ring|Damm)\.?\s*\d+[\s\-–/]*[a-zA-Z]?(?:\s*[-–]\s*\d+[a-zA-Z]?)?)/;
const STREET_LOOSE = /^([A-ZÄÖÜ][\wÄÖÜäöüß.'\- ]{2,50}?\s\d{1,4}\s*[a-zA-Z]?(?:\s*[-–/]\s*\d{1,4}[a-zA-Z]?)?)(?:$|,)/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/i;
const PHONE_RE = /(?:^|\b)(?:Tel(?:efon)?|Fon|Phone|Telephone|T|Mobil|Handy|Mobile)\.?\s*(?:Nr\.?)?\s*[:.]?\s*((?:\+|00|\(?0)[\d\s/().\-–]{6,22}\d)/i;
const FAX_RE = /(?:^|\b)(?:Tele)?fax\.?\s*(?:Nr\.?)?\s*[:.]?\s*((?:\+|00|\(?0)[\d\s/().\-–]{6,22}\d)/i;
const VAT_RE = /\b(DE\s?\d{3}\s?\d{3}\s?\d{3}|ATU\s?\d{8}|CHE[-\s]?\d{3}[.\s]?\d{3}[.\s]?\d{3}(?:\s?(?:MWST|TVA|IVA|VAT))?)\b/;
const REG_RE = /\b(HRB|HRA|VR|PR|GnR|GsR|PartR)\s*[:.]?\s*(?:Nr\.?\s*)?(\d{1,7}(?:\s?B\b)?)/;
const FN_RE = /\b(?:FN|Firmenbuchnummer)\s*[:.]?\s*(\d{1,7}\s?[a-z])\b/i;
const CH_UID = /\b(CHE[-\s]?\d{3}[.\s]?\d{3}[.\s]?\d{3})\b/;
const COURT_RE = /(?:Amtsgericht|Registergericht|Handelsregister(?:gericht)?|Partnerschaftsregister|Vereinsregister|Firmenbuchgericht|Registered at|Register court)\s*[:.(]?\s*(?:beim\s+|des\s+|im\s+)?(?:Amtsgericht(?:s)?\s+|AG\s+|Landesgericht\s+|Handelsgericht\s+|Partnerschaftsregister\s+)?((?:Bad\s)?[A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)?(?:\s(?:am|an der|im|in der|ob der|vor der|i\.\s?)\s?[A-ZÄÖÜ][a-zäöüß.]+|\s?\((?:Main|Oder|Saale|Elbe|Breisgau|Westf\.|Oberpfalz|Rhein)\)|\sam\sMain)?)/;
const COURT_STOP = /^(?:Nr|Nummer|Eintragung|Eingetragen|Registernummer|Register|Handelsregister|Handelregisternummer|Sitz|Abteilung|Teil|Unter|Der|Die|Das|Vertreten|Vertretungsberechtigt\w*|Geschäftsführ\w*|Umsatzsteuer\w*|Steuer\w*|Systemzentrale|Hauptsitz|Gesellschaft|Partnerschaftsregister|Amtsgericht)$/;
const DIRECTOR_LABEL = /^(?:[\wÄÖÜäöü ]{0,30}:\s*)?(?:(?:Diese|Sie|Jeweils|Ebenfalls|Die Gesellschaft wird)\s+)?(?:(?:Die\s)?Geschäftsführ(?:er(?:in|innen)?|ung|ende\sGesellschafter(?:in)?)|Vertretungsberechtigte(?:r)?\s(?:Geschäftsführer(?:in)?|Gesellschafter(?:in)?|Person(?:en)?|Vorstand)|[Vv]ertreten\s(?:durch|wird die .{3,40}? durch)(?:\s(?:den|die|das)\s(?:Geschäftsführer(?:in)?|Vorstand|Inhaber(?:in)?|Präsident(?:in)?|Vorsitzende[nr]?))?|Vorstand(?:svorsitzende[r]?)?|Inhaber(?:in)?|Geschäftsinhaber(?:in)?|Praxisinhaber(?:in)?|Gesellschafter(?:in)?|Managing Directors?|Executive Board|Represented by|Owner|Komplementär(?:in)?|Partner)\b\s*[:.]?\s*(.*)$/i;
const RESP_LABEL = /(?:Verantwortlich(?:e[r]?)?\s(?:für den Inhalt|für redaktionelle Inhalte|i\.?\s?S\.?\s?d\.?|im Sinne|gem(?:äß|\.|aess)|nach)[^:]{0,60}|V\.?\s?i\.?\s?S\.?\s?d\.?\s?P\.?|Inhaltlich verantwortlich[^:]{0,40})\s*:?\s*(.*)$/i;
const TAXNO_RE = /Steuer(?:nummer|-?Nr\.?)\s*[:.]?\s*(\d{2,3}\s?\/\s?\d{3,4}\s?\/\s?\d{4,5}|\d{10,13})/i;
const PROF_RE = /(?:Berufsbezeichnung|Gesetzliche Berufsbezeichnung)\s*[:.]?\s*(.+)$/i;
const CHAMBER_RE = /(?:Zuständige\s(?:Kammer|Aufsichtsbehörde|Berufskammer|Zahnärztekammer|Ärztekammer|Rechtsanwaltskammer|Steuerberaterkammer|Handwerkskammer)|Aufsichtsbehörde|(?:Mitglied (?:der|in der))\s(?:[\wäöü]+kammer))\s*[:.]?\s*(.+)$/i;

const clip = (s, n = 200) => (s ? s.replace(/\s+/g, ' ').replace(/^[\s:,.;|–-]+|[\s,;|–-]+$/g, '').slice(0, n) || null : null);

const TITLE_PREFIX = /^(?:(?:Herr|Frau|Hr\.|Fr\.|Mr\.?|Ms\.?|Mrs\.?|Prof\.?|Dr\.?(?:\s?(?:med|dent|rer|nat|jur|oec|pol|phil|vet|ing|h\.?\s?c)\.?(?:\s?(?:dent|nat|pol|oec)\.)?)*|Dipl\.?[-\s]?[\wäöü]*\.?|Ing\.?|Kfm\.?|Kffr\.?|Betriebsw\.?|Finanzwirt(?:in)?|Volkswirt(?:in)?|Steuerberater(?:in)?|Rechtsanwalt|Rechtsanwältin|RAin|RA|StBin|StB|WPin|WP|Wirtschaftsprüfer(?:in)?|Zahnarzt|Zahnärztin|Architekt(?:in)?|Notar(?:in)?|Arzt|Ärztin|Mag\.?|MBA|LL\.?\s?M\.?|M\.?\s?A\.?|B\.?\s?A\.?|M\.?\s?Sc\.?|B\.?\s?Sc\.?|M\.?\s?Eng\.?)\s*(?:\(\w+\))?\s+)+/i;
const PERSON = /^[A-ZÄÖÜ][a-zäöüßéèáçñ'-]+(?:\s+(?:[A-ZÄÖÜ]\.|von|van|de|der|den|zu|del|la|le|di|von der|van der))*(?:\s+[A-ZÄÖÜ][\wäöüßéèáçñ'-]+){1,3}$/;

export function personNames(s) {
    if (!s) return [];
    return s
        .replace(/\((?:FH|BA|TU|Uni|DHBW|IHK|HWK)\)/gi, ' ')
        .split(/\s*(?:,|;|\/|\||\bund\b|\band\b|&|\bsowie\b)\s*/)
        .map((x) => x.replace(/\(.*?\)/g, ' ').replace(/\s*[-–]\s*(?:Steuerberater|Rechtsanw|Wirtschaftsprüfer|Zahnarzt|Zahnärztin|Arzt|Geschäftsführ|CEO|CFO|COO|CTO|Vorsitz|Sprecher|Inhaber|Partner|Architekt|Notar|Gesellschafter).*$/i, '').replace(/\s+/g, ' ').trim().replace(TITLE_PREFIX, '').trim())
        .filter((x) => PERSON.test(x) && x.length < 50
            && !/\bCo\.|KGaA|GmbH|mbH|\bAG\b|\bSE\b|\bUG\b|\bKG\b|Gesellschaft|Straße|Str\.|Telefon|Geschäftsführ|Vorstand|Amtsgericht|Register|Kammer|Deutschland|Germany/i.test(x))
        .slice(0, 8);
}

const NAME_LABEL = /^(?:Sie erreichen (?:die|den|das|uns)|Firma|Firmenname|Name|Anbieter(?:in)?|Diensteanbieter(?:in)?|Unternehmen|Herausgeber(?:in)?|Betreiber(?:in)?|Webseitenbetreiber(?:in)?|Einzelunternehm\w*|Einzelfirma|Inhaber(?:in)?|Praxisinhaber(?:in)?|Kanzleiinhaber(?:in)?|Company|Provider|Operator)\b\s*[:.]?\s*(?:Inhaber(?:in)?\s+)?/i;
const JUNK_LINE = /@|https?:|www\.|\d{5,}|^(?:impressum|imprint|start|startseite|home|menü|menu|navigation|skip|zum inhalt|kontakt|anschrift|adresse|postanschrift|angaben|hinweise|diensteanbieter|anbieter|anbieterkennzeichnung|herausgeber|betreiber|legal|rechtliches|datenschutz|facebook|instagram|linkedin|xing|twitter|youtube|search|suche|tel|fon|fax|telefon|mobil|e-?mail|mail|web|internet|sitz|steuer|ust|umsatzsteuer|registergericht|handelsregister|amtsgericht|verantwortlich|inhaltlich|haftung|bildnachweis|bildquellen|quelle|copyright|©|mo|di|öffnungszeiten)(?![a-zäöüß])/i;
const PERSON_LABEL_START = /^(?:Geschäftsführ|Vertreten|Vorstand|Inh\.|Inhaber|Gesellschafter|Prokur|Ansprechpartner)/i;

function nameCandidate(raw) {
    if (!raw) return null;
    let l = raw.replace(NAME_LABEL, '').replace(/\s*[|•·]\s*$/, '').trim();
    if (l !== raw.trim() && !l) return null;
    if (!l || l.length < 3 || l.length > 100) return null;
    if (JUNK_LINE.test(l) || PERSON_LABEL_START.test(l) || /:\s*$/.test(l)) return null;
    if (/:/.test(l) && !NAME_LABEL.test(raw)) return null;
    if (PLZ_CITY.test(l) && /\d{4,5}\s+[A-ZÄÖÜ]/.test(l)) return null;
    if (STREET.test(l) || STREET_LOOSE.test(l)) return null;
    if (/^[\d+(]/.test(l) || /\b(?:Straße|Strasse|Str\.|Platz|Gasse|Weg|Objekt|Postfach|Top|Stiege)\s*\d/i.test(l)) return null;
    if (!l.replace(/\(.*?\)/g, '').replace(TITLE_PREFIX, '').replace(/^(?:Dipl\.?[-\s]?[\wäöü]*\.?|Steuerberater(?:in)?|Rechtsanw\w*|Zahnärzt\w*|Zahnarzt|Ärzt\w*|Arzt|Architekt\w*|Diplom-\w+)\s*/i, '').trim()) return null;
    return l;
}

// A legal form near the end of a short line ("Muster GmbH", "Muster GmbH (Standort X)").
function formAtEnd(l) {
    const core = l.replace(/\(.*?\)/g, '').trim();
    const m = core.match(LEGAL_FORM);
    if (!m || core.length > 95) return null;
    return core.length - (m.index + m[0].length) <= 25 ? m[1].replace(/\s+/g, ' ') : null;
}

function lineScore(l) {
    let s = 0;
    if (LEGAL_MARKER.test(l)) s += 3;
    if (REG_RE.test(l) || VAT_RE.test(l)) s += 3;
    if (PLZ_CITY.test(l)) s += 2;
    if (EMAIL.test(l) || PHONE_RE.test(l)) s += 1;
    return s;
}

export function extract(lines, pageUrl, siteHost, title = '') {
    // Find the notice itself: the 25-line window with the most legal signals,
    // pulled back to a heading just above it. Menus and footers score low.
    const scores = lines.map(lineScore);
    const W = 25;
    let best = 0, bestAt = 0, run = 0;
    for (let i = 0; i < lines.length; i++) {
        run += scores[i] - (i >= W ? scores[i - W] : 0);
        if (run > best) { best = run; bestAt = Math.max(0, i - W + 1); }
    }
    // Prefer the first block that is nearly as strong (the company, not the chamber or insurer).
    run = 0;
    for (let i = 0; i < lines.length; i++) {
        run += scores[i] - (i >= W ? scores[i - W] : 0);
        if (run >= best * 0.7) { bestAt = Math.max(0, i - W + 1); break; }
    }
    let start = bestAt;
    for (let i = bestAt; i >= Math.max(0, bestAt - 12); i--) {
        if (/^(?:impressum|imprint|legal notice|site notice|anbieterkennzeichnung)\b|Angaben gem(?:ä|ae)ss?\s*§|Hinweise gem/i.test(lines[i]) && lines[i].length < 140) { start = i; break; }
    }
    const sec = lines.slice(start, start + 160);
    const text = sec.join('\n');
    const row = {};

    // Address: first postcode + city line; street from the same line or the line above.
    for (let i = 0; i < sec.length; i++) {
        const l = sec[i];
        if ((/Registergericht|Amtsgericht|Steuer|USt|HRB|Fax|Tel/i.test(l) && !STREET.test(l)) || /©|copyright|\(c\)\s*\d{4}/i.test(l)) continue;
        const m = l.match(PLZ_CITY);
        if (!m) continue;
        const city = m[3].replace(/\s+(?:Tel|Fon|Telefon|Fax|E-?Mail|Germany|Deutschland).*$/i, '').trim();
        if (/^(Uhr|Euro|EUR|Mitarbeiter|Zeichen|Besucher|Kunden|Stück|Jahre)/i.test(city) || LEGAL_FORM.test(city)) continue;
        const before = l.slice(0, m.index + (m[0].match(/^[\s,|]/) ? 1 : 0));
        const street = before.match(STREET)?.[1] || before.replace(/[,|]\s*$/, '').match(STREET_LOOSE)?.[1]
            || (sec[i - 1] && (sec[i - 1].match(STREET)?.[1] || sec[i - 1].match(STREET_LOOSE)?.[1]))
            || (sec[i - 2] && sec[i - 2].match(STREET)?.[1]) || null;
        row.street = clip(street, 100);
        row._addrLine = l;
        row._streetSameLine = !!(before.match(STREET) || before.replace(/[,|]\s*$/, '').match(STREET_LOOSE));
        row.postalCode = m[2];
        row.city = clip(city, 60);
        const cc = m[1] || '';
        row.country = /^(A|AT)$/.test(cc) || (m[2].length === 4 && /Österreich|Austria|Wien|Graz|Linz|Salzburg|Innsbruck|Klagenfurt/i.test(text)) ? 'AT'
            : /^CH$/.test(cc) || (m[2].length === 4 && /Schweiz|Switzerland|Suisse|Zürich|Zurich|Bern|Basel|Luzern|Genf|CHE-/i.test(text)) ? 'CH'
                : m[2].length === 5 ? 'DE' : null;
        break;
    }

    // Company name: lines just above the street, then any short legal-form line
    // near the top of the notice, then the page title.
    const addrIdx = sec.findIndex((l) => l === row._addrLine);
    const near = [];
    for (let i = addrIdx - 1; addrIdx > 0 && i >= Math.max(0, addrIdx - 6); i--) {
        const c = nameCandidate(sec[i]);
        if (c) near.push(c);
    }
    const firstPart = sec.slice(0, addrIdx >= 0 ? addrIdx + 4 : 30);
    const titleName = nameCandidate(decode(String(title)).replace(/\s+/g, ' ').replace(/^(?:impressum|imprint|legal notice)(?:\s*(?:&|und|\/|\+)\s*datenschutz\w*)?\s*[|:–—-]\s*|\s*[|:–—-]\s*(?:impressum|imprint|legal notice)\s*$/gi, '').split(/\s+[|–—-]\s+/)[0]);
    const pick = near.find((c) => formAtEnd(c))
        || firstPart.map((l) => nameCandidate(l)).find((c) => c && formAtEnd(c))
        || (titleName && formAtEnd(titleName) ? titleName : null)
        || near.find((c) => c.split(/\s+/).length >= 2)
        || (titleName && !/impressum/i.test(titleName) ? titleName : null);
    if (pick) {
        row.companyName = clip(pick, 120);
        row.legalForm = formAtEnd(pick)?.replace(/^in\s/, '') || null;
    }
    delete row._addrLine; delete row._streetSameLine;

    // Contact
    const phones = []; let fax = null;
    for (const l of sec) {
        const f = l.match(FAX_RE); if (f && !fax) fax = clip(f[1], 30);
        const p = l.replace(FAX_RE, '').match(PHONE_RE); if (p) phones.push(clip(p[1], 30));
    }
    row.phone = phones[0] || null;
    row.fax = fax;
    const deob = text
        .replace(/\s*[[({<]\s*(?:at|ät|@)\s*[\])}>]\s*/gi, '@').replace(/\s+\(?at\)?\s+(?=[\w-]+\s*(?:[[({]\s*(?:dot|punkt)\s*[\])}]|\.)\s*[a-z]{2,})/gi, '@')
        .replace(/\s*[[({<]\s*(?:dot|punkt)\s*[\])}>]\s*/gi, '.');
    const emails = [...new Set((deob.match(new RegExp(EMAIL.source, 'gi')) || []).map((e) => e.toLowerCase().replace(/^mailto:/, '')))]
        .filter((e) => !/\.(png|jpe?g|gif|webp|svg)$/.test(e) && !/example\.|sentry|wixpress|@2x/.test(e));
    const own = emails.filter((e) => siteHost && e.split('@')[1].replace(/^www\./, '').endsWith(siteHost.split('.').slice(-2).join('.')));
    const ordered = [...own, ...emails.filter((e) => !own.includes(e))];
    // Data-protection officers and dispute bodies are not the company contact.
    const general = ordered.filter((e) => !/^(datenschutz|dsb|privacy|dpo|gdpr)@|ec\.europa|schlichtung/.test(e));
    row.email = general[0] || ordered[0] || null;
    row.emails = ordered.slice(0, 6);

    // People
    let directors = [];
    for (let i = 0; i < sec.length && !directors.length; i++) {
        const m = sec[i].match(DIRECTOR_LABEL);
        if (!m) continue;
        const own = (m[1] || '').trim();
        directors = personNames(own);
        // Names listed on the following lines, one per line.
        for (let k = i + 1; k < Math.min(sec.length, i + 7) && (!own || !directors.length); k++) {
            if (DIRECTOR_LABEL.test(sec[k]) || /:\s*$|^(?:Sitz|Register|Amtsgericht|Handelsregister|Tel|Fax|E-?Mail|USt|Kontakt|Anschrift)/i.test(sec[k])) break;
            const more = personNames(sec[k]);
            if (!more.length) break;
            directors.push(...more);
        }
    }
    row.managingDirectors = directors;
    for (let i = 0; i < sec.length; i++) {
        const m = sec[i].match(RESP_LABEL);
        if (!m) continue;
        const v = personNames((m[1] || '').trim() || sec[i + 1] || '');
        if (v.length) { row.contentResponsible = v[0]; break; }
    }

    // Registration
    const reg = text.match(REG_RE);
    const fn = text.match(FN_RE);
    row.registerType = reg ? reg[1] : fn ? 'FN' : null;
    row.registerNumber = reg ? `${reg[1]} ${reg[2].replace(/\s+/g, ' ').trim()}` : fn ? `FN ${fn[1].replace(/\s+/g, '')}` : null;
    const courtLine = sec.find((l) => /Amtsgericht|Registergericht|Handelsregister|Firmenbuchgericht|Registered at|Register court/i.test(l)) || '';
    const court = (courtLine + ' ' + (sec[sec.indexOf(courtLine) + 1] || '')).match(COURT_RE);
    row.registerCourt = court && !COURT_STOP.test(court[1].trim()) ? `Amtsgericht ${court[1].trim()}` : null;
    // Austria: Handelsgericht / Landesgericht keep firm registers; Switzerland: cantonal registers.
    const atCourt = text.match(/(Handelsgericht|Landesgericht(?:\sfür\sZRS)?|Bezirksgericht)\s+([A-ZÄÖÜ][a-zäöüß]+(?:\s(?:Neustadt|an der [A-ZÄÖÜ]\w+))?)/);
    const chCourt = text.match(/Handelsregister(?:amt)?\s+des\s+Kantons\s+([A-ZÄÖÜ][a-zäöüß]+(?:[\s-][A-ZÄÖÜ][a-zäöüß]+)?)/);
    if (chCourt) row.registerCourt = `Handelsregister des Kantons ${chCourt[1]}`;
    else if (atCourt && (row.registerType === 'FN' || row.country === 'AT')) row.registerCourt = `${atCourt[1]} ${atCourt[2]}`;
    if (row.registerCourt && (row.country === 'AT' || row.country === 'CH') && /^Amtsgericht /.test(row.registerCourt)) row.registerCourt = null;
    const vat = text.match(VAT_RE);
    row.vatId = vat ? vat[1].replace(/\s+/g, '').replace(/^(CHE)-?(\d{3})\.?(\d{3})\.?(\d{3})(.*)$/, 'CHE-$2.$3.$4$5') : null;
    if (!row.vatId && CH_UID.test(text)) row.vatId = text.match(CH_UID)[1];
    if (!row.registerNumber && row.country === 'CH' && CH_UID.test(text)) { row.registerNumber = text.match(CH_UID)[1].replace(/\s/g, ''); row.registerType = 'UID'; }
    row.taxNumber = clip(text.match(TAXNO_RE)?.[1], 30);
    row.profession = clip(text.match(PROF_RE)?.[1], 120);
    row.chamber = clip(text.match(CHAMBER_RE)?.[1], 150);

    row.impressumUrl = pageUrl;
    return row;
}
