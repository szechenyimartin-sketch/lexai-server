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

if (MOCK_MODE) { console.log('⚠️  MOCK MODE'); }
else { console.log('✅ ÉLES MÓD v3 – userParty alapú elemzés'); }

// ── PTK RAG ──────────────────────────────────────────────────────────────────
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
  return '\n\nRELEVÁNS PTK. §-OK (használd ezeket a hivatkozásokban!):\n' +
    paragraphs.map(p => p.section_id + (p.title ? ' [' + p.title + ']' : '') + ':\n' + p.content.slice(0, 200)).join('\n\n');
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
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

function estimateCost(i, o) {
  const usd = (i/1000000)*3.0 + (o/1000000)*15.0;
  return { input_tokens: i, output_tokens: o, cost_usd: Math.round(usd*10000)/10000, cost_huf: Math.round(usd*370) };
}

// ── MOCK ──────────────────────────────────────────────────────────────────────
const MOCK_RESULT = {
  user_party: 'Befektető',
  contract_type: 'Befektetési szerződés',
  risk_score: 68,
  erős_pontok: [
    { title: 'Anti-dilúciós védelem biztosított', desc: 'Weighted average módszer védi a befektetőt hígulástól.' },
    { title: 'Board megfigyelői jog', desc: 'A befektető részt vehet az igazgatósági üléseken.' }
  ],
  javítható_pontok: [
    { title: 'Exit határidő pontosítható', desc: '5 év szándék, de nem kötelezettség. Érdemes kötelező visszavásárlást beépíteni.', ptk_ref: '6:150.§' },
    { title: 'Kötbér mértéke alacsony', desc: 'A késedelmi kötbér 0.5%/nap, ami átlag alatt van.', ptk_ref: '6:185.§' }
  ],
  kritikus_pontok: [
    { title: 'ESOP részesedés jogi státusza tisztázatlan', desc: 'Az ESOP részesedések szavazati joga nincs rögzítve, ez végrehajtási kockázatot jelent.', fix: 'Külön ESOP megállapodás szükséges a szavazati jogok rögzítésével.', ptk_ref: '3:1.§' },
    { title: 'Drag-Along küszöb túl alacsony (51%)', desc: 'Az 51%-os küszöb lehetővé teszi kényszereladást a befektető számára kedvezőtlen áron.', fix: 'Emeljük 75-80%-ra és adjunk minimálár garanciát.', ptk_ref: '6:137.§' }
  ],
  hiányzó_klauzulák: [
    { title: 'Likvidációs preferencia részletei', fontosság: 'kötelező', javaslat: 'Rögzíteni kell a likvidációs sorrend pontos matematikáját (1x, 2x preference, participating vs non-participating).' },
    { title: 'Információs jogok részletezése', fontosság: 'ajánlott', javaslat: 'Negyedéves pénzügyi és KPI riport kötelezettség az alapítók részéről.' }
  ],
  tárgyalási_tippek: [
    'Kérje az ESOP pool elkülönítését a szavazati jogok tisztázásával – ez standardnak számít seed körben.',
    'A Drag-Along küszöbnél hivatkozzon arra, hogy az iparági standard 75-80% Magyarországon is.',
    'Exit garanciánál ajánlja fel a kötelező visszavásárlást bekerülési érték 150%-án 5 év után.'
  ],
  erőviszony: { én_score: 62, másik_score: 38, én_fél: 'Befektető', másik_fél: 'Alapítók', összefoglalás: 'A szerződés összességében a Befektetőnek kedvez, de az ESOP és Drag-Along rendelkezések gyengítik a pozícióját.' },
  alternatív_szövegek: [
    { cím: 'Drag-Along minimálár klauzula', szöveg: 'A Drag-Along jog kizárólag akkor gyakorolható, ha a felajánlott vételár eléri az eredeti befektetési összeget és a 20%-os éves hozamot (CAGR).' },
    { cím: 'Kötelező exit klauzula', szöveg: 'Az Alapítók kötelesek a Befektető részesedését a Befektetői Exit Összegen visszavásárolni, ha 5 éven belül nem valósul meg az Exit Esemény.' }
  ],
  ptk_references: [
    { section: '6:150.§', title: 'Felmondás', book: 'Hatodik Könyv' },
    { section: '6:185.§', title: 'Kötbér', book: 'Hatodik Könyv' }
  ],
  summary: 'A befektetési szerződés összességében a Befektetőnek kedvező struktúrát mutat, azonban az ESOP kezelés és a Drag-Along küszöb komoly kockázatokat rejt. A kritikus pontok javítása után a szerződés elfogadható szintre hozható.',
  _mock: true
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

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'LexAI Backend', version: '12.0-userparty', mock_mode: MOCK_MODE });
});

// ── FŐ ELEMZÉS ────────────────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const { text, type, userParty } = req.body;
    if (!text || text.length < 30) return res.status(400).json({ error: 'Nincs szöveg' });

    if (MOCK_MODE) {
      await new Promise(r => setTimeout(r, 2000));
      return res.json({ ...MOCK_RESULT, user_party: userParty || 'Ügyfél' });
    }

    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    let totalIn = 0, totalOut = 0;

    // ── 1. LÉPÉS: Felek és típus azonosítása ─────────────────────────────────
    console.log('1. Felek azonosítása...');
    const step1 = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 600,
      messages: [{ role: 'user', content:
        'Olvasd el a szerződést és azonosítsd a feleket.\n\n' + text.slice(0, 6000) + '\n\n' +
        'A FELHASZNÁLÓ: "' + (userParty || 'nem megadott') + '" (ő az ügyfél akinek az érdekeit nézzük)\n\n' +
        'JSON (TILOS ```json):\n' +
        '{"fel1_nev":"pontos név","fel1_szerep":"pl. Befektető","fel2_nev":"pontos név","fel2_szerep":"pl. Alapító","szerzodes_tipus":"típus","user_fel":"fel1|fel2|ismeretlen"}'
      }]
    });
    totalIn += step1.usage.input_tokens; totalOut += step1.usage.output_tokens;
    const felek = extractJSON(step1.content[0].text) || {};
    console.log('Felek:', felek.fel1_nev, '/', felek.fel2_nev, '| User:', felek.user_fel);

    // Meghatározzuk ki az "én" fél
    const userIsFel1 = felek.user_fel === 'fel1';
    const enNev = userIsFel1 ? felek.fel1_nev : felek.fel2_nev;
    const masikNev = userIsFel1 ? felek.fel2_nev : felek.fel1_nev;
    const enSzerep = userIsFel1 ? felek.fel1_szerep : felek.fel2_szerep;
    const masikSzerep = userIsFel1 ? felek.fel2_szerep : felek.fel1_szerep;
    const userPartyFinal = userParty || enNev || 'Ügyfél';

    // ── 2. LÉPÉS: PTK keresés ────────────────────────────────────────────────
    console.log('2. Ptk. keresés...');
    const ptkParagraphs = await searchPtk(text);
    const ptkContext = formatPtkContext(ptkParagraphs);
    console.log('Ptk. találatok:', ptkParagraphs.length);

    // ── 3. LÉPÉS: Teljes elemzés egy nagy promptban ──────────────────────────
    console.log('3. Elemzés...');
    const chunks = splitIntoChunks(text, 12000);
    const toAnalyze = chunks.length <= 2 ? chunks : [chunks[0], chunks[chunks.length-1]];

    let erősPontok = [], javíthatóPontok = [], kritikusPontok = [], hiányzóKlauzulák = [];
    let tárgyalásiTippek = [], alternatívSzövegek = [];
    let enScore = 50, masikScore = 50;

    for (let i = 0; i < toAnalyze.length; i++) {
      const chunk = toAnalyze[i];
      try {
        const r = await client.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 2000,
          messages: [{ role: 'user', content:
            'TE EGY TAPASZTALT MAGYAR ÜGYVÉD VAGY.\n\n' +
            'A SZERZŐDÉS RÉSZLETE:\n' + chunk + '\n\n' +
            ptkContext + '\n\n' +
            'AZ ÜGYFÉL: "' + userPartyFinal + '" (' + enSzerep + ')\n' +
            'A MÁSIK FÉL: "' + masikNev + '" (' + masikSzerep + ')\n' +
            'A SZERZŐDÉS TÍPUSA: ' + (felek.szerzodes_tipus || type || 'ismeretlen') + '\n\n' +
            'FELADAT: Elemezd a szerződést KIZÁRÓLAG "' + userPartyFinal + '" szemszögéből!\n\n' +
            'DEFINÍCIÓK:\n' +
            '- ERŐS PONT: ami már most védi ' + userPartyFinal + ' érdekeit\n' +
            '- JAVÍTHATÓ: nem veszélyes de lehetne jobb ' + userPartyFinal + ' számára\n' +
            '- KRITIKUS: ami HÁTRÁNYOS ' + userPartyFinal + ' számára, újra KELL tárgyalni\n' +
            '- HIÁNYZÓ: ami nincs benne de kellene ' + userPartyFinal + ' védelméhez\n\n' +
            'JSON (TILOS ```json):\n' +
            '{\n' +
            '"en_score": SZAM_0_100,\n' +
            '"masik_score": SZAM_0_100,\n' +
            '"eros_pontok": [{"title":"cím","desc":"magyarázat"}],\n' +
            '"javithato_pontok": [{"title":"cím","desc":"mit kellene javítani","ptk_ref":"pl. 6:155.§ vagy üres"}],\n' +
            '"kritikus_pontok": [{"title":"cím","desc":"miért hátrányos ' + userPartyFinal + ' számára","fix":"konkrét szövegszerű javítás","ptk_ref":"pl. 6:142.§ vagy üres"}],\n' +
            '"hianyzo_klauzu lak": [{"title":"cím","fontossag":"kötelező|ajánlott|opcionális","javaslat":"mit kellene beírni"}],\n' +
            '"targyalasi_tippek": ["konkrét tárgyalási érv amit mondhat ' + userPartyFinal + '"],\n' +
            '"alternativ_szovegek": [{"cim":"klauzula neve","szoveg":"konkrét beilleszthető szerződéses szöveg"}]\n' +
            '}'
          }]
        });
        totalIn += r.usage.input_tokens; totalOut += r.usage.output_tokens;
        const d = extractJSON(r.content[0].text);
        if (d) {
          if (d.en_score) enScore = d.en_score;
          if (d.masik_score) masikScore = d.masik_score;
          if (d.eros_pontok) erősPontok.push(...d.eros_pontok);
          if (d.javithato_pontok) javíthatóPontok.push(...d.javithato_pontok);
          if (d.kritikus_pontok) kritikusPontok.push(...d.kritikus_pontok);
          if (d.hianyzo_klauzu_lak) hiányzóKlauzulák.push(...d.hianyzo_klauzu_lak);
          if (d.hianyzo_klauzulak) hiányzóKlauzulák.push(...d.hianyzo_klauzulak);
          if (d.targyalasi_tippek) tárgyalásiTippek.push(...d.targyalasi_tippek);
          if (d.alternativ_szovegek) alternatívSzövegek.push(...d.alternativ_szovegek);
        }
      } catch(e) { console.error('Elemzés hiba:', e.message); }
    }

    // ── 4. LÉPÉS: Összefoglaló ───────────────────────────────────────────────
    console.log('4. Összefoglaló...');
    const sumR = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 400,
      messages: [{ role: 'user', content:
        'Ügyfél: ' + userPartyFinal + ' | Score: ' + enScore + '/100\n' +
        'Kritikus problémák: ' + kritikusPontok.slice(0,3).map(x=>x.title).join(', ') + '\n' +
        'Írj egy 3 mondatos összefoglalót ' + userPartyFinal + ' szemszögéből.\n' +
        'JSON (TILOS ```json): {"summary":"3 mondatos összefoglaló"}'
      }]
    });
    totalIn += sumR.usage.input_tokens; totalOut += sumR.usage.output_tokens;
    const sumData = extractJSON(sumR.content[0].text) || {};

    const cost = estimateCost(totalIn, totalOut);
    console.log('KÉSZ | Score:', enScore, '| Kritikus:', kritikusPontok.length, '| Ptk.:', ptkParagraphs.length, '| Költség:', cost.cost_huf, 'Ft');

    // Deduplikálás cím alapján
    const dedup = (arr) => {
      const seen = {};
      return arr.filter(x => { if(seen[x.title]) return false; seen[x.title]=true; return true; });
    };

    res.json({
      user_party: userPartyFinal,
      en_nev: enNev,
      masik_nev: masikNev,
      en_szerep: enSzerep,
      masik_szerep: masikSzerep,
      contract_type: felek.szerzodes_tipus || type || 'Szerződés',
      risk_score: enScore,
      erős_pontok: dedup(erősPontok).slice(0, 6),
      javítható_pontok: dedup(javíthatóPontok).slice(0, 8),
      kritikus_pontok: dedup(kritikusPontok).slice(0, 10),
      hiányzó_klauzulák: dedup(hiányzóKlauzulák).slice(0, 8),
      tárgyalási_tippek: [...new Set(tárgyalásiTippek)].slice(0, 6),
      erőviszony: {
        én_score: enScore,
        másik_score: masikScore,
        én_fél: userPartyFinal,
        másik_fél: masikNev,
        összefoglalás: sumData.summary || 'Az elemzés elkészült.'
      },
      alternatív_szövegek: dedup(alternatívSzövegek).slice(0, 6),
      ptk_references: ptkParagraphs.map(p => ({ section: p.section_id, title: p.title, book: p.book })),
      summary: sumData.summary || 'Az elemzés elkészült.',
      _cost: cost
    });

  } catch(err) {
    console.error('Hiba:', err.message);
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

// ── GENERÁLÁS ─────────────────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  try {
    const { action, type, favor, party1, party2, amount, deadline, date, level, details, special } = req.body;

    if (MOCK_MODE) {
      await new Promise(r => setTimeout(r, 800));
      if (action === 'hints') return res.json(MOCK_GENERATE_HINTS);
      if (action === 'generate') return res.json({
        contract: 'VÁLLALKOZÁSI SZERZŐDÉS\n\n[MOCK]\n\n' + (party1||'1. Fél') + ' és ' + (party2||'2. Fél') + ' között.\n\nKelt: ' + (date||new Date().toLocaleDateString('hu-HU')),
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
