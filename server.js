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

function extractJSON(raw) {
  if (!raw) return null;
  // Eltávolítjuk a markdown jelölőket
  let c = raw.replace(/```json/gi, '').replace(/```/gi, '').trim();
  // Megkeressük az első { és utolsó } közötti részt
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
  res.json({ status: 'LexAI Backend running', version: '5.0' });
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
    const allPositives = [];
    const s1arr = [], s2arr = [];
    let structure = {};

    for (let i = 0; i < toAnalyze.length; i++) {
      const chunk = toAnalyze[i];
      const pFrom = Math.round(i * estPages / toAnalyze.length) + 1;
      const pTo = Math.round((i+1) * estPages / toAnalyze.length);

      // LÉPÉS 1: Alap info kinyerése (kis JSON, soha nem csonkul)
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
        const info = extractJSON(r1.content[0].text);
        if (info) {
          if (info.fel1_score) s1arr.push(info.fel1_score);
          if (info.fel2_score) s2arr.push(info.fel2_score);
          if (info.fel1 && !structure.fel1) structure = {fel1: info.fel1, fel2: info.fel2, type: info.type};
          if (info.pos1) allPositives.push({title: info.pos1, description: ''});
          if (info.pos2) allPositives.push({title: info.pos2, description: ''});
        }
      } catch(e) { console.error('Info hiba:', e.message); }

      // LÉPÉS 2: Problémák – fel1 és fel2 szempontból külön, 4-4 issue per chunk
      const problemPrompt = 'Szerződésrész (~' + pFrom + '-' + pTo + '. oldal):\n\n' + chunk + '\n\n';
      const fel1n = structure.fel1 || '1. fél';
      const fel2n = structure.fel2 || '2. fél';

      // Fel1 szempontjából hátrányos pontok
      try {
        const rA = await client.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 1500,
          messages: [{ role: 'user', content:
            problemPrompt +
            'Keresd meg a TOP 4 problémát ami ' + fel1n + ' szempontjából HÁTRÁNYOS (ahol ' + fel2n + ' kedvezőbb).\n' +
            'JSON (TILOS ```json):\n' +
            '{"issues":[{"sev":"kritikus|figyelmeztetés","title":"max 60 kar","loc":"fejezet (~' + pFrom + '.o)","desc":"miért hátrányos ' + fel1n + '-nek, max 150 kar","fix":"konkrét javítás max 150 kar","impactA":"hatás ' + fel1n + '-re","impactB":"hatás ' + fel2n + '-re"}]}\n' +
            'Ha nincs: {"issues":[]}'
          }]
        });
        totalInputTokens += rA.usage.input_tokens;
        totalOutputTokens += rA.usage.output_tokens;
        const resA = extractJSON(rA.content[0].text);
        if (resA && resA.issues) {
          resA.issues.forEach(issue => {
            if (issue && issue.title) allIssues.push({
              severity: issue.sev || 'figyelmeztetés',
              title: issue.title, location: issue.loc || '',
              favors: 'fel2', description: issue.desc || '',
              fix_text: issue.fix || '', impactA: issue.impactA || '', impactB: issue.impactB || ''
            });
          });
        }
      } catch(e) { console.error('Fel1 hátrány hiba:', e.message); }

      // Fel2 szempontjából hátrányos pontok
      try {
        const rB = await client.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 1500,
          messages: [{ role: 'user', content:
            problemPrompt +
            'Keresd meg a TOP 4 problémát ami ' + fel2n + ' szempontjából HÁTRÁNYOS (ahol ' + fel1n + ' kedvezőbb).\n' +
            'JSON (TILOS ```json):\n' +
            '{"issues":[{"sev":"kritikus|figyelmeztetés","title":"max 60 kar","loc":"fejezet (~' + pFrom + '.o)","desc":"miért hátrányos ' + fel2n + '-nek, max 150 kar","fix":"konkrét javítás max 150 kar","impactA":"hatás ' + fel1n + '-re","impactB":"hatás ' + fel2n + '-re"}]}\n' +
            'Ha nincs: {"issues":[]}'
          }]
        });
        totalInputTokens += rB.usage.input_tokens;
        totalOutputTokens += rB.usage.output_tokens;
        const resB = extractJSON(rB.content[0].text);
        if (resB && resB.issues) {
          resB.issues.forEach(issue => {
            if (issue && issue.title) allIssues.push({
              severity: issue.sev || 'figyelmeztetés',
              title: issue.title, location: issue.loc || '',
              favors: 'fel1', description: issue.desc || '',
              fix_text: issue.fix || '', impactA: issue.impactA || '', impactB: issue.impactB || ''
            });
          });
        }
      } catch(e) { console.error('Fel2 hátrány hiba:', e.message); }

    } // for loop vége

    const avgS1 = s1arr.length ? Math.round(s1arr.reduce((a,b)=>a+b,0)/s1arr.length) : 50;
    const avgS2 = s2arr.length ? Math.round(s2arr.reduce((a,b)=>a+b,0)/s2arr.length) : 50;
    const topIssues = allIssues.slice(0,3).map(function(x){return x.title;}).join('; ') || 'nincs';

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
    const sum = extractJSON(sumR.content[0].text) || {};

    const seen = {};
    const dedup = allIssues.filter(function(x){
      if(seen[x.title]) return false; seen[x.title]=true; return true;
    });

    const result = {
      fel1_score: avgS1, fel2_score: avgS2,
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
      issues: dedup.slice(0, 30),
      positives: allPositives.filter(function(v,i,a){return a.findIndex(function(x){return x.title===v.title;})===i;}).slice(0,6),
      structure: structure,
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
      return res.json(extractJSON(r.content[0].text) || {hints:[]});
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
    res.status(500).json({ error: 'Szerverhiba: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('LexAI szerver fut: port ' + PORT));
