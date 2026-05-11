const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MOCK_MODE = process.env.MOCK_MODE === 'true';

if (MOCK_MODE) console.log('MOCK MODE');
else console.log('ELES MOD v103');

function extractJSON(raw) {
  if (!raw) return null;
  let c = raw.replace(/```json/gi, '').replace(/```/gi, '').trim();
  const s = c.indexOf('{');
  const e = c.lastIndexOf('}');
  if (s < 0 || e < 0) return null;
  c = c.substring(s, e + 1);
  try { return JSON.parse(c); }
  catch(e1) {
    try { return JSON.parse(c.replace(/,(\s*[}\]])/g, '$1')); }
    catch(e2) { console.log('JSON HIBA:', c.slice(0, 200)); return null; }
  }
}

function cost(inp, out) {
  const usd = (inp/1000000)*3.0 + (out/1000000)*15.0;
  return { input_tokens: inp, output_tokens: out, cost_usd: Math.round(usd*10000)/10000, cost_huf: Math.round(usd*370) };
}

const MOCK_RESULT = {
  user_party: 'Befektető', contract_type: 'Befektetési szerződés', risk_score: 45,
  eros_pontok: [{ title: 'Anti-dilúciós védelem', desc: 'Weighted average módszer védi a befektetőt.' }],
  javithato_pontok: [{ title: 'Exit határidő', desc: 'Nem kötelező, érdemes visszavásárlást beépíteni.', ptk_ref: '6:150.§' }],
  kritikus_pontok: [
    { title: 'ESOP jogi státusz tisztázatlan', desc: 'Szavazati jog nincs rögzítve.', fix: 'Külön ESOP megállapodás kell.', ptk_ref: '3:1.§' },
    { title: 'Drag-Along küszöb alacsony', desc: '51% kényszereladást tesz lehetővé.', fix: 'Emeljük 75%-ra.', ptk_ref: '6:137.§' }
  ],
  hianyzo_klauzulak: [{ title: 'Likvidációs preferencia', fontossag: 'kotelezo', javaslat: 'Rögzíteni kell a sorrendet.' }],
  targyalasi_tippek: ['ESOP pool elkülönítés kérése.', 'Drag-Along 75-80%-ra emelése.'],
  eroviszony: { en_score: 45, masik_score: 55, en_fel: 'Befektető', masik_fel: 'Alapítók', osszefoglalas: 'A szerződés az Alapítóknak kedvez.' },
  alternativ_szovegek: [{ cim: 'Drag-Along minimálár', szoveg: 'A jog csak akkor gyakorolható, ha a vételár eléri az eredeti befektetés 150%-át.' }],
  ptk_references: [], summary: 'A szerződés az Alapítóknak kedvező struktúrát mutat.', _mock: true
};

app.get('/', (req, res) => res.json({ status: 'LexAI Backend', version: '103.0', mock_mode: MOCK_MODE }));

app.post('/api/analyze', async (req, res) => {
  try {
    const { text, type, userParty } = req.body;
    if (!text || text.length < 30) return res.status(400).json({ error: 'Nincs szoveg' });
    if (MOCK_MODE) {
      await new Promise(r => setTimeout(r, 1500));
      const m = Object.assign({}, MOCK_RESULT);
      m.user_party = userParty || 'Ugyfel';
      return res.json(m);
    }
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    let totalIn = 0, totalOut = 0;
    const ugyfel = userParty || 'az ugyfel';

    // A szerződés első 8000 karaktere elegendő az elemzéshez
    const szoveg = text.slice(0, 8000);

    // STEP 1: Felek azonosítása
    console.log('1. Felek...');
    const r1 = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 300,
      messages: [{ role: 'user', content: `Contract start:\n${text.slice(0,3000)}\n\nWho are the two parties? Which one is "${ugyfel}"?\nJSON only: {"fel1_nev":"name","fel1_szerep":"role","fel2_nev":"name","fel2_szerep":"role","szerzodes_tipus":"type in Hungarian","user_fel":"fel1 or fel2"}` }]
    });
    totalIn += r1.usage.input_tokens; totalOut += r1.usage.output_tokens;
    const felek = extractJSON(r1.content[0].text) || {};
    const userIsFel1 = felek.user_fel !== 'fel2';
    const enNev = userIsFel1 ? (felek.fel1_nev || ugyfel) : (felek.fel2_nev || ugyfel);
    const masikNev = userIsFel1 ? (felek.fel2_nev || 'Masik fel') : (felek.fel1_nev || 'Masik fel');
    const enSzerep = userIsFel1 ? (felek.fel1_szerep || '') : (felek.fel2_szerep || '');
    const szerzTipus = felek.szerzodes_tipus || type || 'Szerzodes';
    console.log(`Felek: ${enNev} vs ${masikNev}`);

    // STEP 2a: Erős és kritikus pontok
    console.log('2a. Eros + kritikus...');
    const r2a = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 1500,
      system: 'Expert Hungarian contract lawyer. JSON only, no markdown.',
      messages: [{ role: 'user', content: `Contract (${szerzTipus}) between "${enNev}" and "${masikNev}".
Analyze from "${enNev}" perspective. Find strong points and critical problems.
CONTRACT: ${szoveg}

JSON only (Hungarian text):
{"risk_score":50,"en_score":50,"masik_score":50,"eros_pontok":[{"title":"cim","desc":"magyarazat"}],"kritikus_pontok":[{"title":"cim","desc":"miert hatranyos","fix":"javitas","ptk_ref":""}]}` }]
    });
    totalIn += r2a.usage.input_tokens; totalOut += r2a.usage.output_tokens;
    const d2a = extractJSON(r2a.content[0].text) || {};
    console.log(`2a kesz: ${d2a.kritikus_pontok?.length||0} kritikus, ${d2a.eros_pontok?.length||0} eros`);

    // STEP 2b: Javítható és hiányzó pontok
    console.log('2b. Javithato + hianyzo...');
    const r2b = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 1500,
      system: 'Expert Hungarian contract lawyer. JSON only, no markdown.',
      messages: [{ role: 'user', content: `Contract (${szerzTipus}) between "${enNev}" and "${masikNev}".
Find improvable clauses and missing clauses for "${enNev}".
CONTRACT: ${szoveg}

JSON only (Hungarian text):
{"javithato_pontok":[{"title":"cim","desc":"mit javitani","ptk_ref":""}],"hianyzo_klauzulak":[{"title":"cim","fontossag":"kotelezo vagy ajanlott","javaslat":"mit irni"}]}` }]
    });
    totalIn += r2b.usage.input_tokens; totalOut += r2b.usage.output_tokens;
    const d2b = extractJSON(r2b.content[0].text) || {};
    console.log(`2b kesz: ${d2b.javithato_pontok?.length||0} javithato, ${d2b.hianyzo_klauzulak?.length||0} hianyzo`);

    // STEP 2c: Tárgyalási tippek és alternatív szövegek
    console.log('2c. Targyalasi tippek...');
    const r2c = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 1000,
      system: 'Expert Hungarian contract lawyer. JSON only, no markdown.',
      messages: [{ role: 'user', content: `Contract (${szerzTipus}). Client: "${enNev}". Issues: ${(d2a.kritikus_pontok||[]).slice(0,3).map(x=>x.title).join(', ')}.
Give negotiation tips and alternative contract texts for "${enNev}".

JSON only (Hungarian text):
{"targyalasi_tippek":["konkret erv"],"alternativ_szovegek":[{"cim":"klauzula","szoveg":"beillesztheto szoveg"}],"eroviszony_szoveg":"2 mondatos osszefoglalo"}` }]
    });
    totalIn += r2c.usage.input_tokens; totalOut += r2c.usage.output_tokens;
    const d2c = extractJSON(r2c.content[0].text) || {};

    // STEP 3: Összefoglaló
    console.log('3. Osszefoglalo...');
    const r3 = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 250,
      messages: [{ role: 'user', content: `Write 3 sentences IN HUNGARIAN summarizing this contract for "${enNev}".
Score: ${d2a.risk_score}/100. Critical: ${(d2a.kritikus_pontok||[]).slice(0,2).map(x=>x.title).join(', ')}.
JSON only: {"summary":"3 mondatos magyar osszefoglalo"}` }]
    });
    totalIn += r3.usage.input_tokens; totalOut += r3.usage.output_tokens;
    const d3 = extractJSON(r3.content[0].text) || {};

    const c = cost(totalIn, totalOut);
    console.log(`KESZ | Score: ${d2a.risk_score} | Kritikus: ${d2a.kritikus_pontok?.length||0} | Koltseg: ${c.cost_huf} Ft`);

    res.json({
      user_party: enNev, en_nev: enNev, masik_nev: masikNev, en_szerep: enSzerep,
      contract_type: szerzTipus,
      risk_score: d2a.risk_score || 50,
      eros_pontok: (d2a.eros_pontok || []).slice(0,6),
      javithato_pontok: (d2b.javithato_pontok || []).slice(0,8),
      kritikus_pontok: (d2a.kritikus_pontok || []).slice(0,10),
      hianyzo_klauzulak: (d2b.hianyzo_klauzulak || []).slice(0,8),
      targyalasi_tippek: (d2c.targyalasi_tippek || []).slice(0,6),
      eroviszony: {
        en_score: d2a.en_score || 50,
        masik_score: d2a.masik_score || 50,
        en_fel: enNev, masik_fel: masikNev,
        osszefoglalas: d2c.eroviszony_szoveg || d3.summary || 'Az elemzes elkeszult.'
      },
      alternativ_szovegek: (d2c.alternativ_szovegek || []).slice(0,4),
      ptk_references: [],
      summary: d3.summary || d2c.eroviszony_szoveg || 'Az elemzes elkeszult.',
      _cost: c
    });

  } catch (err) {
    console.error('Hiba:', err.message);
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const { action, type, favor, party1, party2, amount, deadline, date, level, details, special } = req.body;
    if (MOCK_MODE) {
      await new Promise(r => setTimeout(r, 800));
      if (action === 'hints') return res.json({ hints: [
        { text: 'Fizetesi hatarido es kesedelmi kamat (Ptk. 6:155§)', importance: 'must' },
        { text: 'Teljesitesi hely es atvétel modja', importance: 'must' },
        { text: 'Szavatossagi feltetelek', importance: 'must' },
        { text: 'Felmondasi feltetelek', importance: 'rec' },
        { text: 'Vis maior klauzula', importance: 'rec' }
      ]});
      if (action === 'generate') return res.json({ contract: `MOCK SZERZODES\n\n${party1||'1. Fel'} es ${party2||'2. Fel'} kozott.\nKelt: ${date||new Date().toLocaleDateString('hu-HU')}`, _mock: true });
    }
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });
    if (action === 'hints') {
      const r = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 800,
        messages: [{ role: 'user', content: `Hungarian lawyer. What must be in a "${type}" contract for "${favor}". JSON only: {"hints":[{"text":"STRING in Hungarian","importance":"must|rec|opt"}]}` }]
      });
      return res.json(extractJSON(r.content[0].text) || { hints: [] });
    }
    if (action === 'generate') {
      const r = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 8000,
        system: `Tapasztalt magyar ugyvéd. Keszits ${level} ${type}-t PTK alapjan. Vedd ${favor} erdekeit. Legyen teljes!`,
        messages: [{ role: 'user', content: `Tipus: ${type}\n1. Fel: ${party1||'1. Fel'}\n2. Fel: ${party2||'2. Fel'}\nOsszeg: ${amount||'megallapodas szerint'}\nHatarido: ${deadline||'megallapodas szerint'}\nDatum: ${date||new Date().toLocaleDateString('hu-HU')}\nReszletesseg: ${level}\nTargy: ${details}\nKulonleges: ${special||'szokásos'}` }]
      });
      return res.json({ contract: r.content[0].text, _cost: cost(r.usage.input_tokens, r.usage.output_tokens) });
    }
    res.status(400).json({ error: 'Ismeretlen action' });
  } catch (err) {
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LexAI szerver fut: port ${PORT}`));
