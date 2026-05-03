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
  fel1_score: 75, fel2_score: 25,
  fel1_name: 'Obudai Venture Capital Zrt.', fel2_name: 'Alapitok es Celtarsasag',
  per_esely_fel1: 75, per_esely_fel2: 25, merleg: 'fel1_eros', score: 50,
  verdict: 'Strukturalis egyensulyhiany, kisebbsegi jogvedelem hianyos',
  summary: 'A szerzodes jelentosen a Befekteto javara billen.',
  top_actions: ['ESOP keretszerzodes', 'Drag-Along 80%-ra', 'Vetojogok rogzitese'],
  fel1_javaslatok: ['ESOP elkülönitese', 'Preferred Return 2x'],
  fel2_javaslatok: ['Drag-Along minimalár', 'Tag-Along 100%'],
  issues: [
    { severity: 'kritikus', title: 'Minimalis exit garancia hianya', location: '6.2.5 (~5. oldal)', favors: 'fel2',
      description: 'Nincs kötelező visszavasarlasi garancia a befektetőnek.', fix_text: 'Exit garancia klauzula beepitese.',
      impactA: 'Befekteto nem tudja kikenyszeriteni exitet', impactB: 'Alapitoknak kedvezo short term' },
    { severity: 'kritikus', title: 'Drag-Along tul alacsony kuszob', location: '7.3 (~7. oldal)', favors: 'fel1',
      description: 'Drag-Along 51%-on aktiválódik, kenyszereladas barmilyen aron.', fix_text: 'Drag-Along kuszob 75-80%-ra.',
      impactA: 'Befekteto korlátlan hatalmat kap exitnel', impactB: 'Alapitok kiszolgáltatottsaga' },
    { severity: 'kritikus', title: 'ESOP jogi statussa tisztazatlan', location: '4.4.2 (~3. oldal)', favors: 'mindketto',
      description: 'ESOP reszesedések nincsenek külön jogosulthoz rendelve.', fix_text: 'Külön ESOP megallapodas keszitese.',
      impactA: 'Befekteto pozicioja bizonytalan', impactB: 'Alapitok szavazati ereje bizonytalan' },
    { severity: 'figyelmeztetés', title: 'Vesting utemezés hianya', location: '4.3 (~3. oldal)', favors: 'mindketto',
      description: 'Vesting ütemezese nincs reszletezve.', fix_text: '1 eves cliff, 4 eves linearis vesting.',
      impactA: 'Befekteto kockazata no', impactB: 'Alapitok motivacioja gyenge' },
    { severity: 'figyelmeztetés', title: 'Informacios jogok gyengek', location: '8.1 (~8. oldal)', favors: 'fel2',
      description: 'Nincs rendkivüli esemeny ertesites.', fix_text: 'MAC ertesitesi 5 munkanapon belül.',
      impactA: 'Befekteto keson ertesül kritikus esemenyekrol', impactB: 'Alapitokra kisebb teher' }
  ],
  positives: [
    { title: 'Anti-dilucios vedelem megvan', description: '' },
    { title: 'Board megfigyeloi jog biztositott', description: '' }
  ],
  structure: { fel1: 'Obudai Venture Capital Zrt.', fel2: 'Alapitok es Celtarsasag', type: 'Befektetesi szerzodes' },
  _pages: 12, _sections: 3, _mock: true
};

app.get('/', (req, res) => res.json({ status: 'LexAI Backend', version: '10.0', mock: MOCK_MODE }));

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

    let totalIn = 0, totalOut = 0;
    const allIssues = [], allPositives = [];
    let structure = {};

    // LÉPÉS 1: Felek azonositasa
    try {
      const r0 = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 400,
        messages: [{ role: 'user', content:
          toAnalyze[0].substring(0, 3000) + '\n\n' +
          'Azonositsd a két felet.\n' +
          'JSON (TILOS ```json):\n' +
          '{"fel1":"fél1 neve","fel2":"fél2 neve","type":"szerz tipus","fel1_leiras":"ki ez a fél 1 mondatban","fel2_leiras":"ki ez a fél 1 mondatban"}'
        }]
      });
      totalIn += r0.usage.input_tokens; totalOut += r0.usage.output_tokens;
      const i0 = extractJSON(r0.content[0].text);
      if (i0 && i0.fel1) structure = i0;
    } catch(e) { console.error('Felek hiba:', e.message); }

    const fel1n = structure.fel1 || '1. fel';
    const fel2n = structure.fel2 || '2. fel';
    const fel1l = structure.fel1_leiras || 'az egyik fél';
    const fel2l = structure.fel2_leiras || 'a másik fél';

    // LÉPÉS 2: Chunkokból problémák gyujtése – CSAK leírás, favors nélkül
    const rawIssues = [];
    for (let i = 0; i < toAnalyze.length; i++) {
      const chunk = toAnalyze[i];
      const pFrom = Math.round(i * estPages / toAnalyze.length) + 1;
      const pTo = Math.round((i+1) * estPages / toAnalyze.length);

      // Pozitivumok
      try {
        const rP = await client.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 300,
          messages: [{ role: 'user', content:
            chunk.substring(0, 2000) + '\n\n' +
            'Adj 2 pozitivumot erről a szerz. részről.\n' +
            'JSON: {"pos1":"pozitivum","pos2":"pozitivum"}'
          }]
        });
        totalIn += rP.usage.input_tokens; totalOut += rP.usage.output_tokens;
        const pos = extractJSON(rP.content[0].text);
        if (pos) {
          if (pos.pos1) allPositives.push({ title: pos.pos1, description: '' });
          if (pos.pos2) allPositives.push({ title: pos.pos2, description: '' });
        }
      } catch(e) {}

      // Problémák – CSAK leírás, ki kinek kedvez nélkül
      try {
        const r2 = await client.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 2500,
          messages: [{ role: 'user', content:
            'Szerz. rész (~' + pFrom + '-' + pTo + '. oldal):\n\n' + chunk + '\n\n' +
            'Azonositsd a 6 legfontosabb problémás klauzulát.\n' +
            'Minden klauzulánál:\n' +
            '1. Mi a klauzula neve és hol van\n' +
            '2. Pontosan mit mond ez a klauzula (tárgyilagos leírás)\n' +
            '3. Melyik FÉLNEK AD JOGOT vagy ELŐNYT ez a klauzula\n' +
            '4. Mi a probléma és hogyan kell javítani\n\n' +
            'JSON (TILOS ```json):\n' +
            '{"klauzulak":[{' +
            '"sev":"kritikus|figyelmeztetés",' +
            '"title":"klauzula neve max 60 kar",' +
            '"loc":"fejezet (~' + pFrom + '.o)",' +
            '"jogot_kap":"pontosan melyik fél neve kapja a jogot/előnyt ebből",' +
            '"desc":"mi a probléma max 150 kar",' +
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
            if (k && k.title) rawIssues.push({
              severity: k.sev || 'figyelmeztetés',
              title: k.title,
              location: k.loc || '',
              jogot_kap: k.jogot_kap || '',
              description: k.desc || '',
              fix_text: k.fix || '',
              impactA: k.impactA || '',
              impactB: k.impactB || ''
            });
          });
        }
      } catch(e) { console.error('Klauzula hiba:', e.message); }
    }

    // LÉPÉS 3: Kategorizálás – külön hívás minden issue-ra
    // Az AI most csak EGY kérdést kap: "a jogot_kap fél fel1 vagy fel2?"
    for (const issue of rawIssues) {
      try {
        const r3 = await client.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 50,
          messages: [{ role: 'user', content:
            'A szerződés két fele:\n' +
            'FEL1: ' + fel1n + ' (' + fel1l + ')\n' +
            'FEL2: ' + fel2n + ' (' + fel2l + ')\n\n' +
            'A következő klauzulából ez a fél kapja a jogot/előnyt: "' + issue.jogot_kap + '"\n\n' +
            'Ez a fél FEL1 vagy FEL2? Válaszolj CSAK ennyit: "fel1" vagy "fel2" vagy "mindketto"'
          }]
        });
        totalIn += r3.usage.input_tokens; totalOut += r3.usage.output_tokens;
        const ans = r3.content[0].text.trim().toLowerCase();
        if (ans.includes('fel1')) issue.favors = 'fel1';
        else if (ans.includes('fel2')) issue.favors = 'fel2';
        else issue.favors = 'mindketto';
      } catch(e) {
        issue.favors = 'mindketto';
      }
      allIssues.push(issue);
    }

    // Deduplikáció
    function getKW(t) { return t.toLowerCase().split(/\s+/).filter(w => w.length > 4); }
    function isSim(a, b) { return a === b || getKW(a).filter(w => getKW(b).includes(w)).length >= 2; }
    const dedup = allIssues.filter((x, i, arr) => !arr.slice(0, i).some(p => isSim(p.title, x.title)));

    // SCORING – pure matematika, AI nem szól bele
    // favors:'fel1' = fel1-nek KEDVEZ = fel2-nek HÁTRÁNYOS
    // favors:'fel2' = fel2-nek KEDVEZ = fel1-nek HÁTRÁNYOS
    const fel1Hatrany = dedup.filter(x => x.favors === 'fel2');
    const fel2Hatrany = dedup.filter(x => x.favors === 'fel1');
    const mindketto = dedup.filter(x => x.favors === 'mindketto');

    function calcW(issues, shared) {
      let s = 0;
      issues.forEach(i => { s += i.severity === 'kritikus' ? 3 : 1; });
      shared.forEach(i => { s += i.severity === 'kritikus' ? 1.5 : 0.5; });
      return Math.max(s, 0);
    }

    const w1 = calcW(fel1Hatrany, mindketto);
    const w2 = calcW(fel2Hatrany, mindketto);
    const total = w1 + w2 || 1;

    // Védettség = 100 - (saját hátrány / összes hátrány * 100)
    const prot1 = Math.round((1 - w1/total) * 100);
    const prot2 = Math.round((1 - w2/total) * 100);
    const merleg = prot1 > prot2 + 10 ? 'fel1_eros' : prot2 > prot1 + 10 ? 'fel2_eros' : 'kiegyensulyozott';

    // Összefoglaló
    let sum = {};
    try {
      const sumR = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 500,
        messages: [{ role: 'user', content:
          fel1n + ' (' + fel1Hatrany.length + ' hátrányos pont): ' + fel1Hatrany.map(x=>x.title).join(', ') + '\n' +
          fel2n + ' (' + fel2Hatrany.length + ' hátrányos pont): ' + fel2Hatrany.map(x=>x.title).join(', ') + '\n\n' +
          'Adj összefoglalót erről a szerződésről.\n' +
          'JSON (TILOS ```json):\n' +
          '{"verdict":"max 10 szó",' +
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
    console.log('KESZ: ' + dedup.length + ' issue | prot1=' + prot1 + '% prot2=' + prot2 + '% | ' + cost.cost_huf + ' Ft');

    res.json({
      fel1_score: prot1, fel2_score: prot2,
      fel1_name: fel1n, fel2_name: fel2n,
      per_esely_fel1: prot1, per_esely_fel2: prot2,
      merleg: merleg,
      score: 50,
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
