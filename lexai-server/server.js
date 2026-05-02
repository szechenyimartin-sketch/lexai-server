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
  res.json({ status: 'LexAI Backend running', version: '4.0' });
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

    const allIssues = [];
    const allPos = [];
    const s1arr = [], s2arr = [];
    let struct = {};

    for (let i = 0; i < toAnalyze.length; i++) {
      const chunk = toAnalyze[i];
      const pFrom = Math.round(i * estPages / toAnalyze.length) + 1;
      const pTo = Math.round((i+1) * estPages / toAnalyze.length);

      // Egyetlen kis JSON objektum per hívás - soha nem csonkul
      try {
        const r = await client.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 1000,
          messages: [{ role: 'user', content:
            'Magyar ügyvéd. Elemezd ezt a szerződésrészt (~' + pFrom + '-' + pTo + '. oldal).\n\n' +
            chunk + '\n\n' +
            'Válaszolj egyetlen kis JSON objektummal (TILOS ```json, max 80 kar/érték):\n' +
            '{"fel1_score":NUMBER,"fel2_score":NUMBER,"fel1":"1.fél neve","fel2":"2.fél neve","type":"szerz.típus","subject":"tárgy",' +
            '"issue1_sev":"kritikus|figyelmeztetés|info","issue1_title":"cím","issue1_loc":"hely","issue1_favors":"fel1|fel2","issue1_desc":"leírás","issue1_fix":"javítás",' +
            '"issue2_sev":"","issue2_title":"","issue2_loc":"","issue2_favors":"","issue2_desc":"","issue2_fix":"",' +
            '"issue3_sev":"","issue3_title":"","issue3_loc":"","issue3_favors":"","issue3_desc":"","issue3_fix":"",' +
            '"pos1":"pozitívum 1","pos2":"pozitívum 2"}'
          }]
        });

        const parsed = safeParseJSON(r.content[0].text);
        if (!parsed) {
          console.error('Chunk ' + (i+1) + ' parse hiba');
          continue;
        }

        if (parsed.fel1_score) s1arr.push(parsed.fel1_score);
        if (parsed.fel2_score) s2arr.push(parsed.fel2_score);
        if (parsed.fel1 && !struct.fel1) struct = {type: parsed.type, fel1: parsed.fel1, fel2: parsed.fel2, subject: parsed.subject};

        // Issues kinyerése
        for (let n = 1; n <= 3; n++) {
          const sev = parsed['issue'+n+'_sev'];
          const title = parsed['issue'+n+'_title'];
          if (sev && title && title.length > 2) {
            allIssues.push({
              severity: sev,
              title: title,
              location: parsed['issue'+n+'_loc'] || '',
              favors: parsed['issue'+n+'_favors'] || 'mindketto',
              description: parsed['issue'+n+'_desc'] || '',
              fix_text: parsed['issue'+n+'_fix'] || ''
            });
          }
        }

        if (parsed.pos1) allPos.push({title: parsed.pos1, description: ''});
        if (parsed.pos2) allPos.push({title: parsed.pos2, description: ''});

        console.log('Chunk ' + (i+1) + ' OK: ' + allIssues.length + ' issue eddig');

      } catch(e) {
        console.error('Chunk ' + (i+1) + ' hiba:', e.message);
      }
    }

    const avgS1 = s1arr.length ? Math.round(s1arr.reduce((a,b)=>a+b,0)/s1arr.length) : 50;
    const avgS2 = s2arr.length ? Math.round(s2arr.reduce((a,b)=>a+b,0)/s2arr.length) : 50;
    const topIssues = allIssues.slice(0,3).map(function(i){return i.title;}).join('; ') || 'nincs';

    const sumR = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      messages: [{ role: 'user', content:
        'Jogi összefoglaló. 1.fél:' + (struct.fel1||'Ügyfél') + ' ' + avgS1 + '/100. 2.fél:' + (struct.fel2||'Szolgáltató') + ' ' + avgS2 + '/100. Főbb problémák:' + topIssues + '\n' +
        'JSON (TILOS ```json, max 120 kar/érték):\n' +
        '{"verdict":"összítélet","p1":NUMBER,"p2":NUMBER,"merleg":"fel1_eros|fel2_eros|kiegyensulyozott","summary":"összefoglaló","j1a":"javaslat 1 fél 1","j1b":"javaslat 2 fél 1","j1c":"javaslat 3 fél 1","j2a":"javaslat 1 fél 2","j2b":"javaslat 2 fél 2","j2c":"javaslat 3 fél 2","a1":"teendő 1","a2":"teendő 2","a3":"teendő 3"}'
      }]
    });

    const sum = safeParseJSON(sumR.content[0].text) || {};

    const seen = {};
    const dedup = allIssues.filter(function(x){
      if(seen[x.title]) return false;
      seen[x.title]=true; return true;
    });

    const result = {
      fel1_score: avgS1,
      fel2_score: avgS2,
      fel1_name: struct.fel1 || '1. Fél (Ügyfél)',
      fel2_name: struct.fel2 || '2. Fél (Szolgáltató)',
      per_esely_fel1: sum.p1 || Math.round(avgS1/(avgS1+avgS2)*100),
      per_esely_fel2: sum.p2 || Math.round(avgS2/(avgS1+avgS2)*100),
      merleg: sum.merleg || 'kiegyensulyozott',
      score: Math.round((avgS1+avgS2)/2),
      verdict: sum.verdict || 'Az elemzés elkészült.',
      summary: sum.summary || 'Az elemzés elkészült.',
      top_actions: [sum.a1, sum.a2, sum.a3].filter(Boolean),
      fel1_javaslatok: [sum.j1a, sum.j1b, sum.j1c].filter(Boolean),
      fel2_javaslatok: [sum.j2a, sum.j2b, sum.j2c].filter(Boolean),
      issues: dedup.slice(0, 15),
      positives: allPos.filter(function(v,i,a){return a.findIndex(function(x){return x.title===v.title;})===i;}).slice(0,6),
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
