const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MOCK_MODE = process.env.MOCK_MODE === 'true';
if (MOCK_MODE) console.log('⚠️  MOCK MODE AKTÍV');
else console.log('✅ ÉLES MÓD');

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
  const start = c.indexOf('{');
  const end = c.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  c = c.substring(start, end + 1);
  try { return JSON.parse(c); }
  catch(e) {
    try { return JSON.parse(c.replace(/,(\s*[}\]])/g, '$1')); }
    catch(e2) { return null; }
  }
}

function estimateCost(inputTokens, outputTokens) {
  const totalUsd = (inputTokens / 1000000) * 3.0 + (outputTokens / 1000000) * 15.0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: Math.round(totalUsd * 10000) / 10000,
    cost_huf: Math.round(totalUsd * 370)
  };
}

const MOCK_RESULT = {
  fel1_score: 72, fel2_score: 28,
  fel1_name: 'Óbuda Uni Venture Capital Zrt.',
  fel2_name: 'Alapítók és Céltársaság',
  per_esely_fel1: 72, per_esely_fel2: 28,
  merleg: 'fel1_eros',
  score: 50,
  verdict: 'Strukturális egyensúlyhiány, kisebbségi jogvédelem hiányos',
  summary: 'A szerződés jelentősen a Befektető javára billen. Az Alapítók kisebbségi jogai nincsenek megfelelően védve, és több kritikus klauzula hiányzik. Az ESOP kezelése jogilag tisztázatlan, ami komoly kockázatot jelent mindkét félnek.',
  top_actions: ['ESOP keretszerződés megalkotása (conversion ratio, vesting, voting)', 'Drag-Along küszöb minimum 80%-ra emelése', 'Kisebbségi vétójogok explicit rögzítése az alapdokumentumokban'],
  fel1_javaslatok: ['ESOP pool explicit elkülönítése alapító szavazati hígulás nélkül', 'Preferred Return minimum 2x biztosítása exit esetén'],
  fel2_javaslatok: ['Drag-Along minimálár küszöb bekerülési érték 80%-a', 'Tag-Along jog 100%-os részvételre minden exit tranzakcióban'],
  issues: [
    { severity: 'kritikus', title: 'ESOP részesedés jogi státusza tisztázatlan', location: '4.4.2 (~3. oldal)', favors: 'mindketto', description: 'Az ESOP részesedések nincsenek külön jogosulthoz rendelve, de az Alapítók tulajdonaként jelennek meg.', fix_text: 'Külön ESOP megállapodás készítése trustee kijelölésével.', impactA: 'Alapítók látszólagos 40%-os tulajdona valójában csak 33,40%', impactB: 'Befektető 20%-os pozíciója bizonytalan ESOP aktiváláskor' },
    { severity: 'kritikus', title: 'Minimális exit garancia hiánya', location: '6.2.5 (~5. oldal)', favors: 'fel2', description: 'Az Exit Esemény kulcsfogalmak csak hivatkozva vannak, nincs kötelező visszavásárlási garancia.', fix_text: 'Exit garancia klauzula: 5 éven belül nem történik exit esetén az Alapítók kötelesek visszavásárolni.', impactA: 'Befektető nem tudja kikényszeríteni exitét', impactB: 'Alapítók számára kedvező, de csökkenti befektetői bizalmat' },
    { severity: 'kritikus', title: 'Drag-Along küszöb túl alacsony', location: '7.3 (~7. oldal)', favors: 'fel1', description: 'A Drag-Along jog 51%-os küszöbön aktiválódik, kényszereladást kezdeményezhet bármilyen áron.', fix_text: 'Drag-Along küszöb minimum 75-80%-ra emelése minimálár garanciával.', impactA: 'Befektető korlátlan hatalmat kap 5 év után', impactB: 'Alapítók teljes kiszolgáltatottság méltánytalan áron' },
    { severity: 'figyelmeztetés', title: 'Vesting ütemezés nem részletezett', location: '4.3 (~3. oldal)', favors: 'mindketto', description: 'Az ESOP program vesting ütemezése nincs részletezve.', fix_text: 'ESOP szabályzat mellékletként: 1 éves cliff, 4 éves lineáris vesting.', impactA: 'Alapítók kontrollálatlanul rendelkezhetnek ESOP résszel', impactB: 'Befektető nem tudja számonkérni a kulcsemberek megtartását' },
    { severity: 'figyelmeztetés', title: 'Információs jogok korlátozottak', location: '8.1 (~8. oldal)', favors: 'fel2', description: 'Negyedéves jelentés van, de nincs rendkívüli esemény értesítési kötelezettség.', fix_text: 'MAC értesítési kötelezettség: 5 munkanapon belül minden >10% árbevételt érintő eseményről.', impactA: 'Befektető késve értesül kritikus eseményekről', impactB: 'Alapítókra adminisztratív terhet ró' }
  ],
  positives: [
    { title: 'Részletes anti-dilúciós védelem (weighted average)', description: '' },
    { title: 'Board megfigyelői jog biztosított a Befektetőnek', description: '' },
    { title: 'Egyértelmű szavazati jogok dokumentálva', description: '' },
    { title: 'Confidentialitási kötelezettség kölcsönös', description: '' }
  ],
  structure: { fel1: 'Óbuda Uni Venture Capital Zrt.', fel2: 'Alapítók és Céltársaság', type: 'Befektetési szerződés' },
  _pages: 12, _sections: 3, _mock: true
};

app.get('/', (req, res) => {
  res.json({ status: 'LexAI Backend running', version: '7.0', mock_mode: MOCK_MODE });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { text, type } = req.body;
    if (!text || text.length < 30) return res.status(400).json({ error: 'Nincs szöveg' });

    if (MOCK_MODE) {
      await new Promise(r => setTimeout(r, 1500));
      return res.json(MOCK_RESULT);
    }

    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    const estPages = Math.max(1, Math.round(text.length / 1800));
    const chunks = splitIntoChunks(text, 12000);
    const toAnalyze = chunks.length <= 3 ? chunks : [chunks[0], chunks[Math.floor(chunks.length/2)], chunks[chunks.length-1]];

    console.log('Elemzés: ' + estPages + ' oldal, ' + toAnalyze.length + ' rész');

    const allIssues = [];
    const allPositives = [];
    const s1arr = [], s2arr = [];
    let structure = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let i = 0; i < toAnalyze.length; i++) {
      const chunk = toAnalyze[i];
      const pFrom = Math.round(i * estPages / toAnalyze.length) + 1;
      const pTo = Math.round((i+1) * estPages / toAnalyze.length);

      // LÉPÉS 1: Alap info
      try {
        const r1 = await client.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 500,
          messages: [{ role: 'user', content:
            'Szerződésrész (~' + pFrom + '-' + pTo + '. oldal). Adj alap infót.\n\n' +
            chunk.substring(0, 2000) + '\n\n' +
            'Csak ezt a JSON-t írd (TILOS ```json):\n' +
            '{"fel1_score":NUMBER,"fel2_score":NUMBER,"fel1":"fél1 neve max 30 kar","fel2":"fél2 neve max 30 kar","type":"szerz típus max 30 kar","pos1":"pozitívum max 60 kar","pos2":"pozitívum max 60 kar"}'
          }]
        });
        totalInputTokens += r1.usage.input_tokens;
        totalOutputTokens += r1.usage.output_tokens;
        const info = extractJSON(r1.content[0].text);
        if (info) {
          if (info.fel1_score) s1arr.push(info.fel1_score);
          if (info.fel2_score) s2arr.push(info.fel2_score);
          if (info.fel1 && !structure.fel1) structure = {fel1: info.fel1, fel2: info.fel2, type: info.type};
          if (info.pos1) allPositives.push({title: info.pos1, description: ''});
          if (info.pos2) allPositives.push({title: info.pos2, description: ''});
        }
      } catch(e) { console.error('Info hiba:', e.message); }

      const problemPrompt = 'Szerződésrész (~' + pFrom + '-' + pTo + '. oldal):\n\n' + chunk + '\n\n';
      const fel1n = structure.fel1 || '1. fél';
      const fel2n = structure.fel2 || '2. fél';

      // LÉPÉS 2: Átfogó elemzés – egy hívásban minden issue, az AI dönti el melyik félnek hátrányos
      try {
        const rIssues = await client.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 3000,
          messages: [{ role: 'user', content:
            'Szerződésrész (~' + pFrom + '-' + pTo + '. oldal):\n\n' + chunk + '\n\n' +
            'FELEK:\n' +
            '- ' + fel1n + ': a BEFEKTETŐ/ERŐSEBB FÉL (tőkét ad, jogokat kap)\n' +
            '- ' + fel2n + ': az ALAPÍTÓ/GYENGÉBB FÉL (tőkét kap, kötelezettségeket vállal)\n\n' +
            'SZABÁLYOK:\n' +
            '- favors:"fel1" = ' + fel1n + '-nek KEDVEZ (azaz ' + fel2n + '-nek HÁTRÁNYOS)\n' +
            '- favors:"fel2" = ' + fel2n + '-nek KEDVEZ (azaz ' + fel1n + '-nek HÁTRÁNYOS)\n' +
            '- favors:"mindketto" = mindkét félnek hátrányos\n\n' +
            'TIPIKUSAN ' + fel1n + '-nek KEDVEZŐ (favors:fel1): Drag-Along, lock-up, kényszereladás, hígulás elleni védelem csak befektetőnek, korlátozott átruházás\n' +
            'TIPIKUSAN ' + fel2n + '-nek KEDVEZŐ (favors:fel2): alacsony IRR, gyenge exit garancia, korlátozott információs jog, befektető felelőssége korlátlan\n\n' +
            'Azonosítsd a TOP 8 legsúlyosabb jogi problémát REÁLISAN – ne erőltesd mindkét félnek ugyanannyit!\n' +
            'JSON (TILOS ```json):\n' +
            '{"issues":[{' +
            '"sev":"kritikus|figyelmeztetés",' +
            '"title":"probléma neve max 60 kar",' +
            '"loc":"fejezet (~' + pFrom + '.o)",' +
            '"favors":"fel1|fel2|mindketto",' +
            '"desc":"miért probléma és kinek hátrányos, max 200 kar",' +
            '"fix":"konkrét javítás max 150 kar",' +
            '"impactA":"hatás ' + fel1n + '-re",' +
            '"impactB":"hatás ' + fel2n + '-re"' +
            '}]}'
          }]
        });
        totalInputTokens += rIssues.usage.input_tokens;
        totalOutputTokens += rIssues.usage.output_tokens;
        const resIssues = extractJSON(rIssues.content[0].text);
        if (resIssues && resIssues.issues) {
          resIssues.issues.forEach(issue => {
            if (issue && issue.title) {
              allIssues.push({
                severity: issue.sev || 'figyelmeztetés',
                title: issue.title,
                location: issue.loc || '',
                favors: issue.favors || 'mindketto',
                description: issue.desc || '',
                fix_text: issue.fix || '',
                impactA: issue.impactA || '',
                impactB: issue.impactB || ''
              });
            }
          });
        }
        console.log('Chunk ' + (i+1) + ' issues:', resIssues ? resIssues.issues.length : 0);
      } catch(e) { console.error('Issue elemzés hiba:', e.message); }

    } // for loop vége

    // Súlyozott issue számolás: kritikus=3 pont, figyelmeztetés=1 pont
    const fel1Issues = allIssues.filter(x => x.favors === 'fel2'); // fel2 javára = fel1 hátrány
    const fel2Issues = allIssues.filter(x => x.favors === 'fel1'); // fel1 javára = fel2 hátrány
    const mindkettIssues = allIssues.filter(x => x.favors === 'mindketto');

    function calcScore(issues, sharedIssues) {
      let score = 0;
      issues.forEach(i => { score += i.severity === 'kritikus' ? 3 : 1; });
      sharedIssues.forEach(i => { score += i.severity === 'kritikus' ? 1.5 : 0.5; });
      return score;
    }

    const fel1Score = calcScore(fel1Issues, mindkettIssues); // hátrányos pontok súlya fel1-nek
    const fel2Score = calcScore(fel2Issues, mindkettIssues); // hátrányos pontok súlya fel2-nek
    const totalScore = fel1Score + fel2Score || 1;

    // Védettség: minél kevesebb hátrányos pont, annál védettebb
    const avgS1 = s1arr.length ? Math.round(s1arr.reduce((a,b)=>a+b,0)/s1arr.length) : 50;
    const avgS2 = s2arr.length ? Math.round(s2arr.reduce((a,b)=>a+b,0)/s2arr.length) : 50;

    // Védettségi arány az issue-k alapján (fordított: több hátrány = alacsonyabb védettség)
    const issueBasedFel1Protection = Math.round((1 - fel1Score/totalScore) * 100);
    const issueBasedFel2Protection = Math.round((1 - fel2Score/totalScore) * 100);

    // Védettség KIZÁRÓLAG az issue-k alapján
    const finalFel1 = issueBasedFel1Protection;
    const finalFel2 = issueBasedFel2Protection;

    const topIssues = allIssues.slice(0,3).map(x=>x.title).join('; ') || 'nincs';

    const fel1IssueList = fel1Issues.slice(0,5).map(x=>x.title).join(', ') || 'nincs';
    const fel2IssueList = fel2Issues.slice(0,5).map(x=>x.title).join(', ') || 'nincs';

    const sumR = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      messages: [{ role: 'user', content:
        structure.fel1 + ' (' + fel1Issues.length + ' hátrányos pont, súly:' + fel1Score.toFixed(1) + '): ' + fel1IssueList + '\n' +
        structure.fel2 + ' (' + fel2Issues.length + ' hátrányos pont, súly:' + fel2Score.toFixed(1) + '): ' + fel2IssueList + '\n' +
        'Mindkét felet érintő: ' + mindkettIssues.length + ' pont\n\n' +
        'Feladat: Adj összefoglalót és válaszd meg a mérleget. A nyerési esélyek (p1+p2=100) TÜKRÖZZÉK a hátrányos pontok arányát!\n' +
        'Ha ' + structure.fel1 + '-nak ' + fel1Issues.length + ' hátrányos pontja van és ' + structure.fel2 + '-nak ' + fel2Issues.length + ', akkor a több hátrányos ponttal rendelkező fél p értéke ALACSONYABB legyen.\n' +
        'JSON (TILOS ```json):\n' +
        '{"verdict":"összítélet max 10 szó","p1":SZAM,"p2":SZAM,"merleg":"fel1_eros|fel2_eros|kiegyensulyozott","summary":"3 mondatos összefoglaló mindkét fél helyzetéről","j1a":"javaslat ' + (structure.fel1||'fél1') + '","j1b":"javaslat ' + (structure.fel1||'fél1') + '","j2a":"javaslat ' + (structure.fel2||'fél2') + '","j2b":"javaslat ' + (structure.fel2||'fél2') + '","a1":"legsürgősebb teendő","a2":"teendő","a3":"teendő"}'
      }]
    });
    totalInputTokens += sumR.usage.input_tokens;
    totalOutputTokens += sumR.usage.output_tokens;
    const sum = extractJSON(sumR.content[0].text) || {};

    // Deduplikáció
    function getKeywords(t) {
      return t.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    }
    function isSimilar(a, b) {
      if (a === b) return true;
      const ka = getKeywords(a), kb = getKeywords(b);
      return ka.filter(w => kb.includes(w)).length >= 2;
    }
    const dedup = allIssues.filter((x, i, arr) => {
      return !arr.slice(0, i).some(prev => isSimilar(prev.title, x.title));
    });

    const cost = estimateCost(totalInputTokens, totalOutputTokens);
    console.log('KÉSZ: s1=' + avgS1 + ' s2=' + avgS2 + ' issues=' + dedup.length + ' | ~' + cost.cost_huf + ' Ft');

    res.json({
      fel1_score: finalFel1, fel2_score: finalFel2,
      fel1_name: structure.fel1 || '1. Fél',
      fel2_name: structure.fel2 || '2. Fél',
      per_esely_fel1: sum.p1 || finalFel1,
      per_esely_fel2: sum.p2 || finalFel2,
      merleg: sum.merleg || 'kiegyensulyozott',
      score: Math.round((avgS1+avgS2)/2),
      verdict: sum.verdict || 'Az elemzés elkészült.',
      summary: sum.summary || 'Az elemzés elkészült.',
      top_actions: [sum.a1, sum.a2, sum.a3].filter(Boolean),
      fel1_javaslatok: [sum.j1a, sum.j1b].filter(Boolean),
      fel2_javaslatok: [sum.j2a, sum.j2b].filter(Boolean),
      issues: dedup.slice(0, 30),
      positives: allPositives.filter((v,i,a) => a.findIndex(x=>x.title===v.title)===i).slice(0,6),
      structure: structure,
      _pages: estPages,
      _sections: toAnalyze.length,
      _cost: cost
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
        messages: [{ role: 'user', content: 'Magyar ügyvéd. Mit kell egy "' + type + '" szerz.-be "' + favor + '" szerint.\nJSON: {"hints":[{"text":"STRING","importance":"must|rec|opt"}]}' }]
      });
      return res.json(extractJSON(r.content[0].text) || {hints:[]});
    }
    if (action === 'generate') {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 8000,
        system: 'Tapasztalt magyar ügyvéd. Készíts ' + level + ' ' + type + 't PTK alapján. Védd ' + favor + ' érdekeit. Legyen teljes!',
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
