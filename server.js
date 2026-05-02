const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function parseJSON(raw) {
  if (!raw) return {};
  let c = raw
    .replace(/^```json\s*/gim, '')
    .replace(/^```\s*/gim, '')
    .replace(/```$/gim, '')
    .trim();
  const start = c.indexOf('{');
  if (start < 0) return {};
  c = c.substring(start);
  const end = c.lastIndexOf('}');
  if (end >= 0) c = c.substring(0, end + 1);
  try { return JSON.parse(c); } catch(e) {
    try {
      c = c.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
      let op=0, cl=0;
      for(const ch of c){ if(ch==='{')op++; if(ch==='}')cl++; }
      for(let i=0;i<op-cl;i++) c+='}';
      return JSON.parse(c);
    } catch(e2) {
      console.error('parseJSON hiba:', e2.message);
      return {};
    }
  }
}

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

    const CHUNK_SIZE = 12000;
    const chunks = splitIntoChunks(text, CHUNK_SIZE);
    const chunksToAnalyze = chunks.length <= 3
      ? chunks
      : [chunks[0], chunks[Math.floor(chunks.length / 2)], chunks[chunks.length - 1]];

    console.log(`Elemzés: ${estPages} oldal, ${chunksToAnalyze.length} rész, nézőpont: ${perspNote}`);

    const sectionPromises = chunksToAnalyze.map((chunk, idx) => {
      const pageFrom = Math.round(idx * (estPages / chunksToAnalyze.length)) + 1;
      const pageTo = Math.round((idx + 1) * (estPages / chunksToAnalyze.length));

      const prompt = 'Magyar ügyvéd vagy. Elemezd ezt a szerződésrészt.\n' +
        'Nézőpont: ' + perspNote + '\n' +
        'Rész: ' + (idx+1) + '/' + chunksToAnalyze.length + ' (~' + pageFrom + '-' + pageTo + '. oldal)\n\n' +
        'SZÖVEG:\n' + chunk + '\n\n' +
        'Válaszolj CSAK valid JSON-ban, tömören, max 5 issue:\n' +
        '{"score":65,"issues":[{"severity":"kritikus","title":"cím","location":"fejezet","description":"1-2 mondat","legal_ref":"PTK §","fix_text":"javítás"}],"missing":[{"item":"hiányzó","importance":"kötelező","why":"ok"}],"positives":["pozitívum"],"structure":{"type":"típus","parties":["felek"],"subject":"tárgy"}}';

      return client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      }).then(r => {
        const raw = r.content[0].text;
        console.log('Chunk ' + (idx+1) + ' raw:', raw.substring(0, 200));
        const parsed = parseJSON(raw);
        console.log('Chunk ' + (idx+1) + ' kész: issues=' + (parsed.issues||[]).length);
        return parsed;
      }).catch(e => {
        console.error('Chunk ' + (idx+1) + ' hiba:', e.message);
        return { score: 50, issues: [], missing: [], positives: [] };
      });
    });

    const sectionResults = await Promise.all(sectionPromises);

    let allIssues = [], allMissing = [], allPositives = [], scores = [], structure = {};
    for (const r of sectionResults) {
      if (r.score) scores.push(r.score);
      if (r.issues) allIssues = allIssues.concat(r.issues);
      if (r.missing) allMissing = allMissing.concat(r.missing);
      if (r.positives) allPositives = allPositives.concat(r.positives);
      if (r.structure && r.structure.type) structure = r.structure;
    }

    const avgScore = scores.length ? Math.round(scores.reduce((a,b) => a+b, 0) / scores.length) : 50;
    const topIssues = allIssues.slice(0,5).map(i => i.title).join(', ') || 'nincs';

    const sumPrompt = 'Magyar jogi szakértő. Összefoglaló.\n' +
      'Szerződés: ' + (type || structure.type || 'ismeretlen') + ', ~' + estPages + ' oldal\n' +
      'Nézőpont: ' + perspNote + '\n' +
      'Kritikus problémák: ' + allIssues.filter(i=>i.severity==='kritikus').length + ' db\n' +
      'Főbb problémák: ' + topIssues + '\n\n' +
      'Válaszolj CSAK JSON-ban:\n' +
      '{"verdict":"1 mondatos","perspective_note":"mit jelent","recommendation":"aláírható-e","risk_level":"magas|közepes|alacsony","summary":"3-4 mondat","top_actions":["1. teendő","2. teendő","3. teendő"]}';

    const sumResp = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: sumPrompt }]
    });
    const summary = parseJSON(sumResp.content[0].text);

    const seen = {};
    const dedupIssues = allIssues.filter(x => { const k = x.title||''; if(seen[k]) return false; seen[k]=true; return true; });
    const seenM = {};
    const dedupMissing = allMissing.filter(x => { const k = x.item||x||''; if(seenM[k]) return false; seenM[k]=true; return true; });

    const result = {
      score: summary.score || avgScore,
      verdict: summary.verdict || 'Az elemzés elkészült.',
      perspective_note: summary.perspective_note || '',
      recommendation: summary.recommendation || '',
      risk_level: summary.risk_level || 'közepes',
      structure,
      issues: dedupIssues.slice(0, 25),
      missing: dedupMissing.slice(0, 15),
      positives: allPositives.filter((v,i,a) => a.indexOf(v)===i).slice(0, 8),
      summary: summary.summary || 'Az elemzés elkészült.',
      top_actions: summary.top_actions || [],
      _pages: estPages,
      _sections: chunksToAnalyze.length
    };

    console.log('Kész: score=' + result.score + ', issues=' + result.issues.length);
    res.json(result);

  } catch(err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const { action, type, favor, party1, party2, amount, deadline, date, level, details, special } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    if (action === 'hints') {
      const prompt = 'Magyar ügyvéd. Listázd mit kell egy "' + type + '" szerződésbe belerakni "' + favor + '" érdekei szerint.\n' +
        'Válaszolj CSAK JSON-ban: {"hints":[{"text":"kikötés","importance":"must|rec|opt"}]}\n' +
        'Legalább 8-10 elem.';
      const r = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] });
      return res.json(parseJSON(r.content[0].text));
    }

    if (action === 'generate') {
      const sys = 'Te egy tapasztalt magyar ügyvéd vagy. Készíts ' + level + ' ' + type + 't PTK alapján. Védd ' + favor + ' érdekeit.\n' +
        'KÖTELEZŐ: fejléc, preambulum, fogalommeghatározások, tárgy, ellenérték+fizetés, teljesítés+határidők, felek kötelezettségei, szavatosság (PTK 6:159§), felelősség (PTK 6:152§), kötbér (PTK 6:185§), késedelmi kamat (PTK 6:155§), titoktartás+GDPR, felmondás (PTK 6:212§), vis maior, vitarendezés, vegyes rendelkezések, aláírási blokk.\n' +
        'Legyen TELJES és RÉSZLETES! Csak a szerződés szövegét add vissza!';

      const user = 'Típus: ' + type + '\n1. Fél: ' + (party1||'1. Fél') + '\n2. Fél: ' + (party2||'2. Fél') + '\nÖsszeg: ' + (amount||'megállapodás szerint') + '\nHatáridő: ' + (deadline||'megállapodás szerint') + '\nDátum: ' + (date||new Date().toLocaleDateString('hu-HU')) + '\nRészletesség: ' + level + '\nTárgy: ' + details + '\nKülönleges kikötések: ' + (special||'szokásos kikötések');

      const r = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 8000, system: sys, messages: [{ role: 'user', content: user }] });
      return res.json({ contract: r.content[0].text });
    }

    res.status(400).json({ error: 'Ismeretlen action' });
  } catch(err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('LexAI szerver fut: port ' + PORT));
