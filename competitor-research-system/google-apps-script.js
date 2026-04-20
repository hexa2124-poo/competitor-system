// ================================================================
// COMPETITOR RESEARCH SYSTEM - Google Apps Script Database
// ================================================================
// SETUP INSTRUCTIONS:
// 1. Open your Google Sheet
// 2. Extensions → Apps Script
// 3. Paste this entire file
// 4. Click "Deploy" → "New Deployment"
// 5. Type: Web App
// 6. Execute as: Me
// 7. Who has access: Anyone
// 8. Click Deploy → Copy Web App URL
// ================================================================

const SPREADSHEET_ID = ''; // Leave blank - uses current spreadsheet
const SHEETS = {
  RAW_DATA: 'RawData',
  MATRIX: 'DemandMatrix',
  COMPETITORS: 'Competitors',
  SETTINGS: 'Settings'
};

// ─── MAIN ENTRY POINTS ──────────────────────────────────────────

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action || 'save_signals';
    
    let result;
    switch (action) {
      case 'save_signals':   result = saveSignals(payload); break;
      case 'save_raw':       result = saveRawData(payload); break;
      case 'add_competitor': result = addCompetitor(payload); break;
      default: result = { error: 'Unknown action: ' + action };
    }
    
    return respond(result);
  } catch (err) {
    return respond({ error: err.message, stack: err.stack });
  }
}

function doGet(e) {
  try {
    const action = e.parameter.action || 'get_matrix';
    
    let result;
    switch (action) {
      case 'get_matrix':      result = getMatrix(e.parameter); break;
      case 'get_raw':         result = getRawData(e.parameter); break;
      case 'get_competitors': result = getCompetitors(); break;
      case 'get_stats':       result = getStats(); break;
      default: result = { error: 'Unknown action' };
    }
    
    return respond(result);
  } catch (err) {
    return respond({ error: err.message });
  }
}

// ─── SAVE FUNCTIONS ─────────────────────────────────────────────

function saveSignals(payload) {
  const sheet = getOrCreateSheet(SHEETS.MATRIX, [
    'ID', 'Timestamp', 'Source', 'CompetitorURL', 'Quadrant',
    'Signal', 'UseCase', 'Frequency', 'RawText', 'Tags', 'Status'
  ]);
  
  const signals = payload.signals || [];
  let saved = 0;
  
  signals.forEach(signal => {
    const id = Utilities.getUuid();
    sheet.appendRow([
      id,
      new Date().toISOString(),
      payload.source || 'manual',
      payload.competitorUrl || '',
      signal.quadrant || '',
      signal.signal || '',
      signal.useCase || '',
      signal.frequency || 'medium',
      signal.rawText || '',
      (signal.tags || []).join(', '),
      'active'
    ]);
    saved++;
  });
  
  // Auto-update stats
  updateStats();
  
  return { status: 'OK', saved, message: `Saved ${saved} signals to DemandMatrix sheet` };
}

function saveRawData(payload) {
  const sheet = getOrCreateSheet(SHEETS.RAW_DATA, [
    'ID', 'Timestamp', 'Platform', 'CompetitorURL', 'ReviewText',
    'Rating', 'ReviewDate', 'Processed', 'SentimentScore'
  ]);
  
  const items = payload.items || [];
  let saved = 0;
  
  items.forEach(item => {
    // Basic sentiment scoring
    const text = (item.text || item.title || '').toLowerCase();
    let sentiment = 0;
    const positiveWords = ['great', 'love', 'best', 'amazing', 'excellent', 'perfect', 'good'];
    const negativeWords = ['bad', 'terrible', 'awful', 'worst', 'poor', 'broken', 'stopped'];
    positiveWords.forEach(w => { if (text.includes(w)) sentiment++; });
    negativeWords.forEach(w => { if (text.includes(w)) sentiment--; });
    
    sheet.appendRow([
      Utilities.getUuid(),
      new Date().toISOString(),
      payload.platform || item.source || 'unknown',
      payload.competitorUrl || '',
      item.text || item.title || item.body || JSON.stringify(item).substring(0, 500),
      item.rating || item.stars || '',
      item.date || item.publishedAt || '',
      'false',
      sentiment
    ]);
    saved++;
  });
  
  return { status: 'OK', saved };
}

function addCompetitor(payload) {
  const sheet = getOrCreateSheet(SHEETS.COMPETITORS, [
    'ID', 'AddedDate', 'Name', 'URL', 'Platform', 'LastScraped', 'TotalReviews', 'Status'
  ]);
  
  sheet.appendRow([
    Utilities.getUuid(),
    new Date().toISOString(),
    payload.name || '',
    payload.url || '',
    payload.platform || 'amazon',
    '',
    0,
    'active'
  ]);
  
  return { status: 'OK', message: 'Competitor added' };
}

// ─── GET FUNCTIONS ──────────────────────────────────────────────

function getMatrix(params) {
  const sheet = getOrCreateSheet(SHEETS.MATRIX, [
    'ID', 'Timestamp', 'Source', 'CompetitorURL', 'Quadrant',
    'Signal', 'UseCase', 'Frequency', 'RawText', 'Tags', 'Status'
  ]);
  
  const rows = sheetToJSON(sheet);
  
  // Filter by quadrant if specified
  if (params && params.quadrant) {
    return rows.filter(r => r.Quadrant === params.quadrant);
  }
  
  return rows;
}

function getRawData(params) {
  const sheet = getOrCreateSheet(SHEETS.RAW_DATA, [
    'ID', 'Timestamp', 'Platform', 'CompetitorURL', 'ReviewText',
    'Rating', 'ReviewDate', 'Processed', 'SentimentScore'
  ]);
  
  const limit = parseInt(params?.limit) || 100;
  const rows = sheetToJSON(sheet);
  
  // Return most recent
  return rows.slice(-limit).reverse();
}

function getCompetitors() {
  const sheet = getOrCreateSheet(SHEETS.COMPETITORS, [
    'ID', 'AddedDate', 'Name', 'URL', 'Platform', 'LastScraped', 'TotalReviews', 'Status'
  ]);
  return sheetToJSON(sheet);
}

function getStats() {
  const matrixSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MATRIX);
  const rawSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.RAW_DATA);
  const compSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.COMPETITORS);
  
  const matrixRows = matrixSheet ? Math.max(0, matrixSheet.getLastRow() - 1) : 0;
  const rawRows = rawSheet ? Math.max(0, rawSheet.getLastRow() - 1) : 0;
  const compRows = compSheet ? Math.max(0, compSheet.getLastRow() - 1) : 0;
  
  // Quadrant breakdown
  let breakdown = { decision_triggers: 0, objection_architecture: 0, conversion_vocabulary: 0, unmet_needs: 0 };
  if (matrixSheet && matrixRows > 0) {
    const data = matrixSheet.getRange(2, 5, matrixRows, 1).getValues();
    data.forEach(row => {
      const q = row[0];
      if (breakdown.hasOwnProperty(q)) breakdown[q]++;
    });
  }
  
  return {
    total_signals: matrixRows,
    total_reviews: rawRows,
    total_competitors: compRows,
    quadrant_breakdown: breakdown,
    last_updated: new Date().toISOString()
  };
}

// ─── UTILITY FUNCTIONS ──────────────────────────────────────────

function getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    
    // Style the header row
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground('#1a1a2e');
    headerRange.setFontColor('#ffffff');
    headerRange.setFontWeight('bold');
    sheet.setFrozenRows(1);
    
    // Auto-resize columns
    sheet.autoResizeColumns(1, headers.length);
  }
  
  return sheet;
}

function sheetToJSON(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  
  const headers = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function updateStats() {
  // Update a stats cell in Settings sheet if it exists
  try {
    const statsSheet = getOrCreateSheet(SHEETS.SETTINGS, ['Key', 'Value', 'UpdatedAt']);
    const stats = getStats();
    
    // Find or create stats row
    const data = statsSheet.getDataRange().getValues();
    let statsRow = -1;
    data.forEach((row, i) => { if (row[0] === 'last_stats') statsRow = i + 1; });
    
    if (statsRow > 0) {
      statsSheet.getRange(statsRow, 2).setValue(JSON.stringify(stats));
      statsSheet.getRange(statsRow, 3).setValue(new Date().toISOString());
    } else {
      statsSheet.appendRow(['last_stats', JSON.stringify(stats), new Date().toISOString()]);
    }
  } catch(e) { /* ignore stats errors */ }
}

// ─── MANUAL TRIGGER FUNCTION ────────────────────────────────────
// Run this manually from Apps Script editor to test setup

function testSetup() {
  const result = saveSignals({
    source: 'test',
    competitorUrl: 'https://example.com',
    signals: [
      { quadrant: 'decision_triggers', signal: 'Test signal - Setup working!', useCase: 'Test', frequency: 'high', rawText: 'Test' }
    ]
  });
  Logger.log(JSON.stringify(result));
  Logger.log('✅ Setup test complete! Check your DemandMatrix sheet.');
}
