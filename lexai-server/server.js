const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MOCK_MODE = process.env.MOCK_MODE === 'true';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';

if (MOCK_MODE) { console.log('⚠️  MOCK MODE AKTÍV'); }
else { console.log('✅ ÉLES MÓD v2 – 4 lépéses elemzés'); }

// ============================================================
// PTK RAG
// ============================================================
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getEmbedding(text) {
  if (!OPENAI_KEY) return null;
  try {
    const resp = await httpsPost('api.openai.com', '/v1/embeddings',
      { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
      { model: 'text-embedding-3-small', input: text.slice(0, 2000) }
    );
    return resp.data[0].embedding;
  } catch(e) { console.error('Embedding hiba:', e.message); return null; }
}

async function searchPtk(contractText, matchCount = 8) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_KEY) return [];
  const embedding = await getEmbedding(contractText);
  if (!embedding) return [];
  try {
    const resp = await httpsPost(
      SUPABASE_URL.replace('https://', ''),
      '/rest/v1/rpc/search_ptk',
      { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
      { query_embedding: embedding, match_count: matchCount, similarity_threshold: 0.65 }
    );
    return Array.isArray(resp) ? resp : [];
  } catch(e) { console.error('Ptk keresés hiba:', e.message); return []; }
}

function formatPtkContext(paragraphs) {
  if (!paragraphs.length) return '';
  return '\n\nRELEVÁNS PTK. §-OK:\n' + paragraphs.map(p =>
    p.section_id + (p.title ? ' [' + p.title + ']' : '') + ':\n' + p.content.slice(0, 250)
  ).join('\n\n');
}

// ============================================================
// HELPER FUNKCIÓK
// ============================================================
function splitIntoChunks(text, maxSize) {
  if (text.length <= maxSize) return [text];
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = '';
  for (const para of paragraphs) {
    if ((current + para).length > maxSize && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}

function extractJSON(raw) {
  if (!raw) return null;
  let c = raw.replace(/```json/gi, '').replace(/```/gi, '').trim();
  const start = c.indexOf('{');
  const end = c.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  c = c.substring(start, end + 1);
  try { return JSON.parse(c); }
  catch(e) {
    try { return JSON.parse(c.replace(/,(\s*[}\]])/g, '$1')); }
    catch(e2) { return null; }
  }
}

function estimateCost(inputTokens, outputTokens) {
  const totalUsd = (inputTokens / 1000000) * 3.0 + (outputTokens / 1000000) * 15.0;
  return { input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: Math.round(totalUsd * 10000) / 10000, cost_huf: Math.round(totalUsd * 370) };
}

// ============================================================
// MOCK ADATOK
// ============================================================
const MOCK_ANALYZE_RESULT = {
  fel1_score: 38, fel2_score: 63,
  fel1_name: 'Óbuda Uni Venture Capital Zrt.', fel2_name: 'Alapítók és Céltársaság',
  per_esely_fel1: 38, per_esely_fel2: 62, merleg: 'fel2_eros', score: 50,
  verdict: 'Az Alapítók erősebb pozícióban vannak',
  summary: 'A szerződés az Alapítók javára billen. A Befektető exit garanciái gyengék.',
  top_actions: ['Exit garancia klauzula beépítése', 'Drag-Along küszöb emelése 80%-ra', 'ESOP keretszerződés elkészítése'],
  fel1_javaslatok: ['Preferred Return minimum 2x biztosítása', 'Board megfigyelői jog erősítése'],
  fel2_javaslatok: ['Tag-Along jog 100%-os részvételre', 'Vesting ütemezés rögzítése'],
  issues: [{
    severity: 'kritikus', title: 'Exit garancia hiánya',
    location: '6.2 Exit rendelkezések', favors: 'fel2',
    description: 'Az 5 éves exit csak szándék, nem kötelezettség.',
    fix_text: 'Kötelező visszavásárlási jog beépítése 5 év után.',
    impactA: 'A Befektető bennreked a befektetésével.',
    impactB: 'Az Alapítóknak nem kell exitálni.',
    ptk_ref: '6:150.§ – Szerződés megszűnése felmondással'
  }],
  positives: [{ title: 'Anti-dilúciós védelem biztosított', description: '' }],
  structure: { fel1: 'Befektető', fel2: 'Alapítók', type: 'Befektetési szerződés' },
  ptk_references: [{ section: '6:150.§', title: 'Felmondás', book: 'Hatodik Könyv' }],
  _pages: 12, _sections: 3, _mock: true
};

const MOCK_GENERATE_HINTS = {
  hints: [
    { text: 'Fizetési határidő és késedelmi kamat (Ptk. 6:155§)', importance: 'must' },
    { text: 'Teljesítési hely és átvétel módja', importance: 'must' },
    { text: 'Szavatossági feltételek', importance: 'must' },
    { text: 'Felmondási feltételek', importance: 'rec' },
    { text: 'Vis maior klauzula', importance: 'rec' },
    { text: 'Vitarendezés módja', importance: 'opt' }
  ]
};

// ============================================================
// ROUTES
// ============================================================
app.get('/', (req, res) => {
  res.json({ status: 'LexAI Backend', version: '11.0-4step', mock_mode: MOCK_MODE });
});

// ============================================================
// ELEMZÉS – 4 LÉPÉSES MEGKÖZELÍTÉS
// ============================================================
app.post('/api/analyze', async (req, res) => {
  try {
    const { text, type } = req.body;
    if (!text || text.length < 30) return res.status(400).json({ error: 'Nincs szöveg' });

    if (MOCK_MODE) {
      await new Promise(r => setTimeout(r, 1500));
      return res.json(MOCK_ANALYZE_RESULT);
    }

    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    let totalInputTokens = 0, totalOutputTokens = 0;
    const textSample = text.slice(0, 8000);

    // ── LÉPÉS 1: Felek és szerződés azonosítása ──────────────
    console.log('1. lépés: Felek azonosítása...');
    const step1 = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 800,
      messages: [{ role: 'user', content:
        'Olvasd el ezt a szerződést és azonosítsd a feleket PONTOSAN.\n\n' +
        'SZERZŐDÉS:\n' + textSample + '\n\n' +
        'FELADAT: Azonosítsd:\n' +
        '1. Ki az 1. fél? (neve, szerepe a szerződésben: pl. Megrendelő, Befektető, Eladó, Munkáltató)\n' +
        '2. Ki a 2. fél? (neve, szerepe: pl. Vállalkozó, Alapító, Vevő, Munkavállaló)\n' +
        '3. Mi a szerződés típusa?\n' +
        '4. Mi a szerződés fő tárgya?\n' +
        '5. Melyik fél van ERŐSEBB tárgyalási pozícióban általában ilyen szerződésben?\n\n' +
        'Csak ezt a JSON-t írd (TILOS ```json):\n' +
        '{"fel1_nev":"pontos név","fel1_szerep":"pl. Befektető/Megrendelő/Eladó","fel2_nev":"pontos név","fel2_szerep":"pl. Alapító/Vállalkozó/Vevő","szerzodes_tipus":"pl. Befektetési szerződés","szerzodes_targy":"rövid leírás","erosebb_fel":"fel1|fel2","indok":"miért"}'
      }]
    });
    totalInputTokens += step1.usage.input_tokens;
    totalOutputTokens += step1.usage.output_tokens;
    const felek = extractJSON(step1.content[0].text) || {};
    console.log('Felek:', felek.fel1_nev, '/', felek.fel2_nev);

    // ── LÉPÉS 2: PTK keresés ──────────────────────────────────
    console.log('2. lépés: Ptk. RAG keresés...');
    const ptkParagraphs = await searchPtk(text);
    const ptkContext = formatPtkContext(ptkParagraphs);
    console.log('Ptk. találatok:', ptkParagraphs.length);

    // ── LÉPÉS 3: Klauzula elemzés – ki kinek kedvez ──────────
    console.log('3. lépés: Klauzula elemzés...');
    const chunks = splitIntoChunks(text, 10000);
    const toAnalyze = chunks.length <= 3 ? chunks : [chunks[0], chunks[Math.floor(chunks.length/2)], chunks[chunks.length-1]];
    const estPages = Math.max(1, Math.round(text.length / 1800));

    const allIssues = [];
    const allPositives = [];
    const s1arr = [], s2arr = [];

    for (let i = 0; i < toAnalyze.length; i++) {
      const chunk = toAnalyze[i];
      const pFrom = Math.round(i * estPages / toAnalyze.length) + 1;
      const pTo = Math.round((i+1) * estPages / toAnalyze.length);

      // Problémák keresése – explicit fél-meghatározással
      for (let n = 1; n <= 3; n++) {
        try {
          const rN = await client.messages.create({
            model: 'claude-sonnet-4-5',
            max_tokens: 800,
            messages: [{ role: 'user', content:
              'FONTOS KONTEXTUS:\n' +
              '- 1. FÉL: ' + (felek.fel1_nev || '1. Fél') + ' (szerepe: ' + (felek.fel1_szerep || 'ismeretlen') + ')\n' +
              '- 2. FÉL: ' + (felek.fel2_nev || '2. Fél') + ' (szerepe: ' + (felek.fel2_szerep || 'ismeretlen') + ')\n' +
              '- SZERZŐDÉS TÍPUSA: ' + (felek.szerzodes_tipus || 'ismeretlen') + '\n\n' +
              'SZERZŐDÉSRÉSZ (~' + pFrom + '-' + pTo + '. oldal):\n' + chunk + '\n' +
              ptkContext + '\n\n' +
              'FELADAT: Add meg a ' + n + '. legsúlyosabb problémát ebben a részben.\n' +
              'KRITIKUS: A "favors" mezőbe PONTOSAN add meg melyik félnek KEDVEZ ez a klauzula.\n' +
              'Ha a klauzula az 1. félnek (' + (felek.fel1_nev || '1. Fél') + ') kedvez → favors="fel1"\n' +
              'Ha a klauzula a 2. félnek (' + (felek.fel2_nev || '2. Fél') + ') kedvez → favors="fel2"\n' +
              'Ha mindkettőnek → favors="mindketto"\n\n' +
              'Csak ezt a JSON-t írd (TILOS ```json):\n' +
              '{"van":true,"sev":"kritikus|figyelmeztetés|info","title":"probléma neve","loc":"fejezet (~' + pFrom + '.o)","favors":"fel1|fel2|mindketto","desc":"miért probléma max 150 kar","fix":"konkrét javítás max 150 kar","impactA":"hatás ' + (felek.fel1_nev || '1. félre') + ' max 100 kar","impactB":"hatás ' + (felek.fel2_nev || '2. félre') + ' max 100 kar","ptk":"pl. 6:142.§ – Kártérítés vagy üres"}\n' +
              'Ha nincs ' + n + '. probléma: {"van":false}'
            }]
          });
          totalInputTokens += rN.usage.input_tokens;
          totalOutputTokens += rN.usage.output_tokens;
          const issue = extractJSON(rN.content[0].text);
          if (issue && issue.van && issue.title) {
            allIssues.push({
              severity: issue.sev || 'figyelmeztetés',
              title: issue.title,
              location: issue.loc || '',
              favors: issue.favors || 'mindketto',
              description: issue.desc || '',
              fix_text: issue.fix || '',
              impactA: issue.impactA || '',
              impactB: issue.impactB || '',
              ptk_ref: issue.ptk || ''
            });
          }
        } catch(e) { console.error('Issue hiba:', e.message); }
      }

      // Védettségi szint külön kérés – explicit fél-meghatározással
      try {
        const rScore = await client.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 400,
          messages: [{ role: 'user', content:
            '1. FÉL: ' + (felek.fel1_nev || '1. Fél') + ' (szerepe: ' + (felek.fel1_szerep || '') + ')\n' +
            '2. FÉL: ' + (felek.fel2_nev || '2. Fél') + ' (szerepe: ' + (felek.fel2_szerep || '') + ')\n\n' +
            'SZERZŐDÉSRÉSZ:\n' + chunk.slice(0, 3000) + '\n\n' +
            'Értékeld 0-100 között mennyire védett ez a szerződésrész az egyes felek számára.\n' +
            '100 = teljesen védett, minden jog megvan\n' +
            '0 = teljesen kiszolgáltatott, nincs védelme\n\n' +
            'FONTOS: A két szám NEM kell hogy összegük 100 legyen! Mindkettő önállóan értékelendő.\n\n' +
            'Csak ezt a JSON-t írd (TILOS ```json):\n' +
            '{"fel1_score":SZAM_0_100,"fel2_score":SZAM_0_100,"pos1":"pozitívum a szerződésben max 80 kar","pos2":"pozitívum max 80 kar"}'
          }]
        });
        totalInputTokens += rScore.usage.input_tokens;
        totalOutputTokens += rScore.usage.output_tokens;
        const score = extractJSON(rScore.content[0].text);
        if (score) {
          if (score.fel1_score !== undefined) s1arr.push(score.fel1_score);
          if (score.fel2_score !== undefined) s2arr.push(score.fel2_score);
          if (score.pos1) allPositives.push({ title: score.pos1, description: '' });
          if (score.pos2) allPositives.push({ title: score.pos2, description: '' });
        }
      } catch(e) { console.error('Score hiba:', e.message); }
    }

    // ── LÉPÉS 4: Összefoglalás és javaslatok ─────────────────
    console.log('4. lépés: Összefoglalás...');
    const avgS1 = s1arr.length ? Math.round(s1arr.reduce((a,b)=>a+b,0)/s1arr.length) : 50;
    const avgS2 = s2arr.length ? Math.round(s2arr.reduce((a,b)=>a+b,0)/s2arr.length) : 50;

    const kritikusIssues = allIssues.filter(x => x.severity === 'kritikus').slice(0,3);
    const fel1Issues = allIssues.filter(x => x.favors === 'fel1').length;
    const fel2Issues = allIssues.filter(x => x.favors === 'fel2').length;

    const sumR = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      messages: [{ role: 'user', content:
        'SZERZŐDÉS ELEMZÉS ÖSSZEFOGLALÁSA:\n\n' +
        '1. FÉL: ' + (felek.fel1_nev || '1. Fél') + ' (' + (felek.fel1_szerep || '') + ') – védettségi szint: ' + avgS1 + '/100\n' +
        '2. FÉL: ' + (felek.fel2_nev || '2. Fél') + ' (' + (felek.fel2_szerep || '') + ') – védettségi szint: ' + avgS2 + '/100\n' +
        'Szerződés típusa: ' + (felek.szerzodes_tipus || 'ismeretlen') + '\n' +
        'Erősebb tárgyalási pozíció: ' + (felek.erosebb_fel === 'fel1' ? felek.fel1_nev : felek.fel2_nev) + '\n\n' +
        'Problémák statisztika:\n' +
        '- ' + (felek.fel1_nev || '1. félnek') + ' kedvező klauzulák: ' + fel1Issues + ' db\n' +
        '- ' + (felek.fel2_nev || '2. félnek') + ' kedvező klauzulák: ' + fel2Issues + ' db\n' +
        'Kritikus problémák: ' + kritikusIssues.map(x=>x.title).join(', ') + '\n\n' +
        'Add meg a végső összefoglalót és pernyerési esélyeket.\n' +
        'FONTOS: p1 + p2 = 100! A magasabb védettségi szintű félnek legyen magasabb esélye.\n\n' +
        'Csak ezt a JSON-t írd (TILOS ```json):\n' +
        '{"verdict":"10 szavas összítélet","p1":SZAM,"p2":SZAM,"merleg":"fel1_eros|fel2_eros|kiegyensulyozott","summary":"3 mondatos összefoglaló konkrétan","j1a":"konkrét javaslat ' + (felek.fel1_nev||'1. félnek') + '","j1b":"konkrét javaslat","j2a":"konkrét javaslat ' + (felek.fel2_nev||'2. félnek') + '","j2b":"konkrét javaslat","a1":"legsürgősebb teendő","a2":"2. teendő","a3":"3. teendő"}'
      }]
    });
    totalInputTokens += sumR.usage.input_tokens;
    totalOutputTokens += sumR.usage.output_tokens;
    const sum = extractJSON(sumR.content[0].text) || {};

    // Deduplikálás
    const seen = {};
    const dedup = allIssues.filter(x => { if(seen[x.title]) return false; seen[x.title]=true; return true; });
    const cost = estimateCost(totalInputTokens, totalOutputTokens);

    console.log('KÉSZ: s1=' + avgS1 + ' s2=' + avgS2 + ' issues=' + dedup.length + ' ptk=' + ptkParagraphs.length + ' | Költség: ~' + cost.cost_huf + ' Ft');

    res.json({
      fel1_score: avgS1,
      fel2_score: avgS2,
      fel1_name: felek.fel1_nev || '1. Fél',
      fel2_name: felek.fel2_nev || '2. Fél',
      fel1_szerep: felek.fel1_szerep || '',
      fel2_szerep: felek.fel2_szerep || '',
      per_esely_fel1: sum.p1 || Math.round(avgS1/(avgS1+avgS2)*100),
      per_esely_fel2: sum.p2 || Math.round(avgS2/(avgS1+avgS2)*100),
      merleg: sum.merleg || 'kiegyensulyozott',
      score: Math.round((avgS1+avgS2)/2),
      verdict: sum.verdict || 'Az elemzés elkészült.',
      summary: sum.summary || 'Az elemzés elkészült.',
      top_actions: [sum.a1, sum.a2, sum.a3].filter(Boolean),
      fel1_javaslatok: [sum.j1a, sum.j1b].filter(Boolean),
      fel2_javaslatok: [sum.j2a, sum.j2b].filter(Boolean),
      issues: dedup.slice(0, 15),
      positives: allPositives.filter((v,i,a) => a.findIndex(x=>x.title===v.title)===i).slice(0,6),
      structure: { fel1: felek.fel1_nev, fel2: felek.fel2_nev, type: felek.szerzodes_tipus },
      ptk_references: ptkParagraphs.map(p => ({ section: p.section_id, title: p.title, book: p.book })),
      _pages: estPages,
      _sections: toAnalyze.length,
      _cost: cost
    });

  } catch(err) {
    console.error('Hiba:', err.message);
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

// ============================================================
// SZERZŐDÉS GENERÁLÁS
// ============================================================
app.post('/api/generate', async (req, res) => {
  try {
    const { action, type, favor, party1, party2, amount, deadline, date, level, details, special } = req.body;

    if (MOCK_MODE) {
      await new Promise(r => setTimeout(r, 800));
      if (action === 'hints') return res.json(MOCK_GENERATE_HINTS);
      if (action === 'generate') return res.json({
        contract: 'VÁLLALKOZÁSI SZERZŐDÉS\n\n[MOCK]\n\nMELY LÉTREJÖTT\n\n' + (party1||'1. Fél') + '\nés\n' + (party2||'2. Fél') + '\n\nközött.\n\nKelt: ' + (date||new Date().toLocaleDateString('hu-HU')),
        _mock: true
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    if (action === 'hints') {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 2000,
        messages: [{ role: 'user', content: 'Magyar ügyvéd. Mit kell egy "' + type + '" szerz.-be "' + favor + '" szerint.\nJSON: {"hints":[{"text":"STRING","importance":"must|rec|opt"}]}' }]
      });
      return res.json(extractJSON(r.content[0].text) || { hints: [] });
    }

    if (action === 'generate') {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 8000,
        system: 'Tapasztalt magyar ügyvéd. Készíts ' + level + ' ' + type + 't PTK alapján. Védd ' + favor + ' érdekeit. Legyen teljes, konkrét Ptk. hivatkozásokkal!',
        messages: [{ role: 'user', content:
          'Típus:' + type + '\n1. Fél:' + (party1||'1. Fél') + '\n2. Fél:' + (party2||'2. Fél') +
          '\nÖsszeg:' + (amount||'megállapodás szerint') + '\nHatáridő:' + (deadline||'megállapodás szerint') +
          '\nDátum:' + (date||new Date().toLocaleDateString('hu-HU')) + '\nRészletesség:' + level +
          '\nTárgy:' + details + '\nKülönleges:' + (special||'szokásos')
        }]
      });
      const cost = estimateCost(r.usage.input_tokens, r.usage.output_tokens);
      return res.json({ contract: r.content[0].text, _cost: cost });
    }

    res.status(400).json({ error: 'Ismeretlen action' });
  } catch(err) {
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('LexAI szerver fut: port ' + PORT));
