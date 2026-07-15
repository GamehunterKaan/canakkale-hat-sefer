// Çanakkale Hat & Sefer — browser/UI layer.
//
// Everything DOM-, Leaflet-, localStorage- and navigator-bound lives here. The
// headless logic (planning, schedules, guided steps, taxi, i18n) lives in
// ./core.js, which this imports and which never touches the page — so it can be
// pulled straight from GitHub Pages and used without a browser.
//
// Loaded from index.html as <script type="module" src="./ui.js">.


// ── Constants ─────────────────────────────────────────────────────────────────

// Headless logic — usable without the page. See ./core.js.
import {
  API, GUIDED_ARRIVE_M, GUIDED_BOARDED_M, MAX_NEAR_STOPS, MAX_WAIT_MIN, MINS_PER_STOP,
  REACH_GRACE_MIN, SETTINGS_DEFAULTS, STR, TAXI_TARIFF, TRANSFER_CROSS_ROAD_M,
  TRANSFER_ETA_TOLERANCE_MIN, TRANSFER_PENALTY_MIN, TRANSFER_WALK_MAX_M, VALHALLA_HOST,
  WALK_DETOUR_FACTOR, WALK_RELAX_MULT, _clockMin, _isLastSefer, _liveBoardWaitMins,
  _nextTimes, _rideMins, _schedFrame, _schedNow, _taxiEstimate, _tmMin, _travelToStopMins,
  _untilClock, _waitFromTimes, findSchedEntry, guidedStepMet, haversine, movedPast,
  pickActiveScheduleId, pickSchedDir, routeSliceCoords, schedCodeNorm, schedTimesForPath,
  todayParts, withinM,
  QS, VALHALLA_COOLDOWN_MS, VALHALLA_FAIL_THRESHOLD, WALK_ROUTE_TIMEOUT_MS, _fetchLiveBuses,
  _valhallaPost, _walkDistances, _walkMatrix, buildGuidedSteps, estimateWaitFromMins,
  getActiveRoutes, getActiveSchedule, planTrips,
  getSchedule, setSchedule, getPathCache, setPathCache,
} from './core.js';

const CACHE_KEY = 'canakkale_bus_v7';

// Çanakkale map bounds + zoom range. Tile pre-cache covers exactly this box at
// every allowed zoom, so panning/zooming inside the box works fully offline.
const MAP_BOUNDS   = [[39.95, 26.30], [40.25, 26.55]];   // [SW lat,lng], [NE lat,lng]
const MAP_MIN_ZOOM = 13;
// Interactive zoom goes to 19 so you can separate two stops that sit almost on
// top of each other. Tiles are only fetched/cached up to MAP_NATIVE_MAX_ZOOM
// (16) — beyond that Leaflet upscales the z16 tile, so offline stays intact and
// the tile cache doesn't balloon.
const MAP_MAX_ZOOM = 19;
const MAP_NATIVE_MAX_ZOOM = 16;


// ── Screen switching ──────────────────────────────────────────────────────────
let plannerReady = false;
// Planner is the default screen — init immediately
window.addEventListener('DOMContentLoaded', () => { applyTheme(SETTINGS.theme || 'dark'); applyStaticI18n(); showOnboarding(); plannerReady = true; initPlanner(); initOfflineIndicator(); });

// ── Offline indicator ───────────────────────────────────────────────────────
// navigator.onLine and the 'offline' event are unreliable across platforms
// (often stay "online" after a real WiFi disconnect). So we actively probe
// kentkart every 15s with a no-store request — that's the real source of
// truth for "can we get live bus data right now?". Real kentkart fetches
// from refreshBuses/selectTrackPath also feed into the same signal.
let kentkartFailStreak = 0;
let offlineProbeTimer  = null;
function setOfflineUI(off) {
  document.body.classList.toggle('is-offline', !!off);
}
function markKentkartResult(ok) {
  if (ok) {
    kentkartFailStreak = 0;
    setOfflineUI(false);
  } else {
    kentkartFailStreak++;
    if (kentkartFailStreak >= 2) setOfflineUI(true);
  }
}
async function probeKentkart() {
  try {
    const r = await fetch(`${API}web/nearest/find?${QS}&_=${Date.now()}`, { cache: 'no-store' });
    markKentkartResult(r.ok);
  } catch {
    markKentkartResult(false);
  }
}
function initOfflineIndicator() {
  setOfflineUI(!navigator.onLine);
  window.addEventListener('online',  () => { probeKentkart(); });
  window.addEventListener('offline', () => setOfflineUI(true));
  // Active probe loop — works even when no route is selected
  probeKentkart();
  offlineProbeTimer = setInterval(probeKentkart, 15000);
  // Pause the probe when the tab is hidden to save battery; reprobe on return
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (offlineProbeTimer) { clearInterval(offlineProbeTimer); offlineProbeTimer = null; }
    } else if (!offlineProbeTimer) {
      probeKentkart();
      offlineProbeTimer = setInterval(probeKentkart, 15000);
    }
  });
}
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  if ((SETTINGS.theme || 'dark') === 'system') applyTheme('system');
});
function showScreen(name) {
  // Reset stop-detail when leaving the Duraklar tab so re-entry shows the list,
  // and drop the ?stop=… from the URL.
  const wasStops = document.getElementById('scr-stops')?.classList.contains('active');
  if (wasStops && name !== 'stops') {
    stopDetailId = null;
    _setStopDeepLinkInUrl(null);
  }

  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('scr-' + name).classList.add('active');
  document.querySelectorAll('.nb').forEach(b => b.classList.toggle('active', b.dataset.s === name));
  if (name !== 'planner') hidePanelHandle();
  if (name === 'planner') {
    if (!plannerReady) { plannerReady = true; initPlanner(); }
    else if (window._map) setTimeout(() => window._map.invalidateSize(), 50);
    renderBookmarksBar();
  }
  if (name === 'settings') initSettingsScreen();
  if (name === 'stops') {
    renderStopsList();
    const input = document.getElementById('stop-search-input');
    if (input) setTimeout(() => input.focus(), 0);
  }
}

// ── Schedule helpers ──────────────────────────────────────────────────────────

function nowStr() {
  const n = new Date();
  return n.getHours().toString().padStart(2,'0') + ':' + n.getMinutes().toString().padStart(2,'0');
}

function hasUpcoming(times) {
  if (!times?.length) return false;
  const ns = nowStr();
  return times.some(t => t >= ns) || (new Date().getHours() >= 20 && times.some(t => t < '04:00'));
}

function countUpcoming(times) {
  if (!times?.length) return 0;
  const ns = nowStr(), late = new Date().getHours() >= 20;
  return times.filter(t => t >= ns || (late && t < '04:00')).length;
}

// ── Schedule tab ──────────────────────────────────────────────────────────────
let schedTab = null;          // currently displayed schedule id
function switchSchedTab(sid) {
  schedTab = sid;
  document.querySelectorAll('.s-tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.sid === sid);
  });
  document.querySelectorAll('.sched-content').forEach(el => {
    el.classList.toggle('visible', el.id === 'routes-' + sid);
  });
  highlightNextTimes();
}




// ══════════════════════════════════════════════════════════════
// PDF FETCHING & PARSING
// ══════════════════════════════════════════════════════════════

// ── Cache & load ──────────────────────────────────────────────────────────────
let kentkartRouteMap = null; // displayRouteCode → {name, routeColor}

// Set scheduleData and rebuild the kentkart route-color lookup from a payload.
function applyScheduleData(data) {
  setSchedule(data);
  kentkartRouteMap = null;
  if (data.routes?.length) {
    kentkartRouteMap = new Map();
    for (const route of data.routes) {
      const code = route.displayRouteCode.toUpperCase();
      const stripped = code.replace(/^Ç(?=\d)/, '');
      kentkartRouteMap.set(code, route);
      if (stripped !== code) kentkartRouteMap.set(stripped, route);
    }
  }
}

// Fetch the freshest schedule.json straight from the network. The cache-busting
// query + no-store dodges both the HTTP cache and the service worker's
// stale-while-revalidate (which would otherwise hand back the cached copy).
// Throws on failure so callers can fall back to the cached copy.
async function fetchScheduleFresh() {
  // Hard timeout so a hanging request can never strand the schedule load.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch('./data/schedule.json?_=' + Date.now(), { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) throw new Error('schedule.json alınamadı (refresh)');
    const data = await r.json();
    if (!Array.isArray(data.schedules)) throw new Error('schedule.json geçersiz');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Read the saved schedule copy from storage (null if none/invalid).
function _savedSchedule() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (c && Array.isArray(c.schedules)) return c;
  } catch {}
  return null;
}

// Schedule loading, dead simple and service-worker-independent:
//   • Returning user (not a manual refresh): show the saved copy from storage
//     instantly, then refresh in the background and re-save if newer.
//   • Otherwise (first visit / private tab / manual refresh): pull schedule.json
//     fresh from the network (cache-busted, bypasses the SW, timed out), save it
//     to storage, and use it. If the network is unreachable, use the saved copy.
async function loadScheduleData(forceRefresh) {
  if (!forceRefresh) {
    const saved = _savedSchedule();
    if (saved) {
      applyScheduleData(saved);
      refreshScheduleInBackground(saved.fetchedAt);
      return;
    }
  }

  setSchedProgress(10, t('schedLoading'));
  let data = null;
  try { data = await fetchScheduleFresh(); }   // network first (cache-busted, bypasses SW, timed out)
  catch { data = _savedSchedule(); }           // offline / unreachable → saved storage copy
  if (!data) throw new Error('schedule.json alınamadı');

  applyScheduleData(data);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
  setSchedProgress(100, t('schedDone'));
}

// Fire-and-forget: pull the newest schedule.json and, if its build is newer
// than what's shown, swap it in and re-render the Seferler tab (keeping the
// user's open tab). Silent on failure so offline users keep the cached copy.
let _schedBgRefreshed = false;
async function refreshScheduleInBackground(shownFetchedAt) {
  if (_schedBgRefreshed) return;   // at most once per page load
  _schedBgRefreshed = true;
  let data;
  try { data = await fetchScheduleFresh(); } catch { return; }
  if (!(data.fetchedAt > (shownFetchedAt || 0))) return; // nothing newer
  applyScheduleData(data);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch {}
  if (document.getElementById('schedTabs')?.children.length) {
    const keep = schedTab;
    renderSchedule();
    if (keep && document.getElementById('routes-' + keep)) switchSchedTab(keep);
  }
}

function setSchedProgress(pct, msg, isError) {
  document.getElementById('schedProgressBar').style.width = pct + '%';
  document.getElementById('schedProgressBar').style.background = isError ? '#ef4444' : '';
  const msgEl = document.getElementById('schedMsg');
  msgEl.textContent = msg;
  msgEl.style.color = isError ? '#ef4444' : '';
}

// ── Render schedule ───────────────────────────────────────────────────────────
function renderSchedule() {
  if (!getSchedule()?.schedules?.length) {
    setSchedProgress(100, t('schedNoData'), true);
    return;
  }

  document.getElementById('schedLoading').style.display = 'none';

  const activeId = pickActiveScheduleId(getSchedule().schedules, todayParts());
  const tabRow   = document.getElementById('schedTabs');
  const panels   = document.getElementById('schedPanels');
  tabRow.innerHTML = '';
  panels.innerHTML = '';

  for (const s of getSchedule().schedules) {
    const isActive = s.id === activeId;
    const btn = document.createElement('button');
    btn.className   = 's-tab-btn';
    btn.dataset.sid = s.id;
    btn.textContent = schedDayLabel(s.label) || s.id;
    btn.onclick     = () => switchSchedTab(s.id);
    tabRow.appendChild(btn);

    const panel = document.createElement('div');
    panel.className = 'sched-content';
    panel.id        = 'routes-' + s.id;
    panels.appendChild(panel);

    // Pass isActive as the "isToday" flag so the next-departure highlight
    // only runs on today's schedule, not on previewed tabs.
    renderRouteCards(s.routes || {}, panel.id, isActive);
  }

  switchSchedTab(activeId);
  highlightNextTimes();
}

function renderRouteCards(routeMap, panelId, isToday) {
  const cont = document.getElementById(panelId);
  cont.innerHTML = '';
  const codes = Object.keys(routeMap).sort((a, b) => a.localeCompare(b, 'tr'));
  let shown = 0;

  for (const code of codes) {
    const entry = routeMap[code];
    if (!entry) continue;
    const { name, dir0, dir1 } = entry;

    // When showing today's tab, hide routes with no remaining buses
    const d0 = dir0?.times || [], d1 = dir1?.times || [];
    if (isToday && !hasUpcoming(d0) && !hasUpcoming(d1)) continue;

    const remaining = isToday ? (countUpcoming(d0) + countUpcoming(d1)) : (d0.length + d1.length);

    let body = '';
    // Direction 0
    if (d0.length) {
      const lbl = dir0.label ? esc(dir0.label) + ' →' : t('dirOut');
      body += '<div class="dir-section"><div class="dir-lbl">' + lbl + '</div>'
        + '<div class="times-grid">'
        + d0.map(t => '<span class="time-chip" data-time="' + t + '">' + t + '</span>').join('')
        + '</div></div>';
    }
    // Direction 1
    if (d1.length) {
      const lbl = dir1.label ? esc(dir1.label) + ' →' : t('dirIn');
      body += '<div class="dir-section"><div class="dir-lbl">' + lbl + '</div>'
        + '<div class="times-grid">'
        + d1.map(t => '<span class="time-chip" data-time="' + t + '">' + t + '</span>').join('')
        + '</div></div>';
    }
    if (!body) continue;

    const metaText = isToday
      ? (remaining > 0 ? t('schedRemaining',{n:remaining}) : t('schedNoneLeft'))
      : t('schedTotal',{n:(d0.length + d1.length)});

    // Look up kentkart display name and color using the route code prefix.
    // Express PDF entries ("… EKSPRES") map to the kentkart "-E" variant.
    const pdfCode    = code.split(/\s+/)[0]; // e.g. "Ç1", "Ç11K", "Ç960"
    const baseCode   = pdfCode.replace(/^Ç(?=\d)/, '').toUpperCase(); // "11K"
    const isExpress  = /EKSPRES/i.test(name);
    const ktRoute    = kentkartRouteMap &&
      ((isExpress && kentkartRouteMap.get(baseCode + '-E')) ||
       kentkartRouteMap.get(pdfCode.toUpperCase()) ||
       kentkartRouteMap.get(baseCode));
    const hexColor   = ktRoute?.routeColor?.replace('#','').padStart(6,'0') || '252d40';
    const textColor  = (() => {
      const r=parseInt(hexColor.slice(0,2),16), g=parseInt(hexColor.slice(2,4),16), b=parseInt(hexColor.slice(4,6),16);
      return (r*299+g*587+b*114)/1000 > 145 ? '#000' : '#fff';
    })();
    const displayCode = ktRoute?.displayRouteCode || (isExpress ? baseCode + '-E' : pdfCode);
    // Use PDF-parsed name so routes with the same code (e.g. Ç11K KEPEZ vs Ç11K DARDANOS)
    // are always distinguishable; strip the leading route-code token to avoid duplication.
    const pdfDest    = name.replace(/^[A-ZÇŞĞÜÖİ0-9]+\s*/i, '').trim();
    const displayName = esc(pdfDest || name);

    const card = document.createElement('div');
    card.className = 'route-card';
    card.dataset.code = code;
    card.innerHTML =
      '<div class="route-card-header" onclick="this.parentElement.classList.toggle(\'open\')">' +
        '<div style="display:flex;align-items:center;gap:7px;flex:1;min-width:0">' +
          '<span class="sched-badge" style="background:#' + hexColor + ';color:' + textColor + '">' + esc(displayCode) + '</span>' +
          '<span class="rc-name" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + displayName + '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;margin-left:6px">' +
          '<span class="rc-meta">' + metaText + '</span>' +
          '<button class="sched-track-btn" onclick="event.stopPropagation();trackRoute(\''+esc(displayCode)+'\')">' +
            '<span style="font-size:.8rem;line-height:1">🚌</span>'+t('canli') +
          '</button>' +
          '<span class="rc-chevron">▼</span>' +
        '</div>' +
      '</div>' +
      '<div class="route-card-body">' + body + '</div>';
    cont.appendChild(card);
    shown++;
  }

  if (!shown)
    cont.innerHTML = '<p style="color:#4a5568;padding:20px;font-size:.85rem">' +
      (isToday ? t('schedNoneTodayLong') : t('schedNoneForDay')) + '</p>';
}

function highlightNextTimes() {
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
  // Only highlight chips in the currently-visible tab
  const visible = document.querySelector('.sched-content.visible');
  if (!visible) return;
  visible.querySelectorAll('.time-chip').forEach(chip => {
    const [h, m] = chip.dataset.time.split(':').map(Number);
    const mins   = h < 4 ? h * 60 + m + 1440 : h * 60 + m;
    chip.className = 'time-chip' + (mins < nowMins ? ' past' : '');
  });
  // Mark next upcoming chip — prefer today's times (h >= 4) over overnight wrap-around
  visible.querySelectorAll('.dir-section .times-grid').forEach(grid => {
    const upcoming = [...grid.querySelectorAll('.time-chip:not(.past)')];
    const next = upcoming.find(c => parseInt(c.dataset.time) >= 4) || upcoming[0];
    if (next) next.classList.add('next');
  });
}

async function refreshSchedule() {
  document.getElementById('schedLoading').style.display = '';
  document.querySelectorAll('.sched-content').forEach(el => el.classList.remove('visible'));
  try {
    await loadScheduleData(true);
    renderSchedule();
  } catch(e) {
    setSchedProgress(100, t('schedError',{err:e.message}), true);
    if (getSchedule()) renderSchedule();
  }
}

// Kick off schedule loading on the next tick. This MUST run after the whole
// inline script has executed, because loadScheduleData → setSchedProgress → t()
// reads the STR i18n dictionary, which is a `const` declared further down this
// file. Calling it inline here would hit STR's temporal dead zone and throw
// ("Cannot access 'STR' before initialization"), which silently stranded the
// schedule on a cold load (first visit / private tab / cleared cache).
setTimeout(async () => {
  try {
    await loadScheduleData(false);
    renderSchedule();
    applyDeepLink();
  } catch(e) {
    setSchedProgress(100, t('schedLoadFail',{err:e.message}), true);
  }
}, 0);

setInterval(highlightNextTimes, 60000);

setInterval(() => {
  if (!getSchedule()) return;
  const age = Math.round((Date.now() - getSchedule().fetchedAt) / 60000);
}, 60000);

// Auto-refresh at midnight each day
function scheduleMidnightRefresh() {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 10, 0); // 00:00:10 tomorrow (10s past midnight for safety)
  setTimeout(async () => {
    await refreshSchedule();
    scheduleMidnightRefresh(); // set up the next night
  }, next - now);
}
scheduleMidnightRefresh();

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

let SETTINGS = (() => {
  try { return { ...SETTINGS_DEFAULTS, ...JSON.parse(localStorage.getItem('bm_settings_v1') || '{}') }; }
  catch { return { ...SETTINGS_DEFAULTS }; }
})();
function saveSettings() { try { localStorage.setItem('bm_settings_v1', JSON.stringify(SETTINGS)); } catch {} }

// ══════════════════════════════════════════════════════════════
// i18n — Turkish / English. Data-sourced text (municipality day/Bayram labels,
// kentkart stop & route names) stays Turkish; everything user-facing in the UI
// goes through t(). Language is resolved once: saved pref → browser → Turkish.
// ══════════════════════════════════════════════════════════════
if (!SETTINGS.lang) { SETTINGS.lang = /^tr/i.test(navigator.language || '') ? 'tr' : 'en'; saveSettings(); }
// Common municipality day labels → English (data otherwise stays Turkish).
const SCHED_DAY_LABELS_EN = { 'Hafta İçi': 'Weekday', 'Hafta Sonu': 'Weekend', 'Cumartesi': 'Saturday', 'Pazar': 'Sunday' };
function schedDayLabel(label) {
  if (lang() === 'en' && label && SCHED_DAY_LABELS_EN[label.trim()]) return SCHED_DAY_LABELS_EN[label.trim()];
  return label;
}
// Active UI language. NOT named `L` — that's Leaflet's global.
function lang() { return SETTINGS.lang === 'en' ? 'en' : 'tr'; }
function t(key, vars) {
  const dict = STR[lang()] || STR.tr;
  let s = dict[key]; if (s == null) s = STR.tr[key]; if (s == null) return key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}
// Translate static markup tagged with data-i18n* attributes.
function applyStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  document.documentElement.lang = lang();
  document.querySelectorAll('[data-lang-opt]').forEach(b => b.classList.toggle('active', b.dataset.langOpt === lang()));
}
// Re-render whatever is on screen so a language switch takes effect immediately.
function refreshActiveI18n() {
  try { if (getSchedule()) renderSchedule(); } catch {}
  try { if (currentMatches && currentMatches.length) renderPlannerResults(currentMatches); } catch {}
  try { if (tripMatch) showTripDetail(tripMatch, false, true); } catch {}
  // Planner guide (shown before any plan): re-render it for the current pick mode.
  try { if (document.getElementById('planner-guide') && (mode === 'origin' || mode === 'dest')) showPlannerGuide(mode); } catch {}
  try { renderBookmarksBar(); renderRecentDests(); } catch {}
  try { if (document.getElementById('scr-stops')?.classList.contains('active')) renderStopsList(); } catch {}
}
function setLang(l) {
  SETTINGS.lang = (l === 'en' ? 'en' : 'tr');
  saveSettings();
  applyStaticI18n();
  refreshActiveI18n();
}

// ── Push notification config (fill in after running generate-keys.js + deploying worker) ──
const VAPID_PUBLIC_KEY = 'BHVCtR1I7eXOv825k0yVg3E6y59A0p7wlgO3rUD90sEOXIec97qg4z5ybGlGjcltgQQxytPw6LD9Q202YxZeC7s';
const WORKER_URL       = 'https://bus-notify.17bus-notify.workers.dev'; // e.g. https://bus-notify.yourname.workers.dev

let planOffset = 0; // minutes into the future to plan for

let allStops     = new Map();
let allRoutes    = [];
let stopToRoutes = new Map();
let mode         = 'origin';
let originStop = null, destStop   = null;
let originClick = null, destClick = null;
let originMarker = null, destMarker = null;
let originPin = null, destPin = null;
let busMarkers      = [];
let drawnLayers     = [];
let networkStopLayer = null;
let refreshTimer = null;
let selectedMatch = null;
let currentMatches = [];
let tripMatch = null;
let currentTaxi = null;   // { km, min, tl } driving estimate for the active O/D, shown at the bottom of results
// Guided "Start Trip" state — self-contained; draws only into its own layer group.
let guided = { active: false, m: null, steps: [], idx: 0, group: null, timer: null, wakeLock: null, userPanned: false, fetching: false };
let _guidedPanHook = false;
// Block origin/dest picking while a guided trip is active. (The End/Back/Next
// buttons stopPropagation so their clicks never reach the map in the first place
// — see guidedRenderBanner; this just stops stray map taps mid-trip.)
function guidedLocksPicks() { return !!(guided && guided.active); }
let stopRefreshTimer = null;
let openStopId   = null;

// ── Bookmarks ─────────────────────────────────────────────────────────────────
let bookmarks = (() => { try { return JSON.parse(localStorage.getItem('bm_locations') || '[]'); } catch { return []; } })();

function saveBookmarks() {
  try { localStorage.setItem('bm_locations', JSON.stringify(bookmarks)); } catch {}
}

// ── Recent destinations ──────────────────────────────────────────────────────
let recentDests = (() => { try { return JSON.parse(localStorage.getItem('bm_recent_dests_v1') || '[]'); } catch { return []; } })();

// ── Deep-link parsing ───────────────────────────────────────────────────────
// Share-friendly URLs like /?stop=12345 open that stop's detail in Duraklar.
let _pendingStopDeepLink = (() => {
  try { return new URLSearchParams(window.location.search).get('stop') || null; }
  catch { return null; }
})();
function applyDeepLink() {
  if (!_pendingStopDeepLink) return;
  if (!allStops || !allStops.size) return; // try again after stops finish loading
  const id = _pendingStopDeepLink;
  _pendingStopDeepLink = null;
  if (!allStops.has(id)) return;            // unknown stop, give up silently
  stopDetailId = id;
  pushRecentStop(id);
  showScreen('stops');
}

// ── Duraklar tab state ──────────────────────────────────────────────────────
let favStops    = (() => { try { return JSON.parse(localStorage.getItem('bm_fav_stops_v1')    || '[]'); } catch { return []; } })();
let recentStops = (() => { try { return JSON.parse(localStorage.getItem('bm_recent_stops_v1') || '[]'); } catch { return []; } })();
let lastUserPos  = null;       // {lat, lng} cached for the session
let nearbyDenied = false;      // GPS denied/unavailable — show hint instead
let stopDetailId = null;       // currently drilled-in stop, null = list view

function saveStopFavs()    { try { localStorage.setItem('bm_fav_stops_v1',    JSON.stringify(favStops));    } catch {} }
function saveRecentStops() { try { localStorage.setItem('bm_recent_stops_v1', JSON.stringify(recentStops)); } catch {} }

function toggleFavStop(stopId) {
  if (favStops.includes(stopId)) favStops = favStops.filter(id => id !== stopId);
  else                            favStops = [stopId, ...favStops];
  saveStopFavs();
  renderStopsList();
}

function pushRecentStop(stopId) {
  if (!stopId) return;
  recentStops = [{ stopId, ts: Date.now() }, ...recentStops.filter(r => r.stopId !== stopId)].slice(0, 5);
  saveRecentStops();
}

function saveRecentDests() {
  try { localStorage.setItem('bm_recent_dests_v1', JSON.stringify(recentDests)); } catch {}
}

function pushRecentDest(stop) {
  if (!stop || !stop.stopId) return;
  recentDests = [{ stopId: stop.stopId, stopName: stop.stopName, lat: stop.lat, lng: stop.lng, ts: Date.now() },
                 ...recentDests.filter(r => r.stopId !== stop.stopId)].slice(0, 5);
  saveRecentDests();
}

function removeRecentDest(stopId) {
  recentDests = recentDests.filter(r => r.stopId !== stopId);
  saveRecentDests();
  renderRecentDests();
}

function renderRecentDests() {
  const el = document.getElementById('recent-dests');
  if (!el) return;
  // Only show in 'dest' mode when destination not yet picked, and we have history
  if (mode !== 'dest' || destClick || !recentDests.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  // Filter out stops that no longer exist (data refreshed)
  const valid = recentDests.filter(r => allStops.has(r.stopId));
  if (valid.length !== recentDests.length) { recentDests = valid; saveRecentDests(); }
  if (!valid.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = 'flex';
  el.innerHTML = '<span class="chip-label">Son:</span>' + valid.map(r =>
    '<span class="chip" onclick="useRecentDest(\'' + r.stopId + '\')">' +
      '<span>' + esc(r.stopName) + '</span>' +
      '<span class="chip-x" onclick="event.stopPropagation();removeRecentDest(\'' + r.stopId + '\')">✕</span>' +
    '</span>'
  ).join('');
}

function useRecentDest(stopId) {
  const r = recentDests.find(x => x.stopId === stopId);
  if (!r) return;
  setMode('dest');
  applyPoint(r.lat, r.lng, 'dest');
}

// ── Settings ─────────────────────────────────────────────────────────────────
function applyTheme(mode) {
  // mode: 'dark' | 'light' | 'system'
  let effective = mode;
  if (mode === 'system') {
    effective = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', effective);
  // Update active state on theme buttons
  document.querySelectorAll('.theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.themeOpt === mode);
  });
}

function setTheme(mode) {
  SETTINGS.theme = mode;
  saveSettings();
  applyTheme(mode);
}

let _settingsRefreshTimer = null;
function updateSliderFill(slider) {
  const pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
  slider.style.setProperty('--val-pct', pct);
}
function initSettingsScreen() {
  // Sliders
  const rSlider = document.getElementById('walkRadiusSlider');
  const sSlider = document.getElementById('walkSpeedSlider');
  const rVal    = document.getElementById('walkRadiusVal');
  const sVal    = document.getElementById('walkSpeedVal');
  if (!rSlider) return;
  rSlider.value = SETTINGS.walkRadius;
  sSlider.value = SETTINGS.walkSpeedMpm;
  rVal.textContent = SETTINGS.walkRadius + ' m';
  sVal.textContent = SETTINGS.walkSpeedMpm + ' ' + t('unitMpm');
  updateSliderFill(rSlider);
  updateSliderFill(sSlider);

  const onSlide = () => {
    SETTINGS.walkRadius   = parseInt(rSlider.value, 10);
    SETTINGS.walkSpeedMpm = parseInt(sSlider.value, 10);
    rVal.textContent = SETTINGS.walkRadius + ' m';
    sVal.textContent = SETTINGS.walkSpeedMpm + ' ' + t('unitMpm');
    updateSliderFill(rSlider);
    updateSliderFill(sSlider);
    clearTimeout(_settingsRefreshTimer);
    _settingsRefreshTimer = setTimeout(() => {
      saveSettings();
      if (originClick && destClick) findRoutes();
    }, 300);
  };
  rSlider.oninput = onSlide;
  sSlider.oninput = onSlide;

  // Theme active button
  applyTheme(SETTINGS.theme || 'dark');

  // Offline map: show actual tile count and rough size estimate
  const hint = document.getElementById('mapCacheHint');
  if (hint) {
    const count = _tilesForBounds().length;
    const sizeMB = Math.max(1, Math.round(count * 12 / 1024));  // ~12 KB / tile average
    hint.textContent = t('offlineHintSize', { count, size: sizeMB });
  }
}

function resetWalkRadius() {
  SETTINGS.walkRadius = SETTINGS_DEFAULTS.walkRadius;
  saveSettings();
  const s = document.getElementById('walkRadiusSlider');
  if (s) { s.value = SETTINGS.walkRadius; updateSliderFill(s); document.getElementById('walkRadiusVal').textContent = SETTINGS.walkRadius + ' m'; }
  if (originClick && destClick) findRoutes();
}
function resetWalkSpeed() {
  SETTINGS.walkSpeedMpm = SETTINGS_DEFAULTS.walkSpeedMpm;
  saveSettings();
  const s = document.getElementById('walkSpeedSlider');
  if (s) { s.value = SETTINGS.walkSpeedMpm; updateSliderFill(s); document.getElementById('walkSpeedVal').textContent = SETTINGS.walkSpeedMpm + ' ' + t('unitMpm'); }
  if (originClick && destClick) findRoutes();
}

function clearBookmarksData() {
  if (!confirm(t('clearBookmarksConfirm'))) return;
  bookmarks = [];
  saveBookmarks();
  renderBookmarksBar();
  alert(t('cleared'));
}
function clearRecentsData() {
  if (!confirm(t('clearRecentsConfirm'))) return;
  recentDests = [];
  saveRecentDests();
  renderRecentDests();
  alert(t('cleared'));
}
function resetOnboarding() {
  localStorage.removeItem('onboarded_v2');
  alert(t('onboardingReset'));
}

// ── Offline map tile pre-cache ─────────────────────────────────────────────
// Compute all OSM tiles covering MAP_BOUNDS at every allowed zoom, fetch them
// (routed through the SW → cached). Cap concurrency so we don't hammer OSM.
function _lng2tile(lng, z) { return Math.floor((lng + 180) / 360 * Math.pow(2, z)); }
function _lat2tile(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1/Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
}
function _tilesForBounds() {
  // Match Leaflet's _getSubdomain formula: subdomains[abs(x+y) % len]
  // so every URL we pre-cache here is exactly the one Leaflet will request.
  const urls = [];
  const [[sLat, wLng], [nLat, eLng]] = MAP_BOUNDS;
  const subs = ['a','b','c'];
  for (let z = MAP_MIN_ZOOM; z <= MAP_NATIVE_MAX_ZOOM; z++) {
    const x0 = _lng2tile(wLng, z), x1 = _lng2tile(eLng, z);
    const y0 = _lat2tile(nLat, z), y1 = _lat2tile(sLat, z);
    for (let x = Math.min(x0,x1); x <= Math.max(x0,x1); x++) {
      for (let y = Math.min(y0,y1); y <= Math.max(y0,y1); y++) {
        const sub = subs[Math.abs(x + y) % subs.length];
        urls.push(`https://${sub}.tile.openstreetmap.org/${z}/${x}/${y}.png`);
      }
    }
  }
  return urls;
}
let _tileDownloadAbort = null;
async function downloadOfflineMap() {
  const urls = _tilesForBounds();
  const total = urls.length;
  const btn = document.getElementById('mapCacheBtn');
  const status = document.getElementById('mapCacheStatus');
  if (!btn || !status) return;
  if (_tileDownloadAbort) { _tileDownloadAbort.abort(); _tileDownloadAbort = null; btn.textContent = t('setOfflineBtn'); status.textContent = t('cancelled'); return; }
  _tileDownloadAbort = new AbortController();
  const signal = _tileDownloadAbort.signal;
  btn.textContent = t('cancelBtn');
  let done = 0, failed = 0;
  const update = () => { status.textContent = done + ' / ' + total + (failed ? ' (' + failed + ' ' + t('tileErrors') + ')' : ''); };
  update();
  let idx = 0;
  async function worker() {
    while (idx < urls.length && !signal.aborted) {
      const u = urls[idx++];
      try {
        const r = await fetch(u, { signal });
        if (!r.ok) failed++;
      } catch { if (!signal.aborted) failed++; }
      done++;
      update();
    }
  }
  await Promise.all(Array.from({length: 4}, worker));
  _tileDownloadAbort = null;
  btn.textContent = t('setOfflineBtn');
  if (signal.aborted) return;
  status.textContent = t('offlineDone', { ok: (done - failed), total });
  try { localStorage.setItem('bm_map_cached_v1', String(Date.now())); } catch {}
}

function renderBookmarksBar() {
  const list = document.getElementById('bm-list');
  if (!list) return;
  // Update header button label with count
  const lbl = document.getElementById('bm-toggle-label');
  if (lbl) lbl.textContent = bookmarks.length ? t('savedPlacesN',{n:bookmarks.length}) : t('savedPlaces');
  if (!bookmarks.length) {
    list.innerHTML = '<div class="bm-dd-empty">'+t('bmEmpty')+'</div>';
    return;
  }
  list.innerHTML = bookmarks.map((bm, i) =>
    '<div class="bm-card" style="margin:2px 8px 2px">' +
      '<span class="bm-icon">⭐</span>' +
      '<span class="bm-name" title="' + esc(bm.name) + '">' + esc(bm.name) + '</span>' +
      '<div class="bm-actions">' +
        '<button class="bm-btn origin" onclick="useBookmark('+i+',\'origin\')" title="'+t('bmStart')+'">📍</button>' +
        '<button class="bm-btn dest"   onclick="useBookmark('+i+',\'dest\')"   title="'+t('bmDest')+'">🏁</button>' +
        '<button class="bm-btn del"    onclick="deleteBookmark('+i+')"         title="'+t('bmDelete')+'">✕</button>' +
      '</div>' +
    '</div>'
  ).join('');
}

function toggleBmDropdown() {
  const dd  = document.getElementById('bm-dropdown');
  const btn = document.getElementById('bm-toggle-btn');
  const open = dd.classList.toggle('open');
  btn.classList.toggle('open', open);
  if (open) renderBookmarksBar();
}

// ── Stop search (Duraklar tab) ──────────────────────────────────────────────
// Strip Turkish diacritics + lowercase for accent-insensitive search.
function _foldTr(s) {
  return (s || '').toLocaleLowerCase('tr')
    .replace(/ı/g, 'i').replace(/ç/g, 'c').replace(/ğ/g, 'g')
    .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u');
}

// Render one stop list item. `distMeters` optional — when omitted and GPS is
// known, the distance is computed automatically so it shows up in every list.
function _stopItemHtml(stopId, stopName, distMeters) {
  const fav    = favStops.includes(stopId);
  const routes = stopToRoutes.get(stopId) || [];
  // Dedup by routeCode, sort, build small colour chips
  const seenR = new Set(), uniqR = [];
  for (const r of routes) {
    if (seenR.has(r.routeCode)) continue;
    seenR.add(r.routeCode); uniqR.push(r);
  }
  uniqR.sort((a, b) => a.routeCode.localeCompare(b.routeCode, 'tr'));
  const MAX_CHIPS = 6;
  const visible = uniqR.slice(0, MAX_CHIPS);
  const more    = uniqR.length - visible.length;
  const chipsHtml = visible.map(r => {
    const hex = (r.routeColor || '4a7dc0').replace('#','').padStart(6,'0');
    return '<span class="ss-route-chip" style="background:#' + hex + ';color:' + textOnHex(hex) + '">' + esc(r.routeCode) + '</span>';
  }).join('') + (more > 0 ? '<span class="ss-route-chip more">+' + more + '</span>' : '');

  // Auto-fill distance from cached GPS when not explicitly provided.
  if (distMeters == null && lastUserPos) {
    const s = allStops.get(stopId);
    if (s) distMeters = haversine(lastUserPos.lat, lastUserPos.lng, s.lat, s.lng);
  }

  const meta = ['#' + esc(stopId)];
  if (distMeters != null) {
    meta.push(distMeters < 1000 ? Math.round(distMeters) + ' m' : (distMeters/1000).toFixed(1) + ' km');
  }
  return '<div class="ss-item" onclick="openStopDetail(\'' + stopId + '\')">'
       +   '<div class="ss-text">'
       +     '<div class="ss-name">' + esc(stopName) + '</div>'
       +     '<div class="ss-meta">' + meta.join(' · ') + '</div>'
       +     (chipsHtml ? '<div class="ss-chips">' + chipsHtml + '</div>' : '')
       +   '</div>'
       +   '<button class="ss-fav' + (fav ? ' on' : '') + '" '
       +          'onclick="event.stopPropagation();toggleFavStop(\'' + stopId + '\')" '
       +          'title="' + (fav ? t('favRemove') : t('favAdd')) + '">'
       +     (fav ? '★' : '☆')
       +   '</button>'
       + '</div>';
}

function _renderSection(id, title, html) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!html) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  el.innerHTML = '<div class="stops-section-title">' + title + '</div>' + html;
}

function _searchStops(q, limit) {
  const items = [];
  for (const s of allStops.values()) {
    const n = _foldTr(s.stopName);
    if (!n.includes(q)) continue;
    let rank = 2;
    if (n.startsWith(q)) rank = 0;
    else if (new RegExp('(^|\\s)' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(n)) rank = 1;
    items.push({ s, rank });
    if (items.length > 200) break;
  }
  items.sort((a, b) => a.rank - b.rank || a.s.stopName.localeCompare(b.s.stopName, 'tr'));
  return items.slice(0, limit).map(x => x.s);
}

function renderStopsList() {
  // Detail-view mode: defer to detail renderer.
  if (stopDetailId) {
    document.getElementById('stops-list-view').style.display = 'none';
    document.getElementById('stops-detail-view').style.display = '';
    renderStopDetail();
    return;
  }
  document.getElementById('stops-list-view').style.display = '';
  document.getElementById('stops-detail-view').style.display = 'none';

  if (!allStops?.size) {
    _renderSection('stops-section-search', '', '<div class="ss-empty">'+t('searchLoading')+'</div>');
    _renderSection('stops-section-favs',   '', '');
    _renderSection('stops-section-recent', '', '');
    _renderSection('stops-section-nearby', '', '');
    return;
  }

  const input = document.getElementById('stop-search-input');
  const q = _foldTr((input?.value || '').trim());

  if (q.length > 0) {
    const results = _searchStops(q, 30);
    const html = results.length
      ? results.map(s => _stopItemHtml(s.stopId, s.stopName)).join('')
      : '<div class="ss-empty">'+t('noMatchStop')+'</div>';
    _renderSection('stops-section-search', t('resultsTitle'), html);
    _renderSection('stops-section-favs',   '', '');
    _renderSection('stops-section-recent', '', '');
    _renderSection('stops-section-nearby', '', '');
    return;
  }

  // Empty query — show favs, recents, nearby.
  _renderSection('stops-section-search', '', '');

  // Favorites — show a discoverability hint when empty so first-time users
  // realise the ★ button does something.
  const favItems = favStops.map(id => allStops.get(id)).filter(Boolean);
  _renderSection('stops-section-favs',
    t('favsTitle'),
    favItems.length
      ? favItems.map(s => _stopItemHtml(s.stopId, s.stopName)).join('')
      : '<div class="ss-empty">'+t('favHint')+'</div>');

  // Recent (drop any stale stopIds)
  const recItems = recentStops.map(r => allStops.get(r.stopId)).filter(Boolean);
  _renderSection('stops-section-recent',
    t('recentOpenedTitle'),
    recItems.length ? recItems.map(s => _stopItemHtml(s.stopId, s.stopName)).join('') : '');

  // Nearby
  if (lastUserPos) {
    const ranked = [...allStops.values()]
      .map(s => ({ s, d: haversine(lastUserPos.lat, lastUserPos.lng, s.lat, s.lng) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 8);
    _renderSection('stops-section-nearby',
      t('nearbyTitle'),
      ranked.map(({ s, d }) => _stopItemHtml(s.stopId, s.stopName, d)).join(''));
  } else if (nearbyDenied) {
    _renderSection('stops-section-nearby',
      t('nearbyTitle'),
      '<div class="ss-empty">'+t('nearbyDenied')
      + '<br><button class="ss-action" onclick="requestNearbyOnce(true)">'+t('retryBtn')+'</button></div>');
  } else {
    _renderSection('stops-section-nearby',
      t('nearbyTitle'),
      '<div class="ss-empty">'+t('nearbyLoading')+'</div>');
    requestNearbyOnce();
  }
}

function requestNearbyOnce(force) {
  if (!navigator.geolocation) { nearbyDenied = true; renderStopsList(); return; }
  if (lastUserPos && !force) return;
  if (force) nearbyDenied = false;
  navigator.geolocation.getCurrentPosition(
    pos => { lastUserPos = { lat: pos.coords.latitude, lng: pos.coords.longitude }; renderStopsList(); },
    ()  => { nearbyDenied = true; renderStopsList(); },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 }
  );
}

function openStopDetail(stopId) {
  stopDetailId = stopId;
  pushRecentStop(stopId);
  _setStopDeepLinkInUrl(stopId);
  renderStopsList();
}

function closeStopDetail() {
  stopDetailId = null;
  _setStopDeepLinkInUrl(null);
  renderStopsList();
}

// Keep the URL's ?stop=… in sync with the currently viewed stop so the link
// stays shareable while you're inside a detail view, and clears the moment
// you back out or leave the tab.
function _setStopDeepLinkInUrl(stopId) {
  try {
    const u = new URL(window.location.href);
    if (stopId) u.searchParams.set('stop', stopId);
    else        u.searchParams.delete('stop');
    const qs = u.searchParams.toString();
    history.replaceState(null, '', u.pathname + (qs ? '?' + qs : '') + u.hash);
  } catch {}
}

function shareStop(stopId) {
  const stop = allStops.get(stopId); if (!stop) return;
  const url = window.location.origin + window.location.pathname + '?stop=' + encodeURIComponent(stopId);
  if (navigator.share) {
    navigator.share({ title: stop.stopName, text: t('shareText',{name:stop.stopName}), url }).catch(() => {});
  } else if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(
      () => setHint(t('linkCopied')),
      () => prompt(t('copyLinkPrompt'), url)
    );
  } else {
    prompt(t('copyLinkPrompt'), url);
  }
}

function renderStopDetail() {
  const wrap = document.getElementById('stops-detail-view');
  if (!wrap) return;
  const stop = allStops.get(stopDetailId);
  if (!stop) {
    wrap.innerHTML = '<button class="sd-back" onclick="closeStopDetail()">'+t('setBack')+'</button>'
                   + '<div class="ss-empty">'+t('stopNotFound')+'</div>';
    return;
  }
  const fav = favStops.includes(stop.stopId);

  // Routes serving this stop — dedup by routeCode + direction, keep route metadata.
  const routes = stopToRoutes.get(stop.stopId) || [];
  const seen = new Set();
  const uniq = [];
  for (const r of routes) {
    const key = r.routeCode + '|' + r.direction;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(r);
  }
  uniq.sort((a, b) => a.routeCode.localeCompare(b.routeCode, 'tr') || (a.direction || '').localeCompare(b.direction || ''));
  const routeCount = new Set(uniq.map(r => r.routeCode)).size;

  const routesHtml = uniq.length
    ? uniq.map((r, i) => {
        const hex = (r.routeColor || '4a7dc0').replace('#', '');
        const fg  = textOnHex(hex);
        const head = r.headSign || r.routeName || '';
        return '<div class="sd-route" id="sd-route-' + i + '" data-code="' + esc(r.routeCode) + '" data-dir="' + esc(r.direction || '') + '">'
             +   '<span class="sd-route-badge" style="background:#' + hex + ';color:' + fg + '">' + esc(r.routeCode) + '</span>'
             +   '<div class="sd-route-info">'
             +     '<div class="sd-route-name">' + esc(head) + '</div>'
             +     '<div class="sd-route-status">'+t('loadingShort')+'</div>'
             +   '</div>'
             +   '<button class="sd-route-live" onclick="trackRoute(\'' + esc(r.routeCode) + '\')">'+t('liveBtn')+'</button>'
             + '</div>';
      }).join('')
    : '<div class="ss-empty">'+t('noRoutesThisStop')+'</div>';

  const distHtml = lastUserPos
    ? '<span class="sd-meta-item">' + (() => {
        const d = haversine(lastUserPos.lat, lastUserPos.lng, stop.lat, stop.lng);
        return d < 1000 ? t('distAwayM',{d:Math.round(d)}) : t('distAwayKm',{d:(d/1000).toFixed(1)});
      })() + '</span>'
    : '';

  wrap.innerHTML =
    '<button class="sd-back" onclick="closeStopDetail()">'+t('setBack')+'</button>'
  + '<div class="sd-title-row">'
  +   '<div class="sd-title-text">'
  +     '<div class="sd-title">' + esc(stop.stopName) + '</div>'
  +     '<div class="sd-meta">'
  +       '<span class="sd-meta-item">#' + esc(stop.stopId) + '</span>'
  +       '<span class="sd-meta-item">' + t('routesCount',{n:routeCount}) + '</span>'
  +       distHtml
  +     '</div>'
  +   '</div>'
  +   '<button class="ss-share" onclick="shareStop(\'' + stop.stopId + '\')" title="'+t('shareStopTitle')+'">🔗</button>'
  +   '<button class="ss-fav' + (fav ? ' on' : '') + '" '
  +          'onclick="toggleFavStop(\'' + stop.stopId + '\')" '
  +          'title="' + (fav ? t('favRemove') : t('favAdd')) + '">'
  +     (fav ? '★' : '☆')
  +   '</button>'
  + '</div>'
  + '<button class="sd-cta" onclick="showStopOnPlanner(\'' + stop.stopId + '\')">'+t('showOnMapCta')+'</button>'
  + '<div class="sd-routes-title">'+t('routesHere')+'</div>'
  + routesHtml;

  // Fetch live buses for this stop and update each row's status
  if (uniq.length) loadStopDetailBuses(stop.stopId, uniq);
}

async function loadStopDetailBuses(stopId, uniqRoutes) {
  try {
    const responses = await Promise.all(uniqRoutes.map(e =>
      fetch(API + 'web/pathInfo?' + QS + '&displayRouteCode=' + encodeURIComponent(e.routeCode) + '&direction=' + e.direction)
        .then(r => r.json()).catch(() => null)
    ));
    if (stopDetailId !== stopId) return;
    // Compute status + sort key per row, update DOM, then reorder.
    const meta = [];
    for (let i = 0; i < uniqRoutes.length; i++) {
      const fp = responses[i]?.pathList?.[0];
      const row = document.getElementById('sd-route-' + i);
      const statusEl = row?.querySelector('.sd-route-status');
      if (!statusEl) { meta.push({ row, sortKey: 99999 }); continue; }
      let status, klass = '', sortKey = 99999;
      if (!fp) {
        status = t('noData');
      } else {
        const seqOf = {};
        for (const s of (fp.busStopList || [])) seqOf[s.stopId] = parseInt(s.seq) || 0;
        const targetSeq = seqOf[stopId] ?? uniqRoutes[i].seq;
        const buses = fp.busList || [];
        const approaching = buses
          .filter(b => (seqOf[b.stopId] ?? -1) >= 0 && seqOf[b.stopId] < targetSeq)
          .map(b => ({ ...b, stopsAway: targetSeq - seqOf[b.stopId] }))
          .sort((a, b) => a.stopsAway - b.stopsAway);
        const atStop = buses.filter(b => b.stopId === stopId);
        if (atStop.length) {
          status = t('statusArrived',{n:atStop.length});
          klass  = 'live-at';
          sortKey = 0;
        } else if (approaching.length) {
          const n = approaching[0].stopsAway;
          status = t('statusApproaching',{n,a:approaching.length});
          klass  = n <= 2 ? 'live-near' : n <= 5 ? 'live-mid' : 'live-far';
          sortKey = n;
        } else if (buses.length) {
          status = t('statusActiveFwd',{n:buses.length});
          klass  = 'live-far';
          sortKey = 9000; // active, but past this stop — below all approaching
        } else {
          const nx = getNextDeparture(uniqRoutes[i].routeCode);
          status = nx === undefined ? t('noActiveBus')
                 : nx === null ? t('noRunsToday')
                 : t('nextShort',{time:nx});
          sortKey = 99999; // inactive — keep at bottom in original order
        }
      }
      statusEl.textContent = status;
      statusEl.className   = 'sd-route-status ' + klass;
      meta.push({ row, sortKey, originalIndex: i });
    }
    // Reorder: active routes by proximity ascending; inactive keep original index.
    meta.sort((a, b) => a.sortKey - b.sortKey || a.originalIndex - b.originalIndex);
    const parent = meta[0]?.row?.parentNode;
    if (parent) for (const { row } of meta) if (row) parent.appendChild(row);
  } catch {}
}

function showStopOnPlanner(stopId) {
  pushRecentStop(stopId);
  showScreen('planner');
  showSingleStopOnMap(stopId);
}

// Close bookmarks dropdown when clicking outside
document.addEventListener('click', e => {
  const dd = document.getElementById('bm-dropdown');
  if (!dd?.classList.contains('open')) return;
  if (!dd.contains(e.target) && !document.getElementById('bm-toggle-btn')?.contains(e.target)) {
    dd.classList.remove('open');
    document.getElementById('bm-toggle-btn')?.classList.remove('open');
  }
});

function saveLocationBookmark(which) {
  // If called from "+ Ekle" (which=null), auto-pick whichever point is set
  if (!which) {
    if (originClick) which = 'origin';
    else if (destClick) which = 'dest';
    else { setHint(t('pickLocFirst')); return; }
  }
  let lat, lng, defaultName;
  if (which === 'origin' && originClick) {
    ({ lat, lng } = originClick);
    defaultName = document.getElementById('originName').textContent || t('locWord');
  } else if (which === 'dest' && destClick) {
    ({ lat, lng } = destClick);
    defaultName = document.getElementById('destName').textContent || t('bmDest');
  } else {
    setHint(t('pickLocFirst'));
    return;
  }
  const name = window.prompt(t('locNamePrompt'), defaultName);
  if (!name) return;
  bookmarks.push({ name: name.trim(), lat, lng });
  saveBookmarks();
  renderBookmarksBar();
  // Flash the save button to confirm
  const btn = document.querySelector('#' + (which === 'origin' ? 'originCard' : 'destCard') + ' .bm-save-btn');
  if (btn) { btn.textContent = t('savedBtn'); setTimeout(() => { btn.textContent = t('saveBtn'); }, 1500); }
}

function deleteBookmark(idx) {
  bookmarks.splice(idx, 1);
  saveBookmarks();
  renderBookmarksBar();
}

function useBookmark(idx, which) {
  const bm = bookmarks[idx];
  if (!bm || !allStops.size) return;
  applyPoint(bm.lat, bm.lng, which);
}

const mkStopIcon = (color, size) => L.divIcon({
  className: '', iconSize: [size, size], iconAnchor: [size/2, size/2],
  html: '<div style="width:'+size+'px;height:'+size+'px;border-radius:50%;background:'+color+';border:1.5px solid rgba(255,255,255,.2);box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>'
});
const mkPinIcon = (color) => L.divIcon({
  className: '', iconSize: [28,38], iconAnchor: [14,38], popupAnchor: [0,-38],
  html: '<svg viewBox="0 0 28 38" width="28" height="38"><path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 24 14 24S28 24.5 28 14C28 6.27 21.73 0 14 0z" fill="'+color+'"/><circle cx="14" cy="14" r="6" fill="#fff" opacity=".9"/></svg>'
});
const mkBusIcon = (hex, brg, label) => {
  // 30px bus circle anchored at marker position; 14px heading arrow above,
  // rotated around the circle center so it orbits as bearing changes;
  // optional plate/label below, absolutely positioned (overflows the box
  // visually but doesn't affect the marker anchor).
  const arrow = brg == null ? '' :
    '<div style="position:absolute;inset:0;transform-origin:15px 29px;transform:rotate('+brg.toFixed(0)+'deg);pointer-events:none">'+
      '<div style="position:absolute;top:0;left:50%;margin-left:-7px;width:0;height:0;border:7px solid transparent;border-bottom-color:#'+hex+';filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))"></div>'+
    '</div>';
  const lbl = label ?
    '<div style="position:absolute;top:42px;left:50%;transform:translateX(-50%);white-space:nowrap;padding:1px 6px;border-radius:7px;background:#'+hex+';color:'+textOnHex(hex)+';border:1.5px solid rgba(255,255,255,.3);box-shadow:0 1px 4px rgba(0,0,0,.6);font:700 10px/1.2 system-ui;pointer-events:none">'+esc(label)+'</div>' : '';
  return L.divIcon({
    className: '',
    iconSize: [30,44], iconAnchor: [15,29], popupAnchor: [0,-30],
    html:
      '<div style="position:relative;width:30px;height:44px">'+arrow+
        '<div style="position:absolute;top:14px;left:0;width:30px;height:30px;border-radius:50%;background:#'+hex+';border:2px solid rgba(255,255,255,.3);box-shadow:0 1px 5px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font-size:14px">🚌</div>'+
        lbl+
      '</div>'
  });
};


// ── Driving route (Valhalla auto) — for the taxi estimate ────────────────────
// Uses the SHORTEST-DISTANCE auto route, not the default time-optimal one. A
// taxi meter bills distance driven, and cabs take the short route — whereas the
// time-optimal route can detour onto a longer ring road/highway (İskele→home was
// 13.4 km time-optimal vs 7.0 km shortest). Shortest matches the real fare.
async function fetchDrivingRoute(a, b) {
  if (!a || !b) return null;
  const d = await _valhallaPost('/route', {
    locations: [{ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng }],
    costing: 'auto', costing_options: { auto: { shortest: true } }, units: 'kilometers',
  });
  const trip = d && d.trip;
  if (!trip || trip.status !== 0 || !trip.legs?.length) return null;
  let coords = [];
  for (const leg of trip.legs) if (leg.shape) coords = coords.concat(_decodePolyline6(leg.shape));
  return { distance: trip.summary.length * 1000, duration: trip.summary.time, coords };
}

// ── Walking-route directions (Valhalla pedestrian routing) ─────────────────
// Fetches a real PEDESTRIAN walking route from the free FOSSGIS Valhalla
// instance. We deliberately do NOT use the OSRM public demo: its /foot/
// endpoint actually serves the driving profile, so it can't cross roads or use
// footpaths — it inflated short pedestrian moves (a 31 m road crossing, an
// 800 m campus cut-through) into hundreds of meters / kilometers, which wrongly
// dropped reachable stops and viable transfers. Valhalla's pedestrian costing
// gives honest walking distances (crosses roads, uses footpaths). Returns null
// on any failure so callers fall back to a straight line + haversine.
const _walkRouteCache = new Map();



// ── Persistent walk caches (localStorage) ───────────────────────────────────
// Both Valhalla walk results are coordinate-keyed and effectively immutable, so
// we memoise them across reloads — cutting matrix size and request volume (and
// thus rate-limit pressure) for repeat planning. Keys round to 5 decimals (~1 m);
// a stop that moves in updated data just yields a new key, so no stale hazard.
const WALK_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const WALK_ROUTE_CACHE_MAX = 400;        // max persisted walk-route polylines
const WALK_DIST_CACHE_MAX = 4000;        // max persisted point→stop distances
const _r5 = n => n.toFixed(5);
function _evictOldest(store, max) {       // drop oldest-by-ts keys to stay ≤ max
  const keys = Object.keys(store);
  if (keys.length <= max) return;
  keys.sort((a, b) => (store[a].ts || 0) - (store[b].ts || 0));
  for (let i = 0; i < keys.length - max; i++) delete store[keys[i]];
}

// Walk-route polylines: hydrate _walkRouteCache with resolved values (callers
// await either a Promise or a plain object alike), and write through on success.
function _hydrateWalkRoutes() {
  try {
    const store = JSON.parse(localStorage.getItem('bm_walkroute_v1') || '{}');
    const now = Date.now();
    for (const k in store) {
      const e = store[k];
      if (e && now - e.ts < WALK_CACHE_MAX_AGE_MS)
        _walkRouteCache.set(k, { coords: e.coords, distance: e.distance, duration: e.duration });
    }
  } catch {}
}
function _persistWalkRoute(k, res) {
  try {
    const store = JSON.parse(localStorage.getItem('bm_walkroute_v1') || '{}');
    store[k] = { coords: res.coords, distance: res.distance, duration: res.duration, ts: Date.now() };
    _evictOldest(store, WALK_ROUTE_CACHE_MAX);
    localStorage.setItem('bm_walkroute_v1', JSON.stringify(store));
  } catch {}
}

// Walk-distance pairs: in-memory Map mirrored to localStorage (debounced). The
// key encodes the matrix's source→target orientation, so a hit equals exactly
// what the matrix would have returned.
const _walkDistCache = new Map();        // key → { m, ts }
const _walkDistKey = (a, b) => _r5(a.lat) + ',' + _r5(a.lng) + '>' + _r5(b.lat) + ',' + _r5(b.lng);
let _walkDistDirty = false, _walkDistFlushTimer = null;
function _hydrateWalkDists() {
  try {
    const store = JSON.parse(localStorage.getItem('bm_walkdist_v1') || '{}');
    const now = Date.now();
    for (const k in store) {
      const e = store[k];
      if (e && now - e.ts < WALK_CACHE_MAX_AGE_MS) _walkDistCache.set(k, e);
    }
  } catch {}
}
function _walkDistGet([a, b]) {
  const e = _walkDistCache.get(_walkDistKey(a, b));
  return (e && Date.now() - e.ts < WALK_CACHE_MAX_AGE_MS) ? e.m : null;
}
function _walkDistSet([a, b], m) {
  _walkDistCache.set(_walkDistKey(a, b), { m, ts: Date.now() });
  _walkDistDirty = true;
  if (_walkDistFlushTimer) return;       // coalesce a planner batch into one write
  _walkDistFlushTimer = setTimeout(() => {
    _walkDistFlushTimer = null;
    if (!_walkDistDirty) return;
    _walkDistDirty = false;
    try {
      let entries = [..._walkDistCache.entries()];
      if (entries.length > WALK_DIST_CACHE_MAX) {   // keep newest, drop the rest
        entries.sort((x, y) => y[1].ts - x[1].ts);
        entries = entries.slice(0, WALK_DIST_CACHE_MAX);
        _walkDistCache.clear();
        for (const [k, v] of entries) _walkDistCache.set(k, v);
      }
      const store = {};
      for (const [k, v] of entries) store[k] = v;
      localStorage.setItem('bm_walkdist_v1', JSON.stringify(store));
    } catch {}
  }, 1500);
}
_hydrateWalkRoutes();
_hydrateWalkDists();

// Decode a Valhalla-encoded polyline (Google polyline algorithm, precision 6).
function _decodePolyline6(str) {
  let i = 0, lat = 0, lng = 0; const coords = [];
  while (i < str.length) {
    let result = 0, shift = 0, b;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 0; shift = 0;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / 1e6, lng / 1e6]);
  }
  return coords;
}
async function fetchWalkingRoute(a, b) {
  if (!a || !b) return null;
  const k = a.lat.toFixed(5)+','+a.lng.toFixed(5)+'>'+b.lat.toFixed(5)+','+b.lng.toFixed(5);
  if (_walkRouteCache.has(k)) return _walkRouteCache.get(k);
  const p = (async () => {
    const d = await _valhallaPost('/route', {
      locations: [{ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng }],
      costing: 'pedestrian', units: 'kilometers',
    });
    const trip = d && d.trip;
    if (!trip || trip.status !== 0 || !trip.legs?.length) return null;
    let coords = [];
    for (const leg of trip.legs) if (leg.shape) coords = coords.concat(_decodePolyline6(leg.shape));
    const res = {
      coords,
      distance: trip.summary.length * 1000,  // km → meters, real pedestrian distance
      duration: trip.summary.time,            // seconds (realistic walking time)
    };
    _persistWalkRoute(k, res);                // write-through to localStorage
    return res;
  })();
  _walkRouteCache.set(k, p);
  return p;
}

// Midpoint of a polyline path, weighted by segment length so labels sit on
// the middle of the road rather than at the array's median index.
function _polylineMidpoint(coords) {
  if (!coords?.length) return null;
  if (coords.length === 1) return coords[0];
  let total = 0;
  const seg = [];
  for (let i = 1; i < coords.length; i++) {
    const d = haversine(coords[i-1][0], coords[i-1][1], coords[i][0], coords[i][1]);
    seg.push(d); total += d;
  }
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    if (acc + seg[i] >= total / 2) {
      const t = seg[i] ? (total/2 - acc) / seg[i] : 0;
      return [
        coords[i][0] + (coords[i+1][0] - coords[i][0]) * t,
        coords[i][1] + (coords[i+1][1] - coords[i][1]) * t,
      ];
    }
    acc += seg[i];
  }
  return coords[coords.length - 1];
}

function _walkLabelMarker(latlng, durationSec, distanceM) {
  const mins = Math.max(1, Math.round(durationSec / 60));
  const text = mins + ' dk · ' + fmtDist(Math.round(distanceM));
  return L.marker(latlng, {
    icon: L.divIcon({
      className: '',
      html: '<span class="walk-label">' + esc(text) + '</span>',
      iconSize: null,
    }),
    interactive: false,
    keyboard: false,
    zIndexOffset: 800,
  });
}

function bearing(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const φ1 = lat1 * r, φ2 = lat2 * r, Δλ = (lng2 - lng1) * r;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function nextStopFor(bus, stops) {
  if (!stops || !stops.length) return null;
  let cur = stops.find(s => s.stopId === bus.stopId);
  if (!cur) {
    // Bus stopId not in path (rare) — fall back to nearest stop by haversine
    let nd = Infinity;
    for (const s of stops) {
      const d = haversine(parseFloat(bus.lat), parseFloat(bus.lng), parseFloat(s.lat), parseFloat(s.lng));
      if (d < nd) { nd = d; cur = s; }
    }
    if (!cur) return null;
  }
  const seq = parseInt(cur.seq) || 0;
  return stops.find(s => (parseInt(s.seq) || 0) === seq + 1) || null;
}

function nearestStop(lat,lng){let b=null,bd=Infinity;for(const s of allStops.values()){const d=haversine(lat,lng,s.lat,s.lng);if(d<bd){bd=d;b=s;}}return{stop:b,meters:Math.round(bd)};}
function fmtDist(m){return m<1000?m+'m':(m/1000).toFixed(1)+'km';}
function textOnHex(h){const r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16);return(r*299+g*587+b*114)/1000>145?'#000':'#fff';}
function setHint(msg,warn){const el=document.getElementById('hint');el.textContent=msg;el.className=warn?'warn':'';el.style.display=msg?'':'none';}

function getNextDeparture(code) {
  if (!getSchedule()) return undefined;
  const dayData = getActiveRoutes();
  const entry  = findSchedEntry(dayData, code);
  if (!entry) return null;
  const toM  = t => { const [h, mn] = t.split(':').map(Number); return (h < 4 ? h*60+1440 : h*60) + mn; };
  const all  = [...(entry.dir0?.times || []), ...(entry.dir1?.times || [])].sort((a, b) => toM(a) - toM(b));
  if (!all.length) return null;
  const now  = _schedNow();   // service-day frame, matches toM
  const next = all.find(t => toM(t) >= now);
  return next || (all[0] ? all[0] + t('tomorrowParen') : null);
}

async function initPlanner() {
  document.getElementById('loadBar').style.width = '5%';
  const sharedRenderer = L.canvas({ padding: 0.5, tolerance: 10 });
  window._map = L.map('map',{
    zoomControl:true, renderer:sharedRenderer, tap:false,
    maxBounds: L.latLngBounds(MAP_BOUNDS), maxBoundsViscosity: 1.0,
    minZoom: MAP_MIN_ZOOM, maxZoom: MAP_MAX_ZOOM,
  }).setView([40.152,26.41],13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    attribution:'© OpenStreetMap', minZoom: MAP_MIN_ZOOM,
    maxZoom: MAP_MAX_ZOOM, maxNativeZoom: MAP_NATIVE_MAX_ZOOM,
  }).addTo(window._map);
  window._map.on('click',e=>{
    if(!allStops.size)return;
    if(guidedLocksPicks())return;   // during a guided trip (and just after End) taps must NOT re-pick origin/dest
    if(mode==='stops')showNearbyStops(e.latlng.lat,e.latlng.lng);
    else applyPoint(e.latlng.lat,e.latlng.lng,mode);
  });
  // Stop the GPS FAB's clicks from bubbling to the map container, which would
  // otherwise also trigger the map's click handler and drop a pin under the
  // button when GPS fails (or before GPS resolves).
  {
    const el = document.getElementById('gps-fab');
    if (el) { L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); }
    // The guided banner + recenter FAB live INSIDE #map, so their clicks would
    // otherwise bubble to the map's click handler. Critical for the End button:
    // endGuidedTrip() flips guided.active=false, then the same click would reach
    // the map handler (guard now lifted) and re-pick the destination under the
    // button. Stop propagation so banner/FAB taps never touch the map.
    for (const id of ['guided-banner', 'guided-recenter']) {
      const g = document.getElementById(id);
      if (g) { L.DomEvent.disableClickPropagation(g); L.DomEvent.disableScrollPropagation(g); }
    }
  }
  // Live "blue dot" is always on — start watching the user's position as soon
  // as the map exists. No toggle; it quietly tracks them as they walk to a stop.
  startLiveLocation();

  // ── Load stops.json (pre-built by GitHub Actions) ────────────────────────────
  try {
    const r = await fetch('./data/stops.json');
    if (!r.ok) throw new Error('stops.json not found');
    const d  = await r.json();
    allRoutes    = d.routes;
    setPathCache(d.paths);
    allStops     = new Map(d.stops);
    stopToRoutes = new Map(d.stopToRoutes);
    // Rebuild kentkartRouteMap from the routes list (for schedule tab colors)
    kentkartRouteMap = new Map();
    for (const route of allRoutes) {
      const code    = route.displayRouteCode.toUpperCase();
      const stripped = code.replace(/^Ç(?=\d)/, '');
      kentkartRouteMap.set(code, route);
      if (stripped !== code) kentkartRouteMap.set(stripped, route);
    }
    try { localStorage.setItem('kentkart_routes', JSON.stringify([...kentkartRouteMap])); } catch {}
  } catch (e) {
    setHint(t('stopDataFailed',{err:e.message}), true);
    return;
  }

  // ── Add markers and enable UI ────────────────────────────────────────────────
  // Canvas renderer: stops share the map's sharedRenderer so there's only ONE
  // canvas in the overlayPane — otherwise a second canvas (auto-created by the
  // first un-rendered polyline) would stack on top and steal all pointer events.
  networkStopLayer = L.layerGroup();
  const _stopCircles = [];
  const _stopRadius = z => Math.max(5, z - 9); // grows with zoom: z13=5, z14=6, z16=8...
  for(const s of allStops.values()) {
    const c = L.circleMarker([s.lat,s.lng],{radius:_stopRadius(13),color:'#4a7dc0',fillColor:'#4a7dc0',fillOpacity:.8,weight:1,bubblingMouseEvents:false})
      .bindTooltip(s.stopName,{direction:'top',offset:[0,-4]})
      // In Konum/Hedef pick modes, treat a stop tap as picking that stop's
      // exact location instead of opening the stops-browser panel.
      .on('click', () => {
        if (guided && guided.active) return;   // ignore stop taps during a guided trip
        if (mode === 'origin' || mode === 'dest') applyPoint(s.lat, s.lng, mode);
        else openStopOnMap(s.stopId);
      });
    c.addTo(networkStopLayer);
    _stopCircles.push(c);
  }
  window._updateStopVis = () => {
    // Never show the whole-network stop layer during a guided trip — its per-step
    // camera zoom would otherwise splatter all ~350 city stops onto the map.
    if (guided && guided.active) { networkStopLayer.remove(); return; }
    if(!networkStopLayer._active) return;
    const z = window._map.getZoom();
    if(z >= 13) {
      networkStopLayer.addTo(window._map);
      const r = _stopRadius(z);
      _stopCircles.forEach(c => c.setRadius(r));
    } else {
      networkStopLayer.remove();
    }
  };
  networkStopLayer._active = true;
  window._map.on('zoomend', window._updateStopVis);
  window._updateStopVis();

  document.getElementById('loadBar').style.width='100%';
  document.getElementById('loadStatus').textContent = t('stopsLoaded',{n:allStops.size});
  ['btnOrigin','btnDest','btnPlanTime'].forEach(id=>document.getElementById(id).disabled=false);
  setMode('origin');
  renderBookmarksBar();
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(pos => {
      applyPoint(pos.coords.latitude, pos.coords.longitude, 'origin');
    }, () => {}, { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 });
  }
  applyDeepLink();
}





function estimateWaitMins(routeCode, boardSeq, path) {
  const effectiveNow = _schedFrame(new Date().getHours()*60 + new Date().getMinutes() + planOffset);   // service-day frame
  return estimateWaitFromMins(routeCode, boardSeq, path, effectiveNow);
}

function resetPlanner() {
  // If user is in stops-browser mode, X just exits stops without clearing the plan
  if (mode === 'stops') {
    if (stopRefreshTimer) { clearInterval(stopRefreshTimer); stopRefreshTimer = null; }
    openStopId = null;
    clearSingleStopMarker();
    document.getElementById('stopPanel').innerHTML = '';
    setMode(originStop && !destStop ? 'dest' : 'origin');
    return;
  }
  clearSingleStopMarker();
  // Clear markers
  if (originMarker) { window._map.removeLayer(originMarker); originMarker = null; }
  if (destMarker)   { window._map.removeLayer(destMarker);   destMarker   = null; }
  if (originPin)    { window._map.removeLayer(originPin);    originPin    = null; }
  if (destPin)      { window._map.removeLayer(destPin);      destPin      = null; }
  // Clear state
  originClick = destClick = originStop = destStop = null;
  selectedMatch = null; currentMatches = []; tripMatch = null; currentTaxi = null;
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  closeTrackPanel();
  stopBusNotify();
  // Clear map
  clearDrawn(); clearBuses(); showNetworkStops();
  // Reset UI
  document.getElementById('results').innerHTML = '';
  document.getElementById('results').style.display = '';
  document.getElementById('stopPanel').style.display = 'none';
  hidePanelHandle();
  document.getElementById('btnReset').disabled = true;
  document.getElementById('btnReset').style.color = '#4a5568';
  document.getElementById('swap-row').style.display = 'none';
  setMode('origin');
  setHint(t('hintClickStart'));
}

function setPlanOffset(mins) {
  planOffset = mins;
  document.querySelectorAll('.plan-time-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.offset) === mins)
  );
  // Hide custom time picker when a preset is chosen
  document.getElementById('custom-time-row').style.display = 'none';
  // Update clock button label
  const clockBtn = document.getElementById('btnPlanTime');
  const offsetLabel = mins > 0 ? '+' + (mins < 60 ? mins + 'dk' : (mins/60) + 'sa') : 'Planla';
  if (clockBtn) clockBtn.innerHTML = '⏰ <span style="font-size:.6rem;font-weight:600;opacity:.8">' + offsetLabel + '</span>';
  const label = mins === 0 ? '' : (mins < 60 ? mins + ' dk sonra' : (mins/60) + ' sa sonra');
  setHint(label ? t('planningFor',{label}) : (originStop && destStop ? t('hintRouteRefresh') : t('hintClickStart')));
  if (originStop && destStop) findRoutes();
}

// ── Panel expand / collapse (mobile) ─────────────────────────────────────────
let panelExpanded = false;

function expandPanel(count) {
  panelExpanded = true;
  document.querySelector('.p-top').classList.add('panel-full');
  document.getElementById('map').classList.add('panel-full');
  const handle = document.getElementById('panel-handle');
  handle.classList.add('visible');
  document.getElementById('ph-label').textContent = count ? count + ' hat bulundu' : '';
  document.getElementById('ph-btn').textContent = t('phMap');
}

function collapsePanel() {
  panelExpanded = false;
  document.querySelector('.p-top').classList.remove('panel-full');
  document.getElementById('map').classList.remove('panel-full');
  document.getElementById('ph-btn').textContent = t('phLines');
  if (window._map) setTimeout(() => window._map.invalidateSize(), 260);
}

function hidePanelHandle() {
  collapsePanel();
  document.getElementById('panel-handle').classList.remove('visible');
}

function togglePanelExpand() {
  if (panelExpanded) collapsePanel();
  else expandPanel();
}

// ── Onboarding ───────────────────────────────────────────────────────────────
function showOnboarding() {
  if (localStorage.getItem('onboarded_v2')) return;
  document.getElementById('onboarding').style.display = 'flex';
}

function dismissOnboarding(goTo) {
  localStorage.setItem('onboarded_v2', '1');
  document.getElementById('onboarding').style.display = 'none';
  showScreen(goTo);
}

// ── Planner guide card ────────────────────────────────────────────────────────
function showPlannerGuide(step) {
  const results = document.getElementById('results');
  const ripple  = document.getElementById('map-ripple');
  if (!results) return;

  if (step === 'origin') {
    results.innerHTML =
      '<div id="planner-guide">' +
        '<div class="guide-headline">'+t('guideStartHeadline')+'</div>' +
        '<button class="guide-gps" onclick="useGPS()">'+t('guideGps')+'</button>' +
        '<span class="guide-or">'+t('guideOr')+'</span>' +
      '</div>';
    if (ripple) ripple.classList.add('active');
  } else if (step === 'dest') {
    results.innerHTML =
      '<div id="planner-guide">' +
        '<div class="guide-headline">'+t('guideDestHeadline')+'</div>' +
        '<div class="guide-sub">'+t('guideDestSub')+'</div>' +
      '</div>';
    if (ripple) ripple.classList.add('active');
  } else {
    if (ripple) ripple.classList.remove('active');
  }
}

function hidePlannerGuide() {
  showPlannerGuide(null);
}

function togglePlanTime() {
  const row = document.getElementById('plan-time-row');
  const open = row.style.display === 'none';
  row.style.display = open ? '' : 'none';
  if (!open) document.getElementById('custom-time-row').style.display = 'none';
  document.getElementById('btnPlanTime').classList.toggle('active', open);
}

function openCustomTime() {
  const cr = document.getElementById('custom-time-row');
  cr.style.display = '';
  const inp = document.getElementById('custom-time-input');
  // Pre-fill with current time
  if (!inp.value) {
    const now = new Date();
    inp.value = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
  }
  inp.focus();
  inp.showPicker?.();
}

function applyCustomTime() {
  const val = document.getElementById('custom-time-input').value;
  if (!val) return;
  const [h, m] = val.split(':').map(Number);
  const targetMins = h * 60 + m;
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
  let offset = targetMins - nowMins;
  if (offset < 0) offset += 1440; // next day
  planOffset = offset;
  // Mark Özel button active, deactivate presets
  document.querySelectorAll('.plan-time-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('btn-custom-time').classList.add('active');
  // Update clock button label
  const clockBtn = document.getElementById('btnPlanTime');
  if (clockBtn) clockBtn.innerHTML = '⏰ <span style="font-size:.6rem;font-weight:600;opacity:.8">' + val + '</span>';
  const hint = offset === 0 ? '' : t('planningFor',{label:val});
  setHint(hint || (originStop && destStop ? t('hintRouteRefresh') : t('hintClickStart')));
  if (originStop && destStop) findRoutes();
}

function setMode(m){
  mode=m;
  ['Origin','Dest'].forEach(n=>document.getElementById('btn'+n).classList.toggle('active',m===n.toLowerCase()));
  const isStop=m==='stops';
  document.getElementById('results').style.display=isStop?'none':'';
  document.getElementById('stopPanel').style.display=isStop?'':'none';
  document.getElementById('originCard').style.display='none';
  document.getElementById('destCard').style.display='none';
  // X (reset) enabled whenever there's something to clear or exit: a plan in progress, stops browser, or live tracker
  const rb = document.getElementById('btnReset');
  const hasPlan = !!(originStop || destStop);
  const tracking = !!trackTimer;
  rb.disabled = !(hasPlan || isStop || tracking);
  rb.style.color = rb.disabled ? '#4a5568' : '#ef4444';
  renderRecentDests();
  // GPS FAB: only show when picking origin
  document.getElementById('gps-fab')?.classList.toggle('visible', m==='origin');
  if(m==='origin'){
    setHint('');
    if(!currentMatches.length && !tripMatch) showPlannerGuide('origin');
  } else if(m==='dest'){
    setHint('');
    if(!currentMatches.length && !tripMatch) showPlannerGuide('dest');
  } else {
    setHint(t('hintNearbyStops'));
    hidePlannerGuide();
    document.getElementById('stopPanel').innerHTML='';
  }
}

function useGPS(){
  if(!navigator.geolocation){alert(t('geoUnsupported'));return;}
  setHint(t('gettingGPS'));
  const onPos = pos => {
    const{latitude:lat,longitude:lng}=pos.coords;
    window._map.setView([lat,lng],16);
    if(mode==='stops')showNearbyStops(lat,lng);
    else{applyPoint(lat,lng,'origin');setMode('dest');}
  };
  // Accept a recent (≤2 min) cached fix instantly, and use coarse (network)
  // location rather than waiting on a fresh high-accuracy GPS lock — a trip
  // start point only needs to be within a block or two, and forcing a fresh
  // hardware fix is what made this take ~10s on phones.
  navigator.geolocation.getCurrentPosition(
    onPos,
    () => setHint(t('gpsFailed'), true),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 }
  );
}

// ── Live location ("blue dot") ──────────────────────────────────────────────
// A continuously-updating marker so you can watch yourself walk to a stop. Uses
// watchPosition with high accuracy. When the GPS reports a heading (course over
// ground, available while moving) the marker shows a direction arrow rotated to
// it; standing still, heading is null so it falls back to a plain dot.
let _liveWatchId = null, _liveMarker = null, _liveCircle = null;

function _liveIcon(heading) {
  const hasDir = heading != null && !isNaN(heading);
  const rot = hasDir ? 'transform:rotate(' + heading + 'deg)' : '';
  const beam = hasDir ? '<div class="live-beam"></div>' : '';
  return L.divIcon({ className: '', html: '<div class="live-wrap" style="' + rot + '">' + beam + '<div class="live-dot"></div></div>', iconSize: [22,22], iconAnchor: [11,11] });
}

// Always-on live location. Starts at map init and quietly tracks the user as a
// blue dot (with a heading arrow when moving). It does NOT recenter the map —
// that would hijack the view on every load; the GPS button is for centering.
function startLiveLocation() {
  if (_liveWatchId != null || !navigator.geolocation) return;
  _liveWatchId = navigator.geolocation.watchPosition(
    pos => {
      const { latitude: lat, longitude: lng, accuracy, heading } = pos.coords;
      lastUserPos = { lat, lng };   // keep session position fresh (used by stops + guided nav)
      if (!_liveMarker) {
        _liveMarker = L.marker([lat, lng], { icon: _liveIcon(heading), zIndexOffset: 1600, interactive: false, keyboard: false }).addTo(window._map);
        _liveCircle = L.circle([lat, lng], { radius: accuracy || 30, color: '#4285f4', weight: 1, opacity: .5, fillColor: '#4285f4', fillOpacity: .12, interactive: false }).addTo(window._map);
      } else {
        _liveMarker.setLatLng([lat, lng]).setIcon(_liveIcon(heading));
        _liveCircle.setLatLng([lat, lng]).setRadius(accuracy || 30);
      }
      if (guided.active) onGuidedPosition(lat, lng);
    },
    () => {},  // ignore errors silently; the dot just won't appear
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

function applyPoint(lat,lng,which){
  // Never re-pick origin/dest while a guided trip is running (or in the brief
  // window right after End) — a stray tap, GPS, bookmark, or the End-button
  // click bubbling to the map would otherwise move the destination.
  if (guidedLocksPicks()) return;
  // Reject points outside the Çanakkale map bounds (typically GPS picks from
  // outside the city, or stale bookmarks). Map clicks are already constrained
  // by maxBounds so they never trigger this.
  const [[sLat, wLng], [nLat, eLng]] = MAP_BOUNDS;
  if (lat < sLat || lat > nLat || lng < wLng || lng > eLng) {
    setHint(t('outOfBounds'), true);
    return;
  }
  const{stop,meters}=nearestStop(lat,lng);if(!stop)return;
  if(which==='origin'){
    originClick={lat,lng};originStop={...stop,meters};
    if(originMarker)window._map.removeLayer(originMarker);if(originPin)window._map.removeLayer(originPin);
    originMarker=L.marker([lat,lng],{icon:mkPinIcon('#2563eb'),zIndexOffset:1100}).bindTooltip(t('tipYou')).addTo(window._map);
    document.getElementById('originName').textContent=stop.stopName;
    document.getElementById('originDist').textContent=fmtDist(meters)+' '+t('nearest');
    const rb=document.getElementById('btnReset');rb.disabled=false;rb.style.color='#ef4444';rb.style.borderColor='#7f1d1d';
    setMode('dest');
  }else{
    destClick={lat,lng};destStop={...stop,meters};
    if(destMarker)window._map.removeLayer(destMarker);if(destPin)window._map.removeLayer(destPin);
    destMarker=L.marker([lat,lng],{icon:mkPinIcon('#16a34a'),zIndexOffset:1100}).bindTooltip(t('tipDest')).addTo(window._map);
    document.getElementById('destName').textContent=stop.stopName;
    document.getElementById('destDist').textContent=fmtDist(meters)+' '+t('nearest');
    pushRecentDest(stop);
  }
  document.getElementById('swap-row').style.display = (originStop && destStop) ? '' : 'none';
  renderRecentDests();
  if(originStop&&destStop)findRoutes();
}

function swapOD() {
  if (!originClick || !destClick) return;
  // Swap state
  [originClick, destClick] = [destClick, originClick];
  [originStop,  destStop]  = [destStop,  originStop];
  // Remove old markers
  if (originMarker) { window._map.removeLayer(originMarker); originMarker = null; }
  if (destMarker)   { window._map.removeLayer(destMarker);   destMarker   = null; }
  // Re-create with swapped roles
  originMarker = L.marker([originClick.lat, originClick.lng], { icon: mkPinIcon('#2563eb'), zIndexOffset: 1100 }).bindTooltip(t('tipYou')).addTo(window._map);
  destMarker   = L.marker([destClick.lat,   destClick.lng],   { icon: mkPinIcon('#16a34a'), zIndexOffset: 1100 }).bindTooltip(t('tipDest')).addTo(window._map);
  // Update card labels
  document.getElementById('originName').textContent = originStop.stopName;
  document.getElementById('originDist').textContent = fmtDist(originStop.meters) + ' ' + t('nearest');
  document.getElementById('destName').textContent   = destStop.stopName;
  document.getElementById('destDist').textContent   = fmtDist(destStop.meters) + ' ' + t('nearest');
  findRoutes();
}

let _findGen = 0;
// Paint a spinner into the results panel, then yield two animation frames so
// the browser actually renders it before we run the synchronous route search.
// Without the yield, the heavy JS would block the paint and the spinner would
// never be seen.
function _showPlannerSpinner(msg) {
  document.getElementById('results').innerHTML =
    '<div style="display:flex;align-items:center;gap:10px;color:#9ca3af;padding:14px 6px;font-size:.85rem">'
    + '<span class="loading-spin" style="width:14px;height:14px"></span>'
    + esc(msg)
    + '</div>';
}
const _nextPaint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

async function findRoutes(){
  const gen = ++_findGen;
  clearDrawn();clearBuses();showNetworkStops();
  _showPlannerSpinner(t('calcRoutes'));
  setHint(t('calcRoutes'));
  await _nextPaint();
  if (gen !== _findGen) return;

  // Bus trips + a taxi estimate (driving route) in parallel.
  // planTrips is headless now (core.js): "now", the walk cache, live-bus fetching
  // and cancellation are all passed in, and it no longer paints anything.
  const [trips, drive] = await Promise.all([
    planTrips({ lat: originClick.lat, lng: originClick.lng }, { lat: destClick.lat, lng: destClick.lng }, {
      pathCache: getPathCache(),
      dayData: getActiveRoutes(),
      settings: SETTINGS,
      nowMins: _schedFrame(new Date().getHours()*60 + new Date().getMinutes() + planOffset),
      live: !planOffset,                      // planning ahead → schedule only, no live buses
      walkCache: { get: _walkDistGet, set: _walkDistSet },
      isCancelled: () => gen !== _findGen,    // same generation semantics as before
    }),
    fetchDrivingRoute({ lat: originClick.lat, lng: originClick.lng }, { lat: destClick.lat, lng: destClick.lng }),
  ]);
  if (gen !== _findGen) return;
  currentTaxi = drive ? { ..._taxiEstimate(drive.distance, drive.duration), coords: drive.coords || [] } : null;

  // `null` = cancelled (nothing to do — a newer plan is already running).
  // `{list: []}` = genuinely no connection → render the empty state planTrips
  // used to paint itself.
  if (!trips) { _appendTaxiCard(); return; }
  if (!trips.list.length) {
    currentMatches = []; tripMatch = null; selectedMatch = null;
    clearDrawn(); clearBuses();
    setHint(t('noConnection'), true);
    document.getElementById('results').innerHTML =
      '<p style="color:#4a5568;font-size:.8rem;padding:6px 0">'+t('noConnectionLong')+'</p>';
    hidePanelHandle();
    _appendTaxiCard(); return;
  }

  currentMatches = trips.list; tripMatch = null;
  hidePlannerGuide();
  const hasMulti = trips.list.some(m => m.isMultiLeg);
  const base = hasMulti ? t('foundNMulti',{n:trips.list.length}) : t('foundN',{n:trips.list.length});
  setHint(trips.relaxed ? base + ' ' + t('walksTooLong') : base, trips.relaxed);
  renderPlannerResults(trips.list); selectPlannerMatch(trips.list[0]);
  expandPanel(trips.list.length);
  if (refreshTimer) clearInterval(refreshTimer); refreshTimer = setInterval(refreshBuses, 30000);
}













function renderPlannerResults(matches){
  const cont=document.getElementById('results');
  const isMulti = matches.length && matches[0].isMultiLeg;
  cont.innerHTML='<div class="result-header">' + (isMulti ? t('resultsTransfer') : t('resultsDirect')) + '</div>';
  for(const m of matches){
    const c=document.createElement('div');c.className='p-route-card';
    if (m.isMultiLeg) {
      const h1=(m.leg1.route.routeColor||'aaaaaa').replace('#','').padStart(6,'0');
      const h2=(m.leg2.route.routeColor||'aaaaaa').replace('#','').padStart(6,'0');
      const totalRide = m.leg1.ride + m.leg1.wait + m.leg2.ride + m.leg2.wait;
      const longWalkChip = m._longWalk ? '<span class="p-longwalk-badge" title="'+t('longWalkTitle')+'">'+t('longWalk')+'</span>' : '';
      const liveChip = m.leg1._live ? '<span class="p-live-badge" title="'+t('liveTitle')+'">'+t('live')+'</span>' : '';
      const lastBusChip = m._lastBus ? '<span class="p-lastbus-badge" title="'+t('lastBusTitle')+'">'+t('lastBus')+'</span>' : '';
      c.innerHTML =
        '<div class="p-route-top">'
        + '<span class="p-multileg-badge">'+t('oneTransfer')+'</span>'
        + longWalkChip + lastBusChip
        + '<span class="p-route-badge" style="background:#'+h1+';color:'+textOnHex(h1)+'">'+esc(m.leg1.path.displayRouteCode)+'</span>'
        + '<span class="p-leg-arrow">→</span>'
        + '<span class="p-route-badge" style="background:#'+h2+';color:'+textOnHex(h2)+'">'+esc(m.leg2.path.displayRouteCode)+'</span>'
        + liveChip
        + '<span class="p-route-eta">~'+m._eta+' '+t('min')+'</span>'
        + '</div>'
        + '<div class="p-route-meta">'+t('metaMulti',{a:m.leg1.sc,b:m.leg2.sc,ride:totalRide})+'</div>'
        + '<div style="font-size:.7rem;color:#4a90d9;margin-top:2px">🟦 <b>'+esc(m.leg1.board.stopName)+'</b> <span style="color:#4a5568">('+fmtDist(m.leg1.walkB)+')</span></div>'
        + '<div style="font-size:.7rem;color:#f59e0b">🔁 <b>'+esc(m.leg1.alight.stopName)+'</b>'
        + (m.leg2.transferWalkM > 0 ? ' <span style="color:#4a5568">'+t('transferWalkParen',{dist:fmtDist(m.leg2.transferWalkM)})+'</span>' : ' <span style="color:#4a5568">'+t('sameStopParen')+'</span>')
        + '</div>'
        + '<div style="font-size:.7rem;color:#22c55e">🟩 <b>'+esc(m.leg2.alight.stopName)+'</b> <span style="color:#4a5568">('+fmtDist(m.leg2.walkA)+')</span></div>';
    } else {
      const hex=(m.route.routeColor||'aaaaaa').replace('#','').padStart(6,'0');
      const bh=m.buses.length?m.buses.map(b=>'<span class="bus-chip">🚌 '+(b.plateNumber||t('activeShort'))+'</span>').join(''):'<span class="bus-chip muted">'+t('noActiveBus')+'</span>';
      const longWalkChip = m._longWalk ? '<span class="p-longwalk-badge" title="'+t('longWalkTitle')+'">'+t('longWalk')+'</span>' : '';
      const liveChip = m._live ? '<span class="p-live-badge" title="'+t('liveTitle')+'">'+t('live')+'</span>' : '';
      const lastBusChip = m._lastBus ? '<span class="p-lastbus-badge" title="'+t('lastBusTitle')+'">'+t('lastBus')+'</span>' : '';
      c.innerHTML='<div class="p-route-top"><span class="p-route-badge" style="background:#'+hex+';color:'+textOnHex(hex)+'">'+m.path.displayRouteCode+'</span><span class="p-route-name">'+esc(m.route.name||m.path.headSign)+'</span>'+longWalkChip+lastBusChip+liveChip+'<span class="p-route-eta">~'+m._eta+' '+t('min')+'</span></div>'
        +'<div class="p-route-meta">'+t('metaDirect',{n:m.sc})+'</div>'
        +'<div style="font-size:.7rem;color:#4a90d9;margin-top:2px">🟦 <b>'+esc(m.board.stopName)+'</b> <span style="color:#4a5568">('+fmtDist(m.walkB)+')</span></div>'
        +'<div style="font-size:.7rem;color:#22c55e">🟩 <b>'+esc(m.alight.stopName)+'</b> <span style="color:#4a5568">('+fmtDist(m.walkA)+')</span></div>'
        +'<div style="margin-top:4px">'+bh+'</div>';
    }
    c.onclick=()=>showTripDetail(m);cont.appendChild(c);
  }
  _appendTaxiCard();
}

// Appends a taxi estimate card to the bottom of the results panel (driving time
// + approximate fare). Skipped if the driving route couldn't be fetched.
function _appendTaxiCard() {
  if (!currentTaxi) return;
  const cont = document.getElementById('results');
  if (!cont || cont.querySelector('.p-taxi-card')) return;
  const tx = currentTaxi;
  const c = document.createElement('div');
  c.className = 'p-taxi-card';
  if (tx.coords && tx.coords.length) c.style.cursor = 'pointer';
  c.innerHTML =
    '<div class="p-taxi-left"><span class="p-taxi-ico">🚕</span><div>'
    + '<div class="p-taxi-title">'+t('taxiTitle')+'</div>'
    + '<div class="p-taxi-sub">'+t('taxiSub',{km:tx.km.toFixed(1),min:tx.min})+'</div>'
    + '</div></div>'
    + '<div class="p-taxi-fare">≈'+tx.tl+' ₺</div>';
  if (tx.coords && tx.coords.length) c.onclick = showTaxiRoute;
  cont.appendChild(c);
}

// Draw the taxi's driving route on the map (origin → dest) and mark the card
// active, mirroring how a bus trip is selected.
function showTaxiRoute() {
  if (!currentTaxi || !currentTaxi.coords?.length) return;
  selectedMatch = null; tripMatch = null;
  document.querySelectorAll('.p-route-card').forEach(c => c.classList.remove('active'));
  document.querySelector('.p-taxi-card')?.classList.add('active');
  clearDrawn(); clearBuses(); hideNetworkStops();
  // origin/dest pins (originMarker/destMarker) persist on the map already.
  const line = L.polyline(currentTaxi.coords, { color: '#eab308', weight: 5, opacity: .9 }).addTo(window._map);
  drawnLayers.push(line);
  const mid = _polylineMidpoint(currentTaxi.coords);
  if (mid) drawnLayers.push(L.marker(mid, { icon: L.divIcon({ className: '', html: '<span class="walk-label">🚕 '+currentTaxi.km.toFixed(1)+' km · ~'+currentTaxi.min+' dk · ≈'+currentTaxi.tl+' ₺</span>', iconSize: null }), interactive: false, keyboard: false, zIndexOffset: 900 }).addTo(window._map));
  window._map.fitBounds(line.getBounds(), { padding: [45, 45] });
}

function selectPlannerMatch(m, fitMap = true){
  // Never redraw the planner overview while a guided trip is running — an async
  // findRoutes() continuation (its awaits resolving mid-trip) would otherwise
  // splatter the full route + walks back onto the guided map.
  if (guided && guided.active) return;
  selectedMatch=m;
  document.querySelectorAll('.p-route-card').forEach(c=>c.classList.remove('active'));
  document.querySelector('.p-taxi-card')?.classList.remove('active');
  if (m.isMultiLeg) {
    // Active card by matching the two badges + transfer name
    [...document.getElementById('results').querySelectorAll('.p-route-card')].find(c => {
      const badges = c.querySelectorAll('.p-route-badge');
      return badges.length === 2
          && badges[0].textContent === m.leg1.path.displayRouteCode
          && badges[1].textContent === m.leg2.path.displayRouteCode;
    })?.classList.add('active');
  } else {
    [...document.getElementById('results').querySelectorAll('.p-route-card')]
      .find(c=>c.querySelector('.p-route-badge')?.textContent===m.path.displayRouteCode&&c.innerHTML.includes(m.path.headSign))?.classList.add('active');
  }
  clearDrawn();clearBuses();hideNetworkStops();

  // Shared walk generation counter — both branches use _drawWalk and need the
  // same race-safety semantics so an in-flight OSRM fetch for a previous trip
  // doesn't overwrite the current trip's lines.
  const _walkGen = (selectPlannerMatch._gen = (selectPlannerMatch._gen || 0) + 1);
  function _drawWalk(a, b, color, slot) {
    if (!a || !b) return;
    const straight = L.polyline(
      [[a.lat, a.lng], [b.lat, b.lng]],
      { color, weight: 4, opacity: .85, dashArray: '6,8' }
    ).addTo(window._map);
    drawnLayers.push(straight);
    // Pre-route placeholder: detour-factor the straight line so the time/dist
    // label isn't an under-estimate (the routed value replaces it once it lands).
    const dStraight = haversine(a.lat, a.lng, b.lat, b.lng) * WALK_DETOUR_FACTOR;
    const tStraight = (dStraight / SETTINGS.walkSpeedMpm) * 60;
    let labelM = _walkLabelMarker([(a.lat+b.lat)/2, (a.lng+b.lng)/2], tStraight, dStraight).addTo(window._map);
    drawnLayers.push(labelM);
    fetchWalkingRoute(a, b).then(route => {
      if (_walkGen !== selectPlannerMatch._gen || (guided && guided.active)) return;
      if (!route) return;
      window._map.removeLayer(straight);
      drawnLayers = drawnLayers.filter(l => l !== straight && l !== labelM);
      window._map.removeLayer(labelM);
      const routed = L.polyline(route.coords, { color, weight: 4, opacity: .9 }).addTo(window._map);
      drawnLayers.push(routed);
      const mid = _polylineMidpoint(route.coords);
      if (mid) {
        // Label time from distance ÷ the user's walkSpeedMpm setting (not the
        // router's own duration) so it honors their configured walking pace.
        const walkSec = (route.distance / SETTINGS.walkSpeedMpm) * 60;
        labelM = _walkLabelMarker(mid, walkSec, route.distance).addTo(window._map);
        drawnLayers.push(labelM);
      }
      if (slot) _updateTripWalk(slot, route.distance);
    });
  }

  if (m.isMultiLeg) { _selectMultiLeg(m, fitMap, _drawWalk); return; }

  const ROUTE_COLOR = 'f59e0b'; // always yellow
  const pts=(m.path.pointList||[]).map(p=>[parseFloat(p.lat),parseFloat(p.lng)]);
  if(pts.length){const l=L.polyline(pts,{color:'#'+ROUTE_COLOR,weight:5,opacity:.9}).addTo(window._map);drawnLayers.push(l);if(fitMap)window._map.fitBounds(l.getBounds(),{padding:[40,40]});}

  // Walking lines: origin → boarding stop, alight stop → destination.
  // OSRM-routed via the shared _drawWalk helper defined above. The slot
  // parameter lets _drawWalk patch the trip-detail card with the actual
  // road distance once OSRM resolves (straight-line haversine on first paint).
  if (originClick && m.board) {
    _drawWalk(
      { lat: originClick.lat, lng: originClick.lng },
      { lat: parseFloat(m.board.lat), lng: parseFloat(m.board.lng) },
      '#2563eb',
      'board'
    );
  }
  if (destClick && m.alight) {
    _drawWalk(
      { lat: parseFloat(m.alight.lat), lng: parseFloat(m.alight.lng) },
      { lat: destClick.lat, lng: destClick.lng },
      '#16a34a',
      'alight'
    );
  }

  // Only show stops between board and alight (inclusive); skip the rest
  const allStopsOnRoute = m.path.busStopList || [];
  const boardIdx  = allStopsOnRoute.findIndex(s => s.stopId === m.board.stopId);
  const alightIdx = allStopsOnRoute.findIndex(s => s.stopId === m.alight.stopId);
  const tripStops = (boardIdx >= 0 && alightIdx >= 0)
    ? allStopsOnRoute.slice(boardIdx, alightIdx + 1)
    : allStopsOnRoute;

  for(const s of tripStops){
    const isB=s.stopId===m.board.stopId, isA=s.stopId===m.alight.stopId;
    drawnLayers.push(L.marker([parseFloat(s.lat),parseFloat(s.lng)],{icon:mkStopIcon(isB?'#2563eb':isA?'#16a34a':'#'+ROUTE_COLOR,isB||isA?14:9),zIndexOffset:isB||isA?500:200})
      .bindTooltip((isB?'🟦 ':isA?'🟩 ':'')+s.stopName,{permanent:isB||isA,direction:'top',offset:[0,isB||isA?-10:-5]})
      .on('click', () => openStopOnMap(s.stopId))
      .addTo(window._map));
  }
  drawBuses(m.buses, ROUTE_COLOR, m.path.displayRouteCode, m.path.busStopList);
}

// Render a multi-leg trip on the map: leg-1 polyline, transfer walk, leg-2
// polyline, plus the origin/destination walks. Bus markers for both legs.
function _selectMultiLeg(m, fitMap, drawWalk) {
  const HEX_L1 = 'f59e0b';
  const HEX_L2 = (m.leg2.route.routeColor || '4a7dc0').replace('#','').padStart(6,'0');

  const pts1 = (m.leg1.path.pointList || []).map(p => [parseFloat(p.lat), parseFloat(p.lng)]);
  const pts2 = (m.leg2.path.pointList || []).map(p => [parseFloat(p.lat), parseFloat(p.lng)]);
  if (pts1.length) drawnLayers.push(L.polyline(pts1, { color: '#'+HEX_L1, weight: 5, opacity: .9 }).addTo(window._map));
  if (pts2.length) drawnLayers.push(L.polyline(pts2, { color: '#'+HEX_L2, weight: 5, opacity: .9 }).addTo(window._map));

  // Walking segments: origin → leg1.board, transfer walk (if >0), leg2.alight → dest.
  // Slot tags let _drawWalk patch the open multi-leg trip-detail card with
  // real on-road distance once OSRM resolves.
  if (originClick && m.leg1.board) {
    drawWalk({ lat: originClick.lat, lng: originClick.lng },
             { lat: parseFloat(m.leg1.board.lat), lng: parseFloat(m.leg1.board.lng) },
             '#2563eb', 'leg1-board');
  }
  if (m.leg2.transferWalkM > 0) {
    drawWalk(
      { lat: parseFloat(m.leg1.alight.lat), lng: parseFloat(m.leg1.alight.lng) },
      { lat: parseFloat(m.leg2.board.lat),  lng: parseFloat(m.leg2.board.lng)  },
      '#f59e0b', 'transfer'
    );
  }
  if (destClick && m.leg2.alight) {
    drawWalk({ lat: parseFloat(m.leg2.alight.lat), lng: parseFloat(m.leg2.alight.lng) },
             { lat: destClick.lat, lng: destClick.lng }, '#16a34a', 'leg2-alight');
  }

  // Per-leg stop markers between board and alight (transfer point gets the 🔁)
  function drawLegStops(path, board, alight, legColorHex, boardIsTransfer) {
    const stops = path.busStopList || [];
    const bIdx = stops.findIndex(s => s.stopId === board.stopId);
    const aIdx = stops.findIndex(s => s.stopId === alight.stopId);
    const trip = (bIdx >= 0 && aIdx >= 0) ? stops.slice(bIdx, aIdx + 1) : stops;
    for (const s of trip) {
      const isB = s.stopId === board.stopId, isA = s.stopId === alight.stopId;
      const color  = isB ? (boardIsTransfer ? '#f59e0b' : '#2563eb')
                  : isA ? (alight === m.leg2.alight ? '#16a34a' : '#f59e0b')
                  : '#'+legColorHex;
      const prefix = isB ? (boardIsTransfer ? '🔁 ' : '🟦 ')
                  : isA ? (alight === m.leg2.alight ? '🟩 ' : '🔁 ')
                  : '';
      drawnLayers.push(L.marker([parseFloat(s.lat), parseFloat(s.lng)], {
        icon: mkStopIcon(color, isB || isA ? 14 : 9),
        zIndexOffset: isB || isA ? 500 : 200,
      }).bindTooltip(prefix + s.stopName, { permanent: isB || isA, direction: 'top', offset: [0, isB||isA ? -10 : -5] })
        .on('click', () => openStopOnMap(s.stopId))
        .addTo(window._map));
    }
  }
  drawLegStops(m.leg1.path, m.leg1.board, m.leg1.alight, HEX_L1, false);
  drawLegStops(m.leg2.path, m.leg2.board, m.leg2.alight, HEX_L2, m.leg2.transferWalkM === 0);

  // Bus markers for both legs (don't clear between calls)
  drawBuses(m.leg1.buses || [], HEX_L1, m.leg1.path.displayRouteCode, m.leg1.path.busStopList);
  drawBuses(m.leg2.buses || [], HEX_L2, m.leg2.path.displayRouteCode, m.leg2.path.busStopList, true);

  if (fitMap) {
    const bounds = L.latLngBounds([]);
    pts1.forEach(p => bounds.extend(p));
    pts2.forEach(p => bounds.extend(p));
    if (originClick) bounds.extend([originClick.lat, originClick.lng]);
    if (destClick)   bounds.extend([destClick.lat, destClick.lng]);
    if (bounds.isValid()) window._map.fitBounds(bounds, { padding: [40, 40] });
  }
}

function drawBuses(buses,hex,code,stops,noClear){
  if(!noClear) clearBuses();
  for(const b of buses){
    if(!b.lat||!b.lng)continue;
    const label=b.plateNumber||b.busLabel||'';
    const bla=parseFloat(b.lat), blo=parseFloat(b.lng);
    // Find current stop (by stopId) and the next stop in seq order — used for
    // both the heading-arrow bearing and the popup's "Şu an / Sıradaki" rows.
    const cur  = stops?.find(s => s.stopId === b.stopId) || null;
    const next = nextStopFor(b,stops);
    let brg=null;
    if(next){
      const sla=parseFloat(next.lat), slo=parseFloat(next.lng);
      if(Math.abs(bla-sla)>1e-6 || Math.abs(blo-slo)>1e-6) brg=bearing(bla,blo,sla,slo);
    }
    let popup = '<b>'+esc(code||'')+'</b>';
    if (b.busLabel) popup += ' · '+esc(b.busLabel);
    if (b.plateNumber) popup += '<br>'+esc(b.plateNumber);
    if (cur)  popup += '<br><span style="color:#7eb3f7">'+t('popupNow')+'</span> '+esc(cur.stopName);
    if (next) popup += '<br><span style="color:#22c55e">'+t('popupNext')+'</span> '+esc(next.stopName);
    busMarkers.push(L.marker([bla,blo],{icon:mkBusIcon(hex,brg,label),zIndexOffset:2000}).bindPopup(popup).addTo(window._map));
  }
}
async function refreshBuses(){
  if(!selectedMatch)return;
  // Multi-leg trips refetch both legs and redraw in one batch.
  if (selectedMatch.isMultiLeg) {
    const m = selectedMatch;
    try {
      const [r1, r2] = await Promise.all([
        fetch(API+'web/pathInfo?'+QS+'&displayRouteCode='+encodeURIComponent(m.leg1.path.displayRouteCode)+'&direction='+m.leg1.path.direction).then(x=>x.json()).catch(()=>null),
        fetch(API+'web/pathInfo?'+QS+'&displayRouteCode='+encodeURIComponent(m.leg2.path.displayRouteCode)+'&direction='+m.leg2.path.direction).then(x=>x.json()).catch(()=>null),
      ]);
      const fp1 = r1?.pathList?.[0], fp2 = r2?.pathList?.[0];
      m.leg1.buses = fp1?.busList || [];
      m.leg2.buses = fp2?.busList || [];
      const HEX_L1 = 'f59e0b';
      const HEX_L2 = (m.leg2.route.routeColor || '4a7dc0').replace('#','').padStart(6,'0');
      drawBuses(m.leg1.buses, HEX_L1, m.leg1.path.displayRouteCode, fp1?.busStopList || m.leg1.path.busStopList);
      drawBuses(m.leg2.buses, HEX_L2, m.leg2.path.displayRouteCode, fp2?.busStopList || m.leg2.path.busStopList, true);
      markKentkartResult(!!(fp1 || fp2));
    } catch {
      clearBuses();
      markKentkartResult(false);
    }
    return;
  }
  const{path,route}=selectedMatch;
  try{
    const r=await fetch(API+'web/pathInfo?'+QS+'&displayRouteCode='+encodeURIComponent(path.displayRouteCode)+'&direction='+path.direction);
    const d=await r.json();const fp=d.pathList?.[0];
    if(fp){
      drawBuses(fp.busList||[],(route.routeColor||'4a7dc0').replace('#',''),path.displayRouteCode,fp.busStopList||path.busStopList);
      // refresh trip detail panel if open
      if(tripMatch&&!tripMatch.isMultiLeg&&tripMatch.path.path_code===path.path_code){
        // skipMap=true: bus markers are already refreshed by drawBuses above;
        // re-rendering the polyline + walking lines would trigger a fresh OSRM
        // fetch and cause visible flicker every 30s.
        tripMatch.buses=fp.busList||[];showTripDetail(tripMatch,false,true);
      }
      markKentkartResult(true);
    } else {
      clearBuses();
      markKentkartResult(false);
    }
  }catch{
    clearBuses();
    markKentkartResult(false);
  }
}
function clearDrawn(){drawnLayers.forEach(l=>window._map.removeLayer(l));drawnLayers=[];}
function clearBuses(){busMarkers.forEach(l=>window._map.removeLayer(l));busMarkers=[];}
function hideNetworkStops(){ if(networkStopLayer){ networkStopLayer._active=false; networkStopLayer.remove(); } }
function showNetworkStops(){ if(guided&&guided.active)return; if(networkStopLayer){ networkStopLayer._active=true; if(window._updateStopVis) window._updateStopVis(); } }

// ── Route tracker (launched from Seferler tab) ────────────────────────────────
let trackedPaths   = [];   // all pathCache entries for the tracked route code
let trackedPathIdx = 0;    // which direction is selected
let trackTimer     = null;
let trackLastRefresh = 0;

async function trackRoute(displayRouteCode) {
  showScreen('planner');
  // Wait for planner data (initPlanner is triggered by showScreen)
  if (!getPathCache().length) {
    const results = document.getElementById('results');
    results.style.display = '';
    document.getElementById('stopPanel').style.display = 'none';
    results.innerHTML = '<div style="padding:16px 4px;color:#4a5568;font-size:.82rem">'+t('routeDataLoading')+'</div>';
    const ok = await new Promise(resolve => {
      const deadline = Date.now() + 60000;
      const iv = setInterval(() => {
        if (getPathCache().length) { clearInterval(iv); resolve(true); }
        else if (Date.now() > deadline) { clearInterval(iv); resolve(false); }
      }, 300);
    });
    if (!ok) {
      document.getElementById('results').innerHTML =
        '<div style="padding:16px 4px;color:#ef4444;font-size:.82rem">'+t('routeDataFailed')+'</div>';
      return;
    }
  }

  // Normalise both sides: kentkart stores '11K' while PDF uses 'Ç11K'
  const code = schedCodeNorm(displayRouteCode);
  trackedPaths = getPathCache().filter(pe =>
    schedCodeNorm(pe.path.displayRouteCode)  === code ||
    schedCodeNorm(pe.route.displayRouteCode) === code
  );
  if (!trackedPaths.length) {
    document.getElementById('results').innerHTML =
      '<div style="padding:16px 4px;color:#ef4444;font-size:.82rem">' + t('routeNotFound',{code:esc(displayRouteCode)}) + '</div>';
    return;
  }

  trackedPathIdx = 0;
  if (trackTimer) clearInterval(trackTimer);
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  selectedMatch = null; tripMatch = null;

  showTrackPanel();
  // Enable X button so user can exit tracking mode
  const rb = document.getElementById('btnReset');
  rb.disabled = false; rb.style.color = '#ef4444';
  if (window._map) window._map.invalidateSize();
  await selectTrackPath(0);
  trackTimer = setInterval(() => selectTrackPath(trackedPathIdx, true), 15000);
}

function showTrackPanel() {
  const pe     = trackedPaths[0];
  const hex    = (pe.route.routeColor || 'aaaaaa').replace('#', '').padStart(6, '0');
  const txt    = textOnHex(hex);
  const code   = pe.path.displayRouteCode;

  const cont = document.getElementById('results');
  cont.style.display = '';
  document.getElementById('stopPanel').style.display = 'none';

  let html = '<div style="padding:10px 2px">';
  html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">';
  html += '<button class="track-back" onclick="closeTrackPanel()">← Geri</button>';
  html += '<span class="p-route-badge" style="background:#'+hex+';color:'+txt+'">'+esc(code)+'</span>';
  html += '<span style="font-weight:700;font-size:.88rem;flex:1">'+esc(pe.route.name||pe.path.headSign)+'</span>';
  html += '</div>';

  // Direction buttons
  html += '<div class="track-dirs">';
  trackedPaths.forEach((p, i) => {
    html += '<button class="track-dir-btn'+(i===trackedPathIdx?' active':'')+'" '
          + 'onclick="selectTrackPath('+i+')" id="tdb-'+i+'">'
          + esc(p.path.headSign || t('dirN',{n:(i+1)}))
          + '</button>';
  });
  html += '</div>';

  html += '<div class="track-bus-list" id="track-bus-list"><div style="color:#4a5568;font-size:.75rem;padding:4px 0">'+t('busesLoading')+'</div></div>';
  html += '<div class="track-refresh" id="track-refresh"></div>';
  html += '</div>';
  cont.innerHTML = html;
}

async function selectTrackPath(idx, refreshOnly = false) {
  trackedPathIdx = idx;

  // Update active button
  trackedPaths.forEach((_, i) => {
    const btn = document.getElementById('tdb-'+i);
    if (btn) btn.classList.toggle('active', i === idx);
  });

  const pe  = trackedPaths[idx];
  const hex = (pe.route.routeColor || '4a7dc0').replace('#', '');

  if (!refreshOnly) {
    clearDrawn(); clearBuses(); hideNetworkStops();
    const pts = (pe.path.pointList || []).map(p => [parseFloat(p.lat), parseFloat(p.lng)]);
    if (pts.length) {
      const l = L.polyline(pts, { color: '#f59e0b', weight: 5, opacity: .9 }).addTo(window._map);
      drawnLayers.push(l);
      window._map.fitBounds(l.getBounds(), { padding: [40, 40] });
    }
    for (const s of (pe.path.busStopList || [])) {
      drawnLayers.push(
        L.marker([parseFloat(s.lat), parseFloat(s.lng)], { icon: mkStopIcon('#'+hex, 9), zIndexOffset: 200 })
          .bindTooltip(s.stopName, { direction: 'top', offset: [0, -5] })
          .on('click', () => openStopOnMap(s.stopId))
          .addTo(window._map)
      );
    }
  }

  // Fetch fresh bus positions
  try {
    const r = await fetch(API+'web/pathInfo?'+QS
      +'&displayRouteCode='+encodeURIComponent(pe.path.displayRouteCode)
      +'&direction='+pe.path.direction);
    const d = await r.json();
    const fp = d.pathList?.[0];
    if (fp) {
      drawBuses(fp.busList || [], hex, pe.path.displayRouteCode, fp.busStopList || pe.path.busStopList);
      renderTrackBuses(fp.busList || [], pe, hex);
      markKentkartResult(true);
    } else {
      clearBuses();
      renderTrackBuses([], pe, hex);
      markKentkartResult(false);
    }
  } catch {
    clearBuses();
    renderTrackBuses(null, pe, hex);
    markKentkartResult(false);
  }

  trackLastRefresh = Date.now();
  const el = document.getElementById('track-refresh');
  if (el) el.textContent = t('updatedJustNow');
}

function renderTrackBuses(buses, pe, hex) {
  const list = document.getElementById('track-bus-list');
  if (!list) return;
  if (!buses || !buses.length) {
    list.innerHTML = '<div style="color:#4a5568;font-size:.75rem;padding:4px 0">'+t('noActiveBuses')+'</div>';
    return;
  }
  const stops = pe.path.busStopList || [];
  const seqOf = {};
  stops.forEach(s => seqOf[s.stopId] = parseInt(s.seq) || 0);
  const seqs    = stops.map(s => parseInt(s.seq) || 0);
  const lastSeq = seqs.length ? Math.max(...seqs) : 0;

  let html = '';
  for (const b of buses) {
    if (!b.lat && !b.lng) continue;
    const seq  = seqOf[b.stopId] ?? -1;
    const rem  = seq >= 0 ? lastSeq - seq : null;
    const col  = rem === null ? '#f59e0b' : rem <= 3 ? '#ef4444' : rem <= 8 ? '#22c55e' : '#7eb3f7';
    const remTxt = rem !== null ? t('stopsLeft',{n:rem}) : t('locUnknown');
    html += '<div class="track-bus-row">'
          + '<div class="bus-dot" style="background:#'+hex+';width:10px;height:10px;border-radius:50%;flex-shrink:0"></div>'
          + '<div style="flex:1"><b>' + esc(b.plateNumber || b.busLabel || t('busWord')) + '</b>'
          + '<div style="font-size:.68rem;color:#4a5568">' + esc(b.stopName || stops.find(s=>s.stopId===b.stopId)?.stopName || '') + '</div></div>'
          + '<span style="font-size:.72rem;font-weight:700;color:'+col+'">' + remTxt + '</span>'
          + '</div>';
  }
  list.innerHTML = html || '<div style="color:#4a5568;font-size:.75rem;padding:4px 0">'+t('noActiveBuses')+'</div>';
}

function closeTrackPanel() {
  if (trackTimer) { clearInterval(trackTimer); trackTimer = null; }
  trackedPaths = [];
  clearDrawn(); clearBuses(); showNetworkStops();
  document.getElementById('results').innerHTML = '';
  setHint(t('hintClickStart'));
}

// ── Bus arrival notifications (Cloudflare Worker + Web Push) ─────────────────
let notifyMatch  = null;
let notifySubId  = null; // subscription ID returned by the Worker

async function toggleBusNotify() {
  // Cancel if already watching this trip
  if (notifyMatch && tripMatch && !tripMatch.isMultiLeg && notifyMatch.path.path_code === tripMatch.path.path_code) {
    await stopBusNotify();
    const btn = document.getElementById('notify-btn');
    if (btn) { btn.textContent = t('notifyOff'); btn.classList.remove('active'); }
    return;
  }

  if (WORKER_URL === 'REPLACE_WITH_YOUR_WORKER_URL') {
    alert(t('pushWorkerNotSet'));
    return;
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert(t('pushUnsupported'));
    return;
  }

  // Permission
  const perm = Notification.permission === 'granted'
    ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') {
    alert(t('pushPermDenied'));
    return;
  }

  // Get or create push subscription
  let reg;
  try { reg = await navigator.serviceWorker.ready; } catch {
    alert(t('pushSwNotReady')); return;
  }

  // Always unsubscribe first — stale subscriptions from previous VAPID keys
  // cause "push service error" from FCM. Fresh subscribe is more reliable.
  try {
    const existing = await reg.pushManager.getSubscription();
    if (existing) await existing.unsubscribe();
  } catch {}

  let pushSub;
  try {
    pushSub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  } catch (e) {
    const isBrave = (navigator.brave && await navigator.brave.isBrave().catch(()=>false)) || false;
    const reason  = isBrave ? t('pushBrave') : t('pushNoPerm');
    alert(t('pushSubFailed',{reason}));
    return;
  }

  // Register with Worker
  const m = tripMatch;
  const stops  = m.path.busStopList || [];
  const seqOf  = {};
  stops.forEach(s => { seqOf[s.stopId] = parseInt(s.seq) || 0; });

  // Compute next scheduled departure timestamp (epoch ms) for time-based alert
  const dayData_  = getActiveRoutes();
  const schedE_   = findSchedEntry(dayData_, m.path.displayRouteCode);
  const schedT_   = schedTimesForPath(schedE_, m.path);
  let nextDepTs   = null;
  if (schedT_.length) {
    const nowMs = Date.now();
    const curH  = new Date().getHours();
    for (const t of schedT_) {
      const [h, mn] = t.split(':').map(Number);
      const d = new Date();
      // Times like "00:30" appearing late in the sorted list mean tomorrow morning
      if (h < 4 && curH >= 4) d.setDate(d.getDate() + 1);
      d.setHours(h, mn, 0, 0);
      if (d.getTime() > nowMs) { nextDepTs = d.getTime(); break; }
    }
    if (!nextDepTs) {
      const [h, mn] = schedT_[0].split(':').map(Number);
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, mn, 0, 0);
      nextDepTs = d.getTime();
    }
  }

  try {
    const res = await fetch(WORKER_URL + '/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: pushSub.toJSON(),
        trip: {
          routeCode:     m.path.displayRouteCode,
          direction:     m.path.direction,
          boardStopId:   m.board.stopId,
          boardSeq:      seqOf[m.board.stopId] ?? 0,
          boardStopName: m.board.stopName,
          headSign:      m.path.headSign,
          pathCode:      m.path.path_code,
          nextDepTs,
        },
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { id } = await res.json();
    notifySubId  = id;
    notifyMatch  = m;
    const btn = document.getElementById('notify-btn');
    if (btn) { btn.textContent = t('notifyOn'); btn.classList.add('active'); }
  } catch (e) {
    alert(t('pushWorkerConnFail',{err:e.message}));
  }
}

async function stopBusNotify() {
  if (notifySubId) {
    fetch(WORKER_URL + '/subscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: notifySubId }),
    }).catch(() => {});
    notifySubId = null;
  }
  notifyMatch = null;
}

function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// Register service worker on page load — also listen for new SW activations
// and surface an "Update available" pill so users can refresh on demand.
let _pendingWorker = null;
function applyAppUpdate() {
  if (_pendingWorker) _pendingWorker.postMessage({ type: 'SKIP_WAITING' });
  setTimeout(() => location.reload(), 200);
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(reg => {
    const promote = () => { _pendingWorker = reg.waiting; document.getElementById('updateToast')?.classList.add('visible'); };
    if (reg.waiting && navigator.serviceWorker.controller) promote();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing; if (!nw) return;
      nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) promote(); });
    });
  }).catch(() => {});
  let _reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (_reloaded) return; _reloaded = true; location.reload(); });
}

// ── Trip detail ───────────────────────────────────────────────────────────────
// (MINS_PER_STOP, MAX_WAIT_MIN, TRANSFER_PENALTY_MIN are declared with the planner above.)

// Patches walk distance/time on an open trip-detail card once OSRM resolves
// with the real on-road distance for either the board or alight leg. The
// initial render uses straight-line haversine because findRoutes is sync;
// this corrects it asynchronously, and rolls the new value into the total.
function _updateTripWalk(slot, meters) {
  const w = window._tripWalks;
  if (!w) return;
  const mins = Math.max(1, Math.round(meters / SETTINGS.walkSpeedMpm));
  if (slot === 'board') {
    w.walkBMins = mins;
    const el = document.getElementById('trip-walk-board-time');
    if (el) el.textContent = '~' + mins + ' ' + t('min');
    const d = document.getElementById('trip-walk-board-detail');
    if (d) d.textContent = t('walkBoardDetail',{dist:fmtDist(meters),mins});
  } else if (slot === 'alight') {
    w.walkAMins = mins;
    const el = document.getElementById('trip-walk-alight-time');
    if (el) el.textContent = '~' + mins + ' ' + t('min');
    const d = document.getElementById('trip-walk-alight-detail');
    if (d) d.textContent = t('walkAlightDetail',{dist:fmtDist(meters),mins});
  } else return;
  const total = w.walkBMins + w.waitMins + w.rideMins + w.walkAMins;
  const tot = document.getElementById('trip-total-value');
  if (tot) tot.textContent = '~' + total + ' ' + t('min');
}

function showTripDetail(m, fitMap = true, skipMap = false) {
  tripMatch = m;
  if (!skipMap) selectPlannerMatch(m, fitMap); // draw route on map
  if (m.isMultiLeg) { _showMultiLegTripDetail(m); return; }

  const stops   = m.path.busStopList || [];
  const seqOf   = {}, idxOf = {};
  stops.forEach((s, i) => { seqOf[s.stopId] = parseInt(s.seq) || 0; idxOf[s.stopId] = i; });
  const boardSeq  = seqOf[m.board.stopId]  ?? 0;
  const alightSeq = seqOf[m.alight.stopId] ?? 0;
  const boardIdx  = stops.findIndex(s => s.stopId === m.board.stopId);
  const alightIdx = stops.findIndex(s => s.stopId === m.alight.stopId);
  const tripStops = (boardIdx >= 0 && alightIdx >= 0) ? stops.slice(boardIdx, alightIdx + 1) : [];

  // Time estimates
  const walkToMins   = Math.max(1, Math.round(m.walkB / SETTINGS.walkSpeedMpm));
  const walkFromMins = Math.max(1, Math.round(m.walkA / SETTINGS.walkSpeedMpm));
  const rideMins     = (boardIdx >= 0 && alightIdx >= 0)
    ? Math.round(_rideMins(stops, boardIdx, alightIdx))
    : Math.round(m.sc * MINS_PER_STOP);

  // Which buses are approaching the board stop (seq < boardSeq)
  const approaching = (m.buses || [])
    .filter(b => { const s = seqOf[b.stopId] ?? -1; return s >= 0 && s < boardSeq; })
    .map(b    => ({ ...b, stopsAway: boardSeq - seqOf[b.stopId], minsAway: Math.round(_rideMins(stops, idxOf[b.stopId], boardIdx)) }))
    .sort((a, b) => a.stopsAway - b.stopsAway);
  const atStop  = (m.buses || []).filter(b => b.stopId === m.board.stopId);
  const onBoard = (m.buses || []).filter(b => { const s = seqOf[b.stopId] ?? -1; return s >= boardSeq && s < alightSeq; });
  // Only count a live bus as catchable if you can plausibly reach the stop
  // before it arrives. The small REACH_GRACE_MIN tolerance means a bus a couple
  // minutes "too soon" still counts; genuinely unreachable ones are dropped (we
  // then fall back to the schedule). An at-stop bus is catchable only if you're
  // basically already there (walk ≤ grace).
  const reachable = approaching.filter(b => b.minsAway >= walkToMins - REACH_GRACE_MIN);
  const atStopReachable = atStop.length && walkToMins <= REACH_GRACE_MIN;

  // ── Schedule lookup ──────────────────────────────────────────────────────────
  // Schedule is keyed by full route name (e.g. "Ç11K KEPEZ ESENLER"), not by code.
  const dayData = getActiveRoutes();
  const schedEntry = findSchedEntry(dayData, m.path.displayRouteCode);
  const nowMins    = _schedFrame(new Date().getHours()*60 + new Date().getMinutes() + planOffset);   // service-day frame, matches toMins below
  // toMins maps early-morning times (h<4) to next-day to keep sort order sane
  const toMins     = t => { const [h, mn] = t.split(':').map(Number); return (h < 4 ? h*60+1440 : h*60) + mn; };
  // Sort by actual chronological minute value — NOT alphabetically.
  // Alphabetical puts "00:10" before "07:40", making it look like the next bus
  // is 741 minutes away instead of finding the real next same-day departure.
  const allSchedTimes = schedTimesForPath(schedEntry, m.path).sort((a, b) => toMins(a) - toMins(b));

  // For each terminal departure, calculate when the bus reaches the boarding stop
  // (from GTFS offsets, flat per-stop fallback inside _travelToStopMins).
  const travelToBoard = _travelToStopMins(boardIdx >= 0 ? stops[boardIdx] : m.board);

  let nextDep = null; // { time: "HH:MM", boardMins: number, tomorrow?: true }
  for (const t of allSchedTimes) {
    const boardMins = toMins(t) + travelToBoard;
    if (boardMins >= nowMins) { nextDep = { time: t, boardMins }; break; }
  }
  // All of today's buses already departed — wrap to first bus tomorrow
  if (!nextDep && allSchedTimes.length) {
    const t = allSchedTimes[0];
    nextDep = { time: t, boardMins: toMins(t) + travelToBoard + 1440, tomorrow: true };
  }

  // ── Wait time ────────────────────────────────────────────────────────────────
  // Live data is only relevant when planning for now; skip it when planOffset > 0
  let waitMins = 0, waitLabel = '', waitDetail = '';
  if (!planOffset && atStopReachable) {
    waitMins   = 0;
    waitLabel  = t('waitBusArrived');
    waitDetail = atStop[0].plateNumber || '';
  } else if (!planOffset && reachable.length) {
    waitMins   = reachable[0].minsAway;
    waitLabel  = t('waitLive');
    waitDetail = t('busAwayDetail',{plate:(reachable[0].plateNumber || t('activeShort')),n:reachable[0].stopsAway});
  } else if (nextDep) {
    waitMins   = Math.max(0, Math.round(nextDep.boardMins - nowMins));
    waitLabel  = nextDep.tomorrow ? t('waitDepartTomorrow',{time:nextDep.time}) : t('waitDepart',{time:nextDep.time});
    const arrRaw = nextDep.boardMins % 1440;
    const arrH = Math.floor(arrRaw / 60).toString().padStart(2,'0');
    const arrM = Math.floor(arrRaw % 60).toString().padStart(2,'0');
    waitDetail = nextDep.tomorrow ? t('arrivesAtTomorrow',{time:arrH+':'+arrM}) : t('arrivesAt',{time:arrH+':'+arrM});
  } else {
    waitMins   = 999;
    waitLabel  = t('schedUnknown');
    waitDetail = t('noLive');
  }
  // Last-bus notice: when the caught departure is the day's final one.
  const isLastSeferDetail = !!(nextDep && !nextDep.tomorrow && allSchedTimes.length
    && nextDep.time === allSchedTimes[allSchedTimes.length - 1]);

  const totalMins = walkToMins + waitMins + rideMins + walkFromMins;
  // Snapshot for async OSRM correction — _updateTripWalk patches this card
  // once real road distance arrives.
  window._tripWalks = { walkBMins: walkToMins, walkAMins: walkFromMins, waitMins, rideMins };

  // ── Scheduled departure chips (next 5 terminal departures, wrap-aware) ──────
  const nextTimes = _nextTimes(allSchedTimes, 5);

  // Badge
  const hex = (m.route.routeColor || 'aaaaaa').replace('#','').padStart(6,'0');
  const txt = textOnHex(hex);

  // Build set of stopIds that have a live bus (for timeline markers)
  const busAtStop = new Set((m.buses || []).map(b => b.stopId));

  // ── Render ────────────────────────────────────────────────────────────────
  let html = '';

  // Back button + route header
  const isNotifying = notifyMatch && notifyMatch.path.path_code === m.path.path_code;
  html += '<div style="display:flex;align-items:center;gap:8px;padding-bottom:8px;border-bottom:1px solid #252d40;margin-bottom:10px">'
        +   '<button class="trip-back" onclick="closeTripDetail()">'+t('backToLines')+'</button>'
        +   '<span class="p-route-badge" style="background:#'+hex+';color:'+txt+'">'+m.path.displayRouteCode+'</span>'
        +   '<span style="font-size:.78rem;font-weight:600;flex:1">'+esc(m.path.headSign)+'</span>'
        +   '<button class="notify-btn'+(isNotifying?' active':'')+'" id="notify-btn" '
        +     'onclick="toggleBusNotify()">'
        +     (isNotifying ? t('notifyOn') : t('notifyOff'))
        +   '</button>'
        + '</div>';

  // ── Start guided trip ─────────────────────────────────────────────────────
  html += planOffset
    ? '<p class="guided-start-hint">'+t('startTripPlanAhead')+'</p>'
    : '<button class="guided-start-btn" onclick="startGuidedTrip()">🧭 '+t('startTrip')+'</button>';

  // ── Journey summary ──────────────────────────────────────────────────────
  html += '<div class="trip-section">';
  html += '<div class="trip-section-title">'+t('journeySummary')+'</div>';

  // Walk to board
  html += '<div class="journey-step">'
        +   '<span class="journey-icon">🚶</span>'
        +   '<span class="journey-time" id="trip-walk-board-time">~'+walkToMins+' '+t('min')+'</span>'
        +   '<div><span class="journey-stop-name">'+esc(m.board.stopName)+'</span> <span class="journey-stop-id">#'+m.board.stopId+'</span>'
        +   '<div class="journey-detail" id="trip-walk-board-detail">'+t('walkBoardDetail',{dist:fmtDist(m.walkB),mins:walkToMins})+'</div>'
        +   '</div>'
        + '</div>';

  // Wait
  const waitCol = atStop.length ? '#3b82f6' : approaching.length ? '#22c55e' : '#f59e0b';
  html += '<div class="journey-step">'
        +   '<span class="journey-icon">⏱</span>'
        +   '<span class="journey-time" style="color:'+waitCol+'">'+(waitMins === 0 ? t('nowWord') : '~'+waitMins+' '+t('min'))+'</span>'
        +   '<div><span class="journey-main">'+esc(waitLabel)+'</span>'
        +   '<div class="journey-detail">'+esc(waitDetail)+'</div>'
        +   (isLastSeferDetail ? '<div class="journey-detail" style="color:#fbbf24;font-weight:700">⚠️ '+t('lastSeferNote')+'</div>' : '')
        +   '</div>'
        + '</div>';

  // Ride
  html += '<div class="journey-step">'
        +   '<span class="journey-icon">🚌</span>'
        +   '<span class="journey-time">~'+rideMins+' '+t('min')+'</span>'
        +   '<div><span class="journey-main">'+t('metaDirect',{n:m.sc})+'</span>'
        +   '<div class="journey-detail">'+esc(m.path.headSign)+'</div>'
        +   '</div>'
        + '</div>';

  // Alight + walk to dest
  html += '<div class="journey-step">'
        +   '<span class="journey-icon">🏁</span>'
        +   '<span class="journey-time" id="trip-walk-alight-time">~'+walkFromMins+' '+t('min')+'</span>'
        +   '<div><span class="journey-stop-name">'+esc(m.alight.stopName)+'</span> <span class="journey-stop-id">#'+m.alight.stopId+'</span>'
        +   '<div class="journey-detail" id="trip-walk-alight-detail">'+t('walkAlightDetail',{dist:fmtDist(m.walkA),mins:walkFromMins})+'</div>'
        +   '</div>'
        + '</div>';

  html += '<div class="total-box">'
        +   '<span class="total-box-label">'+t('totalEst')+'</span>'
        +   '<span class="total-box-value" id="trip-total-value">~'+totalMins+' '+t('min')+'</span>'
        + '</div>';
  html += '</div>';

  // ── Incoming buses ───────────────────────────────────────────────────────
  // Only shown when there's real-time data (a bus at the stop or approaching).
  // With no live buses this used to just echo the next scheduled time, which the
  // "Programlı Seferler" section below already shows better — so we hide it.
  if (atStopReachable || approaching.length) {
    html += '<div class="trip-section">';
    html += '<div class="trip-section-title">'+t('incomingBuses')+'</div>';
    if (atStopReachable) {
      html += '<div class="live-row"><div class="bus-dot dot-blue" style="width:10px;height:10px"></div>'
            + '<div style="flex:1"><b>'+esc(atStop[0].plateNumber||t('activeShort'))+'</b></div>'
            + '<span class="live-eta" style="color:#3b82f6">'+t('busArrivedExcl')+'</span></div>';
    }
    if (approaching.length) {
      approaching.forEach(b => {
        const dot = b.stopsAway <= 2 ? 'dot-blue' : b.stopsAway <= 5 ? 'dot-green' : 'dot-yellow';
        const col = b.stopsAway <= 2 ? '#3b82f6' : b.stopsAway <= 5 ? '#22c55e' : '#f59e0b';
        html += '<div class="live-row"><div class="bus-dot '+dot+'" style="width:10px;height:10px"></div>'
              + '<div style="flex:1"><b>'+esc(b.plateNumber||t('activeShort'))+'</b><div style="font-size:.68rem;color:#4a5568">'+t('stopsAwayText',{n:b.stopsAway})+'</div></div>'
              + '<span class="live-eta" style="color:'+col+'">~'+b.minsAway+' '+t('min')+'</span></div>';
      });
    }
    html += '</div>';
  }

  // ── Scheduled times ──────────────────────────────────────────────────────
  if (nextTimes.length) {
    html += '<div class="trip-section">';
    html += '<div class="trip-section-title">'+t('schedTimes')+' <span style="font-weight:400;opacity:.6">'+t('schedApprox')+'</span></div>';
    html += '<div class="dep-chips">';
    nextTimes.forEach((tm, i) => { html += '<span class="dep-chip'+(i===0?' next':'')+'">'+tm+'</span>'; });
    html += '</div></div>';
  }

  // ── Buses riding the route (between board and alight) ────────────────────
  if (onBoard.length) {
    html += '<div class="trip-section">';
    html += '<div class="trip-section-title">'+t('activeOnRoute')+'</div>';
    onBoard.forEach(b => {
      const rem = alightSeq - (seqOf[b.stopId] ?? alightSeq);
      html += '<div class="live-row"><div class="bus-dot dot-orange" style="width:10px;height:10px"></div>'
            + '<div style="flex:1"><b>'+esc(b.plateNumber||t('activeShort'))+'</b>'
            + '<div style="font-size:.68rem;color:#4a5568">'+t('stopsLeft',{n:rem})+'</div></div>'
            + '<span class="live-eta" style="color:#ef4444">~'+Math.round(rem*MINS_PER_STOP)+' '+t('min')+'</span></div>';
    });
    html += '</div>';
  }

  // ── Stop timeline ────────────────────────────────────────────────────────────
  if (tripStops.length > 1) {
    html += '<div class="trip-section">';
    html += '<div class="trip-section-title">'+t('routeStops')+'</div>';
    html += '<div class="tl"><div class="tl-line"></div>';
    tripStops.forEach(s => {
      const isBoard  = s.stopId === m.board.stopId;
      const isAlight = s.stopId === m.alight.stopId;
      const hasBus   = busAtStop.has(s.stopId);
      const dotCls   = isBoard ? 'board' : isAlight ? 'alight' : hasBus ? 'bus' : '';
      html += '<div class="tl-item">'
            +   '<div class="tl-dot '+dotCls+'"></div>'
            +   '<span class="tl-name">'+esc(s.stopName)+'</span>'
            +   '<span class="tl-id">#'+s.stopId+'</span>';
      if (isBoard)  html += ' <span class="tl-badge board">'+t('tlBoard')+'</span>';
      if (isAlight) html += ' <span class="tl-badge alight">'+t('tlAlight')+'</span>';
      if (hasBus && !isBoard && !isAlight) html += ' <span class="tl-badge bus">🚌</span>';
      html += '</div>';
    });
    html += '</div></div>';
  }

  // ── Show in results panel ────────────────────────────────────────────────────
  const cont = document.getElementById('results');
  cont.innerHTML = '<div style="padding:12px 2px;overflow-y:auto;height:100%">' + html + '</div>';
  document.getElementById('stopPanel').style.display = 'none';
  cont.style.display = '';
}

function _showMultiLegTripDetail(m) {
  const h1 = (m.leg1.route.routeColor || 'aaaaaa').replace('#','').padStart(6,'0');
  const h2 = (m.leg2.route.routeColor || 'aaaaaa').replace('#','').padStart(6,'0');
  const walkBMins  = Math.max(1, Math.round(m.leg1.walkB / SETTINGS.walkSpeedMpm));
  const walkAMins  = Math.max(1, Math.round(m.leg2.walkA / SETTINGS.walkSpeedMpm));
  const xferMins   = m.leg2.transferWalkMins;
  // Snapshot for async OSRM correction — _updateTripWalk patches this card
  // once real road distances arrive for the three walking segments.
  window._tripWalks = {
    multi: true, ref: m,
    walkBMins, walkAMins, xferMins,
    leg1Wait: m.leg1.wait, leg2Wait: m.leg2.wait,
    leg1Ride: m.leg1.ride, leg2Ride: m.leg2.ride,
  };

  let html = '';
  // Header
  html += '<div style="display:flex;align-items:center;gap:6px;padding-bottom:8px;border-bottom:1px solid #252d40;margin-bottom:10px;flex-wrap:wrap">'
        +   '<button class="trip-back" onclick="closeTripDetail()">'+t('backToLines')+'</button>'
        +   '<span class="p-multileg-badge">'+t('oneTransfer')+'</span>'
        +   '<span class="p-route-badge" style="background:#'+h1+';color:'+textOnHex(h1)+'">'+esc(m.leg1.path.displayRouteCode)+'</span>'
        +   '<span class="p-leg-arrow">→</span>'
        +   '<span class="p-route-badge" style="background:#'+h2+';color:'+textOnHex(h2)+'">'+esc(m.leg2.path.displayRouteCode)+'</span>'
        +   '<span style="flex:1"></span>'
        +   '<span class="p-route-eta">~'+m._eta+' '+t('min')+'</span>'
        + '</div>';

  // Start guided trip
  html += planOffset
    ? '<p class="guided-start-hint">'+t('startTripPlanAhead')+'</p>'
    : '<button class="guided-start-btn" onclick="startGuidedTrip()">🧭 '+t('startTrip')+'</button>';

  // Journey summary
  html += '<div class="trip-section">';
  html += '<div class="trip-section-title">'+t('journeySummary')+'</div>';

  // 1. Walk to board
  html += '<div class="journey-step">'
        +   '<span class="journey-icon">🚶</span>'
        +   '<div style="flex:1">'
        +     '<div class="journey-main" id="ml-leg1-board-main">'+t('mlWalk',{mins:walkBMins,dist:fmtDist(m.leg1.walkB)})+'</div>'
        +     '<div class="journey-detail">'+t('mlBoard',{stop:esc(m.leg1.board.stopName)})+'</div>'
        +   '</div>'
        + '</div>';

  // 2. Leg 1 ride
  html += '<div class="journey-step">'
        +   '<span class="p-route-badge" style="background:#'+h1+';color:'+textOnHex(h1)+'">'+esc(m.leg1.path.displayRouteCode)+'</span>'
        +   '<div style="flex:1">'
        +     '<div class="journey-main">'+t('mlLeg1Main',{wait:m.leg1.wait,ride:m.leg1.ride})+'</div>'
        +     '<div class="journey-detail">'+t('mlLegDetail',{sc:m.leg1.sc,from:esc(m.leg1.board.stopName),to:esc(m.leg1.alight.stopName)})+'</div>'
        +   '</div>'
        + '</div>';

  // 3. Aktarma
  html += '<div class="journey-step">'
        +   '<span class="journey-icon">🔁</span>'
        +   '<div style="flex:1">'
        +     '<div class="journey-main">'+t('xferTitle',{stop:esc(m.leg1.alight.stopName)})
        +       (m.leg2.transferWalkM > 0 ? '' : t('sameStopShort'))+'</div>'
        +     '<div class="journey-detail" id="ml-transfer-detail">'
        +       (m.leg2.transferWalkM > 0
                  ? t('mlXferWalk',{mins:xferMins,dist:fmtDist(m.leg2.transferWalkM)})
                  : '')
        +       t('mlWaitMin',{wait:m.leg2.wait})
        +     '</div>'
        +   '</div>'
        + '</div>';

  // 4. Leg 2 ride
  html += '<div class="journey-step">'
        +   '<span class="p-route-badge" style="background:#'+h2+';color:'+textOnHex(h2)+'">'+esc(m.leg2.path.displayRouteCode)+'</span>'
        +   '<div style="flex:1">'
        +     '<div class="journey-main">'+t('mlRideOnly',{ride:m.leg2.ride})+'</div>'
        +     '<div class="journey-detail">'+t('mlLegDetail',{sc:m.leg2.sc,from:esc(m.leg2.board.stopName),to:esc(m.leg2.alight.stopName)})+'</div>'
        +   '</div>'
        + '</div>';

  // 5. Walk to dest
  html += '<div class="journey-step">'
        +   '<span class="journey-icon">🚶</span>'
        +   '<div style="flex:1">'
        +     '<div class="journey-main" id="ml-leg2-alight-main">'+t('mlWalk',{mins:walkAMins,dist:fmtDist(m.leg2.walkA)})+'</div>'
        +     '<div class="journey-detail">'+t('mlAlight',{stop:esc(m.leg2.alight.stopName)})+'</div>'
        +   '</div>'
        + '</div>';

  html += '</div>';

  const cont = document.getElementById('results');
  cont.innerHTML = '<div style="padding:12px 2px;overflow-y:auto;height:100%">' + html + '</div>';
  document.getElementById('stopPanel').style.display = 'none';
  cont.style.display = '';
}

function closeTripDetail() {
  stopBusNotify();
  tripMatch = null;
  renderPlannerResults(currentMatches);
  if (selectedMatch) {
    // Re-highlight active card — match by code(s) depending on direct vs multi-leg.
    [...document.getElementById('results').querySelectorAll('.p-route-card')].find(c => {
      const badges = c.querySelectorAll('.p-route-badge');
      if (selectedMatch.isMultiLeg) {
        return badges.length === 2
            && badges[0].textContent === selectedMatch.leg1.path.displayRouteCode
            && badges[1].textContent === selectedMatch.leg2.path.displayRouteCode;
      }
      return badges[0]?.textContent === selectedMatch.path.displayRouteCode;
    })?.classList.add('active');
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  GUIDED "START TRIP" — step through the trip ONE segment at a time.
//  On start it wipes the planner overview and draws into its OWN layer group.
//  Each step clears that group and draws ONLY the current segment: the walk you
//  are on, OR the board→alight portion of the bus ride — never the whole route
//  or the other walks. So during a walk step there is NO bus line, and during a
//  ride step there are NO walk lines. Nothing else is ever on the map.
// ════════════════════════════════════════════════════════════════════════════



// ── Start / stop ──
function startGuidedTrip(m) {
  m = m || tripMatch;
  if (!m || !originClick || !destClick || !window._map) return;
  if (planOffset) { setHint(t('startTripPlanAhead'), true); return; }
  guided = { active: true, m, steps: buildGuidedSteps(m, { lat: originClick.lat, lng: originClick.lng }, { lat: destClick.lat, lng: destClick.lng }, { walkSpeedMpm: SETTINGS.walkSpeedMpm }), idx: 0, group: L.layerGroup().addTo(window._map), timer: null, wakeLock: null, userPanned: false, fetching: false };

  // CLEAN SLATE: wipe the planner overview (full route line + every walk) so the
  // map shows ONLY base tiles + the live dot + our group. Bump the planner's gen
  // so any in-flight overview walk fetch aborts instead of re-adding a line, and
  // stop the bus-refresh timer. From here, guided draws only the current segment.
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  guidedWipeMap();

  document.body.classList.add('guided-active');
  window._map.invalidateSize();
  if (!_guidedPanHook) {
    _guidedPanHook = true;
    window._map.on('dragstart', () => { if (guided.active) { guided.userPanned = true; document.getElementById('guided-recenter')?.classList.add('show'); } });
  }
  startLiveLocation();
  guidedWakeLock();
  guided.timer = setInterval(guidedTick, 15000);
  guidedEnterStep();
}

function endGuidedTrip(returnToDetail = true) {
  const m = guided.m;
  if (guided.timer) clearInterval(guided.timer);
  try { guided.wakeLock?.release(); } catch {}
  try { guided.group && window._map.removeLayer(guided.group); } catch {}
  guided.active = false; guided.timer = null; guided.wakeLock = null; guided.group = null;
  document.body.classList.remove('guided-active');
  document.getElementById('guided-recenter')?.classList.remove('show');
  const b = document.getElementById('guided-banner'); if (b) b.innerHTML = '';
  if (window._map) {
    window._map.invalidateSize();
    try { originMarker && originMarker.addTo(window._map); } catch {}
    try { destMarker && destMarker.addTo(window._map); } catch {}
  }
  if (returnToDetail && m) {
    // Exit to the trip LIST with a CLEAN map. Do NOT auto-redraw the full trip
    // overview — for a transfer it draws both entire bus lines + three walks,
    // which looked like a mess on End. The user can re-tap a card to see it.
    clearDrawn(); clearBuses(); hideNetworkStops();
    tripMatch = null; selectedMatch = null;
    if (typeof renderPlannerResults === 'function' && currentMatches && currentMatches.length) {
      renderPlannerResults(currentMatches);
    }
  }
}

// ── Step transitions ──
function guidedEnterStep() {
  if (!guided.active) return;
  const step = guided.steps[guided.idx];
  guided.userPanned = false;
  guided._track = null;      // reset adaptive per-stop pace for the new step
  document.getElementById('guided-recenter')?.classList.remove('show');
  drawGuidedStep(step);      // clears the group, draws ONLY this segment
  guidedRenderBanner();
  step._alerted = false;
  if (step.type === 'ARRIVED') { guidedAlert(); return; }
  if (step.type === 'WAIT' || step.type === 'RIDE') guidedTick();
  // Arm auto-advance only if we're NOT already inside this step's arrival zone,
  // so a Back (or Next) into a step we're physically at/past waits for a fresh
  // crossing instead of instantly re-advancing.
  guided._armed = lastUserPos ? !guidedStepMet(step, lastUserPos) : true;
  if (lastUserPos) onGuidedPosition(lastUserPos.lat, lastUserPos.lng);
}
function guidedAdvance() {
  if (!guided.active || guided.idx >= guided.steps.length - 1) return;
  guided.idx++; guidedEnterStep();
}
function guidedBack() {
  if (!guided.active || guided.idx <= 0) return;
  guided.idx--; guidedEnterStep();
}
function onGuidedPosition(lat, lng) {
  if (!guided.active) return;
  const pos = { lat, lng }, step = guided.steps[guided.idx];
  if (!guided.userPanned && window._map) window._map.panTo([lat, lng], { animate: true, duration: 0.6 });
  if (step.type === 'ARRIVED') return;
  // Edge-triggered auto-advance: fire only when the arrival condition NEWLY
  // becomes true after being false during this step (guided._armed). Standing
  // inside the zone on entry — e.g. after pressing Back into a step you're
  // already at/past — must not bounce you straight forward again.
  const met = guidedStepMet(step, pos);
  if (!met) guided._armed = true;
  else if (guided._armed) { guidedAdvance(); return; }
  guidedRenderBanner();   // refresh live ETA as they move
}
async function guidedTick() {
  if (!guided.active || guided.fetching) return;
  const step = guided.steps[guided.idx];
  if (step.type === 'ARRIVED') return;
  if (step.type !== 'WAIT' && step.type !== 'RIDE') { guidedRenderBanner(); return; }  // walk/transfer: refresh ETA only
  guided.fetching = true;
  try {
    const buses = await _fetchLiveBuses(step.path.displayRouteCode, step.path.direction);
    if (!guided.active || step !== guided.steps[guided.idx]) return;
    if (buses && buses.length) {
      step.buses = buses;
      guidedDrawBuses(step);   // refresh live buses on the current segment
      if (step.type === 'WAIT' && buses.some(b => b.stopId === step.boardId) && !step._alerted) { step._alerted = true; guidedAlert(); }
    }
    guidedRenderBanner();
    if (lastUserPos) onGuidedPosition(lastUserPos.lat, lastUserPos.lng);
  } catch {} finally { guided.fetching = false; }
}

// ── Draw ONLY the current segment into guided.group ──
function guidedDrawBuses(step) {
  if (!guided.group) return;
  guided.group.eachLayer(l => { if (l.options && l.options._gbus) guided.group.removeLayer(l); });
  const hex = (step.route && step.route.routeColor || 'f59e0b').replace('#', '').padStart(6, '0');
  for (const b of (step.buses || [])) {
    if (!b.lat || !b.lng) continue;
    guided.group.addLayer(L.marker([parseFloat(b.lat), parseFloat(b.lng)], { icon: mkBusIcon(hex, null, b.plateNumber || b.busLabel || ''), zIndexOffset: 2000, _gbus: true }));
  }
}
// Strip the map down to base tiles + live dot + our (empty) group. Bumps the
// planner's draw-gen so any in-flight overview walk fetch aborts. Run at start
// AND before every step, because the planner overview keeps creeping back onto
// the map (async walk routes, etc.) — re-wiping each step keeps guided clean.
function guidedWipeMap() {
  if (!window._map) return;
  selectPlannerMatch._gen = (selectPlannerMatch._gen || 0) + 1;
  // Collect first, THEN remove — removing during eachLayer skips entries.
  const toWipe = [];
  window._map.eachLayer(l => {
    if (l instanceof L.TileLayer || l === _liveMarker || l === _liveCircle || l === guided.group) return;
    if (guided.group && guided.group.hasLayer && guided.group.hasLayer(l)) return;
    toWipe.push(l);
  });
  toWipe.forEach(l => { try { window._map.removeLayer(l); } catch {} });
  drawnLayers.length = 0; busMarkers.length = 0; hideNetworkStops();
}
function drawGuidedStep(step) {
  if (!guided.group) return;
  guided.group.clearLayers();
  guidedWipeMap();   // remove any overview that crept back since the last step
  const add = l => { guided.group.addLayer(l); return l; };
  const C = s => s ? [parseFloat(s.lat), parseFloat(s.lng)] : null;
  const fit = pts => {
    const valid = pts.filter(Boolean);
    if (!valid.length) return;
    const b = L.latLngBounds(valid);
    if (lastUserPos) b.extend([lastUserPos.lat, lastUserPos.lng]);
    if (b.isValid()) window._map.fitBounds(b, { padding: [55, 55], maxZoom: 16 });
  };
  if (step.type === 'WALK' || step.type === 'TRANSFER') {
    const a = step.from, b = step.to;
    const col = step.type === 'TRANSFER' ? '#f59e0b' : '#2563eb';
    // Straight dashed line first (instant), then swap in the real Valhalla
    // walking route — same road-following geometry the normal trip view uses.
    const line = add(L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { color: col, weight: 5, opacity: .9, dashArray: '8,8' }));
    if (step.toStop) add(L.marker([b.lat, b.lng], { icon: mkStopIcon(col, 14) }).bindTooltip('🚏 ' + esc(step.toStop.stopName), { permanent: true, direction: 'top', offset: [0, -10] }));
    else add(L.marker([b.lat, b.lng], { icon: mkPinIcon('#16a34a') }));
    const applyRoute = coords => {
      if (!coords || coords.length < 2) return;
      if (guided.active && guided.steps[guided.idx] === step && guided.group && guided.group.hasLayer(line)) {
        line.setLatLngs(coords); line.setStyle({ dashArray: null });
        fit(coords);
      }
    };
    if (step.coords) { applyRoute(step.coords); fit([[a.lat, a.lng], [b.lat, b.lng]]); }
    else {
      fit([[a.lat, a.lng], [b.lat, b.lng]]);
      fetchWalkingRoute(a, b).then(rt => { if (rt && rt.coords) { step.coords = rt.coords; applyRoute(rt.coords); } }).catch(() => {});
    }
  } else if (step.type === 'WAIT') {
    const p = C(step.boardStop);
    add(L.marker(p, { icon: mkStopIcon('#2563eb', 15) }).bindTooltip('🚏 ' + esc(step.boardStop.stopName), { permanent: true, direction: 'top', offset: [0, -10] }));
    guidedDrawBuses(step);
    fit([p]);
  } else if (step.type === 'RIDE') {
    const slice = routeSliceCoords(step.path.pointList || [], step.boardStop, step.alightStop);
    if (slice.length > 1) add(L.polyline(slice, { color: '#f59e0b', weight: 6, opacity: .95 }));
    const bp = C(step.boardStop), ap = C(step.alightStop);
    // Intermediate stops along the ride (board → alight), like the planner shows.
    const bi = step.stops.findIndex(s => s.stopId === step.boardId);
    const ai = step.stops.findIndex(s => s.stopId === step.alightId);
    if (bi >= 0 && ai > bi) {
      for (let i = bi + 1; i < ai; i++) {
        const s = step.stops[i];
        add(L.circleMarker([parseFloat(s.lat), parseFloat(s.lng)], { radius: 4, color: '#f59e0b', weight: 2, fillColor: '#0d1520', fillOpacity: 1 })
          .bindTooltip(esc(s.stopName), { direction: 'top' }));
      }
    }
    add(L.marker(bp, { icon: mkStopIcon('#2563eb', 13) }).bindTooltip('🚌 ' + esc(step.boardStop.stopName), { direction: 'top' }));
    add(L.marker(ap, { icon: mkStopIcon('#16a34a', 15) }).bindTooltip('🏁 ' + esc(step.alightStop.stopName), { permanent: true, direction: 'top', offset: [0, -10] }));
    guidedDrawBuses(step);
    fit(slice.length ? slice : [bp, ap]);
  } else if (step.type === 'ARRIVED') {
    if (destClick) { add(L.marker([destClick.lat, destClick.lng], { icon: mkPinIcon('#16a34a') })); window._map.setView([destClick.lat, destClick.lng], 16); }
  }
}

// ── Live, adaptive ETA ──────────────────────────────────────────────────────
// Sorted scheduled departure times for a leg.
function _gSchedTimes(step) {
  return (schedTimesForPath(findSchedEntry(getActiveRoutes(), step.path.displayRouteCode), step.path) || [])
    .slice().sort((a, b) => _tmMin(a) - _tmMin(b));
}
// Minutes to wait for the next scheduled bus at the board stop, given you're
// there at fromMin (clock minutes). Wraps to tomorrow if all buses have gone.
function _gSchedWait(step, fromMin) {
  const times = _gSchedTimes(step);
  if (!times.length) return { mins: 20, time: null };
  const travel = _travelToStopMins(step.stops.find(s => s.stopId === step.boardId) || step.boardStop);
  for (const tm of times) { const bm = _tmMin(tm) + travel; if (bm >= fromMin) return { mins: bm - fromMin, time: tm }; }
  return { mins: _tmMin(times[0]) + travel + 1440 - fromMin, time: times[0] };
}
// Adaptive pace: observed minutes-per-stop (EWMA) plus any "overage" if we've
// been stuck on the current stop longer than expected (bus late / slow leg).
// Tracking is per-step (reset in guidedEnterStep); curIdx is a route index.
function _gPace(curIdx) {
  const base = MINS_PER_STOP, now = Date.now();
  let tr = guided._track;
  if (!tr) { tr = guided._track = { idx: curIdx, t: now, perStop: base }; }
  if (curIdx > tr.idx) {
    const dt = (now - tr.t) / 60000, adv = curIdx - tr.idx;
    const obs = Math.max(base * 0.4, Math.min(base * 4, dt / adv));
    tr.perStop = tr.perStop * 0.5 + obs * 0.5; tr.idx = curIdx; tr.t = now;
  } else if (curIdx < tr.idx) { tr.idx = curIdx; tr.t = now; }   // resync on GPS jitter
  const overage = Math.max(0, (now - tr.t) / 60000 - tr.perStop);
  return { perStop: tr.perStop, overage };
}
// Which board→alight stop index the rider is nearest to right now.
function _gRideIdx(step) {
  const bi = step.stops.findIndex(s => s.stopId === step.boardId);
  const ai = step.stops.findIndex(s => s.stopId === step.alightId);
  let cur = bi;
  if (lastUserPos && bi >= 0 && ai >= bi) {
    let best = Infinity;
    for (let i = bi; i <= ai; i++) { const d = haversine(lastUserPos.lat, lastUserPos.lng, parseFloat(step.stops[i].lat), parseFloat(step.stops[i].lng)); if (d < best) { best = d; cur = i; } }
  }
  return { bi, ai, cur };
}
// Minutes until the bus you can catch reaches the board stop — live if a bus is
// approaching (so a late bus pushes it out), else from the schedule.
function _gWaitMins(step, fromMin) {
  const buses = step.buses || [];
  const seqOf = {}; step.stops.forEach(s => seqOf[s.stopId] = parseInt(s.seq) || 0);
  const boardSeq = seqOf[step.boardId] ?? 0;
  const boardIdx = step.stops.findIndex(s => s.stopId === step.boardId);
  if (buses.some(b => b.stopId === step.boardId)) return { mins: 0, live: true };
  const appr = buses
    .map(b => ({ idx: step.stops.findIndex(s => s.stopId === b.stopId), seq: seqOf[b.stopId] ?? -1 }))
    .filter(x => x.idx >= 0 && x.seq >= 0 && x.seq < boardSeq)
    .sort((a, b) => b.seq - a.seq);   // nearest (highest seq below board) first
  if (appr.length && boardIdx >= 0) {
    const pace = _gPace(appr[0].idx);
    return { mins: (boardIdx - appr[0].idx) * pace.perStop + pace.overage, live: true };
  }
  const sd = _gSchedWait(step, fromMin);
  return { mins: Math.max(0, sd.mins), live: false, time: sd.time };
}
// Total remaining minutes to the destination from the CURRENT step onward.
// Current step uses live buses / GPS pace (grows when the bus is late or a leg
// drags); downstream steps use stored estimates. Recomputed every render/tick.
function guidedETA() {
  if (!guided.active) return null;
  const nowMin = _schedNow();   // service-day frame; arrival clock below folds back via %1440
  let total = 0;
  for (let j = guided.idx; j < guided.steps.length; j++) {
    const s = guided.steps[j], cur = j === guided.idx;
    if (s.type === 'WALK' || s.type === 'TRANSFER') {
      if (cur && lastUserPos && s.to) total += haversine(lastUserPos.lat, lastUserPos.lng, s.to.lat, s.to.lng) / SETTINGS.walkSpeedMpm;
      else total += s.walkMins || 0;
    } else if (s.type === 'WAIT') {
      total += cur ? _gWaitMins(s, nowMin + total).mins : _gSchedWait(s, nowMin + total).mins;
    } else if (s.type === 'RIDE') {
      if (cur) { const r = _gRideIdx(s), pace = _gPace(r.cur); total += Math.max(0, r.ai - r.cur) * pace.perStop + pace.overage; }
      else total += s.rideMins || 0;
    }
  }
  total = Math.max(0, Math.round(total));
  const arr = (nowMin + total) % 1440;
  const time = String(Math.floor(arr / 60)).padStart(2, '0') + ':' + String(Math.round(arr % 60)).padStart(2, '0');
  return { mins: total, time };
}
// HTML for the always-on ETA line in the banner.
function guidedEtaHtml() {
  const e = guidedETA();
  if (!e) return '';
  if (e.mins <= 1) return '<div class="g-eta due"><span class="lbl">' + t('navEtaTitle') + '</span><span class="val">' + t('navEtaNow') + '</span></div>';
  return '<div class="g-eta"><span class="lbl">' + t('navEtaTitle') + '</span><span class="val">' + t('navEtaArrive', { time: e.time, mins: e.mins }) + '</span></div>';
}
// WAIT detail: scheduled departures + buses approaching the board stop.
function guidedWaitDetail(step) {
  let html = '';
  const times = _gSchedTimes(step);
  const chips = _nextTimes(times, 6);   // soonest 6 departures, wrap-aware
  if (chips.length) {
    html += '<div class="trip-section"><div class="trip-section-title">' + t('schedTimes') + ' <span style="font-weight:400;opacity:.6">' + t('schedApprox') + '</span></div><div class="dep-chips">';
    chips.forEach((tm, i) => { html += '<span class="dep-chip' + (i === 0 ? ' next' : '') + '">' + tm + '</span>'; });
    html += '</div></div>';
  }
  const buses = step.buses || [];
  const seqOf = {}; step.stops.forEach(s => seqOf[s.stopId] = parseInt(s.seq) || 0);
  const boardSeq = seqOf[step.boardId] ?? 0;
  const boardIdx = step.stops.findIndex(s => s.stopId === step.boardId);
  const appr = buses
    .map(b => ({ b, idx: step.stops.findIndex(s => s.stopId === b.stopId), seq: seqOf[b.stopId] ?? -1 }))
    .filter(x => x.idx >= 0 && x.seq >= 0 && x.seq <= boardSeq)
    .sort((a, b) => b.seq - a.seq);
  if (appr.length) {
    html += '<div class="trip-section"><div class="trip-section-title">' + t('activeOnRoute') + '</div>';
    appr.forEach(({ b, idx, seq }) => {
      const away = Math.max(0, boardIdx - idx);
      const pace = _gPace(idx);
      const eta = seq === boardSeq ? 0 : Math.round(away * pace.perStop + pace.overage);
      html += '<div class="live-row"><div class="bus-dot dot-orange" style="width:10px;height:10px"></div>'
        + '<div style="flex:1"><b>' + esc(b.plateNumber || b.busLabel || t('activeShort')) + '</b>'
        + '<div style="font-size:.68rem;color:#4a5568">' + (away ? t('stopsLeft', { n: away }) : t('busArrivedExcl')) + '</div></div>'
        + '<span class="live-eta" style="color:#ef4444">' + (eta ? '~' + eta + ' ' + t('min') : t('nowWord')) + '</span></div>';
    });
    html += '</div>';
  }
  return html;
}
// RIDE detail: the board→alight stop list, current stop highlighted.
function guidedRideDetail(step) {
  const { bi, ai, cur } = _gRideIdx(step);
  if (bi < 0 || ai <= bi) return '';
  const busAt = new Set((step.buses || []).map(b => b.stopId));
  let html = '<div class="trip-section"><div class="trip-section-title">' + t('routeStops') + '</div><div class="tl"><div class="tl-line"></div>';
  for (let i = bi; i <= ai; i++) {
    const s = step.stops[i];
    const isBoard = i === bi, isAlight = i === ai, hasBus = busAt.has(s.stopId), isCur = i === cur;
    const dotCls = isBoard ? 'board' : isAlight ? 'alight' : isCur ? 'cur' : hasBus ? 'bus' : '';
    html += '<div class="tl-item' + (isCur ? ' cur' : '') + '"><div class="tl-dot ' + dotCls + '"></div>'
      + '<span class="tl-name">' + esc(s.stopName) + '</span><span class="tl-id">#' + s.stopId + '</span>';
    if (isBoard) html += ' <span class="tl-badge board">' + t('tlBoard') + '</span>';
    if (isAlight) html += ' <span class="tl-badge alight">' + t('tlAlight') + '</span>';
    if (hasBus && !isBoard && !isAlight) html += ' <span class="tl-badge bus">🚌</span>';
    html += '</div>';
  }
  return html + '</div></div>';
}

// ── Banner ──
function guidedWaitText(step) {
  const buses = step.buses || [];
  const seqOf = {}; step.stops.forEach(s => seqOf[s.stopId] = parseInt(s.seq) || 0);
  const boardSeq = seqOf[step.boardId] ?? 0;
  if (buses.some(b => b.stopId === step.boardId)) return t('navBusHere');
  const approaching = buses.filter(b => { const s = seqOf[b.stopId] ?? -1; return s >= 0 && s < boardSeq; })
    .map(b => boardSeq - seqOf[b.stopId]).sort((a, b) => a - b);
  if (approaching.length) return t('navBusApproaching', { n: approaching[0] });
  const times = (schedTimesForPath(findSchedEntry(getActiveRoutes(), step.path.displayRouteCode), step.path) || []).slice().sort((a, b) => _tmMin(a) - _tmMin(b));
  const now = _schedNow();   // service-day frame, matches _tmMin
  const travel = _travelToStopMins(step.stops.find(s => s.stopId === step.boardId) || step.boardStop);
  for (const tm of times) { const bm = _tmMin(tm) + travel; if (bm >= now) return t('navNextDep', { time: tm, mins: Math.max(0, Math.round(bm - now)) }); }
  return t('navNoSchedule');
}
function guidedRideText(step) {
  if (!lastUserPos) return t('navOnBus');
  const bi = step.stops.findIndex(s => s.stopId === step.boardId);
  const ai = step.stops.findIndex(s => s.stopId === step.alightId);
  if (bi < 0 || ai < 0 || ai <= bi) return t('navOnBus');
  let cur = bi, best = Infinity;
  for (let i = bi; i <= ai; i++) { const d = haversine(lastUserPos.lat, lastUserPos.lng, parseFloat(step.stops[i].lat), parseFloat(step.stops[i].lng)); if (d < best) { best = d; cur = i; } }
  const left = Math.max(0, ai - cur);
  if (left <= 1 && !step._alerted) { step._alerted = true; guidedAlert(); }
  return left <= 1 ? t('navGetOffNow') : t('navStopsLeft', { n: left });
}
function guidedRenderBanner() {
  const el = document.getElementById('guided-banner');
  if (!el || !guided.active) return;
  const step = guided.steps[guided.idx];
  let icon = '🧭', primary = '', secondary = '', actionLabel = t('navNext');
  if (step.type === 'WALK') {
    icon = '🚶'; primary = step.toStop ? t('navWalkTo', { stop: esc(step.toStop.stopName) }) : t('navWalkToDest');
    secondary = t('navWalkSecondary', { mins: step.walkMins }); actionLabel = t('navImHere');
  } else if (step.type === 'TRANSFER') {
    icon = '🔁'; primary = step.sameStop ? t('navTransferSame', { stop: esc(step.toStop.stopName) }) : t('navTransferWalk', { stop: esc(step.toStop.stopName) });
    secondary = step.sameStop ? t('navTransferSameSub') : t('navWalkSecondary', { mins: step.walkMins }); actionLabel = t('navImHere');
  } else if (step.type === 'WAIT') {
    icon = '⏱'; primary = t('navWaitAt', { stop: esc(step.boardStop.stopName) }); secondary = guidedWaitText(step); actionLabel = t('navIBoarded');
  } else if (step.type === 'RIDE') {
    icon = '🚌'; primary = t('navRideTo', { stop: esc(step.alightStop.stopName) }); secondary = guidedRideText(step); actionLabel = t('navIGotOff');
  } else if (step.type === 'ARRIVED') {
    icon = '🎉'; primary = t('navArrivedTitle'); secondary = t('navArrivedSub');
  }
  const n = guided.steps.length;
  let dots = '';
  for (let i = 0; i < n; i++) dots += '<span class="g-pdot ' + (i < guided.idx ? 'done' : i === guided.idx ? 'cur' : '') + '"></span>';
  const arrived = step.type === 'ARRIVED';
  const etaLine = arrived ? '' : guidedEtaHtml();
  const detail = step.type === 'WAIT' ? guidedWaitDetail(step) : step.type === 'RIDE' ? guidedRideDetail(step) : '';
  const detailHtml = detail ? '<div class="g-detail">' + detail + '</div>' : '';
  // stopPropagation FIRST so the click can't reach the map even if the handler
  // detaches this button from the DOM (endGuidedTrip clears the banner) — see the
  // map click handler / endGuidedTrip for why Leaflet's flag-walk misses it.
  const backBtn = guided.idx > 0 ? '<button class="g-btn back" onclick="event.stopPropagation();guidedBack()">'+t('navBack')+'</button>' : '';
  const nextBtn = arrived ? '' : '<button class="g-btn primary" onclick="event.stopPropagation();guidedAdvance()">' + actionLabel + '</button>';
  const prevScroll = el.querySelector('.g-detail')?.scrollTop || 0;   // keep list position across live re-renders
  el.innerHTML =
    '<div class="g-top"><span class="g-icon">' + icon + '</span>'
    + '<div class="g-instr"><div class="g-primary">' + primary + '</div><div class="g-secondary">' + secondary + '</div></div></div>'
    + etaLine
    + detailHtml
    + '<div class="g-progress">' + dots + '</div>'
    + '<div class="g-actions">' + backBtn + nextBtn + '<button class="g-btn end" onclick="event.stopPropagation();endGuidedTrip()">' + t('navEnd') + '</button></div>';
  if (prevScroll) { const d = el.querySelector('.g-detail'); if (d) d.scrollTop = prevScroll; }
}

// ── Alerts / wake lock / recenter ──
function guidedAlert() {
  try { if (navigator.vibrate) navigator.vibrate([130, 70, 130]); } catch {}
  const b = document.getElementById('guided-banner');
  if (b) { b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); }
}
async function guidedWakeLock() {
  try { if (navigator.wakeLock) guided.wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (guided.active && document.visibilityState === 'visible' && !guided.wakeLock) guidedWakeLock();
});
function guidedRecenter() {
  guided.userPanned = false;
  document.getElementById('guided-recenter')?.classList.remove('show');
  if (lastUserPos && window._map) window._map.setView([lastUserPos.lat, lastUserPos.lng], Math.max(window._map.getZoom(), 16));
}

// ── Stops feature ─────────────────────────────────────────────────────────────
function openStopOnMap(stopId){const s=allStops.get(stopId);if(!s)return;clearSingleStopMarker();setMode('stops');window._map.setView([s.lat,s.lng],Math.max(window._map.getZoom(),16));showNearbyStops(s.lat,s.lng);}

// Show ONLY the picked stop on the map with a labelled marker — used by the
// Duraklar tab's "Haritada göster" so the user sees just their target stop
// instead of the 5-nearest cluster.
let _singleStopMarker = null;
function clearSingleStopMarker() {
  if (_singleStopMarker && window._map) { window._map.removeLayer(_singleStopMarker); _singleStopMarker = null; }
}
function showSingleStopOnMap(stopId) {
  const s = allStops.get(stopId); if (!s) return;
  if (stopRefreshTimer) clearInterval(stopRefreshTimer);
  openStopId = null;
  setMode('stops');
  window._map.setView([s.lat, s.lng], Math.max(window._map.getZoom(), 17));
  renderNearbyList([{ ...s, meters: 0 }]);
  openStop(stopId);   // places the labelled marker
  stopRefreshTimer = setInterval(() => { if (openStopId) openStop(openStopId, true); }, 30000);
}
function showNearbyStops(lat,lng){
  clearSingleStopMarker();
  if(stopRefreshTimer)clearInterval(stopRefreshTimer);openStopId=null;
  const nearby=[...allStops.values()].map(s=>({...s,meters:Math.round(haversine(lat,lng,s.lat,s.lng))})).sort((a,b)=>a.meters-b.meters).slice(0,5);
  setHint(t('nearbyCount',{name:(nearby[0]?.stopName||'?'),n:nearby.length}));
  renderNearbyList(nearby);if(nearby[0])openStop(nearby[0].stopId);
  stopRefreshTimer=setInterval(()=>{if(openStopId)openStop(openStopId,true);},30000);
}
function renderNearbyList(stops){
  const panel=document.getElementById('stopPanel');panel.innerHTML='<div class="result-header">'+t('nearbyStopsTitle')+'</div>';
  for(const s of stops){
    const routes=stopToRoutes.get(s.stopId)||[];
    const rn=[...new Set(routes.map(r=>r.routeCode))].join(', ')||'—';
    const div=document.createElement('div');div.className='nearby-stop';div.dataset.stopId=s.stopId;
    div.innerHTML='<div class="ns-header"><span class="ns-dist">'+s.meters+'m</span><div><div class="ns-name">'+esc(s.stopName)+' <span style="color:#374151;font-size:.62rem">#'+s.stopId+'</span></div><div class="ns-tags">'+rn+'</div></div></div>'
      +'<div class="ns-body" id="sb-'+s.stopId+'">'
      +  '<div class="ns-actions">'
      +    '<button class="ns-view-btn" onclick="event.stopPropagation();viewStopInDuraklar(\''+s.stopId+'\')">'+t('openInDuraklar')+'</button>'
      +  '</div>'
      +  '<div class="ns-buses"><span class="loading-spin"></span>'+t('loadingShort')+'</div>'
      +'</div>';
    div.onclick=()=>openStop(s.stopId);panel.appendChild(div);
  }
}
function openStop(stopId,silent){
  document.querySelectorAll('.nearby-stop').forEach(el=>el.classList.toggle('open',el.dataset.stopId===stopId));
  openStopId=stopId;
  // Move/refresh the labelled marker so the active stop is always visually
  // distinguished on the map. Same behaviour whether arriving from a map
  // click (showNearbyStops) or a click in the nearby list.
  const s=allStops.get(stopId);
  if(s){
    clearSingleStopMarker();
    _singleStopMarker=L.marker([s.lat,s.lng],{icon:mkStopIcon('#f59e0b',14),zIndexOffset:1500})
      .bindTooltip(s.stopName,{permanent:true,direction:'top',offset:[0,-10]})
      .addTo(window._map);
  }
  if(!silent){const b=document.querySelector('#sb-'+stopId+' .ns-buses');if(b)b.innerHTML='<span class="loading-spin"></span>'+t('loadingShort');}
  fetchStopBuses(stopId);
}
function viewStopInDuraklar(stopId){
  stopDetailId=stopId;
  pushRecentStop(stopId);
  showScreen('stops');
}
async function fetchStopBuses(stopId){
  const entries=stopToRoutes.get(stopId)||[];const seen=new Set();
  const toFetch=entries.filter(e=>{const k=e.routeCode+':'+e.direction;if(seen.has(k))return false;seen.add(k);return true;});
  const responses=await Promise.all(toFetch.map(e=>fetch(API+'web/pathInfo?'+QS+'&displayRouteCode='+encodeURIComponent(e.routeCode)+'&direction='+e.direction).then(r=>r.json()).catch(()=>null)));
  const rows=[];
  for(let i=0;i<toFetch.length;i++){
    const e=toFetch[i],fp=responses[i]?.pathList?.[0];
    const seqOf={};for(const s of(fp?.busStopList||[]))seqOf[s.stopId]=parseInt(s.seq)||0;
    const tSeq=seqOf[stopId]??e.seq,busList=fp?.busList||[];
    const approaching=busList.filter(b=>(seqOf[b.stopId]??-1)>=0&&seqOf[b.stopId]<tSeq).map(b=>({...b,stopsAway:tSeq-seqOf[b.stopId]})).sort((a,b)=>a.stopsAway-b.stopsAway);
    const atStop=busList.filter(b=>b.stopId===stopId);
    rows.push({entry:e,approaching,atStop});
  }
  rows.sort((a,b)=>{const ap=a.atStop.length?0:a.approaching.length?a.approaching[0].stopsAway:999;const bp=b.atStop.length?0:b.approaching.length?b.approaching[0].stopsAway:999;return ap-bp;});
  renderStopBuses(stopId,rows);
}
function renderStopBuses(stopId,rows){
  const body=document.querySelector('#sb-'+stopId+' .ns-buses');if(!body)return;
  if(!rows.length){body.innerHTML='<div class="no-bus">'+t('noLinesFound')+'</div>';return;}
  body.innerHTML=rows.map(({entry:e,approaching,atStop})=>{
    const hex=e.routeColor.replace('#','').padStart(6,'0');
    const badge='<span class="bus-badge" style="background:#'+hex+';color:'+textOnHex(hex)+'">'+e.routeCode+'</span>';
    let dot,away;
    if(atStop.length){dot='dot-blue';away=t('atStopShort');}
    else if(approaching.length){const n=approaching[0].stopsAway;dot=n<=2?'dot-blue':n<=5?'dot-green':n<=10?'dot-yellow':'dot-orange';away=t('stopsLeft',{n});}
    else{dot='dot-grey';const nx=getNextDeparture(e.routeCode);away=nx===undefined?t('noActiveBus'):nx===null?t('noRunsToday'):t('nextShort',{time:nx});}
    const plate=atStop[0]?.plateNumber||approaching[0]?.plateNumber||'';
    return '<div class="bus-row">'+badge+'<div class="bus-info"><div>'+esc(e.headSign)+'</div><div class="bus-dir">'+plate+'</div></div><div class="bus-dot '+dot+'"></div><span class="bus-away">'+away+'</span></div>';
  }).join('');
}

// ── Inline handler bridge ───────────────────────────────────────────────────
// index.html's inline on*= handlers (onclick="setMode('origin')") resolve their
// identifiers against the GLOBAL scope. In a classic <script> every top-level
// declaration was global, so this was free. Module top-level bindings are NOT
// global, so each handler target must be bridged explicitly — a missing name is
// a silent no-op on click, not an error.
//
// Shorthand syntax means a typo here is a load-time ReferenceError, so this block
// cannot half-work. Omissions are caught by test/handlers-test.mjs (CI-enforced),
// which also forbids passing a bare identifier as a handler argument.
Object.assign(window, {
applyAppUpdate, applyCustomTime, clearBookmarksData, clearRecentsData, closeStopDetail,
  closeTrackPanel, closeTripDetail, deleteBookmark, dismissOnboarding, downloadOfflineMap,
  endGuidedTrip, guidedAdvance, guidedBack, guidedRecenter, openCustomTime, openStopDetail,
  removeRecentDest, renderStopsList, requestNearbyOnce, resetOnboarding, resetPlanner,
  resetWalkRadius, resetWalkSpeed, saveLocationBookmark, setLang, setMode, setPlanOffset,
  setTheme, shareStop, showScreen, showStopOnPlanner, startGuidedTrip, swapOD,
  toggleBmDropdown, togglePanelExpand, togglePlanTime, trackRoute, useBookmark, useGPS,
  useRecentDest, viewStopInDuraklar,
});
