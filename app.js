// ---------- Storage ----------

const STORAGE_KEY = 'cycleCalendarData_v1';

const COLOR_PRESETS = ['#c1567b', '#b23a6b', '#e08a6f', '#a97ca5', '#7c9473'];

function defaultData() {
  return {
    onboarded: false,
    profile: { name: '' },
    periods: [],       // [{id, start: 'YYYY-MM-DD', length: number|null}]
    eventRecords: [],   // [{id, title, time: 'HH:MM'|null, startDate, endDate: 'YYYY-MM-DD', recurrence: null|{freq:'daily'|'weekly'|'biweekly', until:'YYYY-MM-DD'}, color: null|'#hex'}]
    inbox: [],           // [{id, title, createdAt}]
    patterns: [],         // [{id, text, dates: ['YYYY-MM-DD', ...], createdAt}]
    settings: {
      cycleLengthOverride: null,
      periodLengthOverride: null,
      phaseMode: 'period',   // 'all' | 'period'
      accentColor: COLOR_PRESETS[0],
      expandedView: false
    }
  };
}

// Merges any partial/stored data object onto a fresh default, guarding
// against shapes saved by older versions of the app.
function normalizeData(parsed) {
  const merged = Object.assign(defaultData(), parsed || {}, {
    settings: Object.assign(defaultData().settings, (parsed && parsed.settings) || {}),
    profile: Object.assign(defaultData().profile, (parsed && parsed.profile) || {})
  });
  if (!Array.isArray(merged.patterns)) merged.patterns = [];
  if (!Array.isArray(merged.periods)) merged.periods = [];
  if (!Array.isArray(merged.inbox)) merged.inbox = [];
  if (!Array.isArray(merged.eventRecords)) merged.eventRecords = [];

  // One-time migration from the old per-date event map (pre-span/recurrence
  // schema) into the new flat eventRecords list. Only runs for data saved
  // before this change; already-migrated data has no `events` key.
  if (parsed && parsed.events && typeof parsed.events === 'object' && !Array.isArray(parsed.eventRecords)) {
    for (const [date, items] of Object.entries(parsed.events)) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        merged.eventRecords.push({
          id: item.id || uid(),
          title: item.title,
          time: item.time || null,
          startDate: date,
          endDate: date,
          recurrence: null,
          color: null
        });
      }
    }
  }
  delete merged.events;

  return merged;
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultData();
    return normalizeData(JSON.parse(raw));
  } catch (e) {
    console.error('Failed to load data, starting fresh', e);
    return defaultData();
  }
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
  if (state.user && window.CycleAuth) {
    window.CycleAuth.saveUserDoc(state.user.uid, state.data).catch(err => {
      console.error('Cloud save failed', err);
    });
  }
}

const state = {
  data: loadData(),
  user: null,
  viewYear: null,
  viewMonth: null, // 0-indexed
  activeDayISO: null,
  editingEventId: null,
  pendingEventColor: null,
  pagerAtMonth: false,
  pendingPatternDates: new Set(),
  patternPickerYear: null,
  patternPickerMonth: null,
  welcomePeriodDates: new Set(),
  welcomePickerYear: null,
  welcomePickerMonth: null,
  welcomeName: '',
  welcomeCycleLength: 28,
  logPeriodSelectedDates: new Set(),
  logPeriodPickerYear: null,
  logPeriodPickerMonth: null,
  editingPeriodId: null,
  logPeriodReturnToSettings: false
};

// ---------- Date helpers ----------

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fromISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, n) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + n);
  return copy;
}

function diffDays(a, b) {
  const MS = 24 * 60 * 60 * 1000;
  const aMid = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const bMid = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((aMid - bMid) / MS);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function formatMonthLabel(year, month) {
  return new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function formatDayHeading(iso) {
  return fromISO(iso).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `${r},${g},${b}`;
}

function colorWithAlpha(hex, alpha) {
  return `rgba(${hexToRgb(hex)},${alpha})`;
}

// ---------- Event records (span + recurrence expansion) ----------

function addEventRecord({ title, time, startDate, endDate, recurrence, color }) {
  const record = {
    id: uid(),
    title,
    time: time || null,
    startDate,
    endDate: endDate || startDate,
    recurrence: recurrence || null,
    color: color || null
  };
  state.data.eventRecords.push(record);
  return record;
}

function stepRecurrenceDate(iso, freq) {
  const d = fromISO(iso);
  if (freq === 'daily') return toISO(addDays(d, 1));
  if (freq === 'weekly') return toISO(addDays(d, 7));
  if (freq === 'biweekly') return toISO(addDays(d, 14));
  return null;
}

// Expands one event record into every concrete {startDate, endDate} span it
// occupies, honoring its recurrence rule (bounded by `until`, required on
// every recurring record so this always terminates).
function expandOccurrences(record) {
  const spanLen = diffDays(fromISO(record.endDate), fromISO(record.startDate));
  const occurrences = [{ startDate: record.startDate, endDate: record.endDate }];
  if (record.recurrence && record.recurrence.freq && record.recurrence.until) {
    let cursor = record.startDate;
    for (let guard = 0; guard < 366; guard++) {
      const nextStart = stepRecurrenceDate(cursor, record.recurrence.freq);
      if (!nextStart || nextStart > record.recurrence.until) break;
      occurrences.push({ startDate: nextStart, endDate: toISO(addDays(fromISO(nextStart), spanLen)) });
      cursor = nextStart;
    }
  }
  return occurrences;
}

// Flattens all event records onto a single date, including any day of a
// multi-day span and any recurrence occurrence that covers it.
function getEventsForDate(iso) {
  const results = [];
  for (const record of state.data.eventRecords) {
    for (const occ of expandOccurrences(record)) {
      if (iso >= occ.startDate && iso <= occ.endDate) {
        results.push({
          id: record.id,
          title: record.title,
          time: record.time,
          color: record.color,
          occStart: occ.startDate,
          occEnd: occ.endDate,
          isSpanStart: iso === occ.startDate,
          isSpanEnd: iso === occ.endDate,
          isMultiDay: occ.startDate !== occ.endDate
        });
        break;
      }
    }
  }
  return results;
}

// ---------- Cycle logic ----------

function getSortedPeriods() {
  return [...state.data.periods]
    .map(p => ({ ...p, startDate: fromISO(p.start) }))
    .sort((a, b) => a.startDate - b.startDate);
}

function getAvgCycleLength() {
  const override = state.data.settings.cycleLengthOverride;
  if (override) return override;
  const periods = getSortedPeriods();
  if (periods.length < 2) return 28;
  let total = 0, count = 0;
  for (let i = 1; i < periods.length; i++) {
    const gap = diffDays(periods[i].startDate, periods[i - 1].startDate);
    if (gap > 10 && gap < 90) { total += gap; count++; }
  }
  return count ? Math.round(total / count) : 28;
}

function getAvgPeriodLength() {
  const override = state.data.settings.periodLengthOverride;
  if (override) return override;
  const lengths = state.data.periods.map(p => p.length).filter(Boolean);
  if (!lengths.length) return 5;
  return Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
}

function getPhaseColorHex(phase) {
  if (phase === 'menstrual') return state.data.settings.accentColor;
  const map = {
    follicular: getComputedStyle(document.documentElement).getPropertyValue('--phase-follicular').trim(),
    ovulatory: getComputedStyle(document.documentElement).getPropertyValue('--phase-ovulatory').trim(),
    luteal: getComputedStyle(document.documentElement).getPropertyValue('--phase-luteal').trim()
  };
  return map[phase] || '#b7b0be';
}

const PHASE_INFO = {
  menstrual: { label: 'Menstrual', tag: 'Bleeding days', blurb: 'Bleeding days. Energy is often lowest here — a good stretch for rest and lighter plans.' },
  follicular: { label: 'Follicular', tag: 'Energy rising', blurb: 'Energy tends to rise. Often a good window for starting new projects and social plans.' },
  ovulatory: { label: 'Ovulatory', tag: 'Peak energy', blurb: 'Around your estimated ovulation. Energy and confidence often peak — good for big or high-stakes plans.' },
  luteal: { label: 'Luteal', tag: 'Post-ovulation', blurb: 'Post-ovulation. Energy can gradually dip and PMS symptoms may build — good stretch to protect downtime.' },
  unknown: { label: 'Unknown', tag: 'No data yet', blurb: 'Log a period start date to see your estimated phase here.' }
};

function getCycleInfo(dateISO) {
  const periods = getSortedPeriods();
  const avgCycle = getAvgCycleLength();
  const avgPeriod = getAvgPeriodLength();
  const dateObj = fromISO(dateISO);

  if (periods.length === 0) {
    return { phase: 'unknown', cycleDay: null, isPeriodDay: false, isPredicted: true };
  }

  let idx = -1;
  for (let i = 0; i < periods.length; i++) {
    if (periods[i].startDate <= dateObj) idx = i;
  }

  let cycleStartDate, periodLengthForCycle, nextStartDate, isPredicted, periodConfirmed;

  periodConfirmed = idx !== -1;

  if (idx === -1) {
    isPredicted = true;
    cycleStartDate = periods[0].startDate;
    while (cycleStartDate > dateObj) cycleStartDate = addDays(cycleStartDate, -avgCycle);
    periodLengthForCycle = avgPeriod;
    nextStartDate = addDays(cycleStartDate, avgCycle);
  } else {
    cycleStartDate = periods[idx].startDate;
    periodLengthForCycle = periods[idx].length || avgPeriod;
    if (idx + 1 < periods.length) {
      nextStartDate = periods[idx + 1].startDate;
      isPredicted = false;
    } else {
      nextStartDate = addDays(cycleStartDate, avgCycle);
      isPredicted = true;
    }
  }

  let effectiveCycleLength = diffDays(nextStartDate, cycleStartDate);
  if (effectiveCycleLength < periodLengthForCycle + 3) effectiveCycleLength = avgCycle;

  let cycleDay = diffDays(dateObj, cycleStartDate) + 1;

  let guard = 0;
  while (cycleDay > effectiveCycleLength && guard < 60) {
    cycleStartDate = nextStartDate;
    nextStartDate = addDays(cycleStartDate, avgCycle);
    periodLengthForCycle = avgPeriod;
    effectiveCycleLength = avgCycle;
    cycleDay = diffDays(dateObj, cycleStartDate) + 1;
    isPredicted = true;
    periodConfirmed = false;
    guard++;
  }
  guard = 0;
  while (cycleDay < 1 && guard < 60) {
    cycleStartDate = addDays(cycleStartDate, -avgCycle);
    cycleDay = diffDays(dateObj, cycleStartDate) + 1;
    isPredicted = true;
    periodConfirmed = false;
    guard++;
  }

  const ovulationDay = clamp(effectiveCycleLength - 14, periodLengthForCycle + 2, effectiveCycleLength - 2);
  const ovulatoryStart = Math.max(periodLengthForCycle + 1, ovulationDay - 2);
  const ovulatoryEnd = Math.min(effectiveCycleLength - 1, ovulationDay + 1);

  let phase;
  if (cycleDay <= periodLengthForCycle) phase = 'menstrual';
  else if (cycleDay < ovulatoryStart) phase = 'follicular';
  else if (cycleDay <= ovulatoryEnd) phase = 'ovulatory';
  else phase = 'luteal';

  return {
    phase,
    cycleDay,
    isPeriodDay: cycleDay <= periodLengthForCycle,
    isPredicted,
    periodConfirmed: periodConfirmed && cycleDay <= periodLengthForCycle,
    periodLength: periodLengthForCycle,
    ovulatoryStart,
    ovulatoryEnd,
    effectiveCycleLength,
    nextPeriodDate: toISO(addDays(cycleStartDate, effectiveCycleLength))
  };
}

// ---------- Rendering: legend & phase mode ----------

function renderLegend() {
  const legend = document.getElementById('legend');
  const mode = state.data.settings.phaseMode;
  const phases = mode === 'period' ? ['menstrual'] : ['menstrual', 'follicular', 'ovulatory', 'luteal'];
  legend.innerHTML = phases.map(p => `
    <span class="legend-item">
      <span class="legend-swatch" style="background:${getPhaseColorHex(p)}"></span>
      ${PHASE_INFO[p].label}
    </span>
  `).join('');
}

function renderPhaseModeToggle() {
  document.querySelectorAll('#phase-mode-toggle .mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.data.settings.phaseMode);
  });
}

function updateExpandButton() {
  const btn = document.getElementById('btn-expand-view');
  const expanded = state.data.settings.expandedView;
  btn.classList.toggle('active', expanded);
  btn.title = expanded ? 'Month view' : 'Week view';

  document.getElementById('month-nav-wrap').classList.toggle('hidden', expanded);
  document.getElementById('week-nav-wrap').classList.toggle('hidden', !expanded);
  document.getElementById('month-grid-wrap').classList.toggle('hidden', expanded);
  document.getElementById('week-grid-wrap').classList.toggle('hidden', !expanded);
}

// ---------- Rendering: calendar ----------

function applyPhaseClasses(cell, info, phaseMode) {
  if (info.isPeriodDay) {
    cell.classList.add('is-period');
    if (!info.periodConfirmed) cell.classList.add('is-predicted');
  } else if (phaseMode === 'all' && info.phase !== 'unknown') {
    cell.classList.add(`is-${info.phase}`);
  }
}

function hasPatternForDate(iso) {
  return state.data.patterns.some(p => p.dates.includes(iso));
}

// Shared builder for plain "pick a date" month grids (onboarding, log period,
// pattern picker). Unlike renderMonth/renderWeek, these have no events/plans —
// just phase tinting for context and a selectable day.
function renderDatePickerGrid(gridEl, year, month, { isSelected, onDayClick }) {
  gridEl.innerHTML = '';
  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayISO = toISO(new Date());
  const phaseMode = state.data.settings.phaseMode;

  for (let i = 0; i < startWeekday; i++) {
    const cell = document.createElement('div');
    cell.className = 'day-cell empty';
    gridEl.appendChild(cell);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateObj = new Date(year, month, day);
    const iso = toISO(dateObj);
    const info = getCycleInfo(iso);

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'day-cell';
    cell.setAttribute('aria-label', dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
    if (iso === todayISO) cell.classList.add('today');
    if (isSelected(iso)) cell.classList.add('selected');
    applyPhaseClasses(cell, info, phaseMode);

    const circle = document.createElement('div');
    circle.className = 'day-num-circle';
    circle.textContent = String(day);
    cell.appendChild(circle);

    cell.addEventListener('click', () => onDayClick(iso));
    gridEl.appendChild(cell);
  }
}

function renderMonth() {
  const { viewYear, viewMonth } = state;
  document.getElementById('month-label').textContent = formatMonthLabel(viewYear, viewMonth);

  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const startWeekday = firstOfMonth.getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const todayISO = toISO(new Date());
  const phaseMode = state.data.settings.phaseMode;

  for (let i = 0; i < startWeekday; i++) {
    const cell = document.createElement('div');
    cell.className = 'day-cell empty';
    grid.appendChild(cell);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateObj = new Date(viewYear, viewMonth, day);
    const iso = toISO(dateObj);
    const info = getCycleInfo(iso);

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'day-cell';
    cell.setAttribute('aria-label', dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
    if (iso === todayISO) cell.classList.add('today');
    applyPhaseClasses(cell, info, phaseMode);

    const circle = document.createElement('div');
    circle.className = 'day-num-circle';
    circle.textContent = String(day);
    cell.appendChild(circle);

    if (info.phase === 'ovulatory' && phaseMode === 'all') {
      const mark = document.createElement('span');
      mark.className = 'ovulation-mark';
      mark.textContent = '✦';
      cell.appendChild(mark);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'ovulation-mark';
      spacer.innerHTML = '&nbsp;';
      cell.appendChild(spacer);
    }

    if (hasPatternForDate(iso)) {
      const line = document.createElement('div');
      line.className = 'pattern-line';
      cell.appendChild(line);
    }

    const dayEvents = getEventsForDate(iso);
    const dots = document.createElement('div');
    dots.className = 'day-dots';
    if (dayEvents.length) {
      dots.innerHTML = dayEvents.slice(0, 4).map(ev => `<span class="dot"${ev.color ? ` style="background:${ev.color}"` : ''}></span>`).join('');
    }
    cell.appendChild(dots);

    cell.addEventListener('click', () => openDayModal(iso));
    grid.appendChild(cell);
  }

  renderWeek();
}

// ---------- Rendering: week view ----------

function getWeekStart(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - d.getDay());
  return d;
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatWeekLabel(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
  const startStr = `${MONTH_SHORT[weekStart.getMonth()]} ${weekStart.getDate()}`;
  const endStr = sameMonth
    ? `${weekEnd.getDate()}, ${weekEnd.getFullYear()}`
    : `${MONTH_SHORT[weekEnd.getMonth()]} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;
  return `${startStr} – ${endStr}`;
}

function renderWeek() {
  if (!state.viewWeekStart) state.viewWeekStart = getWeekStart(new Date());
  const weekStart = state.viewWeekStart;
  document.getElementById('week-label').textContent = formatWeekLabel(weekStart);

  const grid = document.getElementById('week-grid');
  grid.innerHTML = '';
  const todayISO = toISO(new Date());
  const phaseMode = state.data.settings.phaseMode;

  for (let i = 0; i < 7; i++) {
    const dateObj = addDays(weekStart, i);
    const iso = toISO(dateObj);
    const info = getCycleInfo(iso);

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'week-day-cell';
    cell.setAttribute('aria-label', dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
    if (iso === todayISO) cell.classList.add('today');
    applyPhaseClasses(cell, info, phaseMode);

    const label = document.createElement('div');
    label.className = 'week-day-label';
    label.textContent = dateObj.toLocaleDateString(undefined, { weekday: 'short' });
    cell.appendChild(label);

    const circle = document.createElement('div');
    circle.className = 'day-num-circle';
    circle.textContent = String(dateObj.getDate());
    cell.appendChild(circle);

    if (info.phase === 'ovulatory' && phaseMode === 'all') {
      const mark = document.createElement('span');
      mark.className = 'ovulation-mark';
      mark.textContent = '✦';
      cell.appendChild(mark);
    }

    if (hasPatternForDate(iso)) {
      const line = document.createElement('div');
      line.className = 'pattern-line';
      cell.appendChild(line);
    }

    const blocks = document.createElement('div');
    blocks.className = 'week-blocks';
    const dayEvents = getEventsForDate(iso);
    const sorted = [...dayEvents].sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
    sorted.slice(0, 5).forEach(ev => {
      const chip = document.createElement('div');
      chip.className = 'block-chip';
      chip.textContent = ev.title;
      if (ev.color) chip.style.background = ev.color;
      blocks.appendChild(chip);
    });
    if (sorted.length > 5) {
      const more = document.createElement('div');
      more.className = 'block-more';
      more.textContent = `+${sorted.length - 5} more`;
      blocks.appendChild(more);
    }
    cell.appendChild(blocks);

    cell.addEventListener('click', () => openDayModal(iso));
    grid.appendChild(cell);
  }
}

// ---------- Rendering: today card ----------

function renderTodayCard() {
  const card = document.getElementById('today-card');
  const expanded = state.data.settings.expandedView;
  card.classList.toggle('hidden', !expanded);
  if (!expanded) return;

  const todayISO = toISO(new Date());
  const items = getEventsForDate(todayISO).sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  const list = document.getElementById('today-agenda-list');
  if (!items.length) {
    list.innerHTML = '<li class="empty">Nothing planned for today</li>';
  } else {
    list.innerHTML = items.map(ev => `
      <li><span class="agenda-time">${ev.time || 'Anytime'}</span><span>${escapeHtml(ev.title)}</span></li>
    `).join('');
  }

  const info = getCycleInfo(todayISO);
  const phaseData = PHASE_INFO[info.phase];
  const note = document.getElementById('today-phase-note');
  note.style.color = getPhaseColorHex(info.phase);
  note.textContent = info.phase === 'unknown'
    ? phaseData.blurb
    : `${phaseData.label}${info.cycleDay ? ` · Day ${info.cycleDay}` : ''} — ${phaseData.blurb}`;
}

// ---------- Rendering: home (greeting) screen ----------

function getGreeting(date) {
  const h = date.getHours();
  if (h < 5) return 'Good evening';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

function formatGreetDate(date) {
  const weekday = date.toLocaleDateString(undefined, { weekday: 'long' });
  const month = date.toLocaleDateString(undefined, { month: 'long' });
  const day = date.getDate();
  return `${weekday} ${day}${ordinalSuffix(day)} ${month}`;
}

function renderHomeScreen() {
  const now = new Date();
  const todayISO = toISO(now);

  document.getElementById('greet-eyebrow').textContent = getGreeting(now);
  document.getElementById('greet-date').textContent = formatGreetDate(now);

  const info = getCycleInfo(todayISO);
  const phaseEl = document.getElementById('greet-phase');
  const phaseTextEl = document.getElementById('greet-phase-text');
  if (info.phase === 'unknown') {
    phaseEl.style.color = 'var(--text-faint)';
    phaseTextEl.textContent = 'No cycle data yet';
  } else {
    phaseEl.style.color = getPhaseColorHex(info.phase);
    phaseTextEl.textContent = PHASE_INFO[info.phase].label;
  }

  const items = getEventsForDate(todayISO).sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  const list = document.getElementById('home-agenda-list');
  if (!items.length) {
    list.innerHTML = `<li><button type="button" class="agenda-empty" data-open-today>Nothing planned today &mdash; tap to add</button></li>`;
  } else {
    list.innerHTML = items.map(ev => `
      <li><button type="button" data-open-today><span class="agenda-time">${ev.time || 'Anytime'}</span><span>${ev.color ? `<span class="dot" style="background:${ev.color};display:inline-block;margin-right:7px;"></span>` : ''}${escapeHtml(ev.title)}</span></button></li>
    `).join('');
  }
}

// ---------- Today/Month pager ----------

function syncPagerHeight() {
  const viewport = document.getElementById('pager-viewport');
  const page = document.getElementById(state.pagerAtMonth ? 'page-month' : 'page-today');
  if (viewport && page) viewport.style.height = page.scrollHeight + 'px';
}

function goToPage(name) {
  state.pagerAtMonth = name === 'month';
  document.getElementById('pager').classList.toggle('at-month', state.pagerAtMonth);
  syncPagerHeight();
}

// ---------- Pattern log ----------

function openPatternsModal(iso) {
  state.pendingPatternDates = new Set([iso || toISO(new Date())]);
  document.getElementById('pattern-date-picker').classList.add('hidden');
  document.getElementById('btn-pattern-pick-date').textContent = '+ Add another day ▾';
  renderPatternSelectedDays();
  renderPatternList();
  showModal('modal-patterns');
}

function sortedPendingDates() {
  return [...state.pendingPatternDates].sort();
}

function shortDateLabel(iso) {
  return fromISO(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function renderPatternSelectedDays() {
  const list = document.getElementById('pattern-selected-days');
  const dates = sortedPendingDates();
  const hint = document.getElementById('pattern-selection-hint');
  hint.classList.toggle('hidden', dates.length > 0);

  if (!dates.length) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = dates.map(iso => {
    const info = getCycleInfo(iso);
    const phaseData = PHASE_INFO[info.phase];
    const tagLine = info.cycleDay
      ? `${phaseData.label} ; Day ${info.cycleDay} ; ${phaseData.tag}`
      : `${phaseData.label} ; ${phaseData.tag}`;
    return `
      <li data-iso="${iso}">
        <span><strong>${shortDateLabel(iso)}</strong> <span class="selected-day-tag">${tagLine}</span></span>
        <button type="button" data-remove-day="${iso}" aria-label="Remove day">&times;</button>
      </li>
    `;
  }).join('');
}

function formatPatternEntryDates(dates) {
  const sorted = [...dates].sort();
  if (sorted.length === 1) return shortDateLabel(sorted[0]);
  if (sorted.length <= 3) return sorted.map(d => fromISO(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })).join(', ');
  return `${sorted.length} days`;
}

function renderPatternList() {
  const list = document.getElementById('pattern-list');
  const activeDates = sortedPendingDates();
  const items = state.data.patterns.filter(p => p.dates.some(d => activeDates.includes(d)));

  if (!items.length) {
    list.innerHTML = '<li style="justify-content:center;color:var(--text-muted);font-style:italic;">Nothing logged for this day yet</li>';
    return;
  }
  list.innerHTML = items.map(p => `
    <li data-id="${p.id}">
      <span>${escapeHtml(p.text)}<br><span class="selected-day-tag">${formatPatternEntryDates(p.dates)}</span></span>
      <button class="event-remove" data-remove-pattern="${p.id}" aria-label="Remove">&times;</button>
    </li>
  `).join('');
}

function addPatternEntry(text) {
  if (!state.pendingPatternDates.size) return;
  state.data.patterns.push({ id: uid(), text, dates: sortedPendingDates(), createdAt: toISO(new Date()) });
  saveData();
  renderPatternList();
  renderMonth();
}

function removePatternEntry(id) {
  state.data.patterns = state.data.patterns.filter(p => p.id !== id);
  saveData();
  renderPatternList();
  renderMonth();
}

function togglePendingPatternDate(iso) {
  if (state.pendingPatternDates.has(iso)) {
    state.pendingPatternDates.delete(iso);
  } else {
    state.pendingPatternDates.add(iso);
  }
  renderPatternSelectedDays();
  renderPatternList();
  renderPatternPicker();
}

function renderPatternPicker() {
  document.getElementById('pattern-picker-label').textContent = formatMonthLabel(state.patternPickerYear, state.patternPickerMonth);
  renderDatePickerGrid(document.getElementById('pattern-calendar-grid'), state.patternPickerYear, state.patternPickerMonth, {
    isSelected: (iso) => state.pendingPatternDates.has(iso),
    onDayClick: (iso) => togglePendingPatternDate(iso)
  });
}

// ---------- Rendering: day modal ----------

function openDayModal(iso) {
  state.activeDayISO = iso;
  state.editingEventId = null;
  document.getElementById('day-modal-date').textContent = formatDayHeading(iso);

  const info = getCycleInfo(iso);
  const banner = document.getElementById('day-modal-phase');
  const phaseData = PHASE_INFO[info.phase];
  banner.style.background = colorWithAlpha(getPhaseColorHex(info.phase), 0.18);
  banner.innerHTML = `<strong>${phaseData.label}${info.cycleDay ? ` &middot; Day ${info.cycleDay}` : ''}</strong><br>${phaseData.blurb}${info.isPredicted ? '<br><em>Estimated from your averages.</em>' : ''}`;

  resetEventForm();

  const periodBtn = document.getElementById('btn-toggle-period-day');
  periodBtn.textContent = info.isPeriodDay ? 'Remove period logged on this day' : 'Mark period start on this day';

  showModal('modal-day');
  renderDayTimeline(iso);
}

const TIMELINE_ROW_HEIGHT = 44;

function formatHourLabel(h) {
  const period = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12} ${period}`;
}

function resetEventForm() {
  state.editingEventId = null;
  state.pendingEventColor = null;
  document.getElementById('event-title').value = '';
  document.getElementById('event-time').value = '';
  document.getElementById('event-form-submit').textContent = 'Add';
  document.getElementById('edit-actions').classList.add('hidden');

  const iso = state.activeDayISO;
  const endInput = document.getElementById('event-end-date');
  endInput.value = iso;
  endInput.min = iso;
  document.getElementById('event-recurrence').value = '';
  const untilInput = document.getElementById('event-recur-until');
  untilInput.value = '';
  untilInput.required = false;
  untilInput.min = iso;
  document.getElementById('event-recur-until-row').classList.add('hidden');
  document.getElementById('event-options').classList.add('hidden');
  renderEventColorSwatches();
}

function renderEventColorSwatches() {
  const container = document.getElementById('event-color-swatches');
  const selected = state.pendingEventColor;
  const noneBtn = `<button type="button" class="color-swatch none${!selected ? ' selected' : ''}" data-color="" aria-label="No colour, use the app accent"></button>`;
  const presetBtns = COLOR_PRESETS.map(hex => `
    <button type="button" class="color-swatch${hex === selected ? ' selected' : ''}" style="background:${hex}" data-color="${hex}" aria-label="Choose colour"></button>
  `).join('');
  container.innerHTML = noneBtn + presetBtns;
}

function renderDayTimeline(iso) {
  const container = document.getElementById('day-timeline');
  const items = getEventsForDate(iso);
  const timed = items.filter(ev => ev.time);
  const anytime = items.filter(ev => !ev.time);

  const anytimeHtml = `
    <div class="day-timeline-anytime">
      <span class="anytime-label">Anytime</span>
      ${anytime.length ? anytime.map(ev => `<button type="button" class="anytime-chip" data-edit-event="${ev.id}"${ev.color ? ` style="background:${ev.color};border-color:${ev.color};color:#fff;"` : ''}>${escapeHtml(ev.title)}</button>`).join('') : '<span class="hint" style="margin:0;">Nothing without a set time</span>'}
    </div>
  `;

  const hourRows = [];
  for (let h = 0; h < 24; h++) {
    hourRows.push(`<div class="timeline-hour-row" data-hour="${h}"><span class="timeline-hour-label">${formatHourLabel(h)}</span></div>`);
  }

  const chips = timed.map(ev => {
    const [h, m] = ev.time.split(':').map(Number);
    const top = (h + m / 60) * TIMELINE_ROW_HEIGHT;
    const colorStyle = ev.color ? `background:${ev.color};` : '';
    return `<div class="timeline-event-chip" style="top:${top}px;${colorStyle}" data-edit-event="${ev.id}"><span class="chip-time">${ev.time}</span>${escapeHtml(ev.title)}</div>`;
  }).join('');

  container.innerHTML = `
    ${anytimeHtml}
    <div class="day-timeline-scroll" id="day-timeline-scroll">
      <div class="day-timeline-inner" style="height:${24 * TIMELINE_ROW_HEIGHT}px;">
        ${hourRows.join('')}
        ${chips}
      </div>
    </div>
  `;

  const scrollEl = document.getElementById('day-timeline-scroll');
  const earliestHour = timed.length ? Math.min(...timed.map(ev => Number(ev.time.split(':')[0]))) : 7;
  scrollEl.scrollTop = Math.max(0, earliestHour - 1) * TIMELINE_ROW_HEIGHT;
}

function startEditingEvent(iso, id) {
  const ev = state.data.eventRecords.find(e => e.id === id);
  if (!ev) return;
  state.editingEventId = id;
  document.getElementById('event-title').value = ev.title;
  document.getElementById('event-time').value = ev.time || '';
  document.getElementById('event-form-submit').textContent = 'Save';
  document.getElementById('edit-actions').classList.remove('hidden');

  const endInput = document.getElementById('event-end-date');
  endInput.value = ev.endDate;
  endInput.min = ev.startDate;
  document.getElementById('event-recurrence').value = ev.recurrence ? ev.recurrence.freq : '';
  const untilInput = document.getElementById('event-recur-until');
  const untilRow = document.getElementById('event-recur-until-row');
  if (ev.recurrence) {
    untilInput.value = ev.recurrence.until;
    untilInput.min = ev.endDate;
    untilInput.required = true;
    untilRow.classList.remove('hidden');
  } else {
    untilInput.value = '';
    untilInput.required = false;
    untilRow.classList.add('hidden');
  }

  state.pendingEventColor = ev.color || null;
  renderEventColorSwatches();

  const hasExtras = ev.endDate !== ev.startDate || !!ev.recurrence || !!ev.color;
  document.getElementById('event-options').classList.toggle('hidden', !hasExtras);

  document.getElementById('event-title').focus();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Brain (inbox) ----------

function renderInbox() {
  const list = document.getElementById('inbox-list');
  const items = state.data.inbox;
  if (!items.length) {
    list.innerHTML = '<li class="inbox-empty">Nothing here yet</li>';
  } else {
    list.innerHTML = items.map(item => `
      <li data-id="${item.id}">
        <span class="inbox-title">${escapeHtml(item.title)}</span>
        <input type="date" class="inbox-date-input" data-assign="${item.id}" />
        <button data-inbox-schedule="${item.id}" title="Give this a date" aria-label="Give this a date">&#128197;</button>
        <button data-inbox-remove="${item.id}" title="Delete" aria-label="Delete">&times;</button>
      </li>
    `).join('');
  }

  const count = document.getElementById('brain-drawer-count');
  count.textContent = items.length
    ? `${items.length} unsorted`
    : 'Nothing here yet';
}

function addInboxItem(title) {
  state.data.inbox.push({ id: uid(), title, createdAt: toISO(new Date()) });
  saveData();
  renderInbox();
}

function removeInboxItem(id) {
  state.data.inbox = state.data.inbox.filter(i => i.id !== id);
  saveData();
  renderInbox();
}

function assignInboxItemToDate(id, iso) {
  const item = state.data.inbox.find(i => i.id === id);
  if (!item || !iso) return;
  addEventRecord({ title: item.title, time: null, startDate: iso, endDate: iso });
  state.data.inbox = state.data.inbox.filter(i => i.id !== id);
  saveData();
  renderInbox();
  renderMonth();
  renderHomeScreen();
}

// ---------- Modals ----------

function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// ---------- Accent colour ----------

function applyAccentColor() {
  document.documentElement.style.setProperty('--accent', state.data.settings.accentColor);
}

function renderColorSwatches(containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = COLOR_PRESETS.map(hex => `
    <button type="button" class="color-swatch${hex === state.data.settings.accentColor ? ' selected' : ''}" style="background:${hex}" data-color="${hex}" aria-label="Choose accent colour"></button>
  `).join('');
}

function renderAllColorSwatches() {
  renderColorSwatches('color-swatches');
  renderColorSwatches('welcome-color-swatches');
}

// ---------- Cycle wheel ----------

function polarPoint(cx, cy, r, angleDeg) {
  const angleRad = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}

function renderCycleWheel() {
  const todayISO = toISO(new Date());
  const info = getCycleInfo(todayISO);
  const svg = document.getElementById('cycle-wheel');
  const cx = 100, cy = 100, r = 80, dotRadius = 3.6;
  const circumference = 2 * Math.PI * r;
  const numDots = Math.max(24, Math.round(circumference / 9));
  const headline = document.getElementById('next-period-headline');

  document.getElementById('wheel-day').textContent = info.cycleDay ? `Day ${info.cycleDay}` : '—';
  document.getElementById('wheel-phase').textContent = PHASE_INFO[info.phase].label;
  document.getElementById('cycle-blurb').textContent = PHASE_INFO[info.phase].blurb;
  document.getElementById('stat-cycle-length').textContent = `${getAvgCycleLength()} days`;
  document.getElementById('stat-period-length').textContent = `${getAvgPeriodLength()} days`;

  if (info.phase === 'unknown') {
    let dots = '';
    for (let i = 0; i < numDots; i++) {
      const p = polarPoint(cx, cy, r, (i / numDots) * 360);
      dots += `<circle cx="${p.x}" cy="${p.y}" r="${dotRadius}" fill="var(--border)" />`;
    }
    svg.innerHTML = dots;
    headline.textContent = 'Log a period to see predictions';
    return;
  }

  const segments = [
    { phase: 'menstrual', days: info.periodLength },
    { phase: 'follicular', days: info.ovulatoryStart - info.periodLength - 1 },
    { phase: 'ovulatory', days: info.ovulatoryEnd - info.ovulatoryStart + 1 },
    { phase: 'luteal', days: info.effectiveCycleLength - info.ovulatoryEnd }
  ];

  function phaseAtDay(dayFrac) {
    let cum = 0;
    for (const seg of segments) {
      cum += seg.days;
      if (dayFrac < cum) return seg.phase;
    }
    return segments[segments.length - 1].phase;
  }

  let dots = '';
  for (let i = 0; i < numDots; i++) {
    const dayFrac = (i / numDots) * info.effectiveCycleLength;
    const phase = phaseAtDay(dayFrac);
    const p = polarPoint(cx, cy, r, (i / numDots) * 360);
    dots += `<circle cx="${p.x}" cy="${p.y}" r="${dotRadius}" fill="${getPhaseColorHex(phase)}" />`;
  }

  const markerAngle = ((info.cycleDay - 0.5) / info.effectiveCycleLength) * 360;
  const markerPoint = polarPoint(cx, cy, r, markerAngle);
  const marker = `<circle cx="${markerPoint.x}" cy="${markerPoint.y}" r="7" fill="var(--surface-solid)" stroke="${getPhaseColorHex(info.phase)}" stroke-width="3" />`;

  svg.innerHTML = dots + marker;

  const daysAway = diffDays(fromISO(info.nextPeriodDate), fromISO(todayISO));
  if (daysAway > 1) headline.textContent = `Period in ${daysAway} days`;
  else if (daysAway === 1) headline.textContent = 'Period in 1 day';
  else if (daysAway === 0) headline.textContent = 'Period due today';
  else headline.textContent = 'Period may have started';
}

// ---------- Settings ----------

// Sets overrides only when the given values differ from what would be
// auto-calculated from period history; otherwise clears the override so
// the value keeps adapting as more periods get logged.
function applySettingsValues(cycleLen, periodLen) {
  state.data.settings.cycleLengthOverride = null;
  state.data.settings.periodLengthOverride = null;
  const rawCycle = getAvgCycleLength();
  const rawPeriod = getAvgPeriodLength();
  state.data.settings.cycleLengthOverride = (cycleLen && cycleLen !== rawCycle) ? cycleLen : null;
  state.data.settings.periodLengthOverride = (periodLen && periodLen !== rawPeriod) ? periodLen : null;
}

function renderSettings() {
  document.getElementById('setting-cycle-length').value = getAvgCycleLength();
  renderPeriodHistory();
  renderAllColorSwatches();
  const name = state.data.profile && state.data.profile.name;
  const email = state.user && state.user.email;
  document.getElementById('account-info').textContent = [name, email].filter(Boolean).join(' · ') || 'Signed in';
}

function formatPeriodRange(p) {
  const startLabel = fromISO(p.start).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (!p.length || p.length <= 1) return `${startLabel} &middot; 1 day`;
  const endLabel = addDays(fromISO(p.start), p.length - 1).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${startLabel} &ndash; ${endLabel} &middot; ${p.length} days`;
}

function renderPeriodHistory() {
  const list = document.getElementById('period-history-list');
  const periods = getSortedPeriods().reverse();
  if (!periods.length) {
    list.innerHTML = '<li><button type="button" class="period-history-edit" data-add-period="true" style="text-align:center;width:100%;">Update your cycle dates</button></li>';
    return;
  }
  list.innerHTML = periods.map(p => `
    <li data-id="${p.id}">
      <button type="button" class="period-history-edit" data-edit-period="${p.id}">${formatPeriodRange(p)}</button>
      <button class="event-remove" data-remove-period="${p.id}" aria-label="Remove">&times;</button>
    </li>
  `).join('');
}

// ---------- Period logging ----------

function logPeriod(startISO, length) {
  state.data.periods.push({ id: uid(), start: startISO, length: length || null });
  saveData();
  renderMonth();
}

function renderLogPeriodPicker() {
  document.getElementById('log-period-picker-label').textContent = formatMonthLabel(state.logPeriodPickerYear, state.logPeriodPickerMonth);
  renderDatePickerGrid(document.getElementById('log-period-calendar-grid'), state.logPeriodPickerYear, state.logPeriodPickerMonth, {
    isSelected: (iso) => state.logPeriodSelectedDates.has(iso),
    onDayClick: (iso) => toggleLogPeriodDate(iso)
  });
}

function toggleLogPeriodDate(iso) {
  if (state.logPeriodSelectedDates.has(iso)) {
    state.logPeriodSelectedDates.delete(iso);
  } else {
    state.logPeriodSelectedDates.add(iso);
  }
  renderLogPeriodPicker();
  renderLogPeriodSummary();
}

function renderLogPeriodSummary() {
  const summary = document.getElementById('log-period-selection-summary');
  const dates = [...state.logPeriodSelectedDates].sort();
  if (!dates.length) {
    summary.textContent = 'Tap the days your period lasted, above.';
    return;
  }
  const range = dates.length > 1
    ? `${shortDateLabel(dates[0])} – ${shortDateLabel(dates[dates.length - 1])}`
    : shortDateLabel(dates[0]);
  summary.textContent = `${dates.length} day${dates.length === 1 ? '' : 's'} selected (${range})`;
}

function openLogPeriodModal(period) {
  const heading = document.getElementById('log-period-heading');
  const editActions = document.getElementById('log-period-edit-actions');

  if (period) {
    state.editingPeriodId = period.id;
    const length = period.length || 1;
    const startDate = fromISO(period.start);
    state.logPeriodSelectedDates = new Set(Array.from({ length }, (_, i) => toISO(addDays(startDate, i))));
    heading.textContent = 'Edit period';
    editActions.classList.remove('hidden');
  } else {
    state.editingPeriodId = null;
    state.logPeriodSelectedDates = new Set([toISO(new Date())]);
    heading.textContent = 'Log a period';
    editActions.classList.add('hidden');
  }

  const anchor = fromISO([...state.logPeriodSelectedDates].sort()[0]);
  state.logPeriodPickerYear = anchor.getFullYear();
  state.logPeriodPickerMonth = anchor.getMonth();
  renderLogPeriodPicker();
  renderLogPeriodSummary();
  showModal('modal-log-period');
}

function closeLogPeriodModal() {
  hideModal('modal-log-period');
  renderPeriodHistory();
  renderSettings();
  if (state.logPeriodReturnToSettings) {
    state.logPeriodReturnToSettings = false;
    showModal('modal-settings');
  }
}

// ---------- Welcome wizard (signup / login) ----------

function showWelcomeStep(stepId) {
  document.querySelectorAll('.welcome-step').forEach(el => el.classList.add('hidden'));
  document.getElementById(stepId).classList.remove('hidden');
}

function showLoading() {
  document.getElementById('welcome-loading').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('welcome-loading').classList.add('hidden');
}

function renderWelcomePicker() {
  document.getElementById('welcome-picker-label').textContent = formatMonthLabel(state.welcomePickerYear, state.welcomePickerMonth);
  renderDatePickerGrid(document.getElementById('welcome-calendar-grid'), state.welcomePickerYear, state.welcomePickerMonth, {
    isSelected: (iso) => state.welcomePeriodDates.has(iso),
    onDayClick: (iso) => handleWelcomePeriodDayClick(iso)
  });
}

// First tap on an empty selection auto-fills a 5-day guess from that date;
// after that, every tap just toggles that single day on/off.
function handleWelcomePeriodDayClick(iso) {
  if (state.welcomePeriodDates.size === 0) {
    const start = fromISO(iso);
    for (let i = 0; i < 5; i++) state.welcomePeriodDates.add(toISO(addDays(start, i)));
  } else if (state.welcomePeriodDates.has(iso)) {
    state.welcomePeriodDates.delete(iso);
  } else {
    state.welcomePeriodDates.add(iso);
  }
  renderWelcomePicker();
  renderWelcomeSelectionSummary();
}

function renderWelcomeSelectionSummary() {
  const summary = document.getElementById('welcome-selection-summary');
  const dates = [...state.welcomePeriodDates].sort();
  if (!dates.length) {
    summary.textContent = 'Tap the first day of your last period, above.';
    return;
  }
  const range = dates.length > 1
    ? `${shortDateLabel(dates[0])} – ${shortDateLabel(dates[dates.length - 1])}`
    : shortDateLabel(dates[0]);
  summary.textContent = `${dates.length} day${dates.length === 1 ? '' : 's'} selected (${range})`;
}

function humanizeAuthError(err) {
  const code = err && err.code;
  const map = {
    'auth/email-already-in-use': 'That email already has an account — try logging in instead.',
    'auth/invalid-email': 'That doesn\'t look like a valid email address.',
    'auth/weak-password': 'Password needs to be at least 6 characters.',
    'auth/wrong-password': 'Wrong password.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/user-not-found': 'No account found with that email.',
    'auth/popup-closed-by-user': 'Google sign-in was closed before finishing.',
    'auth/network-request-failed': 'Network error — check your connection and try again.'
  };
  return map[code] || 'Something went wrong. Please try again.';
}

// Shared finish step for both email/password signup and Google sign-up:
// awaits the auth call, then builds the new account's data from whatever
// was collected earlier in the wizard (name, period days, cycle length,
// accent colour) and saves it as that user's very first cloud record.
async function finishAccountCreation(authAction, errorElId) {
  const errorEl = document.getElementById(errorElId);
  errorEl.textContent = '';
  showLoading();
  try {
    const cred = await authAction();
    const newData = defaultData();
    newData.onboarded = true;
    newData.profile.name = state.welcomeName;
    const dates = [...state.welcomePeriodDates].sort();
    if (dates.length) {
      newData.periods.push({ id: uid(), start: dates[0], length: dates.length });
    }
    newData.settings.cycleLengthOverride = (state.welcomeCycleLength && state.welcomeCycleLength !== 28) ? state.welcomeCycleLength : null;
    newData.settings.accentColor = state.data.settings.accentColor;
    state.user = cred.user;
    state.data = newData;
    saveData();
    hideLoading();
    hideModal('modal-onboarding');
    applyAccentColor();
    renderAll();
  } catch (err) {
    hideLoading();
    errorEl.textContent = humanizeAuthError(err);
  }
}

async function finishLogin(authAction) {
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = '';
  showLoading();
  try {
    await authAction();
    // onAuthStateChanged will pick up the new session, fetch cloud data, and render.
  } catch (err) {
    hideLoading();
    errorEl.textContent = humanizeAuthError(err);
  }
}

function removePeriod(id) {
  state.data.periods = state.data.periods.filter(p => p.id !== id);
  saveData();
  renderMonth();
  renderPeriodHistory();
  renderSettings();
}

function togglePeriodOnDay(iso) {
  const info = getCycleInfo(iso);
  if (info.isPeriodDay) {
    const periods = getSortedPeriods();
    const match = periods.find(p => p.start === iso);
    if (match) {
      removePeriod(match.id);
    } else {
      alert("This day is part of an estimated period window, not a day you logged directly. Open Settings to edit your period history.");
    }
  } else {
    logPeriod(iso, null);
  }
  openDayModal(iso);
}

// ---------- Data export/import ----------

function exportData() {
  const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cycle-calendar-backup-${toISO(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      state.data = normalizeData(parsed);
      saveData();
      applyAccentColor();
      renderAll();
      alert('Backup imported.');
    } catch (e) {
      alert('That file could not be read as a backup.');
    }
  };
  reader.readAsText(file);
}

// ---------- Init / wiring ----------

function renderAll() {
  renderLegend();
  renderPhaseModeToggle();
  updateExpandButton();
  renderMonth();
  renderTodayCard();
  renderHomeScreen();
  renderInbox();
  renderSettings();
  syncPagerHeight();
}

function init() {
  const today = new Date();
  state.viewYear = today.getFullYear();
  state.viewMonth = today.getMonth();

  applyAccentColor();
  renderAllColorSwatches();
  renderAll();

  state.welcomePickerYear = today.getFullYear();
  state.welcomePickerMonth = today.getMonth();
  renderWelcomePicker();
  renderWelcomeSelectionSummary();

  showLoading();
  window.CycleAuth.onAuthStateChanged(async (user) => {
    if (user) {
      state.user = user;
      try {
        const cloudData = await window.CycleAuth.getUserDoc(user.uid);
        if (cloudData) state.data = normalizeData(cloudData);
      } catch (err) {
        console.error('Failed to load cloud data', err);
      }
      hideModal('modal-onboarding');
      applyAccentColor();
      renderAll();
      goToPage('today');
      hideLoading();
    } else {
      state.user = null;
      hideLoading();
      showModal('modal-onboarding');
      showWelcomeStep('welcome-step-landing');
    }
  });

  // Month nav
  document.getElementById('btn-prev-month').addEventListener('click', () => {
    state.viewMonth--;
    if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
    renderMonth();
  });
  document.getElementById('btn-next-month').addEventListener('click', () => {
    state.viewMonth++;
    if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
    renderMonth();
  });
  document.getElementById('btn-today').addEventListener('click', () => {
    state.viewYear = today.getFullYear();
    state.viewMonth = today.getMonth();
    renderMonth();
  });

  // Phase mode toggle
  document.getElementById('phase-mode-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    state.data.settings.phaseMode = btn.dataset.mode;
    saveData();
    renderPhaseModeToggle();
    renderLegend();
    renderMonth();
  });

  // Modal close buttons
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => hideModal(btn.dataset.close));
  });
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && overlay.id !== 'modal-onboarding') hideModal(overlay.id);
    });
  });

  // Brain
  document.getElementById('inbox-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('inbox-input');
    const title = input.value.trim();
    if (!title) return;
    addInboxItem(title);
    input.value = '';
  });

  document.getElementById('inbox-list').addEventListener('click', (e) => {
    const scheduleId = e.target.dataset.inboxSchedule;
    const removeId = e.target.dataset.inboxRemove;
    if (scheduleId) {
      const input = e.target.parentElement.querySelector(`[data-assign="${scheduleId}"]`);
      input.classList.add('active');
      input.showPicker ? input.showPicker() : input.focus();
    } else if (removeId) {
      removeInboxItem(removeId);
    }
  });

  document.getElementById('inbox-list').addEventListener('change', (e) => {
    if (e.target.dataset.assign) {
      assignInboxItemToDate(e.target.dataset.assign, e.target.value);
    }
  });

  // Day modal: add/edit event
  document.getElementById('event-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const titleInput = document.getElementById('event-title');
    const timeInput = document.getElementById('event-time');
    const endInput = document.getElementById('event-end-date');
    const recurSelect = document.getElementById('event-recurrence');
    const untilInput = document.getElementById('event-recur-until');
    const title = titleInput.value.trim();
    if (!title || !state.activeDayISO) return;
    const iso = state.activeDayISO;
    const endDate = endInput.value && endInput.value >= iso ? endInput.value : iso;
    const recurrence = recurSelect.value ? { freq: recurSelect.value, until: untilInput.value } : null;
    const color = state.pendingEventColor || null;

    if (state.editingEventId) {
      const ev = state.data.eventRecords.find(e2 => e2.id === state.editingEventId);
      if (ev) {
        ev.title = title;
        ev.time = timeInput.value || null;
        ev.endDate = endDate;
        ev.recurrence = recurrence;
        ev.color = color;
      }
    } else {
      addEventRecord({ title, time: timeInput.value || null, startDate: iso, endDate, recurrence, color });
    }
    saveData();
    resetEventForm();
    renderDayTimeline(iso);
    renderMonth();
    renderTodayCard();
    renderHomeScreen();
  });

  document.getElementById('day-timeline').addEventListener('click', (e) => {
    const editId = e.target.closest('[data-edit-event]')?.dataset.editEvent;
    if (editId) {
      startEditingEvent(state.activeDayISO, editId);
      return;
    }
    const hourRow = e.target.closest('.timeline-hour-row');
    if (hourRow) {
      resetEventForm();
      const hour = String(hourRow.dataset.hour).padStart(2, '0');
      document.getElementById('event-time').value = `${hour}:00`;
      document.getElementById('event-title').focus();
    }
  });

  document.getElementById('btn-cancel-edit-event').addEventListener('click', () => {
    resetEventForm();
  });

  document.getElementById('btn-delete-edit-event').addEventListener('click', () => {
    if (!state.editingEventId || !state.activeDayISO) return;
    const iso = state.activeDayISO;
    state.data.eventRecords = state.data.eventRecords.filter(ev => ev.id !== state.editingEventId);
    saveData();
    resetEventForm();
    renderDayTimeline(iso);
    renderMonth();
    renderTodayCard();
    renderHomeScreen();
  });

  // Event options: toggle panel, recurrence until-date, colour swatches
  document.getElementById('btn-toggle-event-options').addEventListener('click', () => {
    document.getElementById('event-options').classList.toggle('hidden');
  });

  document.getElementById('event-recurrence').addEventListener('change', (e) => {
    const untilInput = document.getElementById('event-recur-until');
    const untilRow = document.getElementById('event-recur-until-row');
    const active = !!e.target.value;
    untilRow.classList.toggle('hidden', !active);
    untilInput.required = active;
  });

  document.getElementById('event-end-date').addEventListener('change', (e) => {
    document.getElementById('event-recur-until').min = e.target.value;
  });

  document.getElementById('event-color-swatches').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-color]');
    if (!btn) return;
    state.pendingEventColor = btn.dataset.color || null;
    renderEventColorSwatches();
  });

  document.getElementById('btn-toggle-period-day').addEventListener('click', () => {
    togglePeriodOnDay(state.activeDayISO);
  });

  // Expand view toggle (month <-> week)
  document.getElementById('btn-expand-view').addEventListener('click', () => {
    state.data.settings.expandedView = !state.data.settings.expandedView;
    saveData();
    if (state.data.settings.expandedView) {
      state.viewWeekStart = getWeekStart(new Date());
    }
    updateExpandButton();
    renderMonth();
    renderTodayCard();
  });

  document.getElementById('btn-prev-week').addEventListener('click', () => {
    state.viewWeekStart = addDays(state.viewWeekStart, -7);
    renderWeek();
  });
  document.getElementById('btn-next-week').addEventListener('click', () => {
    state.viewWeekStart = addDays(state.viewWeekStart, 7);
    renderWeek();
  });
  document.getElementById('btn-this-week').addEventListener('click', () => {
    state.viewWeekStart = getWeekStart(new Date());
    renderWeek();
  });

  // Log period modal
  document.getElementById('btn-log-period').addEventListener('click', () => {
    state.logPeriodReturnToSettings = false;
    openLogPeriodModal(null);
  });
  document.getElementById('btn-log-period-prev-month').addEventListener('click', () => {
    state.logPeriodPickerMonth--;
    if (state.logPeriodPickerMonth < 0) { state.logPeriodPickerMonth = 11; state.logPeriodPickerYear--; }
    renderLogPeriodPicker();
  });
  document.getElementById('btn-log-period-next-month').addEventListener('click', () => {
    state.logPeriodPickerMonth++;
    if (state.logPeriodPickerMonth > 11) { state.logPeriodPickerMonth = 0; state.logPeriodPickerYear++; }
    renderLogPeriodPicker();
  });
  document.getElementById('log-period-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const dates = [...state.logPeriodSelectedDates].sort();
    if (!dates.length) return;
    const startISO = dates[0];
    const length = dates.length;
    if (state.editingPeriodId) {
      const p = state.data.periods.find(p2 => p2.id === state.editingPeriodId);
      if (p) { p.start = startISO; p.length = length; }
      saveData();
      renderMonth();
    } else {
      logPeriod(startISO, length);
    }
    closeLogPeriodModal();
  });
  document.getElementById('btn-delete-log-period').addEventListener('click', () => {
    if (state.editingPeriodId) removePeriod(state.editingPeriodId);
    closeLogPeriodModal();
  });
  document.getElementById('btn-cancel-log-period-edit').addEventListener('click', () => {
    closeLogPeriodModal();
  });

  // Cycle modal
  document.getElementById('btn-cycle-icon').addEventListener('click', () => {
    renderCycleWheel();
    showModal('modal-cycle');
  });
  document.getElementById('btn-cycle-log-today').addEventListener('click', () => {
    logPeriod(toISO(new Date()), null);
    renderCycleWheel();
    renderSettings();
  });
  document.getElementById('btn-cycle-open-settings').addEventListener('click', () => {
    hideModal('modal-cycle');
    renderSettings();
    showModal('modal-settings');
  });

  // Pattern log modal
  document.getElementById('btn-patterns').addEventListener('click', () => {
    openPatternsModal(toISO(new Date()));
  });

  document.getElementById('pattern-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('pattern-text');
    const text = input.value.trim();
    if (!text || !state.pendingPatternDates.size) return;
    addPatternEntry(text);
    input.value = '';
  });

  document.getElementById('pattern-list').addEventListener('click', (e) => {
    const removeId = e.target.dataset.removePattern;
    if (removeId) removePatternEntry(removeId);
  });

  document.getElementById('pattern-selected-days').addEventListener('click', (e) => {
    const iso = e.target.dataset.removeDay;
    if (!iso) return;
    state.pendingPatternDates.delete(iso);
    renderPatternSelectedDays();
    renderPatternList();
    if (!document.getElementById('pattern-date-picker').classList.contains('hidden')) renderPatternPicker();
  });

  document.getElementById('btn-pattern-pick-date').addEventListener('click', () => {
    const picker = document.getElementById('pattern-date-picker');
    const btn = document.getElementById('btn-pattern-pick-date');
    if (picker.classList.contains('hidden')) {
      const anchorISO = sortedPendingDates()[0] || toISO(new Date());
      const d = fromISO(anchorISO);
      state.patternPickerYear = d.getFullYear();
      state.patternPickerMonth = d.getMonth();
      renderPatternPicker();
      picker.classList.remove('hidden');
      btn.textContent = 'Hide calendar ▲';
    } else {
      picker.classList.add('hidden');
      btn.textContent = '+ Add another day ▾';
    }
  });

  document.getElementById('btn-pattern-prev-month').addEventListener('click', () => {
    state.patternPickerMonth--;
    if (state.patternPickerMonth < 0) { state.patternPickerMonth = 11; state.patternPickerYear--; }
    renderPatternPicker();
  });
  document.getElementById('btn-pattern-next-month').addEventListener('click', () => {
    state.patternPickerMonth++;
    if (state.patternPickerMonth > 11) { state.patternPickerMonth = 0; state.patternPickerYear++; }
    renderPatternPicker();
  });

  // Settings modal
  document.getElementById('btn-settings').addEventListener('click', () => {
    renderSettings();
    showModal('modal-settings');
  });
  document.getElementById('btn-home-settings').addEventListener('click', () => {
    renderSettings();
    showModal('modal-settings');
  });

  // Today <-> Month pager
  document.getElementById('btn-go-month').addEventListener('click', () => goToPage('month'));
  document.getElementById('btn-back-today').addEventListener('click', () => goToPage('today'));

  document.getElementById('home-agenda-list').addEventListener('click', (e) => {
    if (e.target.closest('[data-open-today]')) openDayModal(toISO(new Date()));
  });

  (function setupPagerSwipe() {
    const viewport = document.getElementById('pager-viewport');
    let startX = null, startY = null, dragging = false;
    viewport.addEventListener('pointerdown', (e) => {
      startX = e.clientX; startY = e.clientY; dragging = true;
    });
    viewport.addEventListener('pointerup', (e) => {
      if (!dragging || startX === null) return;
      dragging = false;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) goToPage('month');
        else goToPage('today');
      }
      startX = null;
    });
  })();

  window.addEventListener('resize', syncPagerHeight);

  // Brain drawer: tap or drag the handle to open/close
  function setBrainDrawerOpen(open) {
    document.getElementById('brain-drawer').classList.toggle('open', open);
    document.getElementById('brain-drawer-scrim').classList.toggle('visible', open);
  }

  document.getElementById('brain-drawer-handle').addEventListener('click', () => {
    setBrainDrawerOpen(!document.getElementById('brain-drawer').classList.contains('open'));
  });
  document.getElementById('brain-drawer-scrim').addEventListener('click', () => setBrainDrawerOpen(false));

  (function setupBrainDrawerDrag() {
    const handle = document.getElementById('brain-drawer-handle');
    let startY = null, dragging = false;
    handle.addEventListener('pointerdown', (e) => { startY = e.clientY; dragging = true; });
    handle.addEventListener('pointerup', (e) => {
      if (!dragging || startY === null) return;
      dragging = false;
      const dy = e.clientY - startY;
      if (dy < -30) setBrainDrawerOpen(true);
      else if (dy > 30) setBrainDrawerOpen(false);
      startY = null;
    });
  })();

  document.getElementById('btn-save-settings').addEventListener('click', () => {
    const cycleLen = parseInt(document.getElementById('setting-cycle-length').value, 10);
    applySettingsValues(cycleLen || null, null);
    saveData();
    renderMonth();
    hideModal('modal-settings');
  });
  document.getElementById('period-history-list').addEventListener('click', (e) => {
    const removeId = e.target.dataset.removePeriod;
    const editId = e.target.dataset.editPeriod;
    const addNew = e.target.dataset.addPeriod;
    if (removeId) {
      removePeriod(removeId);
    } else if (editId) {
      const p = state.data.periods.find(p2 => p2.id === editId);
      if (p) {
        hideModal('modal-settings');
        state.logPeriodReturnToSettings = true;
        openLogPeriodModal(p);
      }
    } else if (addNew) {
      hideModal('modal-settings');
      state.logPeriodReturnToSettings = true;
      openLogPeriodModal(null);
    }
  });

  document.getElementById('color-swatches').addEventListener('click', (e) => {
    const hex = e.target.dataset.color;
    if (!hex) return;
    state.data.settings.accentColor = hex;
    saveData();
    applyAccentColor();
    renderAllColorSwatches();
    renderMonth();
    renderLegend();
  });

  document.getElementById('welcome-color-swatches').addEventListener('click', (e) => {
    const hex = e.target.dataset.color;
    if (!hex) return;
    state.data.settings.accentColor = hex;
    applyAccentColor();
    renderAllColorSwatches();
  });

  document.getElementById('btn-export-data').addEventListener('click', exportData);
  document.getElementById('btn-import-data').addEventListener('click', () => {
    document.getElementById('import-file-input').click();
  });
  document.getElementById('import-file-input').addEventListener('change', (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
  });
  document.getElementById('btn-clear-data').addEventListener('click', async () => {
    const message = state.user
      ? 'This will permanently delete your account\'s data from the cloud and log you out. Continue?'
      : 'This will permanently delete all logged periods, plans, and settings on this device. Continue?';
    if (!confirm(message)) return;
    localStorage.removeItem(STORAGE_KEY);
    if (state.user) {
      try {
        await window.CycleAuth.deleteUserDoc(state.user.uid);
        await window.CycleAuth.logOut();
      } catch (err) {
        console.error('Failed to delete cloud data', err);
      }
      state.user = null;
    }
    state.data = defaultData();
    applyAccentColor();
    hideModal('modal-settings');
    showModal('modal-onboarding');
    showWelcomeStep('welcome-step-landing');
    renderAll();
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    if (!confirm('Log out of this account on this device?')) return;
    try {
      await window.CycleAuth.logOut();
    } catch (err) {
      console.error('Logout failed', err);
    }
    localStorage.removeItem(STORAGE_KEY);
    state.user = null;
    state.data = defaultData();
    applyAccentColor();
    hideModal('modal-settings');
    showModal('modal-onboarding');
    showWelcomeStep('welcome-step-landing');
    renderAll();
  });

  // Welcome wizard: landing choice
  document.getElementById('btn-welcome-start-signup').addEventListener('click', () => {
    state.welcomeName = '';
    state.welcomePeriodDates = new Set();
    state.welcomeCycleLength = 28;
    document.getElementById('welcome-name-input').value = '';
    document.getElementById('cyclelen-custom').classList.add('hidden');
    document.getElementById('signup-error').textContent = '';
    document.getElementById('signup-form').reset();
    renderWelcomePicker();
    renderWelcomeSelectionSummary();
    showWelcomeStep('welcome-step-name');
  });
  document.getElementById('btn-welcome-start-login').addEventListener('click', () => {
    document.getElementById('login-error').textContent = '';
    document.getElementById('login-form').reset();
    showWelcomeStep('welcome-step-login');
  });
  document.querySelectorAll('[data-back-to]').forEach(btn => {
    btn.addEventListener('click', () => showWelcomeStep(btn.dataset.backTo));
  });

  // Welcome wizard: login
  document.getElementById('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    finishLogin(() => window.CycleAuth.logIn(email, password));
  });
  document.getElementById('btn-login-google').addEventListener('click', () => {
    finishLogin(() => window.CycleAuth.signInWithGoogle());
  });

  // Welcome wizard: name
  document.getElementById('welcome-name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    state.welcomeName = document.getElementById('welcome-name-input').value.trim();
    showWelcomeStep('welcome-step-period');
  });

  // Welcome wizard: period days
  document.getElementById('btn-welcome-prev-month').addEventListener('click', () => {
    state.welcomePickerMonth--;
    if (state.welcomePickerMonth < 0) { state.welcomePickerMonth = 11; state.welcomePickerYear--; }
    renderWelcomePicker();
  });
  document.getElementById('btn-welcome-next-month').addEventListener('click', () => {
    state.welcomePickerMonth++;
    if (state.welcomePickerMonth > 11) { state.welcomePickerMonth = 0; state.welcomePickerYear++; }
    renderWelcomePicker();
  });
  document.getElementById('btn-welcome-period-continue').addEventListener('click', () => {
    showWelcomeStep('welcome-step-cyclelen');
  });

  // Welcome wizard: cycle length
  document.getElementById('btn-cyclelen-yes').addEventListener('click', () => {
    state.welcomeCycleLength = 28;
    showWelcomeStep('welcome-step-colour');
  });
  document.getElementById('btn-cyclelen-no').addEventListener('click', () => {
    document.getElementById('cyclelen-custom').classList.remove('hidden');
  });
  document.getElementById('btn-cyclelen-custom-continue').addEventListener('click', () => {
    state.welcomeCycleLength = parseInt(document.getElementById('welcome-cycle-length').value, 10) || 28;
    showWelcomeStep('welcome-step-colour');
  });

  // Welcome wizard: colour
  document.getElementById('btn-colour-continue').addEventListener('click', () => {
    showWelcomeStep('welcome-step-account');
  });

  // Welcome wizard: create account
  document.getElementById('signup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    finishAccountCreation(() => window.CycleAuth.signUp(email, password), 'signup-error');
  });
  document.getElementById('btn-signup-google').addEventListener('click', () => {
    if (!document.getElementById('onboard-consent').checked) {
      document.getElementById('signup-error').textContent = 'Please check the box above first.';
      return;
    }
    finishAccountCreation(() => window.CycleAuth.signInWithGoogle(), 'signup-error');
  });
}

document.addEventListener('DOMContentLoaded', init);
