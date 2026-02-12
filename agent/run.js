// agent/run.js
// Enkel konkurrent-agent uten eksterne pakker.
// Analysere HTML på klassiske feil og generere en selger-vennlig rapport.

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
    } catch {
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
 * Gjet hovednøkkelord (tjeneste)
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
 * Gjet lokasjon (f.eks. Raufoss) ut fra tekst som "2830 Raufoss"
 */
function guessLocation(html) {
  const lower = html.toLowerCase();

  // postnummer + sted
  const match = lower.match(/\b(\d{4})\s+([a-zæøå\- ]{2,})\b/);
  if (match) {
    const sted = match[2].trim();
    if (
      sted.length > 2 &&
      !sted.includes('norge') &&
      !sted.includes('norway')
    ) {
      // enkel kapitalisering
      return sted
        .split(' ')
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(' ');
    }
  }

  // fallback
  return 'ditt område';
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

  // se også etter body { color: ... } i inline <style>
  const styleBlocks = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [];
  for (const block of styleBlocks) {
    const bodyMatch = block.match(/body\s*{[^}]*color:\s*(#[0-9a-fA-F]{3,6})/i);
    if (bodyMatch) {
      examples.push(`body-tekstfarge: ${bodyMatch[1]} definert i CSS`);
    }
  }

  return examples;
}

function estimateContrastRisk(examples) {
  if (examples.length > 5) return 'høy';
  if (examples.length > 0) return 'middels';
  return 'lav';
}

/**
 * Enkel HTML-analyse
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
    /type=['"]application\/ld\+json['"]/.test(html.toLowerCase());

  const veryLowText = textLength < 1500;

  const linkMatches = noScripts.match(/<a\s+[^>]*href=/gi) || [];
  const linkCount = linkMatches.length;

  const navPresent = /<nav[^>]*>/i.test(noScripts);

  const contrastExamples = findContrastExamples(html);
  const contrastRisk = estimateContrastRisk(contrastExamples);

  // SEO-score
  let seoScore = 100;
  if (!hasSchema) seoScore -= 20;
  if (veryLowText) seoScore -= 20;
  if (!hasServiceWords) seoScore -= 20;

  seoScore = Math.max(0, Math.min(100, seoScore));

  return {
    textLength,
    hasServiceWords,
    hasFAQ,
    hasSchema,
    veryLowText,
    contrastExamples,
    contrastRisk,
    linkCount,
    navPresent,
    seoScore
  };
}

function seoLabel(score) {
  if (score >= 80) return 'høy';
  if (score >= 60) return 'middels';
  if (score >= 40) return 'middels / svak';
  return 'svak';
}

/**
 * "Realistisk rangering"-tabell (ASCII)
 */
function buildRankingSection(mainKeyword, location, seoScore) {
  const rows = [
    {
      term: `${mainKeyword} ${location}`,
      why:
        seoScore >= 80
          ? 'godt nok innhold, men fortsatt konkurranse'
          : seoScore >= 50
          ? 'begrenset innhold og strukturert data'
          : 'lite forklarende innhold og manglende strukturert data'
    },
    {
      term: `${mainKeyword} pris ${location}`,
      why: 'ingen tydelig seksjon som svarer på pris og hva som er inkludert'
    },
    {
      term: `beste ${mainKeyword} ${location}`,
      why: 'lite innhold som bygger faglig tyngde, anmeldelser eller kundehistorier'
    }
  ];

  let out = '';
  out += `Realistisk rangering i Google for nettstedet (basert på innholdet, ikke faktiske målinger)\n`;
  out += `Søkeord                           | Forventet synlighet | Hvorfor\n`;
  out += `--------------------------------- | ------------------- | ---------------------------------------------\n`;

  rows.forEach((r) => {
    const forventet =
      seoScore >= 80 ? 'Middels–god' : seoScore >= 50 ? 'Middels–svak' : 'Svak';
    const term = r.term.padEnd(33, ' ');
    const vis = forventet.padEnd(19, ' ');
    out += `${term} | ${vis} | ${r.why}\n`;
  });

  out += `\nNettsiden rangerer trolig svakere enn den kunne på bransjesøk som for eksempel "${mainKeyword} ${location}", "beste ${mainKeyword} ${location}" og "${mainKeyword} pris ${location}".\n`;

  return out;
}

/**
 * Bygg "De største problemene"
 */
function buildProblemsSection(analysis) {
  const {
    textLength,
    hasSchema,
    hasServiceWords,
    hasFAQ,
    contrastRisk,
    contrastExamples
  } = analysis;

  const problems = [];

  // 1) Dårlig SEO
  const seoBullets = [];
  if (!hasSchema) seoBullets.push('Mangler strukturert data (schema.org).');
  if (textLength < 3000)
    seoBullets.push(
      `Lite forklarende tekst (anslagsvis ${textLength} tegn synlig tekst).`
    );
  if (!hasServiceWords)
    seoBullets.push(
      'Få tydelige tjeneste-overskrifter som treffer søkeord målgruppen bruker.'
    );
  if (seoBullets.length) {
    problems.push({
      title: '1) Dårlig SEO – Google forstår ikke innholdet',
      bullets: seoBullets,
      impacts: [
        'Lavere synlighet i Google på viktige bransjesøk.',
        'Kunder vil i mindre grad finne dere når de søker etter det dere faktisk tilbyr.'
      ]
    });
  }

  // 2) UU / kontrast
  const uuBullets = [];
  if (contrastRisk === 'høy')
    uuBullets.push(
      'Svak kontrast: mange lyse/bleke tekster som kan være vanskelige å lese.'
    );
  if (contrastRisk === 'middels')
    uuBullets.push(
      'Noe risiko for svak kontrast, med flere lyse tekststiler.'
    );
  if (contrastExamples.length) {
    uuBullets.push('Eksempler på potensielt problematisk tekstfarge/klasse:');
    contrastExamples.slice(0, 3).forEach((ex) => uuBullets.push(`* ${ex}`));
  }

  if (uuBullets.length) {
    problems.push({
      title: '2) Brudd på UU‑krav (indikasjoner på svak universell utforming)',
      bullets: uuBullets,
      impacts: [
        'Noen brukere vil ha problemer med å lese innholdet.',
        'Gir risiko for klager/pålegg og et mindre profesjonelt inntrykk.'
      ]
    });
  }

  // 3) Lav PageSpeed – grov indikasjon
  const pageBullets = [];
  if (textLength > 8000)
    pageBullets.push(
      'Mye innhold lastes på én side, noe som kan gjøre siden tung å laste på mobil.'
    );

  if (pageBullets.length) {
    problems.push({
      title: '3) Lav PageSpeed – treg side (indikasjon)',
      bullets: pageBullets,
      impacts: [
        'Kunder mister tålmodigheten hvis siden oppleves treg, spesielt på mobil.',
        'Google prioriterer raskere sider, så treghet kan gi færre klikk og henvendelser.'
      ]
    });
  }

  // 4) Kunder får ikke med seg viktig innhold
  const contentBullets = [];
  if (textLength < 2000)
    contentBullets.push(
      'Lite overordnet innhold som forklarer hvem dere er, hva dere gjør og hvorfor kunden skal velge dere.'
    );
  if (!hasServiceWords)
    contentBullets.push(
      'Mangler tydelige seksjoner som løfter frem de viktigste tjenestene.'
    );
  if (contrastRisk === 'høy' || contrastRisk === 'middels')
    contentBullets.push('Lesbarheten påvirkes negativt av svak kontrast enkelte steder.');

  if (contentBullets.length) {
    problems.push({
      title: '4) Kunder får ikke med seg viktig innhold',
      bullets: contentBullets,
      impacts: [
        'Tapte salgspunkter – budskapene deres kommer ikke tydelig nok frem.',
        'Færre tar kontakt enn dere kunne hatt med tydeligere og mer lesbart innhold.'
      ]
    });
  }

  // 5) Ingen FAQ / LLM-optimalisering
  const aeoBullets = [];
  if (!hasFAQ)
    aeoBullets.push('Ingen FAQ eller tydelig spørsmål/svar-seksjon (FAQ) funnet.');
  if (!hasSchema)
    aeoBullets.push(
      'Ingen strukturert data som gjør det lett for AI-tjenester å forstå virksomheten.'
    );

  if (aeoBullets.length) {
    problems.push({
      title: '5) Ingen FAQ eller LLM-optimalisering (AEO)',
      bullets: aeoBullets,
      impacts: [
        'Nettsiden dukker i liten grad opp i AI-genererte svar (ChatGPT, Bing, Google AI).',
        'Konkurrenter som har FAQ og strukturert data vil få et forsprang i nye søkekanaler.'
      ]
    });
  }

  return problems;
}

/**
 * Bygg hele rapporten
 */
function buildReport(url, html, analysis) {
  const { seoScore } = analysis;
  const label = seoLabel(seoScore);
  const mainKeyword = guessMainKeyword(html, url);
  const location = guessLocation(html);
  const ranking = buildRankingSection(mainKeyword, location, seoScore);
  const problems = buildProblemsSection(analysis);

  let out = '';

  out += `Din side (${url})\n`;
  out += `har fått en SEO‑score på\n`;
  out += `${seoScore} / 100 (${label})\n\n`;

  out += `${ranking}\n\n`;
  out += `Hvorfor ${url} scorer dårlig i Google\n\n`;
  out += `De største problemene\n`;

  problems.forEach((p) => {
    out += `\n${p.title}\n`;
    p.bullets.forEach((b) => {
      out += `* ${b}\n`;
    });
    p.impacts.forEach((i) => {
      out += `→ ${i}\n`;
    });
  });

  out += `\nHva vi fant\n`;
  out += `Dette nettstedet har flere svakheter som påvirker:\n`;
  out += `* synlighet i Google\n`;
  out += `* brukeropplevelse\n`;
  out += `* troverdighet\n`;
  out += `* konverteringer (hvor mange som faktisk tar kontakt)\n`;
  out += `* risiko for brudd på norsk tilgjengelighetslov (UU)\n\n`;

  out += `Hvordan vi kan hjelpe deg\n`;
  out += `Vi leverer:\n`;
  out += `* Raskere sider\n`;
  out += `* Bedre SEO\n`;
  out += `* Bedre universell utforming (UU)\n`;
  out += `* Strukturert data + AI‑optimalisering\n`;
  out += `* Bedre konvertering og mer profesjonell presentasjon\n`;

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
    const report = buildReport(targetUrl, html, analysis);

    fs.writeFileSync('SALGS-RAPPORT.txt', report, 'utf8');
    console.log('SALGS-RAPPORT.txt generert ✅');
  } catch (err) {
    console.error('Feil under kjøring av agent:', err);
    process.exit(1);
  }
})();
