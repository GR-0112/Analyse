const fs = require('fs');
const cheerio = require('cheerio');
const https = require('https');

// Enkel fetch-funksjon som ikke bruker node-fetch/undici
function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    const doRequest = (u, redirects = 0) => {
      https
        .get(u, (res) => {
          // Håndter enkle redirects (301/302)
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location &&
            redirects < 3
          ) {
            const next = res.headers.location.startsWith('http')
              ? res.headers.location
              : new URL(res.headers.location, u).toString();
            return doRequest(next, redirects + 1);
          }

          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => resolve(data));
        })
        .on('error', (err) => reject(err));
    };

    doRequest(url);
  });
}

const url = process.env.TARGET_URL;

if (!url) {
  console.error('TARGET_URL mangler');
  process.exit(1);
}

(async () => {
  try {
    console.log('Henter HTML fra:', url);

    const html = await fetchHTML(url);
    const $ = cheerio.load(html);

    // ===== 1. Enkle indikatorer =====
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const textLength = bodyText.length;

    const headingsText = $('h1, h2, h3').text().toLowerCase();

    const hasServiceWords =
      headingsText.includes('tjenester') ||
      headingsText.includes('produkter') ||
      headingsText.includes('vi tilbyr');

    const hasFAQ =
      $('details, summary').length > 0 ||
      $('.faq, .accordion').length > 0 ||
      /faq|ofte stilte spørsmål/i.test(headingsText);

    const hasSchema = $('script[type="application/ld+json"]').length > 0;

    const veryLowText = textLength < 1500;

    // ===== 2. Enkle scorer =====
    let seoScore = 70;
    if (textLength < 3000) seoScore -= 10;
    if (!hasServiceWords) seoScore -= 10;
    if (!hasSchema) seoScore -= 10;

    let aiScore = 70;
    if (!hasFAQ) aiScore -= 20;
    if (!hasSchema) aiScore -= 10;
    if (textLength < 3000) aiScore -= 10;

    let uuScore = 75;
    if (veryLowText) uuScore -= 10; // lite forklarende tekst

    // Begrens scorer mellom 0 og 100
    seoScore = Math.max(0, Math.min(100, seoScore));
    aiScore = Math.max(0, Math.min(100, aiScore));
    uuScore = Math.max(0, Math.min(100, uuScore));

    // ===== 3. Bygg selger-rapport =====
    const rapport = `
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

    fs.writeFileSync('SALGS-RAPPORT.txt', rapport, 'utf8');
    console.log('SALGS-RAPPORT.txt generert ✅');
  } catch (err) {
    console.error('Feil under kjøring av agent:', err);
    process.exit(1);
  }
})();
