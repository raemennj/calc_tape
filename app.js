(() => {
  'use strict';

  /* ===== Small helpers ===== */
  const setVar = (k,v) => document.documentElement.style.setProperty(k,v);
  const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
  const cssNum = (name, fallback) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const n = parseFloat(v); return Number.isFinite(n) ? n : fallback;
  };

  /* Keep last good number handy for redraws during layout changes */
  let lastGood = { value: 0, fraction: '', decimal: '' };

  let tapeMode = 'result';
  let tapeEntryCenter = 0;
  let tapeEntryTouched = false;

  const TAPE_MAX_IN = 5280 * 12;
  function clampTapeValue(value){ return clamp(value, 0, TAPE_MAX_IN); }
  function snapTapeValue(value){ return Math.round(value * 16) / 16; }

  /* ====== Uniform tile/gap solver ====== */
  const MIN_TAP = 44;
  const MIN_GAP = 6, MAX_GAP = 12;

  function computeTile(){
    const card = document.getElementById('card');
    const { width: W, height: H } = card.getBoundingClientRect();

    let gap = clamp(Math.floor(Math.min(W,H) * 0.02), MIN_GAP, MAX_GAP);
    setVar('--gap', gap + 'px');

    const tapeMin = cssNum('--tape-min', 100);

    // Measure minimum results height parts
    const pad = gap;
    const resultsPadTop = pad;
    const resultsPadBottom = Math.max(4, Math.round(pad * 0.35));
    setVar('--results-pad-top', resultsPadTop + 'px');
    setVar('--results-pad-bottom', resultsPadBottom + 'px');
    const inputEl  = document.getElementById('inputLine');
    const outputEl = document.querySelector('.output');

    const getLineHeightPx = (el) => {
      const cs = getComputedStyle(el);
      const lh = cs.lineHeight;
      if (lh.endsWith && lh.endsWith('px')) return parseFloat(lh);
      const fs = parseFloat(cs.fontSize) || 16;
      const mult = parseFloat(lh) || 1.2;
      return fs * mult;
    };

    const inputLH   = getLineHeightPx(inputEl);
    const outputLH  = getLineHeightPx(outputEl);
    const outputPad = parseFloat(getComputedStyle(outputEl).paddingTop) || 0;

    const historyMin = Math.ceil(inputLH * 2);
    setVar('--history-min', historyMin + 'px');

    // Reserve at least one output line + its top padding so divider is stable
    const outputMin = Math.ceil(outputPad + outputLH);
    setVar('--output-min', outputMin + 'px');

    // Results panel minimum = padding*2 + history + (fixed 8px gap between rows) + output + 1px divider
    const INTER_ROW_GAP = 8;
    const resultsMin = Math.ceil(resultsPadTop + resultsPadBottom + historyMin + INTER_ROW_GAP + outputMin + 1);
    setVar('--results-min', resultsMin + 'px');

    // Keypad composition (8 rows total: 1 mem + 4 console + 3 fractions)
    const ROWS = 8;
    const GAP_BUDGET = (3 + 2 + 2 + 6) * gap; // 13*gap across memory/console/fractions stacks
    const W_inside = W - 2*gap;

    // Available height for keypad if results uses only its MIN
    const H_for_keypad = Math.max(0, H - tapeMin - resultsMin - 2*gap);

    const tileFromH = Math.floor((H_for_keypad - GAP_BUDGET) / ROWS);
    const tileFromW = Math.floor((W_inside - (5 - 1) * gap) / 5);
    const tile = Math.max(MIN_TAP, Math.min(tileFromH, tileFromW));
    setVar('--tile', tile + 'px');

    // Redraw tape (and recenter the red line) whenever layout changes
    updateTapeDisplay(lastGood.value);
  }

  const ro = new ResizeObserver(computeTile);
  ro.observe(document.getElementById('card'));

  function initPortraitLock(){
    const orientation = window.screen?.orientation;
    if (!orientation?.lock) return;

    const tryLock = () => {
      orientation.lock('portrait').catch(() => {});
    };

    const onceOnInteract = () => {
      tryLock();
      window.removeEventListener('pointerdown', onceOnInteract);
      window.removeEventListener('keydown', onceOnInteract);
    };

    tryLock();
    window.addEventListener('pointerdown', onceOnInteract);
    window.addEventListener('keydown', onceOnInteract);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) tryLock();
    });
  }

  /* ====== Calculator logic (Feet behavior + safe eval) ====== */
  const tape = document.getElementById('tape');
  const sweep = document.getElementById('sweep');
  const inputLine = document.getElementById('inputLine');
  const fractionLine = document.getElementById('fractionLine');
  const decimalLine = document.getElementById('decimalLine');

  function getTapeDisplayCenter(){
    const base = (tapeMode === 'entry') ? tapeEntryCenter : lastGood.value;
    return Number.isFinite(base) ? clampTapeValue(base) : 0;
  }

  function updateTapeModeHint(){
    if (!tape) return;
    tape.dataset.mode = tapeMode;
    const label = (tapeMode === 'result') ? 'Result' : 'Entry';
    tape.setAttribute('title', `Tape: ${label} (tap to toggle)`);
  }

  function updateTapeDisplay(resultCenter){
    const center = (tapeMode === 'result')
      ? (Number.isFinite(resultCenter) ? resultCenter : lastGood.value)
      : tapeEntryCenter;
    drawTape(Number.isFinite(center) ? clampTapeValue(center) : 0);
    updateTapeModeHint();
  }

  function setTapeMode(mode){
    if (mode === tapeMode) return;
    if (mode === 'entry' && !tapeEntryTouched){
      tapeEntryCenter = clampTapeValue(Number.isFinite(lastGood.value) ? lastGood.value : 0);
    }
    tapeMode = mode;
    updateTapeDisplay(lastGood.value);
  }

  function toggleTapeMode(){
    setTapeMode(tapeMode === 'result' ? 'entry' : 'result');
  }

/* ---- Render helper for arrow span (robust) ---- */
function renderOutputs(leftFractionText, rightDecimalText){
  const raw = String(leftFractionText || '');
  // Wrap a leading ▴/▾ *after optional sign* with a span.arrow
  let html = raw.replace(
    /^(\s*[−-]?)\s*([▴▾])\s*/,
    (_, sign, arr) => `${sign}<span class="arrow" aria-hidden="true">${arr}</span> `
  );
  // Normalize accidental double spaces
  html = html.replace(/\s{2,}/g, ' ').trim();

  // Flag whether we're rounded (useful if you want styles like blinking, etc.)
  const rounded = /^(\s*[−-]?)\s*<span class="arrow/.test(html);
  fractionLine.setAttribute('data-rounded', rounded ? 'true' : 'false');

  fractionLine.innerHTML = html;
  decimalLine.textContent = rightDecimalText || '';
}



 

	
	
  const MEMORY_SLOT_COUNT = 5;
  const MEMORY_KEY = 'calcMemorySlots_uniform420';
  let memorySlots = Array(MEMORY_SLOT_COUNT).fill(null);
  const parseStoredMemoryValue = (val) => {
    if (val == null) return null;
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'string'){
      const direct = parseFloat(val);
      if (Number.isFinite(direct)) return direct;
      const mixed = parseMixedInchString(val);
      if (Number.isFinite(mixed)) return mixed;
    }
    return null;
  };

  let tokens = [];                 // raw tokens for math
  let tokenDisplays = [];          // pretty display for measurement tokens
  let currentEntry = '';           // normal numeric entry (non-measure)
  let currentEntryDisplay = '';    // optional display override (e.g., tape snap)
  let tmr = null;

  // Feet-builder state (active until finalized by an operator)
  let measure = { active:false, feet:0, inches:0, inEntry:'' };

  // Display mode: 'inch' (default) or 'feet' during peek
  let displayMode = 'inch';

  const gcd = (a,b)=> (b?gcd(b,a%b):Math.abs(a));
  const isOp = t => ['+','-','*','/'].includes(t);
  const isWhole = s => /^-?\d+$/.test(s);
  const isDec = s => /^-?\d+\.\d+$/.test(s);
  const splitDec = s => { const [w, d='0'] = s.split('.'); return [parseInt(w,10), parseFloat('0.'+d)]; };
  const fracFromDec = d => { const D=16; let n=Math.round(d*D), g=gcd(n,D); return `${n/g}/${D/g}`; };
  const prettyOp = (op) => ({ '*':'×', '/':'÷', '-':'−', '+':'+' }[op] || op);
  const roundToSixteenth = (x)=> Math.round(x*16)/16;

  // ---------- Result formatters ----------
function formatResultInch(value){
  // LEFT: 1/16″ fraction (rounded), with arrow when rounded
  const rounded = roundToSixteenth(value);
  const sign = rounded < 0 ? '-' : '';
  const abs  = Math.abs(rounded);
  const w    = Math.floor(abs);
  const f    = abs - w;

  let n = Math.round(f*16), d = 16, g = gcd(n,d); n/=g; d/=g;
  const fracCore = (n===0) ? `${w}″` : (w ? `${w} ${n}/${d}″` : `${n}/${d}″`);

  const arrow = roundingArrow(value, rounded);
  const fraction = sign + arrow + fracCore;

  // RIGHT: exact decimal (no 1/16 snap)
  const decimal = formatExactDecimalNumber(value) + '″';

  return { fraction, decimal };
}

/* ---- Replace current expression/history with a single value ---- */
function replaceHistoryWith(valueInInches){
  // Clear everything
  tokens = [];
  tokenDisplays = [];
  currentEntry = '';
  currentEntryDisplay = '';
  measure = { active:false, feet:0, inches:0, inEntry:'' };

  // Store one number token; display string matches the current displayMode
  const fmt = displayMode === 'feet' ? formatResultFeet(valueInInches)
                                     : formatResultInch(valueInInches);

  // strip any rounding arrow from the human label
  const cleanedLeft = (fmt.fraction || '').replace(/^\s*(?:▴|▾)\s*/, '');

  tokens.push(String(valueInInches));
  tokenDisplays.push(cleanedLeft);  // history shows a nice human label

  updateInput();
  evaluate();
  showToast('History replaced');
}


function formatResultFeet(value){
  // Arrow computed against INCH value rounded to 1/16″
  const rounded = roundToSixteenth(value);
  const arrow   = roundingArrow(value, rounded);

  const sign = value < 0 ? '-' : '';
  const rAbs = Math.abs(rounded);

  let feet    = Math.floor(rAbs / 12);
  let inchesR = roundToSixteenth(rAbs - feet*12);
  let wholeIn = Math.floor(inchesR);
  let fracIn  = inchesR - wholeIn;

  let n = Math.round(fracIn*16), d = 16, g = gcd(n,d); n/=g; d/=g;
  if (n === 16){ wholeIn += 1; n = 0; d = 16; }
  if (wholeIn >= 12){ feet += 1; wholeIn -= 12; }

  let inchStr = '';
  if (wholeIn === 0 && n === 0) inchStr = '';
  else if (n === 0)            inchStr = ` ${wholeIn}″`;
  else if (wholeIn === 0)      inchStr = ` ${n}/${d}″`;
  else                         inchStr = ` ${wholeIn} ${n}/${d}″`;

  // LEFT: feet + (rounded) inches with arrow if rounded
  const fraction = `${sign}${arrow}${feet}′${inchStr}`;

  // RIGHT: exact decimal in feet (no rounding)
  const decimal = formatExactDecimalNumber(value/12) + '′';

  return { fraction, decimal };
}


  function formatResult(value){
    return displayMode === 'feet' ? formatResultFeet(value) : formatResultInch(value);
  }

  function measureTotal(){
    const scratchIn = measure.inEntry ? parseFloat(measure.inEntry) : 0;
    return measure.feet*12 + measure.inches + scratchIn;
  }

  function measureDisplay(){
    const inVal = (measure.inEntry ? parseFloat(measure.inEntry) : 0) + measure.inches;
    const hasInches = inVal > 0;
    const feetStr = `${measure.feet}\u2032`;
    if (!hasInches) return feetStr;
    const r = roundToSixteenth(inVal);
    const w = Math.floor(r);
    const f = r - w;
    let n = Math.round(f*16), d = 16, g = gcd(n,d); n/=g; d/=g;
    const inchStr = (n===0) ? `${w}″` : (w ? `${w} ${n}/${d}″` : `${n}/${d}″`);
    return `${feetStr} ${inchStr}`;
  }

  function finalizeMeasureToken(){
    if (!measure.active) return;
    const total = measureTotal();
    const disp = measureDisplay();
    tokens.push(String(total));
    tokenDisplays.push(disp);
    measure = { active:false, feet:0, inches:0, inEntry:'' };
  }

	// old -- Exact decimal formatter (no 1/16 snap)
// Exact decimal formatter — always 4 places (normalizes "-0.0000" → "0.0000")
function formatExactDecimalNumber(x) {
  const s = Number(x).toFixed(4);
  return s === '-0.0000' ? '0.0000' : s;
}


// Arrow shows only when the fraction rounding changed the value.
function roundingArrow(exact, rounded){
  // Slightly looser tolerance so typical decimal entries (e.g., 1.3 vs 1-5/16)
  // actually show an arrow on most devices/browsers.
  const EPS = 1e-6;
  const delta = exact - rounded;
  if (Math.abs(delta) < EPS) return '';
  return (delta > 0) ? '▴ ' : '▾ ';
}


	// Parse strings like: "1 11/32", "2 1/2″", "19/32″", "1′ 6″", "1′ 6 1/2″"
function parseMixedInchString(s){
  if (!s || typeof s !== 'string') return null;
  const str = s.trim()
    .replace(/[””"]/g,'″')
    .replace(/[’’']/g,'′');

  let feet = 0, whole = 0, num = 0, den = 1;

  // Feet (optional)
  const feetMatch = str.match(/(-?\d+)\s*′/);
  if (feetMatch) feet = parseInt(feetMatch[1],10);

  // Portion after feet
  const afterFeet = str.replace(/.*′/,'').trim();

  // Whole inches (optional)
  const wholeMatch = afterFeet.match(/(-?\d+)(?=\s*(?:″|$|\s+\d+\/\d+))/);
  if (wholeMatch) whole = parseInt(wholeMatch[1],10);

  // Fraction inches (optional)
  const fracMatch = afterFeet.match(/(-?\d+)\s*\/\s*(\d+)/);
  if (fracMatch){
    num = parseInt(fracMatch[1],10);
    den = parseInt(fracMatch[2],10) || 1;
  }



  // If we saw *only* a fraction like "3/16" with no whole number
  if (!wholeMatch && fracMatch) whole = 0;

  const sign = (feet<0 || whole<0 || num<0) ? -1 : 1;
  const total = Math.abs(feet)*12 + Math.abs(whole) + Math.abs(num)/(den||1);
  const inches = sign * total;
  return isFinite(inches) ? inches : null;
}

	
  /* --- Pretty history with precedence parentheses + inch marks when feet appear --- */
  function tokenDisplayAt(idx, tok){
  // If we explicitly stored a pretty display (e.g., "1 1/2"), use it.
  // Otherwise, show exactly what the user typed.
  return (tokenDisplays[idx] !== undefined) ? tokenDisplays[idx] : String(tok);
}


  function buildDisplayArr(){
    const arr = [];
    for (let i=0;i<tokens.length;i++){
      const t = tokens[i];
      if (isOp(t)) arr.push({type:'op', value:t});
      else arr.push({type:'num', value:t, display: tokenDisplayAt(i,t)});
    }

    // Append the live entry (measure or number)
    if (measure.active){
      arr.push({type:'num', value: String(measureTotal()), display: measureDisplay()});
    } else if (currentEntry){
  // Show exactly what the user typed (no decimal → fraction conversion here)
  arr.push({ type:'num', value: currentEntry, display: currentEntryDisplay || currentEntry });
}


    // Keep trailing operator visible, but don’t include it in grouping
    let trailingOp = null;
    if (arr.length && arr[arr.length-1].type==='op'){
      trailingOp = arr.pop().value;
    }

    // Unary leading minus → merge into first number for display
    if (arr.length>=2 && arr[0].type==='op' && arr[0].value==='-' && arr[1].type==='num'){
      arr.shift();
      arr[0].display = '−' + arr[0].display;
    }

    return {arr, trailingOp};
  }

  function renderHistory(){
    const {arr, trailingOp} = buildDisplayArr();
    if (!arr.length){
      inputLine.textContent = trailingOp ? prettyOp(trailingOp) : '';
      return;
    }

    // If ANY feet are present in the expression, show explicit inches (″) on inch-only terms
    const feetPresent = arr.some(n => n.type==='num' && typeof n.display==='string' && n.display.includes('′'));
    const markInches = (txt) => {
      if (!feetPresent) return txt;
      if (!txt) return txt;
      if (txt.includes('′') || txt.includes('″')) return txt;
      return txt + '″';
    };

    const hasHigh = arr.some(n => n.type==='op' && (n.value==='*' || n.value==='/'));
    const hasLow  = arr.some(n => n.type==='op' && (n.value==='+' || n.value==='-'));
    const mixed   = hasHigh && hasLow;

    // Build with minimal parentheses around ×/÷ runs when mixed
    let s = '';
    for (let i=0;i<arr.length;){
      const node = arr[i];
      if (node.type==='num'){
        let part = markInches(node.display);
        let j=i;
        let hasHighInGroup = false;
        while (j+1<arr.length && arr[j+1].type==='op' && (arr[j+1].value==='*' || arr[j+1].value==='/') && j+2<arr.length && arr[j+2].type==='num'){
          part += ' ' + prettyOp(arr[j+1].value) + ' ' + markInches(arr[j+2].display);
          hasHighInGroup = true;
          j += 2;
        }
        if (mixed && hasHighInGroup) part = '(' + part + ')';
        s += part;
        i = j+1;
      } else {
        s += ' ' + prettyOp(node.value) + ' ';
        i += 1;
      }
    }

    if (trailingOp) s = (s ? s + ' ' : '') + prettyOp(trailingOp);

    inputLine.textContent = s.trim();

    requestAnimationFrame(()=>{
      const hist=document.getElementById('history');
      if(hist) hist.scrollTop = hist.scrollHeight;
    });

    setRepeatEnabled(canRepeat());
  }

  function updateInput(){ renderHistory(); }

  // ====== Evaluator ======
  const qEval = () => { clearTimeout(tmr); tmr = setTimeout(evaluate, 120); };

  function evaluate(){
    // Start with raw tokens and maybe a trailing operator
    let exprTokens = [...tokens];
    let pendingOp = null;
    if (exprTokens.length && isOp(exprTokens.at(-1))) {
      pendingOp = exprTokens.pop(); // hold the trailing op
    }

    const left = exprTokens.join(' ');
    const liveMeasure = measure.active ? String(measureTotal()) : null;
    const liveEntry   = (!measure.active && currentEntry) ? currentEntry : null;

    let preview = '';

    if (pendingOp && (liveMeasure || liveEntry)) {
      preview = (left ? left + ' ' : '') + pendingOp + ' ' + (liveMeasure ?? liveEntry);
    } else if (liveMeasure) {
      preview = left ? `${left} + ${liveMeasure}` : liveMeasure;
    } else if (liveEntry) {
      preview = left ? `${left} ${liveEntry}` : liveEntry;
    } else {
      preview = left;
    }

    try{
      let val = preview.trim() ? math.evaluate(preview) : 0;
      let num = (typeof val === 'number') ? val : val.toNumber();

      const out = formatResult(num);
      lastGood = { value: num, fraction: out.fraction, decimal: out.decimal };
      renderOutputs(out.fraction, out.decimal);
      updateTapeDisplay(num);
    } catch {
      if (measure.active && !left){
        const m = measureTotal();
        const out = formatResult(m);
        renderOutputs(out.fraction, out.decimal);
        updateTapeDisplay(m);
        return;
      }
     if (lastGood.decimal){
  renderOutputs(lastGood.fraction, lastGood.decimal);
  updateTapeDisplay(lastGood.value);
} else {
  renderOutputs('', '');
}

    }
  }

  // ===== Tape rendering + pixel-perfect center line =====
function drawTape(center){
  center = clampTapeValue(center);

  // Clear old ticks/labels
  [...tape.querySelectorAll('.tick,.tick-label')].forEach(n=>n.remove());

  const rect = tape.getBoundingClientRect();
  const mid = rect.width/2;

  // Auto-fit: show exactly N inches across the tape width (no calibration)
  const VIEW_RANGE_IN = 2.5;               // how many inches to display across the width
  const PPI = rect.width / VIEW_RANGE_IN; // pixels per inch derived from container width

  // Generate ticks around the center value
  const range = VIEW_RANGE_IN;
  const start = Math.max(center - range/2, 0), end = center + range/2;
  const a = Math.floor(start*16), b = Math.ceil(end*16);

  for (let i=a;i<=b;i++){
    const inches = i/16;
    const x = (inches - center)*PPI + mid - 1.5;  // centers around the red line

    const el = document.createElement('div'); el.className='tick'; el.style.left = x+'px';
    if (i%16===0){
      el.classList.add('num');
      const lbl=document.createElement('div');
      lbl.className='tick-label';
      lbl.textContent=inches.toFixed(0);
      lbl.style.left=(x+1.5)+'px';
      tape.appendChild(lbl);
    } else if (i%8===0) el.classList.add('lg');
    else if (i%4===0)   el.classList.add('med');
    else                el.classList.add('small');

    tape.appendChild(el);
  }

  // Place the red center line at the exact pixel mid (override any CSS)
  const centerEl = tape.querySelector('.center-line');
  if (centerEl){
    const desiredW = 4;
    centerEl.style.setProperty('width', desiredW + 'px', 'important');
    centerEl.style.setProperty('transform', 'none', 'important');

    const midPx = Math.round(rect.width / 2);
    const leftPx = midPx - (desiredW / 2);
    centerEl.style.setProperty('left', leftPx + 'px', 'important');
  }

  // Sweep animation reset
  sweep.classList.remove('animate'); void sweep.offsetWidth; sweep.classList.add('animate');
}

  // ===== Tape swipe selection =====
  const TAPE_SWIPE_VIEW_IN = 2.5;
  const TAPE_SWIPE_START_PX = 6;
  const TAPE_SWIPE_FLING_MIN_V = 0.4;
  const TAPE_SWIPE_STOP_MIN_V = 0.05;
  const TAPE_SWIPE_DECAY = 0.92;

  function canTapeSwipe(){
    return true;
  }

  function initTapeSwipe(){
    if (!tape) return;

    let active = false;
    let pointerId = null;
    let startX = 0;
    let startCenter = 0;
    let startDisplayCenter = 0;
    let lastX = 0;
    let lastT = 0;
    let velocity = 0;
    let center = 0;
    let moved = false;
    let rafId = 0;
    let flingId = 0;

    tape.style.touchAction = 'none';

    const scheduleDraw = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        drawTape(center);
      });
    };

    const stopFling = () => {
      if (!flingId) return;
      cancelAnimationFrame(flingId);
      flingId = 0;
    };

    const commitValue = () => {
      if (!Number.isFinite(center)) return;
      const snapped = clampTapeValue(snapTapeValue(center));
      center = snapped;
      tapeEntryCenter = snapped;
      tapeEntryTouched = true;
      insertValueIntoEntry(snapped, {
        replaceIfNoOp: true,
        display: formatResultInchOnlyLabel(snapped)
      });
    };

    const getPpi = () => {
      const rect = tape.getBoundingClientRect();
      return rect.width ? rect.width / TAPE_SWIPE_VIEW_IN : 0;
    };

    const onStart = (e) => {
      if (e.button != null && e.button !== 0) return;
      if (!canTapeSwipe()) return;

      stopFling();
      active = true;
      moved = false;
      pointerId = e.pointerId;
      startX = lastX = e.clientX;
      lastT = performance.now();
      velocity = 0;
      startDisplayCenter = getTapeDisplayCenter();
      startCenter = clampTapeValue(startDisplayCenter);
      center = startCenter;

      tape.setPointerCapture?.(pointerId);
    };

    const onMove = (e) => {
      if (!active || e.pointerId !== pointerId) return;
      const now = performance.now();
      const dx = e.clientX - startX;
      if (!moved && Math.abs(dx) < TAPE_SWIPE_START_PX) return;
      if (!moved){
        moved = true;
        if (tapeMode !== 'entry'){
          tapeMode = 'entry';
          updateTapeModeHint();
        }
        tapeEntryCenter = startCenter;
        tapeEntryTouched = true;
      }

      const ppi = getPpi();
      if (!ppi) return;

      center = clampTapeValue(startCenter - dx / ppi);
      tapeEntryCenter = center;

      const dt = now - lastT;
      if (dt > 0) {
        const deltaX = e.clientX - lastX;
        const instVel = -((deltaX / dt) / ppi) * 1000;
        velocity = velocity ? (velocity * 0.7 + instVel * 0.3) : instVel;
      }

      lastX = e.clientX;
      lastT = now;
      scheduleDraw();
      e.preventDefault();
    };

    const finish = () => {
      if (!active) return;
      active = false;
      if (pointerId != null) tape.releasePointerCapture?.(pointerId);
      pointerId = null;

      if (!moved){
        toggleTapeMode();
        return;
      }

      if (Math.abs(velocity) > TAPE_SWIPE_FLING_MIN_V) {
        let lastTime = performance.now();
        const step = (now) => {
          const dt = (now - lastTime) / 1000;
          lastTime = now;

          center = clampTapeValue(center + velocity * dt);
          const decay = Math.pow(TAPE_SWIPE_DECAY, dt * 60);
          tapeEntryCenter = center;
          if ((center <= 0 && velocity < 0) || (center >= TAPE_MAX_IN && velocity > 0)) {
            velocity = 0;
          } else {
            velocity *= decay;
          }

          drawTape(center);

          if (Math.abs(velocity) <= TAPE_SWIPE_STOP_MIN_V) {
            flingId = 0;
            commitValue();
            return;
          }
          flingId = requestAnimationFrame(step);
        };
        flingId = requestAnimationFrame(step);
      } else {
        commitValue();
      }
    };

    tape.addEventListener('pointerdown', onStart, { passive: true });
    tape.addEventListener('pointermove', onMove, { passive: false });
    tape.addEventListener('pointerup', finish, { passive: true });
    tape.addEventListener('pointercancel', finish, { passive: true });
    tape.addEventListener('lostpointercapture', finish, { passive: true });
  }

  // ===== Memory helpers =====
function loadMemory(){
  try{
    const raw = localStorage.getItem(MEMORY_KEY);
    const arr = raw ? JSON.parse(raw) : null;

    memorySlots = Array.from({ length: MEMORY_SLOT_COUNT }, (_, idx) =>
      parseStoredMemoryValue(Array.isArray(arr) ? arr[idx] : null)
    );

    // Save back migrated format (numbers/null only)
    saveMemory();
  } catch {
    memorySlots = Array(MEMORY_SLOT_COUNT).fill(null);
  }
  refreshMemLabels();
}

function saveMemory(){
  try{
    const sanitized = memorySlots.map(v =>
      (typeof v === 'number' && Number.isFinite(v)) ? v : null
    );
    localStorage.setItem(MEMORY_KEY, JSON.stringify(sanitized));
  }catch{}
}


  function ensureLabelSpan(btn){
    let span = btn.querySelector('.btn-label');
    if (!span){
      span = document.createElement('span');
      span.className = 'btn-label';
      span.textContent = btn.textContent;
      btn.replaceChildren(span);
    }
    return span;
  }

function formatResultInchOnlyLabel(v){
  // Build from the rounded fraction but strip arrow + inch mark for compact labels
  return formatResultInch(v)
    .fraction
    .replace(/^(?:▴ |▾ )/, '') // remove leading arrow if present
    .replace(/″/g, '');
}


function refreshMemLabels(){
  document.querySelectorAll('.btn.mem').forEach(btn=>{
    const i=+btn.dataset.mem, v=memorySlots[i];
    const text = v==null ? `M${i+1}` : formatResultInchOnlyLabel(v);
    const span = ensureLabelSpan(btn);
    span.textContent = text;
  });
  renderMemoryLiveRow();
}

/* ===== Saved Equations (manual snapshots) ===== */
const EQ_KEY = 'calcSavedEquations_v1';
let savedEq = [];

function loadSavedEq(){
  try{
    const raw = localStorage.getItem(EQ_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    savedEq = Array.isArray(arr) ? arr : [];
  }catch{
    savedEq = [];
  }
}

function saveSavedEq(){
  try{
    localStorage.setItem(EQ_KEY, JSON.stringify(savedEq));
  }catch{}
}

function formatEqTimestamp(ts){
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
}

function copyEqText(text){
  if (!text) return;
  if (navigator.clipboard?.writeText){
    navigator.clipboard.writeText(text).then(()=> showToast('Equation copied')).catch(()=> fallbackCopy());
  } else {
    fallbackCopy();
  }

  function fallbackCopy(){
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try{
      document.execCommand('copy');
      showToast('Equation copied');
    }catch{}
    ta.remove();
  }
}

function canonicalEquationDisplay(expr='', frac=''){
  const exprText = String(expr || '').trim();
  const fracText = String(frac || '').trim();
  if (exprText && fracText){
    return `${exprText} = ${fracText}`.trim();
  }
  return (exprText || fracText).trim();
}

function renderSavedEq(){
  const list = document.getElementById('eqList');
  if (!list) return;

  if (!savedEq.length){
    list.innerHTML = '<p class="eq-empty">No saved equations yet.</p>';
    return;
  }

  const esc = (s='') => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

  list.innerHTML = savedEq.map(item => {
    const exprText = esc((item.expr || '').trim());
    const fracText = esc((item.frac || '').trim());
    let line = '';
    if (exprText && fracText){
      line = `${exprText}<span class="eq-result-group"> = ${fracText}</span>`;
    } else {
      line = exprText || fracText;
    }
    const meta = esc(item.label && item.label.trim() ? item.label : formatEqTimestamp(item.ts));
    return `
      <div class="eq-row" data-id="${item.id}">
        <button class="eq-body" type="button">
          <div class="eq-equation">${line}</div>
          <div class="eq-meta" data-id="${item.id}">${meta}</div>
        </button>
        <div class="eq-actions">
          <button class="eq-load" type="button" aria-label="Load equation" data-id="${item.id}">⤓</button>
          <button class="eq-delete" type="button" aria-label="Delete equation" data-id="${item.id}">🗑</button>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.eq-body').forEach(btn => {
    const row = btn.closest('.eq-row');
    const id = row?.dataset.id;
    btn.addEventListener('click', () => {
      const item = savedEq.find(eq => eq.id === id);
      if (!item) return;
      const text = [item.expr, item.frac].filter(Boolean).join(' = ');
      copyEqText(text);
    });
  });

  list.querySelectorAll('.eq-load').forEach(btn => {
    const id = btn.dataset.id;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = savedEq.find(eq => eq.id === id);
      if (item) loadSavedEquation(item);
    });
  });

  list.querySelectorAll('.eq-delete').forEach(btn => {
    const id = btn.dataset.id;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSavedEquation(id);
    });
  });

  list.querySelectorAll('.eq-meta').forEach(metaEl => {
    const id = metaEl.dataset.id;
    attachEqMetaRename(metaEl, id);
  });
}

function clearSavedEq(){
  if (!savedEq.length) return;
  if (!confirm('Clear all saved equations?')) return;
  savedEq = [];
  saveSavedEq();
  renderSavedEq();
  showToast('Saved equations cleared');
}

function snapshotCurrentEquation(){
  const expr = (inputLine.textContent || '').trim();
  if (!expr){
    showToast('Nothing to save');
    return;
  }
  const frac = (fractionLine.textContent || '').trim();
  const dec = (decimalLine.textContent || '').trim();
  const displayKey = canonicalEquationDisplay(expr, frac);
  if (!displayKey){
    showToast('Nothing to save');
    return;
  }

  const duplicate = savedEq.some(item => canonicalEquationDisplay(item.expr, item.frac) === displayKey);
  if (duplicate){
    showToast('This equation is already saved.');
    return;
  }

  const tokensSnapshot = tokens.map(t => (t == null ? null : String(t)));
  const displaysSnapshot = tokenDisplays.map(v => (v === undefined ? null : v));

  const item = {
    id: Date.now().toString(36) + '-' + Math.random().toString(16).slice(2),
    expr,
    frac,
    dec,
    ts: Date.now(),
    tokens: tokensSnapshot,
    displays: displaysSnapshot,
    value: Number.isFinite(lastGood?.value) ? lastGood.value : null
  };

  savedEq.unshift(item);
  if (savedEq.length > 50) savedEq.length = 50;

  saveSavedEq();
  renderSavedEq();
  showToast('Equation saved.');
}

function deleteSavedEquation(id){
  if (!id) return;
  const idx = savedEq.findIndex(eq => eq.id === id);
  if (idx < 0) return;
  if (!confirm('Delete this saved equation?')) return;
  savedEq.splice(idx, 1);
  saveSavedEq();
  renderSavedEq();
  showToast('Saved equation deleted');
}

function attachEqMetaRename(metaEl, id){
  if (!metaEl || !id) return;
  const HOLD_MS = 600;
  let timer = null;
  let suppressClick = false;
  const clear = () => {
    clearTimeout(timer);
    metaEl.classList.remove('hold');
  };
  const arm = () => {
    clearTimeout(timer);
    metaEl.classList.add('hold');
    timer = setTimeout(() => {
      metaEl.classList.remove('hold');
      renameSavedEquation(id);
      suppressClick = true;
    }, HOLD_MS);
  };

  metaEl.addEventListener('pointerdown', arm);
  metaEl.addEventListener('pointerup', clear);
  metaEl.addEventListener('pointerleave', clear);
  metaEl.addEventListener('pointercancel', clear);
  metaEl.addEventListener('touchstart', arm, { passive: true });
  metaEl.addEventListener('touchend', clear);
  metaEl.addEventListener('touchcancel', clear);
  metaEl.addEventListener('click', (e) => {
    if (suppressClick){
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

function renameSavedEquation(id){
  const item = savedEq.find(eq => eq.id === id);
  if (!item) return;
  const next = prompt('Name this equation (leave blank to reset to date):', item.label || '');
  if (next === null) return;
  const trimmed = next.trim();
  if (trimmed){
    item.label = trimmed;
  } else {
    delete item.label;
  }
  saveSavedEq();
  renderSavedEq();
}

function parseSavedValue(item){
  if (!item) return null;
  if (typeof item.value === 'number' && Number.isFinite(item.value)) return item.value;
  const decText = (item.dec || '').trim();
  if (!decText) return null;
  let num = parseFloat(decText);
  if (!Number.isFinite(num)) return null;
  if (decText.includes('′')) num *= 12;
  return num;
}

function loadSavedEquation(item){
  if (!item) return;
  const numeric = parseSavedValue(item);
  const resolvedValue = Number.isFinite(numeric)
    ? numeric
    : (Number.isFinite(lastGood?.value) ? lastGood.value : 0);
  const frac = item.frac || '';
  const dec = item.dec || '';

  tokens = Array.isArray(item.tokens)
    ? item.tokens.map(t => (t == null ? '' : String(t)))
    : [];
  tokenDisplays = Array.isArray(item.displays)
    ? item.displays.map(v => (v == null ? undefined : v))
    : [];

  currentEntry = '';
  currentEntryDisplay = '';
  measure = { active:false, feet:0, inches:0, inEntry:'' };

  if (tokenDisplays.length < tokens.length){
    for (let i = tokenDisplays.length; i < tokens.length; i++){
      tokenDisplays[i] = undefined;
    }
  }

  if (!tokens.length){
    tokens = [String(resolvedValue)];
    tokenDisplays = [item.expr || String(resolvedValue)];
  }

  renderHistory();
  renderOutputs(frac, dec);

  lastGood = { value:resolvedValue, fraction:frac, decimal:dec };
  updateTapeDisplay(resolvedValue);
  showToast('Equation loaded');
  if (typeof window._cmClose === 'function'){
    window._cmClose();
  }
}

/* ===== Memory Sets list (vertical rows) ===== */
const MEMORY_SETS_KEY = 'inchCalc.memorySets.v2';
let memorySets = [];

function uid(){ return Math.random().toString(36).slice(2,9); }
const sanitizeMemoryValue = (v) => (Number.isFinite(v) ? v : null);
function memorySetSignature(values){
  const normalized = [];
  const arr = Array.isArray(values) ? values : [];
  for (let i=0;i<MEMORY_SLOT_COUNT;i++){
    const val = sanitizeMemoryValue(arr[i]);
    normalized.push(val == null ? 'null' : `${val}`);
  }
  return normalized.join('|');
}

function loadMemorySets(){
  try{
    const raw = localStorage.getItem(MEMORY_SETS_KEY);
    if (!raw){
      memorySets = [];
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)){
      memorySets = [];
      return;
    }
    memorySets = parsed.map(item => {
      const rawVals = Array.isArray(item?.values) ? item.values : [];
      const values = [];
      for (let i=0;i<MEMORY_SLOT_COUNT;i++){
        const raw = rawVals[i];
        const numeric = (typeof raw === 'number') ? raw : parseFloat(raw);
        values.push(sanitizeMemoryValue(numeric));
      }
      return {
        id: item?.id || uid(),
        name: typeof item?.name === 'string' ? item.name : '',
        values
      };
    });
  }catch{
    memorySets = [];
  }
}

function saveMemorySets(){
  try{
    localStorage.setItem(MEMORY_SETS_KEY, JSON.stringify(memorySets));
  }catch{}
}

function defaultSetName(index){
  return `Set ${index}`;
}

function renderMemoryLiveRow(){
  const row = document.getElementById('memLiveRow');
  if (!row) return;
  const scrollLock = row.scrollTop;
  row.textContent = '';
  for (let i=0;i<MEMORY_SLOT_COUNT;i++){
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mem-set-slot mem-live-slot';
    btn.disabled = true;
    btn.textContent = memorySlots[i]==null ? `M${i+1}` : formatResultInchOnlyLabel(memorySlots[i]);
    row.appendChild(btn);
  }
  row.scrollTop = scrollLock;
}

function renderMemorySets(){
  const list = document.getElementById('memSetsList');
  const emptyEl = document.getElementById('memSetsEmpty');
  const counter = document.getElementById('mcCounter');
  if (!list) return;

  const prevScroll = list.scrollTop;
  list.textContent = '';

  memorySets.forEach((set, idx) => {
    const row = document.createElement('div');
    row.className = 'mem-set-row';
    row.setAttribute('role','listitem');
    row.dataset.groupId = set.id;

    const header = document.createElement('div');
    header.className = 'mem-set-header';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'mem-set-name';
    nameInput.placeholder = 'Untitled set';
    const label = (set.name && set.name.trim()) || defaultSetName(idx + 1);
    nameInput.value = label;
    header.appendChild(nameInput);

    const headActions = document.createElement('div');
    headActions.className = 'mem-set-actions';

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.className = 'mem-set-action mem-set-load';
    loadBtn.setAttribute('aria-label', 'Load saved set into memory slots');
    loadBtn.textContent = '⤓';
    headActions.appendChild(loadBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'mem-set-action mem-set-delete';
    deleteBtn.setAttribute('aria-label', 'Delete saved set');
    deleteBtn.textContent = '🗑';
    headActions.appendChild(deleteBtn);

    header.appendChild(headActions);

    const buttonsWrap = document.createElement('div');
    buttonsWrap.className = 'mem-set-buttons';

    for (let i=0;i<MEMORY_SLOT_COUNT;i++){
      const slotBtn = document.createElement('button');
      slotBtn.type = 'button';
      slotBtn.className = 'mem-set-slot';
      slotBtn.dataset.slotIndex = String(i);
      const value = set.values?.[i];
      if (!Number.isFinite(value)){
        slotBtn.classList.add('empty');
        slotBtn.textContent = '—';
        slotBtn.disabled = true;
        slotBtn.setAttribute('aria-disabled','true');
      } else {
        slotBtn.textContent = formatResultInchOnlyLabel(value);
      }
      buttonsWrap.appendChild(slotBtn);
    }

    row.append(header, buttonsWrap);
    list.appendChild(row);
  });

  if (counter){
    counter.textContent = memorySets.length ? `${memorySets.length} saved` : '0 saved';
  }
  if (emptyEl){
    emptyEl.style.display = memorySets.length ? 'none' : 'block';
  }

  if (memorySets.length){
    const maxScroll = list.scrollHeight - list.clientHeight;
    list.scrollTop = Math.max(0, Math.min(prevScroll, maxScroll));
  } else {
    list.scrollTop = 0;
  }
}

function clearMemorySlots(){
  memorySlots = Array(MEMORY_SLOT_COUNT).fill(null);
  saveMemory();
  refreshMemLabels();
  showToast('Memory cleared');
}

function addCurrentSlotsAsSet(){
  const values = memorySlots.map(v => sanitizeMemoryValue(v));
  if (!values.some(v => v != null)){
    showToast('Nothing to save');
    return;
  }
  const signature = memorySetSignature(values);
  const duplicate = memorySets.some(set => memorySetSignature(set.values) === signature);
  if (duplicate){
    showToast('This button set is already saved.');
    return;
  }
  const set = {
    id: uid(),
    name: defaultSetName(memorySets.length + 1),
    values
  };
  memorySets.push(set);
  saveMemorySets();
  renderMemorySets();
  showToast('Button set saved.');
}

function deleteMemorySetById(id){
  const idx = memorySets.findIndex(s => s.id === id);
  if (idx < 0) return;
  if (!confirm('Delete this saved set?')) return;
  memorySets.splice(idx, 1);
  saveMemorySets();
  renderMemorySets();
  showToast('Saved set deleted');
}

function loadMemorySetById(id){
  const setIndex = memorySets.findIndex(s => s.id === id);
  if (setIndex < 0) return;
  const set = memorySets[setIndex];
  const cleaned = (set.values || []).map(v => sanitizeMemoryValue(v));
  for (let i=0;i<MEMORY_SLOT_COUNT;i++){
    memorySlots[i] = cleaned[i] ?? null;
  }
  saveMemory();
  refreshMemLabels();
  renderMemoryLiveRow();
  const name = (set.name && set.name.trim()) || defaultSetName(setIndex + 1);
  showToast(`Loaded ${name}`);
  if (typeof window._cmClose === 'function'){
    window._cmClose();
  }
}

function updateMemorySetName(id, value){
  const set = memorySets.find(s => s.id === id);
  if (!set) return;
  const trimmed = value.trim();
  set.name = trimmed || defaultSetName(memorySets.indexOf(set) + 1);
  saveMemorySets();
  renderMemorySets();
}

window.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('mcClear')?.addEventListener('click', ()=>{
    if (confirm('Clear all current memory slots? This does not delete your saved sets.')) {
      clearMemorySlots();
    }
  });
  document.getElementById('mcSaveCurrent')?.addEventListener('click', addCurrentSlotsAsSet);
});

const memSetsListEl = document.getElementById('memSetsList');
memSetsListEl?.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const deleteBtn = target.closest('.mem-set-delete');
  if (deleteBtn){
    const row = deleteBtn.closest('.mem-set-row');
    if (row?.dataset.groupId) deleteMemorySetById(row.dataset.groupId);
    return;
  }
  const loadBtn = target.closest('.mem-set-load');
  if (loadBtn){
    const row = loadBtn.closest('.mem-set-row');
    if (row?.dataset.groupId) loadMemorySetById(row.dataset.groupId);
    return;
  }
  const slotBtn = target.closest('.mem-set-slot');
  if (slotBtn && !slotBtn.disabled){
    const row = slotBtn.closest('.mem-set-row');
    const slotIdx = Number(slotBtn.dataset.slotIndex);
    const set = memorySets.find(s => s.id === row?.dataset.groupId);
    const value = set?.values?.[slotIdx];
    setTapeMode('result');
    currentEntryDisplay = '';
    insertValueIntoEntry(value);
  }
});

memSetsListEl?.addEventListener('keydown', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (target.classList.contains('mem-set-name') && e.key === 'Enter'){
    e.preventDefault();
    target.blur();
  }
});

memSetsListEl?.addEventListener('blur', (e) => {
  const input = e.target;
  if (!(input instanceof Element)) return;
  if (!input.classList.contains('mem-set-name')) return;
  const row = input.closest('.mem-set-row');
  if (!row?.dataset.groupId) return;
  updateMemorySetName(row.dataset.groupId, input.value);
}, true);


  // ===== Number / decimal entry =====
  document.querySelectorAll('.btn[data-val]').forEach(b=>b.addEventListener('click',()=>{
    const val = b.dataset.val;
    setTapeMode('result');
    currentEntryDisplay = '';
    if (measure.active){

      measure.inEntry += val;
      updateInput(); qEval();
      return;
    }
    currentEntry += val; updateInput(); qEval();
  }));

  document.querySelector('.btn.dec[data-val="."]').addEventListener('click',()=>{
    setTapeMode('result');
    currentEntryDisplay = '';
    if (measure.active){
      if (!measure.inEntry.includes('.')) measure.inEntry = measure.inEntry ? (measure.inEntry + '.') : '0.';
      updateInput(); qEval();
      return;
    }
    if (currentEntry.includes('.')) return;
    currentEntry = currentEntry ? currentEntry+'.' : '0.';
    updateInput(); qEval();
  });

  // ===== Operators =====
  document.querySelectorAll('.btn.operator[data-op]').forEach(b=>b.addEventListener('click',()=>{
    const op = b.dataset.op;
    setTapeMode('result');
    if (measure.active) finalizeMeasureToken();

    if (currentEntry){
      pushCurrentEntry();
    }
    if (!tokens.length && op !== '-') { updateInput(); qEval(); return; }

    if (isOp(tokens.at(-1))){
      tokens[tokens.length-1] = op;
    } else {
      tokens.push(op);
      tokenDisplays.push(undefined);
    }
    updateInput(); qEval();
  }));

  /* ===== Backspace: tap = 1 char. Hold 750ms = remove last number + preceding op ===== */
  const backBtn = document.querySelector('.btn.back');
  let backHoldTimer = null;
  let backHoldTriggered = false;

  function backspaceChar(){
    setTapeMode('result');
    if (measure.active){
      if (measure.inEntry){
        measure.inEntry = measure.inEntry.slice(0,-1);
      } else if (measure.inches > 0){
        measure.inches = 0;
      } else {
        measure = { active:false, feet:0, inches:0, inEntry:'' };
      }
      updateInput(); evaluate(); return;
    }
    if (currentEntry && isTypedFraction(currentEntry)){
      currentEntry = '';
      currentEntryDisplay = '';
      updateInput(); evaluate(); return;
    }

    if (currentEntry){
      currentEntry = currentEntry.slice(0,-1);
      currentEntryDisplay = '';
    } else if (tokens.length){
      let last = tokens.at(-1);
      if (isOp(last)) {
        tokens.pop(); tokenDisplays.pop();
      } else {
        last = last.slice(0,-1);
        if (last) tokens[tokens.length-1]=last;
        else { tokens.pop(); tokenDisplays.pop(); }
      }
    }
    updateInput(); evaluate();
  }

  function removeLastTermPair(){
    if (measure.active){
      measure = { active:false, feet:0, inches:0, inEntry:'' };
      if (tokens.length && isOp(tokens.at(-1))) { tokens.pop(); tokenDisplays.pop(); }
      updateInput(); evaluate(); return;
    }
    if (currentEntry){
      currentEntry = '';
      currentEntryDisplay = '';
      if (tokens.length && isOp(tokens.at(-1))) { tokens.pop(); tokenDisplays.pop(); }
      updateInput(); evaluate(); return;
    }
    if (!tokens.length){ updateInput(); evaluate(); return; }

    // Find last numeric token
    let idx = tokens.length - 1;
    while (idx >= 0 && isOp(tokens[idx])) idx--;
    if (idx < 0){ updateInput(); evaluate(); return; }

    // Remove the number
    tokens.splice(idx, 1);
    tokenDisplays.splice(idx, 1);

    // Remove the operator immediately before it, if present
    if (idx - 1 >= 0 && isOp(tokens[idx - 1])){
      tokens.splice(idx - 1, 1);
      tokenDisplays.splice(idx - 1, 1);
    }
    updateInput(); evaluate();
  }

  // Short tap
  backBtn.addEventListener('click', (e)=>{
    if (backHoldTriggered){ backHoldTriggered = false; e.preventDefault(); return; }
    backspaceChar();
  });

  // Long-hold (750ms)
  function setHoldVisual(btn, on) { if (btn) btn.classList.toggle('hold', !!on); }
  function clearBackHold(){
    clearTimeout(backHoldTimer);
    setHoldVisual(backBtn, false);
  }
  backBtn.addEventListener('pointerdown', ()=>{
    setHoldVisual(backBtn, true);
    clearTimeout(backHoldTimer);
    backHoldTimer = setTimeout(()=>{
      setHoldVisual(backBtn, false);
      backHoldTriggered = true;     // block subsequent click
      removeLastTermPair();
    }, 750);
  });
  backBtn.addEventListener('pointerup', clearBackHold);
  backBtn.addEventListener('pointercancel', clearBackHold);
  backBtn.addEventListener('mouseleave', clearBackHold);

  // ===== Clear =====
  document.querySelector('.btn.clear[data-action="clear"]').addEventListener('click',()=>{
    setTapeMode('result');
    tokens=[]; tokenDisplays=[]; currentEntry=''; currentEntryDisplay=''; measure = { active:false, feet:0, inches:0, inEntry:'' };
    inputLine.textContent='';
renderOutputs('', '');

    tapeEntryCenter = 0;
    tapeEntryTouched = true;
    updateTapeDisplay(0);
    setRepeatEnabled(false);
  });

// ===== Feet behavior (tap = commit feet; long-press = preview feet; mixed/fraction friendly) =====
const feetBtn = document.getElementById('feetBtn');

// --- helpers just for Ft handling ---
const isWholeOrWholeDot = (s) => /^[+-]?\d+\.?$/.test(s);      // "1" or "1."
const isTypedFraction   = (s) => /^[+-]?\d+\s*\/\s*\d+$/.test(s);
function fracToDecimal(s){
  const m = s.match(/^\s*([+-])?\s*(\d+)\s*\/\s*(\d+)\s*$/);
  if (!m) return null;
  const sign = m[1]==='-' ? -1 : 1;
  const n = +m[2], d = +m[3];
  if (!d) return null;
  return sign * (n/d);
}
function lastNumericIndex(){
  let i = tokens.length - 1;
  while (i >= 0 && isOp(tokens[i])) i--;
  return i;
}

// --- click → commit feet (whole/decimal/fraction or convert last mixed token) ---
let suppressFeetClick = false;
feetBtn.addEventListener('click', (e) => {
  setTapeMode('result');
  currentEntryDisplay = '';
  if (suppressFeetClick) {        // swallow the click that follows a long-press
    suppressFeetClick = false;
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  // A) Current entry is a fraction → treat it as feet (e.g., "1/2" Ft → 6")
  if (currentEntry && isTypedFraction(currentEntry)){
    const ft = fracToDecimal(currentEntry);           // feet as decimal
    if (ft != null){
      const totalIn = ft * 12;
      tokens.push(String(totalIn));
      tokenDisplays.push(`${currentEntry}\u2032`);     // show 1/2′ in history
      currentEntry = '';
      updateInput(); qEval();
      return;
    }
  }

  // B) No current entry: if last token looks like mixed or fraction, convert it to feet
  if (!currentEntry){
    const i = lastNumericIndex();
    if (i >= 0){
      const disp = tokenDisplays[i];
      const looksMixed = disp && /^\s*[+-]?\d+\s+\d+\/\d+\s*$/.test(disp);   // "1 1/2"
      const looksFrac  = disp && /^\s*[+-]?\d+\/\d+\s*$/.test(disp);         // "1/2"
      const alreadyFeet = disp && disp.includes('′');

      if (!alreadyFeet && (looksMixed || looksFrac)){
        const val = parseFloat(tokens[i]);            // numeric inches (e.g., 1.5)
        if (!Number.isNaN(val)){
          tokens[i] = String(val * 12);               // reinterpret as feet ⇒ inches
          tokenDisplays[i] = disp + '\u2032';         // add prime to the label
          updateInput(); qEval();
          return;
        }
      }
    }
  }

  // C) Normal paths: decimal feet or whole feet start/commit
  if (isDec(currentEntry)){
    const ft = parseFloat(currentEntry);
    const total = ft * 12;
    tokens.push(String(total));
    tokenDisplays.push(`${ft}\u2032`);
    currentEntry='';
    updateInput(); qEval();
    return;
  }
  if (isWholeOrWholeDot(currentEntry)){
    // start feet-builder if desired (treat "1." as "1")
    const feetWhole = parseInt(currentEntry,10);
    measure = { active:true, feet: feetWhole, inches:0, inEntry:'' };
    currentEntry='';
    updateInput(); qEval();
    return;
  }
  if (!currentEntry) return;

  // D) Loose parse fallback (e.g., "1.5")
  const ftLoose = parseFloat(currentEntry);
  if (!Number.isNaN(ftLoose)){
    const total = ftLoose * 12;
    tokens.push(String(total));
    tokenDisplays.push(`${ftLoose}\u2032`);
    currentEntry='';
    updateInput(); qEval();
  }
});

// --- long-press (600ms) → temporarily show results in feet while held
let feetHoldTimer = null;
let feetPeekActive = false;

function startFeetPeek(){
  if (feetPeekActive) return;
  feetPeekActive = true;
  displayMode = 'feet';
  setHoldVisual(feetBtn, true);   // uses your existing .btn.hold pulse
  evaluate();
}
function endFeetPeek(){
  if (!feetPeekActive) return;
  feetPeekActive = false;
  displayMode = 'inch';
  setHoldVisual(feetBtn, false);
  evaluate();
}

// Pointer (covers mouse + touch with Pointer Events)
feetBtn.addEventListener('pointerdown', () => {
  clearTimeout(feetHoldTimer);
  feetHoldTimer = setTimeout(() => {
    suppressFeetClick = true;     // prevent the click after a hold
    startFeetPeek();
  }, 600);
});
function clearFeetHold(){

  clearTimeout(feetHoldTimer);
  endFeetPeek();
}
feetBtn.addEventListener('pointerup', clearFeetHold);
feetBtn.addEventListener('pointercancel', clearFeetHold);
feetBtn.addEventListener('pointerleave', clearFeetHold);

// Optional: keyboard “hold to peek” (Space)
feetBtn.addEventListener('keydown', (e) => {
  if (e.code === 'Space'){
    e.preventDefault();
    startFeetPeek();
  }
});
feetBtn.addEventListener('keyup', (e) => {
  if (e.code === 'Space'){
    e.preventDefault();
    suppressFeetClick = true;     // Space would also fire click on button
    endFeetPeek();
  }
});


// ===== Memory buttons =====
function pushCurrentEntry(){
  if (!currentEntry) return;
  tokens.push(currentEntry);
  tokenDisplays.push(currentEntryDisplay ? currentEntryDisplay : undefined);
  currentEntry = '';
  currentEntryDisplay = '';
}

function insertValueIntoEntry(value, options = {}){
  if (!Number.isFinite(value)) return;
  if (measure.active) finalizeMeasureToken();
  const replaceIfNoOp = options.replaceIfNoOp === true;
  const displayOverride = options.display ? String(options.display) : '';
  if (currentEntry){
    const shouldReplace = replaceIfNoOp && tokens.length === 0;
    if (!shouldReplace){
      pushCurrentEntry();
    }
  }
  currentEntry = String(value);
  currentEntryDisplay = displayOverride;
  updateInput();
  evaluate();
}

function storeToMem(btn){
  let expr=[...tokens];
  if (currentEntry) expr.push(currentEntry);
  while (expr.length && isOp(expr.at(-1))) expr.pop();

  let base = expr.length ? math.evaluate(expr.join(' ')) : 0;
  let valNum = (typeof base === 'number' ? base : base.toNumber())
             + (measure.active ? measureTotal() : 0);

  const i = +btn.dataset.mem;
  const existingLabel = memorySlots[i]==null ? null : formatResultInchOnlyLabel(memorySlots[i]);
  const confirmReplace = memorySlots[i]!=null
    ? confirm(`Overwrite M${i+1}${existingLabel ? ` (${existingLabel})` : ''} with the current value?`)
    : true;
  if (!confirmReplace) return;

  memorySlots[i] = valNum;
  saveMemory();
  refreshMemLabels();

  // Saved flash
  btn.classList.add('saved');
  setTimeout(() => btn.classList.remove('saved'), 480);
}

function recallFromMem(btn){
  setTapeMode('result');
  currentEntryDisplay = '';
  const i = +btn.dataset.mem;
  const v = memorySlots[i];

  // Empty slot? Tap = save current result into this slot (no confirm).
  if (v == null){
    storeToMem(btn, /*skipConfirm=*/true);
    return;
  }

  // Filled slot → recall (existing behavior)
  insertValueIntoEntry(v);
}


document.querySelectorAll('.btn.mem').forEach(btn=>{
  // Per-button guards
  btn._recallTimer = null;
  btn._preventNextClick = false;   // set true by LP or dblclick to block ensuing click

  // Tap = recall (debounced so a dblclick won’t recall first)
  btn.addEventListener('click', (e) => {
    if (btn._preventNextClick){
      btn._preventNextClick = false;
      return;
    }
    if (e.detail && e.detail > 1){  // second click of a dblclick
      clearTimeout(btn._recallTimer);
      return;
    }
    clearTimeout(btn._recallTimer);
    btn._recallTimer = setTimeout(() => recallFromMem(btn), 300);
  });

  // Double-click = store
  btn.addEventListener('dblclick', (e) => {
    clearTimeout(btn._recallTimer);
    btn._preventNextClick = true; // block the synthetic click that follows
    e.preventDefault();
    e.stopImmediatePropagation();
    storeToMem(btn);
  });

  // Long-press (touch) = store directly (no dispatching dblclick)
  let lpTimer = null;
  btn.addEventListener('touchstart', () => {
    setHoldVisual(btn, true);
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      btn._preventNextClick = true; // swallow the click after touchend
      setHoldVisual(btn, false);
      storeToMem(btn);
    }, 600);
  }, { passive: true });

  function clearLP(){
    clearTimeout(lpTimer);
    setHoldVisual(btn, false);
  }
  btn.addEventListener('touchend', clearLP, { passive: true });
  btn.addEventListener('touchcancel', clearLP, { passive: true });
});

/* ===== FRACTION BUTTON PALETTES ===== */


  /* ===== FRACTION BUTTON PALETTES ===== */
  const FRACTION_PALETTES = {
     '1/16': { bg: '#1a75ff', fg:'#fff' },
     '1/8': { bg: '#66a3ff', fg:'#fff' },
     '3/16': { bg: '#1a75ff', fg:'#fff' },
     '1/4': { bg: '#66a3ff', fg:'#fff' },
     '5/16': { bg: '#1a75ff', fg:'#fff' },
     '3/8': { bg: '#66a3ff', fg:'#fff' },
     '7/16': { bg: '#1a75ff', fg:'#fff' },
     '1/2': { bg: '#66a3ff', fg:'#fff' },
     '9/16': { bg: '#1a75ff', fg:'#fff' },
     '5/8': { bg: '#66a3ff', fg:'#fff' },
     '11/16': { bg: '#1a75ff', fg:'#fff' },
     '3/4': { bg: '#66a3ff', fg:'#fff' },
     '13/16': { bg: '#1a75ff', fg:'#fff' },
     '7/8': { bg: '#66a3ff', fg:'#fff' },
     '15/16': { bg: '#1a75ff', fg:'#fff' },
  };

  function fallbackFor(frac){
    const [n,d] = frac.split('/').map(Number);
    if (!n || !d) return { bg: 'hsl(210 70% 50%)', fg:'#fff' };
    const t = Math.max(0, Math.min(1, n/d));
    const h = 210 + t * 120; /* blue → magenta */
    const s = 70, l = 50;
    return { bg: `hsl(${h} ${s}% ${l}%)`, fg:'#fff' };
  }

  function applyFractionPalettes(){
    document.querySelectorAll('.btn.frac[data-frac]').forEach(el=>{
      const key = el.getAttribute('data-frac');
      const conf = { ...fallbackFor(key), ...(FRACTION_PALETTES[key]||{}) };
      if (conf.bg) el.style.setProperty('--btn-bg', conf.bg);
      if (conf.fg) el.style.setProperty('--btn-fg', conf.fg);
      if (conf.img) el.style.setProperty('--btn-img', conf.img);
      if (conf.hoverBg) el.style.setProperty('--btn-hover-bg', conf.hoverBg);
      if (conf.activeBg) el.style.setProperty('--btn-active-bg', conf.activeBg);
    });
  }

  // ===== Fractions input handling =====
  document.querySelectorAll('.btn.frac').forEach(b=>b.addEventListener('click',()=>{
    setTapeMode('result');
    const f=b.dataset.frac;
    const [n,d]=f.split('/').map(Number);
    const fVal = n/d;

    if (measure.active){
      if (!measure.inEntry){
        measure.inches += fVal;
      } else {
        const base = parseFloat(measure.inEntry);
        measure.inches += base + fVal;
        measure.inEntry = '';
      }
      updateInput(); qEval();
      return;
    }

  if (!currentEntry) {
      currentEntry = f;
} else if (isWhole(currentEntry)) {
  const whole = parseInt(currentEntry, 10);
  const combined = whole + fVal;
  tokens.push(String(combined));
  // History should reflect the user's intent explicitly: "1 1/2"
  tokenDisplays.push(`${whole} ${f}`);
  currentEntry = '';
  currentEntryDisplay = '';
}
 else {
      pushCurrentEntry();
      tokens.push('+');         tokenDisplays.push(undefined);
      currentEntry=f;
    }
    updateInput(); qEval();
  }));

  // ---- UI helpers: ripples / hold visuals / copy-to-clipboard / toasts
  function attachRipples() {
    document.querySelectorAll('.btn').forEach(btn => {
      btn.addEventListener('pointerdown', (e) => {
        const rect = btn.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const ripple = document.createElement('span');
        ripple.className = 'ripple';
        const maxDim = Math.max(rect.width, rect.height);
        ripple.style.width = ripple.style.height = maxDim * 1.2 + 'px';
        ripple.style.left = x + 'px';
        ripple.style.top = y + 'px';
        btn.appendChild(ripple);
        ripple.addEventListener('animationend', () => ripple.remove());
      });
    });
  }

  // Touch-friendly pressed state
  function attachPressState(){
    document.querySelectorAll('.btn').forEach(btn=>{
      const set = on => { if (!btn.disabled) btn.classList.toggle('pressed', !!on); };
      btn.addEventListener('pointerdown', ()=> set(true));
      btn.addEventListener('pointerup',   ()=> set(false));
      btn.addEventListener('pointercancel',()=> set(false));
      btn.addEventListener('mouseleave',  ()=> set(false));
    });
  }

  function showToast(msg='Copied', ms=3400){
    const toast = document.getElementById('copyToast');
    if (!toast) return;
    toast.querySelector('span').textContent = msg;
    toast.style.display='flex';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=>{ toast.style.display='none'; }, ms);
  }
  function enableClickCopy(selector){
    document.querySelectorAll(selector).forEach(el=>{
      el.style.cursor='pointer';
      el.addEventListener('click', () => {
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return; // let manual selection win
        const text = (el.textContent || '').trim();
        if (!text) return;
        if (navigator.clipboard?.writeText){
          navigator.clipboard.writeText(text).then(()=> showToast('Copied'));
        } else {
          const ta = document.createElement('textarea');
          ta.value = text; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); showToast('Copied'); } catch {}
          ta.remove();
        }
      });
    });
  }
  // Generic direction-lock gesture helper for touch + pointer events
  function attachDirectionLockedGestures(container, options = {}){
    const LOCK_THRESHOLD = options.lockThreshold ?? 10;     // px needed before we decide
    const DIRECTION_BIAS = options.directionBias ?? 4;      // px the leading axis must beat the other by
    let active = false;
    let gestureDirection = null;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let pointerId = null;
    let lastDx = 0;
    let lastDy = 0;

    const getPoint = (evt) => {
      if (evt.touches && evt.touches[0]) return evt.touches[0];
      if (evt.changedTouches && evt.changedTouches[0]) return evt.changedTouches[0];
      return evt;
    };
    const reset = () => {
      active = false;
      gestureDirection = null;
      pointerId = null;
      lastDx = 0;
      lastDy = 0;
      startTime = 0;
    };

    function handleStart(evt){
      if (evt.pointerType === 'mouse' && evt.button !== 0) return;
      if (evt.touches && evt.touches.length > 1) return; // ignore pinch/zoom
      if (active) return; // ignore secondary touches while a gesture is running
      if (typeof options.shouldStart === 'function' && options.shouldStart(evt) === false) return;

      const point = getPoint(evt);
      if (!point) return;

      startX = point.clientX;
      startY = point.clientY;
      startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      pointerId = evt.pointerId ?? null;
      active = true;
      gestureDirection = null;
      lastDx = 0;
      lastDy = 0;

      options.onStart?.(evt, { startX, startY, startTime });
    }

    function handleMove(evt){
      if (!active) return;
      if (evt.touches && evt.touches.length > 1) return;
      if (pointerId != null && evt.pointerId != null && evt.pointerId !== pointerId) return;

      const point = getPoint(evt);
      if (!point) return;

      const dx = point.clientX - startX;
      const dy = point.clientY - startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      lastDx = dx;
      lastDy = dy;

      if (!gestureDirection){
        if (absX < LOCK_THRESHOLD && absY < LOCK_THRESHOLD) return;

        if (absX - absY >= DIRECTION_BIAS){
          gestureDirection = 'horizontal';
        } else if (absY - absX >= DIRECTION_BIAS){
          gestureDirection = 'vertical';
        } else {
          return; // keep waiting until one axis clearly wins
        }
        options.onDirectionLocked?.(gestureDirection, evt, { dx, dy });
      }

      if (gestureDirection === 'horizontal'){
        options.onHorizontalMove?.(evt, { dx, dy });
        if (!options.passiveHorizontal && evt.cancelable){
          evt.preventDefault();
          if (options.stopHorizontalPropagation) evt.stopPropagation();
        }
      } else if (gestureDirection === 'vertical'){
        options.onVerticalMove?.(evt, { dx, dy });
        if (options.preventVerticalDefault && evt.cancelable){
          evt.preventDefault();
        }
      }
    }

    function handleEnd(evt){
      if (!active) return;
      if (pointerId != null && evt.pointerId != null && evt.pointerId !== pointerId) return;
      options.onEnd?.(evt, { direction: gestureDirection, dx: lastDx, dy: lastDy, startTime });
      reset();
    }

    const supportsPointer = 'PointerEvent' in window;
    if (supportsPointer){
      container.addEventListener('pointerdown', handleStart, { passive: true });
      container.addEventListener('pointermove', handleMove, { passive: false });
      container.addEventListener('pointerup', handleEnd, { passive: true });
      container.addEventListener('pointercancel', handleEnd, { passive: true });
    } else {
      container.addEventListener('touchstart', handleStart, { passive: true });
      container.addEventListener('touchmove', handleMove, { passive: false });
      container.addEventListener('touchend', handleEnd, { passive: true });
      container.addEventListener('touchcancel', handleEnd, { passive: true });
    }
  }

  // Chalk Line Helper (tools modal)
  function initChalkLineHelper(){
    const card = document.getElementById('chalkHelperCard');
    const chalkFeet = document.getElementById('chalkFeet');
    const chalkInches = document.getElementById('chalkInches');
    const calcBtn = document.getElementById('chalkCalcBtn');
    const resultsEl = document.getElementById('chalkResults');
    const modeLabelEl = document.getElementById('chalkModeStatus');
    const tileBtn = document.getElementById('chalkHelperTile');

    if (tileBtn){
      tileBtn.addEventListener('click', () => {
        if (typeof window._cmOpen === 'function') window._cmOpen();
        if (typeof window._cmIndexOf === 'function' && typeof window._cmGoTo === 'function' && card){
          const idx = window._cmIndexOf(card);
          if (idx >= 0) window._cmGoTo(idx);
        }
      });
    }

    if (!card || !resultsEl) return;

    const stripArrow = (text) => text.replace(/^\s*[▴▾]\s*/, '');
    const formatInchLabel = (inches) => stripArrow(formatResultInch(inches).fraction);

    function renderMessage(msg){
      resultsEl.innerHTML = `<p class="chalk-results-empty">${msg}</p>`;
    }

    function renderMarks(marks){
      if (!marks.length){
        renderMessage('Width is under 24″ — no chalk lines needed.');
        return;
      }
      const rows = marks.map(pos => {
        const left = formatInchLabel(pos);
        return `<div class="chalk-row"><div class="chalk-pos-in">${left}</div></div>`;
      }).join('');
      resultsEl.innerHTML = rows;
    }

    let lastStepInches = null;

    function updateModeLabel(){
      if (modeLabelEl){
        if (lastStepInches){
          const spacing = formatInchLabel(lastStepInches);
          modeLabelEl.textContent = `Spacing ≈ ${spacing}`;
        } else {
          modeLabelEl.textContent = 'Spacing will appear after you enter a width.';
        }
      }
    }

    function calculateMarks(){
      const feetVal = Number(chalkFeet?.value);
      const inchVal = Number(chalkInches?.value);
      let safeFeet = Number.isFinite(feetVal) ? feetVal : 0;
      if (safeFeet < 0) safeFeet = 0;
      let safeInches = Number.isFinite(inchVal) ? inchVal : 0;
      safeInches = clamp(Math.round(safeInches), 0, 11);

      if (chalkFeet && Number.isFinite(feetVal) && feetVal < 0){
        chalkFeet.value = String(safeFeet);
      }
      if (chalkInches && chalkInches.value !== ''){
        chalkInches.value = String(safeInches);
      }

      const totalInches = safeFeet * 12 + safeInches;
      if (!totalInches){
        lastStepInches = null;
        updateModeLabel();
        renderMessage('Enter a door width to see chalk marks.');
        return;
      }
      if (totalInches < 24){
        lastStepInches = null;
        updateModeLabel();
        renderMessage('Width is under 24″ — no chalk lines needed.');
        return;
      }

      const segments = Math.max(2, Math.round(totalInches / 24));
      const step = totalInches / segments;
      const marks = [];
      for (let pos = step; pos < totalInches - 1e-6; pos += step){
        marks.push(pos);
      }
      lastStepInches = step;
      updateModeLabel();
      renderMarks(marks);
    }

    calcBtn?.addEventListener('click', calculateMarks);
    [chalkFeet, chalkInches].forEach(input => {
      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter'){
          e.preventDefault();
          calculateMarks();
        }
      });
    });

    updateModeLabel();
    renderMessage('Enter a door width to see chalk marks.');
  }

  function initSegmentTape(){
    const root = document.getElementById('segmentTapeCard');
    if (!root) return;

    // ===== Helpers
    const gcd = (a, b) => b ? gcd(b, a % b) : a;

    // UPDATED: avoids outputs like 21 1/1; carries to whole when n===d
    const toReadableFraction = (x, denom = 16) => {
      if (isNaN(x)) return '';
      const sign = x < 0 ? '-' : '';
      const ax = Math.abs(x);

      // small epsilon to dodge floating artifacts
      let whole = Math.floor(ax + 1e-10);
      const frac = ax - whole;

      let n = Math.round(frac * denom);
      let d = denom;

      // carry 1 to the whole when rounding hits denom/denom
      if (n === d) { whole += 1; n = 0; }

      // reduce if needed
      if (n !== 0) {
        const div = gcd(n, d);
        n /= div; d /= div;
      }

      if (n === 0) return sign + (whole ? String(whole) : '0');

      return whole
        ? `${sign}${whole} &nbsp;&nbsp;<span class='factor'><sup>${n}</sup>/<sub>${d}</sub></span>`
        : `${sign}<span class='factor'><sup>${n}</sup>/<sub>${d}</sub></span>`;
    };

    const parseInput = input => {
      if (!input) return NaN;
      const s = String(input).trim();
      if (s.includes(' ')) {
        const [w, f] = s.split(' '), [n, d] = f.split('/').map(Number);
        return (isNaN(n)||isNaN(d)||d===0)? NaN : Number(w) + (n/d);
      }
      if (s.includes('/')) {
        const [n, d] = s.split('/').map(Number);
        return (isNaN(n)||isNaN(d)||d===0)? NaN : (n/d);
      }
      return Number(s);
    };

    // ===== Tabs
    const changeTab = choice => {
      document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
      document.getElementById(choice + 'Tab').classList.add('active');
      document.getElementById('dynamicLabel').innerText = choice === 'equal' ? 'Segments:' : 'Inches:';
      const els = document.querySelectorAll('.length, .burn, .segmentType');
      (choice === 'near') ? els.forEach(el => el.classList.add('lightgreen-bg')) : els.forEach(el => el.classList.remove('lightgreen-bg'));
      calculate();
    };

    // ===== Tape zoom state
    let marksDecimal = [];      // absolute inches from 0
    let currentMarkIndex = 0;   // pointer into marksDecimal
    let totalLengthIn = 0;      // total inches for ruler scaling
    let zoomMode = 'window';    // 'window' | 'full'
    let zoomWidth = 3;          // inches when window mode

    // ===== Ruler with zoom
    const tape = {
      left: 14, right: 14, top: 6, bottom: 8, h: 110,
      window(){
        let L = 0, R = totalLengthIn || 1;
        if (zoomMode === 'window' && marksDecimal.length){
          const center = marksDecimal[currentMarkIndex] ?? 0;
          const w = Math.max(1/8, zoomWidth); // at least 1/8" window
          if ((totalLengthIn||0) > w){
            L = Math.max(0, Math.min(center - w/2, totalLengthIn - w));
            R = L + w;
          }
        }
        this.winL = L; this.winR = Math.max(L + 1/16, R); // ensure non-zero width
        return [this.winL, this.winR];
      },
      scaleX(x, w){
        const [L, R] = this.window();
        const inner = Math.max(1, w - this.left - this.right);
        const clamped = Math.max(L, Math.min(R, x));
        return this.left + ((clamped - L) / (R - L)) * inner;
      },
      draw(){
        const wrap = document.getElementById('tapeContainer');
        if (!wrap) return;
        wrap.innerHTML = '';
        const w = wrap.clientWidth || 560, h = this.h;
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.setAttribute('role','img');

        // background
        const bg = document.createElementNS(svgNS, 'rect');
        bg.setAttribute('x', 0); bg.setAttribute('y', 0);
        bg.setAttribute('width', w); bg.setAttribute('height', h);
        bg.setAttribute('fill', 'lightyellow');
        svg.appendChild(bg);

        // baseline
        const base = document.createElementNS(svgNS, 'line');
        base.setAttribute('x1', this.left); base.setAttribute('x2', w - this.right);
        base.setAttribute('y1', h - this.bottom); base.setAttribute('y2', h - this.bottom);
        base.setAttribute('stroke', '#000'); base.setAttribute('stroke-width', 1);
        svg.appendChild(base);

        // ticks within window
        const [L, R] = this.window();
        const startF = Math.floor(L * 16);
        const endF   = Math.ceil(R * 16);

        // gradient background (classic blade vibe)
        const defs = document.createElementNS(svgNS,'defs');
        const grad = document.createElementNS(svgNS,'linearGradient');
        grad.setAttribute('id','blade'); grad.setAttribute('x1','0'); grad.setAttribute('x2','0'); grad.setAttribute('y1','0'); grad.setAttribute('y2','1');
        const s1 = document.createElementNS(svgNS,'stop'); s1.setAttribute('offset','0%');  s1.setAttribute('stop-color','#fff6a6');
        const s2 = document.createElementNS(svgNS,'stop'); s2.setAttribute('offset','100%'); s2.setAttribute('stop-color','#ffe06a');
        grad.appendChild(s1); grad.appendChild(s2); defs.appendChild(grad); svg.appendChild(defs);

        // repaint bg using gradient
        bg.setAttribute('fill','url(#blade)');

        for(let f=startF; f<=endF; f++){
          const inch = f/16;
          const x = this.scaleX(inch, w);
          const isInch = f % 16 === 0;
          const isHalf = f % 8 === 0 && !isInch;
          const isQuarter = f % 4 === 0 && !isInch && !isHalf;
          const isEighth = f % 2 === 0 && !isInch && !isHalf && !isQuarter;
          const len = isInch? 75 : isHalf? 55 : isQuarter? 40 : isEighth? 20 : 20;
          const y1 = h - this.bottom, y2 = y1 - len;
          const tick = document.createElementNS(svgNS, 'line');
          tick.setAttribute('x1', x); tick.setAttribute('x2', x);
          tick.setAttribute('y1', y1); tick.setAttribute('y2', y2);
          tick.setAttribute('stroke', '#000'); tick.setAttribute('stroke-width', (isInch? 1.5 : 1.5));
          svg.appendChild(tick);

          if (isInch){
            const label = document.createElementNS(svgNS, 'text');
            label.setAttribute('x', x+2); label.setAttribute('y', y2-6);
            label.setAttribute('font-size', 14);
            label.setAttribute('font-weight', '700');
            label.setAttribute('font-family', 'dunbar-tall, sans-serif');
            label.setAttribute('fill', '#000');
            label.textContent = String(inch.toFixed(0));
            svg.appendChild(label);
          }
        }

        // subtle edge shading
        const shadeTop = document.createElementNS(svgNS,'rect');
        shadeTop.setAttribute('x',0); shadeTop.setAttribute('y',0);
        shadeTop.setAttribute('width',w); shadeTop.setAttribute('height',8);
        shadeTop.setAttribute('fill','rgba(0,0,0,.06)');
        svg.appendChild(shadeTop);

        wrap.appendChild(svg);
        drawMarker();
      }
    };

    function drawMarker(){
      const wrap = document.getElementById('tapeContainer');
      const svg = wrap?.querySelector('svg');
      if (!svg) return;
      const w = wrap.clientWidth || 560, h = 110;
      const gOld = svg.querySelector('#marker');
      if (gOld) gOld.innerHTML = '';
      const g = gOld || document.createElementNS('http://www.w3.org/2000/svg','g');
      g.setAttribute('id','marker');

      const x = tape.scaleX(marksDecimal[currentMarkIndex] || 0, w);
      const line = document.createElementNS('http://www.w3.org/2000/svg','line');
      line.setAttribute('x1', x); line.setAttribute('x2', x);
      line.setAttribute('y1', 0); line.setAttribute('y2', h);
      line.setAttribute('stroke','#d91e18'); line.setAttribute('stroke-width','4');

      const tri = document.createElementNS('http://www.w3.org/2000/svg','polygon');
      const t = 8; // size
      tri.setAttribute('fill','#d91e18');

      g.appendChild(tri); g.appendChild(line);
      svg.appendChild(g);

      // label update
      document.getElementById('markIndex').textContent = marksDecimal.length? (currentMarkIndex+1) : 'ƒ?"';
      document.getElementById('markCount').textContent = marksDecimal.length;
      const v = marksDecimal[currentMarkIndex] || 0;
      document.getElementById('markFrac').innerHTML = toReadableFraction(v);
    }

    function gotoMark(i){
      if (!marksDecimal.length) return;
      currentMarkIndex = Math.max(0, Math.min(marksDecimal.length-1, i));
      tape.draw(); // re-center window on the new mark
    }

    // ===== Main calculate (original + hook)
    const calculate = () => {
      const [lengthInput, endDistanceInput, valueUsedInput] = [document.getElementById('length').value, document.getElementById('endDistance').value, document.getElementById('valueUsed').value];
      const method = document.querySelector('.tab.active').id.startsWith('equal') ? 'equal' : 'near';
      const [length, endDistance, valueUsed] = [parseInput(lengthInput), parseInput(endDistanceInput), parseInput(valueUsedInput)];

      if (isNaN(length) || isNaN(endDistance) || isNaN(valueUsed)) {
        document.getElementById('segmentResult').innerText = 'Please enter valid numbers or fractions.';
        document.getElementById('marksResult').innerHTML = '';
        marksDecimal = []; totalLengthIn = 0; tape.draw();
        return;
      }

      let remainingLength = length - 2 * endDistance, segments = [toReadableFraction(endDistance)], segmentLength, numSegments;
      if (method === 'equal') { numSegments = Math.max(1, Math.round(valueUsed)); segmentLength = remainingLength / numSegments; }
      else { const exactNumSegments = remainingLength / valueUsed; numSegments = Math.max(1, Math.round(exactNumSegments)); segmentLength = remainingLength / numSegments; }

      // build marks list (including end burn and each segment)
      marksDecimal = [endDistance];
      for (let i = 0; i < numSegments; i++){
        const p = (i + 1) * segmentLength + endDistance;
        marksDecimal.push(p);
        segments.push(toReadableFraction(p));
      }

      document.getElementById('segmentResult').innerHTML = `Segment length: ${toReadableFraction(segmentLength)}"`;
      document.getElementById('marksResult').innerHTML = `Marks:<br><br>${segments.join('"<hr><br>')} `;

      totalLengthIn = Math.max(0, length);
      tape.draw();
      gotoMark(0);
    };

    // ===== Debounce
    let debounceTimer;
    const debounceCalculate = () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(calculate, 200); };

    // ===== Button press helper (click vs long-press) + no-select cleanup + keyboard
    function attachPress(btn, onClick, onLongPress){
      const HOLD_MS = 500; // long-press threshold
      let timer = null, longed = false;

      const clearSelection = () => {
        const sel = window.getSelection && window.getSelection();
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
      };

      const start = (e) => {
        longed = false;
        if (e && typeof e.preventDefault === 'function') e.preventDefault(); // avoid ghost click
        clearSelection(); // nuke any existing text highlight (iOS/Android)
        timer = setTimeout(() => {
          longed = true;
          onLongPress();
          if (navigator.vibrate) try { navigator.vibrate(12); } catch {}
        }, HOLD_MS);
      };
      const clear = () => { if (timer) clearTimeout(timer); timer = null; };
      const end = () => { clear(); if (!longed) onClick(); };

      if ('PointerEvent' in window){
        btn.addEventListener('pointerdown', start, {passive:false});
        btn.addEventListener('pointerup', end);
        btn.addEventListener('pointerleave', clear);
        btn.addEventListener('pointercancel', clear);
      } else {
        btn.addEventListener('mousedown', start);
        btn.addEventListener('mouseup', end);
        btn.addEventListener('mouseleave', clear);
        btn.addEventListener('touchstart', start, {passive:false});
        btn.addEventListener('touchend', end);
        btn.addEventListener('touchcancel', clear);
      }

      // Keyboard support (Enter / Space to "click")
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      });

      // Stop context menu on long-press
      btn.addEventListener('contextmenu', (e)=> e.preventDefault());
    }

    // ===== Listeners
    // tabs
    document.getElementById('equalTab').addEventListener('keydown', e=>{ if (e.key === 'Enter') { e.preventDefault(); changeTab('equal'); }});
    document.getElementById('nearTab').addEventListener('keydown',  e=>{ if (e.key === 'Enter') { e.preventDefault(); changeTab('near');  }});
    document.getElementById('equalTab').addEventListener('click', ()=> changeTab('equal'));
    document.getElementById('nearTab').addEventListener('click',  ()=> changeTab('near'));

    // inputs
    document.getElementById('length').addEventListener('input', debounceCalculate);
    document.getElementById('endDistance').addEventListener('input', debounceCalculate);
    document.getElementById('valueUsed').addEventListener('input', debounceCalculate);

    // tape nav buttons: click vs long-press
    const prevBtn = document.getElementById('prevMark');
    const nextBtn = document.getElementById('nextMark');
    attachPress(prevBtn,
      ()=> gotoMark(currentMarkIndex-1),            // click
      ()=> gotoMark(0)                              // long-press -> first
    );
    attachPress(nextBtn,
      ()=> gotoMark(currentMarkIndex+1),            // click
      ()=> gotoMark(Math.max(0, marksDecimal.length-1)) // long-press -> last
    );

    // tape redraw on resize
    window.addEventListener('resize', ()=> tape.draw());

    // ===== Swipe / Wheel / Keyboard navigation on the tape
    (() => {
      const el = document.getElementById('tapeContainer');

      // Keyboard left/right when the tape has focus
      el.setAttribute('tabindex', '0');
      el.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft')  { e.preventDefault(); gotoMark(currentMarkIndex - 1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); gotoMark(currentMarkIndex + 1); }
      });

      // Trackpad/mouse horizontal swipe (wheel) support with a short throttle
      let lastWheel = 0;
      el.addEventListener('wheel', (e) => {
        // Only react to mostly-horizontal gestures
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
        const now = performance.now();
        if (now - lastWheel < 180) return; // throttle
        lastWheel = now;
        e.preventDefault();
        if (e.deltaX > 0) gotoMark(currentMarkIndex + 1);
        else              gotoMark(currentMarkIndex - 1);
      }, { passive: false });

      // Touch/mouse swipe with Pointer Events (plus a touch fallback)
      const THRESH = 28; // px horizontal movement required to count as a swipe

      function installPointerSwipe(target) {
        let sx = 0, sy = 0, tracking = false, handled = false;

        const onDown = (x, y, id) => {
          sx = x; sy = y; tracking = true; handled = false;
          target.setPointerCapture?.(id);
        };

        const onMove = (x, y, rawEvt) => {
          if (!tracking || handled) return;
          const dx = x - sx, dy = y - sy;
          // Require mostly-horizontal + threshold
          if (Math.abs(dx) < THRESH || Math.abs(dx) <= Math.abs(dy)) return;

          handled = true; // one step per swipe
          if (dx < 0) gotoMark(currentMarkIndex + 1);
          else        gotoMark(currentMarkIndex - 1);
          rawEvt.preventDefault(); // stop accidental page moves now that we handled it
        };

        const onUp = (id) => {
          tracking = false; handled = false;
          try { target.releasePointerCapture?.(id); } catch {}
        };

        if ('PointerEvent' in window) {
          target.addEventListener('pointerdown', e => onDown(e.clientX, e.clientY, e.pointerId), { passive: true });
          target.addEventListener('pointermove', e => onMove(e.clientX, e.clientY, e), { passive: false });
          target.addEventListener('pointerup',   e => onUp(e.pointerId), { passive: true });
          target.addEventListener('pointercancel', e => onUp(e.pointerId), { passive: true });
        } else {
          // iOS <13 fallback
          target.addEventListener('touchstart', e => { const t = e.changedTouches[0]; onDown(t.clientX, t.clientY, 0); }, { passive: true });
          target.addEventListener('touchmove',  e => { const t = e.changedTouches[0]; onMove(t.clientX, t.clientY, e); }, { passive: false });
          target.addEventListener('touchend',   () => onUp(0), { passive: true });
          target.addEventListener('touchcancel',() => onUp(0), { passive: true });
        }
      }

      installPointerSwipe(el);
    })();

    // ===== Modal
    const modal = document.getElementById('instructionsModal');
    const showModalBtn = document.getElementById('showModalBtn');
    const closeModalBtn = document.getElementById('closeModalBtn');
    function openModal() { modal.style.display = "block"; closeModalBtn.focus(); }
    function closeModal() { modal.style.display = "none"; showModalBtn.focus(); }
    showModalBtn.addEventListener('click', openModal);
    closeModalBtn.addEventListener('click', closeModal);
    closeModalBtn.addEventListener('keypress', function(event) { if (event.key === 'Enter' || event.keyCode === 13) { closeModal(); }});
    window.addEventListener('click', function(event) { if (event.target === modal) { closeModal(); }});

    // ===== Start
    calculate();

    window._segmentTapeRefresh = () => {
      requestAnimationFrame(() => tape.draw());
    };
  }

  /* ===== Carousel Modal (cards only, not full-screen screenshot) ===== */
(function carouselModal(){
  const backdrop = document.getElementById('cmBackdrop');
  const track = document.getElementById('cmTrack');
  const dotsWrap = document.getElementById('cmDots');
  const prevBtn = document.getElementById('cmPrev');
  const nextBtn = document.getElementById('cmNext');
  const closeBtn = document.getElementById('cmClose');
  const openBtn  = document.getElementById('menuBtn');
  const memPreview = document.getElementById('cmMemPreview');

  const slideCount = track ? track.children.length : 0;
  let idx = 0;
  let lastFocus = null;

  // Build dots
  function buildDots(){
    if (!dotsWrap) return;
    dotsWrap.innerHTML = '';
    for (let i=0;i<slideCount;i++){
      const b = document.createElement('button');
      b.className = 'cm-dot';
      b.setAttribute('role','tab');
      b.setAttribute('aria-label', `Slide ${i+1}`);
      b.addEventListener('click', ()=> goTo(i));
      dotsWrap.appendChild(b);
    }
  }

  function syncUI(){
    // Move the track
    track.style.transform = `translateX(${(-idx*100)}%)`;
    // Dots
    [...dotsWrap.children].forEach((d,i)=> d.setAttribute('aria-selected', i===idx ? 'true' : 'false'));
    // Prev/Next disabled?
    prevBtn.disabled = (idx===0);
    nextBtn.disabled = (idx===slideCount-1);
  }

  function goTo(n){
    idx = Math.max(0, Math.min(slideCount-1, n));
    syncUI();
  }
  const next = () => goTo(idx+1);
  const prev = () => goTo(idx-1);

  // Open/close
  function open(){
    if (!backdrop) return;
    lastFocus = document.activeElement;
    backdrop.setAttribute('aria-hidden','false');
    renderMemoryPreview();
    renderSavedEq();
    buildDots();
    syncUI();
    // focus close for accessibility
    setTimeout(()=> closeBtn?.focus(), 0);
    // block body touch scroll while open except inside card
    document.body.style.overscrollBehavior = 'contain';
  }
  function close(){
    backdrop.setAttribute('aria-hidden','true');
    document.body.style.overscrollBehavior = '';
    lastFocus?.focus?.();
  }

  // Hook existing menu button
  openBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  backdrop?.addEventListener('click', (e)=>{ if (e.target === backdrop) close(); });
  document.addEventListener('keydown', (e)=>{
    if (backdrop.getAttribute('aria-hidden') === 'true') return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') next();
    if (e.key === 'ArrowLeft') prev();
  });

  // Swipe (track moves horizontally, cards scroll vertically)
  (function enableSwipe(){
    const viewport = backdrop?.querySelector('.cm-viewport');
    if (!viewport || !track) return;

    let width = 1;
    let dragging = false;
    const shouldIgnoreDrag = (target) => target?.closest?.('#memSetsList');

    attachDirectionLockedGestures(viewport, {
      lockThreshold: 10,
      directionBias: 4,
      stopHorizontalPropagation: true,
      shouldStart(evt){
        return !shouldIgnoreDrag(evt.target);
      },
      onStart(){
        width = viewport.clientWidth || 1;
        dragging = false;
        track.classList.remove('dragging');
      },
      onDirectionLocked(dir){
        if (dir === 'horizontal'){
          dragging = true;
          track.classList.add('dragging');
        } else {
          dragging = false;
          track.classList.remove('dragging');
        }
      },
      onHorizontalMove(_, { dx }){
        if (!dragging) return;
        const pct = (dx / width) * 100;
        track.style.transform = `translateX(${(-idx*100 + pct)}%)`;
      },
      onEnd(_, { direction, dx }){
        if (!dragging || direction !== 'horizontal'){
          track.classList.remove('dragging');
          dragging = false;
          return;
        }
        dragging = false;
        track.classList.remove('dragging');
        const threshold = Math.max(60, width * 0.18); // pixels
        if (dx > threshold) prev();
        else if (dx < -threshold) next();
        else syncUI(); // snap back
      }
    });
  })();

  // Dynamic memory preview (reads your existing memorySlots)
  function renderMemoryPreview(){
    if (!memPreview) return;
    const cells = [];
    for (let i=0;i<MEMORY_SLOT_COUNT;i++){
      const v = memorySlots[i];
      const display = (v==null) ? '—' : formatResultInch(v).fraction.replace('″','');
      cells.push(`<div class="cm-memcell"><span class="k">M${i+1}</span><span class="v">${display}</span></div>`);
    }
    memPreview.innerHTML = cells.join('');
  }

  // Expose a tiny API if you want to deep-link a slide later:
  window._cmGoTo = goTo; // e.g., _cmGoTo(3)
	  window._cmOpen = open;
  window._cmIndexOf = (el) => Array.from(track.children).indexOf(el);
  window._cmClose = close;
														  
															  
})();


  /* ====== REPEAT BUTTON ====== */
  const repeatBtn = document.getElementById('repeatBtn');

  function canRepeat(){
    if (measure.active){
      const hasOpBefore = tokens.length && isOp(tokens.at(-1));
      const hasSomeMeasure = (measure.feet || measure.inches || measure.inEntry);
      return hasOpBefore && hasSomeMeasure;
    }
    if (currentEntry){
      return tokens.length && isOp(tokens.at(-1));
    }
    const n = tokens.length;
    return n >= 2 && isOp(tokens[n-2]) && !isOp(tokens[n-1]);
  }

  function setRepeatEnabled(on){
    if (!repeatBtn) return;
    repeatBtn.disabled = !on;
  }

  function commitPendingIfPair(){
    if (measure.active && tokens.length && isOp(tokens.at(-1))){
      finalizeMeasureToken();
    }
    if (currentEntry && tokens.length && isOp(tokens.at(-1))){
      pushCurrentEntry();
    }
  }

  function findLastPair(){
    const n = tokens.length;
    if (n >= 2 && isOp(tokens[n-2]) && !isOp(tokens[n-1])){
      return { opIdx: n-2, termIdx: n-1 };
    }
    return null;
  }

  function doRepeat(){
    if (!canRepeat()) return;
    commitPendingIfPair();

    const pair = findLastPair();
    if (!pair) { setRepeatEnabled(false); updateInput(); qEval(); return; }

    const op = tokens[pair.opIdx];
    const term = tokens[pair.termIdx];
    const disp = tokenDisplays[pair.termIdx];

    tokens.push(op);   tokenDisplays.push(undefined);
    tokens.push(term); tokenDisplays.push(disp);

    updateInput(); qEval();
  }

  repeatBtn.addEventListener('click', doRepeat);

  // Init tape once it has width
  function initTape(){
    const r=tape.getBoundingClientRect();
    if(!r.width){ requestAnimationFrame(initTape); return; }
    updateTapeDisplay(0);
  }

  // Block selection/callout on buttons only (not outputs/history)
  document.addEventListener('selectstart', (e) => {
    if (e.target.closest('.btn')) e.preventDefault();
  }, { capture: true });
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.btn')) e.preventDefault();
  }, { capture: true });

  /* PWA: Service Worker + Install */
  let deferredPrompt = null;
  if ('serviceWorker' in navigator){
    window.addEventListener('load', async () => {
      try{
        const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
        reg.addEventListener('updatefound', () => {
          const newSW = reg.installing;
          newSW && newSW.addEventListener('statechange', () => {
            if (newSW.state === 'installed' && navigator.serviceWorker.controller){
              const toast = document.getElementById('updateToast'); if (toast) toast.style.display='flex';
            }
          });
        });
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
      }catch(e){ console.warn('SW registration failed', e); }
    });

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      const btn = document.getElementById('installBtn'); if (btn) btn.style.display='inline-block';
    });
  }

  const installBtn = document.getElementById('installBtn');
  if (installBtn) installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.style.display='none';
  });

  document.getElementById('updateReload')?.addEventListener('click', async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg?.waiting){ reg.waiting.postMessage('skipWaiting'); }
  });

  // Bootstrap
  initPortraitLock();
  computeTile();
  initTape();
  initTapeSwipe();
  loadMemory();
  loadSavedEq();
  loadMemorySets();
  renderMemoryLiveRow();
  renderMemorySets();
  renderSavedEq();
  initChalkLineHelper();
  initSegmentTape();
  attachRipples();
  attachPressState();
  applyFractionPalettes();
  enableClickCopy('#fractionLine, #decimalLine');

  const eqSaveBtn = document.getElementById('eqSaveBtn');
  if (eqSaveBtn){
    let lpTimer = null;
    let suppressNextClick = false;
    let holdTriggered = false;
    const HOLD_MS = 600;

    const armHold = () => {
      clearTimeout(lpTimer);
      eqSaveBtn.classList.add('hold');
      lpTimer = setTimeout(() => {
        holdTriggered = true;
        suppressNextClick = true;
        eqSaveBtn.classList.remove('hold');
        openSavedEqCard();
      }, HOLD_MS);
    };

    const disarmHold = () => {
      clearTimeout(lpTimer);
      eqSaveBtn.classList.remove('hold');
    };

    eqSaveBtn.addEventListener('pointerdown', armHold);
    eqSaveBtn.addEventListener('pointerup', () => {
      disarmHold();
      holdTriggered = false;
    });
    eqSaveBtn.addEventListener('pointerleave', disarmHold);
    eqSaveBtn.addEventListener('pointercancel', disarmHold);

    eqSaveBtn.addEventListener('keydown', (e) => {
      if (e.code === 'Space'){
        e.preventDefault();
        armHold();
      }
    });
    eqSaveBtn.addEventListener('keyup', (e) => {
      if (e.code === 'Space'){
        e.preventDefault();
        disarmHold();
      }
    });

    eqSaveBtn.addEventListener('click', (e) => {
      if (suppressNextClick){
        suppressNextClick = false;
        return;
      }
      snapshotCurrentEquation();
    });
  }

  function openSavedEqCard(){
    const eqCard = document.getElementById('cmSavedEq');
    if (typeof window._cmOpen === 'function'){
      window._cmOpen();
      renderSavedEq();
      if (typeof window._cmIndexOf === 'function' && typeof window._cmGoTo === 'function' && eqCard){
        const idx = window._cmIndexOf(eqCard);
        if (idx >= 0) window._cmGoTo(idx);
      }
    }
  }

  function openMemCenterCard(){
    const memCard = document.getElementById('memCenter');
    if (typeof window._cmOpen === 'function'){
      window._cmOpen();
      if (typeof window._cmIndexOf === 'function' && typeof window._cmGoTo === 'function' && memCard){
        const idx = window._cmIndexOf(memCard);
        if (idx >= 0) window._cmGoTo(idx);
      }
    }
  }

  function openSegmentTapeCard(){
    const segCard = document.getElementById('segmentTapeCard');
    if (typeof window._cmOpen === 'function'){
      window._cmOpen();
      if (typeof window._cmIndexOf === 'function' && typeof window._cmGoTo === 'function' && segCard){
        const idx = window._cmIndexOf(segCard);
        if (idx >= 0) window._cmGoTo(idx);
      }
    }
    if (typeof window._segmentTapeRefresh === 'function') window._segmentTapeRefresh();
  }

  document.getElementById('eqClearBtn')?.addEventListener('click', clearSavedEq);
  document.getElementById('savedEqTile')?.addEventListener('click', openSavedEqCard);
  document.getElementById('memCenterTile')?.addEventListener('click', openMemCenterCard);
  const segmentTile = document.getElementById('segmentTapeTile') || document.querySelector('.cm-tile[href="segment_tape.html"]');
  segmentTile?.addEventListener('click', (e) => {
    e.preventDefault();
    openSegmentTapeCard();
  });

})();
  
  /* ---- Long-press on results → replace history ---- */
(function bindResultLongPress(){
  const outWrap   = document.querySelector('.output');
  const fracEl    = document.getElementById('fractionLine');
  const decEl     = document.getElementById('decimalLine');

  if (!fracEl || !decEl) return;

  let lpTimer = null;
  let suppressNextClick = false;

  // Reuse your “hold pulse” vibe by toggling a simple class on the output row
  function armHold(){
    clearTimeout(lpTimer);
    outWrap?.classList.add('hold');
    lpTimer = setTimeout(() => {
      outWrap?.classList.remove('hold');
      // Ask before clobbering the expression (matches memory confirm vibe)
      const ok = confirm('Replace the current expression with this result?\nThis will clear the history.');
      if (ok && Number.isFinite(lastGood?.value)) {
        suppressNextClick = true;            // prevent the copy tap after a long-press
        replaceHistoryWith(lastGood.value);  // exact inches
      }
    }, 600); // long-press threshold; match your other holds
  }
  function disarmHold(){
    clearTimeout(lpTimer);
    outWrap?.classList.remove('hold');
  }

  function attach(el){
    // pointer events cover mouse & touch on modern browsers
    el.addEventListener('pointerdown', armHold);
    el.addEventListener('pointerup',   disarmHold);
    el.addEventListener('pointercancel', disarmHold);
    el.addEventListener('pointerleave',  disarmHold);

    // If a long-press fired, swallow the following synthetic click (so it doesn’t copy text)
    el.addEventListener('click', (e) => {
      if (suppressNextClick){
        suppressNextClick = false;
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    // Touch fallback
    el.addEventListener('touchstart', armHold, { passive:true });
    el.addEventListener('touchend',   disarmHold);
    el.addEventListener('touchcancel',disarmHold);

    // Nice hint
    el.setAttribute('title', 'Tap to copy • Hold to replace history');
  }

  attach(fracEl);
  attach(decEl);
})();
