(() => {
  'use strict';

  /* ============================================================
   * Program Magang Karyamas Plantation (Offline-first)
   * - Local storage: IndexedDB (meta + reports)
   * - Sync online: Google Apps Script (JSONP to avoid CORS)
   * ============================================================ */

  // ---------------------------
  // 01) KONFIGURASI & STATE
  // ---------------------------

  // ✅ HARDCODE (dikunci)
  const GAS_URL = "https://script.google.com/macros/s/AKfycbwxN_RsSpwEJ8pRotFQAjxibS0yQdYv-dqaP3RFp7t38JZrV2xH5g-My1eqgmAPZWomlA/exec";
  const SHEET_ID = "1xCSeBJvrvV8jDmVW-EX_oJIxTsWjrO1PgNcZq0cAlMw";

  const APP = {
    name: 'Program Magang KMP',
    dbName: 'magang_kmp_db',
    dbVersion: 1,
    storeMeta: 'meta',
    storeReports: 'reports',
    defaultMeta: {
      // gasUrl & sheetId tidak perlu disimpan lagi, tetap dipertahankan agar backward compatible bila sudah ada meta lama
      profile: { nik: '', menteeName: '', mentorName: '' },
      remember: { estateUnit: '', bidangMagang: '' }
    }
  };

  const State = {
    meta: structuredClone(APP.defaultMeta),
    reports: [],
    deviceId: '',
    editingId: null,
    history: { page: 1, pageSize: 10 }
  };

  // ---------------------------
  // 02) UTILITAS DOM & FORMAT
  // ---------------------------
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
  const escapeHtml = (s) => String(s ?? '')
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
    .replaceAll('"','&quot;').replaceAll("'","&#039;");

  function setPill(msg, kind='info'){
    const el = $('#statusPill');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('ok','no','warn');
    if (kind === 'ok') el.classList.add('ok');
    if (kind === 'no') el.classList.add('no');
    if (kind === 'warn') el.classList.add('warn');
  }

  function todayISO(){
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function formatHariTanggal(isoDate){
    if (!isoDate) return '';
    const d = new Date(isoDate + 'T00:00:00');
    const weekday = new Intl.DateTimeFormat('id-ID', { weekday: 'long' }).format(d);
    const day = d.getDate();
    const month = new Intl.DateTimeFormat('id-ID', { month: 'short' }).format(d);
    const year = d.getFullYear();
    // id-ID month short usually 'Jan', 'Feb', ...
    return `${capitalize(weekday)}, ${day} ${capitalize(month)} ${year}`;
  }

  function capitalize(s){
    s = String(s||'');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function toast(msg, ok=true){
    // lightweight: reuse settingsResult if exists
    const box = $('#settingsResult');
    if (box){
      box.innerHTML = `<div style="font-weight:900;margin-bottom:6px">${ok?'✅':'❌'} ${ok?'OK':'ERROR'}</div><div>${escapeHtml(msg)}</div>`;
    }
    setPill(ok ? 'OK' : 'ERROR', ok ? 'ok' : 'no');
    console[ok ? 'log' : 'warn'](msg);
  }

  function copyToClipboard(text){
    return navigator.clipboard?.writeText(text).catch(() => {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      document.execCommand('copy');
      ta.remove();
    });
  }

  // ---------------------------
  // 03) DEVICE ID
  // ---------------------------
  function getOrCreateDeviceId(){
    const key = 'magang_kmp.device_id';
    let id = localStorage.getItem(key);
    if (!id){
      id = 'DEV-' + Math.random().toString(16).slice(2,10).toUpperCase()
              + '-' + Date.now().toString(36).toUpperCase();
      localStorage.setItem(key, id);
    }
    return id;
  }

  // ---------------------------
  // 04) INDEXEDDB (minimal wrapper)
  // ---------------------------
  let _db = null;

  function idbOpen(){
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(APP.dbName, APP.dbVersion);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(APP.storeMeta)) db.createObjectStore(APP.storeMeta);
        if (!db.objectStoreNames.contains(APP.storeReports)) db.createObjectStore(APP.storeReports, { keyPath:'id' });
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(store, key){
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const os = tx.objectStore(store);
      const req = os.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbPut(store, val, key){
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      const req = (key !== undefined) ? os.put(val, key) : os.put(val);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDel(store, key){
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      const req = os.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGetAll(store){
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const os = tx.objectStore(store);
      const req = os.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function clearAll(){
    const db = await idbOpen();
    await Promise.all([
      new Promise((res, rej) => {
        const tx=db.transaction(APP.storeMeta,'readwrite');
        const req=tx.objectStore(APP.storeMeta).clear();
        req.onsuccess=()=>res(true); req.onerror=()=>rej(req.error);
      }),
      new Promise((res, rej) => {
        const tx=db.transaction(APP.storeReports,'readwrite');
        const req=tx.objectStore(APP.storeReports).clear();
        req.onsuccess=()=>res(true); req.onerror=()=>rej(req.error);
      })
    ]);
  }

  async function clearReportsOnly(){
    const db = await idbOpen();
    await new Promise((res, rej) => {
      const tx = db.transaction(APP.storeReports, 'readwrite');
      const req = tx.objectStore(APP.storeReports).clear();
      req.onsuccess = () => res(true);
      req.onerror = () => rej(req.error);
    });
    State.reports = [];
    State.history.page = 1;
  }

  function exportHistoryXlsx(){
    if (!window.XLSX){
      toast('Library XLSX belum termuat. Pastikan CDN xlsx sudah ditambahkan di index.html.', false);
      return;
    }

    const rows = sortNewestFirst(applyFilters(State.reports));
    if (rows.length === 0){
      toast('Tidak ada data untuk diexport.', false);
      return;
    }

    const data = rows.map(r => ({
      ID: r.id,
      Tanggal: r.tanggal,
      "Estate/Unit": r.estateUnit,
      "Bidang Magang": r.bidangMagang,
      NIK: r.nik,
      Mentee: r.menteeName,
      Mentor: r.mentorName,
      "Kegiatan Inti": r.kegiatanInti,
      "Proses & Metode": r.prosesMetode,
      "Hasil/Capaian": r.hasilCapaian,
      "Hambatan & Solusi": r.hambatanSolusi,
      "Pelajaran Baru": r.pelajaranBaru,
      "Rencana Besok": r.rencanaBesok,
      Synced: r.synced ? 'YES' : 'NO',
      "Timestamp Laporan": r.timestamp,
      "Synced At": r.syncedAt || ''
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Magang');

    const fname = `Magang_KMP_${todayISO()}.xlsx`;
    XLSX.writeFile(wb, fname);
    toast(`Export berhasil: ${fname}`, true);
  }

  // ---------------------------
// 05) API JSONP (anti-CORS)
// ---------------------------
  function apiJsonp(payload){
    const baseUrl = String(GAS_URL || '').trim();
    if (!baseUrl) return Promise.reject(new Error('GAS URL belum dikonfigurasi.'));

    // Fallback domain (sering lebih "aman" di mobile / anti-tracking)
    const candidates = [
      baseUrl,
      baseUrl.replace('https://script.google.com', 'https://script.googleusercontent.com'),
      baseUrl.replace('http://script.google.com', 'https://script.googleusercontent.com'),
    ].filter((v,i,a)=>v && a.indexOf(v)===i);

    const dataStr = JSON.stringify(payload || {});
    // cache-busting agar tidak kena cache agresif mobile
    const nonce = Date.now().toString(36) + Math.random().toString(16).slice(2);

    let lastErr = null;

    const tryOne = (gasUrl) => {
      const cbName = '__cb_' + Math.random().toString(16).slice(2);
      let scriptEl = null;

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('Request timeout. Periksa koneksi / akses GAS.'));
        }, 20000);

        function cleanup(){
          clearTimeout(timeout);
          try { delete window[cbName]; } catch(_) {}
          if (scriptEl && scriptEl.parentNode) scriptEl.parentNode.removeChild(scriptEl);
        }

        window[cbName] = (resp) => { cleanup(); resolve(resp); };

        const url = new URL(gasUrl);
        url.searchParams.set('data', dataStr);
        url.searchParams.set('callback', cbName);
        url.searchParams.set('_', nonce); // cache bust

        scriptEl = document.createElement('script');
        scriptEl.async = true;
        scriptEl.src = url.toString();

        // bantu sebagian browser mobile
        scriptEl.referrerPolicy = 'no-referrer';

        scriptEl.onerror = () => {
          cleanup();
          reject(new Error('Gagal memuat response (script error). Domain mungkin diblokir / GAS tidak public.'));
        };

        (document.head || document.documentElement).appendChild(scriptEl);
      });
    };

    // coba berurutan (primary lalu fallback)
    return (async () => {
      for (const u of candidates){
        try{
          const resp = await tryOne(u);
          return resp;
        }catch(err){
          lastErr = err;
        }
      }
      throw lastErr || new Error('Gagal memuat response.');
    })();
  }

  // ---------------------------
  // 05B) API POST (no-preflight) — seperti KLP1 AGRO
  // ---------------------------
  async function postToGAS(payloadObj){
    const baseUrl = String(GAS_URL || '').trim();
    if (!baseUrl) throw new Error('GAS URL belum dikonfigurasi.');

    // form-urlencoded => simple request => biasanya aman di mobile (tanpa OPTIONS)
    const body = new URLSearchParams();
    body.set('data', JSON.stringify(payloadObj || {}));

    const res = await fetch(baseUrl, {
      method: 'POST',
      body,              // <-- jangan set headers!
      cache: 'no-store',
      credentials: 'omit'
    });

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      // GAS JSONP kadang balas JS kalau request salah, jadi tampilkan cuplikan
      throw new Error('Response bukan JSON: ' + text.slice(0, 200));
    }
  }

  // ---------------------------
  // 06) META LOAD/SAVE
  // ---------------------------
  async function loadMeta(){
    const meta = await idbGet(APP.storeMeta, 'meta');
    if (meta) State.meta = { ...structuredClone(APP.defaultMeta), ...meta };
    // ensure nested defaults
    State.meta.profile = { ...APP.defaultMeta.profile, ...(State.meta.profile||{}) };
    State.meta.remember = { ...APP.defaultMeta.remember, ...(State.meta.remember||{}) };
  }

  async function saveMeta(){
    await idbPut(APP.storeMeta, State.meta, 'meta');
  }

  // ---------------------------
  // 07) REPORT CRUD
  // ---------------------------
  function newId(){
    return Number(Date.now().toString() + Math.floor(Math.random()*90+10)); // numeric-ish
  }

  function getForm(){
    return {
      estateUnit: ($('#estateUnit')?.value || '').trim(),
      bidangMagang: ($('#bidangMagang')?.value || '').trim(),
      tanggal: $('#tanggal')?.value || '',
      kegiatanInti: ($('#kegiatanInti')?.value || '').trim(),
      prosesMetode: ($('#prosesMetode')?.value || '').trim(),
      hasilCapaian: ($('#hasilCapaian')?.value || '').trim(),
      hambatanSolusi: ($('#hambatanSolusi')?.value || '').trim(),
      pelajaranBaru: ($('#pelajaranBaru')?.value || '').trim(),
      rencanaBesok: ($('#rencanaBesok')?.value || '').trim()
    };
  }

  function setFormRemember(estateUnit, bidangMagang){
    if ($('#estateUnit')) $('#estateUnit').value = estateUnit || '';
    if ($('#bidangMagang')) $('#bidangMagang').value = bidangMagang || '';
  }

  function resetForm(keepRemember=true){
    const remember = State.meta.remember;
    if ($('#tanggal')) $('#tanggal').value = todayISO();

    const fields = ['kegiatanInti','prosesMetode','hasilCapaian','hambatanSolusi','pelajaranBaru','rencanaBesok','waPreview'];
    for (const id of fields){
      const el = $('#'+id);
      if (el) el.value = '';
    }

    if (keepRemember){
      setFormRemember(remember.estateUnit, remember.bidangMagang);
    } else {
      setFormRemember('', '');
    }
  }

  function validate(form){
    const p = State.meta.profile;
    if (!p.nik || !p.menteeName || !p.mentorName) return 'Profil mentee belum lengkap. Buka Pengaturan → Ubah Profil Mentee.';
    if (!form.estateUnit) return 'Estate/Unit wajib diisi.';
    if (!form.bidangMagang) return 'Bidang Magang wajib diisi.';
    if (!form.tanggal) return 'Tanggal wajib diisi.';
    if (!form.kegiatanInti) return 'Kegiatan Inti wajib diisi.';
    if (!form.prosesMetode) return 'Proses & Metode wajib diisi.';
    if (!form.hasilCapaian) return 'Hasil/Capaian wajib diisi.';
    if (!form.hambatanSolusi) return 'Hambatan & Solusi wajib diisi.';
    if (!form.pelajaranBaru) return 'Pelajaran/Pengetahuan Baru wajib diisi.';
    if (!form.rencanaBesok) return 'Rencana Besok wajib diisi.';
    return '';
  }

  async function saveReport(){
    const form = getForm();
    const err = validate(form);
    if (err){ toast(err, false); return; }

    // remember estate + bidang
    State.meta.remember.estateUnit = form.estateUnit;
    State.meta.remember.bidangMagang = form.bidangMagang;
    await saveMeta();

    const p = State.meta.profile;

    // ==== MODE EDIT: overwrite record lokal (masuk antrian sync lagi) ====
    if (State.editingId){
      const id = State.editingId;
      const idx = State.reports.findIndex(x => String(x.id) === String(id));
      if (idx < 0){
        State.editingId = null;
        toast('Data edit tidak ditemukan. Coba ulangi dari History.', false);
        return;
      }

      const old = State.reports[idx];
      const updated = {
        ...old,
        ...form,
        nik: p.nik,
        menteeName: p.menteeName,
        mentorName: p.mentorName,
        timestamp: new Date().toISOString(),
        synced: false,
        syncedAt: ''
      };

      await idbPut(APP.storeReports, updated);
      State.reports[idx] = updated;

      State.editingId = null;
      resetForm(true);
      toast(`Laporan berhasil diperbarui (ID ${updated.id}) dan masuk antrian sync.`, true);

      // refresh & switch
      renderHistory();
      setPill('Siap', 'ok');
      return;
    }

    // ==== MODE BARU: create ====
    const rec = {
      id: newId(),
      type: 'magang',
      timestamp: new Date().toISOString(),
      deviceId: State.deviceId,
      nik: p.nik,
      menteeName: p.menteeName,
      mentorName: p.mentorName,
      ...form,
      synced: false,
      syncedAt: ''
    };

    await idbPut(APP.storeReports, rec);
    State.reports.unshift(rec);

    resetForm(true);
    toast('Laporan tersimpan (lokal).', true);
    renderHistory();
  }

  // ---------------------------
  // 08) WA FORMATTER
  // ---------------------------
  function buildWAText(form){
    const p = State.meta.profile;
    const hariTanggal = formatHariTanggal(form.tanggal);

    return `*Laporan Harian Program Magang*\n\n` +
      `Mentee: ${p.menteeName || '-'}\n` +
      `Mentor: ${p.mentorName || '-'}\n\n` +
      `Hari/Tanggal: ${hariTanggal || '-'}\n` +
      `Bidang: ${form.bidangMagang || '-'}\n` +
      `Estate/Unit: ${form.estateUnit || '-'}\n\n` +
      `1. KEGIATAN: ${form.kegiatanInti || '-'}\n\n` +
      `2. PROSES: ${form.prosesMetode || '-'}\n\n` +
      `3. HASIL: ${form.hasilCapaian || '-'}\n\n` +
      `4. HAMBATAN: ${form.hambatanSolusi || '-'}\n\n` +
      `5. PELAJARAN: ${form.pelajaranBaru || '-'}\n\n` +
      `6. RENCANA BESOK: ${form.rencanaBesok || '-'}\n\n` +
      `*Demikian kami sampaikan dan terima kasih*`;
  }

  function generateWA(){
  // Mekanisme baru: buka modal pilih tanggal
    openWADateModal();
  }

  // cari laporan berdasarkan tanggal (yyyy-mm-dd)
  function findReportByTanggal(isoDate){
    const t = String(isoDate || '').trim();
    if (!t) return null;

    // Ambil yang paling baru untuk tanggal itu (kalau ada lebih dari 1)
    const matches = State.reports.filter(r => String(r.tanggal||'') === t);
    if (matches.length === 0) return null;

    matches.sort((a,b) => (b.timestamp||'').localeCompare(a.timestamp||''));
    return matches[0];
  }

  function openWADateModal(){
    const inp = $('#waDatePick');
    const hint = $('#waDateHint');

    // default: tanggal di form, atau hari ini
    const def = ($('#tanggal')?.value || '').trim() || todayISO();
    if (inp) inp.value = def;

    // hint awal
    const r = findReportByTanggal(def);
    if (hint){
      hint.textContent = r
        ? `✅ Ditemukan 1 laporan pada ${formatHariTanggal(def)} (ID ${r.id})`
        : `❌ Tidak ada laporan pada ${formatHariTanggal(def)}`;
    }

    showModal('waDateModal');
  }

  async function doGenerateWAFromPickedDate(){
    const t = ($('#waDatePick')?.value || '').trim();
    if (!t){
      toast('Silakan pilih tanggal laporan.', false);
      return;
    }

    const r = findReportByTanggal(t);
    if (!r){
      toast(`Tidak ada laporan pada tanggal ${formatHariTanggal(t)}.`, false);
      return;
    }

    const wa = buildWAText({
      estateUnit: r.estateUnit,
      bidangMagang: r.bidangMagang,
      tanggal: r.tanggal,
      kegiatanInti: r.kegiatanInti,
      prosesMetode: r.prosesMetode,
      hasilCapaian: r.hasilCapaian,
      hambatanSolusi: r.hambatanSolusi,
      pelajaranBaru: r.pelajaranBaru,
      rencanaBesok: r.rencanaBesok
    });

    if ($('#waPreview')) $('#waPreview').value = wa;

    hideModal('waDateModal');

    // pindah tab ke Laporan agar preview langsung terlihat
    $('[data-tab="laporan"]')?.click();
    toast(`WA dibuat untuk ${formatHariTanggal(t)}.`, true);
  }

  // ---------------------------
  // 09) HISTORY RENDER + ACTIONS
  // ---------------------------
  function applyFilters(list){
    const from = $('#filterDateFrom')?.value || '';
    const to   = $('#filterDateTo')?.value || '';
    const q    = ($('#filterText')?.value || '').trim().toLowerCase();

    return list.filter(r => {
      if (from && r.tanggal < from) return false;
      if (to && r.tanggal > to) return false;
      if (q){
        const hay = `${r.estateUnit} ${r.bidangMagang} ${r.kegiatanInti} ${r.prosesMetode} ${r.hasilCapaian} ${r.hambatanSolusi} ${r.pelajaranBaru} ${r.rencanaBesok}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

    function sortNewestFirst(list){
    // terbaru -> terlama: tanggal desc lalu timestamp desc
    return [...list].sort((a,b) =>
      (String(b.tanggal||'')).localeCompare(String(a.tanggal||'')) ||
      (String(b.timestamp||'')).localeCompare(String(a.timestamp||''))
    );
  }

  // Minggu ini (Senin–Minggu), Bulan ini, YTD
  function calcStats(allReports){
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // start of week: Monday
    const day = (today.getDay() + 6) % 7; // Mon=0 ... Sun=6
    const startWeek = new Date(today);
    startWeek.setDate(today.getDate() - day);
    const endWeek = new Date(startWeek);
    endWeek.setDate(startWeek.getDate() + 7);

    const startMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const endMonth = new Date(today.getFullYear(), today.getMonth()+1, 1);

    const startYear = new Date(today.getFullYear(), 0, 1);
    const endTodayPlus = new Date(today);
    endTodayPlus.setDate(today.getDate()+1);

    const toDate = (iso) => {
      if (!iso) return null;
      const d = new Date(String(iso) + 'T00:00:00');
      return isNaN(d.getTime()) ? null : d;
    };

    let week=0, month=0, ytd=0, unsynced=0;

    for (const r of allReports){
      const d = toDate(r.tanggal);
      if (!d) continue;

      if (!r.synced) unsynced++;

      if (d >= startWeek && d < endWeek) week++;
      if (d >= startMonth && d < endMonth) month++;
      if (d >= startYear && d < endTodayPlus) ytd++;
    }

    return { week, month, ytd, unsynced };
  }

  function renderHistoryStats(){
    const s = calcStats(State.reports);
    if ($('#statWeek')) $('#statWeek').textContent = `${s.week} laporan`;
    if ($('#statMonth')) $('#statMonth').textContent = `${s.month} laporan`;
    if ($('#statYtd')) $('#statYtd').textContent = `${s.ytd} laporan`;
    if ($('#statUnsynced')) $('#statUnsynced').textContent = `${s.unsynced} laporan`;
  }

  // Pagination with ellipsis
  function buildPager(totalPages, current){
    if (totalPages <= 1) return [];
    const pages = new Set([1, totalPages, current, current-1, current+1, current-2, current+2]);
    const arr = [...pages].filter(p => p>=1 && p<=totalPages).sort((a,b)=>a-b);

    const out = [];
    let prev = 0;
    for (const p of arr){
      if (prev && p - prev > 1) out.push('…');
      out.push(p);
      prev = p;
    }
    return out;
  }

    function renderHistory(){
    const listEl = $('#historyList');
    const sumEl = $('#historySummary');
    const pageInfoEl = $('#historyPageInfo');
    const pagerEl = $('#historyPager');
    if (!listEl) return;

    renderHistoryStats();

    // 1) filter + sort newest-first
    const filteredRaw = applyFilters(State.reports);
    const filtered = sortNewestFirst(filteredRaw);

    const total = filtered.length;
    const unsynced = filtered.filter(r => !r.synced).length;
    if (sumEl) sumEl.textContent = `${total} laporan • ${unsynced} belum sync`;

    // 2) paging
    const pageSize = Number(State.history.pageSize) || 10;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    State.history.page = Math.min(Math.max(1, State.history.page), totalPages);

    const startIdx = (State.history.page - 1) * pageSize;
    const endIdx = Math.min(total, startIdx + pageSize);
    const pageItems = filtered.slice(startIdx, endIdx);

    if (pageInfoEl){
      pageInfoEl.textContent = total === 0
        ? `Menampilkan 0`
        : `Menampilkan ${startIdx+1}–${endIdx} dari ${total}`;
    }

    // pager UI
    if (pagerEl){
      const nums = buildPager(totalPages, State.history.page);
      const prevDisabled = State.history.page <= 1;
      const nextDisabled = State.history.page >= totalPages;

      pagerEl.innerHTML = `
        <button class="btn secondary" data-page="prev" type="button" ${prevDisabled?'disabled':''}>Prev</button>
        ${nums.map(x => x==='…'
          ? `<span class="small muted" style="padding:8px 6px">…</span>`
          : `<button class="btn ${x===State.history.page?'':'secondary'}" data-page="${x}" type="button">${x}</button>`
        ).join('')}
        <button class="btn secondary" data-page="next" type="button" ${nextDisabled?'disabled':''}>Next</button>
      `;
    }

    // 3) render list (WA diganti EDIT)
    listEl.innerHTML = pageItems.map(r => {
      const title = `${formatHariTanggal(r.tanggal)} • ${escapeHtml(r.estateUnit)} • ${escapeHtml(r.bidangMagang)}`;
      const meta = `ID ${r.id} • ${new Date(r.timestamp).toLocaleString('id-ID')} • ${r.synced ? 'Synced' : 'Local only'}`;
      const chip = r.synced ? `<span class="chip ok">Synced</span>` : `<span class="chip warn">Belum Sync</span>`;
      const body = [
        `KEGIATAN: ${r.kegiatanInti}`,
        `PROSES: ${r.prosesMetode}`,
        `HASIL: ${r.hasilCapaian}`,
        `HAMBATAN: ${r.hambatanSolusi}`,
        `PELAJARAN: ${r.pelajaranBaru}`,
        `RENCANA BESOK: ${r.rencanaBesok}`,
      ].join('\n');

      return `<div class="item" data-id="${r.id}">
        <div class="item__head">
          <div>
            <div class="item__title">${title}</div>
            <div class="item__meta">${escapeHtml(meta)}</div>
          </div>
          <div class="item__meta">${chip}</div>
        </div>
        <div class="item__body">${escapeHtml(body)}</div>
        <div class="item__actions">
          <button class="btn secondary" data-act="edit" data-id="${r.id}" type="button">Edit</button>
          <button class="btn secondary" data-act="copy" data-id="${r.id}" type="button">Copy</button>
          <button class="btn danger" data-act="del" data-id="${r.id}" type="button">Hapus</button>
        </div>
      </div>`;
    }).join('');
  }

  async function deleteReport(id){
    await idbDel(APP.storeReports, id);
    State.reports = State.reports.filter(r => r.id !== id);
    toast('Laporan dihapus.', true);
    renderHistory();
  }

  function reportToWAById(id){
    const r = State.reports.find(x => x.id === id);
    if (!r) return '';
    const wa = buildWAText({
      estateUnit: r.estateUnit,
      bidangMagang: r.bidangMagang,
      tanggal: r.tanggal,
      kegiatanInti: r.kegiatanInti,
      prosesMetode: r.prosesMetode,
      hasilCapaian: r.hasilCapaian,
      hambatanSolusi: r.hambatanSolusi,
      pelajaranBaru: r.pelajaranBaru,
      rencanaBesok: r.rencanaBesok
    });
    return wa;
  }

  function fillFormFromReport(r){
  if (!r) return;
  if ($('#estateUnit')) $('#estateUnit').value = r.estateUnit || '';
  if ($('#bidangMagang')) $('#bidangMagang').value = r.bidangMagang || '';
  if ($('#tanggal')) $('#tanggal').value = r.tanggal || '';
  if ($('#kegiatanInti')) $('#kegiatanInti').value = r.kegiatanInti || '';
  if ($('#prosesMetode')) $('#prosesMetode').value = r.prosesMetode || '';
  if ($('#hasilCapaian')) $('#hasilCapaian').value = r.hasilCapaian || '';
  if ($('#hambatanSolusi')) $('#hambatanSolusi').value = r.hambatanSolusi || '';
  if ($('#pelajaranBaru')) $('#pelajaranBaru').value = r.pelajaranBaru || '';
  if ($('#rencanaBesok')) $('#rencanaBesok').value = r.rencanaBesok || '';
}

  // ---------------------------
  // 10) SYNC (appendData) & PULL (getActualByNIK)
  // ---------------------------
  async function syncUnsynced(){
    const sheetId = (SHEET_ID || '').trim();
    if (!sheetId) { toast('Sheet ID belum dikonfigurasi (hardcode).', false); return; }

    const unsynced = State.reports.filter(r => !r.synced);
    if (unsynced.length === 0){ toast('Tidak ada data yang perlu di-sync.', true); return; }

    setPill('Sync...', 'warn');

    const payload = {
      action: 'appendData',
      sheetId,
      timestamp: new Date().toISOString(),
      data: unsynced.map(r => ({
        id: r.id,
        timestamp: r.timestamp,
        nik: r.nik,
        menteeName: r.menteeName,
        mentorName: r.mentorName,
        estateUnit: r.estateUnit,
        bidangMagang: r.bidangMagang,
        tanggal: r.tanggal,
        kegiatanInti: r.kegiatanInti,
        prosesMetode: r.prosesMetode,
        hasilCapaian: r.hasilCapaian,
        hambatanSolusi: r.hambatanSolusi,
        pelajaranBaru: r.pelajaranBaru,
        rencanaBesok: r.rencanaBesok
      }))
    };

    try{
      let resp;
        try {
          resp = await postToGAS(payload);    // ✅ POST dulu
        } catch (e) {
          resp = await apiJsonp(payload);     // fallback JSONP
        }
      if (!resp || !resp.success) throw new Error(resp?.message || 'Sync gagal.');

      const okIds = new Set((resp.syncedIds || []).map(String));
      const nowIso = new Date().toISOString();

      for (const r of State.reports){
        if (!r.synced && okIds.has(String(r.id))){
          r.synced = true;
          r.syncedAt = nowIso;
          await idbPut(APP.storeReports, r);
        }
      }
      toast(resp.message || `Synced ${okIds.size} laporan`, true);
      renderHistory();
    }catch(err){
      toast(err.message || String(err), false);
    }
  }

  async function pullFromServer(){
  const sheetId = (SHEET_ID || '').trim();
  if (!sheetId) { toast('Sheet ID belum dikonfigurasi (hardcode).', false); return; }

  const nik = (State.meta.profile.nik || '').trim();
  if (!nik) { toast('NIK belum diisi (profil).', false); return; }

  setPill('Pull...', 'warn');

  try{
    let resp;
      try {
        resp = await postToGAS({ action:'getActualByNIK', sheetId, nik }); // ✅ POST dulu
      } catch (e) {
        resp = await apiJsonp({ action:'getActualByNIK', sheetId, nik });  // fallback JSONP
      }
    if (!resp || !resp.success) throw new Error(resp?.message || 'Pull gagal.');

    const items = resp.items || [];
    if (items.length === 0){
      toast('Tidak ada data di server untuk NIK ini.', true);
      return;
    }

    // Merge: server data is authoritative for "synced" ones
    const byId = new Map(State.reports.map(r => [String(r.id), r]));
    let added = 0, updated = 0;

    for (const it of items){
      const idStr = String(it.id);
      const existing = byId.get(idStr);
      const rec = normalizeServerItem(it);

      if (!existing){
        await idbPut(APP.storeReports, rec);
        State.reports.push(rec);
        added++;
      }else{
        // update hanya jika record lokal sudah synced (jangan timpa draft lokal yang belum sync)
        if (existing.synced){
          await idbPut(APP.storeReports, { ...existing, ...rec, synced:true });
          Object.assign(existing, { ...existing, ...rec, synced:true });
          updated++;
        }
      }
    }

    // sort newest first by tanggal then timestamp
    State.reports.sort((a,b) =>
      (b.tanggal||'').localeCompare(a.tanggal||'') ||
      (b.timestamp||'').localeCompare(a.timestamp||'')
    );

    toast(`Pull selesai: +${added} baru, ${updated} update.`, true);
    renderHistory();

  }catch(err){
    toast(err.message || String(err), false);
  }
}

  function normalizeServerItem(it){
    // Ensure same shape as local
    return {
      id: (typeof it.id === 'number') ? it.id : Number(it.id) || it.id,
      type: 'magang',
      timestamp: it.timestamp || new Date().toISOString(),
      deviceId: it.deviceId || '',
      nik: it.nik || State.meta.profile.nik || '',
      menteeName: it.menteeName || State.meta.profile.menteeName || '',
      mentorName: it.mentorName || State.meta.profile.mentorName || '',
      estateUnit: it.estateUnit || it.estate || '',
      bidangMagang: it.bidangMagang || it.bidang || '',
      tanggal: it.tanggal || '',
      kegiatanInti: it.kegiatanInti || it.kegiatan || '',
      prosesMetode: it.prosesMetode || it.proses || '',
      hasilCapaian: it.hasilCapaian || it.hasil || '',
      hambatanSolusi: it.hambatanSolusi || it.hambatan || '',
      pelajaranBaru: it.pelajaranBaru || it.pelajaran || '',
      rencanaBesok: it.rencanaBesok || it.rencana || '',
      synced: true,
      syncedAt: it.syncedAt || ''
    };
  }

  // ---------------------------
  // 11) UI: TABS + MODAL + SETTINGS
  // ---------------------------
  function initTabs(){
    $$('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const target = btn.dataset.tab;
        $$('.tab-content').forEach(c => c.classList.remove('active'));
        $('#'+target)?.classList.add('active');
      });
    });
  }

  function showModal(id){
    const m = $('#'+id);
    if (!m) return;
    m.classList.add('show');
    m.setAttribute('aria-hidden','false');
  }
  function hideModal(id){
    const m = $('#'+id);
    if (!m) return;
    m.classList.remove('show');
    m.setAttribute('aria-hidden','true');
  }

  function initModal(){
    $$('[data-close]').forEach(x => x.addEventListener('click', () => hideModal(x.dataset.close)));
    $('#btnOpenProfile')?.addEventListener('click', () => openProfileModal());
    $('#saveUserInfo')?.addEventListener('click', async () => {
      const nik = ($('#pesertaNik')?.value || '').trim();
      const menteeName = ($('#menteeName')?.value || '').trim();
      const mentorName = ($('#mentorName')?.value || '').trim();
      if (!nik || !menteeName || !mentorName){
        toast('NIK, Nama Mentee, dan Nama Mentor wajib diisi.', false);
        return;
      }
      State.meta.profile = { nik, menteeName, mentorName };
      await saveMeta();
      refreshProfileUI();
      hideModal('userInfoModal');
      toast('Profil tersimpan.', true);
    });

    $('#btnResetProfile')?.addEventListener('click', async () => {
      if (!confirm('Reset profil mentee?')) return;
      State.meta.profile = { nik:'', menteeName:'', mentorName:'' };
      await saveMeta();
      refreshProfileUI();
      openProfileModal();
    });

    // Modal Generate WA (pilih tanggal)
    $('#btnDoGenerateWA')?.addEventListener('click', () => doGenerateWAFromPickedDate());

    $('#waDatePick')?.addEventListener('change', () => {
      const t = ($('#waDatePick')?.value || '').trim();
      const hint = $('#waDateHint');
      const r = findReportByTanggal(t);
      if (hint){
        hint.textContent = r
          ? `✅ Ditemukan 1 laporan pada ${formatHariTanggal(t)} (ID ${r.id})`
          : `❌ Tidak ada laporan pada ${formatHariTanggal(t)}`;
      }
    });
  }

  function openProfileModal(){
    const p = State.meta.profile;
    if ($('#pesertaNik')) $('#pesertaNik').value = p.nik || '';
    if ($('#menteeName')) $('#menteeName').value = p.menteeName || '';
    if ($('#mentorName')) $('#mentorName').value = p.mentorName || '';
    if ($('#deviceId')) $('#deviceId').value = State.deviceId || '';
    showModal('userInfoModal');
  }

  function refreshProfileUI(){
    const p = State.meta.profile;
    const el = $('#profileSummary');
    if (el){
      el.innerHTML = `NIK <b>${escapeHtml(p.nik||'-')}</b> • Mentee <b>${escapeHtml(p.menteeName||'-')}</b> • Mentor <b>${escapeHtml(p.mentorName||'-')}</b>`;
    }
  }

  function initSettings(){
    // ✅ Tidak ada input gasUrl/sheetId karena sudah hardcode

    $('#btnTestConn')?.addEventListener('click', async () => {
      try{
        let resp;
          try {
            resp = await postToGAS({ action:'testConnection' });   // ✅ utama: POST
          } catch (e) {
            resp = await apiJsonp({ action:'testConnection' });    // fallback: JSONP
          }
        if (!resp?.success) throw new Error(resp?.message || 'Gagal test connection.');
        toast(resp.message || 'Connection successful', true);
      }catch(err){
        toast(
          (err.message || String(err)) +
          '\n\nCatatan: Jika hanya error di mobile, biasanya karena GAS belum public (Anyone) atau domain script Google diblokir (ETP/AdBlock/Private DNS).',
          false
        );
      }
    });

    $('#btnClearLocal')?.addEventListener('click', async () => {
      if (!confirm('Hapus SEMUA data lokal (meta + laporan)?')) return;
      await clearAll();
      State.meta = structuredClone(APP.defaultMeta);
      State.reports = [];
      await saveMeta();
      resetForm(false);
      refreshProfileUI();
      toast('Data lokal dihapus.', true);
      renderHistory();
    });
  }


  function initForm(){
    $('#tanggal')?.addEventListener('change', () => setPill('Siap', 'info'));
    $('#estateUnit')?.addEventListener('change', async () => {
      State.meta.remember.estateUnit = ($('#estateUnit')?.value || '').trim();
      await saveMeta();
    });
    $('#bidangMagang')?.addEventListener('change', async () => {
      State.meta.remember.bidangMagang = ($('#bidangMagang')?.value || '').trim();
      await saveMeta();
    });

    $('#btnResetForm')?.addEventListener('click', () => resetForm(true));
    $('#btnSave')?.addEventListener('click', () => saveReport());
    $('#btnWA')?.addEventListener('click', () => generateWA());
    $('#btnCopyWA')?.addEventListener('click', async () => {
      const txt = $('#waPreview')?.value || '';
      if (!txt.trim()){ toast('Belum ada teks WA.', false); return; }
      await copyToClipboard(txt);
      toast('Teks WA disalin.', true);
    });
    $('#btnOpenWA')?.addEventListener('click', async () => {
      const txt = $('#waPreview')?.value || '';
      if (!txt.trim()){ toast('Belum ada teks WA.', false); return; }
      const url = 'https://wa.me/?text=' + encodeURIComponent(txt);
      window.open(url, '_blank', 'noopener');
    });
  }

  function initHistory(){
  // filter actions
    $('#btnApplyFilter')?.addEventListener('click', () => {
      State.history.page = 1;
      renderHistory();
    });
    $('#filterText')?.addEventListener('input', () => {
      State.history.page = 1;
      renderHistory();
    });
    $('#filterDateFrom')?.addEventListener('change', () => {
      State.history.page = 1;
      renderHistory();
    });
    $('#filterDateTo')?.addEventListener('change', () => {
      State.history.page = 1;
      renderHistory();
    });

    // page size
    $('#historyPageSize')?.addEventListener('change', (e) => {
      State.history.pageSize = Number(e.target.value) || 10;
      State.history.page = 1;
      renderHistory();
    });

    // pager clicks
    $('#historyPager')?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-page]');
      if (!btn) return;
      const v = btn.dataset.page;

      const totalFiltered = sortNewestFirst(applyFilters(State.reports)).length;
      const totalPages = Math.max(1, Math.ceil(totalFiltered / (Number(State.history.pageSize)||10)));

      if (v === 'prev') State.history.page = Math.max(1, State.history.page - 1);
      else if (v === 'next') State.history.page = Math.min(totalPages, State.history.page + 1);
      else State.history.page = Number(v) || 1;

      renderHistory();
    });

    // list item actions
    $('#historyList')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      const numId = Number(id) || id;

      if (act === 'del'){
        if (!confirm('Hapus laporan ini?')) return;
        await deleteReport(numId);
        return;
      }

      if (act === 'edit'){
        const r = State.reports.find(x => String(x.id) === String(numId));
        if (!r){ toast('Data tidak ditemukan.', false); return; }

        State.editingId = r.id;
        fillFormFromReport(r);

        // pindah ke tab laporan untuk edit
        $('[data-tab="laporan"]')?.click();
        setPill('Edit', 'warn');
        toast(`Mode EDIT (ID ${r.id}). Silakan ubah lalu klik Simpan.`, true);
        return;
      }

      if (act === 'copy'){
        const wa = reportToWAById(numId);
        await copyToClipboard(wa);
        toast('Teks WA (history) disalin.', true);
        return;
      }
    });

    // sync/pull
    $('#btnSync')?.addEventListener('click', () => syncUnsynced());
    $('#btnPullServer')?.addEventListener('click', () => pullFromServer());

    // export
    $('#btnExportXlsx')?.addEventListener('click', () => exportHistoryXlsx());

    // clear reports only (keep profile/meta)
    $('#btnClearReports')?.addEventListener('click', async () => {
      if (!confirm('Hapus SEMUA laporan lokal? Profil mentee tetap aman.')) return;
      await clearReportsOnly();
      toast('Semua laporan lokal dihapus. Profil tetap tersimpan.', true);
      renderHistory();
    });
  }

  // ---------------------------
  // 12) BOOTSTRAP
  // ---------------------------
  async function main(){
    try{
      State.deviceId = getOrCreateDeviceId();
      await loadMeta();

      // load reports
      const list = await idbGetAll(APP.storeReports);
      // sort newest first by tanggal then timestamp
      list.sort((a,b) => (b.tanggal||'').localeCompare(a.tanggal||'') || (b.timestamp||'').localeCompare(a.timestamp||''));
      State.reports = list;

      initTabs();
      initModal();
      initSettings();
      initForm();
      initHistory();
      State.history.pageSize = Number($('#historyPageSize')?.value) || 10;

      // init form defaults
      resetForm(true);
      // restore remember fields
      setFormRemember(State.meta.remember.estateUnit, State.meta.remember.bidangMagang);
      refreshProfileUI();
      renderHistory();

      // force profile if empty
      const p = State.meta.profile;
      if (!p.nik || !p.menteeName || !p.mentorName){
        openProfileModal();
        setPill('Isi Profil', 'warn');
      } else {
        setPill('Siap', 'ok');
      }
    }catch(err){
      console.error(err);
      alert('Gagal inisialisasi aplikasi: ' + (err.message || err));
    }
  }

  document.addEventListener('DOMContentLoaded', main);
})();
