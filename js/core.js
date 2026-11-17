/* Omet – Mensa · LOGICA COMUNE
   Lo stesso file gira:
   - nel browser in "modalità prova" (dati nel dispositivo, posta simulata);
   - in Google Apps Script come backend vero (dati nel Foglio Google, posta con Gmail), copiato come Core.gs.
   Nessuna dipendenza, tutto sincrono. L'ambiente (env) fornisce archivio, posta, file, orologio, hash.

   CICLO SETTIMANALE (v0.3)
   - La settimana S (lun–ven) si prenota dal lunedì della settimana prima fino al venerdì prima alle 17:00.
   - Alla chiusura: email agli addetti con l'ordine della settimana per il fornitore (PDF + testo WhatsApp)
     e a ogni utente che lo chiede il riepilogo dei suoi pasti.
   - Dopo la chiusura: si può solo annullare entro le 09:30 del giorno stesso (variazioni dei piatti disattivabili).
     Ogni annullamento genera, entro 5 minuti, l'email "VARIAZIONE MENSA" con il totale aggiornato del giorno.
   - Nessuna email il sabato e la domenica: partono il lunedì mattina. */
var MensaCore = (function () {
  "use strict";

  var VERSIONE = "v0.3";
  var DATA_VERSIONE = "17/11/2026";

  /* ---------- schema delle tabelle (anche intestazioni del Foglio) ----------
     Le colonne nuove si aggiungono SOLO in fondo: il Foglio legge per posizione. */
  var SCHEMA = {
    utenti: [["id"], ["username"], ["pinHash"], ["salt"], ["email"], ["mailSettimana", "b"], ["notifiche", "b"], ["ruolo"], ["stato"],
      ["creato"], ["approvatoDa"], ["approvatoIl"], ["errori", "n"], ["bloccatoFino"], ["ultimoAccesso"], ["acqua"]],
    sessioni: [["token"], ["uid"], ["creato"], ["scade"], ["dispositivo"]],
    menu: [["data"], ["lunedi"], ["settimana"], ["cod"], ["nome"], ["all"], ["cat"], ["panna", "b"], ["maiale", "b"], ["pos", "n"]],
    menuNote: [["lunedi"], ["settimana"], ["note"], ["caricatoDa"], ["caricatoIl"], ["origine"]],
    ordini: [["id"], ["data"], ["uid"], ["username"], ["scelte"], ["acqua"], ["nota"], ["stato"], ["creato"], ["modificato"],
      ["inseritoDa"], ["tardivo", "b"], ["ospite", "b"]],
    registro: [["ts"], ["data"], ["uid"], ["username"], ["azione"], ["prima"], ["dopo"], ["entroLimite", "b"], ["da"], ["dopoInvio", "b"],
      ["dopoChiusura", "b"], ["notificato", "b"]],
    invii: [["id"], ["data"], ["ts"], ["da"], ["modo"], ["pasti", "n"], ["file"]],
    posta: [["ts"], ["a"], ["oggetto"], ["tipo"], ["esito"]],
    config: [["chiave"], ["valore", "j"]],
    comunicati: [["data"], ["ts"], ["motivo"], ["conteggi", "j"]]
  };

  var CATS = [["primo", "Primi"], ["secondo", "Secondi"], ["contorno", "Contorni"], ["fine", "Frutta e dolce"]];
  var GIORNI = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
  var GIORNI_B = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];

  var DEF_CFG = {
    aperturaGiorno: 1,          // la settimana dopo si apre il lunedì (1) della settimana prima, alle 00:00
    chiusuraGiorno: 5,          // ...e si chiude il venerdì (5) della settimana prima
    chiusuraOra: "17:00",
    cutoff: "09:30",            // dopo la chiusura: annullamento entro quest'ora del giorno stesso
    variazioni: false,          // dopo la chiusura si possono anche cambiare i piatti (entro lo stesso orario)
    limiti: { primo: 1, secondo: 1, contorno: 1, fine: 1 },
    minPiatti: 1,
    nominativoWhatsApp: false,  // elenco nomi anche nel testo per il fornitore
    approvazione: true,
    emailExtra: "",             // altre caselle per le email agli addetti (separate da virgola)
    emailAmministrazione: "",   // report mensile, primo giorno lavorativo del mese
    mailWeekend: false,         // email anche sabato e domenica
    nomeMensa: "Mensa",
    sessioneGiorni: 180,
    maxErrori: 5,
    bloccoMinuti: 15
  };

  /* ---------- utilità ---------- */
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function pd(s) { var a = s.split("-"); return new Date(+a[0], +a[1] - 1, +a[2], 12, 0, 0); }
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function it(s) { var a = s.split("-"); return a[2] + "/" + a[1] + "/" + a[0]; }
  function lunedi(s) { var d = pd(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); }
  function addDays(s, n) { var d = pd(s); d.setDate(d.getDate() + n); return iso(d); }
  function dow(s) { return pd(s).getDay(); }
  function giornoL(s) { return GIORNI[dow(s)]; }
  function giornoB(s) { return GIORNI_B[dow(s)]; }
  function tsIt(ts) { if (!ts) return ""; var p = ts.split("T"); return it(p[0]) + " ore " + (p[1] || "").slice(0, 5); }
  function cap(s) { s = String(s || "").toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function err(code, msg) { var e = new Error(msg); e.code = code; e.utente = true; return e; }
  function norm(u) { return String(u || "").trim().toLowerCase(); }
  function splitCodes(s) { return String(s || "").split(/\s+/).filter(Boolean); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function uniq(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }
  function passato(n, x) { return n.date > x.date || (n.date === x.date && n.time >= x.time); }   // n è uguale o dopo x
  function periodo(lun) { return it(lun).slice(0, 5) + "–" + it(addDays(lun, 4)).slice(0, 5); }
  function weekend(date) { var g = dow(date); return g === 0 || g === 6; }

  function create(env) {
    var S = env.store, C = env.clock;

    /* ---------- configurazione ---------- */
    var _cfg = null;
    function cfg() {
      if (_cfg) return clone(_cfg);
      var c = clone(DEF_CFG);
      S.rows("config").forEach(function (r) { if (r.chiave in c && r.valore !== null && r.valore !== undefined) c[r.chiave] = r.valore; });
      c.limiti = Object.assign({}, DEF_CFG.limiti, c.limiti || {});
      _cfg = c;
      return clone(c);
    }
    function setCfg(patch) {
      var cur = {}; S.rows("config").forEach(function (r) { cur[r.chiave] = true; });
      Object.keys(patch).forEach(function (k) {
        if (!(k in DEF_CFG)) return;
        if (cur[k]) S.update("config", "chiave", k, { valore: patch[k] });
        else S.insert("config", { chiave: k, valore: patch[k] });
      });
      _cfg = null;
    }

    /* ---------- tempo e finestre ---------- */
    function now() { return C.parts(); }
    function apertura(lun, c) { c = c || cfg(); return { date: addDays(lun, -7 + (+c.aperturaGiorno - 1)), time: "00:00" }; }
    function chiusuraSett(lun, c) { c = c || cfg(); return { date: addDays(lun, -7 + (+c.chiusuraGiorno - 1)), time: c.chiusuraOra }; }
    // stato di un giorno: "futuro" (non ancora prenotabile) · "aperto" (si prenota e si cambia liberamente)
    // "chiuso" (ordine inviato: si può solo annullare entro il cutoff del giorno) · "concluso"
    function statoGiorno(day, c) {
      c = c || cfg(); var n = now(), lun = lunedi(day);
      if (!passato(n, apertura(lun, c))) return "futuro";
      if (!passato(n, chiusuraSett(lun, c))) return "aperto";
      if (passato(n, { date: day, time: c.cutoff })) return "concluso";
      return "chiuso";
    }

    /* ---------- utenti e sessioni ---------- */
    function hashPin(pin, salt) { var h = salt + ":" + pin; for (var i = 0; i < 300; i++) h = env.hash(salt + h); return h; }
    function pubblico(u) {
      return { id: u.id, username: u.username, email: u.email || "", mailSettimana: !!u.mailSettimana, notifiche: !!u.notifiche, ruolo: u.ruolo, stato: u.stato,
        acqua: u.acqua === "G" ? "G" : "N", creato: u.creato, approvatoDa: u.approvatoDa || "", approvatoIl: u.approvatoIl || "", ultimoAccesso: u.ultimoAccesso || "" };
    }
    function utenteDa(token) {
      if (!token) throw err("auth", "Accesso scaduto: entra di nuovo.");
      var s = S.rows("sessioni").filter(function (x) { return x.token === token; })[0];
      if (!s) throw err("auth", "Accesso scaduto: entra di nuovo.");
      if (s.scade && s.scade < now().ts) { S.remove("sessioni", "token", token); throw err("auth", "Accesso scaduto: entra di nuovo."); }
      var u = S.rows("utenti").filter(function (x) { return x.id === s.uid; })[0];
      if (!u || u.stato !== "attivo") throw err("auth", "Utente non attivo.");
      return u;
    }
    function isAddetto(u) { return u.ruolo === "addetto" || u.ruolo === "admin"; }
    function serve(u, liv) {
      if (liv === "admin" && u.ruolo !== "admin") throw err("perm", "Funzione riservata all'amministratore.");
      if (liv === "addetto" && !isAddetto(u)) throw err("perm", "Funzione riservata agli addetti mensa.");
    }
    function checkPin(pin) { if (!/^\d{4,6}$/.test(String(pin || ""))) throw err("pin", "Il PIN deve avere da 4 a 6 cifre."); }
    function emailOk(e) { return !e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

    function registra(p) {
      var username = String(p.username || "").trim().replace(/\s+/g, " ");
      if (username.length < 3 || username.length > 30) throw err("dati", "Il nome utente deve avere da 3 a 30 caratteri.");
      if (!/^[\p{L}\p{N} ._'-]+$/u.test(username)) throw err("dati", "Nel nome utente usa lettere, numeri, spazio, punto, trattino.");
      checkPin(p.pin);
      var email = String(p.email || "").trim();
      if (!emailOk(email)) throw err("dati", "Indirizzo email non valido.");
      if (p.mailSettimana && !email) throw err("dati", "Per ricevere il riepilogo serve un indirizzo email.");
      var tutti = S.rows("utenti");
      if (tutti.some(function (u) { return norm(u.username) === norm(username) && u.stato !== "rifiutato"; })) throw err("dati", "Nome utente già usato: scegline un altro.");
      var c = cfg(), primo = !tutti.some(function (u) { return u.ruolo === "admin" && u.stato === "attivo"; });
      var salt = env.uuid().replace(/-/g, "").slice(0, 16);
      var u = { id: "U" + env.uuid().replace(/-/g, "").slice(0, 10), username: username, pinHash: hashPin(String(p.pin), salt), salt: salt, email: email,
        mailSettimana: !!p.mailSettimana && !!email, notifiche: primo, ruolo: primo ? "admin" : "utente", stato: (primo || !c.approvazione) ? "attivo" : "attesa",
        creato: now().ts, approvatoDa: primo ? "(primo utente)" : (c.approvazione ? "" : "(automatica)"), approvatoIl: primo || !c.approvazione ? now().ts : "",
        errori: 0, bloccatoFino: "", ultimoAccesso: "", acqua: p.acqua === "G" ? "G" : "N" };
      S.insert("utenti", u);
      if (u.stato === "attesa") {
        var adm = S.rows("utenti").filter(function (x) { return x.ruolo === "admin" && x.stato === "attivo" && x.email; }).map(function (x) { return x.email; });
        if (adm.length) manda(adm, "Mensa – nuova registrazione da approvare: " + username,
          "Si è registrato un nuovo utente della mensa:\n\n  " + username + (email ? " (" + email + ")" : "") + "\n  il " + tsIt(u.creato) +
          "\n\nPer approvarlo apri la app, Gestione → Utenti.\n" + (env.appUrl || ""), null, "registrazione");
      }
      return { stato: u.stato, ruolo: u.ruolo, primo: primo };
    }

    function login(p) {
      var u = S.rows("utenti").filter(function (x) { return norm(x.username) === norm(p.username) && x.stato !== "rifiutato"; })[0];
      var generico = err("login", "Nome utente o PIN errati.");
      if (!u) throw generico;
      var n = now(), c = cfg();
      if (u.bloccatoFino && u.bloccatoFino > n.ts) throw err("blocco", "Troppi tentativi: riprova dopo le " + u.bloccatoFino.slice(11, 16) + ".");
      if (hashPin(String(p.pin || ""), u.salt) !== u.pinHash) {
        var e = (+u.errori || 0) + 1, patch = { errori: e };
        if (e >= c.maxErrori) { patch.errori = 0; patch.bloccatoFino = C.parts(new Date(C.now().getTime() + c.bloccoMinuti * 60000)).ts; }
        S.update("utenti", "id", u.id, patch);
        throw generico;
      }
      if (u.stato === "attesa") throw err("attesa", "Registrazione in attesa di approvazione da parte dell'amministratore.");
      if (u.stato === "disattivo") throw err("attesa", "Utente disattivato. Chiedi all'amministratore.");
      var token = env.uuid().replace(/-/g, "") + env.uuid().replace(/-/g, "").slice(0, 8);
      S.insert("sessioni", { token: token, uid: u.id, creato: n.ts, scade: C.parts(new Date(C.now().getTime() + c.sessioneGiorni * 86400000)).ts, dispositivo: String(p.dispositivo || "").slice(0, 80) });
      S.update("utenti", "id", u.id, { errori: 0, bloccatoFino: "", ultimoAccesso: n.ts });
      return { token: token, io: pubblico(u) };
    }
    function esci(u, token) { S.remove("sessioni", "token", token); return { ok: true }; }

    function profilo(u, p) {
      var patch = {};
      if ("email" in p) { var e = String(p.email || "").trim(); if (!emailOk(e)) throw err("dati", "Indirizzo email non valido."); patch.email = e; }
      if ("mailSettimana" in p) patch.mailSettimana = !!p.mailSettimana;
      if ("notifiche" in p && isAddetto(u)) patch.notifiche = !!p.notifiche;
      if ("acqua" in p) patch.acqua = p.acqua === "G" ? "G" : "N";
      var email = "email" in patch ? patch.email : u.email;
      if ((("mailSettimana" in patch) ? patch.mailSettimana : u.mailSettimana) && !email) throw err("dati", "Per ricevere il riepilogo serve un indirizzo email.");
      if (p.nuovoPin) {
        if (hashPin(String(p.vecchioPin || ""), u.salt) !== u.pinHash) throw err("pin", "Il PIN attuale non è corretto.");
        checkPin(p.nuovoPin); patch.pinHash = hashPin(String(p.nuovoPin), u.salt);
      }
      S.update("utenti", "id", u.id, patch);
      return { io: pubblico(Object.assign({}, u, patch)) };
    }

    /* ---------- menu ---------- */
    function piattiDel(day) {
      return S.rows("menu").filter(function (r) { return r.data === day; }).sort(function (a, b) { return a.pos - b.pos; })
        .map(function (r) { return { c: r.cod, n: r.nome, all: r.all || "", cat: r.cat, panna: !!r.panna, maiale: !!r.maiale }; });
    }
    function tutteSettimane() {
      var map = {};
      S.rows("menu").forEach(function (r) { (map[r.lunedi] = map[r.lunedi] || { lunedi: r.lunedi, settimana: r.settimana, giorni: {} }).giorni[r.data] = 1; });
      return Object.keys(map).sort().map(function (k) { var w = map[k]; return { lunedi: k, settimana: w.settimana, giorni: Object.keys(w.giorni).sort() }; });
    }
    // gli utenti vedono solo la settimana in corso e quella dopo; addetti e admin tutte
    function settimaneVisibili(u) {
      var all = tutteSettimane();
      if (isAddetto(u)) return all;
      var l0 = lunedi(now().date), l1 = addDays(l0, 7);
      return all.filter(function (w) { return w.lunedi === l0 || w.lunedi === l1; });
    }
    function chiusa(lun) { return S.rows("comunicati").some(function (r) { return r.motivo === "chiusura" && lunedi(r.data) === lun; }) || passato(now(), chiusuraSett(lun)); }
    function infoSettimana(lun, c) {
      c = c || cfg();
      var ch = chiusuraSett(lun, c), ap = apertura(lun, c);
      var inv = S.rows("comunicati").filter(function (r) { return r.motivo === "chiusura" && lunedi(r.data) === lun; }).sort(function (a, b) { return a.ts < b.ts ? -1 : 1; })[0];
      return { lunedi: lun, periodo: periodo(lun), apre: ap, chiude: ch, aperta: passato(now(), ap) && !passato(now(), ch), chiusa: passato(now(), ch), inviataIl: inv ? inv.ts : "" };
    }
    function settimana(u, p) {
      var lun = p.lunedi, c = cfg();
      if (!isAddetto(u) && !settimaneVisibili(u).some(function (w) { return w.lunedi === lun; })) throw err("perm", "Settimana non disponibile.");
      var giorni = {};
      S.rows("menu").forEach(function (r) { if (r.lunedi === lun) giorni[r.data] = 1; });
      var note = S.rows("menuNote").filter(function (r) { return r.lunedi === lun; })[0];
      var miei = {};
      S.rows("ordini").forEach(function (o) { if (o.uid === u.id && lunedi(o.data) === lun) miei[o.data] = pubOrd(o); });
      return Object.assign(infoSettimana(lun, c), {
        settimana: note ? note.settimana : "", note: note ? String(note.note || "").split("\n").filter(Boolean) : [],
        giorni: Object.keys(giorni).sort().map(function (d) { return { data: d, piatti: piattiDel(d), stato: statoGiorno(d, c), cutoff: c.cutoff, ordine: miei[d] || null }; })
      });
    }
    function salvaMenu(u, p) {
      serve(u, "addetto");
      var sett = p.settimane || [], n = 0;
      sett.forEach(function (w) {
        (w.giorni || []).forEach(function (g) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(g.data)) throw err("dati", "Data non valida: " + g.data);
          var lun = lunedi(g.data);
          S.removeWhere("menu", function (r) { return r.data === g.data; });
          S.insertMany("menu", (g.piatti || []).filter(function (x) { return x.c && x.n; }).map(function (x, i) {
            return { data: g.data, lunedi: lun, settimana: String(w.n || ""), cod: String(x.c).toUpperCase().trim(), nome: String(x.n).trim(), all: x.all || "",
              cat: x.cat, panna: !!x.panna, maiale: !!x.maiale, pos: i };
          }));
          n++;
        });
        uniq((w.giorni || []).map(function (g) { return lunedi(g.data); })).forEach(function (lun) {
          S.removeWhere("menuNote", function (r) { return r.lunedi === lun; });
          S.insert("menuNote", { lunedi: lun, settimana: String(w.n || ""), note: (w.note || []).join("\n"), caricatoDa: u.username, caricatoIl: now().ts, origine: p.origine || "" });
        });
      });
      return { giorni: n };
    }
    function eliminaGiorno(u, p) {
      serve(u, "addetto");
      var ord = S.rows("ordini").filter(function (o) { return o.data === p.data && o.stato === "ok"; }).length;
      if (ord && !p.forza) throw err("ordini", "Ci sono " + ord + " ordini per questo giorno: conferma per eliminarlo comunque.");
      S.removeWhere("menu", function (r) { return r.data === p.data; });
      return { ok: true };
    }

    /* ---------- ordini ---------- */
    function pubOrd(o) {
      return { id: o.id, data: o.data, uid: o.uid, username: o.username, scelte: splitCodes(o.scelte), acqua: o.acqua || "", nota: o.nota || "", stato: o.stato,
        creato: o.creato, modificato: o.modificato, inseritoDa: o.inseritoDa || "", tardivo: !!o.tardivo, ospite: !!o.ospite };
    }
    function nomePiatto(piatti, c) { var p = piatti.filter(function (x) { return x.c === c; })[0]; return p ? cap(p.n) : "?"; }
    function descr(o, piatti) {
      if (!o || o.stato !== "ok") return "nessun pasto";
      return splitCodes(o.scelte).map(function (c) { return c + " " + nomePiatto(piatti, c); }).join(", ") +
        ", acqua " + (o.acqua === "G" ? "gassata" : "naturale") + (o.nota ? " – nota: " + o.nota : "");
    }
    function inviato(day) { return S.rows("comunicati").some(function (r) { return r.data === day; }); }

    function salvaOrdine(u, p) {
      var day = p.data, c = cfg();
      var piatti = piattiDel(day);
      if (!piatti.length) throw err("menu", "Per questo giorno non c'è il menu.");
      var perConto = !!(p.uid && p.uid !== u.id) || !!p.ospite;
      if (perConto) serve(u, "addetto");
      var st = statoGiorno(day, c), dopo = st === "chiuso" || st === "concluso";
      var id0 = day + "_" + (p.uid || u.id), ex0 = S.rows("ordini").filter(function (o) { return o.id === id0; })[0];
      if (!isAddetto(u)) {
        if (st === "futuro") throw err("chiuso", "Le prenotazioni per la settimana del " + it(lunedi(day)) + " si aprono " + giornoL(apertura(lunedi(day), c).date) + " " + it(apertura(lunedi(day), c).date) + ".");
        if (st === "concluso") throw err("chiuso", "Per " + giornoL(day) + " " + it(day) + " non si può più modificare.");
        if (st === "chiuso") {
          if (!c.variazioni) throw err("chiuso", "L'ordine della settimana è già stato inviato: ora puoi solo annullare il pasto entro le " + c.cutoff + " del giorno.");
          if (!ex0 || ex0.stato !== "ok") throw err("chiuso", "L'ordine della settimana è già stato inviato: non si possono aggiungere pasti.");
        }
      }
      var dest;
      if (p.ospite) {
        var nome = String(p.nomeOspite || "").trim();
        if (!nome && !p.uid) throw err("dati", "Scrivi il nome dell'ospite.");
        dest = p.uid ? { id: p.uid, username: (S.rows("ordini").filter(function (o) { return o.uid === p.uid; })[0] || {}).username || nome } : { id: "OSP" + env.uuid().replace(/-/g, "").slice(0, 8), username: "Ospite – " + nome };
      } else if (p.uid && p.uid !== u.id) {
        dest = S.rows("utenti").filter(function (x) { return x.id === p.uid; })[0];
        if (!dest) throw err("dati", "Utente non trovato.");
      } else dest = u;
      var sc = uniq((p.scelte || []).map(function (x) { return String(x).toUpperCase(); }));
      sc.forEach(function (k) { if (!piatti.some(function (x) { return x.c === k; })) throw err("dati", "Codice " + k + " non presente nel menu del giorno."); });
      if (!perConto) CATS.forEach(function (cc) {
        var lim = +c.limiti[cc[0]], n = sc.filter(function (k) { return piatti.filter(function (x) { return x.c === k; })[0].cat === cc[0]; }).length;
        if (n > lim) throw err("regole", cc[1] + ": al massimo " + lim + ".");
      });
      if (sc.length < (+c.minPiatti || 1)) throw err("regole", "Scegli almeno " + (+c.minPiatti || 1) + " piatto.");
      var pref = (S.rows("utenti").filter(function (x) { return x.id === dest.id; })[0] || {}).acqua;
      var acqua = /^[NG]$/.test(p.acqua || "") ? p.acqua : (pref === "G" ? "G" : "N");          // l'acqua c'è sempre
      var nota = String(p.nota || "").slice(0, 120);
      sc.sort(function (a, b) { return piatti.findIndex(function (x) { return x.c === a; }) - piatti.findIndex(function (x) { return x.c === b; }); });
      var id = day + "_" + dest.id, ex = S.rows("ordini").filter(function (o) { return o.id === id; })[0], n = now();
      var row = { id: id, data: day, uid: dest.id, username: dest.username, scelte: sc.join(" "), acqua: acqua, nota: nota, stato: "ok",
        creato: ex ? ex.creato : n.ts, modificato: n.ts, inseritoDa: perConto ? u.username : (ex ? ex.inseritoDa : ""), tardivo: dopo, ospite: !!p.ospite };
      var azione = ex ? (ex.stato === "ok" ? "modifica" : "ripristina") : "prenota";
      var sett = function () { return p.conSettimana ? settimana(u, { lunedi: lunedi(day) }) : undefined; };
      if (ex && ex.stato === "ok" && ex.scelte === row.scelte && (ex.acqua || "") === acqua && (ex.nota || "") === nota) return { ordine: pubOrd(ex), invariato: true, settimana: sett() };
      if (ex) S.update("ordini", "id", id, row); else S.insert("ordini", row);
      registra_(day, dest, azione, descr(ex, piatti), descr(row, piatti), st !== "concluso", u.username, dopo);
      return { ordine: pubOrd(row), settimana: sett() };
    }

    function annullaOrdine(u, p) {
      var day = p.data, c = cfg(), uid = p.uid || u.id;
      if (uid !== u.id) serve(u, "addetto");
      var st = statoGiorno(day, c), dopo = st === "chiuso" || st === "concluso";
      if (!isAddetto(u) && st === "concluso") throw err("chiuso", "Sono passate le " + c.cutoff + ": per annullare chiama gli addetti mensa.");
      var id = day + "_" + uid, ex = S.rows("ordini").filter(function (o) { return o.id === id; })[0];
      var sett = function () { return p.conSettimana ? settimana(u, { lunedi: lunedi(day) }) : undefined; };
      if (!ex) throw err("dati", "Non c'è un ordine da annullare.");
      if (ex.stato !== "ok") return { ok: true, giaAnnullato: true, settimana: sett() };   // doppio invio dopo un errore di rete
      var n = now(), piatti = piattiDel(day);
      S.update("ordini", "id", id, { stato: "annullato", modificato: n.ts, tardivo: dopo, inseritoDa: uid !== u.id ? u.username : ex.inseritoDa });
      registra_(day, { id: uid, username: ex.username }, "annulla", descr(ex, piatti), "nessun pasto", st !== "concluso", u.username, dopo);
      return { ok: true, dopoChiusura: dopo, settimana: sett() };
    }
    function registra_(day, dest, azione, prima, dopo, entro, da, dopoChiusura) {
      S.insert("registro", { ts: now().ts, data: day, uid: dest.id, username: dest.username, azione: azione, prima: prima, dopo: dopo, entroLimite: entro, da: da,
        dopoInvio: !!dopoChiusura, dopoChiusura: !!dopoChiusura, notificato: !dopoChiusura });   // dopo la chiusura: in coda per l'email di variazione
    }

    /* ---------- posta ---------- */
    function manda(to, oggetto, testo, allegato, tipo) {
      to = uniq((Array.isArray(to) ? to : [to]).filter(Boolean));
      if (!to.length) return false;
      var esito = "inviata";
      try { env.mail.send({ to: to, subject: oggetto, body: testo, attachment: allegato || null }); }
      catch (e) { esito = "ERRORE: " + (e && e.message || e); }
      S.insert("posta", { ts: now().ts, a: to.join(", "), oggetto: oggetto, tipo: tipo || "", esito: esito });
      return esito === "inviata";
    }
    function emailAddetti() {
      var c = cfg();
      var l = S.rows("utenti").filter(function (x) { return isAddetto(x) && x.stato === "attivo" && x.notifiche && x.email; }).map(function (x) { return x.email; });
      String(c.emailExtra || "").split(/[,;\s]+/).filter(Boolean).filter(emailOk).forEach(function (e) { l.push(e); });
      return uniq(l);
    }

    /* ---------- conteggi e testi per il fornitore ---------- */
    function conteggi(day) {
      var k = { pasti: 0, cod: {}, acqua: { N: 0, G: 0 }, ospiti: 0 };
      S.rows("ordini").forEach(function (o) {
        if (o.data !== day || o.stato !== "ok") return;
        k.pasti++; if (o.ospite) k.ospiti++;
        k.acqua[o.acqua === "G" ? "G" : "N"]++;
        splitCodes(o.scelte).forEach(function (c) { k.cod[c] = (k.cod[c] || 0) + 1; });
      });
      return k;
    }
    function ultimoComunicato(day) {
      return S.rows("comunicati").filter(function (r) { return r.data === day; }).sort(function (a, b) { return a.ts < b.ts ? 1 : -1; })[0] || null;
    }
    function differenze(prima, ora, piatti) {
      if (!prima) return "";
      var parti = [], dp = ora.pasti - prima.pasti;
      var codes = uniq(Object.keys(prima.cod || {}).concat(Object.keys(ora.cod)));
      codes.sort(function (a, b) { return piatti.findIndex(function (x) { return x.c === a; }) - piatti.findIndex(function (x) { return x.c === b; }); });
      codes.forEach(function (c) { var d = (ora.cod[c] || 0) - ((prima.cod || {})[c] || 0); if (d) parti.push(c + " " + (d > 0 ? "+" : "−") + Math.abs(d)); });
      ["N", "G"].forEach(function (a) { var d = ora.acqua[a] - ((prima.acqua || {})[a] || 0); if (d) parti.push("acqua " + (a === "N" ? "nat." : "gass.") + " " + (d > 0 ? "+" : "−") + Math.abs(d)); });
      if (!dp && !parti.length) return "nessuna differenza";
      return (dp ? (dp > 0 ? "+" : "−") + Math.abs(dp) + (Math.abs(dp) === 1 ? " pasto" : " pasti") : "stessi pasti") + (parti.length ? " (" + parti.join(", ") + ")" : "");
    }
    function bloccoGiorno(day, k, piatti, wa) {   // testo per il fornitore di un giorno
      var B = wa ? "*" : "", I = wa ? "_" : "";
      var t = B + cap(giornoL(day)) + " " + it(day) + B + " – pasti: " + B + k.pasti + B + (k.ospiti ? " (di cui ospiti " + k.ospiti + ")" : "") + "\n";
      if (!k.pasti) return t;
      CATS.forEach(function (cc) {
        var r = piatti.filter(function (x) { return x.cat === cc[0] && k.cod[x.c]; }).map(function (x) { return x.c + " " + cap(x.n) + ": " + B + k.cod[x.c] + B; });
        if (r.length) t += I + cc[1] + I + "\n" + r.join("\n") + "\n";
      });
      t += I + "Acqua" + I + "\nNaturale: " + B + k.acqua.N + B + "\nGassata: " + B + k.acqua.G + B + "\n";
      return t;
    }
    function noteGiorno(day) {
      return S.rows("ordini").filter(function (o) { return o.data === day && o.stato === "ok" && o.nota; }).map(function (o) { return o.username + ": " + o.nota; });
    }
    function nominativo(day) {
      return S.rows("ordini").filter(function (o) { return o.data === day && o.stato === "ok"; }).sort(function (a, b) { return a.username.localeCompare(b.username); })
        .map(function (o) { return o.username + ": " + o.scelte + " · " + (o.acqua || "N"); });
    }
    function testoGiorno(day, wa, intest) {
      var c = cfg(), piatti = piattiDel(day), k = conteggi(day);
      var t = (wa ? "*OMET – " + (intest || "ORDINE MENSA") + "*\n" : "OMET – " + (intest || "ORDINE MENSA") + "\n") + bloccoGiorno(day, k, piatti, wa);
      var nt = noteGiorno(day); if (nt.length) t += (wa ? "_Note_" : "Note") + "\n" + nt.join("\n") + "\n";
      if (c.nominativoWhatsApp) t += (wa ? "_Nominativo_" : "Nominativo") + "\n" + nominativo(day).join("\n") + "\n";
      return t;
    }
    function testoSettimana(lun, wa) {
      var c = cfg(), giorni = giorniSettimana(lun);
      var t = (wa ? "*OMET – ORDINE MENSA settimana " + periodo(lun) + "*\n" : "OMET – ORDINE MENSA settimana " + periodo(lun) + "\n");
      t += "Totale pasti: " + (wa ? "*" : "") + giorni.reduce(function (s, d) { return s + conteggi(d).pasti; }, 0) + (wa ? "*" : "") + "\n";
      giorni.forEach(function (d) {
        t += "\n" + bloccoGiorno(d, conteggi(d), piattiDel(d), wa);
        var nt = noteGiorno(d); if (nt.length) t += (wa ? "_Note_" : "Note") + "\n" + nt.join("\n") + "\n";
        if (c.nominativoWhatsApp) t += (wa ? "_Nominativo_" : "Nominativo") + "\n" + nominativo(d).join("\n") + "\n";
      });
      return t;
    }
    function giorniSettimana(lun) {
      var g = {}; S.rows("menu").forEach(function (r) { if (r.lunedi === lun) g[r.data] = 1; });
      return Object.keys(g).sort();
    }

    /* ---------- documenti stampabili (HTML: lo converte anche Google Drive) ---------- */
    var B_ = "#093E83", L_ = "#D7DEE8", BAND_ = "#EEF3F9";
    var TD = "border:1px solid " + L_ + ";padding:3px 5px;font-size:10px;";
    var TH = TD + "background:" + B_ + ";color:#fff;font-weight:600;";
    function testata(titolo) {
      return '<table style="width:100%;border-collapse:collapse;margin-bottom:8px"><tr><td style="background:' + B_ + ';color:#fff;padding:7px 10px;font-size:10px;letter-spacing:.08em">OMET FOODTECH · MENSA</td>' +
        '<td style="background:' + B_ + ';color:#fff;padding:7px 10px;font-size:15px;font-weight:600;text-align:right">' + esc(titolo) + "</td></tr></table>";
    }
    function piede(stamp) {
      return '<p style="font-size:9px;color:#5D6B7C;border-top:1px solid ' + L_ + ';padding-top:4px;margin-top:12px">Omet Foodtech · Mensa ' + VERSIONE + " del " + DATA_VERSIONE + " · " + esc(stamp || "") + "</p>";
    }
    function htmlRiepilogo(day, stamp, titolo) {   // un giorno: totali + foglio nominativo
      var c = cfg(), piatti = piattiDel(day), k = conteggi(day);
      var ok = S.rows("ordini").filter(function (o) { return o.data === day && o.stato === "ok"; }).map(pubOrd).sort(function (a, b) { return (a.ospite - b.ospite) || a.username.localeCompare(b.username); });
      var ann = S.rows("ordini").filter(function (o) { return o.data === day && o.stato === "annullato"; }).map(pubOrd);
      var h = '<div class="foglio" style="font-family:Segoe UI,Arial,sans-serif;color:#1B2430;">' + testata((titolo || "Ordine") + " " + giornoL(day) + " " + it(day));
      h += '<table style="border-collapse:collapse;margin-bottom:8px"><tr>' +
        [["PASTI", k.pasti], k.ospiti ? ["DI CUI OSPITI", k.ospiti] : null, ["ACQUA NAT. / GASS.", k.acqua.N + " / " + k.acqua.G], ["ANNULLATI", ann.length]].filter(Boolean)
          .map(function (x) { return '<td style="padding:2px 18px 2px 0;font-size:10px;color:#5D6B7C">' + x[0] + '<br><b style="font-size:20px;color:#1B2430">' + x[1] + "</b></td>"; }).join("") + "</tr></table>";
      h += '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr>';
      CATS.forEach(function (cc) {
        h += '<td style="vertical-align:top;padding-right:8px;width:25%"><table style="width:100%;border-collapse:collapse"><tr><th colspan="3" style="' + TH + 'text-align:left">' + cc[1].toUpperCase() + "</th></tr>";
        piatti.filter(function (x) { return x.cat === cc[0]; }).forEach(function (x) {
          var n = k.cod[x.c] || 0;
          h += '<tr><td style="' + TD + 'font-family:Consolas,monospace;font-weight:700;color:' + B_ + ';width:16px">' + esc(x.c) + '</td><td style="' + TD + '">' + esc(cap(x.n)) +
            '</td><td style="' + TD + 'text-align:right;font-weight:700;width:22px;' + (n ? "" : "color:#AEB6C4;") + '">' + (n || "–") + "</td></tr>";
        });
        h += "</table></td>";
      });
      h += "</tr></table>";
      var codes = piatti.map(function (x) { return x.c; });
      h += '<table style="width:100%;border-collapse:collapse"><tr><th style="' + TH + 'text-align:left">NOMINATIVO</th>' + codes.map(function (x) { return '<th style="' + TH + 'text-align:center;padding:3px 2px">' + esc(x) + "</th>"; }).join("") +
        '<th style="' + TH + '">ACQUA</th><th style="' + TH + 'text-align:left">NOTE</th></tr>';
      ok.forEach(function (o, i) {
        var bg = i % 2 ? "background:" + BAND_ + ";" : "";
        h += '<tr><td style="' + TD + bg + 'white-space:nowrap">' + esc(o.username) + (o.inseritoDa ? ' <span style="color:#C76A00">(' + (o.ospite ? "ospite, " : "") + "ins. " + esc(o.inseritoDa) + ")</span>" : "") + "</td>" +
          codes.map(function (x) { return '<td style="' + TD + bg + 'text-align:center;padding:3px 2px;font-weight:700">' + (o.scelte.indexOf(x) >= 0 ? "X" : "") + "</td>"; }).join("") +
          '<td style="' + TD + bg + 'text-align:center">' + (o.acqua || "N") + '</td><td style="' + TD + bg + '">' + esc(o.nota) + "</td></tr>";
      });
      h += '<tr><td style="' + TD + 'font-weight:700;background:' + BAND_ + '">TOTALE</td>' + codes.map(function (x) { return '<td style="' + TD + 'text-align:center;padding:3px 2px;font-weight:700;background:' + BAND_ + '">' + (k.cod[x] || "") + "</td>"; }).join("") +
        '<td style="' + TD + 'text-align:center;font-weight:700;background:' + BAND_ + '">' + k.acqua.N + "N " + k.acqua.G + 'G</td><td style="' + TD + "background:" + BAND_ + '"></td></tr></table>';
      if (ann.length) h += '<p style="font-size:9px;color:#5D6B7C;margin:6px 0 0">Annullati: ' + ann.map(function (o) { return esc(o.username) + (o.tardivo ? " (dopo la chiusura)" : ""); }).join(", ") + "</p>";
      return h + piede(stamp) + "</div>";
    }
    function htmlSettimana(lun, stamp) {   // ordine per il fornitore: un giorno per colonna, solo totali
      var giorni = giorniSettimana(lun), tot = 0;
      var cols = giorni.map(function (d) { var k = conteggi(d); tot += k.pasti; return { d: d, k: k, p: piattiDel(d) }; });
      var h = '<div class="foglio" style="font-family:Segoe UI,Arial,sans-serif;color:#1B2430;">' + testata("Ordine mensa settimana " + periodo(lun)) +
        '<p style="font-size:11px;margin:0 0 8px">Totale pasti della settimana: <b style="font-size:16px">' + tot + "</b></p>";
      h += '<table style="width:100%;border-collapse:collapse;table-layout:fixed"><tr>' + cols.map(function (x) {
        return '<th style="' + TH + 'font-size:11px;text-align:left">' + esc(cap(giornoL(x.d))) + " " + it(x.d).slice(0, 5) + '<span style="float:right">' + x.k.pasti + (x.k.pasti === 1 ? " pasto" : " pasti") + "</span></th>"; }).join("") + "</tr><tr>";
      cols.forEach(function (x) {
        var cell = '<table style="width:100%;border-collapse:collapse">';
        CATS.forEach(function (cc) {
          var rr = x.p.filter(function (y) { return y.cat === cc[0]; });
          if (!rr.length) return;
          cell += '<tr><td colspan="3" style="' + TD + 'background:' + BAND_ + ';font-weight:600;font-size:9px;letter-spacing:.06em">' + cc[1].toUpperCase() + "</td></tr>";
          rr.forEach(function (y) { var n = x.k.cod[y.c] || 0;
            cell += '<tr><td style="' + TD + 'font-family:Consolas,monospace;font-weight:700;color:' + B_ + ';width:14px">' + esc(y.c) + '</td><td style="' + TD + (n ? "" : "color:#AEB6C4;") + '">' + esc(cap(y.n)) +
              '</td><td style="' + TD + 'text-align:right;font-weight:700;width:20px;' + (n ? "" : "color:#AEB6C4;") + '">' + (n || "–") + "</td></tr>"; });
        });
        cell += '<tr><td colspan="2" style="' + TD + 'background:' + BAND_ + ';font-weight:600">Acqua nat. / gass.</td><td style="' + TD + 'background:' + BAND_ + ';text-align:right;font-weight:700;white-space:nowrap">' + x.k.acqua.N + "/" + x.k.acqua.G + "</td></tr>";
        var nt = noteGiorno(x.d);
        if (nt.length) cell += '<tr><td colspan="3" style="' + TD + 'font-size:9px">Note: ' + nt.map(esc).join("; ") + "</td></tr>";
        h += '<td style="vertical-align:top;padding:0 3px 0 0">' + cell + "</table></td>";
      });
      return h + "</tr></table>" + piede(stamp) + "</div>";
    }
    function htmlPersonale(u, lun, stamp) {
      var giorni = giorniSettimana(lun);
      var h = '<div class="foglio" style="font-family:Segoe UI,Arial,sans-serif;color:#1B2430;">' + testata("I pasti di " + u.username + " · settimana " + periodo(lun)) +
        '<table style="width:100%;border-collapse:collapse"><tr><th style="' + TH + 'text-align:left;width:22%">GIORNO</th><th style="' + TH + 'text-align:left">PIATTI</th><th style="' + TH + 'width:12%">ACQUA</th></tr>';
      giorni.forEach(function (d, i) {
        var o = S.rows("ordini").filter(function (x) { return x.data === d && x.uid === u.id; })[0], p = piattiDel(d), bg = i % 2 ? "background:" + BAND_ + ";" : "";
        var ok = o && o.stato === "ok";
        h += '<tr><td style="' + TD + bg + 'font-size:12px;font-weight:600">' + esc(cap(giornoL(d))) + " " + it(d) + '</td><td style="' + TD + bg + 'font-size:12px">' +
          (ok ? splitCodes(o.scelte).map(function (c) { return "<b>" + esc(c) + "</b> " + esc(nomePiatto(p, c)); }).join(" · ") + (o.nota ? " <i>(" + esc(o.nota) + ")</i>" : "") : '<span style="color:#6B7785">nessun pasto</span>') +
          '</td><td style="' + TD + bg + 'font-size:12px;text-align:center">' + (ok ? (o.acqua === "G" ? "gassata" : "naturale") : "") + "</td></tr>";
      });
      return h + "</table>" + piede(stamp) + "</div>";
    }
    function testoPersonale(u, lun) {
      var c = cfg();
      var t = "Ciao " + u.username + ",\necco i tuoi pasti della settimana " + periodo(lun) + ":\n\n";
      giorniSettimana(lun).forEach(function (d) {
        var o = S.rows("ordini").filter(function (x) { return x.data === d && x.uid === u.id; })[0], p = piattiDel(d);
        t += cap(giornoB(d)) + " " + it(d).slice(0, 5) + "  " + (o && o.stato === "ok" ? splitCodes(o.scelte).map(function (x) { return nomePiatto(p, x); }).join(", ") + " · acqua " + (o.acqua === "G" ? "gassata" : "naturale") : "nessun pasto") + "\n";
      });
      return t + "\nSe non puoi venire, annulla dalla app entro le " + c.cutoff + " del giorno.\n" + (env.appUrl || "");
    }
    function docHtml(body, titolo) {
      return '<!doctype html><html lang="it"><head><meta charset="utf-8"><title>' + esc(titolo) + '</title><style>@page{size:A4 landscape;margin:10mm}body{margin:0}' +
        ".foglio{page-break-after:always}.foglio:last-child{page-break-after:auto}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head><body>" + body + "</body></html>";
    }
    function stampa(chi, auto) { return "Stampa del " + tsIt(now().ts) + " · " + (auto ? "generato automaticamente" : "da " + chi); }

    /* ---------- riepiloghi per addetti ---------- */
    function riep(day) {
      var piatti = piattiDel(day), c = cfg();
      var tutti = S.rows("ordini").filter(function (o) { return o.data === day; }).map(pubOrd);
      var ok = tutti.filter(function (o) { return o.stato === "ok"; }).sort(function (a, b) { return (a.ospite - b.ospite) || a.username.localeCompare(b.username); });
      var ann = tutti.filter(function (o) { return o.stato === "annullato"; });
      var k = conteggi(day), ult = ultimoComunicato(day);
      var reg = S.rows("registro").filter(function (r) { return r.data === day; }).sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
      var inv = S.rows("invii").filter(function (i) { return i.data === day; }).sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
      var senza = S.rows("utenti").filter(function (x) { return x.stato === "attivo" && !tutti.some(function (o) { return o.uid === x.id; }); })
        .map(function (x) { return { id: x.id, username: x.username }; }).sort(function (a, b) { return a.username.localeCompare(b.username); });
      return {
        data: day, giorno: giornoL(day), piatti: piatti, ok: ok, annullati: ann, conteggi: k.cod, acqua: k.acqua, ospiti: k.ospiti,
        stato: statoGiorno(day, c), cutoff: c.cutoff, registro: reg.slice(0, 200), invii: inv, senzaOrdine: senza,
        comunicato: ult ? { ts: ult.ts, motivo: ult.motivo, differenze: differenze(ult.conteggi, k, piatti) } : null
      };
    }
    function riepilogo(u, p) {
      serve(u, "addetto");
      var r = riep(p.data), titolo = "mensa_ordine_" + p.data;
      r.titolo = titolo;
      r.html = docHtml(htmlRiepilogo(p.data, stampa(u.username)), titolo);
      r.whatsapp = testoGiorno(p.data, true) + "\nInviato da " + u.username + " il " + tsIt(now().ts);
      return r;
    }
    function riepilogoSettimana(u, p) {
      serve(u, "addetto");
      var lun = p.lunedi, giorni = giorniSettimana(lun), titolo = "mensa_settimana_" + lun;
      return Object.assign(infoSettimana(lun), {
        giorni: giorni.map(function (d) { var k = conteggi(d); return { data: d, pasti: k.pasti, ospiti: k.ospiti, acqua: k.acqua, cod: k.cod, piatti: piattiDel(d), stato: statoGiorno(d) }; }),
        titolo: titolo, html: docHtml(htmlSettimana(lun, stampa(u.username)), titolo),
        whatsapp: testoSettimana(lun, true) + "\nInviato da " + u.username + " il " + tsIt(now().ts)
      });
    }
    function registraInvio(u, p) {
      serve(u, "addetto");
      var giorni = p.lunedi ? giorniSettimana(p.lunedi) : [p.data], n = now();
      giorni.forEach(function (d) { S.insert("invii", { id: env.uuid().slice(0, 8), data: d, ts: n.ts, da: u.username, modo: (p.modo || "app") + (p.lunedi ? " (settimana)" : ""), pasti: conteggi(d).pasti, file: "" }); });
      return { ok: true };
    }
    function documento(u, p) {   // PDF di più giorni (archivio) o personale
      if (p.personale) {
        var lunp = p.lunedi, tp = "mensa_" + u.username.replace(/\W+/g, "_") + "_" + lunp;
        return { html: docHtml(htmlPersonale(u, lunp, stampa(u.username)), tp), titolo: tp };
      }
      serve(u, "addetto");
      var days = p.giorni || [p.data], st = stampa(u.username);
      var titolo = days.length > 1 ? "mensa_giorni_" + days[0] : "mensa_ordine_" + days[0];
      return { html: docHtml(days.map(function (d) { return htmlRiepilogo(d, st); }).join(""), titolo), titolo: titolo };
    }
    function inviaRiepilogo(u, p) {   // "Invia riepilogo via email" a chi lo chiede
      serve(u, "addetto");
      if (!u.email) throw err("dati", "Metti prima la tua email nel profilo.");
      var ok;
      if (p.lunedi) {
        var t = "mensa_settimana_" + p.lunedi;
        ok = manda(u.email, "Mensa – ordine settimana " + periodo(p.lunedi), testoSettimana(p.lunedi, false) + "\n----- testo per WhatsApp -----\n" + testoSettimana(p.lunedi, true),
          { name: t + ".pdf", html: docHtml(htmlSettimana(p.lunedi, stampa(u.username)), t) }, "riepilogo");
      } else {
        var t2 = "mensa_ordine_" + p.data;
        ok = manda(u.email, "Mensa – riepilogo " + giornoL(p.data) + " " + it(p.data), testoGiorno(p.data, false) + "\n----- testo per WhatsApp -----\n" + testoGiorno(p.data, true),
          { name: t2 + ".pdf", html: docHtml(htmlRiepilogo(p.data, stampa(u.username)), t2) }, "riepilogo");
      }
      if (!ok) throw err("posta", "Invio non riuscito: vedi Impostazioni → Posta.");
      return { ok: true, a: u.email };
    }

    /* ---------- archivio settimanale ---------- */
    function archivio(u, p) {
      serve(u, "addetto");
      var lun = p.lunedi;
      return Object.assign(infoSettimana(lun), {
        giorni: giorniSettimana(lun).map(function (d) {
          var r = riep(d);
          return { data: d, pasti: r.ok.length, ospiti: r.ospiti, annullati: r.annullati.length, variazioni: r.registro.filter(function (x) { return x.dopoChiusura; }).length,
            invii: r.invii, comunicati: S.rows("comunicati").filter(function (x) { return x.data === d; }).map(function (x) { return { ts: x.ts, motivo: x.motivo, pasti: (x.conteggi || {}).pasti }; }) };
        })
      });
    }

    /* ---------- report mensile ---------- */
    function calcReport(mese) {
      var ord = S.rows("ordini").filter(function (o) { return o.data.slice(0, 7) === mese; });
      var reg = S.rows("registro").filter(function (r) { return r.data.slice(0, 7) === mese; });
      var per = {};
      function riga(uid, nome) { return per[uid] || (per[uid] = { uid: uid, username: nome, pasti: 0, annullati: 0, variazioni: 0, perConto: 0, ospite: false }); }
      ord.forEach(function (o) { var r = riga(o.uid, o.username); if (o.stato === "ok") r.pasti++; if (o.ospite) r.ospite = true; if (o.inseritoDa) r.perConto++; });
      reg.forEach(function (x) {   // contano solo le modifiche fatte DOPO l'invio dell'ordine al fornitore
        if (!x.dopoChiusura) return;
        var r = riga(x.uid, x.username);
        if (x.azione === "annulla") r.annullati++; else r.variazioni++;
      });
      var righe = Object.keys(per).map(function (k) { return per[k]; }).sort(function (a, b) { return (b.annullati - a.annullati) || a.username.localeCompare(b.username); });
      var giorni = {}; ord.forEach(function (o) { if (o.stato === "ok") giorni[o.data] = (giorni[o.data] || 0) + 1; });
      var tot = righe.reduce(function (s, r) { s.pasti += r.pasti; s.variazioni += r.variazioni; s.annullati += r.annullati; return s; }, { pasti: 0, variazioni: 0, annullati: 0 });
      var piattiCache = {};
      var dettaglio = ord.slice().sort(function (a, b) { return a.data.localeCompare(b.data) || a.username.localeCompare(b.username); }).map(function (o) {
        var p = piattiCache[o.data] || (piattiCache[o.data] = piattiDel(o.data));
        var an = reg.filter(function (x) { return x.uid === o.uid && x.data === o.data && x.azione === "annulla"; }).sort(function (a, b) { return a.ts < b.ts ? 1 : -1; })[0];
        return { data: o.data, giorno: giornoL(o.data), username: o.username, stato: o.stato === "ok" ? "Consumato" : "Annullato",
          codici: o.scelte, piatti: splitCodes(o.scelte).map(function (c) { return nomePiatto(p, c); }).join(", "), acqua: o.acqua === "G" ? "Gassata" : "Naturale",
          nota: o.nota || "", annullatoIl: o.stato !== "ok" && an ? an.ts : "", dopoChiusura: o.stato !== "ok" && an ? !!an.dopoChiusura : false,
          inseritoDa: o.inseritoDa || "", ospite: !!o.ospite };
      });
      return {
        mese: mese, righe: righe, totali: tot, perGiorno: Object.keys(giorni).sort().map(function (d) { return { data: d, giorno: giornoL(d), pasti: giorni[d] }; }),
        dettaglio: dettaglio, annullamenti: reg.filter(function (x) { return x.azione === "annulla" && x.dopoChiusura; }).sort(function (a, b) { return a.ts < b.ts ? -1 : 1; })
      };
    }
    function csvReport(R) {
      var q = function (v) { v = String(v == null ? "" : v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      var L = [["REPORT MENSA " + R.mese], [], ["Utente", "Pasti consumati", "Annullamenti dopo l'invio", "Variazioni dopo l'invio", "Inseriti da addetti", "Ospite"]];
      R.righe.forEach(function (r) { L.push([r.username, r.pasti, r.annullati, r.variazioni, r.perConto, r.ospite ? "SI" : ""]); });
      L.push(["TOTALE", R.totali.pasti, R.totali.annullati, R.totali.variazioni]);
      return "﻿" + L.map(function (r) { return r.map(q).join(";"); }).join("\r\n");
    }

    /* ---------- utenti (admin) ---------- */
    function utenti(u) {
      serve(u, "admin");
      return { utenti: S.rows("utenti").map(pubblico).sort(function (a, b) { return (a.stato === "attesa" ? 0 : 1) - (b.stato === "attesa" ? 0 : 1) || a.username.localeCompare(b.username); }) };
    }
    function gestisciUtente(u, p) {
      serve(u, "admin");
      var x = S.rows("utenti").filter(function (y) { return y.id === p.id; })[0];
      if (!x) throw err("dati", "Utente non trovato.");
      var patch = {}, n = now(), ris = {};
      if (x.id === u.id && (p.azione === "disattiva" || p.azione === "ruolo" || p.azione === "rifiuta")) throw err("dati", "Non puoi modificare il tuo ruolo o disattivarti da solo.");
      if (p.azione === "approva") {
        patch = { stato: "attivo", approvatoDa: u.username, approvatoIl: n.ts, ruolo: p.ruolo || x.ruolo || "utente" };
        if (patch.ruolo !== "utente") patch.notifiche = true;
        if (x.email) manda(x.email, "Mensa Omet – registrazione approvata", "Ciao " + x.username + ",\nla tua registrazione alla mensa è stata approvata da " + u.username + ".\nOra puoi entrare con il tuo nome utente e PIN.\n\n" + (env.appUrl || ""), null, "approvazione");
      } else if (p.azione === "rifiuta") patch = { stato: "rifiutato", approvatoDa: u.username, approvatoIl: n.ts };
      else if (p.azione === "disattiva") patch = { stato: "disattivo" };
      else if (p.azione === "riattiva") patch = { stato: "attivo" };
      else if (p.azione === "ruolo") { if (["utente", "addetto", "admin"].indexOf(p.ruolo) < 0) throw err("dati", "Ruolo non valido."); patch = { ruolo: p.ruolo, notifiche: p.ruolo !== "utente" }; }
      else if (p.azione === "notifiche") patch = { notifiche: !x.notifiche };
      else if (p.azione === "resetPin") {
        var pin = String(1000 + Math.floor(Math.random() * 9000));
        patch = { pinHash: hashPin(pin, x.salt), errori: 0, bloccatoFino: "" }; ris.pin = pin;
        S.removeWhere("sessioni", function (s) { return s.uid === x.id; });
      } else throw err("dati", "Azione non valida.");
      if (p.azione === "disattiva" || p.azione === "rifiuta") S.removeWhere("sessioni", function (s) { return s.uid === x.id; });
      S.update("utenti", "id", x.id, patch);
      ris.utente = pubblico(Object.assign({}, x, patch));
      return ris;
    }

    /* ---------- lavori a orario (controllo ogni 5 minuti nel backend) ---------- */
    function giaFatto(chiave) { return S.rows("config").some(function (r) { return r.chiave === "_fatto_" + chiave; }); }
    function segnaFatto(chiave) { S.insert("config", { chiave: "_fatto_" + chiave, valore: now().ts }); }
    function salvaComunicato(day, motivo) { S.insert("comunicati", { data: day, ts: now().ts, motivo: motivo, conteggi: conteggi(day) }); }

    function chiudiSettimana(lun, conEmail) {
      var c = cfg(), n = now(), giorni = giorniSettimana(lun);
      giorni.forEach(function (d) { salvaComunicato(d, conEmail ? "chiusura" : "riferimento"); });   // "riferimento": settimana già iniziata, nessuna email
      // le modifiche già in coda per questi giorni sono comprese nel totale appena inviato
      S.rows("registro").forEach(function (r) { if (!r.notificato && lunedi(r.data) === lun) S.update("registro", "ts", r.ts, { notificato: true }); });
      if (!conEmail) return "chiusura " + lun + " (senza email)";
      var t = "mensa_settimana_" + lun, st = stampa("", true);
      var url = "";
      try { if (env.files) url = env.files.salvaPdf(lun, docHtml(htmlSettimana(lun, st), t), t) || ""; } catch (e) { url = ""; }
      giorni.forEach(function (d) { S.insert("invii", { id: env.uuid().slice(0, 8), data: d, ts: n.ts, da: "automatico", modo: "chiusura settimana", pasti: conteggi(d).pasti, file: url }); });
      manda(emailAddetti(), "Mensa – ORDINE SETTIMANA " + periodo(lun) + " – " + (function (n) { return n + (n === 1 ? " pasto" : " pasti"); })(giorni.reduce(function (s, d) { return s + conteggi(d).pasti; }, 0)),
        "Prenotazioni chiuse " + giornoL(n.date) + " " + it(n.date) + " alle " + c.chiusuraOra + ".\nIn allegato l'ordine della settimana in PDF; qui sotto il testo da girare alla mensa (WhatsApp).\n\n" +
        "----------\n" + testoSettimana(lun, true) + "----------\n" + (url ? "\nCopia nell'archivio: " + url + "\n" : "") + "\n" + (env.appUrl || ""),
        { name: t + ".pdf", html: docHtml(htmlSettimana(lun, st), t) }, "chiusura");
      // riepilogo personale a chi lo vuole
      S.rows("utenti").filter(function (x) { return x.stato === "attivo" && x.mailSettimana && x.email; }).forEach(function (x) {
        manda(x.email, "Mensa – i tuoi pasti della settimana " + periodo(lun), testoPersonale(x, lun), null, "personale");
      });
      return "chiusura " + lun;
    }
    function mandaVariazioni() {
      var n = now();
      var coda = S.rows("registro").filter(function (r) { return r.dopoChiusura && !r.notificato; });
      if (!coda.length) return "";
      var giorni = uniq(coda.map(function (r) { return r.data; })).sort();
      var futuri = giorni.filter(function (d) { return d >= n.date; });
      var segna = function () { coda.forEach(function (r) { S.update("registro", "ts", r.ts, { notificato: true }); }); };
      if (!futuri.length) { segna(); return ""; }
      var t = "", wa = "";
      futuri.forEach(function (d) {
        var prima = ultimoComunicato(d), k = conteggi(d), p = piattiDel(d);
        var chi = coda.filter(function (r) { return r.data === d; }).map(function (r) { return "  " + tsIt(r.ts).slice(11) + " " + r.username + ": " + ({ annulla: "annullato", modifica: "modificato", ripristina: "aggiunto", prenota: "aggiunto" }[r.azione] || r.azione) + (r.da !== r.username ? " (da " + r.da + ")" : ""); });
        t += "VARIAZIONE MENSA – " + giornoL(d).toUpperCase() + " " + it(d) + "\nModifica del " + tsIt(n.ts) + "\n\n" + bloccoGiorno(d, k, p, false) +
          "\nRispetto all'ultimo totale comunicato" + (prima ? " (" + tsIt(prima.ts) + ")" : "") + ": " + differenze(prima && prima.conteggi, k, p) + "\n" +
          "Dettaglio (solo per gli addetti):\n" + chi.join("\n") + "\n\n";
        wa += "*OMET – VARIAZIONE MENSA*\n" + bloccoGiorno(d, k, p, true) + "Modifica del " + tsIt(n.ts) + "\n\n";
        salvaComunicato(d, "variazione");
      });
      segna();
      var ogg = "Mensa – VARIAZIONE " + futuri.map(function (d) { return giornoL(d) + " " + it(d).slice(0, 5); }).join(", ");
      manda(emailAddetti(), ogg, t + "----- testo per WhatsApp -----\n" + wa + (env.appUrl || ""), null, "variazione");
      return "variazioni " + futuri.join(",");
    }
    function tick() {
      var c = cfg(), n = now(), fatti = [];
      var limite = addDays(n.date, -40);
      if (S.rows("config").some(function (r) { return r.chiave.indexOf("_fatto_") === 0 && String(r.valore || "").slice(0, 10) < limite; }))
        S.removeWhere("config", function (r) { return r.chiave.indexOf("_fatto_") === 0 && String(r.valore || "").slice(0, 10) < limite; });
      var feriale = c.mailWeekend || !weekend(n.date);
      // 1) chiusura della settimana: snapshot + email (se la settimana non è ancora cominciata e non è weekend)
      var l0 = lunedi(n.date);
      [l0, addDays(l0, 7)].forEach(function (lun) {
        if (!giorniSettimana(lun).length || giaFatto("chiusura_" + lun) || !passato(n, chiusuraSett(lun, c))) return;
        var conEmail = n.date < lun && feriale;
        if (!conEmail && n.date < lun) return;            // weekend: aspetta (in pratica la chiusura è il venerdì)
        segnaFatto("chiusura_" + lun);
        fatti.push(chiudiSettimana(lun, conEmail));
      });
      // 2) variazioni in coda (mai nel weekend)
      if (feriale) { var v = mandaVariazioni(); if (v) fatti.push(v); }
      // 3) report mensile all'amministrazione: primo giorno lavorativo del mese
      var mesePrec = (function () { var d = pd(n.date); d.setDate(1); d.setMonth(d.getMonth() - 1); return iso(d).slice(0, 7); })();
      if (c.emailAmministrazione && feriale && +n.date.slice(8) <= 7 && !giaFatto("report_" + mesePrec)) {
        segnaFatto("report_" + mesePrec);
        var R = calcReport(mesePrec);
        manda(c.emailAmministrazione, "Mensa – report " + mesePrec, "Report mensile della mensa: " + R.totali.pasti + " pasti, " + R.totali.annullati + " annullamenti dopo l'invio dell'ordine.\n" +
          "Il file Excel completo si scarica dalla app: Gestione → Report.\n\n" +
          R.righe.slice(0, 15).map(function (r) { return r.username + ": " + r.pasti + " pasti, " + r.annullati + " annullamenti"; }).join("\n"),
          { name: "mensa_report_" + mesePrec + ".csv", csv: csvReport(R) }, "report");
        fatti.push("report");
      }
      return { fatti: fatti, ora: n.ts };
    }

    /* ---------- impostazioni e stato ---------- */
    function impostazioni(u, p) {
      serve(u, "admin");
      if (p && p.salva) {
        var v = p.salva;
        ["cutoff", "chiusuraOra"].forEach(function (k) { if (v[k] && !/^\d{2}:\d{2}$/.test(v[k])) throw err("dati", "Orario non valido."); });
        setCfg(v);
      }
      return { cfg: cfg(), quota: env.mail.quota ? env.mail.quota() : null, posta: S.rows("posta").slice(-40).reverse(), addetti: emailAddetti() };
    }
    function io(u, p) {
      var c = cfg();
      var sett = settimaneVisibili(u), oggi = now().date, lun = p && p.lunedi;
      if (!lun || !sett.some(function (w) { return w.lunedi === lun; })) {
        var aperta = sett.filter(function (w) { return infoSettimana(w.lunedi, c).aperta; })[0];
        var w0 = aperta || sett.filter(function (w) { return w.giorni.some(function (d) { return d >= oggi; }); })[0];
        lun = w0 ? w0.lunedi : (sett.length ? sett[sett.length - 1].lunedi : "");
      }
      var pub = { cutoff: c.cutoff, chiusuraGiorno: c.chiusuraGiorno, chiusuraOra: c.chiusuraOra, aperturaGiorno: c.aperturaGiorno, variazioni: c.variazioni, limiti: c.limiti, minPiatti: c.minPiatti, nomeMensa: c.nomeMensa };
      // pasto di oggi, per il riquadro in alto
      var po = piattiDel(oggi), oo = S.rows("ordini").filter(function (o) { return o.data === oggi && o.uid === u.id; })[0];
      var r = { io: pubblico(u), cfg: pub, settimane: sett.map(function (w) { return Object.assign(w, infoSettimana(w.lunedi, c)); }), oggi: oggi, ora: now().time,
        settimana: lun ? settimana(u, { lunedi: lun }) : null,
        pastoOggi: po.length ? { data: oggi, ordine: oo ? pubOrd(oo) : null, piatti: po, stato: statoGiorno(oggi, c) } : null };
      if (u.ruolo === "admin") r.inAttesa = S.rows("utenti").filter(function (x) { return x.stato === "attesa"; }).length;
      return r;
    }
    function ultimoOrdine(u, p) {
      var o = S.rows("ordini").filter(function (x) { return x.uid === u.id && x.stato === "ok" && x.data < p.data; }).sort(function (a, b) { return a.data < b.data ? 1 : -1; })[0];
      if (!o) return { ordine: null };
      return { ordine: pubOrd(o), piatti: piattiDel(o.data) };
    }

    /* ---------- smistamento chiamate ---------- */
    var PUBBLICHE = { registra: registra, login: login, info: function () { return { versione: VERSIONE, data: DATA_VERSIONE, oggi: now().date, ora: now().time }; } };
    var PRIVATE = {
      io: io, esci: esci, profilo: profilo, settimana: settimana, salvaOrdine: salvaOrdine, annullaOrdine: annullaOrdine, ultimoOrdine: ultimoOrdine,
      riepilogo: riepilogo, riepilogoSettimana: riepilogoSettimana, registraInvio: registraInvio, documento: documento, inviaRiepilogo: inviaRiepilogo,
      archivio: archivio, salvaMenu: salvaMenu, eliminaGiorno: eliminaGiorno, utenti: utenti, gestisciUtente: gestisciUtente, impostazioni: impostazioni,
      report: function (u, p) { serve(u, "admin"); return calcReport(p.mese); },
      csvReport: function (u, p) { serve(u, "admin"); return { csv: csvReport(calcReport(p.mese)), nome: "mensa_report_" + p.mese + ".csv" }; },
      tickOra: function (u) { serve(u, "admin"); return tick(); },
      provaEmail: function (u) { serve(u, "admin"); if (!u.email) throw err("dati", "Inserisci prima la tua email nel profilo."); return { ok: manda(u.email, "Mensa Omet – email di prova", "Se leggi questo messaggio, le email della mensa funzionano.", null, "prova") }; }
    };
    function call(action, params, token) {
      params = params || {}; _cfg = null;
      if (PUBBLICHE[action]) return PUBBLICHE[action](params);
      if (!PRIVATE[action]) throw err("dati", "Azione sconosciuta: " + action);
      var u = utenteDa(token);
      return PRIVATE[action](u, params, token);
    }

    return { call: call, tick: function () { _cfg = null; return tick(); }, cfg: cfg, riep: riep, conteggi: conteggi, testoGiorno: testoGiorno, testoSettimana: testoSettimana,
      htmlSettimana: htmlSettimana, docHtml: docHtml, calcReport: calcReport, csvReport: csvReport, statoGiorno: statoGiorno };
  }

  return { create: create, SCHEMA: SCHEMA, CATS: CATS, DEF_CFG: DEF_CFG, VERSIONE: VERSIONE, DATA_VERSIONE: DATA_VERSIONE,
    util: { pad: pad, iso: iso, it: it, pd: pd, lunedi: lunedi, addDays: addDays, giornoL: giornoL, giornoB: giornoB, tsIt: tsIt, cap: cap, esc: esc, periodo: periodo } };
})();
if (typeof module !== "undefined" && module.exports) module.exports = MensaCore;
