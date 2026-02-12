// agent/run.js
// Konkurrent-agent uten eksterne pakker.
// Henter HTML, analyserer noen enkle ting og lager en selger-vennlig rapport med konkrete eksempler.

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
function guessMainKeyword(html, fallbackUrl) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  let source =
    (h1Match && h1Match[1]) ||
    (titleMatch && titleMatch[1]) ||
    fallbackUrl.replace(/^https?:\/\//, '').split('/')[0];

  source = source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  const words = source.split(' ').filter((w) => w.length > 2);
  if (!words.length) return 'din tjeneste';

  return words.slice(0, 2).join(' ');
}

/**
 * Finn potensielle lav-kontrast-eksempler (klasser/farger)
 */
function findContrastExamples(html) {
  const examples = [];

  // Look for Tailwind-aktige klasser
  const classPattern =
    /class="([^"]*(text-gray-300|text-gray-200|text-gray-400|text-slate-300|text-muted)[^"]*)"/gi;
  let m;
  while ((m = classPattern.exec(html)) !== null) {
    if (examples.length >= 5) break;
    examples.push(`klasse: ${m[2]} (i ${m[1].slice(0, 60)}...)`);
  }

  // Look for inline color styles
  const stylePattern =
    /style="[^"]*color:\s*(#[0-9a-fA-F]{3,6}|rgba?\([^)]*\))[^"]*"/gi;
  while ((m = stylePattern.exec(html)) !== null) {
    if (examples.length >= 5) break;
    examples.push(`fargekode: ${m[1]}`);
  }

  return examples;
}

/**
 * Estimer "kontrastrisiko"
 */
function estimateContrastRisk(contrastExamples) {
  if (contrastExamples.length > 5) return 'høy';
  if (contrastExamples.length > 0) return 'middels';
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

  const contrastExamples = findContrastExamples(html);
  const contrastRisk = estimateContrastRisk(contrastExamples);

  // ===== Scorer =====
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
    contrastExamples,
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

  rows.push({
    term: `${mainKeyword} i ditt område`,
    reason: [
      textLength < 3000 ? 'lite forklarende innhold' : null,
      !hasSchema ? 'ingen strukturert informasjon til Google' : null
    ]
      .filter(Boolean)
      .join(', ') || 'begrenset innhold og sterk konkurranse'
  });

  rows.push({
    term: `${mainKeyword} pris`,
    reason:
      'ingen tydelig informasjon eller egne seksjoner som svarer på pris og hva som er inkludert'
  });

  rows.push({
    term: `beste ${mainKeyword}`,
    reason: [
      !hasFAQ ? 'mangler spørsmål/svar-innhold (FAQ)' : null,
      !hasSchema ? 'ingen strukturert data (anmeldelser/tjenester)' : null
    ]
      .filter(Boolean)
      .join(', ') || 'lite innhold som bygger troverdighet og faglig tyngde'
  });

  let section = `## Hvorfor nettsiden deres rangerer dårlig nå\n`;
  section += `Dette er en vurdering basert på innholdet på nettsiden (ikke faktiske rangeringstall):\n\n`;
  section += `Søkeord | Forventet synlighet | Hvorfor\n`;
  section += `--- | --- | ---\n`;
  rows.forEach((row) => {
    section += `${row.term} | Svak | ${row.reason}\n`;
  });

  return section.trim();
}

/**
 * Bygg rapporttekst (med overskrifter og punktlister i "markdown"-stil)
 */
function buildReport(url, scores, analysis, html) {
  const { seoScore, aiScore, uuScore } = scores;
  const { contrastRisk, veryLowText, contrastExamples, textLength } = analysis;

  const mainKeyword = guessMainKeyword(html, url);
  const rankingSection = buildRankingSection(mainKeyword, analysis);

  const liteTekstSetning = veryLowText
    ? '- Relativt lite forklarende tekst på siden.'
    : '- En del tekst, men mye av den forklarer lite for nye besøkende.';

  let kontrastSetning;
  if (contrastRisk === 'høy') {
    kontrastSetning =
      '- Høy risiko for dårlig lesbarhet (mye lys/grå tekst mot lys bakgrunn).';
  } else if (contrastRisk === 'middels') {
    kontrastSetning =
      '- Noe risiko for dårlig lesbarhet (flere lyse tekststiler brukt).';
  } else {
    kontrastSetning = '- Ingen åpenbar høy kontrastrisiko i automatisk sjekk.';
  }

  const kontrastEksemplerTekst =
    contrastExamples.length > 0
      ? contrastExamples
          .slice(0, 3)
          .map((e) => `  - Eksempel: ${e}`)
          .join('\n')
      : '  - Fantes ingen tydelige eksempler i automatisk sjekk.';

  return `
# Konkurrentanalyse – Kort vurdering

**Nettside:** ${url}

Vi har tatt en rask sjekk av nettsiden deres. Her er det viktigste:

---

## 1. Google forstår ikke helt hva dere driver med

${liteTekstSetning}
- Google får dermed begrenset informasjon om hva dere faktisk tilbyr.
- Overskriftene sier lite om tjenester og innhold: ${
    analysis.hasServiceWords ? 'Noen tjeneste-ord funnet.' : 'ingen tydelige "tjenester"-overskrifter funnet.'
  }

**Hva betyr det?**
- Dårligere synlighet i søk
- Vanskeligere å bli funnet av nye kunder
- Dere taper oppdrag selv om dere kan være faglig sterke

---

## 2. Kundene får lite forklaring på tjenestene

Siden ser pen ut, men forklarer lite:
- hva tjenestene går ut på
- hvordan dere jobber
- hva kunder kan forvente

**Hva betyr det?**
- Folk forstår ikke helt hva de får
- Mange blir usikre
- Flere velger en annen leverandør som forklarer bedre

---

## 3. Siden fungerer ikke helt for alle brukere

${kontrastSetning}
**Konkrete tegn på potensielt dårlig kontrast:**
${kontrastEksemplerTekst}

**Hva betyr det?**
- Noen kunder får problemer med å lese og bruke siden
- Google trekker poeng for sider som ikke er godt tilpasset alle

---

## 4. De dukker trolig ikke opp i AI-søk (ChatGPT, Bing, Google AI)

Nettsiden mangler:
- tydelig spør–og–svar-innhold (FAQ): ${analysis.hasFAQ ? 'ja, noe finnes.' : 'nei, ingenting funnet.'}
- strukturert informasjon (schema.org): ${analysis.hasSchema ? 'ja, noe finnes.' : 'nei, ingenting funnet.'}

**Hva betyr det?**
- Når folk spør ChatGPT om “beste ${mainKeyword} i sitt område”, er sjansen liten for at dere blir nevnt.
- AI-verktøyene finner rett og slett ikke nok informasjon til å anbefale dere.

---

## 5. Viktige poenger drukner litt

- Mye av teksten fokuserer på overflate, lite på kundens praktiske spørsmål.
- Få tydelige avsnitt som sier “dette gjør vi, for hvem, og slik hjelper vi dere”.

**Hva betyr det?**
- Kundene overser mye av det som egentlig gjør dere gode
- Færre tar kontakt enn dere kunne hatt med tydeligere innhold

---

## Score (estimat, 0–100)

> Basert på tekstmengde (${textLength} tegn), struktur, FAQ og tekniske signaler fra siden.

- **SEO / Google-synlighet:** ${seoScore}/100  
- **AI-synlighet:** ${aiScore}/100  
- **Brukeropplevelse:** ${uuScore}/100  

---

${rankingSection}

---

## Kort fortalt

Konkurrenten ser grei ut, men:

- Google forstår dem ikke godt nok  
- AI (ChatGPT, Bing, Google AI) finner dem ikke  
- Mange kunder overser viktig informasjon  
- Siden er ikke like lett å lese og forstå som den kunne vært  

**Dette er ting dere lett kan gjøre bedre – og som vil gi dere et klart fortrinn.**
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

    const report = buildReport(targetUrl, scores, analysis, html);

    fs.writeFileSync('SALGS-RAPPORT.txt', report, 'utf8');
    console.log('SALGS-RAPPORT.txt generert ✅');
  } catch (err) {
    console.error('Feil under kjøring av agent:', err);
    process.exit(1);
  }
})();
