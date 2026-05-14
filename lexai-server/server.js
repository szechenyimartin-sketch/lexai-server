const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MOCK_MODE = process.env.MOCK_MODE === 'true';

if (MOCK_MODE) console.log('MOCK MODE');
else console.log('ELES MOD v107');

// Prefill: Claude KENYSZERITVE { val kezd
async function claudeJSON(prompt, maxTokens) {
  const r = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: maxTokens,
    messages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: '{' }
    ]
  });
  // A valasz mar { utan folytatodik, hozzafuzzuk
  return '{' + r.content[0].text;
}

function tryParse(raw) {
  if (!raw) return null;
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s < 0 || e < 0) { console.log('NO JSON:', raw.slice(0,100)); return null; }
  const c = raw.substring(s, e+1);
  try { return JSON.parse(c); }
  catch(err) {
    try { return JSON.parse(c.replace(/,(\s*[}\]])/g,'$1')); }
    catch(err2) { console.log('PARSE ERR:', err2.message, c.slice(0,100)); return null; }
  }
}

function calcCost(inp, out) {
  const usd = (inp/1000000)*3.0 + (out/1000000)*15.0;
  return { input_tokens:inp, output_tokens:out, cost_usd:Math.round(usd*10000)/10000, cost_huf:Math.round(usd*370) };
}

const MOCK = {
  user_party:'Befektető', contract_type:'Befektetési szerződés', risk_score:45,
  eros_pontok:[{title:'Anti-dilúciós védelem',desc:'Weighted average módszer védi a befektetőt.'}],
  javithato_pontok:[{title:'Exit határidő',desc:'Nem kötelező, visszavásárlást érdemes beépíteni.',ptk_ref:'6:150.§'}],
  kritikus_pontok:[
    {title:'ESOP jogi státusz tisztázatlan',desc:'Szavazati jog nincs rögzítve.',fix:'Külön ESOP megállapodás kell.',ptk_ref:'3:1.§'},
    {title:'Drag-Along küszöb alacsony',desc:'51% kényszereladást tesz lehetővé.',fix:'Emeljük 75%-ra.',ptk_ref:'6:137.§'}
  ],
  hianyzo_klauzulak:[{title:'Likvidációs preferencia',fontossag:'kotelezo',javaslat:'Rögzíteni kell a sorrendet.'}],
  targyalasi_tippek:['ESOP elkülönítés kérése.','Drag-Along 75%-ra emelése.'],
  eroviszony:{en_score:45,masik_score:55,en_fel:'Befektető',masik_fel:'Alapítók',osszefoglalas:'A szerződés az Alapítóknak kedvez.'},
  alternativ_szovegek:[{cim:'Drag-Along minimálár',szoveg:'A jog csak akkor gyakorolható ha a vételár eléri az eredeti befektetés 150%-át.'}],
  ptk_references:[], summary:'A szerződés az Alapítóknak kedvező struktúrát mutat.', _mock:true
};

app.get('/', (req, res) => res.json({ status:'LexAI Backend', version:'107.0', mock_mode:MOCK_MODE }));

app.post('/api/analyze', async (req, res) => {
  try {
    const { text, type, userParty } = req.body;
    if (!text || text.length < 30) return res.status(400).json({ error:'Nincs szoveg' });
    if (MOCK_MODE) {
      await new Promise(r => setTimeout(r,1500));
      return res.json({ ...MOCK, user_party: userParty||'Ugyfel' });
    }
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error:'API kulcs hiányzik' });

    let tin=0, tout=0;
    const ugyfel = userParty || 'az ugyfel';
    const szoveg = text.slice(0, 8000);

    // 1. Felek
    console.log('1. Felek...');
    const r1 = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 300,
      messages: [
        { role: 'user', content: `Read this contract. Who are the two parties? Which one is "${ugyfel}"?\n\nCONTRACT:\n${text.slice(0,3000)}\n\nReturn a JSON object:` },
        { role: 'assistant', content: '{"fel1_nev":"' }
      ]
    });
    tin+=r1.usage.input_tokens; tout+=r1.usage.output_tokens;
    const felek = tryParse('{"fel1_nev":"' + r1.content[0].text) || {};
    const userIsFel1 = felek.user_fel !== 'fel2';
    const enNev = userIsFel1 ? (felek.fel1_nev||ugyfel) : (felek.fel2_nev||ugyfel);
    const masikNev = userIsFel1 ? (felek.fel2_nev||'Masik fel') : (felek.fel1_nev||'Masik fel');
    const enSzerep = userIsFel1 ? (felek.fel1_szerep||'') : (felek.fel2_szerep||'');
    const szTipus = felek.szerzodes_tipus || type || 'Szerzodes';
    console.log(`Felek: ${enNev} vs ${masikNev}`);

    // 2a. Eros + kritikus (PREFILL)
    console.log('2a. Eros + kritikus...');
    const raw2a = await claudeJSON(
      `You are a Hungarian contract lawyer. Analyze this contract from "${enNev}" (${enSzerep}) perspective.\nOther party: "${masikNev}". Contract: ${szTipus}.\n\nCONTRACT:\n${szoveg}\n\nFind strong points and critical problems for "${enNev}". All text in Hungarian.\n\nComplete this JSON:`,
      1500
    );
    tin += 500; tout += 500; // becsles
    console.log('r2a:', raw2a.slice(0,100));
    const d2a = tryParse(raw2a) || {};
    // Ha ures, probald meg ujra egyszerubb prompttal
    if (!d2a.risk_score) {
      console.log('2a retry...');
      const raw2a2 = await claudeJSON(
        `Hungarian contract lawyer. Contract: ${szTipus}. Client: ${enNev}. Other: ${masikNev}.\n\nContract text: ${szoveg.slice(0,4000)}\n\nAnalyze for ${enNev}. Hungarian text. Complete this JSON:`,
        1200
      );
      const d2a2 = tryParse(raw2a2) || {};
      if (d2a2.risk_score) Object.assign(d2a, d2a2);
    }
    console.log(`2a: risk=${d2a.risk_score}, kritikus=${d2a.kritikus_pontok?.length||0}, eros=${d2a.eros_pontok?.length||0}`);

    // 2b. Javithato + hianyzo (PREFILL)
    console.log('2b. Javithato...');
    const raw2b = await claudeJSON(
      `Hungarian contract lawyer. Contract: ${szTipus} between "${enNev}" and "${masikNev}".\n\nCONTRACT:\n${szoveg}\n\nFind improvable and missing clauses for "${enNev}". All text in Hungarian.\n\nComplete this JSON:`,
      1200
    );
    const d2b = tryParse(raw2b) || {};
    console.log(`2b: javithato=${d2b.javithato_pontok?.length||0}, hianyzo=${d2b.hianyzo_klauzulak?.length||0}`);

    // 2c. Tippek (PREFILL)
    console.log('2c. Tippek...');
    const issues = (d2a.kritikus_pontok||[]).slice(0,3).map(x=>x.title).join(', ') || 'altalanos problemak';
    const raw2c = await claudeJSON(
      `Hungarian contract lawyer. Client: "${enNev}". Contract: ${szTipus}. Problems: ${issues}.\n\nGive negotiation tips and alternative texts for "${enNev}". All text in Hungarian.\n\nComplete this JSON:`,
      1000
    );
    const d2c = tryParse(raw2c) || {};

    // 3. Osszefoglalo (PREFILL)
    console.log('3. Osszefoglalo...');
    const raw3 = await claudeJSON(
      `Write 3 sentences in Hungarian for "${enNev}" about this ${szTipus}.\nRisk: ${d2a.risk_score||50}/100. Problems: ${issues}.\n\nComplete this JSON:`,
      250
    );
    const d3 = tryParse(raw3) || {};

    const c = calcCost(tin, tout);
    console.log(`KESZ | Score: ${d2a.risk_score} | Kritikus: ${d2a.kritikus_pontok?.length||0} | Koltseg: ${c.cost_huf} Ft`);

    res.json({
      user_party:enNev, en_nev:enNev, masik_nev:masikNev, en_szerep:enSzerep,
      contract_type:szTipus, risk_score:d2a.risk_score||50,
      eros_pontok:(d2a.eros_pontok||[]).slice(0,6),
      javithato_pontok:(d2b.javithato_pontok||[]).slice(0,8),
      kritikus_pontok:(d2a.kritikus_pontok||[]).slice(0,10),
      hianyzo_klauzulak:(d2b.hianyzo_klauzulak||[]).slice(0,8),
      targyalasi_tippek:(d2c.targyalasi_tippek||[]).slice(0,6),
      eroviszony:{
        en_score:d2a.en_score||50, masik_score:d2a.masik_score||50,
        en_fel:enNev, masik_fel:masikNev,
        osszefoglalas:d2c.eroviszony_szoveg||d3.summary||'Az elemzes elkeszult.'
      },
      alternativ_szovegek:(d2c.alternativ_szovegek||[]).slice(0,4),
      ptk_references:[],
      summary:d3.summary||d2c.eroviszony_szoveg||'Az elemzes elkeszult.',
      _cost:c
    });

  } catch(err) {
    console.error('Hiba:', err.message);
    res.status(500).json({ error:'Szerverhiba: '+err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const { action, type, favor, party1, party2, amount, deadline, date, level, details, special } = req.body;
    if (MOCK_MODE) {
      await new Promise(r => setTimeout(r,800));
      if (action==='hints') return res.json({hints:[
        {text:'Fizetesi hatarido es kesedelmi kamat (Ptk. 6:155§)',importance:'must'},
        {text:'Teljesitesi hely es atvétel modja',importance:'must'},
        {text:'Szavatossagi feltetelek',importance:'must'},
        {text:'Felmondasi feltetelek',importance:'rec'},
        {text:'Vis maior klauzula',importance:'rec'}
      ]});
      if (action==='generate') return res.json({contract:`MOCK SZERZODES\n\n${party1||'1. Fel'} es ${party2||'2. Fel'} kozott.\nKelt: ${date||new Date().toLocaleDateString('hu-HU')}`,_mock:true});
    }
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error:'API kulcs hiányzik' });
    if (action==='hints') {
      const raw = await claudeJSON(`Hungarian lawyer. What must be in a "${type}" contract for "${favor}". Complete this JSON:`, 800);
      return res.json(tryParse(raw) || {hints:[]});
    }
    if (action==='generate') {
      const r = await client.messages.create({
        model:'claude-sonnet-4-5', max_tokens:8000,
        system:`Tapasztalt magyar ugyvéd. Keszits ${level} ${type}-t PTK alapjan. Vedd ${favor} erdekeit. Legyen teljes!`,
        messages:[{role:'user',content:`Tipus: ${type}\n1. Fel: ${party1||'1. Fel'}\n2. Fel: ${party2||'2. Fel'}\nOsszeg: ${amount||'megallapodas szerint'}\nHatarido: ${deadline||'megallapodas szerint'}\nDatum: ${date||new Date().toLocaleDateString('hu-HU')}\nReszletesseg: ${level}\nTargy: ${details}\nKulonleges: ${special||'szokásos'}`}]
      });
      return res.json({contract:r.content[0].text, _cost:calcCost(r.usage.input_tokens,r.usage.output_tokens)});
    }
    res.status(400).json({error:'Ismeretlen action'});
  } catch(err) {
    res.status(500).json({error:'Szerverhiba: '+err.message});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LexAI szerver fut: port ${PORT}`));
