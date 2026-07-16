function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  try {
    // Parse data (support JSONP via ?data=...&callback=...)
    var requestData = null;
    if (e && e.parameter && e.parameter.data) {
      requestData = JSON.parse(e.parameter.data);
    } else if (e && e.postData && e.postData.getDataAsString()) {
      var raw = e.postData.getDataAsString();

      // Kalau body berupa "data=...." (form-urlencoded), ambil parameter data
      if (raw && raw.indexOf('data=') === 0) {
        var decoded = decodeURIComponent(raw.slice(5)); // setelah "data="
        requestData = JSON.parse(decoded);
      } else {
        requestData = JSON.parse(raw);
      }
    }

    // ✅ IMPORTANT: dukung JSONP callback dari URL (?callback=...)
    if (e && e.parameter && e.parameter.callback) {
      requestData = requestData || {};
      requestData.callback = String(e.parameter.callback);
    }

    if (!requestData) {
      return respond_(false, "No data provided", null, requestData);
    }

    switch (String(requestData.action || "")) {
      case "appendData":
        return handleAppendMagang_(requestData);
      case "testConnection":
        return respond_(true, "Connection successful", {}, requestData);
      case "getActualByNIK":
        return handleGetActualByNIK_(requestData);
      default:
        return respond_(false, "Invalid action", null, requestData);
    }
  } catch (err) {
    console.error("Error in handleRequest:", err);
    // tetap dukung callback bila ada
    var cb = (e && e.parameter && e.parameter.callback) ? String(e.parameter.callback) : null;
    return respond_(false, err.message, null, cb ? { callback: cb } : null);
  }
}

/**
 * Sheet: "Magang"
 * Dedupe by column "ID" (col B)
 */
function handleAppendMagang_(requestData) {
  try {
    if (!requestData.sheetId || !requestData.data || !Array.isArray(requestData.data)) {
      throw new Error("Invalid request data (sheetId & data[] required)");
    }

    var ss = SpreadsheetApp.openById(requestData.sheetId);
    if (!ss) throw new Error("Spreadsheet not found");

    var sh = getOrCreateSheet_(ss, "Magang");
    if (sh.getLastRow() === 0) setupHeaders_(sh);

    // Map existing ID -> rowNumber (row starts at 2)
    var lastRow = sh.getLastRow();
    var idToRow = {};
    if (lastRow >= 2) {
      var idVals = sh.getRange(2, 2, lastRow - 1, 1).getValues(); // col B = ID
      for (var i = 0; i < idVals.length; i++) {
        var idStr = String(idVals[i][0] || "").trim();
        if (idStr) idToRow[idStr] = i + 2; // actual row number
      }
    }

    var syncedIds = [];
    var tsSync = requestData.timestamp || new Date().toISOString();

    requestData.data.forEach(function (r) {
      try {
        var idStr = String(r.id || "").trim();
        if (!idStr) return;

        var rowValues = [
          tsSync,                           // Timestamp Sync
          r.id,                             // ID
          r.timestamp || new Date().toISOString(), // Timestamp Laporan
          r.nik || "",                      // NIK
          r.menteeName || "",               // Mentee
          r.mentorName || "",               // Mentor
          r.estateUnit || "",               // Estate/Unit
          r.bidangMagang || "",             // Bidang
          r.tanggal || "",                  // Tanggal (yyyy-mm-dd)
          r.kegiatanInti || "",             // Kegiatan Inti
          r.prosesMetode || "",             // Proses & Metode
          r.hasilCapaian || "",             // Hasil/Capaian
          r.hambatanSolusi || "",           // Hambatan & Solusi
          r.pelajaranBaru || "",            // Pelajaran Baru
          r.rencanaBesok || ""              // Rencana Besok
        ];

        var existingRow = idToRow[idStr];
        if (existingRow) {
          // OVERWRITE existing row
          sh.getRange(existingRow, 1, 1, rowValues.length).setValues([rowValues]);
        } else {
          // APPEND new row
          sh.appendRow(rowValues);
          idToRow[idStr] = sh.getLastRow();
        }

        syncedIds.push(r.id);
      } catch (rowErr) {
        console.error("Error upsert row id=" + r.id + ":", rowErr);
      }
    });

    return respond_(true, "Successfully synced " + syncedIds.length + " reports (upsert)", {
      count: syncedIds.length,
      syncedIds: syncedIds
    }, requestData);

  } catch (err) {
    console.error("Error in handleAppendMagang_:", err);
    return respond_(false, err.message, null, requestData);
  }
}

function handleGetActualByNIK_(requestData) {
  try {
    if (!requestData.sheetId) throw new Error("sheetId required");
    if (!requestData.nik) throw new Error("nik required");

    var nik = String(requestData.nik).trim();
    var ss = SpreadsheetApp.openById(requestData.sheetId);
    var sh = ss.getSheetByName("Magang");
    if (!sh) {
      return respond_(true, "Sheet Magang belum ada", { count: 0, items: [] }, requestData);
    }

    var values = sh.getDataRange().getValues();
    if (values.length < 2) return respond_(true, "OK", { count: 0, items: [] }, requestData);

    var headers = values[0].map(function (h) { return String(h || "").trim().toLowerCase(); });
    var idx = function (name) { return headers.indexOf(name); };

    var iId = idx("id");
    var iTs = idx("timestamp laporan");
    var iNik = idx("nik");
    var iMentee = idx("mentee");
    var iMentor = idx("mentor");
    var iEstate = idx("estate/unit");
    var iBidang = idx("bidang");
    var iTanggal = idx("tanggal");
    var iKegiatan = idx("kegiatan inti");
    var iProses = idx("proses & metode");
    var iHasil = idx("hasil/capaian (output)");
    var iHambatan = idx("hambatan & solusi");
    var iPelajaran = idx("pelajaran/pengetahuan baru");
    var iRencana = idx("rencana besok");

    if (iId < 0 || iNik < 0) throw new Error("Header sheet Magang tidak sesuai. Pastikan sudah dibuat oleh aplikasi (setup headers).");

    var out = [];
    for (var r = 1; r < values.length; r++) {
      var row = values[r];
      var rowNik = String(row[iNik] || "").trim();
      if (!rowNik || rowNik !== nik) continue;

      out.push({
        id: row[iId],
        type: "magang",
        timestamp: iTs >= 0 ? toIsoDateTime_(row[iTs]) : new Date().toISOString(),
        nik: rowNik,
        menteeName: iMentee >= 0 ? String(row[iMentee] || "").trim() : "",
        mentorName: iMentor >= 0 ? String(row[iMentor] || "").trim() : "",
        estateUnit: iEstate >= 0 ? String(row[iEstate] || "").trim() : "",
        bidangMagang: iBidang >= 0 ? String(row[iBidang] || "").trim() : "",
        tanggal: iTanggal >= 0 ? toIsoDate_(row[iTanggal]) : "",
        kegiatanInti: iKegiatan >= 0 ? String(row[iKegiatan] || "").trim() : "",
        prosesMetode: iProses >= 0 ? String(row[iProses] || "").trim() : "",
        hasilCapaian: iHasil >= 0 ? String(row[iHasil] || "").trim() : "",
        hambatanSolusi: iHambatan >= 0 ? String(row[iHambatan] || "").trim() : "",
        pelajaranBaru: iPelajaran >= 0 ? String(row[iPelajaran] || "").trim() : "",
        rencanaBesok: iRencana >= 0 ? String(row[iRencana] || "").trim() : "",
        synced: true
      });
    }

    // sort newest first by tanggal
    out.sort(function (a, b) {
      return String(b.tanggal || "").localeCompare(String(a.tanggal || "")) ||
             String(b.timestamp || "").localeCompare(String(a.timestamp || ""));
    });

    return respond_(true, "OK", { count: out.length, items: out }, requestData);

  } catch (err) {
    console.error("Error in handleGetActualByNIK_:", err);
    return respond_(false, err.message, null, requestData);
  }
}

function getOrCreateSheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function setupHeaders_(sh) {
  var headers = [
    "Timestamp Sync",
    "ID",
    "Timestamp Laporan",
    "NIK",
    "Mentee",
    "Mentor",
    "Estate/Unit",
    "Bidang",
    "Tanggal",
    "Kegiatan Inti",
    "Proses & Metode",
    "Hasil/Capaian (Output)",
    "Hambatan & Solusi",
    "Pelajaran/Pengetahuan Baru",
    "Rencana Besok"
  ];
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  sh.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  sh.setFrozenRows(1);
}

function getExistingIds_(sh) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  return sh.getRange(2, 2, lastRow - 1, 1).getValues().flat().map(function (v) { return String(v); });
}

function respond_(success, message, extra, requestData) {
  var obj = { success: !!success, message: message || "" };
  if (extra && typeof extra === "object") {
    Object.keys(extra).forEach(function (k) { obj[k] = extra[k]; });
  }

  if (requestData && requestData.callback) {
    var cb = String(requestData.callback);
    var jsonp = cb + "(" + JSON.stringify(obj) + ")";
    return ContentService.createTextOutput(jsonp).setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function toIsoDate_(v) {
  if (!v) return "";
  if (Object.prototype.toString.call(v) === "[object Date]") {
    var d = v;
    var yyyy = d.getFullYear();
    var mm = ("0" + (d.getMonth() + 1)).slice(-2);
    var dd = ("0" + d.getDate()).slice(-2);
    return yyyy + "-" + mm + "-" + dd;
  }
  var s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return s;
}

function toIsoDateTime_(v) {
  if (!v) return new Date().toISOString();
  if (Object.prototype.toString.call(v) === "[object Date]") return v.toISOString();
  var s = String(v).trim();
  // if already iso-ish, keep
  return s;
}
