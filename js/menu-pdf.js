/* Omet – Mensa · lettura del menu mensile dal PDF della mensa (testo vero, non scansione).
   Funziona nel browser (pdf.js incorporato in /vendor) e in Node per il collaudo.
   Ingresso: elenco di pagine, ognuna = array di {str, x, y, w, rot} (rot=true se testo verticale).
   Uscita: {settimane:[{n, giorni:[{data:"AAAA-MM-GG", piatti:[{c,n,all,cat,panna,maiale}]}], note:[...]}], avvisi:[...]} */
(function (root) {
  "use strict";
  const CODE_RE = /^([A-Z]|\d)$/;
  const DATE_RE = /(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/;
  const pad = n => String(n).padStart(2, "0");

  // Analizza il nome: allergeni tra parentesi, P = panna, ** = maiale
  function parseNome(raw) {
    let s = " " + raw.replace(/\s+/g, " ").trim() + " ";
    let all = "";
    const m = s.match(/\(\s*([\d\s\-–,]+)\s*\)/);
    if (m) { all = m[1].replace(/\s/g, "").replace(/–/g, "-").replace(/,/g, "-"); s = s.replace(m[0], " "); }
    const maiale = /\*\*/.test(s); s = s.replace(/\*\*/g, " ");
    // "P" isolato (anche attaccato alla parentesi già tolta) = piatto con panna
    let panna = false;
    if (/\sP\s*$/.test(s.trimEnd() + " ") || /\sP\s/.test(s)) { panna = true; s = s.replace(/\sP(?=\s|$)/g, " "); }
    const n = s.replace(/\s+/g, " ").trim();
    return { n, all, panna, maiale };
  }

  // Codici di contorno che in realtà sono frutta o dolce (convenzione del menu Omet: L frutta, G dolce)
  const FINE = new Set(["L", "G"]);

  function parsePage(items, pageNo) {
    const avvisi = [];
    const txt = items.filter(i => i.str && i.str.trim());
    // numero settimana: "SETTIMANA N. 1", "SETTIMANA 2" anche spezzato in due pezzi
    let n = "";
    const sett = txt.find(i => /SETTIMANA/i.test(i.str));
    if (sett) {
      const mm = sett.str.match(/(\d+)\s*$/);
      if (mm) n = mm[1];
      else {
        const near = txt.filter(i => i !== sett && Math.abs(i.y - sett.y) < 8 && i.x > sett.x && /^\s*\d+\s*$/.test(i.str)).sort((a, b) => a.x - b.x)[0];
        if (near) n = near.str.trim();
      }
    }
    // intestazioni di colonna
    const hdr = k => txt.find(i => new RegExp("^\\s*" + k, "i").test(i.str));
    const H = [["primo", hdr("PRIMI")], ["secondo", hdr("SECONDI")], ["contorno", hdr("CONTORNI")]];
    if (H.some(h => !h[1])) { avvisi.push(`Pagina ${pageNo}: intestazioni PRIMI/SECONDI/CONTORNI non trovate, pagina saltata.`); return { n, giorni: [], note: [], avvisi }; }
    const cols = H.map(([cat, it]) => ({ cat, x: it.x, y: it.y })).sort((a, b) => a.x - b.x);
    const yTop = Math.min(...cols.map(c => c.y)) - 4;
    // date (testo verticale o orizzontale a sinistra della prima colonna)
    const dates = [];
    txt.forEach(i => {
      const s = i.str.replace(/\s+/g, "");
      const m = s.match(DATE_RE);
      if (m && i.x < cols[0].x) {
        const cy = i.rot ? i.y + (i.w || 0) / 2 : i.y;
        dates.push({ data: `${m[3]}-${pad(m[2])}-${pad(m[1])}`, cy });
      }
    });
    // righe: un codice nella colonna giusta + testo alla sua destra sulla stessa riga
    const body = txt.filter(i => !i.rot && i.y < yTop);
    const colOf = x => { let c = null; for (const k of cols) if (x >= k.x - 8) c = k; return c; };
    const righe = [];
    body.forEach(i => {
      const s = i.str.trim();
      const c = colOf(i.x);
      if (!c || !CODE_RE.test(s) || Math.abs(i.x - c.x) > 10) return;
      const next = cols[cols.indexOf(c) + 1];
      const xMax = next ? next.x - 8 : Infinity;
      const parts = body.filter(j => j !== i && Math.abs(j.y - i.y) < 9 && j.x > i.x + 4 && j.x < xMax).sort((a, b) => a.x - b.x);
      if (!parts.length) return;
      const raw = parts.map(p => p.str).join(" ");
      if (/PIATTI CONTENENTE/i.test(raw)) return;
      const p = parseNome(raw);
      if (!p.n) return;
      righe.push({ y: i.y, c: s, cat: c.cat === "contorno" && FINE.has(s) ? "fine" : c.cat, ...p });
    });
    // note in fondo (legenda) e righe non attribuibili
    const note = [];
    body.forEach(i => { const s = i.str.trim(); if (/AFF\.?TO\s*:/i.test(s)) note.push(s.replace(/\s+/g, " ")); });
    // attribuisci ogni riga alla data più vicina (centro del testo verticale)
    const giorni = dates.sort((a, b) => b.cy - a.cy).map(d => ({ data: d.data, piatti: [] }));
    if (!giorni.length) { avvisi.push(`Pagina ${pageNo}: nessuna data trovata.`); return { n, giorni: [], note, avvisi }; }
    const ds = dates.slice();
    righe.forEach(r => {
      let best = 0, bd = Infinity;
      ds.forEach((d, k) => { const dd = Math.abs(d.cy - r.y); if (dd < bd) { bd = dd; best = k; } });
      giorni[best].piatti.push(r);
    });
    const ORD = { primo: 0, secondo: 1, contorno: 2, fine: 3 };
    giorni.forEach(g => {
      g.piatti.sort((a, b) => ORD[a.cat] - ORD[b.cat] || b.y - a.y);
      const seen = {};
      g.piatti = g.piatti.filter(p => { if (seen[p.c]) { avvisi.push(`${g.data}: codice ${p.c} ripetuto, tenuto il primo.`); return false; } return (seen[p.c] = true); })
        .map(({ y, ...p }) => p);
      if (g.piatti.length < 15) avvisi.push(`${g.data}: letti solo ${g.piatti.length} piatti, controlla.`);
    });
    giorni.sort((a, b) => a.data.localeCompare(b.data));
    return { n, giorni, note, avvisi };
  }

  function parsePages(pages) {
    const out = { settimane: [], avvisi: [] };
    pages.forEach((items, k) => {
      const r = parsePage(items, k + 1);
      out.avvisi.push(...r.avvisi);
      if (r.giorni.length) out.settimane.push({ n: r.n || String(out.settimane.length + 1), giorni: r.giorni, note: r.note });
    });
    return out;
  }

  // Estrae gli item da un documento pdf.js
  async function itemsFromPdf(doc) {
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const pg = await doc.getPage(p);
      const tc = await pg.getTextContent();
      pages.push(tc.items.map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, rot: Math.abs(i.transform[1]) > Math.abs(i.transform[0]) })));
    }
    return pages;
  }

  const api = { parsePages, parsePage, parseNome, itemsFromPdf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MenuPdf = api;
})(typeof self !== "undefined" ? self : this);
