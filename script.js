/* ══════════════════════════════════════════════════════════
   CONFIG
══════════════════════════════════════════════════════════ */
const API        = 'https://api.mangadex.org';
const COVER_BASE = 'https://uploads.mangadex.org/covers';
const JIKAN      = 'https://api.jikan.moe/v4';
const PROXIES    = [
  u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  u => `https://corsproxy.org/?${encodeURIComponent(u)}`, // Keeping one of the original corsproxy.org
  u => `https://cors.eu.org/${u}`, // Adding a new proxy found in history, replaces the duplicate corsproxy.org
];
const LIMIT = 24;
const HIST_MAX = 30;

/* ══════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════ */
let workingProxy     = null;
let currentMangaId   = null;
const apiCache       = new Map();
let currentMangaTitle= '';
let currentChapters  = [];
let currentChIdx     = 0;
let currentChapterId = null;
let currentPreloadId = 0;
let browseOffset     = 0;
let browseGenre      = '';
let allTagIds        = {};
let browseObserver   = null;
let pageObserver     = null;
let lazyObserver     = null;
let chapterSortOrder = 'desc'; // 'asc' or 'desc'
let readDir          = 'ltr';
let prevPage         = 'home-page';
const boundChapterLists = new WeakSet();
const mangaStore     = new Map();

/* ══════════════════════════════════════════════════════════
   THEME
══════════════════════════════════════════════════════════ */
function toggleTheme() {
  const html = document.documentElement;
  const newTheme = html.dataset.theme === 'light' ? 'dark' : 'light';
  html.dataset.theme = newTheme;
  localStorage.setItem('mv_theme', newTheme);
  document.getElementById('theme-toggle').textContent = newTheme === 'light' ? '🌙' : '☀️';
}
function applySavedTheme() {
  const savedTheme = localStorage.getItem('mv_theme') || 'dark';
  document.documentElement.dataset.theme = savedTheme;
  document.getElementById('theme-toggle').textContent = savedTheme === 'light' ? '🌙' : '☀️';
}


/* ══════════════════════════════════════════════════════════
   STORAGE — history / read chapters / page progress
══════════════════════════════════════════════════════════ */
function getBookmarks() {
  try { return JSON.parse(localStorage.getItem('mv_bkm') || '[]'); } catch { return []; }
}
function toggleBookmark(id) {
  let b = getBookmarks();
  if (b.includes(id)) b = b.filter(x => x !== id);
  else b.push(id);
  try { localStorage.setItem('mv_bkm', JSON.stringify(b)); } catch {}
  const btn = document.getElementById('bookmark-btn');
  if (btn) btn.textContent = b.includes(id) ? 'Bookmarked ★' : 'Bookmark ☆';
  showToast(b.includes(id) ? 'Added to Bookmarks' : 'Removed from Bookmarks');
}

function getHistory() {
  try { return JSON.parse(localStorage.getItem('mv_hist') || '[]'); } catch { return []; }
}
function saveHistory(entry) {
  let h = getHistory().filter(m => m.id !== entry.id);
  h.unshift({ id:entry.id, title:entry.title, cover:entry.cover||'', ts:Date.now() });
  if (h.length > HIST_MAX) h.length = HIST_MAX;
  try { localStorage.setItem('mv_hist', JSON.stringify(h)); } catch {}
}
function clearHistory() {
  if (!confirm('Clear all reading history?')) return;
  localStorage.removeItem('mv_hist');
  openHistory();
  showToast('History cleared');
}
function getMangaDir(mangaId) {
  return localStorage.getItem('mv_dir_' + mangaId) || localStorage.getItem('mv_dir') || 'ltr';
}
function saveMangaDir(mangaId, dir) {
  try {
    localStorage.setItem('mv_dir_' + mangaId, dir);
    localStorage.setItem('mv_dir', dir);
  } catch {}
}
// FIXED: missing getReadChs function
function getReadChs(mangaId) {
  try { return JSON.parse(localStorage.getItem('mv_read_' + mangaId) || '[]'); } catch { return []; }
}
function markRead(mangaId, chId) {
  const r = getReadChs(mangaId);
  if (!r.includes(chId)) {
    r.push(chId);
    try { localStorage.setItem('mv_read_' + mangaId, JSON.stringify(r)); } catch {}
  }
}
function savePageProg(mangaId, chId, page) {
  try { localStorage.setItem(`mv_pg_${mangaId}_${chId}`, page); } catch {}
}
function getPageProg(mangaId, chId) {
  return parseInt(localStorage.getItem(`mv_pg_${mangaId}_${chId}`) || '0');
}

/* ══════════════════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════════════════ */
function goPage(id, skipHistory = false) {
  const cur = document.querySelector('.page.active');
  if (cur && cur.id === id) return;
  if (cur) prevPage = cur.id;
  
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  ['home','browse','bookmarks','history', 'search'].forEach(k => {
    const el = document.getElementById('nav-' + k);
    if (el) el.classList.toggle('active', id === k + '-page');
  });
  window.scrollTo(0, 0);
  
  if (!skipHistory) {
    history.pushState({ pageId: id }, '', `#${id.replace('-page', '')}`);
  }
}

window.addEventListener('popstate', e => {
  if (e.state && e.state.pageId) goPage(e.state.pageId, true);
  else goPage('home-page', true);
});

function goHome() { goPage('home-page'); }
function goBack() {
  if (history.length > 1 && history.state) history.back();
  else goPage((prevPage === 'reader-page') ? 'detail-page' : (prevPage || 'home-page'));
}
function openBrowse()  { goPage('browse-page'); loadBrowse(); }
async function openBookmarks() {
  goPage('bookmarks-page');
  const bkms = getBookmarks();
  const grid = document.getElementById('bookmarks-grid');
  if (!bkms.length) {
    grid.innerHTML = '<div class="empty-msg">No bookmarks yet. Add some from the manga details page!</div>';
    return;
  }
  grid.innerHTML = '<div class="spinner-wrap"><div class="spinner"></div><span>Loading Bookmarks</span></div>';
  
  const q = bkms.map(id => `ids[]=${encodeURIComponent(id)}`).join('&');
  const data = await apiFetch(`/manga?limit=100&${q}&includes[]=cover_art`);
  if (data?.data) {
    renderGrid('bookmarks-grid', data.data);
  } else {
    showErr('bookmarks-grid', 'Could not load bookmarks.', openBookmarks);
  }
}
function openHistory() {
  goPage('history-page');
  const hist = getHistory();
  const grid = document.getElementById('history-grid');
  if (!hist.length) {
    grid.innerHTML = '<div class="hist-empty"><div class="big">📖</div>No reading history yet.<br>Start reading something!</div>';
    return;
  }
  grid.innerHTML = hist.map(m => {
    const key = sid(m.id);
    mangaStore.set(key, { id:m.id, title:m.title, cover:m.cover, isHistory:true });

    const imgHTML = m.cover
      ? `<img class="mc-img" src="${eh(m.cover)}" alt="${eh(m.title)} cover" loading="lazy"
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/>
         <div class="mc-ph" style="display:none">📖</div>`
      : `<div class="mc-ph">📖</div>`;

    return `<div class="manga-card" onclick="openManga('${key}')">
      <div class="mc-thumb">
        ${imgHTML}
        <span class="hist-badge">READ</span>
      </div>
      <div class="mc-title">${eh(m.title)}</div>
    </div>`;
  }).join('');
}
async function openBrowseGenre(g) {
  goPage('browse-page');
  await loadBrowse(g);
}

/* ══════════════════════════════════════════════════════════
   API — multi-proxy fallback + timeout + Jikan backoff
══════════════════════════════════════════════════════════ */
function tFetch(url, opts={}, ms=8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal:ctrl.signal }).finally(() => clearTimeout(t));
}

async function apiFetch(path) {
  if (apiCache.has(path)) return apiCache.get(path);
  const url = API + path;
  // 1. Direct
  try {
    const r = await tFetch(url, { headers:{ Accept:'application/json' } }, 6000);
    if (r.ok) { setProxy('Direct ✓'); const data = await r.json(); apiCache.set(path, data); return data; }
    if (r.status === 429) showToast('MangaDex is busy — retrying via proxy…');
  } catch {}
  // 2. Cached proxy
  if (workingProxy !== null) {
    try {
      const r = await tFetch(PROXIES[workingProxy](url), {}, 8000);
      if (r.ok) { const data = await r.json(); apiCache.set(path, data); return data; }
    } catch {}
  }
  // 3. Try all proxies
  for (let i = 0; i < PROXIES.length; i++) {
    if (i === workingProxy) continue;
    try {
      const r = await tFetch(PROXIES[i](url), {}, 9000);
      if (r.ok) { workingProxy = i; setProxy('Proxy ' + (i+1) + ' ✓'); const data = await r.json(); apiCache.set(path, data); return data; }
    } catch {}
  }
  return null;
}

async function jikanFetch(url, retries=3) {
  if (apiCache.has(url)) return apiCache.get(url);
  for (let i = 0; i < retries; i++) {
    try {
      const r = await tFetch(url, {}, 8000);
      if (r.status === 429) {
        if (i === 0) showToast('MyAnimeList is busy — retrying…');
        await new Promise(res => setTimeout(res, 1000 * Math.pow(2, i)));
        continue;
      }
      if (r.ok) { const data = await r.json(); apiCache.set(url, data); return data; }
    } catch {}
  }
  return null;
}

function setApiStat(api, ok) {
  const el = document.getElementById('status-' + api);
  if (el) el.className = 'api-dot ' + (ok ? 'ok' : 'fail');
}
function setProxy(t) {
  const el = document.getElementById('status-proxy');
  if (el) el.textContent = t;
}

/* ══════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════ */
function eh(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function sid(id) { return 'mv_' + String(id).replace(/[^a-zA-Z0-9_-]/g,'_'); }

function relDate(str) {
  if (!str) return '';
  const sec = Math.floor((Date.now() - new Date(str)) / 1000);
  if (sec < 3600)    return Math.floor(sec/60)    + 'm ago';
  if (sec < 86400)   return Math.floor(sec/3600)  + 'h ago';
  if (sec < 604800)  return Math.floor(sec/86400) + 'd ago';
  if (sec < 2592000) return Math.floor(sec/604800)+ 'w ago';
  return Math.floor(sec/2592000) + 'mo ago';
}

function normalizeJikan(item) {
  return {
    _source:'mal', id:'mal-'+item.mal_id, mal_id:item.mal_id,
    attributes:{
      title:{ en:item.title, ja:item.title_japanese||item.title },
      status:(item.status||'unknown').toLowerCase()
        .replace('publishing','ongoing').replace('finished','completed'),
      description:{ en:item.synopsis||'' },
      tags:(item.genres||[]).map(g=>({ attributes:{ name:{ en:g.name } } }))
    },
    _cover:item.images?.jpg?.large_image_url||item.images?.jpg?.image_url||null
  };
}

function getTitle(m)  { const t=m.attributes.title; return t.en||t['ja-ro']||t.ja||Object.values(t)[0]||'Unknown'; }
function getCover(m)  {
  if (m._cover) return m._cover;
  const c=(m.relationships||[]).find(r=>r.type==='cover_art');
  return c?.attributes ? `${COVER_BASE}/${m.id}/${c.attributes.fileName}.256.jpg` : null;
}
function getStatus(m) { return m.attributes.status||'unknown'; }
function getTags(m)   { return (m.attributes.tags||[]).map(t=>t.attributes.name.en).filter(Boolean).slice(0,5); }
function getDesc(m)   { const d=m.attributes.description; return d?(d.en||Object.values(d)[0]||''):''; }
function getRating(s) { return s?.rating?.bayesian ? s.rating.bayesian.toFixed(1) : null; }

/* ══════════════════════════════════════════════════════════
   SKELETON LOADERS
══════════════════════════════════════════════════════════ */
function showSkeleton(id, count=12) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = Array.from({length:count}, ()=>`
    <div class="sk-card">
      <div class="skeleton sk-thumb"></div>
      <div class="skeleton sk-line" style="margin-top:4px"></div>
      <div class="skeleton sk-line w6"></div>
    </div>`).join('');
}

/* ══════════════════════════════════════════════════════════
   CARD & GRID
══════════════════════════════════════════════════════════ */
function cardHTML(manga) {
  const title  = getTitle(manga);
  const cover  = getCover(manga);
  const status = getStatus(manga);
  const sc     = status==='ongoing'?'ongoing':status==='completed'?'completed':'';
  const isMAL  = manga._source==='mal';
  const key    = sid(manga.id);
  mangaStore.set(key, { id:manga.id, title, cover, isMAL });

  const img = cover
    ? `<img class="mc-img" src="${eh(cover)}" alt="${eh(title)} cover" loading="lazy"
         onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/>
       <div class="mc-ph" style="display:none">📖</div>`
    : `<div class="mc-ph">📖</div>`;

  return `<div class="manga-card" onclick="openManga('${key}')">
    <div class="mc-thumb">
      ${img}
      <div class="mc-status ${eh(sc)}">${eh(status)}</div>
      <span class="api-badge ${isMAL?'mal':'md'}">${isMAL?'MAL':'MD'}</span>
    </div>
    <div class="mc-title">${eh(title)}</div>
    <div class="mc-meta" id="cst-${eh(manga.id)}"></div>
  </div>`;
}

function renderGrid(id, list, retry) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!list?.length) { el.innerHTML='<div class="empty-msg">No results found.</div>'; return; }
  el.innerHTML = list.map(cardHTML).join('');
  const ids = list.filter(m=>!m._source).map(m=>m.id);
  if (ids.length) loadStats(ids);
}

function showErr(id, msg, retryFn) {
  const el = document.getElementById(id);
  if (!el) return;
  const bid = 'rb_'+id;
  el.innerHTML = `<div class="error-box">${eh(msg)}<br><button class="retry-btn" id="${bid}">Retry</button></div>`;
  if (retryFn) { const b=document.getElementById(bid); if(b) b.onclick=retryFn; }
}

async function loadStats(ids) {
  try {
    const q = ids.map(id=>`manga[]=${encodeURIComponent(id)}`).join('&');
    const r = await tFetch(`${API}/statistics/manga?${q}`, {}, 6000);
    if (!r.ok) return;
    const data = await r.json();
    ids.forEach(id => {
      const el = document.getElementById('cst-'+id);
      if (!el) return;
      const rating = getRating(data.statistics?.[id]);
      if (rating) el.textContent = '★ ' + rating;
    });
  } catch {}
}

/* ══════════════════════════════════════════════════════════
   HOME
══════════════════════════════════════════════════════════ */
function loadHome() {
  showSkeleton('popular-grid'); showSkeleton('recent-grid'); showSkeleton('rated-grid');
  loadPopular(); loadRecent(); loadRated();
}

async function loadPopular() {
  const data = await apiFetch(`/manga?limit=12&order[followedCount]=desc&includes[]=cover_art&availableTranslatedLanguage[]=en&contentRating[]=safe&contentRating[]=suggestive`);
  if (!data?.data) { showErr('popular-grid','Could not load manga. Check your connection.',loadPopular); setApiStat('md',false); return; }
  setApiStat('md',true); renderGrid('popular-grid', data.data);
}
async function loadRecent() {
  const data = await apiFetch(`/manga?limit=12&order[updatedAt]=desc&includes[]=cover_art&availableTranslatedLanguage[]=en&contentRating[]=safe&contentRating[]=suggestive`);
  if (data?.data) renderGrid('recent-grid', data.data);
  else showErr('recent-grid','Could not load recent manga.',loadRecent);
}
async function loadRated() {
  const data = await apiFetch(`/manga?limit=24&order[followedCount]=desc&includes[]=cover_art&availableTranslatedLanguage[]=en&contentRating[]=safe&contentRating[]=suggestive`);
  if (!data?.data) { showErr('rated-grid','Could not load rated manga.',loadRated); return; }
  const ids = data.data.map(m=>m.id);
  const stats = await apiFetch('/statistics/manga?'+ids.map(id=>`manga[]=${encodeURIComponent(id)}`).join('&'));
  if (stats?.statistics) {
    data.data.sort((a,b) => {
      const ra = parseFloat(getRating(stats.statistics[a.id])||0);
      const rb = parseFloat(getRating(stats.statistics[b.id])||0);
      return rb-ra;
    });
  } else {
    // fallback: already sorted by followers
    console.warn('Statistics unavailable, showing by popularity');
  }
  renderGrid('rated-grid', data.data.slice(0,12));
}

/* ══════════════════════════════════════════════════════════
   BROWSE — infinite scroll
══════════════════════════════════════════════════════════ */
const GENRES = ['action','adventure','comedy','drama','fantasy','horror','mystery','romance','sci-fi','slice of life','sports','supernatural','thriller'];
let browseLoading = false;

async function loadBrowse(initialGenre = '') {
  const genre = typeof initialGenre === 'string' ? initialGenre : '';
  if (!Object.keys(allTagIds).length) await fetchTags();
  browseOffset=0; browseGenre=genre;

  // Reset advanced filters when coming from home page tags
  if (genre) {
    const statusEl = document.getElementById('filter-status');
    const demoEl = document.getElementById('filter-demo');
    const ratingEl = document.getElementById('filter-rating');
    if (statusEl) statusEl.value = '';
    if (demoEl) demoEl.value = '';
    if (ratingEl) ratingEl.value = 'safe,suggestive';
  }

  if (genre) {
    document.querySelectorAll('.genre-pill').forEach(p=> {
      p.classList.toggle('active', p.textContent.toLowerCase() === genre.toLowerCase());
    });
  } else {
    document.querySelectorAll('.genre-pill').forEach(p=>p.classList.remove('active'));
    const allPill = document.querySelector('.genre-pill');
    if (allPill) allPill.classList.add('active');
  }

  showSkeleton('browse-grid');
  await loadChunk();
  setupInfiniteScroll();
}

async function fetchTags() {
  const data = await apiFetch('/manga/tag');
  if (!data?.data) return;
  data.data.forEach(t => { const n=t.attributes.name.en; if(n) allTagIds[n.toLowerCase()]=t.id; });
  const bar = document.getElementById('genre-bar');
  if (!bar) return;
  bar.innerHTML = `<div class="genre-pill active" onclick="filterGenre('',this)">All</div>`
    + GENRES.map(g=>`<div class="genre-pill" onclick="filterGenre('${eh(g)}',this)">${eh(g)}</div>`).join('');
}

function filterGenre(genre, el) {
  document.querySelectorAll('.genre-pill').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  browseGenre=genre; browseOffset=0;
  showSkeleton('browse-grid');
  loadChunk();
}

function applyFilters() {
  browseOffset = 0;
  showSkeleton('browse-grid');
  loadChunk();
}

async function loadChunk() {
  if (browseLoading) return;
  browseLoading=true;
  
  const status = document.getElementById('filter-status')?.value;
  const demo = document.getElementById('filter-demo')?.value;
  const rating = document.getElementById('filter-rating')?.value || 'safe,suggestive';
  
  let url = `/manga?limit=${LIMIT}&offset=${browseOffset}&includes[]=cover_art&availableTranslatedLanguage[]=en&order[followedCount]=desc`;
  
  rating.split(',').forEach(r => url += `&contentRating[]=${r}`);
  if (status) url += `&status[]=${status}`;
  if (demo) url += `&publicationDemographic[]=${demo}`;
  
  const lowerGenre = browseGenre.toLowerCase();
  if (browseGenre && allTagIds[lowerGenre]) url += `&includedTags[]=${encodeURIComponent(allTagIds[lowerGenre])}`;
  const data = await apiFetch(url);
  browseLoading=false;
  const grid = document.getElementById('browse-grid');
  if (!grid) return;
  if (!data?.data) {
    if (browseOffset === 0) showErr('browse-grid','Could not load results.',loadBrowse);
    return;
  }
  if (browseOffset === 0) grid.innerHTML = '';
  data.data.forEach(m => grid.insertAdjacentHTML('beforeend', cardHTML(m)));
  const ids=data.data.filter(m=>!m._source).map(m=>m.id);
  if (ids.length) loadStats(ids);
  browseOffset += LIMIT;
  if (data.data.length < LIMIT && browseObserver) browseObserver.disconnect();
}

function setupInfiniteScroll() {
  if (browseObserver) browseObserver.disconnect();
  const sentinel = document.getElementById('browse-sentinel');
  if (!sentinel) return;
  browseObserver = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) loadChunk();
  }, { rootMargin:'300px' });
  browseObserver.observe(sentinel);
}

/* ══════════════════════════════════════════════════════════
   SEARCH
══════════════════════════════════════════════════════════ */
let _searchDebounce = null;
function debounceSearch() {
  clearTimeout(_searchDebounce);
  const q = document.getElementById('search-input').value.trim();
  if (q.length < 2) return;
  _searchDebounce = setTimeout(doSearch, 300);
}
async function doSearch() {
  clearTimeout(_searchDebounce);
  const q = document.getElementById('search-input').value.trim();
  if (!q) return;
  document.getElementById('search-qd').textContent = '"' + q + '"';
  goPage('search-page');
  showSkeleton('search-grid');

  const mdP = apiFetch(`/manga?limit=20&title=${encodeURIComponent(q)}&includes[]=cover_art&availableTranslatedLanguage[]=en&contentRating[]=safe&contentRating[]=suggestive`)
    .then(d=>{ setApiStat('md',!!d); return d?.data||[]; })
    .catch(()=>{ setApiStat('md',false); return []; });

  const malP = jikanFetch(`${JIKAN}/manga?q=${encodeURIComponent(q)}&limit=12&sfw=true`)
    .then(d=>{ setApiStat('mal',!!d); return d?.data?.map(normalizeJikan)||[]; })
    .catch(()=>{ setApiStat('mal',false); return []; });

  let shown = false;
  const display = (md, mal) => {
    const seen=new Set(), merged=[];
    for (const m of [...md,...mal]) {
      const k=getTitle(m).toLowerCase().trim();
      if (!seen.has(k)){seen.add(k);merged.push(m);}
    }
    if (merged.length||!shown){shown=true; renderGrid('search-grid',merged);}
  };

  Promise.race([mdP,malP]).then(first => {
    const isMD = Array.isArray(first)&&first.length&&!first[0]?._source;
    display(isMD?first:[], isMD?[]:first);
  });

  const [md,mal] = await Promise.all([mdP,malP]);
  display(md,mal);
  if (!md.length&&!mal.length)
    document.getElementById('search-grid').innerHTML='<div class="error-box">No results found. Try a different title.</div>';
}

/* ══════════════════════════════════════════════════════════
   DETAIL
══════════════════════════════════════════════════════════ */
async function openManga(key) {
  const entry = mangaStore.get(key);
  if (!entry) return;
  const { id, title, isMAL } = entry;

  if (isMAL || String(id).startsWith('mal-')) {
    goPage('detail-page');
    document.getElementById('detail-content').innerHTML =
      '<div class="spinner-wrap"><div class="spinner"></div><span>Finding on MangaDex</span></div>';
    const md = await apiFetch(`/manga?limit=5&title=${encodeURIComponent(title||id.replace('mal-',''))}&includes[]=cover_art&includes[]=author&includes[]=artist&availableTranslatedLanguage[]=en&contentRating[]=safe&contentRating[]=suggestive`);
    if (md?.data?.length) { showToast('Found on MangaDex!'); return openMangaDex(md.data[0].id); }
    document.getElementById('detail-content').innerHTML = '<div class="error-box">This title is not yet available on MangaDex.</div>';
    return;
  }
  openMangaDex(id);
}

async function openMangaDex(mangaId) {
  currentMangaId = mangaId;
  chapterSortOrder = 'desc';
  readDir = getMangaDir(mangaId);
  goPage('detail-page');
  document.getElementById('detail-content').innerHTML =
    '<div class="spinner-wrap"><div class="spinner"></div><span>Loading</span></div>';

  const [mangaData, chapData] = await Promise.all([
    apiFetch(`/manga/${mangaId}?includes[]=cover_art&includes[]=author&includes[]=artist`),
    apiFetch(`/manga/${mangaId}/feed?translatedLanguage[]=en&order[chapter]=asc&limit=500&contentRating[]=safe&contentRating[]=suggestive&includes[]=scanlation_group`)
  ]);

  if (!mangaData?.data) {
    document.getElementById('detail-content').innerHTML = '<div class="error-box">Could not load manga details.</div>';
    return;
  }

  const manga   = mangaData.data;
  const title   = getTitle(manga);
  const cover   = getCover(manga);
  const status  = getStatus(manga);
  const tags    = getTags(manga);
  const desc    = getDesc(manga);
  const authors = (manga.relationships||[]).filter(r=>r.type==='author').map(r=>r.attributes?.name).filter(Boolean);

  currentMangaTitle = title;
  saveHistory({ id:mangaId, title, cover:cover||'' });

  const seen = new Set();
  const chapters = (chapData?.data||[]).filter(ch => {
    const k = ch.attributes.chapter||ch.id;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  currentChapters = chapters;

  const readChs    = getReadChs(mangaId);
  const firstId    = chapters[0]?.id;

  let continueIdx = -1;
  for (let i = chapters.length-1; i >= 0; i--) {
    if (readChs.includes(chapters[i].id)) { continueIdx = Math.min(i+1, chapters.length-1); break; }
  }

  const bkms = getBookmarks();
  const isBookmarked = bkms.includes(mangaId);
  const bookmarkBtnText = isBookmarked ? 'Bookmarked ★' : 'Bookmark ☆';

  const imgHTML = cover
    ? `<img src="${eh(cover)}" alt="${eh(title)} cover" style="width:100%;display:block;aspect-ratio:2/3;object-fit:cover;"
         onerror="this.parentElement.innerHTML='<div class=\\'detail-cover-ph\\'>📖</div>'"/>`
    : `<div class="detail-cover-ph">📖</div>`;

  document.getElementById('detail-content').innerHTML = `
    <div class="detail-hero">
      <div class="detail-cover">${imgHTML}</div>
      <div class="detail-info">
        <div class="detail-title">${eh(title)}</div>
        <div class="detail-author">${eh(authors.join(', '))}</div>
        <div class="detail-tags">
          <span class="detail-tag ac">${eh(status)}</span>
          ${tags.map(t=>`<span class="detail-tag">${eh(t)}</span>`).join('')}
        </div>
        ${desc?`<div class="detail-desc clamped" id="det-desc">${eh(desc)}</div>
          <button class="show-more" id="det-more" onclick="toggleDesc()">Show more ↓</button>`:''}
        <div class="btn-row">
          ${firstId?`<button class="read-btn" onclick="beginReading()">Start reading</button>`:''}
          ${continueIdx>0&&continueIdx<chapters.length?`<button class="outline-btn" onclick="openReader('${eh(chapters[continueIdx].id)}',${continueIdx})">Continue →</button>`:''}
          <button id="bookmark-btn" class="bookmark-btn" onclick="toggleBookmark('${eh(mangaId)}')">${bookmarkBtnText}</button>
        </div>
      </div>
    </div>
    <div class="ch-list-wrap">
      <div class="ch-list-header">
        <span>Chapters (${chapters.length})</span>
        <div class="ch-list-controls">
          <span class="ch-list-meta" id="ch-read-count">${readChs.length} of ${chapters.length} read</span>
          <button id="ch-sort-btn" class="ch-sort-btn" onclick="toggleChapterSort()">Newest ↓</button>
        </div>
      </div>
      ${chapters.length>5?`<div class="ch-filter"><input id="ch-filter-inp" type="text" placeholder="Jump to chapter…" oninput="filterChapters(this.value)"/></div>`:''}
      <div class="ch-list" id="ch-list">${buildChList(chapters, readChs)}</div>
      <button class="ch-go-top" id="ch-go-top" aria-label="Back to top of chapter list"
        onclick="document.getElementById('ch-list').scrollTo({top:0,behavior:'smooth'})">↑</button>
    </div>`;

  attachChListDelegate();
}

function toggleChapterSort() {
  chapterSortOrder = chapterSortOrder === 'desc' ? 'asc' : 'desc';
  const btn = document.getElementById('ch-sort-btn');
  if (btn) btn.textContent = chapterSortOrder === 'desc' ? 'Newest ↓' : 'Oldest ↑';

  const readChs = getReadChs(currentMangaId);
  const listEl = document.getElementById('ch-list');
  if (listEl) {
    listEl.innerHTML = buildChList(currentChapters, readChs);
    attachChListDelegate();
  }
}

const INITIAL_CH_VISIBLE = 150;

function getDownloads() {
  try { return JSON.parse(localStorage.getItem('mv_dl') || '[]'); } catch { return []; }
}

async function downloadChapter(chId, btn, e) {
  if (e) e.stopPropagation();
  let dl = getDownloads();
  if (dl.includes(chId)) return;
  
  btn.textContent = '⏳';
  btn.disabled = true;
  try {
    const data = await apiFetch(`/at-home/server/${chId}`);
    if (!data?.chapter) throw new Error('No data');
    const urls = data.chapter.data.map(f=>`${data.baseUrl}/data/${data.chapter.hash}/${f}`);
    
    let loaded = 0;
    await Promise.all(urls.map(async u => {
       try { await fetch(u, { mode: 'no-cors' }); } catch {}
       loaded++;
       btn.textContent = `${Math.round((loaded/urls.length)*100)}%`;
    }));
    
    dl.push(chId);
    localStorage.setItem('mv_dl', JSON.stringify(dl));
    
    btn.textContent = '✅';
    btn.classList.add('done');
    btn.disabled = false;
    showToast('Chapter downloaded for offline reading');
  } catch (err) {
    btn.textContent = '❌';
    setTimeout(() => { btn.textContent = '⬇️'; btn.disabled = false; }, 2000);
  }
}

function renderChItem(ch, actualIdx, readChs) {
  const num    = ch.attributes.chapter ? `Chapter ${ch.attributes.chapter}` : 'Oneshot';
  const chTit  = ch.attributes.title ? ` — ${eh(ch.attributes.title)}` : '';
  const group  = (ch.relationships||[]).find(r=>r.type==='scanlation_group');
  const gName  = group?.attributes?.name ? eh(group.attributes.name) : '';
  const date   = relDate(ch.attributes.updatedAt);
  const isRead = readChs.includes(ch.id);
  const safe   = sid(ch.id);
  mangaStore.set('ch_'+safe, { chId:ch.id, idx:actualIdx });
  
  const isDl = getDownloads().includes(ch.id);
  const dlBtn = `<button class="ch-dl-btn ${isDl ? 'done' : ''}" onclick="downloadChapter('${ch.id}', this, event)" title="Download for offline">${isDl ? '✅' : '⬇️'}</button>`;
  
  return `<div class="ch-item" data-ch="${eh(ch.attributes.chapter||'')}" data-tit="${eh(ch.attributes.title||'')}">
    <div>
      <div class="ch-item-title${isRead?' dimmed':''}" id="cht-${safe}">${num}${chTit}</div>
      <div class="ch-item-info">${gName?gName+' · ':''}${date}</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;">
      ${dlBtn}
      <button class="ch-read-btn${isRead?' read':''}" id="chrb-${safe}"
        data-chkey="ch_${safe}" aria-label="${isRead?'Read again':'Read'} ${num}">
        ${isRead?'Read again':'Read'}
      </button>
    </div>
  </div>`;
}

function buildChList(chapters, readChs) {
  if (!chapters.length) return '<div class="empty-msg" style="padding:24px">No English chapters available.</div>';
  const sorted = chapterSortOrder === 'desc' ? [...chapters].reverse() : [...chapters];
  const needsTruncation = sorted.length > INITIAL_CH_VISIBLE;
  const visible = needsTruncation ? sorted.slice(0, INITIAL_CH_VISIBLE) : sorted;

  let html = visible.map(ch => {
    const actualIdx = chapters.indexOf(ch);
    return renderChItem(ch, actualIdx, readChs);
  }).join('');

  if (needsTruncation) {
    const remaining = sorted.length - INITIAL_CH_VISIBLE;
    html += `<div id="ch-show-more-wrap" style="padding:16px 0;text-align:center;">
      <button class="show-more" onclick="expandChList()">Show all ${sorted.length} chapters (${remaining} more) ↓</button>
    </div>`;
    window._fullChaptersForExpand = { chapters, readChs };
  }
  return html;
}

function expandChList() {
  const { chapters, readChs } = window._fullChaptersForExpand || {};
  if (!chapters) return;
  const list = document.getElementById('ch-list');
  if (list) {
    const sorted = chapterSortOrder === 'desc' ? [...chapters].reverse() : [...chapters];
    list.innerHTML = sorted.map(ch => {
      const actualIdx = chapters.indexOf(ch);
      return renderChItem(ch, actualIdx, readChs);
    }).join('');
  }
  delete window._fullChaptersForExpand;
}

function attachChListDelegate() {
  const list = document.getElementById('ch-list');
  if (!list) return;
  if (boundChapterLists.has(list)) return;
  boundChapterLists.add(list);
  list.addEventListener('click', e => {
    const btn = e.target.closest('[data-chkey]');
    if (btn) { e.stopPropagation(); readCh(btn.dataset.chkey, e); return; }
    const item = e.target.closest('.ch-item');
    if (item) {
      const readBtn = item.querySelector('[data-chkey]');
      if (readBtn) readCh(readBtn.dataset.chkey, e);
    }
  });
  list.addEventListener('scroll', () => {
    const topBtn = document.getElementById('ch-go-top');
    if (topBtn) topBtn.classList.toggle('visible', list.scrollTop > 200);
  }, { passive: true });
}

function filterChapters(q) {
  const s = q.toLowerCase().trim();
  document.querySelectorAll('#ch-list .ch-item').forEach(el => {
    const ch  = el.dataset.ch || '';
    const tit = el.dataset.tit || '';
    el.style.display = (!s || ch.includes(s) || tit.toLowerCase().includes(s)) ? '' : 'none';
  });
}

function toggleDesc() {
  const el  = document.getElementById('det-desc');
  const btn = document.getElementById('det-more');
  if (!el||!btn) return;
  btn.textContent = el.classList.toggle('clamped') ? 'Show more ↓' : 'Show less ↑';
}

function beginReading() {
  if (currentChapters.length) openReader(currentChapters[0].id, 0);
}

/* ══════════════════════════════════════════════════════════
   READER
══════════════════════════════════════════════════════════ */
function readCh(chKey, e) {
  if (e) e.stopPropagation();
  const entry = mangaStore.get(chKey);
  if (entry) openReader(entry.chId, entry.idx);
}

function openReader(chapterId, chapterIndex) {
  currentChIdx     = chapterIndex;
  currentChapterId = chapterId;
  markRead(currentMangaId, chapterId);
  updateChBtn(chapterId);
  goPage('reader-page');
  loadChPages(chapterId);
}

function updateChBtn(chId) {
  const safe = sid(chId);
  const btn  = document.getElementById('chrb-'+safe);
  const tit  = document.getElementById('cht-'+safe);
  if (btn) { btn.textContent='Read again'; btn.classList.add('read'); }
  if (tit) tit.classList.add('dimmed');
  const countEl = document.getElementById('ch-read-count');
  if (countEl) {
    const r = getReadChs(currentMangaId);
    countEl.textContent = `${r.length} of ${currentChapters.length} read`;
  }
}

async function loadChPages(chapterId) {
  if (pageObserver) pageObserver.disconnect();
  if (lazyObserver) lazyObserver.disconnect();
  const pagesEl = document.getElementById('reader-pages');
  pagesEl.innerHTML='<div class="spinner-wrap"><div class="spinner"></div><span>Loading pages</span></div>';

  const ch    = currentChapters.find(c=>c.id===chapterId);
  const chNum = ch ? (ch.attributes.chapter ? `Chapter ${ch.attributes.chapter}` : 'Oneshot') : 'Chapter';
  document.getElementById('reader-title').textContent =
    (currentMangaTitle ? currentMangaTitle + ' · ' : '') + chNum;

  document.getElementById('prev-ch-btn').disabled = currentChIdx <= 0;
  document.getElementById('next-ch-btn').disabled = currentChIdx >= currentChapters.length - 1;
  document.getElementById('reader-prog').textContent =
    `${currentChIdx + 1} / ${currentChapters.length}`;

  pagesEl.className = 'reader-pages';
  pagesEl.classList.toggle('rtl', readDir === 'rtl');
  document.getElementById('dir-btn').textContent = readDir.toUpperCase();

  const data = await apiFetch(`/at-home/server/${chapterId}`);
  if (!data?.chapter) {
    pagesEl.innerHTML='<div class="error-box">Could not load pages. This chapter may be unavailable.</div>';
    return;
  }
  const { baseUrl, chapter } = data;
  const pages = chapter.data.map(f=>`${baseUrl}/data/${chapter.hash}/${f}`);
  const saved = getPageProg(currentMangaId, chapterId);

  pagesEl.innerHTML = pages.map((url,i)=>`
    <img class="reader-page-img pending" data-src="${eh(url)}" data-page="${i}"
      alt="Page ${i+1} of ${pages.length}"
      onerror="pageErr(this,'${eh(url)}')"/>`).join('');

  const imgs = pagesEl.querySelectorAll('.reader-page-img');
  lazyObserver = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      const img = e.target;
      if (!img.dataset.src) return;
      img.src = img.dataset.src;
      img.onload  = () => img.classList.remove('pending');
      img.onerror = () => {};
      delete img.dataset.src;
      lazyObserver.unobserve(img);
    });
  }, { rootMargin:'400px' });
  imgs.forEach(img => lazyObserver.observe(img));

  pageObserver = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) savePageProg(currentMangaId, chapterId, +e.target.dataset.page);
    });
  }, { threshold:0.5 });
  imgs.forEach(img => pageObserver.observe(img));

  window.scrollTo(0,0);
  if (saved > 0 && imgs[saved]) setTimeout(() => imgs[saved].scrollIntoView(), 200);

  preloadNext();
}

function pageErr(img, url) {
  const p = img.dataset.page;
  img.outerHTML = `<div class="page-err" ${p !== undefined ? `data-page="${p}"` : ''}>
    Page failed to load
    <button class="page-retry-btn" onclick="retryPage(this,'${eh(url)}')">Retry</button>
  </div>`;
}
function retryPage(btn, url) {
  const wrap = btn.parentElement;
  const p = wrap.dataset.page;
  const img  = document.createElement('img');
  img.className = 'reader-page-img';
  img.alt = 'Page';
  img.src = url;
  if (p !== undefined) img.dataset.page = p;
  img.onerror = () => pageErr(img, url);
  wrap.replaceWith(img);
  if (pageObserver)  pageObserver.observe(img);
}

async function preloadNext() {
  const nextIdx = currentChIdx + 1;
  if (nextIdx >= currentChapters.length) return;
  const pid = ++currentPreloadId;
  try {
    const d = await apiFetch(`/at-home/server/${currentChapters[nextIdx].id}`);
    if (d?.chapter && pid === currentPreloadId) {
      const badge = document.getElementById('preload-badge');
      if (badge) {
        badge.textContent = '⬇ Caching next chapter...';
        badge.style.display = 'block';
      }
      const urls = d.chapter.data.map(f => `${d.baseUrl}/data/${d.chapter.hash}/${f}`);
      for (const url of urls) {
        if (pid !== currentPreloadId) break;
        try { await fetch(url, { mode: 'no-cors' }); } catch {}
      }
      if (badge && pid === currentPreloadId) {
        badge.textContent = '⬇ Next chapter ready';
        setTimeout(() => { badge.style.display = 'none'; }, 3000);
      }
    }
  } catch {}
}

function changeChapter(dir) {
  const idx = currentChIdx + dir;
  if (idx < 0 || idx >= currentChapters.length) {
    showToast(dir > 0 ? 'No next chapter' : 'No previous chapter'); return;
  }
  currentChIdx = idx;
  currentChapterId = currentChapters[idx].id;
  markRead(currentMangaId, currentChapterId);
  updateChBtn(currentChapterId);
  loadChPages(currentChapterId);
}

function closeReader() { goPage('detail-page'); }

function toggleDir() {
  readDir = readDir==='ltr' ? 'rtl' : 'ltr';
  saveMangaDir(currentMangaId, readDir);
  if (currentChapterId) loadChPages(currentChapterId);
}

/* ══════════════════════════════════════════════════════════
   KEYBOARD & TOUCH (with input field detection)
══════════════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  // Ignore if user is typing in an input or textarea
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  const inReader = document.getElementById('reader-page').classList.contains('active');
  if (inReader) {
    if (e.key==='ArrowRight') changeChapter(1);
    else if (e.key==='ArrowLeft') changeChapter(-1);
    else if (e.key==='Escape') closeReader();
  } else if (e.key==='Escape') goBack();
});

let tx0 = 0;
document.addEventListener('touchstart', e => { tx0 = e.touches[0].clientX; }, { passive:true });
document.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - tx0;
  if (Math.abs(dx) < 60) return;
  const inReader = document.getElementById('reader-page').classList.contains('active');
  if (inReader) changeChapter(dx < 0 ? 1 : -1);
}, { passive:true });

window.addEventListener('scroll', () => {
  const topBtn = document.getElementById('main-go-top');
  if (topBtn) {
    topBtn.classList.toggle('visible', window.scrollY > 400 && !document.getElementById('reader-page').classList.contains('active'));
  }
}, { passive: true });

/* ══════════════════════════════════════════════════════════
   TOAST
══════════════════════════════════════════════════════════ */
let toastT;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent=msg; t.style.display='block';
  clearTimeout(toastT);
  toastT = setTimeout(()=>{ t.style.display='none'; }, 2500);
}

/* ══════════════════════════════════════════════════════════
   INIT & PWA
══════════════════════════════════════════════════════════ */
applySavedTheme();
loadHome();

if (!history.state) {
  history.replaceState({ pageId: 'home-page' }, '', '#home');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {/* non-fatal */});
}

(async () => {
  try {
    const r = await tFetch('https://api.mangadex.org/ping', {}, 5000);
    setApiStat('md', r.ok);
    setProxy(r.ok ? 'Direct ✓' : 'Using proxy…');
  } catch { setApiStat('md',false); setProxy('Using proxy…'); }
  try {
    const r = await tFetch(`${JIKAN}/manga?q=naruto&limit=1&sfw=true`, {}, 5000);
    setApiStat('mal', r.ok);
  } catch { setApiStat('mal',false); }
})();