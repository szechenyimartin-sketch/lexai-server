const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildPerspective(p) {
  if(!p || p.includes('kiegyensuly')) return 'mindkét fél szempontjából egyensúlyosan';
  if(p.includes('ugyfel')) return 'az ügyfél / megbízó / vásárló érdekei szerint';
  return 'az ellenérdekű fél / szolgáltató / eladó érdekei szerint';
}

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
  let c = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
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

// Determinisztikus pontozás a talált problémák alapján
function calculateScore(allIssues, allMissing, allPositives) {
  let score = 60;
  for (const issue of allIssues) {
    if (issue.severity === 'kritikus') score -= 12;
    else if (issue.severity === 'figyelmeztetés') score -= 6;
    else score -= 2;
  }
  for (const m of allMissing) {
    if (m.importance === 'kötelező') score -= 5;
    else if (m.importance === 'ajánlott') score -= 2;
  }
  return Math.max(5, Math.min(100, score));
}

app.get('/', (req, res) => {
  res.json({ status: 'LexAI Backend running', version: '2.0' });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { text, type, perspective } = req.body;
    if (!text || text.length < 30) return res.status(400).json({ error: 'Nincs szöveg' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    const estPages = Math.max(1, Math.round(text.length / 1800));
    const perspNote = buildPerspective(perspective);

    const CHUNK_SIZE = 14000;
    const chunks = splitIntoChunks(text, CHUNK_SIZE);
    const chunksToAnalyze = chunks.length <= 3
      ? chunks
      : [chunks[0], chunks[Math.floor(chunks.length / 2)], chunks[chunks.length - 1]];

    console.log('Elemzés: ' + estPages + ' oldal, ' + chunksToAnalyze.length + ' rész, nézőpont: ' + perspNote);

    const sectionPromises = chunksToAnalyze.map((chunk, idx) => {
      const pageFrom = Math.round(idx * (estPages / chunksToAnalyze.length)) + 1;
      const pageTo = Math.round((idx + 1) * (estPages / chunksToAnalyze.length));

      const prompt = 'Te egy magyar ügyvéd vagy. Elemezd ezt a szerződésrészt ' + perspNote + '.\n' +
        'Ez a ' + (idx+1) + '. rész, kb. ' + pageFrom + '-' + pageTo + '. oldal.\n\n' +
        'SZÖVEG:\n' + chunk + '\n\n' +
        'INSTRUKCIÓK:\n' +
        '1. Minden problémánál add meg PONTOSAN: fejezet száma, pont száma, becsült oldal\n' +
        '2. original_text: az eredeti problémás szöveg (max 80 kar)\n' +
        '3. fix_text: konkrét beilleszthető javított szöveg\n' +
        '4. severity szabályok: kritikus=jogvesztés/nagy anyagi kár kockázata, figyelmeztetés=egyoldalú/méltánytalan kikötés, info=pontosítandó\n' +
        '5. Max 4 issue per rész, max 120 kar stringenként\n\n' +
        'Csak valid JSON:\n' +
        '{"issues":[{"severity":"kritikus|figyelmeztetés|info","title":"STRING","location":"pl. 3.2 pont (~' + pageFrom + '. oldal)","original_text":"STRING","description":"STRING","fix_text":"STRING"}],"missing":[{"item":"STRING","importance":"kötelező|ajánlott","why":"STRING"}],"positives":["STRING"],"structure":{"type":"STRING","parties":["STRING"],"subject":"STRING"}}';

      return client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      }).then(r => {
        const raw = r.content[0].text;
        console.log('Chunk ' + (idx+1) + ' nyers:', raw.substring(0, 150));
        const parsed = safeParseJSON(raw);
        if (!parsed) {
          console.error('Chunk ' + (idx+1) + ' parse hiba');
          return { issues: [], missing: [], positives: [] };
        }
        console.log('Chunk ' + (idx+1) + ' OK: issues=' + (parsed.issues||[]).length);
        return parsed;
      }).catch(e => {
        console.error('Chunk ' + (idx+1) + ' hiba:', e.message);
        return { issues: [], missing: [], positives: [] };
      });
    });

    const sectionResults = await Promise.all(sectionPromises);

    let allIssues = [], allMissing = [], allPositives = [], structure = {};
    for (const r of sectionResults) {
      if (r.issues) allIssues = allIssues.concat(r.issues);
      if (r.missing) allMissing = allMissing.concat(r.missing);
      if (r.positives) allPositives = allPositives.concat(r.positives);
      if (r.structure && r.structure.type) structure = r.structure;
    }

    // Determinisztikus score számítás
    const finalScore = calculateScore(allIssues, allMissing, allPositives);
    const kritikusDb = allIssues.filter(i=>i.severity==='kritikus').length;
    const topIssues = allIssues.slice(0,3).map(i => i.title).join('; ') || 'nincs';

    const sumPrompt = 'Magyar jogi szakértő vagy. Rövid összefoglaló.\n' +
      'Szerződés: ' + (type||'általános') + ', ~' + estPages + ' oldal. Nézőpont: ' + perspNote + '.\n' +
      'Score: ' + finalScore + '/100. Kritikus: ' + kritikusDb + ' db. Főbb: ' + topIssues + '\n\n' +
      'Csak ezt a JSON-t írd, max 150 kar stringenként:\n' +
      '{"verdict":"STRING","perspective_note":"STRING","risk_level":"magas|közepes|alacsony","summary":"STRING","top_actions":["STRING","STRING","STRING"]}';

    const sumResp = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 800,
      messages: [{ role: 'user', content: sumPrompt }]
    });
    const summary = safeParseJSON(sumResp.content[0].text) || {};

    // Dedup
    const seen = {};
    const dedupIssues = allIssues.filter(x => {
      const k = x.title||'';
      if(seen[k]) return false;
      seen[k]=true;
      return true;
    });

    const result = {
      score: finalScore,
      verdict: summary.verdict || 'Az elemzés elkészült.',
      perspective_note: summary.perspective_note || '',
      risk_level: finalScore >= 70 ? 'alacsony' : finalScore >= 40 ? 'közepes' : 'magas',
      structure: structure,
      issues: dedupIssues.slice(0, 15),
      missing: allMissing.filter((v,i,a) => a.findIndex(x=>x.item===v.item)===i).slice(0, 10),
      positives: allPositives.filter((v,i,a) => a.indexOf(v)===i).slice(0, 6),
      summary: summary.summary || 'Az elemzés elkészült.',
      top_actions: summary.top_actions || [],
      _pages: estPages,
      _sections: chunksToAnalyze.length
    };

    console.log('KÉSZ: score=' + result.score + ', issues=' + result.issues.length + ', missing=' + result.missing.length);
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
      const prompt = 'Magyar ügyvéd. Listázd mit kell egy "' + type + '" szerződésbe "' + favor + '" szerint.\n' +
        'Csak JSON: {"hints":[{"text":"STRING","importance":"must|rec|opt"}]}\n8-10 elem.';
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
