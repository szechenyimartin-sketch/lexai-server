const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MOCK_MODE = process.env.MOCK_MODE === 'true';

if (MOCK_MODE) console.log('MOCK MODE');
else console.log('ELES MOD v109');

// XML tagek kozott kerunk JSON-t - ez 100%-ban mukodik
async function askClaude(systemPrompt, userPrompt, maxTokens) {
  const r = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });
  const text = r.content[0].text;
  // XML tag kinyerese
  const match = text.match(/<json>([\s\S]*?)<\/json>/i);
  if (!match) {
    console.log('NO XML TAG, trying direct parse. Raw:', text.slice(0,200));
    // Fallback: direkt JSON kereses
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s >= 0 && e >= 0) {
      try { return { data: JSON.parse(text.substring(s, e+1)), usage: r.usage }; }
      catch(e) {}
    }
    return { data: null, usage: r.usage };
  }
  try {
    return { data: JSON.parse(match[1].trim()), usage: r.usage };
  } catch(err) {
    try {
      return { data: JSON.parse(match[1].trim().replace(/,(\s*[}\]])/g,'$1')), usage: r.usage };
    } catch(err2) {
      console.log('XML PARSE ERR:', err2.message, match[1].slice(0,150));
      return { data: null, usage: r.usage };
    }
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

app.get('/', (req, res) => res.json({ status:'LexAI Backend', version:'109.0', mock_mode:MOCK_MODE }));

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
    const r1 = await askClaude(
      'You are a contract analysis assistant. Always wrap your JSON response in <json></json> tags.',
      `Identify the two parties in this contract. Which one is "${ugyfel}"?\n\nCONTRACT:\n${text.slice(0,3000)}\n\nRespond with <json>{"fel1_nev":"...","fel1_szerep":"...","fel2_nev":"...","fel2_szerep":"...","szerzodes_tipus":"...","user_fel":"fel1 or fel2"}</json>`,
      400
    );
    tin += r1.usage.input_tokens; tout += r1.usage.output_tokens;
    const felek = r1.data || {};
    const userIsFel1 = felek.user_fel !== 'fel2';
    const enNev = userIsFel1 ? (felek.fel1_nev||ugyfel) : (felek.fel2_nev||ugyfel);
    const masikNev = userIsFel1 ? (felek.fel2_nev||'Masik fel') : (felek.fel1_nev||'Masik fel');
    const enSzerep = userIsFel1 ? (felek.fel1_szerep||'') : (felek.fel2_szerep||'');
    const szTipus = felek.szerzodes_tipus || type || 'Szerzodes';
    console.log(`Felek: ${enNev} vs ${masikNev}`);

    // 2. Fo elemzes
    console.log('2. Elemzes...');
    const r2 = await askClaude(
      `Te egy tapasztalt magyar szerződésjogász vagy. MINDIG <json></json> tagek közé tedd a JSON választ. Minden szöveges értéket magyarul írj.`,
      `Elemezd ezt a szerződést KIZÁRÓLAG "${enNev}" (${enSzerep}) szemszögéből!
Másik fél: "${masikNev}"
Szerződés típusa: ${szTipus}

SZERZŐDÉS SZÖVEGE:
${szoveg}

Találd meg az összes fontos pontot ami "${enNev}" érdekeit érinti.

Válaszolj ebben a formában:
<json>
{
  "risk_score": 50,
  "en_score": 50,
  "masik_score": 50,
  "eros_pontok": [{"title": "cim", "desc": "magyarazat"}],
  "javithato_pontok": [{"title": "cim", "desc": "mit javitani", "ptk_ref": ""}],
  "kritikus_pontok": [{"title": "cim", "desc": "miert hatranyos", "fix": "javitas", "ptk_ref": ""}],
  "hianyzo_klauzulak": [{"title": "cim", "fontossag": "kotelezo", "javaslat": "mit irni"}],
  "targyalasi_tippek": ["konkret erv"],
  "alternativ_szovegek": [{"cim": "klauzula", "szoveg": "szoveg"}],
  "eroviszony_szoveg": "2 mondatos osszefoglalo",
  "summary": "3 mondatos osszefoglalo"
}
</json>`,
      3000
    );
    tin += r2.usage.input_tokens; tout += r2.usage.output_tokens;
    const d = r2.data || {};
    console.log(`Elemzes: risk=${d.risk_score}, kritikus=${d.kritikus_pontok?.length||0}, eros=${d.eros_pontok?.length||0}`);

    const c = calcCost(tin, tout);
    console.log(`KESZ | Score: ${d.risk_score} | Kritikus: ${d.kritikus_pontok?.length||0} | Koltseg: ${c.cost_huf} Ft`);

    res.json({
      user_party:enNev, en_nev:enNev, masik_nev:masikNev, en_szerep:enSzerep,
      contract_type:szTipus, risk_score:d.risk_score||50,
      eros_pontok:(d.eros_pontok||[]).slice(0,6),
      javithato_pontok:(d.javithato_pontok||[]).slice(0,8),
      kritikus_pontok:(d.kritikus_pontok||[]).slice(0,10),
      hianyzo_klauzulak:(d.hianyzo_klauzulak||[]).slice(0,8),
      targyalasi_tippek:(d.targyalasi_tippek||[]).slice(0,6),
      eroviszony:{
        en_score:d.en_score||50,
        masik_score:d.masik_score||50,
        en_fel:enNev, masik_fel:masikNev,
        osszefoglalas:d.eroviszony_szoveg||d.summary||'Az elemzes elkeszult.'
      },
      alternativ_szovegek:(d.alternativ_szovegek||[]).slice(0,4),
      ptk_references:[],
      summary:d.summary||d.eroviszony_szoveg||'Az elemzes elkeszult.',
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
      const r = await askClaude(
        'Hungarian contract lawyer. Wrap JSON in <json></json> tags.',
        `What must be in a "${type}" contract for "${favor}"? Respond: <json>{"hints":[{"text":"STRING in Hungarian","importance":"must|rec|opt"}]}</json>`,
        800
      );
      return res.json(r.data || {hints:[]});
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
