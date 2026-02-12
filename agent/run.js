// agent/run.js
// Enkel konkurrent-agent uten eksterne pakker.
// Bruker kun Node sine innebygde moduler for å hente HTML og gjøre enkel analyse.

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
 * Gjet hovednøkkelord: plukk noe fra <title> eller <h1>
 */
function guessMainKeyword(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  let source =
    (h1Match && h1Match[1]) ||
    (titleMatch && titleMatch[1]) ||
    'din tjeneste';

  source = source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // Fjern veldig korte ord som ofte er "Velkommen til", "Din", etc.
  const words = source.split(' ').filter((w) => w.length > 2);
  if (!words.length) return 'din tjeneste';

  // Ta de 2 første ordene som hovedfrase
  return words.slice(0, 2).join(' ');
}

/**
 * Estimer "kontrastrisiko" ved å se etter lyse farger/grå-tekstindikatorer.
 * (Ikke perfekt, men gir oss et salgsargument når det er mye lys tekst.)
 */
function estimateContrastRisk(html) {
  const patterns = [
    /color:\s*#ccc/gi,
    /color:\s*#ddd/gi,
    /color:\s*#eee/gi,
    /color:\s*#999/gi,
    /color:\s*#aaa/gi,
    /class="[^"]*(text-muted|text-gray-300|text-gray-400)[^"]*"/gi
  ];

  let hits = 0;
  for (const re of patterns) {
    const matches = html.match(re);
    if (matches) hits += matches.length;
  }

  if (hits > 15) return 'høy';
  if (hits > 0) return 'middels';
  return 'lav';
}

/**
 * Enkel HTML-analyse uten cheerio.
 */
function analyseHtml(html) {
  const noScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const textOnly = noScripts.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const textLength = textOnly.trim().length;

  // overskrifter
  const headingMatches =
    noScripts.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi) || [];
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
  const contrastRisk = estimateContrastRisk(html);

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
  if (contrastRisk === 'høy') uuScore -= 20;
  if (contrastRisk === 'middels') uuScore -= 10;

  seoScore = Math.max(0, Math.min(100, seoScore));
  aiScore = Math.max(0, Math.min(100, aiScore));
  uuScore = Math.max(0, Math.min(100, uuScore));

  return {
    textLength,
    hasServiceWords,
    hasFAQ,
    hasSchema,
    veryLowText,
    contrastRisk,
    seoScore,
    aiScore,
    uuScore,
    headingsText
  };
}

/**
 * Lag en enkel "rangeringstabell" basert på nøkkelord
 */
function buildRankingSection(mainKeyword, analysis) {
  const { hasFAQ, hasSchema, textLength } = analysis;

  const rows = [];

  // Søkeord 1: hovedtjeneste + område
  rows.push({
    term: `${mainKeyword} i ditt område`,
    reason: [
      textLength < 3000 ? 'lite forklarende innhold' : null,
      !hasSchema ? 'ingen strukturert informasjon til Google' : null
    ]
      .filter(Boolean)
      .join(', ') || 'moderat konkurranse og begrenset innhold'
  });

  // Søkeord 2: hovedtjeneste + pris
  rows.push({
    term: `${mainKeyword} pris`,
    reason:
      'ingen egne sider eller innhold som svarer på pris/spørsmål rundt kostnad'
  });

  // Søkeord 3: hovedtjeneste som "beste"
  rows.push({
    term: `beste ${mainKeyword}`,
    reason: [
      !hasFAQ ? 'mangler FAQ' : null,
      !hasSchema ? 'ingen strukturert data for anmeldelser/innhold' : null
    ]
      .filter(Boolean)
      .join(', ') || 'lite innhold som bygger faglig tyngde og tillit'
  });

  let section = `Hvorfor nettsiden deres rangerer dårlig nå\n`;
  section += `Dette er vår vurdering av hvor vanskelig det er for dere å vinne viktige søk (basert på innholdet på nettsiden, ikke faktiske rangeringstall):\n\n`;

  section += `Søkeord\tForventet synlighet\tHvorfor\n`;
  rows.forEach((row) => {
    section += `${row.term}\tSvak\t${row.reason}\n`;
  });

  return section.trim();
}

/**
 * Bygg rapporttekst (nå med litt mer dynamikk basert på analyse)
 */
function buildReport(url, scores, analysis) {
  const { seoScore, aiScore, uuScore } = scores;
  const { contrastRisk, veryLowText } = analysis;

  const mainKeyword = guessMainKeyword(url); // fallback til URL hvis title/h1 ikke ble funnet i analyseHtml

  const rankingSection = buildRankingSection(mainKeyword, analysis);

  const kontrastSetning =
    contrastRisk === 'høy'
      ? 'Nettsiden har flere områder med veldig lys/grå tekst, som kan være vanskelig å lese for mange brukere.'
      : contrastRisk === 'middels'
      ? 'Noe av teksten fremstår ganske lys, og kan være utfordrende å lese for enkelte brukere.'
      : 'Teksten fremstår ikke som åpenbart vanskelig å lese ut fra en automatisk sjekk.';

  const liteTekstSetning = veryLowText
    ? 'Det er relativt lite forklarende tekst på siden.'
    : 'Det finnes en del tekst på siden, men den kunne vært mer forklarende for nye besøkende.';

  return `
Konkurrentanalyse – Kort vurdering
Nettside: ${url}

Vi har tatt en rask sjekk av nettsiden deres. Her er det viktigste:

1. Google forstår ikke helt hva de driver med
${liteTekstSetning} Google får dermed begrenset informasjon om hva dere faktisk tilbyr.
Hva betyr det?
- Dårligere synlighet i søk
- Vanskeligere å bli funnet av nye kunder
- Dere taper oppdrag selv om dere kan være faglig sterke

2. Kundene får lite forklaring på tjenestene
Siden ser pen ut, men forklarer lite:
- hva tjenestene går ut på
- hvordan dere jobber
- hva kunder kan forvente
Hva betyr det?
Folk forstår ikke helt hva de får, blir usikre og velger ofte en annen leverandør.

3. Siden fungerer ikke helt for alle brukere
${kontrastSetning}
Hva betyr det?
Noen kunder får problemer med å bruke siden, og Google trekker poeng for sider som ikke er godt tilpasset alle.

4. De dukker trolig ikke opp i AI-søk (ChatGPT, Bing, Google AI)
Nettsiden mangler tydelig spør–og–svar-innhold (FAQ) og strukturert informasjon som AI-verktøy trenger.
Hva betyr det?
Når folk spør ChatGPT om “beste ${mainKeyword} i sitt område”, er sjansen liten for at dere blir nevnt.

5. Viktige poenger drukner litt
De viktigste fordelene og argumentene deres kommer ikke tydelig nok frem i innholdet.
Hva betyr det?
Kundene overser mye av det som egentlig gjør dere gode, og det gir færre henvendelser.

Score (estimat, 0–100):
- SEO / Google-synlighet: ${seoScore}/100
- AI-synlighet: ${aiScore}/100
- Brukeropplevelse: ${uuScore}/100

${rankingSection}

Kort fortalt:
Konkurrenten ser grei ut, men Google forstår dem ikke godt nok, AI finner dem ikke,
og mange kunder overser viktig informasjon. Dette kan dere lett gjøre bedre.
`.trim() + '\n';
}

/**
 * Main
 */
(async () => {
  try {
    console.log('Henter HTML fra:', targetUrl);
    const html = await fetchHTML(targetUrl);
    const analysis = analyseHtml(html);
    const scores = {
      seoScore: analysis.seoScore,
      aiScore: analysis.aiScore,
      uuScore: analysis.uuScore
    };

    const report = buildReport(targetUrl, scores, analysis);

    fs.writeFileSync('SALGS-RAPPORT.txt', report, 'utf8');
    console.log('SALGS-RAPPORT.txt generert ✅');
  } catch (err) {
    console.error('Feil under kjøring av agent:', err);
    process.exit(1);
  }
})();
