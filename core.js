// Çanakkale Hat & Sefer — headless core.
//
// Zero DOM, zero Leaflet, zero localStorage, zero navigator. Runs unmodified in a
// browser AND in Node, so the app's logic can be used with no webpage at all:
//
//   import { planTrips, findSchedEntry } from 'https://<user>.github.io/bus-manager/core.js';
//
// Rendering lives in ./ui.js. Nothing in this file may reference the page — that
// invariant is enforced by test/core-test.mjs, which imports this under bare node
// (where document/window/localStorage/L simply do not exist).

// Compute today (Europe/Istanbul) — mirror of the CI script's todayInTurkey
export function todayParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = k => parts.find(p => p.type === k).value;
  const y = +get('year'), m = +get('month'), d = +get('day');
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return {
    ymd:  `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`,
    mmdd: `${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`,
    year: y,
    isWeekend: dow === 0 || dow === 6,
  };
}

// Pick today's active schedule id from scheduleData.schedules.
// Same priority as the CI picker: dated special → effective-from → weekday/weekend.
export function pickActiveScheduleId(schedules, today) {
  if (!schedules?.length) return null;
  // 1. Specials whose dates contain today's MM-DD (year-aware).
  const specials = schedules
    .filter(s => s.kind === 'special')
    .filter(s => s.year == null || s.year === today.year)
    .filter(s => Array.isArray(s.dates) && s.dates.includes(today.mmdd))
    .sort((a, b) => {
      const pri = id => /arefe/.test(id) ? 0 : /bayram/.test(id) ? 1 : 2;
      const pa = pri(a.id), pb = pri(b.id);
      if (pa !== pb) return pa - pb;
      return (a.dates.length - b.dates.length); // single > range
    });
  if (specials.length) return specials[0].id;
  // 2. Effective-from override matching today's day-of-week.
  const wantKind = today.isWeekend ? 'effective-weekend' : 'effective-weekday';
  const eff = schedules
    .filter(s => s.kind === wantKind)
    .filter(s => s.year == null || s.year === today.year)
    .filter(s => s.effectiveFrom && s.effectiveFrom <= today.mmdd)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  if (eff.length) return eff[0].id;
  // 3. Regular weekday / weekend
  const reg = schedules.find(s => s.kind === (today.isWeekend ? 'weekend' : 'weekday'));
  return reg?.id || schedules[0].id;
}

// ══════════════════════════════════════════════════════════════
// PLANNER
// ══════════════════════════════════════════════════════════════
export const API    = 'https://service.kentkart.com/rl1/';

// User-configurable preferences. Loaded once at startup; defaults below.
export const SETTINGS_DEFAULTS = { walkRadius: 900, walkSpeedMpm: 72, theme: 'dark' };

export const STR = {
  tr: {
    // ── App / onboarding ──
    appName: 'Çanakkale Hat & Sefer',
    obSub: 'Çanakkale otobüslerini gerçek zamanlı takip edin, rota planlayın ve kalkmadan önce bildirim alın.',
    obSched: '📅 Saatlere<br>Bak',
    obPlan: '🗺 Rota<br>Bul',
    // ── Planner controls ──
    btnOrigin: '📍 Konum', btnDest: '🏁 Hedef', btnPlan: 'Planla',
    swapDir: '⇄ Yön değiştir', swapDirTitle: 'Başlangıç ve hedefi değiştir',
    tNow: 'Şimdi', tPlus30: '+30 dk', tPlus1h: '+1 sa', tCustom: '🕐 Özel',
    waitingMap: 'Harita bekleniyor…',
    // ── Planner results / hints ──
    calcRoutes: 'Rotalar hesaplanıyor…',
    noConnection: 'Bağlantı bulunamadı.',
    noConnectionLong: 'Bu konum ve hedef için hat bulunamadı.',
    resultsDirect: 'Bağlantılı Hatlar',
    resultsTransfer: 'Aktarmalı Hatlar',
    foundN: '{n} hat bulundu. Detay için bir hatta tıklayın.',
    foundNMulti: '{n} seçenek bulundu (aktarmalı dahil).',
    walksTooLong: 'Yürüme mesafeleri ayarınızdan uzun.',
    longWalk: '⚠️ uzun yürüyüş', longWalkTitle: 'Yürüme yarıçapından uzun',
    live: '🔴 canlı', liveTitle: 'Canlı otobüs konumuna göre',
    lastBus: '⚠️ Son sefer', lastBusTitle: 'Bugünün son seferi',
    lastSeferNote: 'Bugünün son seferi',
    oneTransfer: '🔁 1 aktarma',
    min: 'dk',
    metaMulti: '{a} + {b} durak · {ride} dk yolculuk',
    metaDirect: '{n} durak arası',
    transferWalkParen: '({dist} aktarma yürüyüşü)',
    sameStopParen: '(aynı durakta)',
    noActiveBus: 'Aktif araç yok', activeShort: 'aktif',
    taxiTitle: 'Taksi', taxiSub: '{km} km · ~{min} dk',
    tipYou: 'Konumunuz', tipDest: 'Hedefiniz', nearest: '(en yakın)',
    outOfBounds: 'Bu konum Çanakkale sınırlarının dışında. Lütfen haritadan bir nokta seçin.',
    // ── Trip detail ──
    backToLines: '← Hatlar',
    mlTitle: 'Aktarmalı Yolculuk · Tahmini {eta} dk',
    walkStep: '{mins} dk yürüyüş',
    walkToStop: '{dist} · {stop} durağına',
    walkToDest: '{dist} · Hedefe',
    legRide: '{sc} durak · {ride} dk',
    nextDepIn: 'Sıradaki kalkış ~{mins} dk içinde',
    xferWalkText: '{mins} dk · {dist} aktarma yürüyüşü',
    sameStopXfer: 'Aynı durakta aktarma',
    xferTitle: 'Aktarma · {stop}',
    xferDetail: "{xfer} · {code} sıradaki kalkışı {clock} (~{wait} dk bekleme)",
    walkBoardDetail: '{dist} · {mins} dk yürüyüş · Biniş noktası',
    walkAlightDetail: '{dist} · {mins} dk yürüyüş · İniş noktası',
    journeySummary: 'Yolculuk Özeti',
    startTrip: 'Yola Çık', startTripPlanAhead: 'Adım adım yol tarifi yalnızca “şimdi” için. Saati sıfırla.',
    navWalkTo: '{stop} durağına yürü', navWalkToDest: 'Hedefe yürü', navWalkSecondary: 'Yaklaşık {mins} dk yürüyüş',
    navWaitAt: '{stop} durağında bekle', navBusHere: 'Otobüs durakta — bin!', navBusApproaching: 'Otobüs {n} durak ötede',
    navNextDep: '{time} kalkışlı sefer · ~{mins} dk', navNoSchedule: 'Sefer bilgisi yok',
    navRideTo: '{stop} durağına kadar git', navStopsLeft: '{n} durak kaldı', navGetOffNow: 'Sıradaki durakta in!', navOnBus: 'Otobüstesin',
    navTransferWalk: 'Aktarma: {stop} durağına yürü', navTransferSame: 'Aktarma: aynı durakta ({stop}) bekle', navTransferSameSub: 'Yürümene gerek yok',
    navArrivedTitle: 'Vardın! 🎉', navArrivedSub: 'Yolculuk tamamlandı',
    navIBoarded: 'Bindim', navIGotOff: 'İndim', navImHere: 'Geldim', navNext: 'Devam', navBack: 'Geri', navEnd: 'Bitir',
    stepWalk: 'yürüyüş', boardingPoint: 'Biniş noktası', alightPoint: 'İniş noktası',
    waitBusArrived: 'Otobüs durağa geldi', waitLive: 'Canlı konum',
    waitDepart: '{time} kalkışı', waitDepartTomorrow: 'Yarın {time} kalkışı',
    arrivesAt: 'Durağa ~{time}\'de gelir', arrivesAtTomorrow: 'Durağa ~{time}\'de gelir (yarın)',
    schedUnknown: 'Program bilinmiyor', noLive: 'Canlı konum yok',
    nowWord: 'Şimdi',
    rideStep: '{code} ile {sc} durak', ridePath: '{from} → {to}',
    totalEst: 'Toplam tahmini süre',
    navEtaTitle: 'Tahmini varış', navEtaArrive: '~{time} · {mins} dk', navEtaCalc: 'Hesaplanıyor…', navEtaNow: 'Neredeyse vardın',
    incomingBuses: 'Biniş Noktasına Gelen Otobüsler',
    busArrivedExcl: 'Durağa geldi!',
    stopsAwayText: '{n} durak uzakta',
    schedTimes: 'Programlı Seferler', schedApprox: '(yaklaşık)',
    activeOnRoute: 'Güzergahta Aktif Otobüsler', stopsLeft: '{n} durak kaldı',
    routeStops: 'Güzergah Durakları',
    nextRun: 'Sıradaki sefer: {time}',
    busAwayDetail: '{plate} · {n} durak uzakta',
    notifyOn: '🔔 Açık', notifyOff: '🔕 Bildir',
    mlWalk: '{mins} dk · {dist} yürüyüş',
    mlBoard: 'Biniş: {stop}',
    mlLeg1Main: '{wait} dk bekleme + {ride} dk yolculuk',
    mlLegDetail: '{sc} durak · {from} → {to}',
    sameStopShort: ' (aynı durak)',
    mlXferWalk: '{mins} dk yürüme · {dist} · ',
    mlWaitMin: '{wait} dk bekleme',
    mlRideOnly: '{ride} dk yolculuk',
    mlAlight: 'İniş: {stop} → hedef',
    tlBoard: 'Biniş', tlAlight: 'İniş',
    // ── Stops / Duraklar / bars / guide / GPS / tracker / push ──
    stopSearchPh: 'Durak adı ara…',
    savedPlaces: 'Yerlerim', savedPlacesN: 'Yerlerim ({n})',
    favsTitle: 'Favoriler', recentOpenedTitle: 'Son açılanlar', nearbyTitle: 'Yakındaki duraklar',
    nearbyDenied: 'Konum izni verilmedi. Yakındaki durakları göstermek için izin verin.',
    nearbyLoading: 'Yakındaki duraklar yükleniyor…',
    favAdd: 'Favorilere ekle', favRemove: 'Favoriden çıkar',
    guideStartHeadline: 'Başlangıç noktanızı seçin', guideDestHeadline: 'Hedef noktanızı seçin',
    guideDestSub: 'Gitmek istediğiniz yere haritada dokunun<br>ya da ⭐ Yerlerim\'den seçin',
    hintClickStart: 'Haritaya tıklayın → başlangıç seçin.', hintRouteRefresh: 'Rota yenileniyor…',
    planningFor: '{label} için planlanıyor.',
    phMap: '🗺 Haritayı Gör', phLines: '☰ Hatları Göster',
    hintNearbyStops: 'Haritaya tıklayın → yakın durakları görün.',
    geoUnsupported: 'Konum desteği yok.', gettingGPS: 'GPS alınıyor…', gpsFailed: 'Konum alınamadı.',
    pickLocFirst: 'Önce haritada bir konum seçin.', locNamePrompt: 'Konum adı:',
    stopDataFailed: 'Durak verisi yüklenemedi: {err}',
    popupNow: 'Şu an:', popupNext: 'Sıradaki:',
    routeDataLoading: 'Hat verileri yükleniyor…', routeDataFailed: 'Hat verileri yüklenemedi.',
    routeNotFound: '{code} hattı bulunamadı.', dirN: 'Yön {n}', busesLoading: 'Otobüsler yükleniyor…',
    updatedJustNow: 'Güncellendi: az önce · 15s aralıklarla otomatik', noActiveBuses: 'Aktif otobüs bulunamadı.',
    locUnknown: 'Konum bilinmiyor', busWord: 'Otobüs',
    nearbyStopsTitle: 'Yakındaki Duraklar', openInDuraklar: '🚏 Duraklar\'da aç', loadingShort: 'Yükleniyor…',
    noLinesFound: 'Hat bulunamadı.', atStopShort: 'Durağa geldi', noRunsToday: 'Bugün sefer kalmadı', nextShort: 'Sıradaki: {time}',
    nearbyCount: '{name} yakınında {n} durak.',
    clearBookmarksConfirm: 'Tüm kaydedilen yerler silinecek. Devam edilsin mi?', cleared: 'Temizlendi.',
    unitMpm: 'm/dk',
    offlineHintSize: 'Çanakkale bölgesindeki harita karoları cihaza indirilir. İnternet yokken bile bu alanda kaydırma/yakınlaştırma çalışır. ~{count} karo, ~{size} MB.',
    pushWorkerNotSet: 'Worker URL ayarlanmamış. Kurulum talimatlarını takip edin.',
    pushUnsupported: 'Bu tarayıcı Web Push desteklemiyor.',
    pushPermDenied: 'Bildirim izni reddedildi. Tarayıcı ayarlarından izin verin.',
    pushSwNotReady: 'Servis çalışanı hazır değil.',
    pushBrave: 'Brave tarayıcısında masaüstünde Google push servisi varsayılan olarak devre dışıdır.',
    pushNoPerm: 'Tarayıcınız push bildirimlerine izin vermiyor.',
    pushSubFailed: 'Bildirim aboneliği oluşturulamadı.\n\n{reason}',
    pushWorkerConnFail: 'Worker\'a bağlanılamadı: {err}',
    tomorrowParen: ' (yarın)',
    stopDataLoadingShort: 'Durak verisi yükleniyor…', noMatchStop: 'Eşleşen durak yok.', resultsTitle: 'Sonuçlar',
    favHint: 'Bir durağa ★ basarak favorilere ekleyin.',
    shareText: '{name} — Çanakkale Hat & Sefer', linkCopied: 'Bağlantı kopyalandı.', copyLinkPrompt: 'Bağlantıyı kopyalayın:',
    stopNotFound: 'Durak bulunamadı.', noRoutesThisStop: 'Bu duraktan geçen hat bulunamadı.',
    shareStopTitle: 'Durağı paylaş', showOnMapCta: '📍 Haritada göster', routesHere: 'Buradan geçen hatlar',
    statusArrived: '🟢 Durağa geldi ({n})', statusApproaching: '🚌 {n} durak uzaklıkta · {a} aktif', statusActiveFwd: '{n} aktif araç (yön: ileri)',
    guideGps: '🛰&nbsp; GPS Konumumu Kullan', guideOr: 'veya haritaya dokunun',
    clearRecentsConfirm: 'Son hedefler geçmişi silinecek. Devam edilsin mi?',
    onboardingReset: 'Tanıtım sıfırlandı. Bir sonraki açılışta tekrar görünecek.',
    cancelled: 'İptal edildi.', cancelBtn: 'İptal et',
    offlineDone: 'Tamamlandı: {ok} / {total} karo önbelleğe alındı.',
    bmEmpty: 'Henüz kayıtlı yer yok.<br>Haritada bir nokta seçip <b style="color:#c0d0ea">+ Ekle</b>\'ye tıklayın.',
    bmStart: 'Başlangıç', bmDest: 'Hedef', bmDelete: 'Sil', tileErrors: 'hata', retryBtn: 'Tekrar dene',
    distAwayM: '{d} m uzakta', distAwayKm: '{d} km uzakta', routesCount: '{n} hat', noData: 'Veri yok', locWord: 'Konum',
    cardOrigin: 'Konum — En yakın durak', cardDest: 'Hedef — En yakın durak', saveBtn: '☆ Kaydet', saveBtnTitle: 'Kaydet', savedBtn: '★ Kaydedildi',
    searchLoading: 'Durak verisi yükleniyor…',
    // ── Settings ──
    setTitle: 'Ayarlar', setBack: '← Geri',
    setAppearance: 'Görünüm', themeDark: '🌙 Karanlık', themeLight: '☀️ Aydınlık', themeSystem: '📱 Sistem',
    setLangLabel: 'Dil / Language',
    setWalkRadius: 'Maksimum yürüme mesafesi:', setWalkRadiusHint: 'Yürünebilir mesafe sınırı. Daha uzaksa o durak için rota önerilmez.',
    setWalkSpeed: 'Yürüme hızı:', setWalkSpeedHint: 'ETA hesaplaması için kullanılır. Varsayılan 72 m/dk (≈4.3 km/sa).',
    setOffline: 'Çevrimdışı harita', setOfflineBtn: 'Haritayı offline indir',
    setOfflineHint: 'Çanakkale bölgesindeki harita karoları cihaza indirilir. İnternet yokken bile bu alanda kaydırma/yakınlaştırma çalışır.',
    setData: 'Veri', setClearBookmarks: 'Kaydedilen yerleri temizle', setClearRecents: 'Son hedefleri temizle', setReshowOnboarding: 'Tanıtımı tekrar göster',
    setAbout: 'Hakkında', setDevSite: '🌐 Geliştirici sitesi', setGitHub: '💻 GitHub', setContact: '✉️ İletişim — kaan@kaangultekin.net',
    // ── Schedule ──
    schedLoading: 'Seferler yükleniyor…',
    dirOut: 'Gidiş →', dirIn: 'Dönüş →', liveBtn: '🚌 Canlı', canli: 'Canlı',
    schedNoData: 'Veri alınamadı. Sayfayı yenileyin.',
    schedDone: 'Tamamlandı.', schedUpdating: 'Veriler güncelleniyor…',
    schedError: 'Hata: {err}', schedLoadFail: 'Yüklenemedi: {err}', stopsLoaded: '{n} durak',
    schedRemaining: '{n} sefer kaldı', schedNoneLeft: 'Sefer kalmadı', schedTotal: '{n} sefer',
    schedNoneTodayLong: 'Bugün için sefer kalmadı.', schedNoneForDay: 'Bu gün tipi için sefer bulunamadı.',
    navSched: '<span>📅</span>Seferler', navPlanner: '<span>🗺</span>Rota &amp; Harita', navStops: '<span>🚏</span>Duraklar',
  },
  en: {
    appName: 'Çanakkale Hat & Sefer',
    obSub: 'Track Çanakkale buses in real time, plan routes, and get notified before your bus arrives.',
    obSched: '📅 View<br>Schedules',
    obPlan: '🗺 Plan a<br>Route',
    btnOrigin: '📍 From', btnDest: '🏁 To', btnPlan: 'Plan',
    swapDir: '⇄ Swap', swapDirTitle: 'Swap origin and destination',
    tNow: 'Now', tPlus30: '+30 min', tPlus1h: '+1 hr', tCustom: '🕐 Custom',
    waitingMap: 'Waiting for map…',
    calcRoutes: 'Finding routes…',
    noConnection: 'No connection found.',
    noConnectionLong: 'No route found for this origin and destination.',
    resultsDirect: 'Connecting Lines',
    resultsTransfer: 'Lines with Transfer',
    foundN: '{n} lines found. Tap one for details.',
    foundNMulti: '{n} options found (incl. transfers).',
    walksTooLong: 'Walking distances are longer than your setting.',
    longWalk: '⚠️ long walk', longWalkTitle: 'Longer than your walking radius',
    live: '🔴 live', liveTitle: 'Based on live bus position',
    lastBus: '⚠️ Last bus', lastBusTitle: "Today's last departure",
    lastSeferNote: "Today's last departure",
    oneTransfer: '🔁 1 transfer',
    min: 'min',
    metaMulti: '{a} + {b} stops · {ride} min ride',
    metaDirect: '{n} stops',
    transferWalkParen: '({dist} transfer walk)',
    sameStopParen: '(same stop)',
    noActiveBus: 'No active bus', activeShort: 'active',
    taxiTitle: 'Taxi', taxiSub: '{km} km · ~{min} min',
    tipYou: 'Your location', tipDest: 'Your destination', nearest: '(nearest)',
    outOfBounds: 'This location is outside Çanakkale. Please pick a point on the map.',
    // ── Trip detail ──
    backToLines: '← Lines',
    mlTitle: 'Transfer trip · est. {eta} min',
    walkStep: '{mins} min walk',
    walkToStop: '{dist} · to {stop}',
    walkToDest: '{dist} · to destination',
    legRide: '{sc} stops · {ride} min',
    nextDepIn: 'Next departure in ~{mins} min',
    xferWalkText: '{mins} min · {dist} transfer walk',
    sameStopXfer: 'Transfer at the same stop',
    xferTitle: 'Transfer · {stop}',
    xferDetail: '{xfer} · next {code} at {clock} (~{wait} min wait)',
    walkBoardDetail: '{dist} · {mins} min walk · Boarding point',
    walkAlightDetail: '{dist} · {mins} min walk · Drop-off point',
    journeySummary: 'Journey Summary',
    startTrip: 'Start Trip', startTripPlanAhead: 'Step-by-step guidance is for “now” only. Reset the time.',
    navWalkTo: 'Walk to {stop}', navWalkToDest: 'Walk to your destination', navWalkSecondary: 'About {mins} min walk',
    navWaitAt: 'Wait at {stop}', navBusHere: 'Bus is at the stop — board!', navBusApproaching: 'Bus is {n} stops away',
    navNextDep: '{time} departure · ~{mins} min', navNoSchedule: 'No schedule info',
    navRideTo: 'Ride to {stop}', navStopsLeft: '{n} stops left', navGetOffNow: 'Get off at the next stop!', navOnBus: 'On the bus',
    navTransferWalk: 'Transfer: walk to {stop}', navTransferSame: 'Transfer: wait at the same stop ({stop})', navTransferSameSub: 'No walking needed',
    navArrivedTitle: 'Arrived! 🎉', navArrivedSub: 'Trip complete',
    navIBoarded: 'I boarded', navIGotOff: 'I got off', navImHere: 'I\'m here', navNext: 'Next', navBack: 'Back', navEnd: 'End',
    stepWalk: 'walk', boardingPoint: 'Boarding point', alightPoint: 'Drop-off point',
    waitBusArrived: 'Bus has arrived', waitLive: 'Live position',
    waitDepart: '{time} departure', waitDepartTomorrow: 'Tomorrow {time} departure',
    arrivesAt: 'Arrives at stop ~{time}', arrivesAtTomorrow: 'Arrives at stop ~{time} (tomorrow)',
    schedUnknown: 'Schedule unknown', noLive: 'No live position',
    nowWord: 'Now',
    rideStep: '{sc} stops on {code}', ridePath: '{from} → {to}',
    totalEst: 'Total estimated time',
    navEtaTitle: 'Est. arrival', navEtaArrive: '~{time} · {mins} min', navEtaCalc: 'Calculating…', navEtaNow: 'Almost there',
    incomingBuses: 'Buses Approaching the Boarding Stop',
    busArrivedExcl: 'At the stop!',
    stopsAwayText: '{n} stops away',
    schedTimes: 'Scheduled Departures', schedApprox: '(approx.)',
    activeOnRoute: 'Active Buses on the Route', stopsLeft: '{n} stops left',
    routeStops: 'Route Stops',
    nextRun: 'Next run: {time}',
    busAwayDetail: '{plate} · {n} stops away',
    notifyOn: '🔔 On', notifyOff: '🔕 Notify',
    mlWalk: '{mins} min · {dist} walk',
    mlBoard: 'Board: {stop}',
    mlLeg1Main: '{wait} min wait + {ride} min ride',
    mlLegDetail: '{sc} stops · {from} → {to}',
    sameStopShort: ' (same stop)',
    mlXferWalk: '{mins} min walk · {dist} · ',
    mlWaitMin: '{wait} min wait',
    mlRideOnly: '{ride} min ride',
    mlAlight: 'Drop-off: {stop} → destination',
    tlBoard: 'Board', tlAlight: 'Drop-off',
    // ── Stops / Duraklar / bars / guide / GPS / tracker / push ──
    stopSearchPh: 'Search stop name…',
    savedPlaces: 'My Places', savedPlacesN: 'My Places ({n})',
    favsTitle: 'Favorites', recentOpenedTitle: 'Recently opened', nearbyTitle: 'Nearby stops',
    nearbyDenied: 'Location permission denied. Allow it to show nearby stops.',
    nearbyLoading: 'Loading nearby stops…',
    favAdd: 'Add to favorites', favRemove: 'Remove from favorites',
    guideStartHeadline: 'Choose your starting point', guideDestHeadline: 'Choose your destination',
    guideDestSub: 'Tap where you want to go on the map<br>or pick from ⭐ My Places',
    hintClickStart: 'Tap the map → choose start.', hintRouteRefresh: 'Refreshing route…',
    planningFor: 'Planning for {label}.',
    phMap: '🗺 View Map', phLines: '☰ Show Lines',
    hintNearbyStops: 'Tap the map → see nearby stops.',
    geoUnsupported: 'Location not supported.', gettingGPS: 'Getting GPS…', gpsFailed: 'Could not get location.',
    pickLocFirst: 'Pick a location on the map first.', locNamePrompt: 'Location name:',
    stopDataFailed: 'Could not load stop data: {err}',
    popupNow: 'Now:', popupNext: 'Next:',
    routeDataLoading: 'Loading line data…', routeDataFailed: 'Could not load line data.',
    routeNotFound: 'Line {code} not found.', dirN: 'Dir {n}', busesLoading: 'Loading buses…',
    updatedJustNow: 'Updated: just now · auto every 15s', noActiveBuses: 'No active buses found.',
    locUnknown: 'Location unknown', busWord: 'Bus',
    nearbyStopsTitle: 'Nearby Stops', openInDuraklar: '🚏 Open in Stops', loadingShort: 'Loading…',
    noLinesFound: 'No lines found.', atStopShort: 'At the stop', noRunsToday: 'No runs left today', nextShort: 'Next: {time}',
    nearbyCount: '{n} stops near {name}.',
    clearBookmarksConfirm: 'All saved places will be deleted. Continue?', cleared: 'Cleared.',
    unitMpm: 'm/min',
    offlineHintSize: 'Map tiles for the Çanakkale region are downloaded to your device. Panning/zooming works in this area even offline. ~{count} tiles, ~{size} MB.',
    pushWorkerNotSet: 'Worker URL is not configured. Follow the setup instructions.',
    pushUnsupported: 'This browser does not support Web Push.',
    pushPermDenied: 'Notification permission denied. Allow it in your browser settings.',
    pushSwNotReady: 'Service worker not ready.',
    pushBrave: 'On Brave desktop, the Google push service is disabled by default.',
    pushNoPerm: 'Your browser does not allow push notifications.',
    pushSubFailed: 'Could not create notification subscription.\n\n{reason}',
    pushWorkerConnFail: 'Could not connect to the worker: {err}',
    tomorrowParen: ' (tomorrow)',
    stopDataLoadingShort: 'Loading stop data…', noMatchStop: 'No matching stops.', resultsTitle: 'Results',
    favHint: 'Tap ★ on a stop to add it to favorites.',
    shareText: '{name} — Çanakkale Hat & Sefer', linkCopied: 'Link copied.', copyLinkPrompt: 'Copy the link:',
    stopNotFound: 'Stop not found.', noRoutesThisStop: 'No lines serve this stop.',
    shareStopTitle: 'Share stop', showOnMapCta: '📍 Show on map', routesHere: 'Lines serving this stop',
    statusArrived: '🟢 At the stop ({n})', statusApproaching: '🚌 {n} stops away · {a} active', statusActiveFwd: '{n} active buses (direction: forward)',
    guideGps: '🛰&nbsp; Use My GPS Location', guideOr: 'or tap the map',
    clearRecentsConfirm: 'Recent destinations history will be cleared. Continue?',
    onboardingReset: 'Intro reset. It will show again next time you open the app.',
    cancelled: 'Cancelled.', cancelBtn: 'Cancel',
    offlineDone: 'Done: {ok} / {total} tiles cached.',
    bmEmpty: 'No saved places yet.<br>Pick a point on the map and tap <b style="color:#c0d0ea">+ Add</b>.',
    bmStart: 'Start', bmDest: 'Destination', bmDelete: 'Delete', tileErrors: 'errors', retryBtn: 'Try again',
    distAwayM: '{d} m away', distAwayKm: '{d} km away', routesCount: '{n} lines', noData: 'No data', locWord: 'Location',
    cardOrigin: 'From — Nearest stop', cardDest: 'To — Nearest stop', saveBtn: '☆ Save', saveBtnTitle: 'Save', savedBtn: '★ Saved',
    searchLoading: 'Loading stop data…',
    setTitle: 'Settings', setBack: '← Back',
    setAppearance: 'Appearance', themeDark: '🌙 Dark', themeLight: '☀️ Light', themeSystem: '📱 System',
    setLangLabel: 'Language / Dil',
    setWalkRadius: 'Maximum walking distance:', setWalkRadiusHint: 'Walkable distance limit. Stops farther than this are not suggested.',
    setWalkSpeed: 'Walking speed:', setWalkSpeedHint: 'Used for ETA math. Default 72 m/min (≈4.3 km/h).',
    setOffline: 'Offline map', setOfflineBtn: 'Download map offline',
    setOfflineHint: 'Map tiles for the Çanakkale region are downloaded to your device. Panning/zooming works in this area even without internet.',
    setData: 'Data', setClearBookmarks: 'Clear saved places', setClearRecents: 'Clear recent destinations', setReshowOnboarding: 'Show the intro again',
    setAbout: 'About', setDevSite: '🌐 Developer site', setGitHub: '💻 GitHub', setContact: '✉️ Contact — kaan@kaangultekin.net',
    schedLoading: 'Loading schedules…',
    dirOut: 'Outbound →', dirIn: 'Inbound →', liveBtn: '🚌 Live', canli: 'Live',
    schedNoData: 'Could not load data. Refresh the page.',
    schedDone: 'Done.', schedUpdating: 'Updating data…',
    schedError: 'Error: {err}', schedLoadFail: 'Could not load: {err}', stopsLoaded: '{n} stops',
    schedRemaining: '{n} runs left', schedNoneLeft: 'No runs left', schedTotal: '{n} runs',
    schedNoneTodayLong: 'No more runs today.', schedNoneForDay: 'No runs found for this day type.',
    navSched: '<span>📅</span>Schedules', navPlanner: '<span>🗺</span>Route &amp; Map', navStops: '<span>🚏</span>Stops',
  },
};

// ── Taxi estimate ───────────────────────────────────────────────────────────
// Çanakkale taxi tariff: 100 ₺ açılış (opening) + 50 ₺/km, with a 200 ₺
// "kısa mesafe / indi-bindi" minimum fare. (A real home→airport trip billed
// ~400 ₺, which matches: 100 + ~5.7 km × 50 ≈ 385 ₺.) Idle waiting (4 ₺/min)
// isn't part of a point-to-point estimate. Fare = max(minimum, açılış + km×rate).
export const TAXI_TARIFF = {
  openTL:    100,  // taksimetre açılış
  perKmTL:   50,   // kilometre başı
  minimumTL: 200,  // kısa mesafe (indi-bindi) minimum ücret
};

export function _taxiEstimate(distM, durSec) {
  const km = distM / 1000;
  const fare = Math.max(TAXI_TARIFF.minimumTL, TAXI_TARIFF.openTL + km * TAXI_TARIFF.perKmTL);
  return { km, min: Math.round(durSec / 60), tl: Math.round(fare / 5) * 5 }; // fare rounded to nearest 5 ₺
}

// ── Valhalla client + circuit breaker ───────────────────────────────────────
// Every spatial call (walk matrix, walk route, taxi drive route) goes through
// ONE free public host with no SLA. Without memory of failure, a dead/slow host
// costs a full timeout on every call, on every plan, for the whole session. The
// breaker fixes that: after VALHALLA_FAIL_THRESHOLD consecutive failures it
// short-circuits to null (no network) for VALHALLA_COOLDOWN_MS, so callers fall
// straight to their haversine fallback instead of stalling.
export const VALHALLA_HOST = 'https://valhalla1.openstreetmap.de';

export function haversine(la1,lo1,la2,lo2) {
  const R=6371000,r=Math.PI/180,dL=(la2-la1)*r,dO=(lo2-lo1)*r;
  const a=Math.sin(dL/2)**2+Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dO/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// Returns estimated minutes to wait for the next bus at the boarding stop,
// Normalise a route code for schedule lookup: strip leading Ç before a digit.
// This makes "Ç960" match the PDF key "960 KEPEZ..." and vice-versa.
export function schedCodeNorm(c) { return c.toUpperCase().replace(/^Ç(?=\d)/, ''); }

// kentkart marks express variants with a "-E" code suffix (e.g. 11K-E) while
// the PDF distinguishes them only by an "EKSPRES" token in the route name.
// Match on the base code, then disambiguate express vs regular when several
// PDF entries share that code.
export function findSchedEntry(dayData, routeCode) {
  const norm      = schedCodeNorm(routeCode);     // "11K" or "11K-E"
  const isExpress = /-E$/.test(norm);
  const baseNorm  = norm.replace(/-E$/, '');       // "11K"
  const candidates = Object.keys(dayData).filter(k =>
    schedCodeNorm(k.split(' ')[0]) === baseNorm);
  if (!candidates.length) return null;
  if (candidates.length === 1) return dayData[candidates[0]];
  const expressKey = candidates.find(k => /EKSPRES/i.test(k));
  const plainKey   = candidates.find(k => !/EKSPRES/i.test(k));
  return dayData[(isExpress ? expressKey : plainKey) || candidates[0]];
}

// Pick which PDF direction (dir0/dir1) belongs to the user's kentkart path.
// PDF blocks are labelled by their DEPARTURE terminal (the origin you board at —
// the app only adds a decorative "→"). So a path's block is the one whose label
// matches where the path STARTS; the other block's label matches where it ends.
// We score "aligned vs inverted" from BOTH endpoints — symmetric, so the two kk
// directions always agree on orientation (never collapse both onto one block) —
// and fall back to the usual kk dirN ↔ PDF dirN index alignment on a tie.
//   e.g. Ç9: path Otogar→Halkbahçesi starts at OTOGAR ⇒ the "OTOGAR" block.
//        Ç7: path PARK17→Esenler starts at PARK17 ⇒ the "PARK 17 EVLERİ" block.
export function pickSchedDir(schedEntry, path) {
  if (!schedEntry || !path) return null;
  const has = d => schedEntry[d] && (schedEntry[d].times || []).length;
  const def = String(path.direction) === '1' ? 'dir1' : 'dir0';   // usual kk dirN ↔ PDF dirN
  const oth = def === 'dir0' ? 'dir1' : 'dir0';
  const normStr = s => (s || '').toUpperCase().replace(/[^A-ZÇĞIİÖŞÜ0-9]/g, '');
  const names = arr => arr.map(s => normStr(s.stopName)).filter(x => x.length >= 4);
  const stops = path.busStopList || [];
  const O = names(stops.slice(0, 4));  // where this path STARTS (its departure terminal)
  const D = names(stops.slice(-4));    // where this path ENDS
  const m = (dir, list) => {
    const l = normStr(schedEntry[dir]?.label);
    if (l.length < 4) return false;
    return list.some(stop => {
      if (stop.includes(l) || l.includes(stop)) return true;
      for (let i = 0; i + 5 <= l.length; i++) if (stop.includes(l.slice(i, i + 5))) return true;
      return false;
    });
  };
  // Block labelled by departure terminal: this path's block ↔ its ORIGIN, the
  // other ↔ its DESTINATION (= the other path's origin).
  const aligned  = (m(def, O) ? 1 : 0) + (m(oth, D) ? 1 : 0);
  const inverted = (m(oth, O) ? 1 : 0) + (m(def, D) ? 1 : 0);
  const pick = inverted > aligned ? oth : def;
  return has(pick) ? pick : (pick === def ? oth : def);
}

export function schedTimesForPath(schedEntry, path) {
  if (!schedEntry) return [];
  const dir = pickSchedDir(schedEntry, path);
  if (dir) return schedEntry[dir]?.times || [];
  // Fallback: merge both directions if we can't determine the mapping
  return [...(schedEntry.dir0?.times || []), ...(schedEntry.dir1?.times || [])];
}

// ── Trip planner ────────────────────────────────────────────────────────────
// One clean pass. Real PEDESTRIAN walk distances (Valhalla matrix) decide which
// stops are reachable from the origin and to the destination; transfers use
// straight-line distance (they are short by construction, and road-routing a
// short hop like crossing a street is unreliable). Direct and 1-transfer trips
// compete in a single ETA ranking — a transfer must beat a direct by more than
// TRANSFER_PENALTY_MIN to outrank it. Trips whose walks fit walkRadius are shown
// first; only if none do we fall back to long-walk trips (≤3×), flagged.
export const MINS_PER_STOP = 1.5;

export const MAX_WAIT_MIN = 240;            // drop trips whose next bus is >4h out (schedule wrapped)

export const TRANSFER_WALK_MAX_M = 400;     // max straight-line walk for a transfer between two stops

export const TRANSFER_PENALTY_MIN = 10;     // a transfer must save >this vs a direct to rank above it

export const TRANSFER_ETA_TOLERANCE_MIN = 5; // (B) transfers within this of the fastest are "equally fast" — then shortest walk wins

export const TRANSFER_CROSS_ROAD_M = 60;    // (C) a transfer walk ≤ this is a "cross the road" hop, preferred outright

export const WALK_RELAX_MULT = 3;           // long-walk fallback radius = walkRadius × this

export const WALK_DETOUR_FACTOR = 1.35;     // real walk ≈ straight-line × this; applied to haversine fallbacks

export const MAX_NEAR_STOPS = 70;           // cap stops sent to one walk matrix

export const REACH_GRACE_MIN = 3;           // a live bus this many mins "too soon" still counts (people speed up)
export const LIVE_RANK_MAX_FETCH = 12;      // cap on distinct route+dir live fetches per plan

export const GUIDED_ARRIVE_M = 35;          // guided: within this of a stop = "arrived" (walk/alight)

export const GUIDED_BOARDED_M = 70;         // guided: moved this far past the board stop = "you boarded"

export const _tmMin = t => { const [h, m] = t.split(':').map(Number); return (h < 4 ? h*60+1440 : h*60) + m; };

// Raw clock minutes (0..1439) and "now" in the SAME service-day frame as _tmMin
// (early-morning h<4 maps to the tail of the operating day, +1440). Using a raw
// clock "now" against service-day-shifted departures is the bug that makes a
// 02:30 bus look like it's tomorrow at 01:42 — compare in one frame instead.
export const _clockMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// Put any raw minute value into the service-day frame (clock < 04:00 ⇒ tail of
// the operating day, +1440). Use this on the *effective* planning time so it
// also works with planOffset (plan-ahead), which is a raw delta.
export function _schedFrame(rawMin) { const c = ((rawMin % 1440) + 1440) % 1440; return c < 240 ? c + 1440 : c; }

export function _schedNow() { const d = new Date(); return _schedFrame(d.getHours()*60 + d.getMinutes()); }

// Minutes until the next occurrence of HH:MM relative to the raw clock `nowRaw`.
export const _untilClock = (hhmm, nowRaw) => { const d = (_clockMin(hhmm) - nowRaw) % 1440; return d < 0 ? d + 1440 : d; };

// The next n departures, soonest first, regardless of the midnight wrap.
export function _nextTimes(times, n) { const nowRaw = new Date().getHours()*60 + new Date().getMinutes(); return times.slice().sort((a, b) => _untilClock(a, nowRaw) - _untilClock(b, nowRaw)).slice(0, n); }

// Minutes from a trip's terminal departure until the bus reaches a stop, taken
// from kentkart's GTFS arrival_offset (seconds). Falls back to a flat per-stop
// estimate when the offset is missing/zero (some routes ship no offset data).
export function _travelToStopMins(stop) {
  const arr = +(stop && stop.arrival_offset);
  if (arr > 0) return arr / 60;
  const seq = parseInt(stop && stop.seq) || 0;
  return Math.max(0, seq - 1) * MINS_PER_STOP;
}

// Scheduled ride time (minutes) between two stop indices on a path: arrival at
// the alight minus departure from the board, from GTFS offsets (seconds). Falls
// back to flat per-stop when offsets are absent or non-monotonic. Index 0 is the
// terminal, whose offsets are legitimately 0.
export function _rideMins(stops, boardIdx, alightIdx) {
  const bd = stops[boardIdx], al = stops[alightIdx];
  const arr = +(al && al.arrival_offset);
  let dep = +(bd && bd.departure_offset);
  if (!(dep > 0)) dep = +(bd && bd.arrival_offset) || 0;
  if (arr > 0 && arr > dep && (dep > 0 || boardIdx === 0)) return (arr - dep) / 60;
  return Math.max(0, alightIdx - boardIdx) * MINS_PER_STOP;
}

// Next-departure wait at a stop, evaluated from `fromMins`, using a path's
// pre-sorted terminal-departure minutes. `travelToBoardMins` is how long after
// the terminal departure the bus reaches the boarding stop (from GTFS offsets).
// Returns minutes to wait. 20 = schedule unknown but route is live; large =
// wrapped to tomorrow.
export function _waitFromTimes(times, travelToBoardMins, fromMins) {
  if (!times.length) return 20;
  const travel = travelToBoardMins;
  for (const t of times) { const a = t + travel; if (a >= fromMins) return Math.max(0, Math.round(a - fromMins)); }
  return Math.max(0, Math.round(times[0] + travel + 1440 - fromMins)); // first bus tomorrow
}

// True when the next catchable departure is the LAST of the operating day (no
// later same-day departure). `times` are pre-sorted terminal-departure minutes.
export function _isLastSefer(times, travelToBoardMins, fromMins) {
  if (!times.length) return false;
  for (let i = 0; i < times.length; i++)
    if (times[i] + travelToBoardMins >= fromMins) return i === times.length - 1;
  return false; // all gone / wrapped to tomorrow — that trip is already dropped
}

// Wait (minutes, from when you reach the stop) for the soonest LIVE bus that is
// approaching the board stop AND that you can still catch — a bus arriving up to
// REACH_GRACE_MIN before you get there still counts (people hurry). Returns
// Infinity when no live bus is catchable, so callers take min(schedule, live):
// live can only lower a wait, never raise it.
export function _liveBoardWaitMins(stops, boardIdx, buses, nowMins, arriveAtStopMins) {
  if (!buses || !buses.length || boardIdx < 0) return Infinity;
  const idxOf = new Map(stops.map((s, i) => [s.stopId, i]));
  let best = Infinity;
  for (const b of buses) {
    const bi = idxOf.get(b.stopId);
    if (bi == null || bi >= boardIdx) continue;            // not approaching this stop
    const arrival = nowMins + _rideMins(stops, bi, boardIdx);
    if (arrival >= arriveAtStopMins - REACH_GRACE_MIN)     // catchable (with grace)
      best = Math.min(best, arrival);
  }
  return best === Infinity ? Infinity : Math.max(0, best - arriveAtStopMins);
}

// ── Pure helpers (mirrored in tests) ──
// Within `m` metres of a point with .lat/.lng (string or number)?
export function withinM(pos, pt, m) {
  if (!pos || !pt) return false;
  return haversine(pos.lat, pos.lng, parseFloat(pt.lat), parseFloat(pt.lng)) <= m;
}

// Moved past the board stop toward the next stop (boarding auto-detect)?
export function movedPast(pos, boardStop, nextStop, m) {
  if (!pos || !boardStop) return false;
  const dB = haversine(pos.lat, pos.lng, parseFloat(boardStop.lat), parseFloat(boardStop.lng));
  if (dB <= m) return false;
  if (!nextStop) return true;
  const dN = haversine(pos.lat, pos.lng, parseFloat(nextStop.lat), parseFloat(nextStop.lng));
  return dN < dB;
}

// The board→alight PORTION of a route's road shape (not the whole line): slice
// pointList between the points nearest the board and alight stops.
export function routeSliceCoords(pointList, board, alight) {
  if (!pointList || !pointList.length || !board || !alight) return [];
  const near = (lat, lng) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < pointList.length; i++) {
      const d = haversine(lat, lng, parseFloat(pointList[i].lat), parseFloat(pointList[i].lng));
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
  let i1 = near(parseFloat(board.lat), parseFloat(board.lng));
  let i2 = near(parseFloat(alight.lat), parseFloat(alight.lng));
  if (i1 > i2) { const t = i1; i1 = i2; i2 = t; }
  return pointList.slice(i1, i2 + 1).map(p => [parseFloat(p.lat), parseFloat(p.lng)]);
}

// Is the current step's arrival condition satisfied at this position?
export function guidedStepMet(step, pos) {
  if (step.type === 'WALK' || step.type === 'TRANSFER') return withinM(pos, step.to, GUIDED_ARRIVE_M);
  if (step.type === 'WAIT') {
    const bIdx = step.stops.findIndex(s => s.stopId === step.boardId);
    const next = bIdx >= 0 ? step.stops[bIdx + 1] : null;
    return (step.buses || []).some(b => b.stopId === step.boardId) || movedPast(pos, step.boardStop, next, GUIDED_BOARDED_M);
  }
  if (step.type === 'RIDE') return withinM(pos, step.alightStop, GUIDED_ARRIVE_M);
  return false;
}

// ── Dataset ─────────────────────────────────────────────────────────────────
// The parsed schedule.json / stops.json this module reasons over. Populated by
// init() (self-fetch or injection). Module-level rather than per-instance: the
// page holds exactly one dataset, and threading an instance through every call
// site would churn the whole UI for no gain. A Node consumer that needs two
// datasets at once should import the module twice (or call setSchedule between
// reads) — noted here because it is the one thing this shape gives up.
let _schedule  = null;   // schedule.json payload
let _stops     = null;   // stops.json payload
let _pathCache = [];     // stops.json .paths

export const getSchedule  = () => _schedule;
export const getStops     = () => _stops;
export const getPathCache = () => _pathCache;
export const setSchedule  = d => { _schedule = d; };
export const setStops     = d => { _stops = d; };
export const setPathCache = p => { _pathCache = p || []; };

// Where init() self-fetches data from when the caller doesn't inject or override.
// Points at the deployed site so `import(...core.js); await init();` just works.
export const DEFAULT_BASE_URL = 'https://gamehunterkaan.github.io/bus-manager/';

// Load the dataset. Every argument is optional:
//   init()                        → fetch both from DEFAULT_BASE_URL
//   init({ baseUrl })             → fetch both from your own host
//   init({ schedule, stops })     → inject pre-parsed data, zero I/O (ui.js + tests)
// Injection wins per-dataset, so init({ schedule }) still fetches stops.
export async function init({ baseUrl, schedule, stops, fetchImpl, signal } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const base = baseUrl || DEFAULT_BASE_URL;
  const at = p => new URL(p, base).href;

  if (schedule) _schedule = schedule;
  else {
    // Cache-bust like the page does, so a stale CDN copy can't pin the schedule.
    const r = await f(at('data/schedule.json?_=' + Date.now()), { cache: 'no-store', signal });
    if (!r.ok) throw new Error('schedule.json: HTTP ' + r.status);
    _schedule = await r.json();
  }
  if (stops) _stops = stops;
  else {
    const r = await f(at('data/stops.json'), { signal });
    if (!r.ok) throw new Error('stops.json: HTTP ' + r.status);
    _stops = await r.json();
  }
  _pathCache = _stops?.paths || [];
  return { schedule: _schedule, stops: _stops, pathCache: _pathCache };
}

export function getActiveSchedule() {
  if (!_schedule?.schedules?.length) return null;
  const id = pickActiveScheduleId(_schedule.schedules, todayParts());
  return _schedule.schedules.find(s => s.id === id)
      || _schedule.schedules.find(s => s.kind === 'weekday')
      || _schedule.schedules[0];
}

export function getActiveRoutes() { return getActiveSchedule()?.routes || {}; }

// i18n: core owns the dictionary, the caller owns where the language lives
// (ui.js keeps it in localStorage-backed SETTINGS). Returns a t() with the exact
// same (key, vars) signature the ~200 existing call sites already use.
export const createT = getLang => (key, vars) => {
  const dict = STR[getLang()] || STR.tr;
  let s = dict[key];
  if (s == null) s = STR.tr[key];
  if (s == null) return key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
};

export const REGION = '007';

export const QS     = 'region=' + REGION + '&lang=tr&authType=4&resultType=111';

export const WALK_ROUTE_TIMEOUT_MS = 5000;

export const VALHALLA_FAIL_THRESHOLD = 2;       // consecutive failures before tripping

export const VALHALLA_COOLDOWN_MS = 60_000;     // skip the host for this long once tripped

export const _vbreak = { fails: 0, downUntil: 0 };

// Single POST path for every Valhalla endpoint. Returns parsed JSON, or null on
// timeout/failure. While the breaker is tripped it returns null *without touching
// the network*, so a dead/slow host stops costing a timeout on every call.
export async function _valhallaPost(path, body, timeoutMs = WALK_ROUTE_TIMEOUT_MS) {
  if (Date.now() < _vbreak.downUntil) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(VALHALLA_HOST + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw 0;
    _vbreak.fails = 0;                    // success resets the breaker
    return await r.json();
  } catch {
    if (++_vbreak.fails >= VALHALLA_FAIL_THRESHOLD)
      _vbreak.downUntil = Date.now() + VALHALLA_COOLDOWN_MS;
    return null;
  }
}

// accounting for planOffset. Used for ETA-based sorting in findRoutes.
// Compute wait time before boarding a route's bus at `boardSeq`, evaluated
// from an arbitrary `fromMins` (minutes-into-today). Generalised so multi-leg
// trip planning can compute leg-2 wait based on the predicted arrival at the
// transfer stop, not "now."
export function estimateWaitFromMins(routeCode, boardSeq, path, fromMins) {
  const dayData = getActiveRoutes();
  const entry   = findSchedEntry(dayData, routeCode);
  if (!entry) return 999;
  const tm = t => { const [h, mn] = t.split(':').map(Number); return (h < 4 ? h*60+1440 : h*60) + mn; };
  const times = (schedTimesForPath(entry, path) || []).sort((a, b) => tm(a) - tm(b));
  if (!times.length) return 20;
  const travel = Math.max(0, boardSeq - 1) * MINS_PER_STOP;
  for (const t of times) {
    const arr = tm(t) + travel;
    if (arr >= fromMins) return Math.max(0, Math.round(arr - fromMins));
  }
  // All today's buses gone — wrap to first bus tomorrow
  return Math.max(0, Math.round(tm(times[0]) + travel + 1440 - fromMins));
}

// Best-effort live bus positions for one route+direction. Returns the busList or
// [] on any failure/timeout — never throws, so the planner degrades to schedule.
export async function _fetchLiveBuses(code, dir) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(API + 'web/pathInfo?' + QS + '&displayRouteCode=' + encodeURIComponent(code) + '&direction=' + dir, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return [];
    const d = await r.json();
    return d.pathList?.[0]?.busList || [];
  } catch { return []; }
}

// Real walking distance (meters) from one point to a set of stops, via Valhalla
// matrix. Returns Map(stopId → meters). Consults the persistent pair cache first
// and only matrixes the misses; falls back to detour-factored haversine per stop
// when both cache and matrix miss. `reverse` swaps direction (stops → point).
// The persistent walk-distance cache is localStorage-backed, which core must not
// touch — so it arrives as an adapter. ui.js passes its real cache (a genuine perf
// feature: repeat plans skip the Valhalla matrix); Node/tests get NULL_CACHE and
// fall back to matrix + haversine, which is exactly the uncached behaviour.
export const NULL_CACHE = { get: () => null, set: () => {} };

export async function _walkDistances(point, stops, reverse, { cache = NULL_CACHE, matrix = _walkMatrix } = {}) {
  const _walkDistGet = cache.get, _walkDistSet = cache.set;
  const ids = [...stops.keys()];
  if (!ids.length) return new Map();

  // Persistent-cache lookup. Key keeps the matrix's source→target orientation so
  // a cached value equals exactly what the matrix would have returned.
  const out = new Map();
  const missIds = [];
  for (const id of ids) {
    const s = stops.get(id);
    const cached = _walkDistGet(reverse ? [s, point] : [point, s]);
    if (cached != null) out.set(id, cached);
    else missIds.push(id);
  }

  if (missIds.length) {
    const pts = missIds.map(id => { const s = stops.get(id); return { lat: s.lat, lon: s.lng }; });
    const mx = reverse ? await matrix(pts, [{ lat: point.lat, lon: point.lng }])
                       : await matrix([{ lat: point.lat, lon: point.lng }], pts);
    missIds.forEach((id, i) => {
      const s = stops.get(id);
      let m = null;
      if (mx) m = reverse ? (mx[i] && mx[i][0]) : (mx[0] && mx[0][i]);
      if (m != null) _walkDistSet(reverse ? [s, point] : [point, s], m);  // real value → cache
      else m = haversine(point.lat, point.lng, s.lat, s.lng) * WALK_DETOUR_FACTOR; // fallback, not cached
      out.set(id, m);
    });
  }
  return out;
}

// Returns { list, relaxed } or null (after rendering an empty state). `list`
// holds direct + multi-leg trip objects matching the renderer's expected shape.
// Plan every direct + one-transfer trip between two points, ranked by total ETA.
//
//   planTrips(origin, dest, opts) -> { list, relaxed } | null
//
// Return contract: `null` means CANCELLED (a newer plan superseded this one);
// an empty result is `{ list: [], relaxed: false }`. The single-file version
// conflated the two by returning null for both — it could, because it rendered
// the empty state itself. That DOM work now belongs to the caller, so the two
// cases have to be distinguishable.
//
// opts:
//   pathCache   route/stop paths           (default: the dataset from init())
//   dayData     active schedule routes     (default: the dataset from init())
//   settings    { walkRadius, walkSpeedMpm }
//   nowMins     service-day frame minutes  (caller owns "now" — it depends on planOffset)
//   live        consult live buses         (false when planning ahead)
//   walkCache   { get, set } adapter       (localStorage in the page, NULL_CACHE in Node)
//   fetchLive / walkMatrix                 injectable for tests
//   isCancelled () => boolean              preserves the caller's generation semantics
export async function planTrips(origin, dest, {
  pathCache = _pathCache,
  dayData = getActiveRoutes(),
  settings = SETTINGS_DEFAULTS,
  nowMins = _schedNow(),
  live = true,
  walkCache = NULL_CACHE,
  fetchLive = _fetchLiveBuses,
  walkMatrix = _walkMatrix,
  isCancelled = () => false,
} = {}) {
  const O = { lat: origin.lat, lng: origin.lng };
  const D = { lat: dest.lat,   lng: dest.lng };
  const W = settings.walkRadius, MAXW = W * WALK_RELAX_MULT;
  const walkMins = m => m / settings.walkSpeedMpm;

  // Usable paths with pre-sorted schedule times (skip student/ghost routes that
  // have neither a schedule nor live buses).
  const usable = [];
  for (const pe of pathCache) {
    const p = pe.path, st = p.busStopList || [];
    if (!st.length || /^OGR|^ÖĞ/i.test(p.displayRouteCode)) continue;
    const entry = findSchedEntry(dayData, p.displayRouteCode);
    const hasLive = (p.busList || []).some(b => b.lat && b.lng);
    if (!entry && !hasLive) continue;
    usable.push({
      p, route: pe.route, st, code: p.displayRouteCode, buses: p.busList || [],
      times: entry ? (schedTimesForPath(entry, p) || []).map(_tmMin).sort((a,b)=>a-b) : [],
    });
  }

  // Distinct stops within the relaxed radius (haversine) of origin / dest — a
  // superset of everything reachable, since real walk ≥ straight-line. Capped to
  // the nearest MAX_NEAR_STOPS so the matrix stays small.
  const collect = (lat, lng) => {
    const m = new Map();
    for (const u of usable) for (const s of u.st) {
      if (m.has(s.stopId)) continue;
      const dd = haversine(lat, lng, +s.lat, +s.lng);
      if (dd <= MAXW) m.set(s.stopId, { lat: +s.lat, lng: +s.lng, d: dd });
    }
    return new Map([...m.entries()].sort((a,b)=>a[1].d-b[1].d).slice(0, MAX_NEAR_STOPS));
  };
  const originStops = collect(O.lat, O.lng);
  const destStops   = collect(D.lat, D.lng);

  // Real pedestrian walk distances (2 matrix calls, in parallel).
  const [boardWalk, alightWalk] = await Promise.all([
    _walkDistances(O, originStops, false, { cache: walkCache, matrix: walkMatrix }),
    _walkDistances(D, destStops, true, { cache: walkCache, matrix: walkMatrix }),
  ]);
  if (isCancelled()) return null;

  const candidates = [];

  // ── Direct trips ──────────────────────────────────────────────────────────
  // Board the stop NEAREST the origin, then alight at the stop nearest the
  // destination that the bus reaches after it. We do NOT minimise total ETA
  // here: doing so would trade a longer walk for a shorter ride and send you
  // past the closest stop to one farther along the route, which nobody wants —
  // people walk to the nearest stop and accept the extra stops on the bus. If
  // the nearest stop has no reachable alight after it (wrong direction), fall
  // through to the next-nearest board.
  for (const u of usable) {
    const boards = [];
    for (let i = 0; i < u.st.length; i++) {
      const w = boardWalk.get(u.st[i].stopId);
      if (w != null && w <= MAXW) boards.push({ i, w });
    }
    boards.sort((a, b) => a.w - b.w);
    let chosen = null;
    for (const b of boards) {
      let ai = -1, aw = Infinity;
      for (let j = b.i + 1; j < u.st.length; j++) {
        const w = alightWalk.get(u.st[j].stopId);
        if (w != null && w <= MAXW && w < aw) { aw = w; ai = j; }
      }
      if (ai >= 0) { chosen = { bi: b.i, bw: b.w, ai, aw }; break; }
    }
    if (!chosen) continue;
    const boardArr = nowMins + walkMins(chosen.bw);
    const wait = _waitFromTimes(u.times, _travelToStopMins(u.st[chosen.bi]), boardArr);
    if (wait >= MAX_WAIT_MIN) continue;
    const eta = Math.round(walkMins(chosen.bw) + wait + _rideMins(u.st, chosen.bi, chosen.ai) + walkMins(chosen.aw));
    candidates.push({
      isMultiLeg: false, path: u.p, route: u.route, buses: u.buses,
      board: u.st[chosen.bi], alight: u.st[chosen.ai],
      walkB: Math.round(chosen.bw), walkA: Math.round(chosen.aw),
      sc: chosen.ai - chosen.bi, _wait: wait, _eta: eta, _maxWalk: Math.max(chosen.bw, chosen.aw),
      _lastBus: _isLastSefer(u.times, _travelToStopMins(u.st[chosen.bi]), boardArr),
      _bi: chosen.bi, _bw: chosen.bw, // transient: board index + walk metres, for the live pass
    });
  }

  // ── 1-transfer trips ────────────────────────────────────────────────────────
  // Pair every path reaching the origin (A) with every path reaching the dest
  // (B≠A); find a transfer where a stop on A (after boarding) is within
  // TRANSFER_WALK_MAX_M of a stop on B (before alighting). Same stopId = 0 m.
  const originPaths = usable.map(u => ({
    u, boards: u.st.map((s,i)=>({s,i,w:boardWalk.get(s.stopId)})).filter(x => x.w != null && x.w <= MAXW),
  })).filter(x => x.boards.length);
  const destPaths = usable.map(u => ({
    u, alights: u.st.map((s,i)=>({s,i,w:alightWalk.get(s.stopId)})).filter(x => x.w != null && x.w <= MAXW),
  })).filter(x => x.alights.length);

  for (const A of originPaths) {
    const board = A.boards.reduce((a,b)=> b.w < a.w ? b : a); // closest board on A
    const leg1Wait = _waitFromTimes(A.u.times, _travelToStopMins(board.s), nowMins + walkMins(board.w));
    if (leg1Wait >= MAX_WAIT_MIN) continue;
    for (const B of destPaths) {
      if (B.u.code === A.u.code) continue;
      const alight = B.alights.reduce((a,b)=> b.w < a.w ? b : a); // closest alight on B
      // Collect every viable transfer point for this route pair, then choose
      // among them with the B+C rule below.
      const boardToDest = haversine(+board.s.lat, +board.s.lng, D.lat, D.lng);
      const xfers = [];
      for (let xi = board.i + 1; xi < A.u.st.length; xi++) {
        const X = A.u.st[xi];
        // Leg 1 must make progress toward the destination — never ride past it
        // to a far terminal and double back (e.g. home → İskele → faculty).
        if (haversine(+X.lat, +X.lng, D.lat, D.lng) > boardToDest) continue;
        for (let yj = 0; yj < alight.i; yj++) {
          const Y = B.u.st[yj];
          const t = (X.stopId === Y.stopId) ? 0 : haversine(+X.lat, +X.lng, +Y.lat, +Y.lng);
          if (t > TRANSFER_WALK_MAX_M) continue;
          const ride1 = _rideMins(A.u.st, board.i, xi);
          const arriveB2 = nowMins + walkMins(board.w) + leg1Wait + ride1 + walkMins(t);
          const leg2Wait = _waitFromTimes(B.u.times, _travelToStopMins(Y), arriveB2);
          if (leg2Wait >= MAX_WAIT_MIN) continue;
          const ride2 = _rideMins(B.u.st, yj, alight.i);
          const eta = Math.round(walkMins(board.w) + leg1Wait + ride1 + walkMins(t) + leg2Wait + ride2 + walkMins(alight.w));
          xfers.push({ X, xi, Y, yj, t, leg2Wait, ride1, ride2, eta });
        }
      }
      // (B) Among transfers within TRANSFER_ETA_TOLERANCE_MIN of the fastest,
      //     time stops mattering — they're all "equally fast."
      // (C) If any of those is a "cross the road" hop (≤ TRANSFER_CROSS_ROAD_M),
      //     restrict to that tier. Within it, change buses as EARLY as possible
      //     (smallest xi, closest to the origin) — a few metres of walk don't
      //     matter, but transferring sooner (less committed to leg 1) does. This
      //     prefers Beldemiz over a marginally-shorter İl Özel İdare further on.
      //     Otherwise (no cross-road hop) fall back to the shortest walk.
      // Lowest ETA breaks remaining ties.
      let best = null;
      if (xfers.length) {
        const minEta = Math.min(...xfers.map(c => c.eta));
        const pool = xfers.filter(c => c.eta <= minEta + TRANSFER_ETA_TOLERANCE_MIN);
        const crossRoad = pool.filter(c => c.t <= TRANSFER_CROSS_ROAD_M);
        best = crossRoad.length
          ? crossRoad.reduce((a, b) => (b.xi < a.xi || (b.xi === a.xi && b.eta < a.eta)) ? b : a)
          : pool.reduce((a, b) => (b.t < a.t || (b.t === a.t && b.eta < a.eta)) ? b : a);
      }
      if (best) {
      const arriveB2 = nowMins + walkMins(board.w) + leg1Wait + best.ride1 + walkMins(best.t);
      const lastBus = _isLastSefer(A.u.times, _travelToStopMins(board.s), nowMins + walkMins(board.w))
                   || _isLastSefer(B.u.times, _travelToStopMins(best.Y), arriveB2);
      candidates.push({
        isMultiLeg: true, _eta: best.eta, _maxWalk: Math.max(board.w, alight.w), _lastBus: lastBus,
        leg1: {
          path: A.u.p, route: A.u.route, board: board.s, alight: best.X,
          walkB: Math.round(board.w), sc: best.xi - board.i, wait: leg1Wait,
          ride: Math.round(best.ride1), buses: A.u.buses,
          _bi: board.i, _bw: board.w, // transient: board index + walk metres, for the live pass
        },
        leg2: {
          path: B.u.p, route: B.u.route, board: best.Y, alight: alight.s,
          walkA: Math.round(alight.w), sc: alight.i - best.yj, wait: best.leg2Wait,
          ride: Math.round(best.ride2), buses: B.u.buses,
          transferWalkM: Math.round(best.t), transferWalkMins: Math.max(0, Math.round(walkMins(best.t))),
        },
      });
      }
    }
  }

  // Nothing connects these two points. Empty is NOT null — null means cancelled.
  // The caller renders the empty state (it used to be painted from right here).
  if (!candidates.length) return { list: [], relaxed: false };

  // ── Live refinement (b) ──────────────────────────────────────────────────────
  // Fold real-time bus positions into the BOARDING wait: it becomes
  // min(scheduleWait, soonest catchable live bus). Live can only LOWER a wait, so
  // if it's missing / slow / fails — or we're planning ahead — the outcome is the
  // schedule-only result, unchanged. Leg-2 stays schedule (it boards in the
  // future, where current positions don't help). Bounded to the distinct routes
  // of the top candidates so we fire at most LIVE_RANK_MAX_FETCH kentkart calls.
  if (live) {
    const want = new Map(); // "code|dir" → { code, dir }
    for (const c of [...candidates].sort((a, b) => a._eta - b._eta)) {
      const p = c.isMultiLeg ? c.leg1.path : c.path;
      const key = p.displayRouteCode + '|' + p.direction;
      if (!want.has(key)) want.set(key, { code: p.displayRouteCode, dir: p.direction });
      if (want.size >= LIVE_RANK_MAX_FETCH) break;
    }
    const keys = [...want.keys()];
    const lists = await Promise.all(keys.map(k => fetchLive(want.get(k).code, want.get(k).dir)));
    if (isCancelled()) return null;
    const liveMap = new Map(keys.map((k, i) => [k, lists[i]]));
    for (const c of candidates) {
      const leg = c.isMultiLeg ? c.leg1 : c;
      const p = leg.path;
      const buses = liveMap.get(p.displayRouteCode + '|' + p.direction);
      if (!buses || !buses.length) continue;
      leg.buses = buses; // surface live buses on the card (chips / detail) so it isn't "Aktif araç yok"
      const arriveAtStop = nowMins + walkMins(leg._bw);
      const liveWait = _liveBoardWaitMins(p.busStopList || [], leg._bi, buses, nowMins, arriveAtStop);
      const schedWait = c.isMultiLeg ? c.leg1.wait : c._wait;
      if (liveWait < schedWait) {
        // _liveBoardWaitMins is a float (offset seconds ÷ 60); round it like the
        // schedule wait so _eta/_wait stay whole minutes (not "~12.283 min").
        const lw = Math.max(0, Math.round(liveWait));
        c._eta = Math.max(0, c._eta - (schedWait - lw));
        if (c.isMultiLeg) { c.leg1.wait = lw; c.leg1._live = true; }
        else { c._wait = lw; c._live = true; }
      }
    }
  }

  // Redundant-transfer filter: if a single bus already makes the whole trip
  // *comfortably* (a direct whose walks fit walkRadius), drop any transfer that
  // uses that same route as a leg — you'd just ride the direct (leg1 reaches
  // dest) or board it at the origin (leg2 reaches origin) instead of changing.
  // Keyed on the REAL comfy-direct set, so it only fires when the direct is
  // genuinely convenient — a long-walk "direct" (e.g. a 1.7 km hike to the stop)
  // does NOT suppress a transfer that rides you there. This is what keeps the
  // good "ride to Beldemiz, transfer toward home" trips while killing "board ÇT3
  // then change" when ÇT3 already runs straight to the destination.
  const comfyDirectCodes = new Set(
    candidates.filter(c => !c.isMultiLeg && c._maxWalk <= W).map(c => c.path.displayRouteCode)
  );
  const kept = comfyDirectCodes.size
    ? candidates.filter(c => !c.isMultiLeg
        || (!comfyDirectCodes.has(c.leg1.path.displayRouteCode)
         && !comfyDirectCodes.has(c.leg2.path.displayRouteCode)))
    : candidates;

  // Dedupe multi-leg to one (best ETA) per route-pair so the list isn't full of
  // the same A→B with slightly different transfer points.
  const seenPair = new Map();
  const deduped = [];
  for (const c of kept) {
    if (!c.isMultiLeg) { deduped.push(c); continue; }
    const key = c.leg1.path.displayRouteCode + '|' + c.leg2.path.displayRouteCode;
    const prev = seenPair.get(key);
    if (!prev) { seenPair.set(key, c); deduped.push(c); }
    else if (c._eta < prev._eta) { deduped[deduped.indexOf(prev)] = c; seenPair.set(key, c); }
  }

  // Rank: ETA, with the transfer penalty applied to multi-leg ordering only.
  const rank = m => m._eta + (m.isMultiLeg ? TRANSFER_PENALTY_MIN : 0);
  const sorted = deduped.sort((a, b) => rank(a) - rank(b));

  // Prefer trips whose walks all fit walkRadius; only if none do, fall back to
  // long-walk trips (≤ MAXW) and flag them.
  const comfy = sorted.filter(m => m._maxWalk <= W);
  const pool = comfy.length ? comfy : sorted;
  const relaxed = !comfy.length;
  for (const m of pool) m._longWalk = m._maxWalk > W;

  return { list: pool.slice(0, 5), relaxed };
}

// Valhalla one-shot distance matrix: every source→target walking distance in a
// SINGLE request. This is the speed win — instead of dozens of point-to-point
// /route calls (slow, serialized by the browser's 6-connection cap), the whole
// planner needs only ~3 matrix calls. Returns a 2D array of meters (null cell
// on failure), or null if the request fails so callers fall back to haversine.
export async function _walkMatrix(sources, targets) {
  if (!sources.length || !targets.length) return null;
  const d = await _valhallaPost('/sources_to_targets', { sources, targets, costing: 'pedestrian', units: 'kilometers' });
  const mx = d && d.sources_to_targets;
  if (!Array.isArray(mx)) return null;
  return mx.map(row => row.map(c => (c && c.distance != null) ? c.distance * 1000 : null));
}

// ── Build the ordered steps (metadata only — no geometry; the map drawing is
//    the planner's). origin/dest are {lat,lng}. Pure → unit-tested. ──
// walkSpeedMpm is the only impurity here (it lives in ui's localStorage-backed
// SETTINGS), so it's injected and defaulted to the shipped default.
export function buildGuidedSteps(m, origin, dest, { walkSpeedMpm = SETTINGS_DEFAULTS.walkSpeedMpm } = {}) {
  const wMins = meters => Math.max(1, Math.round(meters / walkSpeedMpm));
  const P = s => ({ lat: parseFloat(s.lat), lng: parseFloat(s.lng) });
  const rideOf = (stops, bId, aId) => {
    const bi = stops.findIndex(s => s.stopId === bId), ai = stops.findIndex(s => s.stopId === aId);
    return (bi >= 0 && ai >= 0) ? Math.round(_rideMins(stops, bi, ai)) : 0;
  };
  const legs = m.isMultiLeg ? [m.leg1, m.leg2] : [{ path: m.path, route: m.route, board: m.board, alight: m.alight, walkB: m.walkB, walkA: m.walkA, buses: m.buses, ride: rideOf(m.path.busStopList || [], m.board.stopId, m.alight.stopId) || Math.round((m.sc || 0) * MINS_PER_STOP) }];
  const steps = [];
  steps.push({ type: 'WALK', from: origin, to: P(legs[0].board), toStop: legs[0].board, walkMins: wMins(legs[0].walkB) });
  for (let li = 0; li < legs.length; li++) {
    const L0 = legs[li];
    const stops = L0.path.busStopList || [];
    steps.push({ type: 'WAIT', path: L0.path, route: L0.route, stops, boardId: L0.board.stopId, alightId: L0.alight.stopId, boardStop: L0.board, buses: L0.buses || [] });
    steps.push({ type: 'RIDE', path: L0.path, route: L0.route, stops, boardId: L0.board.stopId, alightId: L0.alight.stopId, boardStop: L0.board, alightStop: L0.alight, rideMins: (L0.ride ?? rideOf(stops, L0.board.stopId, L0.alight.stopId)), buses: L0.buses || [] });
    const nextLeg = legs[li + 1];
    if (nextLeg) steps.push({ type: 'TRANSFER', from: P(L0.alight), to: P(nextLeg.board), fromStop: L0.alight, toStop: nextLeg.board, sameStop: (nextLeg.transferWalkM || 0) === 0, walkMins: nextLeg.transferWalkMins || 0 });
  }
  const lastLeg = legs[legs.length - 1];
  steps.push({ type: 'WALK', from: P(lastLeg.alight), to: dest, fromStop: lastLeg.alight, walkMins: wMins(lastLeg.walkA) });
  steps.push({ type: 'ARRIVED' });
  return steps;
}
