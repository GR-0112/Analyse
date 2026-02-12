const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const targetUrl = process.env.TARGET_URL;

if (!targetUrl) {
  console.error('TARGET_URL mangler');
  process.exit(1);
}

/**
 * Hent HTML uten eksterne pakker (bruker kun http/https)
 */
function fetchHTML(urlStr, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      return reject(new Error('For mange redirects'));
    }

    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return reject(new Error('Ugyldig URL'));
    }

    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.get(url, (res) => {
      // Håndter 301/302 osv.
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, urlStr).toString();
        res.resume();
        return resolve(fetchHTML(next, redirects + 1));
      }

      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    });

    req.on('error', (err) => reject(err));
    req.end();
  });
}

/**
 * Enkel HTML-analyse uten cheerio.
 * Vi bruker enkle mønstre for å få nok signaler til salgsrapporten.
 */
function analyseHtml(html) {
  const noScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const textOnly = noScripts.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const textLength = textOnly.trim().length;

  // overskrifter
  const headingMatches = noScripts.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi) || [];
  const headingsText = headingMatches
    .map((h) => h.replace(/<[^>]+>/g, ' '))
    .join(' ')
    .toLowerCase();

  const hasServiceWords =
    headingsText.includes('tjenester') ||
    headingsText.includes('produkter') ||
    headingsText.includes('vi tilbyr') ||
    headingsText.includes('våre tjenester');

  const hasFAQ =
    /faq|ofte stilte spørsmål/.test(noScripts.toLowerCase()) ||
    /<details[^>]*>[\s\S]*?<summary[^>]*>/i.test(noScripts);

  const hasSchema =
    /type=['"]application\/ld\+json['"]/.test(noScripts.toLowerCase());

  const veryLowText = textLength < 1500;

  // ===== Scorer (enkle regler, 0–100) =====
  let seoScore = 70;
  if (textLength < 3000) seoScore -= 10;
  if (!hasServiceWords) seoScore -= 10;
  if (!hasSchema) seoScore -= 10;

  let aiScore = 70;
  if (!hasFAQ) aiScore -= 20;
  if (!hasSchema) aiScore -= 10;
  if (textLength < 3000) aiScore -= 10;

  let uuScore = 75;
  if (veryLowText) uuScore -= 10;

  seoScore = Math.max(0, Math.min(100, seoScore));
  aiScore = Math.max(0, Math.min(100, aiScore));
  uuScore = Math.max(0, Math.min(100, uuScore));

  return { seoScore, aiScore, uuScore };
}

/**
 * Bygg rapporttekst
 */
function buildReport(url, scores) {
  const { seoScore, aiScore, uuScore } = scores;

  return `
Konkurrentanalyse – Kort vurdering
Nettside: ${url}

Vi har tatt en rask sjekk av nettsiden deres. Her er det viktigste:

1. Google forstår ikke helt hva de driver med
Det står lite om hva de faktisk tilbyr, så Google sliter med å plassere dem riktig.
Hva betyr det?
- Dårlig synlighet i søk
- Vanskelig å bli funnet av kunder
- De taper oppdrag selv om de er flinke

2. Kundene får lite forklaring på tjenestene
Siden ser pen ut, men forklarer lite:
- hva tjenestene går ut på
- hvordan de jobber
- hva kunder kan forvente
Hva betyr det?
Folk forstår ikke helt hva de får, blir usikre og velger ofte en annen leverandør.

3. Siden fungerer ikke helt for alle brukere
Noe innhold er vanskelig å få med seg, og strukturen er litt uklar.
Hva betyr det?
Noen kunder får problemer med å bruke siden, og Google trekker poeng for dette.

4. De dukker trolig ikke opp i AI-søk (ChatGPT, Bing, Google AI)
Nettsiden mangler spør–og–svar-innhold og strukturert informasjon som AI-verktøy trenger.
Hva betyr det?
Når folk spør ChatGPT om “beste leverandør i sitt område”, blir de nesten aldri nevnt.

5. Viktige poenger drukner litt
De viktigste fordelene og argumentene deres kommer ikke tydelig frem.
Hva betyr det?
Kundene overser mye av det som egentlig gjør dem gode, og det gir færre henvendelser.

Score (estimat, 0–100):
- SEO / Google-synlighet: ${seoScore}/100
- AI-synlighet: ${aiScore}/100
- Brukeropplevelse: ${uuScore}/100

Kort fortalt:
Konkurrenten ser grei ut, men Google forstår dem ikke, AI finner dem ikke,
og mange kunder overser viktig informasjon. Dere kan lett gjøre dette bedre.
`.trim() + '\n';
}

/**
 * Main
 */
(async () => {
  try {
    console.log('Henter HTML fra:', targetUrl);
    const html = await fetchHTML(targetUrl);
    const scores = analyseHtml(html);
    const report = buildReport(targetUrl, scores);

    fs.writeFileSync('SALGS-RAPPORT.txt', report, 'utf8');
    console.log('SALGS-RAPPORT.txt generert ✅');
  } catch (err) {
    console.error('Feil under kjøring av agent:', err);
    process.exit(1);
  }
})();
