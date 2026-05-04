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

if (MOCK_MODE) {
  console.log('⚠️  MOCK MODE AKTÍV');
} else {
  console.log('✅ ÉLES MÓD');
}

// ============================================================
// PTK RAG – OpenAI embedding + Supabase keresés
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
    const resp = await httpsPost('api.openai.com', '/v1/embeddings', {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + OPENAI_KEY
    }, { model: 'text-embedding-3-small', input: text.slice(0, 2000) });
    return resp.data[0].embedding;
  } catch(e) {
    console.error('Embedding hiba:', e.message);
    return null;
  }
}

async function searchPtk(contractText, matchCount = 6) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_KEY) return [];
  const embedding = await getEmbedding(contractText);
  if (!embedding) return [];
  try {
    const resp = await httpsPost(
      SUPABASE_URL.replace('https://', ''),
      '/rest/v1/rpc/search_ptk',
      {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY
      },
      { query_embedding: embedding, match_count: matchCount, similarity_threshold: 0.65 }
    );
    return Array.isArray(resp) ? resp : [];
  } catch(e) {
    console.error('Ptk keresés hiba:', e.message);
    return [];
  }
}

function formatPtkContext(paragraphs) {
  if (!paragraphs.length) return '';
  return '\n\n---\nRELEVÁNS PTK. §-OK:\n' + paragraphs.map(p =>
    p.section_id + (p.title ? ' [' + p.title + ']' : '') + ' (' + (p.book || '') + '):\n' + p.content.slice(0, 300)
  ).join('\n\n');
}

// ============================================================
// PTK FELTÖLTŐ ENDPOINT – /api/upload-ptk
// Ezt egyszer kell meghívni a Ptk. adatbázisba töltéséhez!
// ============================================================

const PTK_CHUNKS = []; // Ide kerül a parsed Ptk. (lásd alább)

app.post('/api/upload-ptk', async (req, res) => {
  const { secret } = req.body;
  if (secret !== 'lexai-ptk-2024') return res.status(403).json({ error: 'Tiltott' });
  if (!OPENAI_KEY || !SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Hiányzó env változók' });

  res.json({ message: 'Feltöltés elindult a háttérben, nézd a logokat!' });

  // Háttérben fut
  (async () => {
    console.log('PTK feltöltés indul... ' + PTK_CHUNKS.length + ' chunk');
    let ok = 0, err = 0;
    const BATCH = 10;
    for (let i = 0; i < PTK_CHUNKS.length; i += BATCH) {
      const batch = PTK_CHUNKS.slice(i, i + BATCH);
      for (const chunk of batch) {
        try {
          const emb = await getEmbedding(chunk.section_id + ' ' + chunk.title + '\n' + chunk.content);
          if (!emb) { err++; continue; }
          await httpsPost(
            SUPABASE_URL.replace('https://', ''),
            '/rest/v1/ptk_paragraphs',
            { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Prefer': 'return=minimal' },
            { section_id: chunk.section_id, title: chunk.title, book: chunk.book, chapter: chunk.chapter, content: chunk.content, embedding: emb }
          );
          ok++;
          if (ok % 50 === 0) console.log('Feltöltve: ' + ok + '/' + PTK_CHUNKS.length);
        } catch(e) { console.error('Chunk hiba:', e.message); err++; }
      }
      await new Promise(r => setTimeout(r, 200));
    }
    console.log('PTK feltöltés kész! OK:' + ok + ' Hiba:' + err);
  })();
});

// ============================================================
// MOCK ADATOK
// ============================================================
const MOCK_ANALYZE_RESULT = {
  fel1_score: 72, fel2_score: 28,
  fel1_name: 'Óbuda Uni Venture Capital Zrt.', fel2_name: 'Alapítók és Céltársaság',
  per_esely_fel1: 72, per_esely_fel2: 28, merleg: 'fel1_eros', score: 50,
  verdict: 'Strukturális egyensúlyhiány, kisebbségi jogvédelem hiányos',
  summary: 'A szerződés jelentősen a Befektető javára billen. Az Alapítók kisebbségi jogai nincsenek megfelelően védve.',
  top_actions: ['ESOP keretszerződés megalkotása', 'Drag-Along küszöb minimum 80%-ra emelése', 'Kisebbségi vétójogok explicit rögzítése'],
  fel1_javaslatok: ['ESOP pool explicit elkülönítése', 'Preferred Return minimum 2x biztosítása'],
  fel2_javaslatok: ['Drag-Along minimálár küszöb beépítése', 'Tag-Along jog 100%-os részvételre'],
  issues: [{
    severity: 'kritikus', title: 'ESOP részesedés jogi státusza tisztázatlan',
    location: '4.4.2 Tulajdonosi szerkezet (~3. oldal)', favors: 'mindketto',
    description: 'Az ESOP részesedések nincsenek külön jogosulthoz rendelve.',
    fix_text: 'Külön ESOP megállapodás készítése szükséges.',
    impactA: 'Szavazati erőviszonyok megváltozása.', impactB: 'Befektetői pozíció gyengülése.',
    ptk_refs: [{ section: '3:1.§', title: 'A jogi személy', book: 'Harmadik Könyv – Jogi személyek' }]
  }],
  positives: [{ title: 'Részletes anti-dilúciós védelem', description: '' }],
  structure: { fel1: 'Óbuda Uni Venture Capital Zrt.', fel2: 'Alapítók', type: 'Befektetési szerződés' },
  _pages: 12, _sections: 3, _mock: true
};

const MOCK_GENERATE_HINTS = {
  hints: [
    { text: 'Fizetési határidő és késedelmi kamat mértéke (Ptk. 6:155§)', importance: 'must' },
    { text: 'Teljesítési hely és átvétel módja', importance: 'must' },
    { text: 'Szavatossági és jótállási feltételek', importance: 'must' },
    { text: 'Felmondási feltételek és felmondási idő', importance: 'rec' },
    { text: 'Vis maior klauzula és értelmezése', importance: 'rec' },
    { text: 'Vitarendezés módja', importance: 'opt' }
  ]
};

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
  const inputCost = (inputTokens / 1000000) * 3.0;
  const outputCost = (outputTokens / 1000000) * 15.0;
  const totalUsd = inputCost + outputCost;
  return { input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: Math.round(totalUsd * 10000) / 10000, cost_huf: Math.round(totalUsd * 370) };
}

// ============================================================
// ROUTES
// ============================================================
app.get('/', (req, res) => {
  res.json({ status: 'LexAI Backend running', version: '7.0-RAG', mock_mode: MOCK_MODE });
});

// ============================================================
// ELEMZÉS – RAG alapú Ptk. hivatkozásokkal
// ============================================================
app.post('/api/analyze', async (req, res) => {
  try {
    const { text, type } = req.body;
    if (!text || text.length < 30) return res.status(400).json({ error: 'Nincs szöveg' });

    if (MOCK_MODE) {
      console.log('MOCK: analyze kérés');
      await new Promise(r => setTimeout(r, 1500));
      return res.json(MOCK_ANALYZE_RESULT);
    }

    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    // PTK RAG keresés
    console.log('Ptk. RAG keresés indul...');
    const ptkParagraphs = await searchPtk(text);
    const ptkContext = formatPtkContext(ptkParagraphs);
    console.log('Ptk. találatok: ' + ptkParagraphs.length + ' §');

    const estPages = Math.max(1, Math.round(text.length / 1800));
    const chunks = splitIntoChunks(text, 12000);
    const toAnalyze = chunks.length <= 3 ? chunks : [chunks[0], chunks[Math.floor(chunks.length/2)], chunks[chunks.length-1]];

    console.log('Elemzés: ' + estPages + ' oldal, ' + toAnalyze.length + ' rész');

    const allIssues = [];
    const allPositives = [];
    const s1arr = [], s2arr = [];
    let structure = {};
    let totalInputTokens = 0, totalOutputTokens = 0;

    for (let i = 0; i < toAnalyze.length; i++) {
      const chunk = toAnalyze[i];
      const pFrom = Math.round(i * estPages / toAnalyze.length) + 1;
      const pTo = Math.round((i+1) * estPages / toAnalyze.length);

      // Alap info
      try {
        const r1 = await client.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 500,
          messages: [{ role: 'user', content:
            'Szerződésrész (~' + pFrom + '-' + pTo + '. oldal). Adj alap infót.\n\n' +
            chunk.substring(0, 2000) + '\n\n' +
            'Csak ezt a JSON-t írd (TILOS ```json):\n' +
            '{"fel1_score":NUMBER,"fel2_score":NUMBER,"fel1":"fél1 neve max 30 kar","fel2":"fél2 neve max 30 kar","type":"szerz típus max 30 kar","pos1":"pozitívum max 60 kar","pos2":"pozitívum max 60 kar"}'
          }]
        });
        totalInputTokens += r1.usage.input_tokens;
        totalOutputTokens += r1.usage.output_tokens;
        const info = extractJSON(r1.content[0].text);
        if (info) {
          if (info.fel1_score) s1arr.push(info.fel1_score);
          if (info.fel2_score) s2arr.push(info.fel2_score);
          if (info.fel1 && !structure.fel1) structure = { fel1: info.fel1, fel2: info.fel2, type: info.type };
          if (info.pos1) allPositives.push({ title: info.pos1, description: '' });
          if (info.pos2) allPositives.push({ title: info.pos2, description: '' });
        }
      } catch(e) { console.error('Info hiba:', e.message); }

      // Problémák – most PTK kontextussal!
      const problemPrompt = 'Szerződésrész (~' + pFrom + '-' + pTo + '. oldal):\n\n' + chunk + ptkContext + '\n\n';

      for (let n = 1; n <= 2; n++) {
        try {
          const rN = await client.messages.create({
            model: 'claude-sonnet-4-5',
            max_tokens: 700,
            messages: [{ role: 'user', content:
              problemPrompt +
              'Add meg a ' + n + '. legsúlyosabb jogi problémát. Ha van releváns Ptk. §, hivatkozz rá!\n' +
              'Csak ezt a JSON-t írd (TILOS ```json, max 120 kar/érték):\n' +
              '{"van":true,"sev":"kritikus|figyelmeztetés|info","title":"probléma neve","loc":"fejezet/pont (~' + pFrom + '.o)","favors":"fel1|fel2|mindketto","desc":"miért probléma","fix":"konkrét javítás","impactA":"hatás 1. félre","impactB":"hatás 2. félre","ptk":"pl. 6:62.§ – adásvétel vagy üres string"}\n' +
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
        } catch(e) { console.error('Issue' + n + ' hiba:', e.message); }
      }
    }

    const avgS1 = s1arr.length ? Math.round(s1arr.reduce((a,b)=>a+b,0)/s1arr.length) : 50;
    const avgS2 = s2arr.length ? Math.round(s2arr.reduce((a,b)=>a+b,0)/s2arr.length) : 50;
    const topIssues = allIssues.slice(0,3).map(x=>x.title).join('; ') || 'nincs';

    const sumR = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      messages: [{ role: 'user', content:
        '1.fél:' + (structure.fel1||'Ügyfél') + ' védettségi szint:' + avgS1 + '/100. 2.fél:' + (structure.fel2||'Szolgáltató') + ' védettségi szint:' + avgS2 + '/100.\n' +
        'Főbb problémák:' + topIssues + '\n' +
        'Csak ezt a JSON-t írd (TILOS ```json):\n' +
        '{"verdict":"összítélet max 10 szó","p1":SZAM,"p2":SZAM,"merleg":"fel1_eros|fel2_eros|kiegyensulyozott","summary":"3 mondatos összefoglaló","j1a":"javaslat","j1b":"javaslat","j2a":"javaslat","j2b":"javaslat","a1":"teendő","a2":"teendő","a3":"teendő"}'
      }]
    });
    totalInputTokens += sumR.usage.input_tokens;
    totalOutputTokens += sumR.usage.output_tokens;
    const sum = extractJSON(sumR.content[0].text) || {};

    const seen = {};
    const dedup = allIssues.filter(x => { if(seen[x.title]) return false; seen[x.title]=true; return true; });
    const cost = estimateCost(totalInputTokens, totalOutputTokens);
    console.log('KÉSZ: s1=' + avgS1 + ' s2=' + avgS2 + ' issues=' + dedup.length + ' ptk=' + ptkParagraphs.length + ' | Költség: ~' + cost.cost_huf + ' Ft');

    res.json({
      fel1_score: avgS1, fel2_score: avgS2,
      fel1_name: structure.fel1 || '1. Fél', fel2_name: structure.fel2 || '2. Fél',
      per_esely_fel1: sum.p1 || Math.round(avgS1/(avgS1+avgS2)*100),
      per_esely_fel2: sum.p2 || Math.round(avgS2/(avgS1+avgS2)*100),
      merleg: sum.merleg || 'kiegyensulyozott', score: Math.round((avgS1+avgS2)/2),
      verdict: sum.verdict || 'Az elemzés elkészült.',
      summary: sum.summary || 'Az elemzés elkészült.',
      top_actions: [sum.a1, sum.a2, sum.a3].filter(Boolean),
      fel1_javaslatok: [sum.j1a, sum.j1b].filter(Boolean),
      fel2_javaslatok: [sum.j2a, sum.j2b].filter(Boolean),
      issues: dedup.slice(0, 15),
      positives: allPositives.filter((v,i,a) => a.findIndex(x=>x.title===v.title)===i).slice(0,6),
      structure: structure,
      ptk_references: ptkParagraphs.map(p => ({ section: p.section_id, title: p.title, book: p.book })),
      _pages: estPages, _sections: toAnalyze.length, _cost: cost
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
        messages: [{ role: 'user', content: 'Típus:' + type + '\n1. Fél:' + (party1||'1. Fél') + '\n2. Fél:' + (party2||'2. Fél') + '\nÖsszeg:' + (amount||'megállapodás szerint') + '\nHatáridő:' + (deadline||'megállapodás szerint') + '\nDátum:' + (date||new Date().toLocaleDateString('hu-HU')) + '\nRészletesség:' + level + '\nTárgy:' + details + '\nKülönleges:' + (special||'szokásos') }]
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
