const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MOCK_MODE = process.env.MOCK_MODE === 'true';

if (MOCK_MODE) console.log('MOCK MODE');
else console.log('ELES MOD v108');

async function claudeJSON(prompt, maxTokens) {
  const r = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: maxTokens,
    messages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: '{' }
    ]
  });
  const raw = '{' + r.content[0].text;
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s < 0 || e < 0) { console.log('NO JSON'); return null; }
  const c = raw.substring(s, e+1);
  try { return { data: JSON.parse(c), tokens: r.usage }; }
  catch(err) {
    try { return { data: JSON.parse(c.replace(/,(\s*[}\]])/g,'$1')), tokens: r.usage }; }
    catch(err2) { console.log('PARSE ERR:', err2.message, '|', c.slice(0,100)); return null; }
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

app.get('/', (req, res) => res.json({ status:'LexAI Backend', version:'108.0', mock_mode:MOCK_MODE }));

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
    const ugyfel = userParty || 'the client';
    const szoveg = text.slice(0, 8000);

    // 1. Felek azonositasa
    console.log('1. Felek...');
    const r1 = await claudeJSON(
      `Identify the two parties in this contract. Which party is "${ugyfel}"?\n\nCONTRACT:\n${text.slice(0,3000)}\n\nJSON with these exact keys:`,
      300
    );
    if (r1) { tin+=r1.tokens.input_tokens; tout+=r1.tokens.output_tokens; }
    const felek = r1?.data || {};
    const userIsFel1 = felek.user_fel !== 'fel2';
    const enNev = userIsFel1 ? (felek.fel1_nev||ugyfel) : (felek.fel2_nev||ugyfel);
    const masikNev = userIsFel1 ? (felek.fel2_nev||'Other party') : (felek.fel1_nev||'Other party');
    const enSzerep = userIsFel1 ? (felek.fel1_szerep||'') : (felek.fel2_szerep||'');
    const szTipus = felek.szerzodes_tipus || type || 'Contract';
    console.log(`Felek: ${enNev} vs ${masikNev}`);

    // 2. FO ELEMZES - ANGOL - igy biztosan nem torik el az encoding
    console.log('2. Fo elemzes (angol)...');
    const r2 = await claudeJSON(
      `You are an expert Hungarian contract lawyer. Analyze this contract ONLY from the perspective of "${enNev}" (${enSzerep}). Other party: "${masikNev}". Contract type: ${szTipus}.\n\nCONTRACT TEXT:\n${szoveg}\n\nProvide a comprehensive analysis in ENGLISH (we will translate later). Find ALL important clauses.\n\nJSON with these exact keys (use English for all text values):`,
      2000
    );
    if (r2) { tin+=r2.tokens.input_tokens; tout+=r2.tokens.output_tokens; }
    const elemzesEN = r2?.data || {};
    console.log(`Elemzes EN: risk=${elemzesEN.risk_score}, critical=${elemzesEN.critical_issues?.length||0}, strong=${elemzesEN.strong_points?.length||0}`);

    // 3. FORDITAS MAGYARRA - egy hivas
    console.log('3. Forditas magyarra...');
    const r3 = await claudeJSON(
      `Translate this contract analysis to Hungarian. Keep all the legal meaning but write naturally in Hungarian.\n\nENGLISH ANALYSIS:\n${JSON.stringify(elemzesEN).slice(0,3000)}\n\nClient: "${enNev}", Other party: "${masikNev}", Contract: ${szTipus}\n\nReturn translated JSON with these exact Hungarian keys:`,
      2000
    );
    if (r3) { tin+=r3.tokens.input_tokens; tout+=r3.tokens.output_tokens; }
    const elemzesHU = r3?.data || {};
    console.log(`Forditas HU: kritikus=${elemzesHU.kritikus_pontok?.length||0}, eros=${elemzesHU.eros_pontok?.length||0}`);

    // Ha a forditas ures, hasznaljuk az angol verzioval feltoltve
    const riskScore = elemzesHU.risk_score || elemzesEN.risk_score || 50;
    const erosPontok = elemzesHU.eros_pontok || elemzesEN.strong_points?.map(x=>({title:x.title||x,desc:x.description||x.desc||''})) || [];
    const kritikusPontok = elemzesHU.kritikus_pontok || elemzesEN.critical_issues?.map(x=>({title:x.title||x,desc:x.description||x.desc||'',fix:x.fix||x.recommendation||'',ptk_ref:''})) || [];
    const javithatoPontok = elemzesHU.javithato_pontok || elemzesEN.improvable_clauses?.map(x=>({title:x.title||x,desc:x.description||x.desc||'',ptk_ref:''})) || [];
    const hianyzoKlauzulak = elemzesHU.hianyzo_klauzulak || elemzesEN.missing_clauses?.map(x=>({title:x.title||x,fontossag:'ajanlott',javaslat:x.suggestion||x.desc||''})) || [];
    const targyalasiTippek = elemzesHU.targyalasi_tippek || elemzesEN.negotiation_tips || [];
    const alternativSzovegek = elemzesHU.alternativ_szovegek || elemzesEN.alternative_texts?.map(x=>({cim:x.title||x.cim||'',szoveg:x.text||x.szoveg||''})) || [];
    const summary = elemzesHU.summary || elemzesEN.summary || 'Az elemzes elkeszult.';
    const eroviszonyText = elemzesHU.eroviszony_szoveg || elemzesEN.power_balance || summary;

    const c = calcCost(tin, tout);
    console.log(`KESZ | Score: ${riskScore} | Kritikus: ${kritikusPontok.length} | Koltseg: ${c.cost_huf} Ft`);

    res.json({
      user_party:enNev, en_nev:enNev, masik_nev:masikNev, en_szerep:enSzerep,
      contract_type:szTipus, risk_score:riskScore,
      eros_pontok:erosPontok.slice(0,6),
      javithato_pontok:javithatoPontok.slice(0,8),
      kritikus_pontok:kritikusPontok.slice(0,10),
      hianyzo_klauzulak:hianyzoKlauzulak.slice(0,8),
      targyalasi_tippek:targyalasiTippek.slice(0,6),
      eroviszony:{
        en_score:elemzesHU.en_score||elemzesEN.client_score||riskScore,
        masik_score:elemzesHU.masik_score||elemzesEN.other_score||(100-riskScore),
        en_fel:enNev, masik_fel:masikNev,
        osszefoglalas:eroviszonyText
      },
      alternativ_szovegek:alternativSzovegek.slice(0,4),
      ptk_references:[],
      summary:summary,
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
      const r = await claudeJSON(`Hungarian lawyer. List what must be in a "${type}" contract protecting "${favor}". JSON:`, 800);
      return res.json(r?.data || {hints:[]});
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
