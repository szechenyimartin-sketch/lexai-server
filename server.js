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

if (MOCK_MODE) { console.log('MOCK MODE'); }
else { console.log('ELES MOD v99 - userParty'); }

// PTK RAG
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
  } catch(e) { console.error('Ptk hiba:', e.message); return []; }
}

function formatPtkContext(paragraphs) {
  if (!paragraphs.length) return '';
  return '\n\nRELEVANS PTK. PARAGRAFUSOK:\n' +
    paragraphs.map(p => p.section_id + (p.title ? ' [' + p.title + ']' : '') + ':\n' + p.content.slice(0, 200)).join('\n\n');
}

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

// MOCK ADAT
const MOCK_RESULT = {
  user_party: 'Befekteto',
  contract_type: 'Befektetesi szerzodes',
  risk_score: 45,
  eros_pontok: [
    { title: 'Anti-dilucios vedelem biztositott', desc: 'Weighted average modszer vedi a befekteot higulaastol.' },
    { title: 'Board megfigyeloi jog', desc: 'A befekteto reszt vehet az igazgatosagi uleseken.' }
  ],
  javithato_pontok: [
    { title: 'Exit hatarido pontositható', desc: '5 ev szandek, de nem kotelezettseg. Erdemes kotelezo visszavasarlast beepiteni.', ptk_ref: '6:150.§' },
    { title: 'Kotber merteke alacsony', desc: 'A kesedelmi kotber 0.5%/nap, ami atlag alatt van.', ptk_ref: '6:185.§' }
  ],
  kritikus_pontok: [
    { title: 'ESOP reszesedes jogi statussa tisztazatlan', desc: 'Az ESOP reszesedések szavazati joga nincs rogzitve, ez vegrehajtasi kockazatot jelent.', fix: 'Kulon ESOP megallapodas szukseges a szavazati jogok rogzitesevel.', ptk_ref: '3:1.§' },
    { title: 'Drag-Along kuszob tul alacsony (51%)', desc: 'Az 51%-os kuszob lehetove teszi kenyszereladast a befekteto szamara kedvezotlen aron.', fix: 'Emeljuk 75-80%-ra es adjunk minimalaar garanciát.', ptk_ref: '6:137.§' }
  ],
  hianyzo_klauzulak: [
    { title: 'Likvidacios preferencia reszletei', fontossag: 'kotelezo', javaslat: 'Rogziteni kell a likvidacios sorrend pontos matematikajat.' },
    { title: 'Informacios jogok reszletezese', fontossag: 'ajanlott', javaslat: 'Negyedeves penzugyi es KPI riport kotelezettseg az alapitok reszerol.' }
  ],
  targyalasi_tippek: [
    'Kerje az ESOP pool elkulonitest a szavazati jogok tisztazasaval – ez standardnak szamit seed korben.',
    'A Drag-Along kuszobnél hivatkozzon arra, hogy az iparagi standard 75-80% Magyarorszagon is.',
    'Exit garancianal ajanlja fel a kotelezo visszavasarlast bekerulesi ertek 150%-an 5 ev utan.'
  ],
  eroviszony: {
    en_score: 45,
    masik_score: 55,
    en_fel: 'Befekteto',
    masik_fel: 'Alapitok',
    osszefoglalas: 'A szerzodes osszessegeben az Alapitoknak kedvez. A Befekteto pozicioja gyengebb az ESOP es Drag-Along rendelkezesek miatt.'
  },
  alternativ_szovegek: [
    { cim: 'Drag-Along minimalaar klauzula', szoveg: 'A Drag-Along jog kizarolag akkor gyakorolhato, ha a felajanlott vetalar eleri az eredeti befektetesi osszeget es a 20%-os eves hozamot (CAGR).' },
    { cim: 'Kotelezo exit klauzula', szoveg: 'Az Alapitok kotelezenek a Befekteto reszesedeset a Befektetoi Exit Ossszegen visszavasarolni, ha 5 even belul nem valosul meg az Exit Esemeny.' }
  ],
  ptk_references: [
    { section: '6:150.§', title: 'Felmondas', book: 'Hatodik Konyv' },
    { section: '6:185.§', title: 'Kotber', book: 'Hatodik Konyv' }
  ],
  summary: 'A befektetesi szerzodes osszessegeben az Alapitoknak kedvezo strukturat mutat. Az ESOP kezeles es a Drag-Along kuszob komoly kockazatokat rejt a Befekteto szamara. A kritikus pontok javitasa utan a szerzodes elfogadhato szintre hozhato.',
  _mock: true
};

const MOCK_GENERATE_HINTS = {
  hints: [
    { text: 'Fizetesi hatarido es kesedelmi kamat (Ptk. 6:155§)', importance: 'must' },
    { text: 'Teljesitesi hely es aatvétel modja', importance: 'must' },
    { text: 'Szavatossagi feltetelek', importance: 'must' },
    { text: 'Felmondasi feltetelek', importance: 'rec' },
    { text: 'Vis maior klauzula', importance: 'rec' },
    { text: 'Vitarendezés modja', importance: 'opt' }
  ]
};

app.get('/', (req, res) => {
  res.json({ status: 'LexAI Backend', version: '99.0', mock_mode: MOCK_MODE });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { text, type, userParty } = req.body;
    if (!text || text.length < 30) return res.status(400).json({ error: 'Nincs szoveg' });

    if (MOCK_MODE) {
      await new Promise(r => setTimeout(r, 1500));
      const mockResult = Object.assign({}, MOCK_RESULT);
      mockResult.user_party = userParty || 'Ugyfel';
      return res.json(mockResult);
    }

    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    let totalIn = 0, totalOut = 0;

    // 1. Felek azonositasa
    console.log('1. Felek azonositasa...');
    const step1 = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 600,
      messages: [{ role: 'user', content:
        'Olvasd el a szerzdoest es azonositsd a feleket.\n\n' + text.slice(0, 6000) + '\n\n' +
        'A FELHASZNALO: "' + (userParty || 'nem megadott') + '" (o az ugyfel akinek az erdekeit nezzuk)\n\n' +
        'JSON (TILOS ```json):\n' +
        '{"fel1_nev":"pontos nev","fel1_szerep":"pl. Befekteto","fel2_nev":"pontos nev","fel2_szerep":"pl. Alapito","szerzodes_tipus":"tipus","user_fel":"fel1|fel2|ismeretlen"}'
      }]
    });
    totalIn += step1.usage.input_tokens; totalOut += step1.usage.output_tokens;
    const felek = extractJSON(step1.content[0].text) || {};
    console.log('Felek:', felek.fel1_nev, '/', felek.fel2_nev, '| User:', felek.user_fel);

    const userIsFel1 = felek.user_fel === 'fel1';
    const enNev = userIsFel1 ? felek.fel1_nev : felek.fel2_nev;
    const masikNev = userIsFel1 ? felek.fel2_nev : felek.fel1_nev;
    const enSzerep = userIsFel1 ? felek.fel1_szerep : felek.fel2_szerep;
    const masikSzerep = userIsFel1 ? felek.fel2_szerep : felek.fel1_szerep;
    const userPartyFinal = userParty || enNev || 'Ugyfel';

    // 2. PTK kereses
    console.log('2. Ptk. kereses...');
    const ptkParagraphs = await searchPtk(text);
    const ptkContext = formatPtkContext(ptkParagraphs);
    console.log('Ptk. talalatok:', ptkParagraphs.length);

    // 3. Elemzes
    console.log('3. Elemzes...');
    const chunks = splitIntoChunks(text, 12000);
    const toAnalyze = chunks.length <= 2 ? chunks : [chunks[0], chunks[chunks.length-1]];

    let erosPontok = [], javithatoPontok = [], kritikusPontok = [], hianyzoKlauzulak = [];
    let targyalasiTippek = [], alternativSzovegek = [];
    let enScore = 50, masikScore = 50;

    for (let i = 0; i < toAnalyze.length; i++) {
      const chunk = toAnalyze[i];
      try {
        const r = await client.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 2000,
          messages: [{ role: 'user', content:
            'TE EGY TAPASZTALT MAGYAR UGYVÉD VAGY.\n\n' +
            'SZERZODES RESZLETE:\n' + chunk + '\n\n' +
            ptkContext + '\n\n' +
            'AZ UGYFEL: "' + userPartyFinal + '" (' + enSzerep + ')\n' +
            'A MASIK FEL: "' + masikNev + '" (' + masikSzerep + ')\n' +
            'SZERZODES TIPUSA: ' + (felek.szerzodes_tipus || type || 'ismeretlen') + '\n\n' +
            'FELADAT: Elemezd a szerzdoest KIZAROLAG "' + userPartyFinal + '" szemszogébol!\n\n' +
            'EROS PONT: ami mar most vedi ' + userPartyFinal + ' erdekeit\n' +
            'JAVITHATO: nem veszelyes de lehetne jobb ' + userPartyFinal + ' szamara\n' +
            'KRITIKUS: ami HATRANYOS ' + userPartyFinal + ' szamara, ujra KELL targyalni\n' +
            'HIANYZO: ami nincs benne de kellene ' + userPartyFinal + ' vedelmehez\n\n' +
            'JSON (TILOS ```json):\n' +
            '{\n' +
            '"en_score": SZAM_0_100,\n' +
            '"masik_score": SZAM_0_100,\n' +
            '"eros_pontok": [{"title":"cim","desc":"magyarazat"}],\n' +
            '"javithato_pontok": [{"title":"cim","desc":"mit kellene javitani","ptk_ref":"pl. 6:155.§ vagy ures string"}],\n' +
            '"kritikus_pontok": [{"title":"cim","desc":"miert hatranyos ' + userPartyFinal + ' szamara","fix":"konkret szovegszeru javitas","ptk_ref":"pl. 6:142.§ vagy ures string"}],\n' +
            '"hianyzo_klauzulak": [{"title":"cim","fontossag":"kotelezo|ajanlott|opcionalis","javaslat":"mit kellene beirni"}],\n' +
            '"targyalasi_tippek": ["konkret targyalasi erv amit mondhat ' + userPartyFinal + '"],\n' +
            '"alternativ_szovegek": [{"cim":"klauzula neve","szoveg":"konkret beillesztheto szerzdoeses szoveg"}]\n' +
            '}'
          }]
        });
        totalIn += r.usage.input_tokens; totalOut += r.usage.output_tokens;
        const d = extractJSON(r.content[0].text);
        if (d) {
          if (d.en_score) enScore = d.en_score;
          if (d.masik_score) masikScore = d.masik_score;
          if (d.eros_pontok) erosPontok.push(...d.eros_pontok);
          if (d.javithato_pontok) javithatoPontok.push(...d.javithato_pontok);
          if (d.kritikus_pontok) kritikusPontok.push(...d.kritikus_pontok);
          if (d.hianyzo_klauzulak) hianyzoKlauzulak.push(...d.hianyzo_klauzulak);
          if (d.targyalasi_tippek) targyalasiTippek.push(...d.targyalasi_tippek);
          if (d.alternativ_szovegek) alternativSzovegek.push(...d.alternativ_szovegek);
        }
      } catch(e) { console.error('Elemzes hiba:', e.message); }
    }

    // 4. Osszefoglalo
    console.log('4. Osszefoglalo...');
    const sumR = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 400,
      messages: [{ role: 'user', content:
        'Ugyfel: ' + userPartyFinal + ' | Score: ' + enScore + '/100\n' +
        'Kritikus problemak: ' + kritikusPontok.slice(0,3).map(x=>x.title).join(', ') + '\n' +
        'Irj egy 3 mondatos osszefoglalot ' + userPartyFinal + ' szemszogebol.\n' +
        'JSON (TILOS ```json): {"summary":"3 mondatos osszefoglalo"}'
      }]
    });
    totalIn += sumR.usage.input_tokens; totalOut += sumR.usage.output_tokens;
    const sumData = extractJSON(sumR.content[0].text) || {};

    const cost = estimateCost(totalIn, totalOut);
    console.log('KESZ | Score:', enScore, '| Kritikus:', kritikusPontok.length, '| Ptk.:', ptkParagraphs.length, '| Koltseg:', cost.cost_huf, 'Ft');

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
      contract_type: felek.szerzodes_tipus || type || 'Szerzodes',
      risk_score: enScore,
      eros_pontok: dedup(erosPontok).slice(0, 6),
      javithato_pontok: dedup(javithatoPontok).slice(0, 8),
      kritikus_pontok: dedup(kritikusPontok).slice(0, 10),
      hianyzo_klauzulak: dedup(hianyzoKlauzulak).slice(0, 8),
      targyalasi_tippek: [...new Set(targyalasiTippek)].slice(0, 6),
      eroviszony: {
        en_score: enScore,
        masik_score: masikScore,
        en_fel: userPartyFinal,
        masik_fel: masikNev,
        osszefoglalas: sumData.summary || 'Az elemzes elkeszult.'
      },
      alternativ_szovegek: dedup(alternativSzovegek).slice(0, 6),
      ptk_references: ptkParagraphs.map(p => ({ section: p.section_id, title: p.title, book: p.book })),
      summary: sumData.summary || 'Az elemzes elkeszult.',
      _cost: cost
    });

  } catch(err) {
    console.error('Hiba:', err.message);
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const { action, type, favor, party1, party2, amount, deadline, date, level, details, special } = req.body;

    if (MOCK_MODE) {
      await new Promise(r => setTimeout(r, 800));
      if (action === 'hints') return res.json(MOCK_GENERATE_HINTS);
      if (action === 'generate') return res.json({
        contract: 'VALLALKOZASI SZERZODES\n\n[MOCK]\n\n' + (party1||'1. Fel') + ' es ' + (party2||'2. Fel') + ' kozott.\n\nKelt: ' + (date||new Date().toLocaleDateString('hu-HU')),
        _mock: true
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    if (action === 'hints') {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 2000,
        messages: [{ role: 'user', content: 'Magyar ugyvéd. Mit kell egy "' + type + '" szerz.-be "' + favor + '" szerint.\nJSON: {"hints":[{"text":"STRING","importance":"must|rec|opt"}]}' }]
      });
      return res.json(extractJSON(r.content[0].text) || { hints: [] });
    }

    if (action === 'generate') {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 8000,
        system: 'Tapasztalt magyar ugyvéd. Keszits ' + level + ' ' + type + 't PTK alapjan. Vedd ' + favor + ' erdekeit. Legyen teljes, konkret Ptk. hivatkozasokkal!',
        messages: [{ role: 'user', content:
          'Tipus:' + type + '\n1. Fel:' + (party1||'1. Fel') + '\n2. Fel:' + (party2||'2. Fel') +
          '\nOsszeg:' + (amount||'megallapodas szerint') + '\nHatarido:' + (deadline||'megallapodas szerint') +
          '\nDatum:' + (date||new Date().toLocaleDateString('hu-HU')) + '\nReszletesseg:' + level +
          '\nTargy:' + details + '\nKulonleges:' + (special||'szokásos')
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
