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
  let c = raw.replace(/```json/g, '').replace(/```/g, '').trim();
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

app.get('/', (req, res) => {
  res.json({ status: 'LexAI Backend running', version: '3.0' });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { text, type } = req.body;
    if (!text || text.length < 30) return res.status(400).json({ error: 'Nincs szöveg' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API kulcs hiányzik' });

    const estPages = Math.max(1, Math.round(text.length / 1800));
    const chunks = splitIntoChunks(text, 12000);
    const toAnalyze = chunks.length <= 3 ? chunks : [chunks[0], chunks[Math.floor(chunks.length/2)], chunks[chunks.length-1]];

    console.log('Elemzés: ' + estPages + ' oldal, ' + toAnalyze.length + ' rész');

    // SZEKVENCIÁLIS - nem párhuzamos!
    const results = [];
    for (let i = 0; i < toAnalyze.length; i++) {
      const chunk = toAnalyze[i];
      const pFrom = Math.round(i * estPages / toAnalyze.length) + 1;
      const pTo = Math.round((i+1) * estPages / toAnalyze.length);

      try {
        const r = await client.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 1500,
          messages: [{ role: 'user', content:
            'Magyar ügyvéd. Elemezd mindkét fél szempontjából. ' +
            'Rész: ' + (i+1) + '/' + toAnalyze.length + ' (~' + pFrom + '-' + pTo + '. oldal)\n\n' +
            'SZÖVEG:\n' + chunk + '\n\n' +
            'JSON (max 3 issue, max 80 kar/string, TILOS ```json):\n' +
            '{"i":[{"s":"k","t":"cím","l":"hely (~' + pFrom + '.o)","f":"fel1","d":"ok","fix":"javítás"}],"s1":50,"s2":50,"p":[{"t":"pos","d":"ok"}],"st":{"ty":"típus","f1":"fél1","f2":"fél2"}}'
          }]
        });
        const parsed = safeParseJSON(r.content[0].text);
        console.log('Chunk ' + (i+1) + ': issues=' + (parsed && parsed.i ? parsed.i.length : 0));
        if (parsed) results.push(parsed);
      } catch(e) {
        console.error('Chunk ' + (i+1) + ' hiba:', e.message);
      }
    }

    let allIssues = [], allPos = [], s1 = [], s2 = [], struct = {};
    for (const r of results) {
      if (r.i) allIssues = allIssues.concat(r.i.map(function(x) { return {
        severity: x.s==='k'?'kritikus':x.s==='f'?'figyelmeztetés':'info',
        title: x.t, location: x.l, favors: x.f,
        description: x.d, fix_text: x.fix
      };}));
      if (r.p) allPos = allPos.concat(r.p.map(function(x){return {title:x.t,description:x.d};}));
      if (r.s1) s1.push(r.s1);
      if (r.s2) s2.push(r.s2);
      if (r.st && r.st.ty) struct = {type:r.st.ty, fel1:r.st.f1, fel2:r.st.f2};
    }

    const avgS1 = s1.length ? Math.round(s1.reduce((a,b)=>a+b,0)/s1.length) : 50;
    const avgS2 = s2.length ? Math.round(s2.reduce((a,b)=>a+b,0)/s2.length) : 50;
    const topIssues = allIssues.slice(0,3).map(function(i){return i.title;}).join('; ') || 'nincs';

    const sumR = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      messages: [{ role: 'user', content:
        'Jogi összefoglaló. 1. fél:' + (struct.fel1||'Ügyfél') + ' ' + avgS1 + '/100. 2. fél:' + (struct.fel2||'Szolgáltató') + ' ' + avgS2 + '/100. Problémák:' + topIssues + '\n' +
        'JSON (TILOS ```json, max 100 kar/string):\n' +
        '{"v":"összítélet","p1":NUMBER,"p2":NUMBER,"m":"fel1_eros|fel2_eros|kiegyensulyozott","s":"összefoglaló","j1":["jav1","jav2"],"j2":["jav1","jav2"],"a":["teen1","teen2","teen3"]}'
      }]
    });
    const sum = safeParseJSON(sumR.content[0].text) || {};

    const seen = {};
    const dedup = allIssues.filter(function(x){
      if(seen[x.title]) return false;
      seen[x.title]=true; return true;
    });

    const result = {
      fel1_score: avgS1, fel2_score: avgS2,
      fel1_name: struct.fel1 || '1. Fél (Ügyfél)',
      fel2_name: struct.fel2 || '2. Fél (Szolgáltató)',
      per_esely_fel1: sum.p1 || Math.round(avgS1/(avgS1+avgS2)*100),
      per_esely_fel2: sum.p2 || Math.round(avgS2/(avgS1+avgS2)*100),
      merleg: sum.m || 'kiegyensulyozott',
      score: Math.round((avgS1+avgS2)/2),
      verdict: sum.v || 'Az elemzés elkészült.',
      summary: sum.s || 'Az elemzés elkészült.',
      top_actions: sum.a || [],
      fel1_javaslatok: sum.j1 || [],
      fel2_javaslatok: sum.j2 || [],
      issues: dedup.slice(0,15),
      positives: allPos.filter(function(v,i,a){return a.findIndex(function(x){return x.title===v.title;})=== i;}).slice(0,6),
      structure: struct,
      _pages: estPages,
      _sections: toAnalyze.length
    };

    console.log('KÉSZ: s1=' + result.fel1_score + ' s2=' + result.fel2_score + ' issues=' + result.issues.length);
    res.json(result);

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
      const r = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 2000, messages: [{ role: 'user', content: 'Magyar ügyvéd. Mit kell egy "' + type + '" szerz.-be "' + favor + '" szerint.\nJSON: {"hints":[{"text":"STRING","importance":"must|rec|opt"}]}' }] });
      return res.json(safeParseJSON(r.content[0].text) || {hints:[]});
    }

    if (action === 'generate') {
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: 8000,
        system: 'Tapasztalt magyar ügyvéd. Készíts ' + level + ' ' + type + 't PTK alapján. Védd ' + favor + ' érdekeit. Legyen teljes!',
        messages: [{ role: 'user', content: 'Típus:' + type + '\n1. Fél:' + (party1||'1. Fél') + '\n2. Fél:' + (party2||'2. Fél') + '\nÖsszeg:' + (amount||'megállapodás szerint') + '\nHatáridő:' + (deadline||'megállapodás szerint') + '\nDátum:' + (date||new Date().toLocaleDateString('hu-HU')) + '\nRészletesség:' + level + '\nTárgy:' + details + '\nKülönleges:' + (special||'szokásos') }]
      });
      return res.json({ contract: r.content[0].text });
    }

    res.status(400).json({ error: 'Ismeretlen action' });
  } catch(err) {
    console.error('Generate hiba:', err.message);
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('LexAI szerver fut: port ' + PORT));
