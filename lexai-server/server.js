const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MOCK_MODE = process.env.MOCK_MODE === 'true';

if (MOCK_MODE) console.log('MOCK MODE');
else console.log('ELES MOD v102');

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
    catch(e2) {
      console.log('JSON parse failed:', c.slice(0, 300));
      return null;
    }
  }
}

function estimateCost(inp, out) {
  const usd = (inp / 1000000) * 3.0 + (out / 1000000) * 15.0;
  return { input_tokens: inp, output_tokens: out, cost_usd: Math.round(usd * 10000) / 10000, cost_huf: Math.round(usd * 370) };
}

function splitText(text, maxSize) {
  if (text.length <= maxSize) return [text];
  const parts = text.split(/\n\n+/);
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > maxSize && cur.length > 0) {
      chunks.push(cur.trim());
      cur = p;
    } else {
      cur += (cur ? '\n\n' : '') + p;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [text];
}

const MOCK_RESULT = {
  user_party: 'Befektető',
  contract_type: 'Befektetési szerződés',
  risk_score: 45,
  eros_pontok: [
    { title: 'Anti-dilúciós védelem biztosított', desc: 'Weighted average módszer védi a befektetőt hígulástól.' },
    { title: 'Board megfigyelői jog', desc: 'A befektető részt vehet az igazgatósági üléseken.' }
  ],
  javithato_pontok: [
    { title: 'Exit határidő pontosítható', desc: '5 év szándék, de nem kötelezettség.', ptk_ref: '6:150.§' },
    { title: 'Kötbér mértéke alacsony', desc: 'A késedelmi kötbér 0.5%/nap, ami átlag alatt van.', ptk_ref: '6:185.§' }
  ],
  kritikus_pontok: [
    { title: 'ESOP részesedés jogi státusza tisztázatlan', desc: 'Az ESOP részesedések szavazati joga nincs rögzítve.', fix: 'Külön ESOP megállapodás szükséges.', ptk_ref: '3:1.§' },
    { title: 'Drag-Along küszöb túl alacsony (51%)', desc: 'Az 51%-os küszöb lehetővé teszi kényszereladást.', fix: 'Emeljük 75-80%-ra.', ptk_ref: '6:137.§' }
  ],
  hianyzo_klauzulak: [
    { title: 'Likvidációs preferencia részletei', fontossag: 'kotelezo', javaslat: 'Rögzíteni kell a likvidációs sorrend matematikáját.' }
  ],
  targyalasi_tippek: ['Kérje az ESOP pool elkülönítést.', 'Drag-Along küszöb 75-80%-ra emelése.'],
  eroviszony: { en_score: 45, masik_score: 55, en_fel: 'Befektető', masik_fel: 'Alapítók', osszefoglalas: 'A szerződés az Alapítóknak kedvez.' },
  alternativ_szovegek: [{ cim: 'Drag-Along minimálár', szoveg: 'A Drag-Along jog csak akkor gyakorolható, ha a vételár eléri az eredeti befektetés 150%-át.' }],
  ptk_references: [],
  summary: 'A befektetési szerződés az Alapítóknak kedvező struktúrát mutat.',
  _mock: true
};

app.get('/', (req, res) => {
  res.json({ status: 'LexAI Backend', version: '102.0', mock_mode: MOCK_MODE });
});

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

    // STEP 1: Identify parties
    console.log('1. Felek azonositasa...');
    const r1 = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Read this contract and identify the two parties. Determine which party is "${ugyfel}".

CONTRACT:
${text.slice(0, 4000)}

Respond ONLY with this JSON, no other text:
{"fel1_nev":"name","fel1_szerep":"role","fel2_nev":"name","fel2_szerep":"role","szerzodes_tipus":"type in Hungarian","user_fel":"fel1 or fel2"}`
      }]
    });
    totalIn += r1.usage.input_tokens;
    totalOut += r1.usage.output_tokens;

    const felek = extractJSON(r1.content[0].text) || {};
    const userIsFel1 = felek.user_fel !== 'fel2';
    const enNev = userIsFel1 ? (felek.fel1_nev || ugyfel) : (felek.fel2_nev || ugyfel);
    const masikNev = userIsFel1 ? (felek.fel2_nev || 'Masik fel') : (felek.fel1_nev || 'Masik fel');
    const enSzerep = userIsFel1 ? (felek.fel1_szerep || '') : (felek.fel2_szerep || '');
    const szerzodesNev = felek.szerzodes_tipus || type || 'Szerzodes';
    console.log(`Felek: ${enNev} vs ${masikNev}`);

    // STEP 2: Analysis - TWO separate calls to avoid token limit
    console.log('2. Elemzes (1. resz)...');
    const chunks = splitText(text, 12000);
    const elemzendoSzoveg = chunks.length === 1 ? chunks[0] : chunks[0] + '\n\n[...]\n\n' + chunks[chunks.length - 1];

    // Call 2a: Strong points + improvable + critical
    const r2a = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 3000,
      system: 'You are an expert Hungarian contract lawyer. Respond with valid JSON only. No markdown, no explanation.',
      messages: [{
        role: 'user',
        content: `Analyze this contract from the perspective of "${enNev}" (${enSzerep}). Other party: "${masikNev}". Contract: ${szerzodesNev}.

CONTRACT:
${elemzendoSzoveg}

Write ALL text in HUNGARIAN. Respond with ONLY this JSON:
{
  "risk_score": 50,
  "en_score": 50,
  "masik_score": 50,
  "eros_pontok": [{"title": "cim", "desc": "magyarazat"}],
  "javithato_pontok": [{"title": "cim", "desc": "mit javitani", "ptk_ref": ""}],
  "kritikus_pontok": [{"title": "cim", "desc": "miert hatranyos", "fix": "javitas", "ptk_ref": ""}],
  "eroviszony_szoveg": "2-3 mondatos osszefoglalo"
}`
      }]
    });
    totalIn += r2a.usage.input_tokens;
    totalOut += r2a.usage.output_tokens;
    const elemzes1 = extractJSON(r2a.content[0].text) || {};
    console.log(`Resz1: ${elemzes1.kritikus_pontok?.length || 0} kritikus, ${elemzes1.eros_pontok?.length || 0} eros`);

    // Call 2b: Missing clauses + negotiation tips + alternative texts
    console.log('2. Elemzes (2. resz)...');
    const r2b = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system: 'You are an expert Hungarian contract lawyer. Respond with valid JSON only. No markdown, no explanation.',
      messages: [{
        role: 'user',
        content: `For this contract, from perspective of "${enNev}": What is missing and how to negotiate?

CONTRACT SUMMARY: ${szerzodesNev} between ${enNev} and ${masikNev}.
KEY ISSUES: ${(elemzes1.kritikus_pontok || []).slice(0,3).map(x=>x.title).join(', ')}

Write ALL text in HUNGARIAN. Respond with ONLY this JSON:
{
  "hianyzo_klauzulak": [{"title": "cim", "fontossag": "kotelezo vagy ajanlott", "javaslat": "mit irni"}],
  "targyalasi_tippek": ["konkret erv"],
  "alternativ_szovegek": [{"cim": "klauzula neve", "szoveg": "beillesztheto szoveg"}]
}`
      }]
    });
    totalIn += r2b.usage.input_tokens;
    totalOut += r2b.usage.output_tokens;
    const elemzes2 = extractJSON(r2b.content[0].text) || {};

    // STEP 3: Summary
    console.log('3. Osszefoglalo...');
    const r3 = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Write a 3-sentence summary IN HUNGARIAN for "${enNev}" about this ${szerzodesNev}.
Risk: ${elemzes1.risk_score}/100. Issues: ${(elemzes1.kritikus_pontok||[]).slice(0,2).map(x=>x.title).join(', ')}
Respond ONLY with: {"summary": "3 mondatos magyar osszefoglalo"}`
      }]
    });
    totalIn += r3.usage.input_tokens;
    totalOut += r3.usage.output_tokens;
    const sumData = extractJSON(r3.content[0].text) || {};

    const cost = estimateCost(totalIn, totalOut);
    console.log(`KESZ | Score: ${elemzes1.risk_score} | Kritikus: ${elemzes1.kritikus_pontok?.length||0} | Koltseg: ${cost.cost_huf} Ft`);

    res.json({
      user_party: enNev,
      en_nev: enNev,
      masik_nev: masikNev,
      en_szerep: enSzerep,
      contract_type: szerzodesNev,
      risk_score: elemzes1.risk_score || 50,
      eros_pontok: (elemzes1.eros_pontok || []).slice(0, 6),
      javithato_pontok: (elemzes1.javithato_pontok || []).slice(0, 8),
      kritikus_pontok: (elemzes1.kritikus_pontok || []).slice(0, 10),
      hianyzo_klauzulak: (elemzes2.hianyzo_klauzulak || []).slice(0, 8),
      targyalasi_tippek: (elemzes2.targyalasi_tippek || []).slice(0, 6),
      eroviszony: {
        en_score: elemzes1.en_score || elemzes1.risk_score || 50,
        masik_score: elemzes1.masik_score || 50,
        en_fel: enNev,
        masik_fel: masikNev,
        osszefoglalas: elemzes1.eroviszony_szoveg || sumData.summary || 'Az elemzes elkeszult.'
      },
      alternativ_szovegek: (elemzes2.alternativ_szovegek || []).slice(0, 4),
      ptk_references: [],
      summary: sumData.summary || elemzes1.eroviszony_szoveg || 'Az elemzes elkeszult.',
      _cost: cost
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
      if (action === 'generate') return res.json({
        contract: `VALLALKOZASI SZERZODES\n\n[MOCK]\n\n${party1||'1. Fel'} es ${party2||'2. Fel'} kozott.\n\nKelt: ${date||new Date().toLocaleDateString('hu-HU')}`,
        _mock: true
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    if (action === 'hints') {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 1000,
        messages: [{ role: 'user', content: `Hungarian lawyer. What must be in a "${type}" contract for "${favor}". JSON only: {"hints":[{"text":"STRING in Hungarian","importance":"must|rec|opt"}]}` }]
      });
      return res.json(extractJSON(r.content[0].text) || { hints: [] });
    }

    if (action === 'generate') {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 8000,
        system: `Tapasztalt magyar ugyvéd. Keszits ${level} ${type}-t PTK alapjan. Vedd ${favor} erdekeit. Legyen teljes!`,
        messages: [{ role: 'user', content: `Tipus: ${type}\n1. Fel: ${party1||'1. Fel'}\n2. Fel: ${party2||'2. Fel'}\nOsszeg: ${amount||'megallapodas szerint'}\nHatarido: ${deadline||'megallapodas szerint'}\nDatum: ${date||new Date().toLocaleDateString('hu-HU')}\nReszletesseg: ${level}\nTargy: ${details}\nKulonleges: ${special||'szokásos'}` }]
      });
      return res.json({ contract: r.content[0].text, _cost: estimateCost(r.usage.input_tokens, r.usage.output_tokens) });
    }

    res.status(400).json({ error: 'Ismeretlen action' });
  } catch (err) {
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LexAI szerver fut: port ${PORT}`));
