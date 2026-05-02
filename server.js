const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

function safeParseJSON(raw) {
  if (!raw) return null;
  let c = raw
    .replace(/^```json\s*/gim, '')
    .replace(/^```\s*/gim, '')
    .replace(/```$/gim, '')
    .trim();
  const start = c.indexOf('{');
  const end = c.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  c = c.substring(start, end + 1);
  try { return JSON.parse(c); }
  catch(e) {
    try { return JSON.parse(c.replace(/,(\s*[}\]])/g, '$1')); }
    catch(e2) { 
      console.error('JSON parse hiba:', e2.message, 'raw:', c.substring(0,100));
      return null; 
    }
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'LexAI Backend running', version: '3.0' });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { text, type, perspective } = req.body;
    if (!text || text.length < 30) return res.status(400).json({ error: 'Nincs szöveg' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    const estPages = Math.max(1, Math.round(text.length / 1800));
    const CHUNK_SIZE = 14000;
    const chunks = splitIntoChunks(text, CHUNK_SIZE);
    const chunksToAnalyze = chunks.length <= 3
      ? chunks
      : [chunks[0], chunks[Math.floor(chunks.length / 2)], chunks[chunks.length - 1]];

    console.log('Elemzés: ' + estPages + ' oldal, ' + chunksToAnalyze.length + ' rész');

    const sectionPromises = chunksToAnalyze.map((chunk, idx) => {
      const pageFrom = Math.round(idx * (estPages / chunksToAnalyze.length)) + 1;
      const pageTo = Math.round((idx + 1) * (estPages / chunksToAnalyze.length));

      const prompt = 'Te egy tapasztalt magyar ügyvéd vagy 20 év tapasztalattal. Végezz ALAPOS és RÉSZLETES elemzést erről a szerződésrészről MINDKÉT FÉL szempontjából.\n\n' +
        'Ez a ' + (idx+1) + '. rész (~' + pageFrom + '-' + pageTo + '. oldal a teljes dokumentumból)\n\n' +
        'SZÖVEG:\n' + chunk + '\n\n' +
        'FELADATOD:\n' +
        '1. Találd meg az ÖSSZES problémát - ne hagyj ki semmit!\n' +
        '2. Minden problémánál pontosan idézd az eredeti szövegrészt\n' +
        '3. Magyarázd el RÉSZLETESEN miért probléma és melyik félnek kedvez\n' +
        '4. Adj KONKRÉT, beilleszthető javítási javaslatot\n' +
        '5. Jelöld meg pontosan hol van (fejezet, pont, oldal)\n' +
        '6. Vizsgáld: kötbér, késedelmi kamat, felmondás, felelősség, szavatosság, GDPR, titoktartás, fizetési feltételek, határidők, vitarendezés\n\n' +
        'FONTOS: Legyen RÉSZLETES és ALAPOS! Maximum 6 issue per rész.\n\n' +
        'Válaszolj CSAK valid JSON-ban:\n' +
        '{"issues":[{"severity":"kritikus|figyelmeztetés|info","title":"rövid cím","location":"pl. 3.2 pont (~' + pageFrom + '. oldal)","favors":"fel1|fel2|mindketto","original_text":"az eredeti szöveg idézete max 150 kar","description":"részletes magyarázat min 2-3 mondat miért probléma","fel1_impact":"hogyan érinti az 1. felet konkrétan","fel2_impact":"hogyan érinti a 2. felet konkrétan","fix_text":"KONKRÉT beilleszthető javítási szöveg","legal_ref":"PTK hivatkozás ha releváns"}],"fel1_score":NUMBER,"fel2_score":NUMBER,"positives":[{"title":"STRING","description":"STRING"}],"structure":{"type":"STRING","fel1":"STRING","fel2":"STRING","subject":"STRING"}}';

      return client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      }).then(r => {
        const raw = r.content[0].text;
        console.log('Chunk ' + (idx+1) + ' nyers:', raw.substring(0, 200));
        const parsed = safeParseJSON(raw);
        if (!parsed) {
          console.error('Chunk ' + (idx+1) + ' parse hiba');
          return { issues: [], fel1_score: 50, fel2_score: 50, positives: [] };
        }
        console.log('Chunk ' + (idx+1) + ' OK: issues=' + (parsed.issues||[]).length);
        return parsed;
      }).catch(e => {
        console.error('Chunk ' + (idx+1) + ' hiba:', e.message);
        return { issues: [], fel1_score: 50, fel2_score: 50, positives: [] };
      });
    });

    const sectionResults = await Promise.all(sectionPromises);

    let allIssues = [], allPositives = [], fel1Scores = [], fel2Scores = [], structure = {};
    for (const r of sectionResults) {
      if (r.issues) allIssues = allIssues.concat(r.issues);
      if (r.positives) allPositives = allPositives.concat(r.positives);
      if (r.fel1_score) fel1Scores.push(r.fel1_score);
      if (r.fel2_score) fel2Scores.push(r.fel2_score);
      if (r.structure && r.structure.type) structure = r.structure;
    }

    const avgFel1 = fel1Scores.length ? Math.round(fel1Scores.reduce((a,b)=>a+b,0)/fel1Scores.length) : 50;
    const avgFel2 = fel2Scores.length ? Math.round(fel2Scores.reduce((a,b)=>a+b,0)/fel2Scores.length) : 50;
    const kritikusDb = allIssues.filter(i=>i.severity==='kritikus').length;
    const topIssues = allIssues.slice(0,3).map(i=>i.title).join('; ') || 'nincs';

    const sumPrompt = 'Magyar jogi szakértő vagy. Készíts részletes összefoglalót mindkét fél szempontjából.\n' +
      'Szerződés: ' + (type||structure.type||'általános') + ', ~' + estPages + ' oldal\n' +
      '1. fél (' + (structure.fel1||'Ügyfél') + ') védelmi szintje: ' + avgFel1 + '/100\n' +
      '2. fél (' + (structure.fel2||'Szolgáltató') + ') védelmi szintje: ' + avgFel2 + '/100\n' +
      'Kritikus problémák: ' + kritikusDb + ' db. Főbb: ' + topIssues + '\n\n' +
      'Csak valid JSON, max 200 kar stringenként:\n' +
      '{"verdict":"1-2 mondatos összítélet","per_esely_fel1":NUMBER,"per_esely_fel2":NUMBER,"merleg":"fel1_eros|fel2_eros|kiegyensulyozott","summary":"4-5 mondatos részletes ügyvédi összefoglaló","fel1_javaslatok":["konkrét javaslat 1","konkrét javaslat 2","konkrét javaslat 3"],"fel2_javaslatok":["konkrét javaslat 1","konkrét javaslat 2","konkrét javaslat 3"],"top_actions":["1. LEGSÜRGŐSEBB: teendő","2. FONTOS: teendő","3. AJÁNLOTT: teendő"]}';

    const sumResp = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1200,
      messages: [{ role: 'user', content: sumPrompt }]
    });
    const summary = safeParseJSON(sumResp.content[0].text) || {};

    const seen = {};
    const dedupIssues = allIssues.filter(x => {
      const k = x.title||'';
      if(seen[k]) return false;
      seen[k]=true;
      return true;
    });

    const result = {
      fel1_score: avgFel1,
      fel2_score: avgFel2,
      fel1_name: structure.fel1 || '1. Fél (Ügyfél)',
      fel2_name: structure.fel2 || '2. Fél (Szolgáltató)',
      per_esely_fel1: summary.per_esely_fel1 || Math.round(avgFel1/(avgFel1+avgFel2)*100),
      per_esely_fel2: summary.per_esely_fel2 || Math.round(avgFel2/(avgFel1+avgFel2)*100),
      merleg: summary.merleg || 'kiegyensulyozott',
      score: Math.round((avgFel1+avgFel2)/2),
      verdict: summary.verdict || 'Az elemzés elkészült.',
      summary: summary.summary || 'Az elemzés elkészült.',
      top_actions: summary.top_actions || [],
      fel1_javaslatok: summary.fel1_javaslatok || [],
      fel2_javaslatok: summary.fel2_javaslatok || [],
      issues: dedupIssues.slice(0, 20),
      positives: allPositives.filter((v,i,a)=>a.findIndex(x=>x.title===v.title)===i).slice(0, 8),
      structure: structure,
      _pages: estPages,
      _sections: chunksToAnalyze.length
    };

    console.log('KÉSZ: fel1=' + result.fel1_score + ', fel2=' + result.fel2_score + ', issues=' + result.issues.length);
    res.json(result);

  } catch(err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const { action, type, favor, party1, party2, amount, deadline, date, level, details, special } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    if (action === 'hints') {
      const prompt = 'Magyar ügyvéd. Listázd mit kell egy "' + type + '" szerződésbe "' + favor + '" szerint.\nCsak JSON: {"hints":[{"text":"STRING","importance":"must|rec|opt"}]}\n8-10 elem.';
      const r = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] });
      return res.json(safeParseJSON(r.content[0].text) || {hints:[]});
    }

    if (action === 'generate') {
      const sys = 'Tapasztalt magyar ügyvéd vagy. Készíts ' + level + ' ' + type + 't PTK alapján. Védd ' + favor + ' érdekeit. Legyen teljes és részletes!';
      const user = 'Típus: ' + type + '\n1. Fél: ' + (party1||'1. Fél') + '\n2. Fél: ' + (party2||'2. Fél') +
        '\nÖsszeg: ' + (amount||'megállapodás szerint') + '\nHatáridő: ' + (deadline||'megállapodás szerint') +
        '\nDátum: ' + (date||new Date().toLocaleDateString('hu-HU')) +
        '\nRészletesség: ' + level + '\nTárgy: ' + details + '\nKülönleges: ' + (special||'szokásos');
      const r = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 8000, system: sys, messages: [{ role: 'user', content: user }] });
      return res.json({ contract: r.content[0].text });
    }

    res.status(400).json({ error: 'Ismeretlen action' });
  } catch(err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('LexAI szerver fut: port ' + PORT));
