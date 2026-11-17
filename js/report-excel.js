/* Omet – Mensa · Excel del report mensile (ExcelJS incluso in /vendor, caricato solo quando serve).
   Tre fogli con filtri attivi, intestazione bloccata e stampa già impostata: A4 orizzontale, una pagina in larghezza,
   righe di intestazione ripetute, piè con pagina e data. Si usa con File → Stampa, senza macro. */
(function (root) {
  "use strict";
  var BLU = "FF093E83", BAND = "FFEEF3F9", LINEA = "FFD7DEE8", ROSSO = "FFC62828";
  var MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
  function it(s) { var a = s.split("-"); return a[2] + "/" + a[1] + "/" + a[0]; }
  function data(s) { var a = s.split("-"); return new Date(Date.UTC(+a[0], +a[1] - 1, +a[2])); }
  function quando(ts) { return ts ? it(ts.slice(0, 10)) + " " + ts.slice(11, 16) : ""; }
  function meseL(m) { var a = m.split("-"); return MESI[+a[1] - 1] + " " + a[0]; }

  function foglio(wb, nome, titolo, sottotitolo, colonne, righe, opz) {
    opz = opz || {};
    var ws = wb.addWorksheet(nome, {
      views: [{ state: "frozen", ySplit: 3 }],
      pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
        margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.25, footer: 0.25 }, printTitlesRow: "3:3" },
      headerFooter: { oddFooter: "&L&8Omet Foodtech · Mensa&C&8Pagina &P di &N&R&8Stampa del &D ore &T", oddHeader: "&L&9&B" + titolo }
    });
    ws.columns = colonne.map(function (c) { return { key: c.k, width: c.w }; });
    ws.mergeCells(1, 1, 1, colonne.length);
    var t = ws.getCell(1, 1); t.value = titolo; t.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
    t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLU } }; t.alignment = { vertical: "middle" }; ws.getRow(1).height = 24;
    ws.mergeCells(2, 1, 2, colonne.length);
    ws.getCell(2, 1).value = sottotitolo; ws.getCell(2, 1).font = { italic: true, size: 9, color: { argb: "FF5D6B7C" } };
    var h = ws.getRow(3);
    colonne.forEach(function (c, i) {
      var cell = h.getCell(i + 1); cell.value = c.t;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLU } };
      cell.alignment = { vertical: "middle", wrapText: true, horizontal: c.n ? "center" : "left" };
    });
    h.height = 30;
    righe.forEach(function (r, i) {
      var row = ws.addRow(r);
      row.eachCell({ includeEmpty: true }, function (cell, col) {
        var c = colonne[col - 1]; if (!c) return;
        cell.border = { bottom: { style: "thin", color: { argb: LINEA } } };
        if (c.n) cell.alignment = { horizontal: "center" };
        if (c.d) cell.numFmt = "dd/mm/yyyy";
        if (c.wrap) cell.alignment = { wrapText: true, vertical: "top" };
        if (i % 2) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND } };
      });
      if (opz.evidenzia) opz.evidenzia(row, r);
    });
    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3 + Math.max(righe.length, 1), column: colonne.length } };
    if (opz.totale) {
      var tr = ws.addRow(opz.totale); tr.font = { bold: true };
      tr.eachCell({ includeEmpty: true }, function (cell, col) { if (colonne[col - 1] && colonne[col - 1].n) cell.alignment = { horizontal: "center" }; cell.border = { top: { style: "medium", color: { argb: BLU } } }; });
    }
    return ws;
  }

  // R = risultato di calcReport (core.js)
  function costruisci(ExcelJS, R, chi) {
    var wb = new ExcelJS.Workbook();
    wb.creator = "Mensa Omet"; wb.created = new Date();
    var sub = "Generato il " + new Date().toLocaleString("it-IT") + (chi ? " da " + chi : "") + " · Filtri attivi sulla riga blu · Stampa: File → Stampa (già impostata A4 orizzontale)";
    // 1) per persona
    foglio(wb, "Per persona", "Mensa Omet – " + meseL(R.mese) + " · riepilogo per persona", sub, [
      { k: "u", t: "Utente", w: 28 }, { k: "p", t: "Pasti consumati", w: 14, n: 1 }, { k: "a", t: "Annullamenti dopo l'invio", w: 16, n: 1 },
      { k: "v", t: "Variazioni dopo l'invio", w: 16, n: 1 }, { k: "c", t: "Inseriti da addetti", w: 14, n: 1 }, { k: "o", t: "Ospite", w: 10, n: 1 }
    ], R.righe.map(function (r) { return { u: r.username, p: r.pasti, a: r.annullati, v: r.variazioni, c: r.perConto, o: r.ospite ? "Sì" : "" }; }), {
      totale: { u: "TOTALE", p: R.totali.pasti, a: R.totali.annullati, v: R.totali.variazioni },
      evidenzia: function (row, r) { if (r.a >= 2) row.getCell(3).font = { bold: true, color: { argb: ROSSO } }; }
    });
    // 2) dettaglio pasti
    foglio(wb, "Dettaglio", "Mensa Omet – " + meseL(R.mese) + " · dettaglio pasti", sub, [
      { k: "d", t: "Data", w: 11, d: 1 }, { k: "g", t: "Giorno", w: 11 }, { k: "u", t: "Utente", w: 24 }, { k: "s", t: "Stato", w: 11 },
      { k: "c", t: "Codici", w: 10 }, { k: "p", t: "Piatti", w: 52, wrap: 1 }, { k: "a", t: "Acqua", w: 10 }, { k: "n", t: "Nota", w: 22, wrap: 1 },
      { k: "x", t: "Annullato il", w: 16 }, { k: "y", t: "Dopo l'invio", w: 11, n: 1 }, { k: "i", t: "Inserito da", w: 16 }
    ], R.dettaglio.map(function (r) {
      return { d: data(r.data), g: r.giorno, u: r.username + (r.ospite ? " (ospite)" : ""), s: r.stato, c: r.codici, p: r.piatti, a: r.acqua, n: r.nota,
        x: quando(r.annullatoIl), y: r.stato === "Annullato" ? (r.dopoChiusura ? "Sì" : "No") : "", i: r.inseritoDa };
    }), { evidenzia: function (row, r) { if (r.y === "Sì") row.getCell(4).font = { bold: true, color: { argb: ROSSO } }; } });
    // 3) pasti per giorno
    foglio(wb, "Per giorno", "Mensa Omet – " + meseL(R.mese) + " · pasti per giorno", sub, [
      { k: "d", t: "Data", w: 12, d: 1 }, { k: "g", t: "Giorno", w: 14 }, { k: "p", t: "Pasti", w: 10, n: 1 }
    ], R.perGiorno.map(function (r) { return { d: data(r.data), g: r.giorno, p: r.pasti }; }), { totale: { d: "TOTALE", p: R.totali.pasti } });
    return wb;
  }

  var api = { costruisci: costruisci, nomeFile: function (R) { return "mensa_report_" + R.mese + ".xlsx"; } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MensaExcel = api;
})(typeof self !== "undefined" ? self : this);
