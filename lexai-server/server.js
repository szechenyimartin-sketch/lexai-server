const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MOCK_MODE = process.env.MOCK_MODE === 'true';

if (MOCK_MODE) console.log('MOCK MODE');
else console.log('ELES MOD v101');

function extractJSON(raw) {
  if (!raw) return null;
  // Remove markdown code blocks
  let c = raw.replace(/```json/gi, '').replace(/```/gi, '').trim();
  // Find first { and last }
  const s = c.indexOf('{');
  const e = c.lastIndexOf('}');
  if (s < 0 || e < 0) return null;
  c = c.substring(s, e + 1);
  try { return JSON.parse(c); }
  catch(e1) {
    // Try fixing trailing commas
    try { return JSON.parse(c.replace(/,(\s*[}\]])/g, '$1')); }
    catch(e2) {
      console.log('JSON parse failed, raw start:', c.slice(0, 200));
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
    { title: 'Exit határidő pontosítható', desc: '5 év szándék, de nem kötelezettség. Érdemes kötelező visszavásárlást beépíteni.', ptk_ref: '6:150.§' },
    { title: 'Kötbér mértéke alacsony', desc: 'A késedelmi kötbér 0.5%/nap, ami átlag alatt van.', ptk_ref: '6:185.§' }
  ],
  kritikus_pontok: [
    { title: 'ESOP részesedés jogi státusza tisztázatlan', desc: 'Az ESOP részesedések szavazati joga nincs rögzítve.', fix: 'Külön ESOP megállapodás szükséges a szavazati jogok rögzítésével.', ptk_ref: '3:1.§' },
    { title: 'Drag-Along küszöb túl alacsony (51%)', desc: 'Az 51%-os küszöb lehetővé teszi kényszereladást.', fix: 'Emeljük 75-80%-ra és adjunk minimálár garanciát.', ptk_ref: '6:137.§' }
  ],
  hianyzo_klauzulak: [
    { title: 'Likvidációs preferencia részletei', fontossag: 'kotelezo', javaslat: 'Rögzíteni kell a likvidációs sorrend pontos matematikáját.' },
    { title: 'Információs jogok részletezése', fontossag: 'ajanlott', javaslat: 'Negyedéves pénzügyi és KPI riport kötelezettség.' }
  ],
  targyalasi_tippek: [
    'Kérje az ESOP pool elkülönítést a szavazati jogok tisztázásával.',
    'A Drag-Along küszöbnél hivatkozzon arra, hogy az iparági standard 75-80%.',
    'Exit garanciánál ajánlja fel a kötelező visszavásárlást bekerülési érték 150%-án 5 év után.'
  ],
  eroviszony: {
    en_score: 45,
    masik_score: 55,
    en_fel: 'Befektető',
    masik_fel: 'Alapítók',
    osszefoglalas: 'A szerződés összességében az Alapítóknak kedvez. A Befektető pozíciója gyengébb az ESOP és Drag-Along rendelkezések miatt.'
  },
  alternativ_szovegek: [
    { cim: 'Drag-Along minimálár klauzula', szoveg: 'A Drag-Along jog kizárólag akkor gyakorolható, ha a felajánlott vételár eléri az eredeti befektetési összeget és a 20%-os éves hozamot (CAGR).' }
  ],
  ptk_references: [],
  summary: 'A befektetési szerződés összességében az Alapítóknak kedvező struktúrát mutat. Az ESOP kezelés és a Drag-Along küszöb komoly kockázatokat rejt a Befektető számára.',
  _mock: true
};

app.get('/', (req, res) => {
  res.json({ status: 'LexAI Backend', version: '101.0', mock_mode: MOCK_MODE });
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

CONTRACT BEGINNING:
${text.slice(0, 4000)}

IMPORTANT: Respond ONLY with this exact JSON structure, no other text:
{"fel1_nev":"exact name of party 1","fel1_szerep":"role e.g. Investor","fel2_nev":"exact name of party 2","fel2_szerep":"role e.g. Founder","szerzodes_tipus":"contract type in Hungarian","user_fel":"fel1 or fel2 depending on which is ${ugyfel}"}`
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

    console.log(`Felek: ${enNev} vs ${masikNev} | Tipus: ${szerzodesNev}`);

    // STEP 2: Main analysis
    console.log('2. Elemzes...');
    const chunks = splitText(text, 14000);
    const elemzendoSzoveg = chunks.length === 1
      ? chunks[0]
      : chunks[0] + '\n\n[...]\n\n' + chunks[chunks.length - 1];

    const r2 = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      system: 'You are an expert Hungarian contract lawyer. You MUST respond with valid JSON only. No explanations, no markdown, no text before or after the JSON object.',
      messages: [{
        role: 'user',
        content: `Analyze this contract EXCLUSIVELY from the perspective of "${enNev}" (${enSzerep}).
The other party is: "${masikNev}"
Contract type: ${szerzodesNev}

CONTRACT:
${elemzendoSzoveg}

Find all important clauses affecting "${enNev}". Write all text fields in HUNGARIAN language.

Respond with ONLY this JSON (no other text):
{
  "risk_score": <number 0-100, lower means better for ${enNev}>,
  "en_score": <number 0-100, protection level of ${enNev}>,
  "masik_score": <number 0-100, protection level of ${masikNev}>,
  "eros_pontok": [
    {"title": "<clause name>", "desc": "<why this is good for ${enNev}>"}
  ],
  "javithato_pontok": [
    {"title": "<clause name>", "desc": "<how to improve for ${enNev}>", "ptk_ref": "<e.g. 6:155 or empty>"}
  ],
  "kritikus_pontok": [
    {"title": "<clause name>", "desc": "<why this is harmful for ${enNev}>", "fix": "<concrete fix suggestion>", "ptk_ref": "<e.g. 6:142 or empty>"}
  ],
  "hianyzo_klauzulak": [
    {"title": "<missing clause>", "fontossag": "<kotelezo or ajanlott or opcionalis>", "javaslat": "<what to add>"}
  ],
  "targyalasi_tippek": [
    "<concrete negotiation argument for ${enNev}>"
  ],
  "alternativ_szovegek": [
    {"cim": "<clause name>", "szoveg": "<ready-to-use contract text in Hungarian>"}
  ],
  "eroviszony_szoveg": "<2-3 sentence summary of power balance from ${enNev} perspective in Hungarian>"
}`
      }]
    });
    totalIn += r2.usage.input_tokens;
    totalOut += r2.usage.output_tokens;

    console.log('Claude raw response start:', r2.content[0].text.slice(0, 300));

    const elemzes = extractJSON(r2.content[0].text);

    if (!elemzes) {
      console.log('JSON parse FAILED. Full response:', r2.content[0].text.slice(0, 1000));
      return res.status(500).json({ error: 'Elemzesi hiba - probald ujra' });
    }

    console.log(`Elemzes kesz: ${elemzes.kritikus_pontok?.length || 0} kritikus, ${elemzes.eros_pontok?.length || 0} eros pont`);

    // STEP 3: Summary
    console.log('3. Osszefoglalo...');
    const r3 = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Write a 3-sentence summary IN HUNGARIAN for "${enNev}" about this contract analysis.
Risk score: ${elemzes.risk_score}/100
Critical issues: ${(elemzes.kritikus_pontok || []).slice(0, 3).map(x => x.title).join(', ')}
Strong points: ${(elemzes.eros_pontok || []).slice(0, 2).map(x => x.title).join(', ')}

Respond ONLY with this JSON:
{"summary": "<3 sentence Hungarian summary>"}`
      }]
    });
    totalIn += r3.usage.input_tokens;
    totalOut += r3.usage.output_tokens;

    const sumData = extractJSON(r3.content[0].text) || {};
    const cost = estimateCost(totalIn, totalOut);

    console.log(`KESZ | Score: ${elemzes.risk_score} | Koltseg: ${cost.cost_huf} Ft`);

    res.json({
      user_party: enNev,
      en_nev: enNev,
      masik_nev: masikNev,
      en_szerep: enSzerep,
      contract_type: szerzodesNev,
      risk_score: elemzes.risk_score || 50,
      eros_pontok: (elemzes.eros_pontok || []).slice(0, 6),
      javithato_pontok: (elemzes.javithato_pontok || []).slice(0, 8),
      kritikus_pontok: (elemzes.kritikus_pontok || []).slice(0, 10),
      hianyzo_klauzulak: (elemzes.hianyzo_klauzulak || []).slice(0, 8),
      targyalasi_tippek: (elemzes.targyalasi_tippek || []).slice(0, 6),
      eroviszony: {
        en_score: elemzes.en_score || elemzes.risk_score || 50,
        masik_score: elemzes.masik_score || (100 - (elemzes.risk_score || 50)),
        en_fel: enNev,
        masik_fel: masikNev,
        osszefoglalas: elemzes.eroviszony_szoveg || sumData.summary || 'Az elemzes elkeszult.'
      },
      alternativ_szovegek: (elemzes.alternativ_szovegek || []).slice(0, 4),
      ptk_references: [],
      summary: sumData.summary || elemzes.eroviszony_szoveg || 'Az elemzes elkeszult.',
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
      if (action === 'hints') return res.json({
        hints: [
          { text: 'Fizetesi hatarido es kesedelmi kamat (Ptk. 6:155§)', importance: 'must' },
          { text: 'Teljesitesi hely es aatvétel modja', importance: 'must' },
          { text: 'Szavatossagi feltetelek', importance: 'must' },
          { text: 'Felmondasi feltetelek', importance: 'rec' },
          { text: 'Vis maior klauzula', importance: 'rec' },
          { text: 'Vitarendezés modja', importance: 'opt' }
        ]
      });
      if (action === 'generate') return res.json({
        contract: `VALLALKOZASI SZERZODES\n\n[MOCK]\n\n${party1 || '1. Fel'} es ${party2 || '2. Fel'} kozott.\n\nKelt: ${date || new Date().toLocaleDateString('hu-HU')}`,
        _mock: true
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    if (action === 'hints') {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: `Hungarian lawyer. What must be in a "${type}" contract for "${favor}". Respond ONLY with JSON: {"hints":[{"text":"STRING in Hungarian","importance":"must|rec|opt"}]}` }]
      });
      return res.json(extractJSON(r.content[0].text) || { hints: [] });
    }

    if (action === 'generate') {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 8000,
        system: `Tapasztalt magyar ugyvéd. Keszits ${level} ${type}-t PTK alapjan. Vedd ${favor} erdekeit. Legyen teljes, konkret Ptk. hivatkozasokkal!`,
        messages: [{
          role: 'user',
          content: `Tipus: ${type}\n1. Fel: ${party1 || '1. Fel'}\n2. Fel: ${party2 || '2. Fel'}\nOsszeg: ${amount || 'megallapodas szerint'}\nHatarido: ${deadline || 'megallapodas szerint'}\nDatum: ${date || new Date().toLocaleDateString('hu-HU')}\nReszletesseg: ${level}\nTargy: ${details}\nKulonleges: ${special || 'szokásos'}`
        }]
      });
      const cost = estimateCost(r.usage.input_tokens, r.usage.output_tokens);
      return res.json({ contract: r.content[0].text, _cost: cost });
    }

    res.status(400).json({ error: 'Ismeretlen action' });
  } catch (err) {
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LexAI szerver fut: port ${PORT}`));
