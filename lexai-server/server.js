const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MOCK_MODE = process.env.MOCK_MODE === 'true';

if (MOCK_MODE) console.log('MOCK MODE');
else console.log('ELES MOD v100');

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
    catch(e2) { return null; }
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
    { title: 'Likvidációs preferencia részletei', fontossag: 'kötelező', javaslat: 'Rögzíteni kell a likvidációs sorrend pontos matematikáját.' },
    { title: 'Információs jogok részletezése', fontossag: 'ajánlott', javaslat: 'Negyedéves pénzügyi és KPI riport kötelezettség.' }
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
  res.json({ status: 'LexAI Backend', version: '100.0', mock_mode: MOCK_MODE });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { text, type, userParty } = req.body;
    if (!text || text.length < 30) return res.status(400).json({ error: 'Nincs szöveg' });

    if (MOCK_MODE) {
      await new Promise(r => setTimeout(r, 1500));
      const m = Object.assign({}, MOCK_RESULT);
      m.user_party = userParty || 'Ügyfél';
      return res.json(m);
    }

    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    let totalIn = 0, totalOut = 0;
    const ugyfel = userParty || 'az ügyfél';

    // LÉPÉS 1: Felek azonosítása
    console.log('1. Felek azonosítása...');
    const r1 = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Ez egy szerződés. Azonosítsd a feleket és állapítsd meg melyik fél a "${ugyfel}".

SZERZŐDÉS ELEJE:
${text.slice(0, 4000)}

Válaszolj CSAK ebben a JSON formátumban, semmi más:
{"fel1_nev":"pontos név","fel1_szerep":"szerepe pl. Befektető","fel2_nev":"pontos név","fel2_szerep":"szerepe pl. Alapító","szerzodes_tipus":"szerződés típusa","user_fel":"fel1 vagy fel2 attól függően melyik a ${ugyfel}"}`
      }]
    });
    totalIn += r1.usage.input_tokens;
    totalOut += r1.usage.output_tokens;

    const felek = extractJSON(r1.content[0].text) || {};
    const userIsFel1 = felek.user_fel !== 'fel2';
    const enNev = userIsFel1 ? (felek.fel1_nev || ugyfel) : (felek.fel2_nev || ugyfel);
    const masikNev = userIsFel1 ? (felek.fel2_nev || 'Másik fél') : (felek.fel1_nev || 'Másik fél');
    const enSzerep = userIsFel1 ? (felek.fel1_szerep || '') : (felek.fel2_szerep || '');
    const szerzodesNev = felek.szerzodes_tipus || type || 'Szerződés';

    console.log(`Felek: ${enNev} vs ${masikNev} | Típus: ${szerzodesNev}`);

    // LÉPÉS 2: Fő elemzés
    console.log('2. Elemzés...');
    const chunks = splitText(text, 14000);
    const elemzendoSzoveg = chunks.length === 1 ? chunks[0] : chunks[0] + '\n\n...\n\n' + chunks[chunks.length - 1];

    const r2 = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `Te egy tapasztalt magyar ügyvéd vagy. Elemezd ezt a szerződést KIZÁRÓLAG "${enNev}" (${enSzerep}) szemszögéből!

A MÁSIK FÉL: "${masikNev}"
SZERZŐDÉS TÍPUSA: ${szerzodesNev}

SZERZŐDÉS SZÖVEGE:
${elemzendoSzoveg}

FELADATOD: Találj minden fontos pontot ami "${enNev}" érdekeit érinti.

Válaszolj CSAK ebben a JSON formátumban, semmi más szöveg:
{
"risk_score": 50,
"eros_pontok": [
{"title": "cím max 60 kar", "desc": "magyarázat hogy ez miért jó ${enNev} számára"}
],
"javithato_pontok": [
{"title": "cím", "desc": "mit kellene javítani és hogyan", "ptk_ref": "pl. 6:155.§ vagy üres string"}
],
"kritikus_pontok": [
{"title": "cím", "desc": "miért hátrányos ${enNev} számára", "fix": "konkrét javítási javaslat", "ptk_ref": "pl. 6:142.§ vagy üres string"}
],
"hianyzo_klauzulak": [
{"title": "cím", "fontossag": "kötelező vagy ajánlott vagy opcionális", "javaslat": "mit kellene beírni"}
],
"targyalasi_tippek": [
"konkrét tárgyalási érv amit ${enNev} mondhat"
],
"alternativ_szovegek": [
{"cim": "klauzula neve", "szoveg": "konkrét beilleszthető szerződéses szöveg"}
],
"eroviszony_szoveg": "2-3 mondatos összefoglaló az erőviszonyokról ${enNev} szemszögéből",
"en_score": 50,
"masik_score": 50
}`
      }]
    });
    totalIn += r2.usage.input_tokens;
    totalOut += r2.usage.output_tokens;

    const elemzes = extractJSON(r2.content[0].text);

    if (!elemzes) {
      console.log('JSON parse hiba, raw:', r2.content[0].text.slice(0, 500));
      return res.status(500).json({ error: 'Elemzési hiba - próbáld újra' });
    }

    console.log(`Elemzés kész: ${elemzes.kritikus_pontok?.length || 0} kritikus, ${elemzes.eros_pontok?.length || 0} erős pont`);

    // LÉPÉS 3: Összefoglaló
    console.log('3. Összefoglaló...');
    const r3 = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Ügyfél: ${enNev} | Szerződés: ${szerzodesNev}
Kockázati pontszám: ${elemzes.risk_score}/100
Kritikus problémák: ${(elemzes.kritikus_pontok || []).slice(0, 3).map(x => x.title).join(', ')}
Erős pontok: ${(elemzes.eros_pontok || []).slice(0, 2).map(x => x.title).join(', ')}

Írj egy 3 mondatos összefoglalót ${enNev} szemszögéből. Válaszolj CSAK ebben a JSON formátumban:
{"summary": "3 mondatos összefoglaló"}`
      }]
    });
    totalIn += r3.usage.input_tokens;
    totalOut += r3.usage.output_tokens;

    const sumData = extractJSON(r3.content[0].text) || {};
    const cost = estimateCost(totalIn, totalOut);

    console.log(`KÉSZ | Score: ${elemzes.risk_score} | Költség: ${cost.cost_huf} Ft`);

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
        osszefoglalas: elemzes.eroviszony_szoveg || sumData.summary || 'Az elemzés elkészült.'
      },
      alternativ_szovegek: (elemzes.alternativ_szovegek || []).slice(0, 4),
      ptk_references: [],
      summary: sumData.summary || elemzes.eroviszony_szoveg || 'Az elemzés elkészült.',
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
          { text: 'Fizetési határidő és késedelmi kamat (Ptk. 6:155§)', importance: 'must' },
          { text: 'Teljesítési hely és átvétel módja', importance: 'must' },
          { text: 'Szavatossági feltételek', importance: 'must' },
          { text: 'Felmondási feltételek', importance: 'rec' },
          { text: 'Vis maior klauzula', importance: 'rec' },
          { text: 'Vitarendezés módja', importance: 'opt' }
        ]
      });
      if (action === 'generate') return res.json({
        contract: `VÁLLALKOZÁSI SZERZŐDÉS\n\n[MOCK]\n\n${party1 || '1. Fél'} és ${party2 || '2. Fél'} között.\n\nKelt: ${date || new Date().toLocaleDateString('hu-HU')}`,
        _mock: true
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    if (action === 'hints') {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: `Magyar ügyvéd. Mit kell egy "${type}" szerződésbe "${favor}" szerint. Válaszolj CSAK JSON: {"hints":[{"text":"STRING","importance":"must|rec|opt"}]}` }]
      });
      return res.json(extractJSON(r.content[0].text) || { hints: [] });
    }

    if (action === 'generate') {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 8000,
        system: `Tapasztalt magyar ügyvéd. Készíts ${level} ${type}-t PTK alapján. Védd ${favor} érdekeit. Legyen teljes, konkrét Ptk. hivatkozásokkal!`,
        messages: [{
          role: 'user',
          content: `Típus: ${type}\n1. Fél: ${party1 || '1. Fél'}\n2. Fél: ${party2 || '2. Fél'}\nÖsszeg: ${amount || 'megállapodás szerint'}\nHatáridő: ${deadline || 'megállapodás szerint'}\nDátum: ${date || new Date().toLocaleDateString('hu-HU')}\nRészletesség: ${level}\nTárgy: ${details}\nKülönleges: ${special || 'szokásos'}`
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
