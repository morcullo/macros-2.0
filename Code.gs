/**
 * Macros app <-> Google Sheets bridge.
 *
 * Setup:
 * 1. Create a Google Sheet.
 * 2. Extensions -> Apps Script.
 * 3. Paste this file into Code.gs and save.
 * 4. Deploy -> New deployment -> Web app.
 * 5. Execute as: Me. Who has access: Anyone.
 * 6. Paste the /exec URL into the GOOGLE_SHEET_URL constant in index.html. No URL entry is needed in the app.
 */
const STATE_SHEET = 'AppState';
const MEALS_SHEET = 'Meals';
const FOODS_SHEET = 'Food Items';
const FOOD_LIBRARY_SHEET = 'Food Library';
const WEIGHT_SHEET = 'Weight';
const GOALS_SHEET = 'Goals';
const STATE_CACHE_KEY = 'macro_tracker_state_v2';
const STATE_CACHE_TTL = 600; // 10 minutes

function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  const cb = e && e.parameter && e.parameter.callback;
  if (action === 'estimateFood') return estimateFood_(e);

  // Use a compressed script cache for normal app reads. This avoids opening
  // and parsing the spreadsheet on most startups and background refreshes.
  const state = readCachedState_();

  if (cb) {
    return ContentService
      .createTextOutput(cb + '(' + JSON.stringify(state) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return json_(state);
}

function readCachedState_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(STATE_CACHE_KEY);

  if (cached) {
    try {
      return JSON.parse(decodeCachedState_(cached));
    } catch (err) {
      console.warn('State cache parse failed: ' + err);
    }
  }

  const state = readState_();

  if (state && !state.__empty) {
    try {
      cache.put(
        STATE_CACHE_KEY,
        encodeCachedState_(JSON.stringify(state)),
        STATE_CACHE_TTL
      );
    } catch (err) {
      console.warn('State cache write skipped: ' + err);
    }
  }

  return state;
}

function encodeCachedState_(json) {
  const blob = Utilities.gzip(Utilities.newBlob(json, 'application/json'));
  return Utilities.base64Encode(blob.getBytes());
}

function decodeCachedState_(encoded) {
  const bytes = Utilities.base64Decode(encoded);
  return Utilities.ungzip(Utilities.newBlob(bytes)).getDataAsString();
}


function estimateFood_(e) {
  const cb = e && e.parameter && e.parameter.callback;
  const food = String((e && e.parameter && e.parameter.food) || '').trim();
  let result;
  try {
    if (!food) throw new Error('Enter a food item first.');
    const key = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
    if (!key) throw new Error('OpenAI API key is not configured in Apps Script.');

    // Nutrition estimator is deliberately stricter than a normal chat prompt.
    // It prioritizes exact labels / official sources, then authoritative food databases,
    // and only falls back to a calculated estimate when an exact match is unavailable.
    const prompt = [
      'You are a meticulous nutrition-database assistant. Estimate calories and macros for the exact food description supplied by the user.',
      '',
      'ACCURACY RULES:',
      '1. Parse every quantity, unit, preparation method, and qualifier in the user input. Preserve the stated serving size exactly.',
      '2. If the user gives grams/ounces/ml/pieces, calculate the nutrition for that exact amount; do NOT silently substitute a standard serving.',
      '3. Treat raw vs cooked as materially different. If the user says cooked, use cooked nutrition. If they say raw, use raw nutrition. If preparation state is genuinely ambiguous, make the most likely assumption and state it.',
      '4. For branded, restaurant, packaged, or chain foods, search the web for the current official nutrition facts first. Prefer the manufacturer/restaurant official site or nutrition PDF.',
      '5. For generic foods, search authoritative nutrition databases when possible (USDA FoodData Central, Canadian Nutrient File, or equivalent government/academic sources).',
      '6. Never use a search snippet alone when a primary nutrition page or nutrition label is available. Cross-check conflicting values and choose the most authoritative/relevant source.',
      '7. Do not invent a brand, recipe, sauce, oil, or ingredient. If an ingredient is unspecified, use a standard preparation only when necessary and clearly disclose it.',
      '8. For mixed dishes or restaurant meals, break the item into plausible components internally, estimate each component, then sum calories/protein/carbs/fat. Include likely cooking oil/sauces only if the description indicates them or they are intrinsic to the dish.',
      '9. Calories and macros must be internally consistent. Protein/carbs provide 4 kcal/g and fat provides 9 kcal/g, allowing for fiber, rounding, sugar alcohols, and database label conventions. If a database calorie value is authoritative, use that value and keep macros close to it.',
      '10. Do not double-count ingredients. Do not count a condiment, dressing, cheese, oil, or topping unless it is actually part of the described serving.',
      '11. Give realistic precision: calories to the nearest whole number; macros to one decimal place. Do not create fake precision beyond what the source supports.',
      '12. If the input is too vague to estimate responsibly, use a clearly stated standard assumption rather than pretending it is exact.',
      '',
      'SEARCH POLICY:',
      '- You MUST use web search for branded/restaurant/packaged foods, named menu items, or foods where an exact current label materially improves accuracy.',
      '- You SHOULD use web search for generic foods when authoritative nutrition data is likely to improve the estimate.',
      '- Prefer official sources and government/academic nutrition databases over blogs, social media, and generic calorie sites.',
      '',
      'OUTPUT:',
      'Return ONLY the requested JSON object. No markdown, no citations outside the JSON, no extra commentary.',
      'The assumption field should briefly state the serving/preparation assumption and, when web data was used, the source type (for example: "official nutrition label; 6 oz cooked serving").',
      '',
      'Food item: ' + food
    ].join('\n');

    const payload = {
      model: 'gpt-5.6-terra',
      tools: [{ type: 'web_search' }],
      input: prompt,
      max_output_tokens: 1200,
      text: {
        format: {
          type: 'json_schema',
          name: 'food_nutrition_estimate',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: {type: 'string'},
              calories: {type: 'number'},
              protein: {type: 'number'},
              carbs: {type: 'number'},
              fat: {type: 'number'},
              assumption: {type: 'string'}
            },
            required: ['name', 'calories', 'protein', 'carbs', 'fat', 'assumption']
          }
        }
      }
    };

    const response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
      method: 'post',
      contentType: 'application/json',
      headers: {Authorization: 'Bearer ' + key},
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const code = response.getResponseCode();
    const body = response.getContentText();
    if (code < 200 || code >= 300) {
      let detail = '';
      try { detail = JSON.parse(body).error?.message || ''; } catch (_) {}
      throw new Error('OpenAI request failed (' + code + ')' + (detail ? ': ' + detail : '.'));
    }

    const parsed = JSON.parse(body);
    let text = parsed.output_text || '';
    if (!text && Array.isArray(parsed.output)) {
      parsed.output.forEach(item => {
        if (item && item.type === 'message' && Array.isArray(item.content)) {
          item.content.forEach(part => {
            if (part && part.type === 'output_text') text += part.text || '';
          });
        }
      });
    }

    // If the API reports an incomplete response, surface a useful error rather than
    // attempting to parse truncated JSON.
    if (parsed.status === 'incomplete' || (parsed.incomplete_details && parsed.incomplete_details.reason)) {
      throw new Error('The nutrition estimate was incomplete. Please try again.');
    }

    const jsonText = String(text).trim().replace(/^```json\s*/i,'').replace(/\s*```$/,'');
    if (!jsonText) throw new Error('The AI returned an empty estimate. Please try again.');

    let foodData;
    try {
      foodData = JSON.parse(jsonText);
    } catch (parseErr) {
      throw new Error('The AI returned incomplete nutrition data. Please try the estimate again.');
    }

    const clean = {
      name: String(foodData.name || food),
      calories: Math.max(0, Number(foodData.calories) || 0),
      protein: Math.max(0, Number(foodData.protein) || 0),
      carbs: Math.max(0, Number(foodData.carbs) || 0),
      fat: Math.max(0, Number(foodData.fat) || 0),
      assumption: String(foodData.assumption || '')
    };
    result = {ok:true, food:clean};
  } catch (err) {
    result = {ok:false, error:String(err && err.message || err)};
  }
  const out = JSON.stringify(result);
  if (cb) return ContentService.createTextOutput(cb + '(' + out + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return json_(result);
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  let locked = false;

  try {
    const raw = e && e.parameter && e.parameter.state;
    if (!raw) throw new Error('Missing state payload.');

    const incoming = JSON.parse(raw);
    if (!incoming || typeof incoming !== 'object') {
      throw new Error('Invalid state payload.');
    }

    // Reject obviously incomplete writes before touching the spreadsheet.
    if (!Array.isArray(incoming.meals) ||
        !Array.isArray(incoming.foodLibrary) ||
        !Array.isArray(incoming.weights)) {
      throw new Error('Incomplete state payload.');
    }

    const incomingStamp = Number(incoming._updatedAt || 0);
    if (!Number.isFinite(incomingStamp) || incomingStamp <= 0) {
      throw new Error('Invalid state timestamp.');
    }

    // Serialize all writes so two phones/browsers cannot clear/write the
    // workbook at the same time.
    lock.waitLock(30000);
    locked = true;

    const existing = readState_();
    const existingStamp = Number(existing && existing._updatedAt || 0);

    // Never allow an older browser snapshot to overwrite a newer cloud copy.
    if (!existing.__empty && existingStamp > incomingStamp) {
      return json_({
        ok: true,
        saved: false,
        ignored: true,
        reason: 'stale',
        updatedAt: existingStamp
      });
    }

    writeState_(incoming);

    // Refresh the read cache immediately after a successful write so the
    // next device/startup sees the newest state without another sheet read.
    try {
      CacheService.getScriptCache().put(
        STATE_CACHE_KEY,
        encodeCachedState_(JSON.stringify(incoming)),
        STATE_CACHE_TTL
      );
    } catch (cacheErr) {
      console.warn('State cache update skipped: ' + cacheErr);
    }

    // Read the state back from Sheets before reporting success. This makes
    // the server-side save atomic from the app's point of view: if the write
    // did not stick, the response is an error instead of a false success.
    const saved = readState_();
    const savedStamp = Number(saved && saved._updatedAt || 0);

    if (saved.__empty || savedStamp !== incomingStamp) {
      throw new Error('Google Sheets did not confirm the saved state.');
    }

    return json_({
      ok: true,
      saved: true,
      ignored: false,
      updatedAt: savedStamp,
      mealCount: Array.isArray(saved.meals) ? saved.meals.length : 0
    });

  } catch (err) {
    console.error('doPost failed:', err);
    return json_({
      ok: false,
      saved: false,
      error: String(err && err.message || err)
    });
  } finally {
    if (locked) {
      try { lock.releaseLock(); } catch (_) {}
    }
  }
}

function readState_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(STATE_SHEET);

  if (!sheet || sheet.getLastRow() < 2 || sheet.getLastColumn() < 2) {
    return {__empty:true};
  }

  const raw = sheet.getRange(2, 2).getValue();
  if (!raw) return {__empty:true};

  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object') return {__empty:true};

    // Keep the timestamp authoritative from the stored JSON.
    parsed._updatedAt = Number(parsed._updatedAt || 0);
    return parsed;
  } catch (err) {
    console.error('Could not parse AppState:', err);
    return {__empty:true};
  }
}

function writeState_(state) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const stateSheet = getOrCreate_(ss, STATE_SHEET);
  stateSheet.clearContents();
  stateSheet.getRange(1,1,2,2).setValues([
    ['updatedAt','stateJson'],
    [new Date(), JSON.stringify(state)]
  ]);
  stateSheet.getRange(1,1,1,2).setFontWeight('bold');
  stateSheet.setColumnWidth(1, 160);
  stateSheet.setColumnWidth(2, 700);

  writeMeals_(ss, state.meals || []);
  writeFoods_(ss, state.meals || []);
  writeFoodLibrary_(ss, state.foodLibrary || []);
  writeWeights_(ss, state.weights || []);
  writeGoals_(ss, state.goals || {});
}

function writeMeals_(ss, meals) {
  const sh = getOrCreate_(ss, MEALS_SHEET); sh.clearContents();
  const rows = [['ID','Date','Time','Meal Type','Meal Name','Calories','Protein (g)','Carbs (g)','Fat (g)','Food Items']];
  meals.forEach(m => {
    const t = totals_(m.items || []);
    rows.push([m.id || '', m.date || '', m.time || '', m.mealType || '', m.name || '', t.calories, t.protein, t.carbs, t.fat, (m.items || []).length]);
  });
  sh.getRange(1,1,rows.length,rows[0].length).setValues(rows); sh.getRange(1,1,1,rows[0].length).setFontWeight('bold');
  sh.setFrozenRows(1);
}

function writeFoods_(ss, meals) {
  const sh = getOrCreate_(ss, FOODS_SHEET); sh.clearContents();
  const rows = [['Meal ID','Meal Name','Food Item','Calories','Protein (g)','Carbs (g)','Fat (g)']];
  meals.forEach(m => (m.items || []).forEach(i => rows.push([m.id || '', m.name || '', i.name || '', +i.calories || 0, +i.protein || 0, +i.carbs || 0, +i.fat || 0])));
  sh.getRange(1,1,rows.length,rows[0].length).setValues(rows); sh.getRange(1,1,1,rows[0].length).setFontWeight('bold');
  sh.setFrozenRows(1);
}


function writeFoodLibrary_(ss, foods) {
  const sh = getOrCreate_(ss, FOOD_LIBRARY_SHEET); sh.clearContents();
  const seen = new Set();
  const rows = [['Food','Carbs','Protein','Fat','Calories']];
  (foods || []).forEach(i => {
    const name = String(i.name || '').trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    rows.push([name, +i.carbs || 0, +i.protein || 0, +i.fat || 0, +i.calories || 0]);
  });
  sh.getRange(1,1,rows.length,5).setValues(rows); sh.getRange(1,1,1,5).setFontWeight('bold');
  sh.setFrozenRows(1);
}

function writeWeights_(ss, weights) {
  const sh = getOrCreate_(ss, WEIGHT_SHEET); sh.clearContents();
  const rows = [['Date','Weight (lbs)']].concat(weights.map(w => [w.date || '', +w.value || 0]));
  sh.getRange(1,1,rows.length,2).setValues(rows); sh.getRange(1,1,1,2).setFontWeight('bold'); sh.setFrozenRows(1);
}

function writeGoals_(ss, goals) {
  const sh = getOrCreate_(ss, GOALS_SHEET); sh.clearContents();
  const rows = [['Goal','Value'],['Calories',+goals.calories||0],['Protein',+goals.protein||0],['Carbs',+goals.carbs||0],['Fat',+goals.fat||0]];
  sh.getRange(1,1,rows.length,2).setValues(rows); sh.getRange(1,1,1,2).setFontWeight('bold'); sh.autoResizeColumns(1,2);
}

function totals_(items) {
  return items.reduce((a,i) => ({
    calories:a.calories+(+i.calories||0), protein:a.protein+(+i.protein||0),
    carbs:a.carbs+(+i.carbs||0), fat:a.fat+(+i.fat||0)
  }), {calories:0,protein:0,carbs:0,fat:0});
}
function getOrCreate_(ss, name) { return ss.getSheetByName(name) || ss.insertSheet(name); }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
