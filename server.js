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
      description: 'Nincs kötelező visszavasarlasi garancia.', fix_text: 'Exit garancia klauzula beepitese.',
      impactA: 'Befekteto nem tudja kikenyszeriteni exitet', impactB: 'Alapitoknak kedvezo' },
    { severity: 'kritikus', title: 'Drag-Along kuszob tul alacsony', location: '7.3 (~7. oldal)', favors: 'fel1',
      description: 'Drag-Along 51%-on aktiválódik, kenyszereladas barmilyen aron.', fix_text: 'Drag-Along kuszob 75-80%-ra emelese.',
      impactA: 'Befekteto korlátlan hatalmat kap', impactB: 'Alapitok kiszolgáltatottsaga' },
    { severity: 'figyelmeztetés', title: 'Vesting utemezés nem reszletezett', location: '4.3 (~3. oldal)', favors: 'mindketto',
      description: 'Az ESOP program vesting ütemezese nincs reszletezve.', fix_text: '1 eves cliff, 4 eves linearis vesting.',
      impactA: 'Alapitok kontrollalatlanul rendelkezhetnek', impactB: 'Befekteto nem szamonkerheti' },
    { severity: 'figyelmeztetés', title: 'Informacios jogok korlatozottak', location: '8.1 (~8. oldal)', favors: 'fel2',
      description: 'Nincs rendkivüli esemeny ertesitesi kötelezettség.', fix_text: 'MAC ertesitesi 5 munkanapon belül.',
      impactA: 'Befekteto keson ertesül', impactB: 'Alapitokra adminisztrativ teher' }
  ],
  positives: [
    { title: 'Reszletes anti-dilucios vedelem', description: '' },
    { title: 'Board megfigyeloi jog biztositott', description: '' }
  ],
  structure: { fel1: 'Obudai Venture Capital Zrt.', fel2: 'Alapitok es Celtarsasag', type: 'Befektetesi szerzodes' },
  _pages: 12, _sections: 3, _mock: true
};

app.get('/', (req, res) => res.json({ status: 'LexAI Backend', version: '9.0', mock: MOCK_MODE }));

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
    let structure = {};
    let totalIn = 0;
    let totalOut = 0;

    // LEPÉS 1: Felek azonositasa az első chunkból
    try {
      const r0 = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 400,
        messages: [{ role: 'user', content:
          toAnalyze[0].substring(0, 3000) + '\n\n' +
          'Azonositsd a két felet és szerepüket.\n' +
          'JSON (TILOS ```json):\n' +
          '{"fel1":"fél1 neve","fel2":"fél2 neve","type":"szerz tipus",' +
          '"fel1_ad":"mit ad fél1 (pl: tokét, bért, munkát)","fel2_ad":"mit ad fél2",' +
          '"fel1_erős":true/false}'
        }]
      });
      totalIn += r0.usage.input_tokens; totalOut += r0.usage.output_tokens;
      const info0 = extractJSON(r0.content[0].text);
      if (info0 && info0.fel1) {
        structure = {
          fel1: info0.fel1, fel2: info0.fel2, type: info0.type,
          fel1_ad: info0.fel1_ad || '', fel2_ad: info0.fel2_ad || '',
          fel1_eros: info0.fel1_erős !== false
        };
      }
    } catch(e) { console.error('Felek azonositasa hiba:', e.message); }

    const fel1n = structure.fel1 || '1. fel';
    const fel2n = structure.fel2 || '2. fel';
    const fel1ad = structure.fel1_ad || 'tokét/jogot ad';
    const fel2ad = structure.fel2_ad || 'kötelezettséget vállal';

    // LEPÉS 2: Minden chunkból klauzulák összegyujtése
    for (let i = 0; i < toAnalyze.length; i++) {
      const chunk = toAnalyze[i];
      const pFrom = Math.round(i * estPages / toAnalyze.length) + 1;
      const pTo = Math.round((i+1) * estPages / toAnalyze.length);

      // 2a: Score és pozitívumok
      try {
        const r1 = await client.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 400,
          messages: [{ role: 'user', content:
            'Szerz. rész (~' + pFrom + '-' + pTo + '. oldal):\n\n' + chunk.substring(0, 2000) + '\n\n' +
            'JSON (TILOS ```json):\n' +
            '{"fel1_score":NUMBER_0_100,"fel2_score":NUMBER_0_100,"pos1":"pozitivum","pos2":"pozitivum"}'
          }]
        });
        totalIn += r1.usage.input_tokens; totalOut += r1.usage.output_tokens;
        const info1 = extractJSON(r1.content[0].text);
        if (info1) {
          if (info1.fel1_score) s1arr.push(info1.fel1_score);
          if (info1.fel2_score) s2arr.push(info1.fel2_score);
          if (info1.pos1) allPositives.push({ title: info1.pos1, description: '' });
          if (info1.pos2) allPositives.push({ title: info1.pos2, description: '' });
        }
      } catch(e) { console.error('Score hiba:', e.message); }

      // 2b: Problémák gyujtése - CSAK a klauzula és leírás, favors nélkül
      try {
        const r2 = await client.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 2000,
          messages: [{ role: 'user', content:
            'Szerz. rész (~' + pFrom + '-' + pTo + '. oldal):\n\n' + chunk + '\n\n' +
            'Gyujtsd össze a 6 legfontosabb problémás klauzulát.\n' +
            'Minden klauzulánál EGYETLEN kérdés: "Ez a klauzula ' + fel1n + '-nek vagy ' + fel2n + '-nek KEDVEZŐ?"\n' +
            '- Ha ' + fel1n + '-nek kedvező (mert ' + fel1ad + '): kedvez="fel1"\n' +
            '- Ha ' + fel2n + '-nek kedvező (mert ' + fel2ad + '): kedvez="fel2"\n' +
            '- Ha mindkettőnek rossz: kedvez="mindketto"\n\n' +
            'JSON (TILOS ```json):\n' +
            '{"klauzulak":[{' +
            '"sev":"kritikus|figyelmeztetés",' +
            '"title":"klauzula neve max 60 kar",' +
            '"loc":"fejezet (~' + pFrom + '.o)",' +
            '"kedvez":"fel1|fel2|mindketto",' +
            '"desc":"mi a probléma és miért kedvez annak a félnek max 150 kar",' +
            '"fix":"konkrét javítás max 150 kar",' +
            '"impactA":"hatás ' + fel1n + '-re",' +
            '"impactB":"hatás ' + fel2n + '-re"' +
            '}]}'
          }]
        });
        totalIn += r2.usage.input_tokens; totalOut += r2.usage.output_tokens;
        const res2 = extractJSON(r2.content[0].text);
        if (res2 && res2.klauzulak) {
          res2.klauzulak.forEach(k => {
            if (k && k.title) {
              // kedvez="fel1" azt jelenti fel1-nek KEDVEZŐ = fel2-nek HÁTRÁNYOS
              // Tehat favors=kedvez (azt a felet jelöli aki NYER ebből)
              allIssues.push({
                severity: k.sev || 'figyelmeztetés',
                title: k.title,
                location: k.loc || '',
                favors: k.kedvez || 'mindketto',
                description: k.desc || '',
                fix_text: k.fix || '',
                impactA: k.impactA || '',
                impactB: k.impactB || ''
              });
            }
          });
        }
        console.log('Chunk ' + (i+1) + ': ' + (res2 && res2.klauzulak ? res2.klauzulak.length : 0) + ' klauzula');
      } catch(e) { console.error('Klauzula hiba:', e.message); }
    }

    // Deduplikáció
    function getKW(t) { return t.toLowerCase().split(/\s+/).filter(w => w.length > 4); }
    function isSim(a, b) { return a === b || getKW(a).filter(w => getKW(b).includes(w)).length >= 2; }
    const dedup = allIssues.filter((x, i, arr) => !arr.slice(0, i).some(p => isSim(p.title, x.title)));

    // Scoring:
    // favors='fel1' = fel1-nek KEDVEZŐ = fel2-nek HÁTRÁNYOS -> fel2 hátrány pontja nő
    // favors='fel2' = fel2-nek KEDVEZŐ = fel1-nek HÁTRÁNYOS -> fel1 hátrány pontja nő
    const fel1Hatrany = dedup.filter(x => x.favors === 'fel2'); // fel2 kedvez = fel1 hátrány
    const fel2Hatrany = dedup.filter(x => x.favors === 'fel1'); // fel1 kedvez = fel2 hátrány
    const mindketto = dedup.filter(x => x.favors === 'mindketto');

    function calcW(issues, shared) {
      let s = 0;
      issues.forEach(i => { s += i.severity === 'kritikus' ? 3 : 1; });
      shared.forEach(i => { s += i.severity === 'kritikus' ? 1.5 : 0.5; });
      return s;
    }

    const w1 = calcW(fel1Hatrany, mindketto); // fel1 hátrányai
    const w2 = calcW(fel2Hatrany, mindketto); // fel2 hátrányai
    const total = w1 + w2 || 1;

    // Védettség: kevesebb hátrány = magasabb védettség
    const prot1 = Math.round((1 - w1/total) * 100);
    const prot2 = Math.round((1 - w2/total) * 100);

    const avgS1 = s1arr.length ? Math.round(s1arr.reduce((a,b)=>a+b,0)/s1arr.length) : 50;
    const avgS2 = s2arr.length ? Math.round(s2arr.reduce((a,b)=>a+b,0)/s2arr.length) : 50;

    // Összefoglaló
    let sum = {};
    try {
      const topIssues = dedup.slice(0,3).map(x=>x.title).join('; ') || 'nincs';
      const sumR = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 500,
        messages: [{ role: 'user', content:
          fel1n + ' hátrányos pontjai (' + fel1Hatrany.length + '): ' + fel1Hatrany.map(x=>x.title).join(', ') + '\n' +
          fel2n + ' hátrányos pontjai (' + fel2Hatrany.length + '): ' + fel2Hatrany.map(x=>x.title).join(', ') + '\n\n' +
          'Adj összefoglalót.\n' +
          'JSON (TILOS ```json):\n' +
          '{"verdict":"max 10 szó","merleg":"fel1_eros|fel2_eros|kiegyensulyozott",' +
          '"summary":"3 mondatos összefoglaló mindkét félről",' +
          '"j1a":"javaslat ' + fel1n + '","j1b":"javaslat",' +
          '"j2a":"javaslat ' + fel2n + '","j2b":"javaslat",' +
          '"a1":"legsürgősebb teendő","a2":"teendő","a3":"teendő"}'
        }]
      });
      totalIn += sumR.usage.input_tokens; totalOut += sumR.usage.output_tokens;
      sum = extractJSON(sumR.content[0].text) || {};
    } catch(e) { console.error('Summary hiba:', e.message); }

    const cost = estimateCost(totalIn, totalOut);
    console.log('KESZ: ' + dedup.length + ' issue | ' + cost.cost_huf + ' Ft | prot1=' + prot1 + '% prot2=' + prot2 + '%');

    res.json({
      fel1_score: prot1, fel2_score: prot2,
      fel1_name: fel1n, fel2_name: fel2n,
      per_esely_fel1: prot1, per_esely_fel2: prot2,
      merleg: sum.merleg || (prot1 > prot2 ? 'fel1_eros' : 'fel2_eros'),
      score: Math.round((avgS1+avgS2)/2),
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
        messages: [{ role: 'user', content: 'Magyar ügyvéd. Mit kell egy "' + type + '" szerződésbe "' + favor + '" szerint.\nJSON: {"hints":[{"text":"STRING","importance":"must|rec|opt"}]}' }]
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
