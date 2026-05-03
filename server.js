const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// MOCK MODE – Railway-en: MOCK_MODE=true env variable beállítva
// fejlesztés közben 0 Ft API költség!
// Éles módhoz: MOCK_MODE=false vagy töröld a variable-t
// ============================================================
const MOCK_MODE = process.env.MOCK_MODE === 'true';

if (MOCK_MODE) {
  console.log('⚠️  MOCK MODE AKTÍV – Nem hív API-t, 0 Ft költség!');
} else {
  console.log('✅ ÉLES MÓD – Valódi API hívások!');
}

// ============================================================
// MOCK ADAT – realisztikus teszt válasz
// ============================================================
const MOCK_ANALYZE_RESULT = {
  fel1_score: 72,
  fel2_score: 28,
  fel1_name: 'Óbuda Uni Venture Capital Zrt.',
  fel2_name: 'Alapítók és Céltársaság',
  per_esely_fel1: 72,
  per_esely_fel2: 28,
  merleg: 'fel1_eros',
  score: 50,
  verdict: 'Strukturális egyensúlyhiány, kisebbségi jogvédelem hiányos',
  summary: 'A szerződés jelentősen a Befektető javára billen. Az Alapítók kisebbségi jogai nincsenek megfelelően védve, és több kritikus klauzula hiányzik. Az ESOP kezelése jogilag tisztázatlan, ami komoly kockázatot jelent mindkét félnek.',
  top_actions: [
    'ESOP keretszerződés megalkotása (conversion ratio, vesting, voting)',
    'Drag-Along küszöb minimum 80%-ra emelése',
    'Kisebbségi vétójogok explicit rögzítése az alapdokumentumokban'
  ],
  fel1_javaslatok: [
    'ESOP pool explicit elkülönítése alapító szavazati hígulás nélkül, külön részvényosztály',
    'Preferred Return minimum 2x biztosítása exit esetén likviditási sorrendben'
  ],
  fel2_javaslatok: [
    'Drag-Along minimálár küszöb (bekerülési érték 80%-a) Súlyos Szerződésszegés esetén is',
    'Tag-Along jog 100%-os részvételre minden exit tranzakcióban piaci áron'
  ],
  issues: [
    {
      severity: 'kritikus',
      title: 'ESOP részesedés jogi státusza tisztázatlan',
      location: '4.4.2 Tulajdonosi szerkezet (~3. oldal)',
      favors: 'mindketto',
      description: 'Az ESOP részesedések (2x6,6%=13,2%) nincsenek külön jogosulthoz rendelve, de az Alapítók tulajdonaként jelennek meg, miközben ezek alkalmazotti opciós programhoz tartoznak. Tisztázatlan, hogy ezek tényleges szavazati jogot biztosítanak-e az Alapítóknak vagy csak kezelői pozícióban vannak.',
      fix_text: 'Külön ESOP megállapodás készítése, amely rögzíti: ESOP részesedések nem adnak szavazati jogot az Alapítóknak azok átruházásáig/megszerzéséig a jogosultak által; vagy az ESOP részesedések elkülönített letéti konstrukcióban kerülnek kezelésre trustee által.',
      impactA: 'Ha az Alapítók szavazhatnak ezekkel, akkor 46,6%-os szavazati erejük van egyenként (vs 20% Befektető), ami jelentősen megváltoztatja az erőviszonyokat.',
      impactB: 'A Befektető 20%-os kisebbségi pozíciója elveszíti védelmét ha az ESOP szavazati jogként funkcionál az Alapítók kezében.'
    },
    {
      severity: 'kritikus',
      title: 'Minimális exit garancia hiánya',
      location: '6.2.5 hivatkozás (~5. oldal)',
      favors: 'fel2',
      description: 'Az Exit Esemény, Befektetői Exit Összeg, Minimum Elvárt Hozam és Hozamráta kulcsfogalmak csak hivatkozva vannak, de nincs definiálva az Alapítók kötelező visszavásárlási vagy likviditási garanciája. Az 5 éves exit szándék nem kötelezettség.',
      fix_text: 'Exit garancia klauzula beépítése: ha 5 éven belül nem történik exit, az Alapítók kötelesek a Befektető részesedését visszavásárolni a bekerülési érték 150%-án, vagy drag-along jogot biztosítani automatikusan.',
      impactA: 'A Befektető nem tudja kikényszeríteni az exitét, ami a tőkéje bennragadásához vezethet határozatlan időre.',
      impactB: 'Az Alapítók számára ez kedvező, de hosszú távon csökkenti a befektetői bizalmat és nehezíti a következő finanszírozási kört.'
    },
    {
      severity: 'kritikus',
      title: 'Drag-Along küszöb túl alacsony',
      location: '7.3 Drag-Along jog (~7. oldal)',
      favors: 'fel1',
      description: 'A Drag-Along jog 51%-os küszöbön aktiválódik, ami azt jelenti, hogy a Befektető és bármely Alapító együtt kényszereladást kezdeményezhet az összes többi részvényes számára. Ez az Alapítók számára komoly kockázat.',
      fix_text: 'Drag-Along küszöb minimum 75-80%-ra emelése, és minimálár garanciával kombinálva (bekerülési érték legalább 100%-a). Alapítói vétójog biztosítása ha az ár nem éri el a küszöböt.',
      impactA: 'Jelenlegi formában a Befektető viszonylag könnyen kierőszakolhat egy számára kedvező de az Alapítóknak esetleg kedvezőtlen exitot.',
      impactB: 'Az Alapítók elveszíthetik a vállalatot egy kényszereladásban a befektetett munkájuk teljes megtérülése előtt.'
    },
    {
      severity: 'figyelmeztetés',
      title: 'Vesting ütemezés nem részletezett',
      location: '4.3 ESOP (~3. oldal)',
      favors: 'mindketto',
      description: 'Az ESOP program vesting ütemezése (cliff, vest periódus, gyorsítási feltételek) nincs részletezve a szerződésben, csak utalás van rá. Ez vitás helyzetet teremthet kilépő alkalmazottak esetén.',
      fix_text: 'ESOP szabályzat mellékletként csatolása: 1 éves cliff, 4 éves lineáris vesting, double-trigger gyorsítás M&A esetén az Alapítók és kulcsalkalmazottak részére.',
      impactA: 'Hiányos vesting szabályok esetén a Befektető nem tudja megvédeni a részvényes értékét kulcsember kilépésekor.',
      impactB: 'Az Alapítók sem védettek ha vitás a vesting – munkaügyi per kockázata nő.'
    },
    {
      severity: 'figyelmeztetés',
      title: 'Információs jogok korlátozottak',
      location: '8.1 Jelentéstétel (~8. oldal)',
      favors: 'fel1',
      description: 'A Befektető negyedéves pénzügyi jelentést kap, de nincs joga rendkívüli eseményekről (pl. kulcsember kilépés, szerződésvesztés >10% árbevétel) azonnali értesítést kapni.',
      fix_text: 'Material Adverse Change (MAC) értesítési kötelezettség beépítése: 5 munkanapon belül értesítés minden olyan eseményről, amely az árbevétel >10%-át vagy a cég értékét >15%-kal érinti.',
      impactA: 'A Befektető késve értesül kritikus eseményekről, ami csökkenti beavatkozási lehetőségét.',
      impactB: 'Az Alapítókra adminisztratív terhet ró, de növeli a befektetői bizalmat és könnyíti a következő kört.'
    }
  ],
  positives: [
    { title: 'Részletes anti-dilúciós védelem (weighted average)', description: '' },
    { title: 'Board megfigyelői jog biztosított a Befektetőnek', description: '' },
    { title: 'Egyértelmű szavazati jogok dokumentálva', description: '' },
    { title: 'Confidentialitási kötelezettség kölcsönös', description: '' }
  ],
  structure: {
    fel1: 'Óbuda Uni Venture Capital Zrt.',
    fel2: 'Alapítók és Céltársaság',
    type: 'Befektetési szerződés'
  },
  _pages: 12,
  _sections: 3,
  _mock: true  // jelzi hogy ez mock adat
};

const MOCK_GENERATE_HINTS = {
  hints: [
    { text: 'Fizetési határidő és késedelmi kamat mértéke (Ptk. 6:155§)', importance: 'must' },
    { text: 'Teljesítési hely és átvétel módja', importance: 'must' },
    { text: 'Szavatossági és jótállási feltételek', importance: 'must' },
    { text: 'Felmondási feltételek és felmondási idő', importance: 'rec' },
    { text: 'Vis maior klauzula és értelmezése', importance: 'rec' },
    { text: 'Titoktartási kötelezettség és időtartama', importance: 'rec' },
    { text: 'Vitarendezés módja (választottbíróság/rendes bíróság)', importance: 'opt' },
    { text: 'Szerződés módosításának feltételei', importance: 'opt' }
  ]
};

// ============================================================
// HELPER FUNKCIÓK
// ============================================================
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

// Token becslő és költség kalkulátor
function estimateCost(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1000000) * 3.0;   // Sonnet: $3/1M input
  const outputCost = (outputTokens / 1000000) * 15.0; // Sonnet: $15/1M output
  const totalUsd = inputCost + outputCost;
  const totalHuf = totalUsd * 370; // kb. árfolyam
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: Math.round(totalUsd * 10000) / 10000,
    cost_huf: Math.round(totalHuf)
  };
}

// ============================================================
// ROUTES
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'LexAI Backend running',
    version: '6.0',
    mock_mode: MOCK_MODE
  });
});

// ============================================================
// ELEMZÉS
// ============================================================
app.post('/api/analyze', async (req, res) => {
  try {
    const { text, type } = req.body;
    if (!text || text.length < 30) return res.status(400).json({ error: 'Nincs szöveg' });

    // MOCK MODE
    if (MOCK_MODE) {
      console.log('MOCK: analyze kérés, ' + text.length + ' karakter szöveg');
      await new Promise(r => setTimeout(r, 1500)); // szimulált késleltetés
      return res.json(MOCK_ANALYZE_RESULT);
    }

    // ÉLES MÓD
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

      // LÉPÉS 2: Problémák egyenként
      const problemPrompt = 'Szerződésrész (~' + pFrom + '-' + pTo + '. oldal):\n\n' + chunk + '\n\n';

      for (let n = 1; n <= 2; n++) {
        try {
          const rN = await client.messages.create({
            model: 'claude-sonnet-4-5',
            max_tokens: 600,
            messages: [{ role: 'user', content:
              problemPrompt +
              'Add meg a ' + n + '. legsúlyosabb jogi problémát (ha van).\n' +
              'Csak ezt a JSON-t írd (TILOS ```json, max 120 kar/érték):\n' +
              '{"van":true,"sev":"kritikus|figyelmeztetés|info","title":"probléma neve","loc":"fejezet/pont (~' + pFrom + '.o)","favors":"fel1|fel2|mindketto","desc":"miért probléma","fix":"konkrét javítás","impactA":"hatás 1. félre","impactB":"hatás 2. félre"}\n' +
              'Ha nincs ' + n + '. probléma: {"van":false}'
            }]
          });
          totalInputTokens += rN.usage.input_tokens;
          totalOutputTokens += rN.usage.output_tokens;
          const issue = extractJSON(rN.content[0].text);
          console.log('Chunk ' + (i+1) + ' issue' + n + ':', JSON.stringify(issue));
          if (issue && issue.van && issue.title) {
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
        } catch(e) { console.error('Issue' + n + ' hiba:', e.message); }
      }
    }

    const avgS1 = s1arr.length ? Math.round(s1arr.reduce((a,b)=>a+b,0)/s1arr.length) : 50;
    const avgS2 = s2arr.length ? Math.round(s2arr.reduce((a,b)=>a+b,0)/s2arr.length) : 50;
    const topIssues = allIssues.slice(0,3).map(x=>x.title).join('; ') || 'nincs';

    // Összefoglaló
    const sumR = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      messages: [{ role: 'user', content:
        '1.fél:' + (structure.fel1||'Ügyfél') + ' ' + avgS1 + '/100. 2.fél:' + (structure.fel2||'Szolgáltató') + ' ' + avgS2 + '/100.\n' +
        'Problémák:' + topIssues + '\n' +
        'Csak ezt a JSON-t írd (TILOS ```json, max 100 kar/érték):\n' +
        '{"verdict":"összítélet","p1":NUMBER,"p2":NUMBER,"merleg":"fel1_eros|fel2_eros|kiegyensulyozott","summary":"3 mondatos összefoglaló","j1a":"javaslat fél1","j1b":"javaslat fél1","j2a":"javaslat fél2","j2b":"javaslat fél2","a1":"teendő","a2":"teendő","a3":"teendő"}'
      }]
    });
    totalInputTokens += sumR.usage.input_tokens;
    totalOutputTokens += sumR.usage.output_tokens;
    const sum = extractJSON(sumR.content[0].text) || {};

    const seen = {};
    const dedup = allIssues.filter(x => {
      if(seen[x.title]) return false; seen[x.title]=true; return true;
    });

    const cost = estimateCost(totalInputTokens, totalOutputTokens);
    console.log('KÉSZ: s1=' + avgS1 + ' s2=' + avgS2 + ' issues=' + dedup.length + ' | Költség: ~' + cost.cost_huf + ' Ft ($' + cost.cost_usd + ')');

    const result = {
      fel1_score: avgS1,
      fel2_score: avgS2,
      fel1_name: structure.fel1 || '1. Fél (Ügyfél)',
      fel2_name: structure.fel2 || '2. Fél (Szolgáltató)',
      per_esely_fel1: sum.p1 || Math.round(avgS1/(avgS1+avgS2)*100),
      per_esely_fel2: sum.p2 || Math.round(avgS2/(avgS1+avgS2)*100),
      merleg: sum.merleg || 'kiegyensulyozott',
      score: Math.round((avgS1+avgS2)/2),
      verdict: sum.verdict || 'Az elemzés elkészült.',
      summary: sum.summary || 'Az elemzés elkészült.',
      top_actions: [sum.a1, sum.a2, sum.a3].filter(Boolean),
      fel1_javaslatok: [sum.j1a, sum.j1b].filter(Boolean),
      fel2_javaslatok: [sum.j2a, sum.j2b].filter(Boolean),
      issues: dedup.slice(0, 15),
      positives: allPositives.filter((v,i,a) => a.findIndex(x=>x.title===v.title)===i).slice(0,6),
      structure: structure,
      _pages: estPages,
      _sections: toAnalyze.length,
      _cost: cost  // token számláló megjelenik a válaszban
    };

    res.json(result);

  } catch(err) {
    console.error('Hiba:', err.message);
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

// ============================================================
// SZERZŐDÉS GENERÁLÁS
// ============================================================
app.post('/api/generate', async (req, res) => {
  try {
    const { action, type, favor, party1, party2, amount, deadline, date, level, details, special } = req.body;

    // MOCK MODE
    if (MOCK_MODE) {
      console.log('MOCK: generate kérés, action=' + action);
      await new Promise(r => setTimeout(r, 800));
      if (action === 'hints') return res.json(MOCK_GENERATE_HINTS);
      if (action === 'generate') return res.json({
        contract: `VÁLLALKOZÁSI SZERZŐDÉS\n\n[MOCK MINTA - Ez teszt adat, nem valódi szerződés]\n\nAMELY LÉTREJÖTT\n\n${party1 || '1. Fél (Megrendelő)'} (székhelye: ..., cégjegyzékszáma: ...)\nmint Megrendelő\n\nés\n\n${party2 || '2. Fél (Vállalkozó)'} (székhelye: ..., cégjegyzékszáma: ...)\nmint Vállalkozó\n\nközött az alábbi feltételekkel:\n\n1. A SZERZŐDÉS TÁRGYA\nA Vállalkozó vállalja, hogy elvégzi: ${details || 'a meghatározott feladatot'}\n\n2. ELLENSZOLGÁLTATÁS\nA Megrendelő a teljesítésért ${amount || 'a felek által megállapított összeget'} fizet.\n\n3. TELJESÍTÉSI HATÁRIDŐ\n${deadline || 'A felek által külön meghatározandó időpontig.'}\n\n4. VEGYES RENDELKEZÉSEK\nJelen szerződésre a Polgári Törvénykönyvről szóló 2013. évi V. törvény rendelkezései az irányadók.\n\nKelt: ${date || new Date().toLocaleDateString('hu-HU')}\n\n_____________________          _____________________\n${party1 || 'Megrendelő'}                    ${party2 || 'Vállalkozó'}`,
        _mock: true
      });
    }

    // ÉLES MÓD
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    if (action === 'hints') {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content:
          'Magyar ügyvéd. Mit kell egy "' + type + '" szerz.-be "' + favor + '" szerint.\n' +
          'JSON: {"hints":[{"text":"STRING","importance":"must|rec|opt"}]}'
        }]
      });
      return res.json(extractJSON(r.content[0].text) || {hints:[]});
    }

    if (action === 'generate') {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 8000,
        system: 'Tapasztalt magyar ügyvéd. Készíts ' + level + ' ' + type + 't PTK alapján. Védd ' + favor + ' érdekeit. Legyen teljes, konkrét Ptk. hivatkozásokkal!',
        messages: [{ role: 'user', content:
          'Típus:' + type + '\n' +
          '1. Fél:' + (party1||'1. Fél') + '\n' +
          '2. Fél:' + (party2||'2. Fél') + '\n' +
          'Összeg:' + (amount||'megállapodás szerint') + '\n' +
          'Határidő:' + (deadline||'megállapodás szerint') + '\n' +
          'Dátum:' + (date||new Date().toLocaleDateString('hu-HU')) + '\n' +
          'Részletesség:' + level + '\n' +
          'Tárgy:' + details + '\n' +
          'Különleges:' + (special||'szokásos')
        }]
      });
      const cost = estimateCost(r.usage.input_tokens, r.usage.output_tokens);
      console.log('Generálás kész. Költség: ~' + cost.cost_huf + ' Ft');
      return res.json({ contract: r.content[0].text, _cost: cost });
    }

    res.status(400).json({ error: 'Ismeretlen action' });

  } catch(err) {
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('LexAI szerver fut: port ' + PORT));
