// agent/run.js
// Konkurrent-agent uten eksterne pakker.
// Gjør enkel HTML-analyse og genererer en selger-vennlig rapport
// med konkrete funn i formatet:
//
// 1) [Kort problemformulering]
// - [konkrete funn]
// → [konsekvens for synlighet / kunder]

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
 * Hent HTML (kun innebygde moduler)
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
 * Gjet hovednøkkelord fra <title>/<h1> eller domenenavn
 */
function guessMainKeyword(html, urlStr) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);

  let source =
    (h1Match && h1Match[1]) ||
    (titleMatch && titleMatch[1]) ||
    urlStr.replace(/^https?:\/\//, '').split('/')[0];

  source = source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const words = source.split(' ').filter((w) => w.length > 2);
  if (!words.length) return 'deres tjeneste';

  return words.slice(0, 2).join(' ');
}

/**
 * Finn potensielle lav-kontrast-eksempler
 */
function findContrastExamples(html) {
  const examples = [];

  const classPattern =
    /class="([^"]*(text-gray-300|text-gray-200|text-gray-400|text-slate-300|text-muted)[^"]*)"/gi;
  let m;
  while ((m = classPattern.exec(html)) !== null) {
    if (examples.length >= 5) break;
    examples.push(`klasse: ${m[2]} (i "${m[1].slice(0, 40)}...")`);
  }

  const stylePattern =
    /style="[^"]*color:\s*(#[0-9a-fA-F]{3,6}|rgba?\([^)]*\))[^"]*"/gi;
  let s;
  while ((s = stylePattern.exec(html)) !== null) {
    if (examples.length >= 5) break;
    examples.push(`fargekode: ${s[1]}`);
  }

  return examples;
}

function estimateContrastRisk(examples) {
  if (examples.length > 5) return 'høy';
  if (examples.length > 0) return 'middels';
  return 'lav';
}

/**
 * Analyse av HTML
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

  const linkMatches = noScripts.match(/<a\s+[^>]*href=/gi) || [];
  const linkCount = linkMatches.length;

  const navPresent = /<nav[^>]*>/i.test(noScripts);

  const contrastExamples = findContrastExamples(html);
  const contrastRisk = estimateContrastRisk(contrastExamples);

  return {
    textLength,
    hasServiceWords,
    hasFAQ,
    hasSchema,
    veryLowText,
    contrastExamples,
    contrastRisk,
    linkCount,
    navPresent
  };
}

/**
 * Bygg liste over problemer (dynamisk)
 */
function buildIssues(url, analysis, html) {
  const issues = [];
  const mainKeyword = guessMainKeyword(html, url);
  const {
    textLength,
    hasServiceWords,
    hasFAQ,
    hasSchema,
    veryLowText,
    contrastExamples,
    contrastRisk,
    linkCount,
    navPresent
  } = analysis;

  // 1) Dårlig SEO
  const seoBullets = [];
  if (!hasSchema) seoBullets.push('Siden mangler strukturert data (schema.org).');
  if (textLength < 3000)
    seoBullets.push(
      `Det er lite forklarende tekst (anslagsvis ${textLength} tegn synlig tekst).`
    );
  if (!hasServiceWords)
    seoBullets.push(
      'Overskriftene sier lite om konkrete tjenester eller tilbud.'
    );

  if (seoBullets.length) {
    issues.push({
      title: 'Dårlig SEO: Google forstår ikke innholdet',
      bullets: seoBullets,
      impacts: [
        'Lavere synlighet i Google, spesielt på søk der kunder bruker tjenestenavn og sted.',
        'Kunder vil i mindre grad finne dere når de søker etter det dere faktisk tilbyr.'
      ]
    });
  }

  // 2) Lite forklaring av tjenester (brukeropplevelse)
  const uxBullets = [];
  if (veryLowText)
    uxBullets.push(
      'Nettsiden har generelt lite tekst som forklarer hva dere gjør og hvordan dere jobber.'
    );
  if (!hasServiceWords)
    uxBullets.push(
      'Det er få tydelige seksjoner eller overskrifter som beskriver tjenester eller prosess.'
    );

  if (uxBullets.length) {
    issues.push({
      title: 'Kundene får lite forklaring på tjenestene',
      bullets: uxBullets,
      impacts: [
        'Besøkende forstår ikke helt hva de får, og blir usikre.',
        'Flere vil velge en konkurrent som forklarer tydeligere.'
      ]
    });
  }

  // 3) Svak synlighet i AI-søk
  const aiBullets = [];
  if (!hasFAQ)
    aiBullets.push('Vi fant ingen tydelig FAQ eller spørsmål/svar-seksjon.');
  if (!hasSchema)
    aiBullets.push(
      'Vi fant ingen strukturert informasjon (schema.org) som AI-verktøy kan bruke.'
    );

  if (aiBullets.length) {
    issues.push({
      title: 'Svak synlighet i AI-søk (ChatGPT, Bing, Google AI)',
      bullets: aiBullets,
      impacts: [
        `Når folk spør etter "beste ${mainKeyword} i området" i AI-verktøy, er det lite som tyder på at dere blir nevnt.`,
        'AI-verktøyene finner for lite konkret informasjon til å anbefale dere.'
      ]
    });
  }

  // 4) Kontrast og lesbarhet
  const kontrastBullets = [];
  if (contrastRisk === 'høy')
    kontrastBullets.push(
      'Automatisk sjekk tyder på høy risiko for svak kontrast (mye lys/grå tekst).'
    );
  if (contrastRisk === 'middels')
    kontrastBullets.push(
      'Vi fant flere eksempler på lyse tekststiler som kan være vanskelige å lese.'
    );
  if (contrastExamples.length) {
    kontrastBullets.push(
      'Eksempler på potensielt svak kontrast:'
    );
    contrastExamples.slice(0, 3).forEach((ex) => {
      kontrastBullets.push(`  - ${ex}`);
    });
  }

  if (kontrastBullets.length) {
    issues.push({
      title: 'Kontrast og lesbarhet er sannsynligvis et problem',
      bullets: kontrastBullets,
      impacts: [
        'Noen kunder vil slite med å lese viktig innhold.',
        'Google vurderer lesbarhet som en del av brukeropplevelsen, noe som kan trekke ned.'
      ]
    });
  }

  // 5) Struktur og navigasjon
  const navBullets = [];
  if (!navPresent)
    navBullets.push('Vi fant ingen tydelig <nav>-struktur for hovedmeny.');
  if (linkCount < 10)
    navBullets.push(
      `Det er få lenker totalt på siden (omtrent ${linkCount}), noe som tyder på lite intern navigasjon.`
    );

  if (navBullets.length) {
    issues.push({
      title: 'Struktur og navigasjon kunne vært tydeligere',
      bullets: navBullets,
      impacts: [
        'Besøkende kan få vanskeligere for å finne det de leter etter.',
        'Google får mindre hjelp til å forstå hvilke sider/tema som er viktigst.'
      ]
    });
  }

  return { issues, mainKeyword };
}

/**
 * Bygg selger-rapport etter ønsket mal
 */
function buildReport(url, analysis, html) {
  const { issues, mainKeyword } = buildIssues(url, analysis, html);

  let out = '';
  out += `Konkurrentanalyse – Kort vurdering\n`;
  out += `Nettside: ${url}\n\n`;
  out += `Vi har gjort en enkel automatisk gjennomgang av nettsiden deres. Her er de viktigste funnene:\n\n`;

  if (!issues.length) {
    out += `Vi fant ingen åpenbare alvorlige problemer basert på automatisk sjekk, men det er fortsatt rom for forbedring i innhold og synlighet.\n`;
    return out;
  }

  issues.forEach((issue, idx) => {
    out += `${idx + 1}) ${issue.title}\n`;
    issue.bullets.forEach((b) => {
      out += `- ${b}\n`;
    });
    if (issue.impacts && issue.impacts.length) {
      issue.impacts.forEach((i) => {
        out += `→ ${i}\n`;
      });
    }
    out += `\n`;
  });

  out += `Oppsummert:\n`;
  out += `- Nettsiden gir et greit visuelt inntrykk, men har svakheter på innhold og struktur.\n`;
  out += `- Google og AI-tjenester får for lite konkret informasjon om hva dere tilbyr.\n`;
  out += `- Mange kunder vil ha problemer med både å finne dere og å forstå hvorfor de skal velge dere.\n`;

  out += `\nDette er ting det er fullt mulig å forbedre, og som vil gjøre det enklere å bli valgt som leverandør.\n`;

  return out;
}

/**
 * Main
 */
(async () => {
  try {
    console.log('Henter HTML fra:', targetUrl);
    const html = await fetchHTML(targetUrl);
    const analysis = analyseHtml(html);

    const report = buildReport(targetUrl, analysis, html);
    fs.writeFileSync('SALGS-RAPPORT.txt', report, 'utf8');
    console.log('SALGS-RAPPORT.txt generert ✅');
  } catch (err) {
    console.error('Feil under kjøring av agent:', err);
    process.exit(1);
  }
})();
