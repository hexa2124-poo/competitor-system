// scripts/auto-scrape.js
// ================================================
// AUTO SCRAPING SCRIPT - Runs via GitHub Actions
// Apify → Claude AI → Google Sheets
// ================================================

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const SHEETS_URL = process.env.SHEETS_WEBAPP_URL;

// Load competitor URLs from data/competitors.json (you create this)
const competitors = require('../data/competitors.json').catch(() => [
  { name: 'Competitor 1', url: 'https://www.amazon.com/dp/EXAMPLE', platform: 'amazon' }
]);

// ─── APIFY SCRAPERS ──────────────────────────────────────────────

const ACTOR_MAP = {
  amazon:    'junglee~amazon-reviews-scraper',
  google:    'compass~google-maps-reviews-scraper',
  youtube:   'streamers~youtube-comments-scraper',
  instagram: 'apify~instagram-comment-scraper'
};

async function scrapeWithApify(url, platform, maxItems = 100) {
  console.log(`🤖 Scraping ${platform}: ${url}`);
  
  const actor = ACTOR_MAP[platform];
  if (!actor) throw new Error(`Unknown platform: ${platform}`);

  // Start run
  const startRes = await fetch(`https://api.apify.com/v2/acts/${actor}/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${APIFY_TOKEN}`
    },
    body: JSON.stringify({
      startUrls: [{ url }],
      maxItems,
      maxConcurrency: 1
    })
  });

  if (!startRes.ok) {
    const err = await startRes.json();
    throw new Error(`Apify start failed: ${err.error?.message}`);
  }

  const { data: { id: runId } } = await startRes.json();
  console.log(`  ✅ Run started: ${runId}`);

  // Poll until done
  let status = 'RUNNING';
  let attempts = 0;
  while (status === 'RUNNING' && attempts < 40) {
    await sleep(5000);
    const pollRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, {
      headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` }
    });
    const pollData = await pollRes.json();
    status = pollData.data.status;
    attempts++;
    process.stdout.write(`  ⏳ ${status} (${attempts * 5}s)\r`);
  }

  if (status !== 'SUCCEEDED') {
    console.log(`\n  ⚠️ Run ended with: ${status}`);
    return [];
  }

  // Get results
  const dataRes = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?limit=${maxItems}`,
    { headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` } }
  );
  const items = await dataRes.json();
  console.log(`\n  ✅ Got ${items.length} items!`);
  return items;
}

// ─── CLAUDE ANALYSIS ─────────────────────────────────────────────

async function analyzeWithClaude(reviews, platform) {
  console.log(`🧠 Analyzing ${reviews.length} reviews with Claude...`);
  
  const reviewTexts = reviews
    .map((r, i) => `${i + 1}. "${r.text || r.title || r.body || JSON.stringify(r).substring(0, 200)}"`)
    .join('\n');

  const prompt = `Analyze these competitor ${platform} reviews and extract a Demand Signal Matrix.

Reviews:
${reviewTexts.substring(0, 8000)}

Extract signals and respond ONLY with valid JSON:
{
  "signals": [
    {
      "quadrant": "decision_triggers|objection_architecture|conversion_vocabulary|unmet_needs",
      "signal": "specific insight (1 sentence)",
      "useCase": "what to use this for",
      "frequency": "high|medium|low",
      "rawText": "exact quote from reviews"
    }
  ]
}

Extract 3-4 signals per quadrant. Focus on actionable insights.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await res.json();
  if (data.error) throw new Error(`Claude error: ${data.error.message}`);

  const text = data.content[0].text;
  const clean = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(clean);
  
  console.log(`  ✅ Got ${parsed.signals?.length || 0} signals`);
  return parsed.signals || [];
}

// ─── SAVE TO GOOGLE SHEETS ───────────────────────────────────────

async function saveToSheets(signals, competitorUrl, source) {
  if (!SHEETS_URL) { console.log('  ⚠️ No Sheets URL configured'); return; }
  
  console.log(`📊 Saving ${signals.length} signals to Google Sheets...`);
  
  const res = await fetch(SHEETS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'save_signals', signals, competitorUrl, source })
  });

  const data = await res.json();
  console.log(`  ✅ Saved: ${data.saved} signals`);
  return data;
}

// ─── MAIN ────────────────────────────────────────────────────────

async function main() {
  if (!APIFY_TOKEN) { console.log('⚠️ APIFY_TOKEN not set, skipping scrape'); return; }
  if (!CLAUDE_API_KEY) { console.log('⚠️ CLAUDE_API_KEY not set, skipping analysis'); return; }

  console.log('🚀 Starting automated competitor research...\n');

  let compList;
  try {
    const fs = require('fs');
    compList = JSON.parse(fs.readFileSync('./data/competitors.json', 'utf8'));
  } catch {
    console.log('⚠️ No data/competitors.json found. Using example.');
    compList = [{ name: 'Example', url: 'https://www.amazon.com/dp/B09999EXAMPLE', platform: 'amazon' }];
  }

  for (const comp of compList) {
    console.log(`\n═══ Processing: ${comp.name} ═══`);
    
    try {
      // 1. Scrape
      const reviews = await scrapeWithApify(comp.url, comp.platform, 100);
      if (!reviews.length) { console.log('  No reviews found, skipping'); continue; }

      // 2. Analyze
      const signals = await analyzeWithClaude(reviews, comp.platform);

      // 3. Save
      await saveToSheets(signals, comp.url, comp.platform);

      console.log(`✅ Done: ${comp.name}`);
    } catch (err) {
      console.error(`❌ Error processing ${comp.name}: ${err.message}`);
    }
    
    // Rate limit pause
    await sleep(3000);
  }

  console.log('\n🎉 Automation complete!');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
