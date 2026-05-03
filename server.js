const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MOCK_MODE = process.env.MOCK_MODE === 'true';
if (MOCK_MODE) console.log('MOCK MODE'); else console.log('ELES MOD');

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
  const s = c.indexOf('{'), e = c.lastIndexOf('}');
  if (s < 0 || e < 0) return null;
  c = c.substring(s, e + 1);
  try { return JSON.parse(c); }
  catch(e1) {
    try { return JSON.parse(c.replace(/,(\s*[}\]])/g, '$1')); }
    catch(e2) { return null; }
  }
}

function estimateCost(inp, out) {
  const usd = (inp/1000000)*3.0 + (out/1000000)*15.0;
  return { input_tokens: inp, output_tokens: out, cost_usd: Math.round(usd*10000)/10000, cost_huf: Math.round(usd*370) };
}

const MOCK_RESULT = {
  fel1_score: 72, fel2_score: 28,
  fel1_name: 'Obudai Venture Capital Zrt.', fel2_name: 'Alapitok es Celtarsasag',
  per_esely_fel1: 72, per_esely_fel2: 28, merleg: 'fel1_eros', score: 50,
  verdict: 'Strukturalis egyensulyhiany, kisebbsegi jogvedelem hianyos',
  summary: 'A szerzodes jelentosen a Befekteto javara billen. Az Alapitok kisebbsegi jogai nincsenek megfeleloen vedve.',
  top_actions: ['ESOP keretszerzodes megalkotasa', 'Drag-Along kuszob 80%-ra emelese', 'Kisebbsegi vetojogok rogzitese'],
  fel1_javaslatok: ['ESOP pool elkülönitese', 'Preferred Return 2x biztositasa'],
  fel2_javaslatok: ['Drag-Along minimalár kuszob', 'Tag-Along jog 100%-os reszvetelre'],
  issues: [
    { severity: 'kritikus', title: 'ESOP reszesedes jogi statussa tisztazatlan', location: '4.4.2 (~3. oldal)', favors: 'mindketto',
      description: 'Az ESOP reszesedések nincsenek külön jogosulthoz rendelve.', fix_text: 'Külön ESOP megallapodas keszitese.',
      impactA: 'Alapitok szavazati ereje bizonytalan', impactB: 'Befekteto 20%-os pozicioja bizonytalan' },
    { severity: 'kritikus', title: 'Minimalis exit garancia hianya', location: '6.2.5 (~5. oldal)', favors: 'fel2',
      description: 'Nincs kötelező visszavasarlasi garancia.', fix_text: 'Exit garancia klauzula: 5 even belül visszavasarlas.',
      impactA: 'Befekteto nem tudja kikenyszeriteni exitet', impactB: 'Alapitoknak kedvezo' },
    { severity: 'kritikus', title: 'Drag-Along kuszob tul alacsony', location: '7.3 (~7. oldal)', favors: 'fel1',
      description: 'A Drag-Along jog 51%-os kuszöbon aktiválódik.', fix_text: 'Drag-Along kuszob 75-80%-ra emelese.',
      impactA: 'Befekteto korlátlan hatalmat kap', impactB: 'Alapitok kiszolgáltatottsaga' },
    { severity: 'figyelmeztetés', title: 'Vesting utemezés nem reszletezett', location: '4.3 (~3. oldal)', favors: 'mindketto',
      description: 'Az ESOP program vesting ütemezese nincs reszletezve.', fix_text: '1 eves cliff, 4 eves linearis vesting.',
      impactA: 'Alapitok kontrollalatlanul rendelkezhetnek', impactB: 'Befekteto nem szamonkerheti' },
    { severity: 'figyelmeztetés', title: 'Informacios jogok korlatozottak', location: '8.1 (~8. oldal)', favors: 'fel2',
      description: 'Nincs rendkivüli esemeny ertesitesi kötelezettség.', fix_text: 'MAC ertesitesi kötelezettség 5 munkanapon belül.',
      impactA: 'Befekteto keson ertesül', impactB: 'Alapitokra adminisztrativ teher' }
  ],
  positives: [
    { title: 'Reszletes anti-dilucios vedelem', description: '' },
    { title: 'Board megfigyeloi jog biztositott', description: '' },
    { title: 'Egyertelmü szavazati jogok', description: '' }
  ],
  structure: { fel1: 'Obudai Venture Capital Zrt.', fel2: 'Alapitok es Celtarsasag', type: 'Befektetesi szerzodes' },
  _pages: 12, _sections: 3, _mock: true
};

app.get('/', (req, res) => res.json({ status: 'LexAI Backend', version: '8.0', mock: MOCK_MODE }));

app.post('/api/analyze', async (req, res) => {
  try {
    const { text, type } = req.body;
    if (!text || text.length < 30) return res.status(400).json({ error: 'Nincs szoveg' });
    if (MOCK_MODE) { await new Promise(r => setTimeout(r, 1500)); return res.json(MOCK_RESULT); }
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    const estPages = Math.max(1, Math.round(text.length / 1800));
    const chunks = splitIntoChunks(text, 12000);
    const toAnalyze = chunks.length <= 3 ? chunks : [chunks[0], chunks[Math.floor(chunks.length/2)], chunks[chunks.length-1]];
    console.log('Elemzes: ' + estPages + ' oldal, ' + toAnalyze.length + ' resz');

    const allIssues = [], allPositives = [], s1arr = [], s2arr = [];
    let structure = {}, totalIn = 0, totalOut = 0;

    for (let i = 0; i < toAnalyze.length; i++) {
      const chunk = toAnalyze[i];
      const pFrom = Math.round(i * estPages / toAnalyze.length) + 1;
      const pTo = Math.round((i+1) * estPages / toAnalyze.length);

      // LEPÉS 1: Alap info + felek azonositasa
      try {
        const r1 = await client.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 600,
          messages: [{ role: 'user', content:
            'Szerződesrész (~' + pFrom + '-' + pTo + '. oldal):\n\n' + chunk.substring(0, 2000) + '\n\n' +
            'JSON (TILOS ```json):\n' +
            '{"fel1_score":NUMBER,"fel2_score":NUMBER,"fel1":"fél1 neve max 30 kar","fel2":"fél2 neve max 30 kar","fel1_szerep":"befekteto|berlo|munkaltato|vevo|egyeb","fel2_szerep":"alapito|berlő|munkavallaló|elado|egyeb","type":"szerzodes tipusa","pos1":"pozitivum","pos2":"pozitivum"}'
          }]
        });
        totalIn += r1.usage.input_tokens; totalOut += r1.usage.output_tokens;
        const info = extractJSON(r1.content[0].text);
        if (info) {
          if (info.fel1_score) s1arr.push(info.fel1_score);
          if (info.fel2_score) s2arr.push(info.fel2_score);
          if (info.fel1 && !structure.fel1) structure = { fel1: info.fel1, fel2: info.fel2, type: info.type, fel1_szerep: info.fel1_szerep || 'egyeb', fel2_szerep: info.fel2_szerep || 'egyeb' };
          if (info.pos1) allPositives.push({ title: info.pos1, description: '' });
          if (info.pos2) allPositives.push({ title: info.pos2, description: '' });
        }
      } catch(e) { console.error('Info hiba:', e.message); }

      const fel1n = structure.fel1 || '1. fél';
      const fel2n = structure.fel2 || '2. fél';
      const fel1s = structure.fel1_szerep || 'egyeb';
      const fel2s = structure.fel2_szerep || 'egyeb';

      // LEPÉS 2: Minden issue egy hívásban - az AI látja a teljes kontextust
      // A favors értéket a PROMPT alapján adjuk meg, NEM az AI dönti el
      try {
        const r2 = await client.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 3000,
          messages: [{ role: 'user', content:
            'Szerződesrész (~' + pFrom + '-' + pTo + '. oldal):\n\n' + chunk + '\n\n' +
            '=== KI KICSODA ===\n' +
            fel1n + ' = ' + fel1s.toUpperCase() + ' (ez a TŐKEERŐSEBB, JOGOKKAL RENDELKEZŐ fél)\n' +
            fel2n + ' = ' + fel2s.toUpperCase() + ' (ez a KÖTELEZETTSÉGEKET VÁLLALÓ, KISZOLGÁLTATOTTABB fél)\n\n' +
            '=== FELADAT ===\n' +
            'Azonosítsd a szerződes ÖSSZES lényeges problémáját. Minden issue-nál döntsd el:\n' +
            '- Ha a klauzula a ' + fel1n + ' TŐKEERŐS félnek hátrányos -> favors:"fel2"\n' +
            '- Ha a klauzula a ' + fel2n + ' KISZOLGÁLTATOTT félnek hátrányos -> favors:"fel1"\n' +
            '- Ha mindkettőnek hátrányos -> favors:"mindketto"\n\n' +
            'FONTOS SZABÁLYOK:\n' +
            '1. Egy befektetési szerződesben TIPIKUSAN az alapítónak több hátrányos pontja van\n' +
            '2. Ha nincs valódi hátrány az egyik félnek, írj kevesebbet - ne erőltesd\n' +
            '3. Adj meg MINIMUM 3, MAXIMUM 8 issue-t összesen\n\n' +
            'JSON (TILOS ```json):\n' +
            '{"issues":[{"sev":"kritikus|figyelmeztetés","title":"max 60 kar","loc":"fejezet (~' + pFrom + '.o)","favors":"fel1|fel2|mindketto","desc":"miért probléma és KINEK hátrányos konkrétan","fix":"konkrét javítás","impactA":"hatás ' + fel1n + '-re","impactB":"hatás ' + fel2n + '-re"}]}'
          }]
        });
        totalIn += r2.usage.input_tokens; totalOut += r2.usage.output_tokens;
        const res2 = extractJSON(r2.content[0].text);
        if (res2 && res2.issues) {
          res2.issues.forEach(issue => {
            if (issue && issue.title) {
              allIssues.push({
                severity: issue.sev || 'figyelmeztetés',
                title: issue.title, location: issue.loc || '',
                favors: issue.favors || 'mindketto',
                description: issue.desc || '',
                fix_text: issue.fix || '',
                impactA: issue.impactA || '',
                impactB: issue.impactB || ''
              });
            }
          });
        }
        console.log('Chunk ' + (i+1) + ': ' + (res2 && res2.issues ? res2.issues.length : 0) + ' issue');
      } catch(e) { console.error('Issue hiba:', e.message); }
    }

    const avgS1 = s1arr.length ? Math.round(s1arr.reduce((a,b)=>a+b,0)/s1arr.length) : 50;
    const avgS2 = s2arr.length ? Math.round(s2arr.reduce((a,b)=>a+b,0)/s2arr.length) : 50;

    // Deduplikáció
    function getKW(t) { return t.toLowerCase().split(/\s+/).filter(w => w.length > 4); }
    function isSim(a, b) { return a === b || getKW(a).filter(w => getKW(b).includes(w)).length >= 2; }
    const dedup = allIssues.filter((x, i, arr) => !arr.slice(0, i).some(p => isSim(p.title, x.title)));

    // Sulyozott scoring az issue-k alapjan
    const fel1Issues = dedup.filter(x => x.favors === 'fel2');
    const fel2Issues = dedup.filter(x => x.favors === 'fel1');
    const bothIssues = dedup.filter(x => x.favors === 'mindketto');

    function calcW(issues, shared) {
      let s = 0;
      issues.forEach(i => { s += i.severity === 'kritikus' ? 3 : 1; });
      shared.forEach(i => { s += i.severity === 'kritikus' ? 1.5 : 0.5; });
      return s;
    }

    const w1 = calcW(fel1Issues, bothIssues);
    const w2 = calcW(fel2Issues, bothIssues);
    const total = w1 + w2 || 1;

    // Vedettség: kevesebb hátrány = magasabb védettség
    const prot1 = Math.round((1 - w1/total) * 100);
    const prot2 = Math.round((1 - w2/total) * 100);

    // Összefoglaló
    const topIssues = dedup.slice(0,3).map(x=>x.title).join('; ') || 'nincs';
    let sum = {};
    try {
      const sumR = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 500,
        messages: [{ role: 'user', content:
          structure.fel1 + ' vedettség: ' + prot1 + '% (' + fel1Issues.length + ' hátrányos pont)\n' +
          structure.fel2 + ' vedettség: ' + prot2 + '% (' + fel2Issues.length + ' hátrányos pont)\n' +
          'Főbb problémák: ' + topIssues + '\n\n' +
          'JSON (TILOS ```json):\n' +
          '{"verdict":"max 10 szó","p1":' + prot1 + ',"p2":' + prot2 + ',"merleg":"fel1_eros|fel2_eros|kiegyensulyozott","summary":"3 mondatos összefoglaló","j1a":"javaslat ' + (structure.fel1||'fél1') + '","j1b":"javaslat","j2a":"javaslat ' + (structure.fel2||'fél2') + '","j2b":"javaslat","a1":"teendő","a2":"teendő","a3":"teendő"}'
        }]
      });
      totalIn += sumR.usage.input_tokens; totalOut += sumR.usage.output_tokens;
      sum = extractJSON(sumR.content[0].text) || {};
    } catch(e) { console.error('Summary hiba:', e.message); }

    const cost = estimateCost(totalIn, totalOut);
    console.log('KESZ: ' + dedup.length + ' issue | ' + cost.cost_huf + ' Ft');

    res.json({
      fel1_score: prot1, fel2_score: prot2,
      fel1_name: structure.fel1 || '1. Fél',
      fel2_name: structure.fel2 || '2. Fél',
      per_esely_fel1: prot1, per_esely_fel2: prot2,
      merleg: sum.merleg || (prot1 > prot2 ? 'fel1_eros' : 'fel2_eros'),
      score: Math.round((prot1+prot2)/2),
      verdict: sum.verdict || 'Az elemzés elkészült.',
      summary: sum.summary || 'Az elemzés elkészült.',
      top_actions: [sum.a1, sum.a2, sum.a3].filter(Boolean),
      fel1_javaslatok: [sum.j1a, sum.j1b].filter(Boolean),
      fel2_javaslatok: [sum.j2a, sum.j2b].filter(Boolean),
      issues: dedup.slice(0, 30),
      positives: allPositives.filter((v,i,a) => a.findIndex(x=>x.title===v.title)===i).slice(0,6),
      structure: structure,
      _pages: estPages, _sections: toAnalyze.length, _cost: cost
    });

  } catch(err) {
    console.error('Hiba:', err.message);
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const { action, type, favor, party1, party2, amount, deadline, date, level, details, special } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });
    if (action === 'hints') {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 2000,
        messages: [{ role: 'user', content: 'Magyar ügyvéd. Mit kell egy "' + type + '" szerződesbe "' + favor + '" szerint.\nJSON: {"hints":[{"text":"STRING","importance":"must|rec|opt"}]}' }]
      });
      return res.json(extractJSON(r.content[0].text) || { hints: [] });
    }
    if (action === 'generate') {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 8000,
        system: 'Tapasztalt magyar ügyvéd. Készíts ' + level + ' ' + type + '-t PTK alapján. Védd ' + favor + ' érdekeit. Legyen teljes!',
        messages: [{ role: 'user', content:
          'Típus:' + type + '\n1. Fél:' + (party1||'1. Fél') + '\n2. Fél:' + (party2||'2. Fél') +
          '\nÖsszeg:' + (amount||'megállapodás szerint') + '\nHatáridő:' + (deadline||'megállapodás szerint') +
          '\nDátum:' + (date||new Date().toLocaleDateString('hu-HU')) + '\nRészletesség:' + level +
          '\nTárgy:' + details + '\nKülönleges:' + (special||'szokásos')
        }]
      });
      return res.json({ contract: r.content[0].text });
    }
    res.status(400).json({ error: 'Ismeretlen action' });
  } catch(err) {
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('LexAI szerver fut: port ' + PORT));
