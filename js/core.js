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

  var VERSIONE = "v0.6";
  var DATA_VERSIONE = "26/11/2026";

  /* ---------- schema delle tabelle (anche intestazioni del Foglio) ----------
     Le colonne nuove si aggiungono SOLO in fondo: il Foglio legge per posizione. */
  var SCHEMA = {
    utenti: [["id"], ["username"], ["pinHash"], ["salt"], ["email"], ["mailSettimana", "b"], ["notifiche", "b"], ["ruolo"], ["stato"],
      ["creato"], ["approvatoDa"], ["approvatoIl"], ["errori", "n"], ["bloccatoFino"], ["ultimoAccesso"], ["acqua"], ["tipo"]],
    sessioni: [["token"], ["uid"], ["creato"], ["scade"], ["dispositivo"]],
    menu: [["data"], ["lunedi"], ["settimana"], ["cod"], ["nome"], ["all"], ["cat"], ["panna", "b"], ["maiale", "b"], ["pos", "n"]],
    menuNote: [["lunedi"], ["settimana"], ["note"], ["caricatoDa"], ["caricatoIl"], ["origine"]],
    ordini: [["id"], ["data"], ["uid"], ["username"], ["scelte"], ["acqua"], ["nota"], ["stato"], ["creato"], ["modificato"],
      ["inseritoDa"], ["tardivo", "b"], ["ospite", "b"], ["annullatoDa"], ["annullatoIl"],
      ["sblocco", "b"], ["nonConsumato", "b"], ["motivoNC"], ["ncDa"], ["ncIl"]],
    sblocchi: [["id"], ["lunedi"], ["uid"], ["username"], ["ts"], ["stato"], ["sbloccatoDa"], ["sbloccatoIl"], ["inviatoIl"], ["gestitoDa"], ["gestitoIl"], ["motivo"], ["notificata", "b"]],
    richieste: [["id"], ["data"], ["uid"], ["username"], ["ts"], ["stato"], ["gestitoDa"], ["gestitoIl"], ["motivo"], ["chiave"], ["notificata", "b"], ["pasto"]],
    registro: [["ts"], ["data"], ["uid"], ["username"], ["azione"], ["prima"], ["dopo"], ["entroLimite", "b"], ["da"], ["dopoInvio", "b"],
      ["dopoChiusura", "b"], ["notificato", "b"]],
    invii: [["id"], ["data"], ["ts"], ["da"], ["modo"], ["pasti", "n"], ["file"]],
    posta: [["ts"], ["a"], ["oggetto"], ["tipo"], ["esito"]],
    config: [["chiave"], ["valore", "j"]],
    comunicati: [["data"], ["ts"], ["motivo"], ["conteggi", "j"]]
  };

  // gruppi di scelta: contorni, frutta e dolce sono un unico gruppo (o l'uno o l'altro)
  var CATS = [["primo", "Primi"], ["secondo", "Secondi"], ["contorno", "Contorno, frutta o dolce"]];
  var CATS_MENU = [["primo", "Primo"], ["secondo", "Secondo"], ["contorno", "Contorno"], ["fine", "Frutta/dolce"]];   // categorie del menu (lettura PDF)
  function grp(cat) { return cat === "fine" ? "contorno" : cat; }
  var GIORNI = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
  var GIORNI_B = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];

  var DEF_CFG = {
    aperturaGiorno: 1,          // la settimana dopo si apre il lunedì (1) della settimana prima, alle 00:00
    chiusuraGiorno: 5,          // ...e si chiude il venerdì (5) della settimana prima
    chiusuraOra: "17:00",
    cutoff: "09:30",            // dopo la chiusura: annullamento entro quest'ora del giorno stesso
    variazioni: false,          // dopo la chiusura si possono anche cambiare i piatti (entro lo stesso orario)
    limiti: { primo: 1, secondo: 1, contorno: 1 },          // "contorno" = contorno, frutta o dolce
    varianti: { B: ["pasta", "riso"], C: ["pasta", "riso"], P: ["pizza", "tramezzino al tonno"] },   // la prima è quella proposta
    minPiatti: 1,
    nominativoWhatsApp: false,  // elenco nomi anche nel testo per il fornitore
    approvazione: true,
    approvazioniFino: "10:00",  // i gestori approvano le richieste di annullamento entro quest'ora del giorno; poi scadono (il pasto resta)
    orarioControllo: "11:00",   // foglio di controllo consegna ai gestori e all'amministrazione
    orarioSblocchi: "07:00",    // pasti da ordine sbloccato: la variazione del giorno parte la mattina stessa da quest'ora
    emailExtra: "",             // altre caselle per le email ai gestori mensa (separate da virgola)
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
  // le scelte si salvano separate da "|" (le varianti possono contenere spazi); i dati vecchi erano separati da spazi
  function splitCodes(s) { s = String(s || ""); return (s.indexOf("|") >= 0 || s.indexOf("~") >= 0 ? s.split("|") : s.split(/\s+/)).map(function (x) { return x.trim(); }).filter(Boolean); }
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
      c.limiti = Object.assign({}, DEF_CFG.limiti, c.limiti || {}); delete c.limiti.fine;
      if (!c.varianti || typeof c.varianti !== "object") c.varianti = clone(DEF_CFG.varianti);
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
      if (liv === "addetto" && !isAddetto(u)) throw err("perm", "Funzione riservata ai gestori mensa.");
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
      S.rows("richieste").forEach(function (r) { if (r.uid === u.id && miei[r.data] && (!miei[r.data].richiesta || miei[r.data].richiesta.ts < r.ts)) miei[r.data].richiesta = pubRich(r); });
      return Object.assign(infoSettimana(lun, c), {
        sblocco: infoSblocco(u, lun, c),
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
      return { id: o.id, data: o.data, uid: o.uid, username: o.username, scelte: splitCodes(o.scelte).map(function (t) { return canon(t); }), acqua: o.acqua || "", nota: o.nota || "", stato: o.stato,
        creato: o.creato, modificato: o.modificato, inseritoDa: o.inseritoDa || "", tardivo: !!o.tardivo, ospite: !!o.ospite,
        annullatoDa: o.annullatoDa || "", annullatoIl: o.annullatoIl || "",
        sblocco: !!o.sblocco, attesaConferma: !!o.sblocco && o.stato === "ok" && !(statoInvio(o.data).ultimoInvio >= o.modificato),
        nonConsumato: !!o.nonConsumato, motivoNC: o.motivoNC || "", ncDa: o.ncDa || "" };
    }
    /* scelte: "A", "4", oppure codice~variante per i piatti con varianti ("B~riso", "P~tramezzino al tonno") */
    function tok(t) { var i = String(t).indexOf("~"); return i < 0 ? { c: String(t), v: "" } : { c: String(t).slice(0, i), v: String(t).slice(i + 1) }; }
    function varDi(c, cv) { var l = (cv || cfg().varianti)[c]; return Array.isArray(l) && l.length ? l : null; }
    function canon(t, cv) { var x = tok(t), l = varDi(x.c, cv); if (!l) return x.c; return x.c + "~" + (l.indexOf(x.v) >= 0 ? x.v : l[0]); }
    function piattoDi(piatti, t) { var c = tok(t).c; return piatti.filter(function (x) { return x.c === c; })[0]; }
    function nomeTok(piatti, t, cv) {   // "Pomodoro – riso"; se il piatto si chiama come una sua variante (Pizza: pizza/tramezzino) si mostra solo la variante
      var p = piattoDi(piatti, t), k = tok(canon(t, cv)), n = p ? cap(p.n) : "?";
      if (!k.v) return n;
      var l = varDi(k.c, cv) || [];
      return l.some(function (v) { return v.toLowerCase() === n.toLowerCase(); }) ? cap(k.v) : n + " – " + k.v;
    }
    function etichetta(piatti, t, cv) { return tok(t).c + " " + nomeTok(piatti, t, cv); }               // "B Pomodoro – riso"
    function breve(t, cv) { var k = tok(canon(t, cv)); return k.c + (k.v ? " " + k.v : ""); }             // "B riso"
    function ordinaTok(piatti, l) { return l.sort(function (a, b) { var ia = piatti.findIndex(function (x) { return x.c === tok(a).c; }), ib = piatti.findIndex(function (x) { return x.c === tok(b).c; }); return ia - ib || (a < b ? -1 : 1); }); }
    // righe di conteggio nell'ordine del menu, con le varianti separate; solo quelle con almeno un pasto se soloPieni
    function righeConteggio(piatti, cod, soloPieni, cv) {
      var out = [];
      piatti.forEach(function (x) {
        var l = varDi(x.c, cv), toks = l ? l.map(function (v) { return x.c + "~" + v; }) : [x.c];
        toks.forEach(function (t) { var n = cod[t] || 0; if (soloPieni && !n) return; out.push({ t: t, c: x.c, v: tok(t).v, nome: cap(x.n), label: nomeTok(piatti, t, cv), gruppo: grp(x.cat), n: n }); });
      });
      return out;
    }
    function sceltePerGruppo(piatti, scelte, cv) {   // {primo:"A Ragù", secondo:"4 Stracchino", contorno:"Z Insalata"}
      var g = {}; CATS.forEach(function (cc) { g[cc[0]] = []; });
      scelte.forEach(function (t) { var p = piattoDi(piatti, t); g[p ? grp(p.cat) : "contorno"].push(etichetta(piatti, t, cv)); });
      Object.keys(g).forEach(function (k) { g[k] = g[k].join(", "); });
      return g;
    }
    function descr(o, piatti) {
      if (!o || o.stato !== "ok") return "nessun pasto";
      return splitCodes(o.scelte).map(function (t) { return etichetta(piatti, t); }).join(", ") + ", acqua " + (o.acqua === "G" ? "gassata" : "naturale");
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
      var sb = !perConto && st === "chiuso" ? sbloccoDi(u.id, lunedi(day)) : null, bozza = false;
      if (sb && sb.stato === "inviato" && !isAddetto(u)) throw err("chiuso", "Hai già inviato i pasti: attendi l'approvazione di un gestore mensa.");
      if (sb && sb.stato === "sbloccato" && (!ex0 || ex0.stato === "bozza" || ex0.stato === "decaduto" || ex0.stato === "rifiutato")) bozza = true;   // ordine sbloccato: si compila e poi si invia
      if (!isAddetto(u) && !bozza) {
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
      var sc = uniq((p.scelte || []).map(function (x) { var k = tok(x); return canon(k.c.toUpperCase() + (k.v ? "~" + k.v.toLowerCase() : ""), c.varianti); }));
      sc.forEach(function (k) { if (!piattoDi(piatti, k)) throw err("dati", "Codice " + tok(k).c + " non presente nel menu del giorno."); });
      if (uniq(sc.map(function (k) { return tok(k).c; })).length !== sc.length) throw err("regole", "Per ogni piatto scegli una sola variante.");
      if (!perConto) CATS.forEach(function (cc) {
        var lim = +c.limiti[cc[0]], n = sc.filter(function (k) { return grp(piattoDi(piatti, k).cat) === cc[0]; }).length;
        if (n > lim) throw err("regole", cc[1] + ": al massimo " + lim + ".");
      });
      if (sc.length < (+c.minPiatti || 1)) throw err("regole", "Scegli almeno " + (+c.minPiatti || 1) + " piatto.");
      var pref = (S.rows("utenti").filter(function (x) { return x.id === dest.id; })[0] || {}).acqua;
      var acqua = /^[NG]$/.test(p.acqua || "") ? p.acqua : (pref === "G" ? "G" : "N");          // l'acqua c'è sempre
      var nota = String(p.nota || "").slice(0, 120);
      ordinaTok(piatti, sc);
      var id = day + "_" + dest.id, ex = S.rows("ordini").filter(function (o) { return o.id === id; })[0], n = now();
      var row = { id: id, data: day, uid: dest.id, username: dest.username, scelte: sc.join("|"), acqua: acqua, nota: nota, stato: bozza ? "bozza" : "ok",
        creato: ex ? ex.creato : n.ts, modificato: n.ts, inseritoDa: perConto ? u.username : (ex ? ex.inseritoDa : ""), tardivo: dopo, ospite: !!p.ospite, sblocco: bozza };
      if (bozza) { if (ex) S.update("ordini", "id", id, row); else S.insert("ordini", row); return { ordine: pubOrd(row), bozza: true, settimana: p.conSettimana ? settimana(u, { lunedi: lunedi(day) }) : undefined }; }
      var azione = ex ? (ex.stato === "ok" ? "modifica" : "ripristina") : "prenota";
      var sett = function () { return p.conSettimana ? settimana(u, { lunedi: lunedi(day) }) : undefined; };
      if (ex && ex.stato === "ok" && ex.scelte === row.scelte && (ex.acqua || "") === acqua && (ex.nota || "") === nota) return { ordine: pubOrd(ex), invariato: true, settimana: sett() };
      if (ex) S.update("ordini", "id", id, row); else S.insert("ordini", row);
      registra_(day, dest, azione, descr(ex, piatti), descr(row, piatti), st !== "concluso", u.username, dopo);
      return { ordine: pubOrd(row), settimana: sett() };
    }

    /* ---------- sblocco ordine: chi non ha prenotato nulla prima della chiusura ----------
       richiesta (da sabato a venerdì entro il cutoff) → un gestore sblocca → l'utente compila e invia i pasti (in attesa)
       → un gestore approva per giorno (entro approvazioniFino del giorno, poi decadono)
       → ogni mattina (orarioSblocchi) il pasto del giorno entra nel totale come VARIAZIONE da inviare alla mensa
       → per l'utente resta "in attesa di conferma" finché quel giorno non viene inviato alla mensa */
    var SB_ATTIVI = ["richiesto", "sbloccato", "inviato"];
    function sbloccoDi(uid, lun) { return S.rows("sblocchi").filter(function (x) { return x.uid === uid && x.lunedi === lun && SB_ATTIVI.indexOf(x.stato) >= 0; })[0] || null; }
    function fineSblocco(lun, c) { var g = giorniSettimana(lun); return { date: g[g.length - 1] || addDays(lun, 4), time: (c || cfg()).cutoff }; }
    function settimanaSbloccabile(c) {
      var n = now(), l0 = lunedi(n.date);
      return [l0, addDays(l0, 7)].filter(function (l) { return giorniSettimana(l).length && passato(n, chiusuraSett(l, c)) && !passato(n, fineSblocco(l, c)); })[0] || "";
    }
    function senzaPasti(uid, lun) { return !S.rows("ordini").some(function (o) { return o.uid === uid && lunedi(o.data) === lun && ["ok", "attesa", "approvato"].indexOf(o.stato) >= 0; }); }
    function pubSb(x) { return x ? { id: x.id, lunedi: x.lunedi, uid: x.uid, username: x.username, ts: x.ts, stato: x.stato, sbloccatoDa: x.sbloccatoDa || "", inviatoIl: x.inviatoIl || "", gestitoDa: x.gestitoDa || "", gestitoIl: x.gestitoIl || "", motivo: x.motivo || "" } : null; }
    function infoSblocco(u, lun, c) {
      c = c || cfg();
      var ult = S.rows("sblocchi").filter(function (x) { return x.uid === u.id && x.lunedi === lun; }).sort(function (a, b) { return a.ts < b.ts ? 1 : -1; })[0];
      var puo = lun === settimanaSbloccabile(c) && senzaPasti(u.id, lun) && !sbloccoDi(u.id, lun);
      var bozze = S.rows("ordini").filter(function (o) { return o.uid === u.id && lunedi(o.data) === lun && o.stato === "bozza"; }).length;
      return { puoiRichiedere: puo, ultimo: pubSb(ult), bozze: bozze, scade: it(fineSblocco(lun, c).date) + " alle " + c.cutoff, approvaEntro: c.approvazioniFino };
    }
    function avvisaSblocco(x) {
      var c = cfg(), ogg, txt;
      if (x.stato === "inviato") {
        var l = S.rows("ordini").filter(function (o) { return o.uid === x.uid && lunedi(o.data) === x.lunedi && o.stato === "attesa"; }).sort(function (a, b) { return a.data < b.data ? -1 : 1; });
        ogg = "Mensa – pasti da APPROVARE (ordine sbloccato): " + x.username + ", settimana " + periodo(x.lunedi);
        txt = x.username + " ha inviato i pasti della settimana " + periodo(x.lunedi) + ":\n" + l.map(function (o) { return "  " + giornoL(o.data) + " " + it(o.data).slice(0, 5) + ": " + descr(Object.assign({}, o, { stato: "ok" }), piattiDel(o.data)); }).join("\n") +
          "\n\nApprova o rifiuta dalla app: Gestione → Richieste. Ogni giorno va approvato entro le " + c.approvazioniFino + " di quel giorno, altrimenti decade.\n" +
          "I pasti approvati entrano nel totale la mattina del giorno stesso come VARIAZIONE da inviare alla mensa.\n" + (env.appUrl || "");
      } else {
        ogg = "Mensa – richiesta di SBLOCCO ordine: " + x.username + ", settimana " + periodo(x.lunedi);
        txt = x.username + " non ha prenotato nessun pasto per la settimana " + periodo(x.lunedi) + " e chiede lo sblocco dell'ordine.\nSblocca o rifiuta dalla app: Gestione → Richieste.\n" + (env.appUrl || "");
      }
      manda(emailAddetti(), ogg, txt, null, "sblocco");
      S.update("sblocchi", "id", x.id, { notificata: true });
    }
    function richiediSblocco(u, p) {
      var c = cfg(), lun = p.lunedi, n = now();
      if (lun !== settimanaSbloccabile(c)) throw err("chiuso", "Lo sblocco si può chiedere solo dopo la chiusura dell'ordine e fino a venerdì alle " + c.cutoff + ".");
      if (!senzaPasti(u.id, lun)) throw err("dati", "Hai già dei pasti in questa settimana: lo sblocco serve solo a chi non ha prenotato nulla.");
      if (sbloccoDi(u.id, lun)) return { settimana: settimana(u, { lunedi: lun }) };
      var x = { id: "S" + env.uuid().replace(/-/g, "").slice(0, 10), lunedi: lun, uid: u.id, username: u.username, ts: n.ts, stato: "richiesto", sbloccatoDa: "", sbloccatoIl: "", inviatoIl: "", gestitoDa: "", gestitoIl: "", motivo: "", notificata: false };
      S.insert("sblocchi", x);
      if (c.mailWeekend || !weekend(n.date)) avvisaSblocco(x);
      return { settimana: settimana(u, { lunedi: lun }), condividi: "Ciao, ti ho inviato dalla app Mensa Omet una richiesta di sblocco dell'ordine per la settimana " + periodo(lun) + ". Grazie!" };
    }
    function sblocca(u, p) {
      serve(u, "addetto");
      var c = cfg(), n = now(), x;
      if (p.id) {
        x = S.rows("sblocchi").filter(function (y) { return y.id === p.id; })[0];
        if (!x) throw err("dati", "Richiesta non trovata.");
        if (x.stato !== "richiesto") throw err("gestita", "Richiesta già gestita (" + x.stato + (x.sbloccatoDa ? " da " + x.sbloccatoDa : "") + ").");
        if (passato(n, fineSblocco(x.lunedi, c))) throw err("gestita", "La settimana è ormai finita.");
        S.update("sblocchi", "id", x.id, { stato: "sbloccato", sbloccatoDa: u.username, sbloccatoIl: n.ts });
      } else {
        var lun = p.lunedi || settimanaSbloccabile(c), dest = S.rows("utenti").filter(function (y) { return y.id === p.uid && y.stato === "attivo"; })[0];
        if (!dest) throw err("dati", "Utente non trovato.");
        if (!lun || passato(n, fineSblocco(lun, c))) throw err("chiuso", "Non c'è una settimana da sbloccare.");
        if (!senzaPasti(dest.id, lun)) throw err("dati", dest.username + " ha già dei pasti in questa settimana.");
        x = sbloccoDi(dest.id, lun);
        if (x && x.stato !== "richiesto") throw err("gestita", "Ordine già sbloccato.");
        if (x) S.update("sblocchi", "id", x.id, { stato: "sbloccato", sbloccatoDa: u.username, sbloccatoIl: n.ts });
        else { x = { id: "S" + env.uuid().replace(/-/g, "").slice(0, 10), lunedi: lun, uid: dest.id, username: dest.username, ts: n.ts, stato: "sbloccato", sbloccatoDa: u.username, sbloccatoIl: n.ts, inviatoIl: "", gestitoDa: "", gestitoIl: "", motivo: "", notificata: true }; S.insert("sblocchi", x); }
      }
      var e = emailUtente(x.uid);
      var testo = "Ciao " + x.username + ", ti ho sbloccato l'ordine della mensa per la settimana " + periodo(x.lunedi) + ". Entra nella app, scegli i pasti e premi \"Invia i pasti della settimana\": poi un gestore li approva.";
      if (e) manda(e, "Mensa – ordine sbloccato per la settimana " + periodo(x.lunedi), testo + "\n" + (env.appUrl || ""), null, "conferma");
      return { ok: true, condividi: testo, sblocco: pubSb(S.rows("sblocchi").filter(function (y) { return y.id === x.id; })[0]) };
    }
    function rifiutaSblocco(u, p) {
      serve(u, "addetto");
      var x = S.rows("sblocchi").filter(function (y) { return y.id === p.id; })[0], n = now();
      if (!x || x.stato !== "richiesto") throw err("gestita", "Richiesta non più in attesa.");
      S.update("sblocchi", "id", x.id, { stato: "rifiutato", gestitoDa: u.username, gestitoIl: n.ts, motivo: String(p.motivo || "").slice(0, 200) });
      var testo = "Ciao " + x.username + ", la richiesta di sblocco dell'ordine per la settimana " + periodo(x.lunedi) + " non è stata accettata da " + u.username + (p.motivo ? ": " + p.motivo : "") + ".";
      var e = emailUtente(x.uid); if (e) manda(e, "Mensa – sblocco ordine non accettato", testo, null, "conferma");
      return { ok: true, condividi: testo };
    }
    function inviaSblocco(u, p) {
      var lun = p.lunedi, x = sbloccoDi(u.id, lun), n = now(), c = cfg();
      if (!x || x.stato !== "sbloccato") throw err("dati", "L'ordine di questa settimana non è sbloccato.");
      var bz = S.rows("ordini").filter(function (o) { return o.uid === u.id && lunedi(o.data) === lun && o.stato === "bozza"; });
      bz.forEach(function (o) { if (passato(n, scadenzaApprov(o.data, c))) S.update("ordini", "id", o.id, { stato: "decaduto", modificato: n.ts }); });
      bz = bz.filter(function (o) { return !passato(n, scadenzaApprov(o.data, c)); });
      if (!bz.length) throw err("dati", "Scegli almeno un pasto prima di inviare.");
      bz.forEach(function (o) { S.update("ordini", "id", o.id, { stato: "attesa", modificato: n.ts }); });
      S.update("sblocchi", "id", x.id, { stato: "inviato", inviatoIl: n.ts, notificata: false });
      x = S.rows("sblocchi").filter(function (y) { return y.id === x.id; })[0];
      if (c.mailWeekend || !weekend(n.date)) avvisaSblocco(x);
      return { settimana: settimana(u, { lunedi: lun }), condividi: "Ciao, ho inviato dalla app Mensa Omet i miei pasti della settimana " + periodo(lun) + " (ordine sbloccato): mi servirebbe la tua approvazione. Grazie!" };
    }
    function attivaSblocco(o, chi) {   // il pasto approvato entra nel totale del giorno come variazione
      var n = now();
      S.update("ordini", "id", o.id, { stato: "ok", modificato: n.ts, tardivo: true });
      registra_(o.data, { id: o.uid, username: o.username }, "prenota", "nessun pasto", descr(Object.assign({}, o, { stato: "ok" }), piattiDel(o.data)) + " (ordine sbloccato)", true, chi, true);
    }
    function approvaSblocco(u, p) {
      serve(u, "addetto");
      var c = cfg(), n = now(), x = S.rows("sblocchi").filter(function (y) { return y.id === p.id; })[0];
      if (!x) throw err("dati", "Richiesta non trovata.");
      if (x.stato !== "inviato") throw err("gestita", "Pasti già gestiti" + (x.gestitoDa ? " da " + x.gestitoDa : "") + ".");
      var esiti = p.esiti || {}, ok = [], no = [], dec = [];
      S.rows("ordini").filter(function (o) { return o.uid === x.uid && lunedi(o.data) === x.lunedi && o.stato === "attesa"; }).sort(function (a, b) { return a.data < b.data ? -1 : 1; }).forEach(function (o) {
        var e = esiti[o.data] || p.esito; if (!e) return;
        var g = giornoL(o.data) + " " + it(o.data).slice(0, 5);
        if (passato(n, scadenzaApprov(o.data, c))) { S.update("ordini", "id", o.id, { stato: "decaduto", modificato: n.ts }); dec.push(g); return; }
        if (e === "approva") {
          if (o.data === n.date && n.time >= c.orarioSblocchi) attivaSblocco(o, u.username);
          else S.update("ordini", "id", o.id, { stato: "approvato", modificato: n.ts });
          ok.push(g);
        } else { S.update("ordini", "id", o.id, { stato: "rifiutato", modificato: n.ts }); no.push(g); }
      });
      var resta = S.rows("ordini").some(function (o) { return o.uid === x.uid && lunedi(o.data) === x.lunedi && o.stato === "attesa"; });
      if (!resta) S.update("sblocchi", "id", x.id, { stato: "chiuso", gestitoDa: u.username, gestitoIl: n.ts, motivo: String(p.motivo || "").slice(0, 200) });
      var testo = "Ciao " + x.username + ", " + (ok.length ? "ho approvato i tuoi pasti di " + ok.join(", ") + ". Diventano definitivi quando l'ordine del giorno viene inviato alla mensa." : "") +
        (no.length ? (ok.length ? " " : "") + "Non approvati: " + no.join(", ") + (p.motivo ? " (" + p.motivo + ")" : "") + "." : "") + (dec.length ? " Scaduti: " + dec.join(", ") + "." : "");
      var e = emailUtente(x.uid); if (e && (ok.length || no.length)) manda(e, "Mensa – pasti dell'ordine sbloccato: esito", testo + "\n" + (env.appUrl || ""), null, "conferma");
      return { ok: true, approvati: ok, rifiutati: no, scaduti: dec, condividi: testo };
    }
    function segnaNonConsumato(u, p) {
      serve(u, "addetto");
      var o = S.rows("ordini").filter(function (x) { return x.id === p.id; })[0], n = now();
      if (!o || o.stato !== "ok") throw err("dati", "Pasto non trovato.");
      if (o.data > n.date) throw err("dati", "Si può segnare solo da oggi in poi a giorno passato.");
      var patch = p.valore ? { nonConsumato: true, motivoNC: String(p.motivo || "").slice(0, 200), ncDa: u.username, ncIl: n.ts } : { nonConsumato: false, motivoNC: "", ncDa: u.username, ncIl: n.ts };
      S.update("ordini", "id", o.id, patch);
      return { ordine: pubOrd(Object.assign({}, o, patch)) };
    }

    /* ---------- annullamenti: dopo l'invio dell'ordine l'utente fa una RICHIESTA che un gestore approva ---------- */
    function pubRich(r) { return { id: r.id, data: r.data, uid: r.uid, username: r.username, ts: r.ts, stato: r.stato, gestitoDa: r.gestitoDa || "", gestitoIl: r.gestitoIl || "", motivo: r.motivo || "", pasto: r.pasto || "" }; }
    function fraseGiorno(day) { return giornoL(day) + " " + it(day); }
    function testoRichiesta(r) { return "Ciao, ti ho inviato dalla app Mensa Omet una richiesta di annullamento per il pasto di " + fraseGiorno(r.data) + " (" + r.pasto + "). Grazie!"; }
    function testoConferma(username, day, pasto, chi, quando) { return "Ciao " + username + ", ti confermo l'annullamento del pasto di " + fraseGiorno(day) + (pasto ? " (" + pasto + ")" : "") + ". Annullato da " + chi + " il " + tsIt(quando).replace(" ore ", " alle ") + "."; }
    function emailUtente(uid) { var x = S.rows("utenti").filter(function (y) { return y.id === uid; })[0]; return x && x.stato === "attivo" ? x.email || "" : ""; }
    function scadenzaApprov(day, c) { return { date: day, time: (c || cfg()).approvazioniFino }; }

    function annullaOrdine(u, p) {
      var day = p.data, c = cfg(), uid = p.uid || u.id, gest = isAddetto(u);
      if (uid !== u.id) serve(u, "addetto");
      var st = statoGiorno(day, c), dopo = st === "chiuso" || st === "concluso";
      var id = day + "_" + uid, ex = S.rows("ordini").filter(function (o) { return o.id === id; })[0];
      var sett = function () { return p.conSettimana ? settimana(u, { lunedi: lunedi(day) }) : undefined; };
      if (!ex) throw err("dati", "Non c'è un ordine da annullare.");
      if (ex.stato === "bozza" && uid === u.id) { S.removeWhere("ordini", function (o) { return o.id === id; }); return { ok: true, tolto: true, settimana: sett() }; }
      if (ex.stato !== "ok") return { ok: true, giaAnnullato: true, settimana: sett() };   // doppio invio dopo un errore di rete
      if (!gest && st === "concluso") throw err("chiuso", "Sono passate le " + c.cutoff + ": per annullare chiama un gestore mensa.");
      if (!gest && st === "chiuso") {   // ordine già inviato: serve l'approvazione di un gestore
        var gia = S.rows("richieste").filter(function (r) { return r.data === day && r.uid === uid && r.stato === "attesa"; })[0];
        if (gia) return { richiesta: pubRich(gia), condividi: testoRichiesta(gia), settimana: sett() };
        var n = now(), r = { id: "R" + env.uuid().replace(/-/g, "").slice(0, 10), data: day, uid: uid, username: ex.username, ts: n.ts, stato: "attesa", gestitoDa: "", gestitoIl: "", motivo: "",
          chiave: env.uuid().replace(/-/g, ""), notificata: false, pasto: descr(ex, piattiDel(day)).replace(/, acqua.*$/, "") };
        S.insert("richieste", r);
        if (c.mailWeekend || !weekend(n.date)) avvisaRichiesta(r);
        return { richiesta: pubRich(r), condividi: testoRichiesta(r), settimana: sett() };
      }
      var esito = applicaAnnullo(ex, u.username, dopo, st !== "concluso");
      return Object.assign(esito, { ok: true, dopoChiusura: dopo, settimana: sett() });
    }
    // effettua l'annullamento e lo registra; dopo la chiusura va in coda l'email di variazione ai gestori
    function applicaAnnullo(ex, chi, dopo, entro) {
      var n = now(), piatti = piattiDel(ex.data), pasto = descr(ex, piatti).replace(/, acqua.*$/, "");
      var daAltri = chi !== ex.username;
      S.update("ordini", "id", ex.id, { stato: "annullato", modificato: n.ts, tardivo: dopo, annullatoDa: daAltri || dopo ? chi : "", annullatoIl: daAltri || dopo ? n.ts : "" });
      registra_(ex.data, { id: ex.uid, username: ex.username }, "annulla", descr(ex, piatti), "nessun pasto", entro, chi, dopo);
      var conferma = testoConferma(ex.username, ex.data, pasto, chi, n.ts);
      if (dopo && daAltri) { var e = emailUtente(ex.uid); if (e) manda(e, "Mensa – annullamento confermato: " + fraseGiorno(ex.data), conferma + "\n\n" + (env.appUrl || ""), null, "conferma"); }
      return { conferma: daAltri ? conferma : "", annullatoDa: chi, annullatoIl: n.ts };
    }
    function firmaLink(r, uid) { return env.hash(r.chiave + ":" + uid).slice(0, 24); }
    function avvisaRichiesta(r) {
      var base = env.webUrl || "", c = cfg();
      var ogg = "Mensa – RICHIESTA di annullamento: " + r.username + ", " + fraseGiorno(r.data);
      var corpo = function (q) {
        var link = function (a) { return base + "?r=" + r.id + q + "&a=" + a; };
        return r.username + " chiede di annullare il pasto di " + fraseGiorno(r.data) + "\n  " + r.pasto + "\nRichiesta del " + tsIt(r.ts) + ".\n\n" +
          (base ? "APPROVA:  " + link("approva") + "\nRIFIUTA:  " + link("rifiuta") + "\n(si apre una pagina di conferma)\n\n" : "") +
          "Oppure dalla app: Gestione → Richieste. Vale il primo gestore che risponde. Senza risposta entro le " + c.approvazioniFino + " la richiesta scade e il pasto resta.\n" +
          "Se approvi, ricorda di inviare alla mensa l'ordine aggiornato.\n" + (env.appUrl || "");
      };
      // un'email per gestore con il suo link personale (così si sa chi ha approvato)
      var gest = S.rows("utenti").filter(function (x) { return isAddetto(x) && x.stato === "attivo" && x.notifiche && x.email; });
      gest.forEach(function (g) { manda(g.email, ogg, corpo("&g=" + g.id + "&k=" + firmaLink(r, g.id)), null, "richiesta"); });
      var extra = emailAddetti().filter(function (e) { return !gest.some(function (g) { return g.email === e; }); });
      if (extra.length) manda(extra, ogg, corpo("&k=" + r.chiave), null, "richiesta");
      S.update("richieste", "id", r.id, { notificata: true });
    }
    function esitoRichiesta(id, esito, motivo, chi) {
      var c = cfg(), r = S.rows("richieste").filter(function (x) { return x.id === id; })[0];
      if (!r) throw err("dati", "Richiesta non trovata.");
      if (r.stato !== "attesa") throw err("gestita", r.stato === "scaduta" ? "Richiesta scaduta alle " + c.approvazioniFino + ": il pasto è rimasto." :
        "Richiesta già " + ({ approvata: "approvata", rifiutata: "rifiutata", ritirata: "ritirata" }[r.stato] || r.stato) + (r.gestitoDa ? " da " + r.gestitoDa + " il " + tsIt(r.gestitoIl) : "") + ".");
      if (passato(now(), scadenzaApprov(r.data, c))) { scadi(r); throw err("gestita", "Richiesta scaduta alle " + c.approvazioniFino + ": il pasto è rimasto."); }
      var n = now(), out = { richiesta: null, conferma: "" };
      if (esito === "approva") {
        var ex = S.rows("ordini").filter(function (o) { return o.id === r.data + "_" + r.uid; })[0];
        S.update("richieste", "id", id, { stato: "approvata", gestitoDa: chi, gestitoIl: n.ts, motivo: String(motivo || "").slice(0, 200) });
        if (ex && ex.stato === "ok") applicaAnnulloDaRichiesta(ex, chi);
        out.conferma = testoConferma(r.username, r.data, r.pasto, chi, n.ts);
        var e = emailUtente(r.uid);
        if (e) manda(e, "Mensa – annullamento APPROVATO: " + fraseGiorno(r.data), out.conferma + "\n\n" + (env.appUrl || ""), null, "conferma");
      } else if (esito === "rifiuta") {
        S.update("richieste", "id", id, { stato: "rifiutata", gestitoDa: chi, gestitoIl: n.ts, motivo: String(motivo || "").slice(0, 200) });
        out.conferma = "Ciao " + r.username + ", la tua richiesta di annullamento per " + fraseGiorno(r.data) + " non è stata accettata da " + chi + (motivo ? ": " + motivo : "") + ". Il pasto resta confermato.";
        var e2 = emailUtente(r.uid);
        if (e2) manda(e2, "Mensa – annullamento NON accettato: " + fraseGiorno(r.data), out.conferma + "\n\n" + (env.appUrl || ""), null, "conferma");
      } else throw err("dati", "Esito non valido.");
      out.richiesta = pubRich(S.rows("richieste").filter(function (x) { return x.id === id; })[0]);
      return out;
    }
    function applicaAnnulloDaRichiesta(ex, chi) {   // come applicaAnnullo, ma la conferma all'utente la manda esitoRichiesta
      var n = now(), piatti = piattiDel(ex.data);
      S.update("ordini", "id", ex.id, { stato: "annullato", modificato: n.ts, tardivo: true, annullatoDa: chi, annullatoIl: n.ts });
      registra_(ex.data, { id: ex.uid, username: ex.username }, "annulla", descr(ex, piatti), "nessun pasto (richiesta approvata da " + chi + ")", true, chi, true);
    }
    function scadi(r) {
      S.update("richieste", "id", r.id, { stato: "scaduta", gestitoIl: now().ts });
      var e = emailUtente(r.uid);
      if (e) manda(e, "Mensa – richiesta di annullamento scaduta: " + fraseGiorno(r.data), "Ciao " + r.username + ", la tua richiesta di annullamento per " + fraseGiorno(r.data) +
        " non è stata gestita entro le " + cfg().approvazioniFino + ": il pasto resta confermato.\n" + (env.appUrl || ""), null, "conferma");
    }
    function gestisciRichiesta(u, p) { serve(u, "addetto"); return esitoRichiesta(p.id, p.esito, p.motivo, u.username); }
    function ritiraRichiesta(u, p) {
      var r = S.rows("richieste").filter(function (x) { return x.data === p.data && x.uid === u.id && x.stato === "attesa"; })[0];
      if (!r) throw err("dati", "Nessuna richiesta in attesa.");
      S.update("richieste", "id", r.id, { stato: "ritirata", gestitoDa: u.username, gestitoIl: now().ts });
      return { ok: true, settimana: p.conSettimana ? settimana(u, { lunedi: lunedi(p.data) }) : undefined };
    }
    function richieste(u, p) {
      serve(u, "addetto");
      var oggi = now().date, l = S.rows("richieste").filter(function (r) { return r.stato === "attesa" || r.data >= addDays(oggi, -7); })
        .sort(function (a, b) { return (a.stato === "attesa" ? 0 : 1) - (b.stato === "attesa" ? 0 : 1) || (a.ts < b.ts ? 1 : -1); });
      var c = cfg(), lunS = settimanaSbloccabile(c);
      var sb = S.rows("sblocchi").filter(function (x) { return SB_ATTIVI.indexOf(x.stato) >= 0 || x.ts.slice(0, 10) >= addDays(oggi, -14); })
        .sort(function (a, b) { return (x0(a) - x0(b)) || (a.ts < b.ts ? 1 : -1); }).map(function (x) {
          return Object.assign(pubSb(x), { periodo: periodo(x.lunedi), pasti: S.rows("ordini").filter(function (o) { return o.uid === x.uid && lunedi(o.data) === x.lunedi && o.sblocco; })
            .sort(function (a, b) { return a.data < b.data ? -1 : 1; }).map(function (o) { return { data: o.data, stato: o.stato, descr: descr(Object.assign({}, o, { stato: "ok" }), piattiDel(o.data)) }; }) }); });
      function x0(x) { return { richiesto: 0, inviato: 0, sbloccato: 1 }[x.stato] != null ? { richiesto: 0, inviato: 0, sbloccato: 1 }[x.stato] : 2; }
      var sbloccabili = lunS ? S.rows("utenti").filter(function (x) { return x.stato === "attivo" && senzaPasti(x.id, lunS) && !sbloccoDi(x.id, lunS); })
        .map(function (x) { return { id: x.id, username: x.username }; }).sort(function (a, b) { return a.username.localeCompare(b.username); }) : [];
      return { richieste: l.map(pubRich), scadenza: c.approvazioniFino, sblocchi: sb, settimanaSblocco: lunS ? { lunedi: lunS, periodo: periodo(lunS) } : null, sbloccabili: sbloccabili };
    }
    function inAttesaGestori() { return S.rows("richieste").filter(function (x) { return x.stato === "attesa"; }).length + S.rows("sblocchi").filter(function (x) { return x.stato === "richiesto" || x.stato === "inviato"; }).length; }
    // link dall'email: pagina di conferma (un clic per aprire, un clic per confermare: i controlli antivirus che aprono i link non approvano nulla)
    function chiDaLink(r, q) {
      if (q.g) {
        var g = S.rows("utenti").filter(function (x) { return x.id === q.g; })[0];
        if (!g || !isAddetto(g) || g.stato !== "attivo" || q.k !== firmaLink(r, g.id)) throw err("dati", "Link non valido.");
        return g.username;
      }
      if (!q.k || q.k !== r.chiave) throw err("dati", "Link non valido.");
      return "gestore (link email)";
    }
    function paginaLink(q) {
      q = q || {}; _cfg = null;
      var titolo = "Richiesta di annullamento", corpo = "", base = env.webUrl || "";
      try {
        var r = S.rows("richieste").filter(function (x) { return x.id === q.r; })[0];
        if (!r) throw err("dati", "Richiesta non trovata.");
        var chi = chiDaLink(r, q), esito = q.a === "rifiuta" ? "rifiuta" : "approva";
        var info = "<p><b>" + esc(r.username) + "</b> · " + esc(fraseGiorno(r.data)) + "<br>" + esc(r.pasto) + "<br><small>Richiesta del " + esc(tsIt(r.ts)) + "</small></p>";
        if (q.conferma === "1") {
          var out = esitoRichiesta(r.id, esito, q.motivo || "", chi);
          titolo = esito === "approva" ? "✓ Annullamento approvato" : "✗ Richiesta rifiutata";
          var e = encodeURIComponent;
          corpo = info + (esito === "approva" ? '<p class="w">⚠ Ricorda di inviare alla mensa l\'ordine aggiornato (dalla app: Gestione → Riepilogo → Giorno).</p>' : "") +
            "<p>Risposta da mandare a " + esc(r.username) + (emailUtente(r.uid) ? " (l'email gli è già arrivata)" : "") + ":</p><pre>" + esc(out.conferma) + "</pre>" +
            '<p><a class="b" target="_top" href="https://wa.me/?text=' + e(out.conferma) + '">WhatsApp</a> <a class="b" target="_top" href="mailto:?subject=' + e("Mensa Omet") + "&body=" + e(out.conferma) + '">Email</a>' +
            (env.appUrl ? ' <a class="b" target="_top" href="' + esc(env.appUrl) + '">Apri la app</a>' : "") + "</p>";
        } else {
          if (r.stato !== "attesa") esitoRichiesta(r.id, esito, "", chi);   // mostra già gestita / scaduta
          if (passato(now(), scadenzaApprov(r.data, cfg()))) esitoRichiesta(r.id, esito, "", chi);
          titolo = esito === "approva" ? "Approvare l'annullamento?" : "Rifiutare la richiesta?";
          corpo = info + '<form method="get" action="' + esc(base) + '" target="_top">' +
            ["r", "g", "k", "a"].map(function (n) { return q[n] ? '<input type="hidden" name="' + n + '" value="' + esc(q[n]) + '">' : ""; }).join("") +
            '<input type="hidden" name="conferma" value="1">' +
            (esito === "rifiuta" ? '<p><label>Motivo (facoltativo)<br><input name="motivo" maxlength="200" style="width:100%;padding:8px;font-size:16px"></label></p>' : "") +
            '<p><button class="b' + (esito === "rifiuta" ? " r" : "") + '" type="submit">' + (esito === "approva" ? "✓ Sì, approva" : "✗ Sì, rifiuta") + "</button></p></form>" +
            "<p><small>Rispondi come: " + esc(chi) + ". Vale il primo gestore che risponde.</small></p>";
        }
      } catch (x) {
        titolo = "Non fatto"; corpo = "<p>" + esc(x.message || String(x)) + "</p>" + (env.appUrl ? '<p><a class="b" target="_top" href="' + esc(env.appUrl) + '">Apri la app</a></p>' : "");
      }
      return '<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mensa Omet</title><style>' +
        'body{font-family:Segoe UI,Arial,sans-serif;color:#1B2430;margin:0;background:#F4F6F9}.h{background:#093E83;color:#fff;padding:14px 18px;font-size:12px;letter-spacing:.1em}' +
        '.c{max-width:520px;margin:18px auto;background:#fff;border:1px solid #D7DEE8;border-radius:10px;padding:18px}h1{font-size:20px;margin:0 0 10px;color:#093E83}' +
        'pre{white-space:pre-wrap;background:#EEF3F9;padding:10px;border-radius:6px;font-family:inherit}.b{display:inline-block;background:#093E83;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-size:16px;text-decoration:none;cursor:pointer;margin:2px 0}' +
        '.b.r{background:#C62828}.w{background:#FFF3C4;border-left:4px solid #E0B400;padding:8px 10px}small{color:#5D6B7C}</style></head><body><div class="h">OMET FOODTECH · MENSA ' + VERSIONE + '</div><div class="c"><h1>' + esc(titolo) + "</h1>" + corpo + "</div></body></html>";
    }

    /* ---------- invio alla mensa: tracciato; avviso finché il totale cambiato non è stato inviato ---------- */
    var MODI_INVIO = /^(app|whatsapp|copia|segnato)/;
    function statoInvio(day) {
      var cambi = S.rows("registro").filter(function (r) { return r.data === day && r.dopoChiusura; }).map(function (r) { return r.ts; }).sort();
      var invii = S.rows("invii").filter(function (i) { return i.data === day && MODI_INVIO.test(i.modo || ""); }).map(function (i) { return i.ts; }).sort();
      var uc = cambi[cambi.length - 1] || "", ui = invii[invii.length - 1] || "";
      return { ultimoCambio: uc, ultimoInvio: ui, daInviare: !!uc && (!ui || uc > ui) };
    }
    function storico(day) {
      var ev = [];
      S.rows("richieste").filter(function (r) { return r.data === day; }).forEach(function (r) {
        ev.push({ ts: r.ts, cosa: "Richiesta di annullamento", chi: r.username, det: r.pasto });
        if (r.stato !== "attesa") ev.push({ ts: r.gestitoIl || r.ts, cosa: { approvata: "Richiesta APPROVATA", rifiutata: "Richiesta RIFIUTATA", scaduta: "Richiesta SCADUTA (pasto confermato)", ritirata: "Richiesta ritirata" }[r.stato] || r.stato,
          chi: r.stato === "scaduta" ? "sistema" : r.gestitoDa, det: r.username + (r.motivo ? " – " + r.motivo : "") });
      });
      S.rows("registro").filter(function (r) { return r.data === day && r.dopoChiusura && r.dopo.indexOf("richiesta approvata") < 0; }).forEach(function (r) {
        ev.push({ ts: r.ts, cosa: { annulla: "Annullato", modifica: "Modificato", prenota: "Pasto aggiunto", ripristina: "Pasto aggiunto" }[r.azione] + (/ordine sbloccato/.test(r.dopo) ? " (ordine sbloccato)" : r.da !== r.username ? " da gestore" : ""), chi: r.da, det: r.username + ": " + r.prima + " → " + r.dopo });
      });
      S.rows("invii").filter(function (i) { return i.data === day; }).forEach(function (i) {
        ev.push({ ts: i.ts, cosa: MODI_INVIO.test(i.modo || "") ? "Inviato alla mensa (" + i.modo.replace("segnato", "segnato a mano") + ")" : "Email ai gestori (" + i.modo + ")", chi: i.da, det: i.pasti + (i.pasti === 1 ? " pasto" : " pasti") });
      });
      S.rows("comunicati").filter(function (r) { return r.data === day && r.motivo === "variazione"; }).forEach(function (r) {
        ev.push({ ts: r.ts, cosa: "Email variazione ai gestori", chi: "sistema", det: ((r.conteggi || {}).pasti || 0) + " pasti" });
      });
      var SBL = { bozza: "in compilazione", attesa: "inviato, in attesa di approvazione", approvato: "approvato (entra nel totale la mattina)", rifiutato: "non approvato", decaduto: "scaduto senza approvazione" };
      S.rows("ordini").filter(function (o) { return o.data === day && o.sblocco && SBL[o.stato]; }).forEach(function (o) {
        ev.push({ ts: o.modificato, cosa: "Pasto da ordine sbloccato: " + SBL[o.stato], chi: o.username, det: descr(Object.assign({}, o, { stato: "ok" }), piattiDel(day)) }); });
      S.rows("ordini").filter(function (o) { return o.data === day && o.stato === "ok" && o.nonConsumato; }).forEach(function (o) {
        ev.push({ ts: o.ncIl || o.modificato, cosa: "Ordinato ma NON consumato", chi: o.ncDa || "", det: o.username + (o.motivoNC ? " – " + o.motivoNC : "") }); });
      return ev.sort(function (a, b) { return a.ts < b.ts ? -1 : 1; });
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
      var cv = cfg().varianti, k = { pasti: 0, cod: {}, acqua: { N: 0, G: 0 }, ospiti: 0 };
      S.rows("ordini").forEach(function (o) {
        if (o.data !== day || o.stato !== "ok") return;
        k.pasti++; if (o.ospite) k.ospiti++;
        k.acqua[o.acqua === "G" ? "G" : "N"]++;
        splitCodes(o.scelte).forEach(function (t) { t = canon(t, cv); k.cod[t] = (k.cod[t] || 0) + 1; });
      });
      return k;
    }
    function ultimoComunicato(day) {
      return S.rows("comunicati").filter(function (r) { return r.data === day; }).sort(function (a, b) { return a.ts < b.ts ? 1 : -1; })[0] || null;
    }
    function differenze(prima, ora, piatti) {
      if (!prima) return "";
      var cv = cfg().varianti, pc = {};
      Object.keys(prima.cod || {}).forEach(function (t) { var k = canon(t, cv); pc[k] = (pc[k] || 0) + prima.cod[t]; });
      var parti = [], dp = ora.pasti - prima.pasti;
      ordinaTok(piatti, uniq(Object.keys(pc).concat(Object.keys(ora.cod)))).forEach(function (t) {
        var d = (ora.cod[t] || 0) - (pc[t] || 0); if (d) parti.push(breve(t, cv) + " " + (d > 0 ? "+" : "−") + Math.abs(d)); });
      ["N", "G"].forEach(function (a) { var d = ora.acqua[a] - ((prima.acqua || {})[a] || 0); if (d) parti.push("acqua " + (a === "N" ? "naturale" : "gassata") + " " + (d > 0 ? "+" : "−") + Math.abs(d)); });
      if (!dp && !parti.length) return "nessuna differenza";
      return (dp ? (dp > 0 ? "+" : "−") + Math.abs(dp) + (Math.abs(dp) === 1 ? " pasto" : " pasti") : "stessi pasti") + (parti.length ? " (" + parti.join(", ") + ")" : "");
    }
    function pl(n, a, b) { return n + " " + (n === 1 ? a : b); }
    /* ---------- variazione: sempre rispetto all'ordine di venerdì (primo totale comunicato del giorno) ----------
       Le variazioni del giorno si sommano; vale l'ora dell'ultima. Il testo non cambia dopo l'invio alla mensa. */
    function rifDi(day) {
      return S.rows("comunicati").filter(function (r) { return r.data === day && (r.motivo === "chiusura" || r.motivo === "riferimento"); })
        .sort(function (a, b) { return a.ts < b.ts ? -1 : 1; })[0] || null;
    }
    function confronto(day) {
      var rif = rifDi(day), k = conteggi(day), piatti = piattiDel(day), cv = cfg().varianti;
      var ultima = S.rows("registro").filter(function (r) { return r.data === day && r.dopoChiusura; }).map(function (r) { return r.ts; }).sort().pop() || "";
      if (!rif || !ultima) return null;
      var pc = {}; Object.keys(rif.conteggi.cod || {}).forEach(function (t) { var x = canon(t, cv); pc[x] = (pc[x] || 0) + rif.conteggi.cod[t]; });
      var righe = ordinaTok(piatti, uniq(Object.keys(pc).concat(Object.keys(k.cod)))).map(function (t) {
        return { t: t, label: etichetta(piatti, t, cv), da: pc[t] || 0, a: k.cod[t] || 0 }; }).filter(function (x) { return x.da !== x.a; });
      var ra = rif.conteggi.acqua || {};
      var acqua = ["N", "G"].map(function (a) { return { label: a === "N" ? "Acqua naturale" : "Acqua gassata", da: ra[a] || 0, a: k.acqua[a] }; }).filter(function (x) { return x.da !== x.a; });
      var d0 = rif.ts.slice(0, 10);
      return { rif: rif, rifTesto: rif.motivo === "chiusura" ? "all'ordine inviato " + giornoL(d0) + " " + it(d0).slice(0, 5) : "all'ordine della settimana",
        k: k, piatti: piatti, righe: righe, acqua: acqua, pastiDa: (rif.conteggi || {}).pasti || 0, pastiA: k.pasti, ultima: ultima };
    }
    function segno(n) { return n > 0 ? "+" + n : n < 0 ? "−" + Math.abs(n) : "0"; }
    function righeVariazione(cf) {
      return cf.righe.concat(cf.acqua).map(function (x) { return x.label + ": da " + x.da + " a " + x.a + " (" + segno(x.a - x.da) + ")"; });
    }
    function testoVariazione(day, wa) {
      var cf = confronto(day); if (!cf) return testoGiorno(day, wa);
      var B = wa ? "*" : "", r = righeVariazione(cf);
      return "Buongiorno, si prega di prendere nota della seguente variazione dei pasti di " + B + giornoL(day) + " " + it(day) + B + ".\n" +
        "Rispetto " + cf.rifTesto + (r.length ? " sono variati i seguenti piatti:\n" + r.map(function (x) { return "– " + x; }).join("\n") : " i piatti non cambiano.") + "\n" +
        "Totale pasti aggiornato: " + B + cf.pastiA + B + " (prima " + cf.pastiDa + ").\n" +
        "Ultima variazione: " + tsIt(cf.ultima).replace(" ore ", " alle ") + ".\n\n" +
        (wa ? "_Ordine aggiornato del giorno_\n" : "Ordine aggiornato del giorno\n") + bloccoGiorno(day, cf.k, cf.piatti, wa) + "\nGrazie.";
    }
    function bloccoGiorno(day, k, piatti, wa) {   // testo per la mensa di un giorno: solo totali
      var B = wa ? "*" : "", I = wa ? "_" : "";
      var t = B + cap(giornoL(day)) + " " + it(day) + B + " – " + B + pl(k.pasti, "pasto", "pasti") + B + (k.ospiti ? " (di cui ospiti " + k.ospiti + ")" : "") + "\n";
      if (!k.pasti) return t;
      var rr = righeConteggio(piatti, k.cod, true);
      CATS.forEach(function (cc) {
        var r = rr.filter(function (x) { return x.gruppo === cc[0]; }).map(function (x) { return x.c + " " + x.label + ": " + B + x.n + B; });
        if (r.length) t += I + cc[1] + I + "\n" + r.join("\n") + "\n";
      });
      t += I + "Acqua" + I + "\nNaturale: " + B + k.acqua.N + B + "\nGassata: " + B + k.acqua.G + B + "\n";
      return t;
    }
    function nominativo(day) {
      var p = piattiDel(day);
      return S.rows("ordini").filter(function (o) { return o.data === day && o.stato === "ok"; }).sort(function (a, b) { return a.username.localeCompare(b.username); })
        .map(function (o) { return o.username + ": " + splitCodes(o.scelte).map(function (t) { return breve(t); }).join(", ") + " · acqua " + (o.acqua === "G" ? "gassata" : "naturale"); });
    }
    function testoGiorno(day, wa, intest) {
      var c = cfg(), piatti = piattiDel(day), k = conteggi(day);
      var t = (wa ? "*OMET – " + (intest || "ORDINE MENSA") + "*\n" : "OMET – " + (intest || "ORDINE MENSA") + "\n") + bloccoGiorno(day, k, piatti, wa);
      if (c.nominativoWhatsApp) t += (wa ? "_Nominativo_" : "Nominativo") + "\n" + nominativo(day).join("\n") + "\n";
      return t;
    }
    function testoSettimana(lun, wa) {
      var c = cfg(), giorni = giorniSettimana(lun);
      var t = (wa ? "*OMET – ORDINE MENSA settimana " + periodo(lun) + "*\n" : "OMET – ORDINE MENSA settimana " + periodo(lun) + "\n");
      t += "Totale: " + (wa ? "*" : "") + pl(giorni.reduce(function (s, d) { return s + conteggi(d).pasti; }, 0), "pasto", "pasti") + (wa ? "*" : "") + "\n";
      giorni.forEach(function (d) {
        t += "\n" + bloccoGiorno(d, conteggi(d), piattiDel(d), wa);
        if (c.nominativoWhatsApp) t += (wa ? "_Nominativo_" : "Nominativo") + "\n" + nominativo(d).join("\n") + "\n";
      });
      return t;
    }
    function giorniSettimana(lun) {
      var g = {}; S.rows("menu").forEach(function (r) { if (r.lunedi === lun) g[r.data] = 1; });
      return Object.keys(g).sort();
    }

    /* ---------- documenti stampabili (HTML a tabelle: lo converte anche Google Drive) ----------
       - ordine settimanale per la mensa: un giorno per colonna, solo totali
       - ordine del giorno per la mensa: solo totali (anche per le variazioni)
       - ordine del giorno interno: totali + elenco nominativo, una riga per persona */
    var B_ = "#093E83", L_ = "#D7DEE8", BAND_ = "#EEF3F9", MUTE_ = "#5D6B7C";
    var FONT = "font-family:Segoe UI,Arial,sans-serif;color:#1B2430;";
    var SING = ["PRIMO", "SECONDO", "CONTORNO, FRUTTA O DOLCE"];
    var TD = "border-bottom:1px solid " + L_ + ";padding:5px 8px;font-size:12px;vertical-align:top;";
    var TH = "background:" + B_ + ";color:#fff;font-weight:600;padding:6px 8px;font-size:11px;letter-spacing:.06em;text-align:left;";
    function testata(sopra, titolo, sotto) {
      return '<table style="width:100%;border-collapse:collapse;margin-bottom:12px"><tr>' +
        '<td style="background:' + B_ + ';color:#fff;padding:10px 12px;font-size:10px;letter-spacing:.1em;vertical-align:middle">OMET FOODTECH · MENSA<br><span style="font-size:11px;letter-spacing:.04em;opacity:.85">' + esc(sopra || "") + "</span></td>" +
        '<td style="background:' + B_ + ';color:#fff;padding:10px 12px;text-align:right;vertical-align:middle"><span style="font-size:18px;font-weight:600">' + esc(titolo) + "</span>" +
        (sotto ? '<br><span style="font-size:11px;opacity:.85">' + esc(sotto) + "</span>" : "") + "</td></tr></table>";
    }
    function riquadri(voci) {   // numeri grandi tutti allineati: etichetta sopra, valore sotto, stessa larghezza
      var w = Math.floor(100 / voci.length);
      return '<table style="width:100%;border-collapse:collapse;table-layout:fixed;margin-bottom:10px"><tr>' + voci.map(function (v) {
        return '<td style="width:' + w + '%;border:1px solid ' + L_ + ';border-top:4px solid ' + (v[2] || B_) + ';padding:6px 10px;vertical-align:top">' +
          '<div style="font-size:10px;letter-spacing:.08em;color:' + MUTE_ + ';text-transform:uppercase">' + esc(v[0]) + '</div><div style="font-size:22px;font-weight:700;line-height:1.15">' + esc(String(v[1])) + "</div></td>"; }).join("") + "</tr></table>";
    }
    function tabTotali(piatti, k) {   // tre colonne: primi, secondi, contorno/frutta/dolce – solo i piatti ordinati
      var rr = righeConteggio(piatti, k.cod, true);
      var h = '<table style="width:100%;border-collapse:collapse;table-layout:fixed;margin-bottom:14px"><tr>';
      CATS.forEach(function (cc, i) {
        var l = rr.filter(function (x) { return x.gruppo === cc[0]; });
        h += '<td style="vertical-align:top;' + (i ? "padding-left:10px;" : "") + '"><table style="width:100%;border-collapse:collapse"><tr><th colspan="3" style="' + TH + '">' + cc[1].toUpperCase() + "</th></tr>" +
          (l.length ? l.map(function (x) { return '<tr><td style="' + TD + 'width:22px;font-family:Consolas,monospace;font-weight:700;color:' + B_ + '">' + esc(x.c) + '</td><td style="' + TD + '">' + esc(x.label) +
            '</td><td style="' + TD + 'width:34px;text-align:right;font-size:15px;font-weight:700">' + x.n + "</td></tr>"; }).join("")
            : '<tr><td colspan="3" style="' + TD + 'color:' + MUTE_ + '">nessuno</td></tr>') + "</table></td>";
      });
      return h + "</tr></table>";
    }
    function piede(stamp) {
      return '<p style="font-size:9px;color:' + MUTE_ + ';border-top:1px solid ' + L_ + ';padding-top:4px;margin:8px 0 0">Omet Foodtech · Mensa ' + VERSIONE + " del " + DATA_VERSIONE + " · " + esc(stamp || "") + "</p>";
    }
    function htmlMensaGiorno(day, stamp, variazione) {   // per la mensa: solo totali
      var piatti = piattiDel(day), k = conteggi(day), cf = variazione ? confronto(day) : null;
      if (variazione && !cf) variazione = false;
      var h = '<div class="foglio" style="' + FONT + '">' + testata(variazione ? "Ordine per la mensa · sostituisce il totale precedente" : "Ordine per la mensa", (variazione ? "VARIAZIONE · " : "") + cap(giornoL(day)) + " " + it(day), variazione ? "Ultima variazione: " + tsIt(cf.ultima).replace(" ore ", " alle ") : "");
      h += riquadri([["Pasti", k.pasti], ["Acqua naturale", k.acqua.N], ["Acqua gassata", k.acqua.G]]);
      h += tabTotali(piatti, k);
      if (variazione) {
        var rv = righeVariazione(cf);
        h += '<div style="font-size:12px;margin:0;padding:8px 10px;background:#FFF3C4;border-left:4px solid #E0B400"><b>Variazioni rispetto ' + esc(cf.rifTesto) + "</b> · pasti da " + cf.pastiDa + " a <b>" + cf.pastiA + "</b>" +
          (rv.length ? "<br>" + rv.map(function (x) { return "– " + esc(x); }).join("<br>") : "") + "</div>";
      }
      return h + piede(stamp) + "</div>";
    }
    function htmlRiepilogo(day, stamp) {   // interno: totali + una riga per persona
      var piatti = piattiDel(day), k = conteggi(day);
      var ok = S.rows("ordini").filter(function (o) { return o.data === day && o.stato === "ok"; }).map(pubOrd).sort(function (a, b) { return (a.ospite - b.ospite) || a.username.localeCompare(b.username); });
      var ann = S.rows("ordini").filter(function (o) { return o.data === day && o.stato === "annullato"; }).map(pubOrd);
      var h = '<div class="foglio" style="' + FONT + '">' + testata("Uso interno – con i nomi", "Ordine " + giornoL(day) + " " + it(day));
      h += riquadri([["Pasti", k.pasti]].concat(k.ospiti ? [["Di cui ospiti", k.ospiti]] : []).concat([["Acqua naturale", k.acqua.N], ["Acqua gassata", k.acqua.G], ["Annullati", ann.length, ann.length ? "#E0B400" : null]]));
      h += tabTotali(piatti, k);
      h += '<table style="width:100%;border-collapse:collapse"><tr><th style="' + TH + 'width:20%">NOME</th>' + SING.map(function (x) { return '<th style="' + TH + '">' + x + "</th>"; }).join("") + '<th style="' + TH + 'width:11%">ACQUA</th></tr>';
      ok.forEach(function (o, i) {
        var g = sceltePerGruppo(piatti, o.scelte), bg = i % 2 ? "background:" + BAND_ + ";" : "";
        h += '<tr><td style="' + TD + bg + 'font-weight:600">' + esc(o.username) + (o.inseritoDa ? '<br><span style="font-weight:400;font-size:10px;color:#C76A00">' + (o.ospite ? "ospite · " : "") + "inserito da " + esc(o.inseritoDa) + "</span>" : "") + "</td>" +
          CATS.map(function (cc) { return '<td style="' + TD + bg + '">' + (esc(g[cc[0]]) || '<span style="color:#AEB6C4">—</span>') + "</td>"; }).join("") +
          '<td style="' + TD + bg + '">' + (o.acqua === "G" ? "gassata" : "naturale") + "</td></tr>";
      });
      if (!ok.length) h += '<tr><td colspan="5" style="' + TD + 'color:' + MUTE_ + '">Nessun pasto prenotato.</td></tr>';
      h += "</table>";
      if (ann.length) h += '<p style="font-size:10px;color:' + MUTE_ + ';margin:8px 0 0">Annullati: ' + ann.map(function (o) { return esc(o.username) + (o.tardivo ? " (dopo l'invio" + (o.annullatoDa ? ", da " + esc(o.annullatoDa) + " " + esc(tsIt(o.annullatoIl).replace(" ore ", " alle ")) : "") + ")" : ""); }).join(", ") + "</p>";
      return h + piede(stamp) + "</div>";
    }
    var TW = "border-bottom:1px solid " + L_ + ";font-size:10.5px;padding:2px 4px;line-height:1.3;vertical-align:top";
    var TN = TW + ";text-align:right;font-weight:700;width:20px;font-size:12px";
    function listaGruppo(l) {
      if (!l.length) return '<span style="color:#AEB6C4">—</span>';
      return '<table style="width:100%;border-collapse:collapse">' + l.map(function (y) { return '<tr><td style="' + TW + '"><b style="font-family:Consolas,monospace;color:' + B_ + '">' + esc(y.c) + "</b> " + esc(y.label) + '</td><td style="' + TN + '">' + y.n + "</td></tr>"; }).join("") + "</table>";
    }
    function htmlSettimana(lun, stamp) {   // ordine settimanale per la mensa, A4 verticale: una riga per giorno (come il menu della mensa)
      var giorni = giorniSettimana(lun), tot = 0, nat = 0, gas = 0;
      var righe = giorni.map(function (d) { var k = conteggi(d); tot += k.pasti; nat += k.acqua.N; gas += k.acqua.G; return { d: d, k: k, p: piattiDel(d) }; });
      var note = (S.rows("menuNote").filter(function (r) { return r.lunedi === lun; })[0] || {}).note || "";
      var TC = "border:1px solid " + L_ + ";padding:4px 5px;vertical-align:top;";
      var h = '<div class="foglio" style="' + FONT + '">' + testata("Ordine per la mensa", "Settimana " + periodo(lun) + " " + lun.slice(0, 4));
      h += riquadri([["Pasti della settimana", tot], ["Acqua naturale", nat], ["Acqua gassata", gas]]);
      h += '<table style="width:100%;border-collapse:collapse;table-layout:fixed"><tr><th style="' + TH + 'width:15%">GIORNO</th><th style="' + TH + 'width:27%">PRIMI</th><th style="' + TH + 'width:27%">SECONDI</th><th style="' + TH + '">CONTORNO, FRUTTA O DOLCE</th></tr>';
      righe.forEach(function (x, i) {
        var rr = righeConteggio(x.p, x.k.cod, true), bg = i % 2 ? "background:#FAFBFD;" : "";
        h += '<tr style="page-break-inside:avoid"><td style="' + TC + bg + '"><div style="font-size:13px;font-weight:700">' + esc(cap(giornoL(x.d))) + '</div><div style="font-size:11px">' + it(x.d) + "</div>" +
          '<div style="font-size:20px;font-weight:700;color:' + B_ + ';margin-top:4px">' + x.k.pasti + '</div><div style="font-size:9px;letter-spacing:.06em;color:' + MUTE_ + '">' + (x.k.pasti === 1 ? "PASTO" : "PASTI") + "</div>" +
          '<div style="font-size:10px;margin-top:5px;color:' + MUTE_ + '">Acqua nat. <b style="color:#1B2430">' + x.k.acqua.N + "</b><br>Acqua gas. <b style=\"color:#1B2430\">" + x.k.acqua.G + "</b></div></td>" +
          CATS.map(function (cc) { return '<td style="' + TC + bg + '">' + listaGruppo(rr.filter(function (y) { return y.gruppo === cc[0]; })) + "</td>"; }).join("") + "</tr>";
      });
      if (!righe.length) h += '<tr><td colspan="4" style="' + TC + 'color:' + MUTE_ + '">Nessun menu caricato per questa settimana.</td></tr>';
      h += "</table>";
      if (note) h += '<p style="font-size:10px;color:' + MUTE_ + ';margin:8px 0 0;white-space:pre-wrap"><b>Note del menu:</b> ' + esc(note) + "</p>";
      return h + piede(stamp) + "</div>";
    }
    // foglio di controllo consegna (stampa ~11:00): ordine per la mensa + riquadro da compilare a mano
    function htmlControllo(day, stamp) {
      var piatti = piattiDel(day), k = conteggi(day), si = statoInvio(day);
      var h = '<div class="foglio" style="' + FONT + '">' + testata("Controllo consegna · da allegare ai documenti della mensa", "Controllo " + cap(giornoL(day)) + " " + it(day), "Totale aggiornato alle " + tsIt(now().ts).slice(11));
      h += riquadri([["Pasti ordinati", k.pasti], ["Acqua naturale", k.acqua.N], ["Acqua gassata", k.acqua.G]]);
      h += tabTotali(piatti, k);
      h += '<p style="font-size:11px;margin:0 0 10px;padding:6px 10px;' + (si.daInviare ? "background:#FFF3C4;border-left:4px solid #E0B400" : "background:" + BAND_ + ";border-left:4px solid " + B_) + '">' +
        (si.daInviare ? "<b>Attenzione:</b> l'ordine aggiornato (variazione del " + esc(tsIt(si.ultimoCambio)) + ") non risulta ancora inviato alla mensa." :
          si.ultimoInvio ? "Ultimo invio alla mensa registrato: " + esc(tsIt(si.ultimoInvio)) + "." : "Vale l'ordine settimanale inviato alla chiusura.") + "</p>";
      var R = "border:1px solid #1B2430;padding:10px 12px;font-size:12px;vertical-align:top;";
      var box = '<span style="display:inline-block;width:13px;height:13px;border:1.5px solid #1B2430;vertical-align:-2px;margin:0 4px 0 14px"></span>';
      h += '<table style="width:100%;border-collapse:collapse;page-break-inside:avoid"><tr><th colspan="2" style="' + TH + '">CONTROLLO ALLA CONSEGNA (da compilare a mano)</th></tr>' +
        '<tr><td style="' + R + 'width:50%"><b>Consegna conforme all\'ordine?</b><br><br>' + box + "Sì" + box + "No</td>" +
        '<td style="' + R + '"><b>Se no: pasti consegnati</b><br><br>n. ______________</td></tr>' +
        '<tr><td colspan="2" style="' + R + 'height:110px"><b>Note / variazioni</b></td></tr>' +
        '<tr><td style="' + R + 'height:46px"><b>Controllato da</b></td><td style="' + R + '"><b>Firma</b></td></tr></table>';
      return h + piede(stamp) + "</div>";
    }
    function htmlPersonale(u, lun, stamp) {
      var giorni = giorniSettimana(lun);
      var h = '<div class="foglio" style="' + FONT + '">' + testata("I miei pasti", u.username, "Settimana " + periodo(lun)) +
        '<table style="width:100%;border-collapse:collapse"><tr><th style="' + TH + 'width:18%">GIORNO</th>' + SING.map(function (x) { return '<th style="' + TH + '">' + x + "</th>"; }).join("") + '<th style="' + TH + 'width:11%">ACQUA</th></tr>';
      giorni.forEach(function (d, i) {
        var o = S.rows("ordini").filter(function (x) { return x.data === d && x.uid === u.id; })[0], p = piattiDel(d), bg = i % 2 ? "background:" + BAND_ + ";" : "";
        var ok = o && o.stato === "ok", g = ok ? sceltePerGruppo(p, splitCodes(o.scelte)) : null;
        h += '<tr><td style="' + TD + bg + 'font-weight:600">' + esc(cap(giornoL(d))) + " " + it(d).slice(0, 5) + "</td>" +
          (ok ? CATS.map(function (cc) { return '<td style="' + TD + bg + '">' + (esc(g[cc[0]]) || '<span style="color:#AEB6C4">—</span>') + "</td>"; }).join("") + '<td style="' + TD + bg + '">' + (o.acqua === "G" ? "gassata" : "naturale") + "</td>"
            : '<td colspan="4" style="' + TD + bg + 'color:#6B7785">nessun pasto</td>') + "</tr>";
      });
      return h + "</table>" + piede(stamp) + "</div>";
    }
    function testoPersonale(u, lun) {
      var c = cfg();
      var t = "Ciao " + u.username + ",\necco i tuoi pasti della settimana " + periodo(lun) + ":\n\n";
      giorniSettimana(lun).forEach(function (d) {
        var o = S.rows("ordini").filter(function (x) { return x.data === d && x.uid === u.id; })[0], p = piattiDel(d);
        t += cap(giornoB(d)) + " " + it(d).slice(0, 5) + "  " + (o && o.stato === "ok" ? splitCodes(o.scelte).map(function (x) { return nomeTok(p, x); }).join(", ") + " · acqua " + (o.acqua === "G" ? "gassata" : "naturale") : "nessun pasto") + "\n";
      });
      return t + "\nSe non puoi venire, annulla dalla app entro le " + c.cutoff + " del giorno.\n" + (env.appUrl || "");
    }
    function docHtml(body, titolo) {
      return '<!doctype html><html lang="it"><head><meta charset="utf-8"><title>' + esc(titolo) + '</title><style>@page{size:A4 portrait;margin:10mm}body{margin:0}' +
        ".foglio{page-break-after:always}.foglio:last-child{page-break-after:auto}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head><body>" + body + "</body></html>";
    }
    function stampa(chi, auto) { return "Stampa del " + tsIt(now().ts) + " · " + (auto ? "generato automaticamente" : "da " + chi); }

    /* ---------- riepiloghi per addetti ---------- */
    function riep(day) {
      var piatti = piattiDel(day), c = cfg();
      var tutti = S.rows("ordini").filter(function (o) { return o.data === day; }).map(pubOrd);
      var ok = tutti.filter(function (o) { return o.stato === "ok"; }).sort(function (a, b) { return (a.ospite - b.ospite) || a.username.localeCompare(b.username); });
      var ann = tutti.filter(function (o) { return o.stato === "annullato"; });
      var sbl = tutti.filter(function (o) { return o.stato === "attesa" || o.stato === "approvato"; });
      var k = conteggi(day), ult = ultimoComunicato(day);
      var reg = S.rows("registro").filter(function (r) { return r.data === day; }).sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
      var inv = S.rows("invii").filter(function (i) { return i.data === day; }).sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
      var senza = S.rows("utenti").filter(function (x) { return x.stato === "attivo" && !tutti.some(function (o) { return o.uid === x.id; }); })
        .map(function (x) { return { id: x.id, username: x.username }; }).sort(function (a, b) { return a.username.localeCompare(b.username); });
      return {
        data: day, giorno: giornoL(day), piatti: piatti, ok: ok.map(function (o) { return Object.assign(o, { gruppi: sceltePerGruppo(piatti, o.scelte) }); }), annullati: ann,
        conteggi: k.cod, righe: righeConteggio(piatti, k.cod, false), acqua: k.acqua, ospiti: k.ospiti, sbloccoInAttesa: sbl,
        stato: statoGiorno(day, c), cutoff: c.cutoff, registro: reg.slice(0, 200), invii: inv, senzaOrdine: senza,
        comunicato: (function () { var rf = rifDi(day) || ult; return rf ? { ts: rf.ts, motivo: rf.motivo, differenze: differenze(rf.conteggi, k, piatti) } : null; })(),
        variazione: !!confronto(day),
        invio: statoInvio(day), storico: storico(day), richieste: S.rows("richieste").filter(function (r) { return r.data === day; }).map(pubRich)
      };
    }
    function riepilogo(u, p) {
      serve(u, "addetto");
      var r = riep(p.data), titolo = "mensa_ordine_" + p.data;
      r.titolo = titolo;
      r.html = docHtml(htmlRiepilogo(p.data, stampa(u.username)), titolo + "_interno");
      r.titoloMensa = titolo; r.titolo = titolo + "_interno";
      var varia = !!confronto(p.data);
      r.htmlMensa = docHtml(htmlMensaGiorno(p.data, stampa(u.username), varia), titolo);
      r.whatsapp = varia ? testoVariazione(p.data, true) : testoGiorno(p.data, true) + "\nInviato da " + u.username + " il " + tsIt(now().ts);
      return r;
    }
    function riepilogoSettimana(u, p) {
      serve(u, "addetto");
      var lun = p.lunedi, giorni = giorniSettimana(lun), titolo = "mensa_settimana_" + lun;
      return Object.assign(infoSettimana(lun), {
        giorni: giorni.map(function (d) { var k = conteggi(d), pp = piattiDel(d); return { data: d, pasti: k.pasti, ospiti: k.ospiti, acqua: k.acqua, righe: righeConteggio(pp, k.cod, true), stato: statoGiorno(d) }; }),
        titolo: titolo, html: docHtml(htmlSettimana(lun, stampa(u.username)), titolo),
        whatsapp: testoSettimana(lun, true) + "\nInviato da " + u.username + " il " + tsIt(now().ts)
      });
    }
    function registraInvio(u, p) {
      serve(u, "addetto");
      var giorni = p.lunedi ? giorniSettimana(p.lunedi) : [p.data], n = now();
      var modo = /^(app|whatsapp|copia|segnato)$/.test(p.modo || "") ? p.modo : "app";
      giorni.forEach(function (d) { S.insert("invii", { id: env.uuid().slice(0, 8), data: d, ts: n.ts, da: u.username, modo: modo + (p.lunedi ? " (settimana)" : ""), pasti: conteggi(d).pasti, file: "" }); });
      return { ok: true, invio: p.data ? statoInvio(p.data) : null };
    }
    function documento(u, p) {   // PDF di più giorni (archivio) o personale
      if (p.personale) {
        var lunp = p.lunedi, tp = "mensa_" + u.username.replace(/\W+/g, "_") + "_" + lunp;
        return { html: docHtml(htmlPersonale(u, lunp, stampa(u.username)), tp), titolo: tp };
      }
      serve(u, "addetto");
      var days = p.giorni || [p.data], st = stampa(u.username);
      var titolo = (days.length > 1 ? "mensa_giorni_" : "mensa_ordine_") + days[0] + (p.mensa ? "" : "_interno");
      if (p.controllo) { var tc = "mensa_controllo_" + days[0]; return { html: docHtml(days.map(function (d) { return htmlControllo(d, st); }).join(""), tc), titolo: tc }; }
      return { html: docHtml(days.map(function (d) { return p.mensa ? htmlMensaGiorno(d, st) : htmlRiepilogo(d, st); }).join(""), titolo), titolo: titolo };
    }
    // PDF vero generato dal server (per telefono / app installata, dove la stampa del browser non è affidabile)
    function pdf(u, p) {
      var d;
      if (p.settimana) { serve(u, "addetto"); var ts = "mensa_settimana_" + p.lunedi; d = { html: docHtml(htmlSettimana(p.lunedi, stampa(u.username)), ts), titolo: ts }; }
      else d = documento(u, p);
      if (!env.pdf) return d;   // modalità prova: niente PDF dal server, si stampa dal browser
      return { nome: d.titolo + ".pdf", b64: env.pdf(d.html, d.titolo) };
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
        ok = manda(u.email, "Mensa – ordine " + giornoL(p.data) + " " + it(p.data), testoGiorno(p.data, false) + "\n----- testo per WhatsApp -----\n" + testoGiorno(p.data, true),
          { name: t2 + ".pdf", html: docHtml(htmlMensaGiorno(p.data, stampa(u.username)), t2) }, "riepilogo");
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
      var tipi = {}; S.rows("utenti").forEach(function (x) { tipi[x.id] = x.tipo === "interinale" ? "Interinale" : "Dipendente"; });
      function riga(uid, nome) { return per[uid] || (per[uid] = { uid: uid, username: nome, tipo: tipi[uid] || (String(uid).indexOf("OSP") === 0 ? "Ospite" : "Dipendente"), pasti: 0, nonConsumati: 0, annullati: 0, variazioni: 0, perConto: 0, ospite: false }); }
      ord.forEach(function (o) {
        if (["ok", "annullato"].indexOf(o.stato) < 0) return;   // bozze e pasti di sblocco non approvati non contano
        var r = riga(o.uid, o.username); if (o.stato === "ok") { r.pasti++; if (o.nonConsumato) r.nonConsumati++; } if (o.ospite) r.ospite = true; if (o.inseritoDa) r.perConto++; });
      reg.forEach(function (x) {   // contano solo le modifiche fatte DOPO l'invio dell'ordine al fornitore
        if (!x.dopoChiusura) return;
        var r = riga(x.uid, x.username);
        if (x.azione === "annulla") r.annullati++; else r.variazioni++;
      });
      var ORD_T = { Dipendente: 0, Interinale: 1, Ospite: 2 };
      var righe = Object.keys(per).map(function (k) { return per[k]; }).sort(function (a, b) { return (ORD_T[a.tipo] - ORD_T[b.tipo]) || a.username.localeCompare(b.username); });
      var giorni = {}, giorniNC = {}; ord.forEach(function (o) { if (o.stato === "ok") { giorni[o.data] = (giorni[o.data] || 0) + 1; if (o.nonConsumato) giorniNC[o.data] = (giorniNC[o.data] || 0) + 1; } });
      var tot = righe.reduce(function (s, r) { s.pasti += r.pasti; s.nonConsumati += r.nonConsumati; s.variazioni += r.variazioni; s.annullati += r.annullati;
        s.perTipo[r.tipo] = s.perTipo[r.tipo] || { pasti: 0, nonConsumati: 0, annullati: 0, persone: 0 }; var t = s.perTipo[r.tipo]; t.pasti += r.pasti; t.nonConsumati += r.nonConsumati; t.annullati += r.annullati; t.persone++; return s; },
        { pasti: 0, nonConsumati: 0, variazioni: 0, annullati: 0, perTipo: {} });
      var piattiCache = {};
      var dettaglio = ord.filter(function (o) { return ["ok", "annullato"].indexOf(o.stato) >= 0; }).sort(function (a, b) { return a.data.localeCompare(b.data) || a.username.localeCompare(b.username); }).map(function (o) {
        var p = piattiCache[o.data] || (piattiCache[o.data] = piattiDel(o.data));
        var an = reg.filter(function (x) { return x.uid === o.uid && x.data === o.data && x.azione === "annulla"; }).sort(function (a, b) { return a.ts < b.ts ? 1 : -1; })[0];
        return { data: o.data, giorno: giornoL(o.data), username: o.username, tipo: (per[o.uid] || {}).tipo || "", stato: o.stato === "ok" ? (o.nonConsumato ? "Non consumato" : "Consumato") : "Annullato",
          motivoNC: o.stato === "ok" && o.nonConsumato ? (o.motivoNC || "") + (o.ncDa ? " (segnato da " + o.ncDa + ")" : "") : "", sblocco: !!o.sblocco,
          codici: splitCodes(o.scelte).map(function (t) { return breve(t); }).join(", "), piatti: splitCodes(o.scelte).map(function (t) { return nomeTok(p, t); }).join(", "),
          gruppi: sceltePerGruppo(p, splitCodes(o.scelte)), acqua: o.acqua === "G" ? "Gassata" : "Naturale",
          nota: o.nota || "", annullatoIl: o.stato !== "ok" && an ? an.ts : "", dopoChiusura: o.stato !== "ok" && an ? !!an.dopoChiusura : false,
          inseritoDa: o.inseritoDa || "", ospite: !!o.ospite, annullatoDa: o.stato !== "ok" ? o.annullatoDa || "" : "" };
      });
      var rich = S.rows("richieste").filter(function (r) { return r.data.slice(0, 7) === mese; });
      var giorniM = uniq(ord.map(function (o) { return o.data; }).concat(rich.map(function (r) { return r.data; }))).sort();
      var eventi = [];
      giorniM.forEach(function (d) { storico(d).forEach(function (e) { eventi.push({ data: d, giorno: giornoL(d), ts: e.ts, cosa: e.cosa, chi: e.chi, det: e.det }); }); });
      tot.richieste = rich.length; ["approvata", "rifiutata", "scaduta", "ritirata", "attesa"].forEach(function (k) { tot["rich_" + k] = rich.filter(function (r) { return r.stato === k; }).length; });
      return {
        eventi: eventi,
        mese: mese, righe: righe, totali: tot, perGiorno: Object.keys(giorni).sort().map(function (d) { return { data: d, giorno: giornoL(d), pasti: giorni[d], nonConsumati: giorniNC[d] || 0 }; }),
        dettaglio: dettaglio, annullamenti: reg.filter(function (x) { return x.azione === "annulla" && x.dopoChiusura; }).sort(function (a, b) { return a.ts < b.ts ? -1 : 1; })
      };
    }
    function csvReport(R) {
      var q = function (v) { v = String(v == null ? "" : v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      var L = [["REPORT MENSA " + R.mese], [], ["Tipo", "Utente", "Pasti ordinati", "Ordinati ma non consumati", "Annullamenti dopo l'invio", "Variazioni dopo l'invio", "Inseriti da gestori", "Ospite"]];
      R.righe.forEach(function (r) { L.push([r.tipo, r.username, r.pasti, r.nonConsumati, r.annullati, r.variazioni, r.perConto, r.ospite ? "SI" : ""]); });
      L.push(["", "TOTALE", R.totali.pasti, R.totali.nonConsumati, R.totali.annullati, R.totali.variazioni]);
      if (R.eventi && R.eventi.length) { L.push([], ["VARIAZIONI E APPROVAZIONI"], ["Giorno", "Data/ora", "Evento", "Da", "Dettaglio"]);
        R.eventi.forEach(function (e) { L.push([it(e.data), tsIt(e.ts), e.cosa, e.chi, e.det]); }); }
      return "﻿" + L.map(function (r) { return r.map(q).join(";"); }).join("\r\n");
    }

    /* ---------- utenti (admin) ---------- */
    function utenti(u) {
      serve(u, "admin");
      return { utenti: S.rows("utenti").map(function (x) { return Object.assign(pubblico(x), { tipo: x.tipo === "interinale" ? "interinale" : "dipendente" }); }).sort(function (a, b) { return (a.stato === "attesa" ? 0 : 1) - (b.stato === "attesa" ? 0 : 1) || a.username.localeCompare(b.username); }) };
    }
    function gestisciUtente(u, p) {
      serve(u, "admin");
      var x = S.rows("utenti").filter(function (y) { return y.id === p.id; })[0];
      if (!x) throw err("dati", "Utente non trovato.");
      var patch = {}, n = now(), ris = {};
      if (x.id === u.id && (p.azione === "disattiva" || p.azione === "ruolo" || p.azione === "rifiuta")) throw err("dati", "Non puoi modificare il tuo ruolo o disattivarti da solo.");
      if (p.azione === "approva") {
        patch = { stato: "attivo", approvatoDa: u.username, approvatoIl: n.ts, ruolo: p.ruolo || x.ruolo || "utente", tipo: p.tipo === "interinale" ? "interinale" : (x.tipo || "dipendente") };
        if (patch.ruolo !== "utente") patch.notifiche = true;
        if (x.email) manda(x.email, "Mensa Omet – registrazione approvata", "Ciao " + x.username + ",\nla tua registrazione alla mensa è stata approvata da " + u.username + ".\nOra puoi entrare con il tuo nome utente e PIN.\n\n" + (env.appUrl || ""), null, "approvazione");
      } else if (p.azione === "rifiuta") patch = { stato: "rifiutato", approvatoDa: u.username, approvatoIl: n.ts };
      else if (p.azione === "disattiva") patch = { stato: "disattivo" };
      else if (p.azione === "riattiva") patch = { stato: "attivo" };
      else if (p.azione === "ruolo") { if (["utente", "addetto", "admin"].indexOf(p.ruolo) < 0) throw err("dati", "Ruolo non valido."); patch = { ruolo: p.ruolo, notifiche: p.ruolo !== "utente" }; }
      else if (p.azione === "notifiche") patch = { notifiche: !x.notifiche };
      else if (p.azione === "tipo") { if (["dipendente", "interinale"].indexOf(p.tipo) < 0) throw err("dati", "Tipo non valido."); patch = { tipo: p.tipo }; }
      else if (p.azione === "resetPin") {
        var pin = String(1000 + Math.floor(Math.random() * 9000));
        patch = { pinHash: hashPin(pin, x.salt), errori: 0, bloccatoFino: "" }; ris.pin = pin;
        S.removeWhere("sessioni", function (s) { return s.uid === x.id; });
      } else throw err("dati", "Azione non valida.");
      if (p.azione === "disattiva" || p.azione === "rifiuta") S.removeWhere("sessioni", function (s) { return s.uid === x.id; });
      S.update("utenti", "id", x.id, patch);
      ris.utente = Object.assign(pubblico(Object.assign({}, x, patch)), { tipo: (patch.tipo || x.tipo) === "interinale" ? "interinale" : "dipendente" });
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
      var t = "", wa = "", fogli = "", st = stampa("", true);
      futuri.forEach(function (d) {
        fogli += htmlMensaGiorno(d, st, true);   // contiene le variazioni rispetto all'ordine di venerdì
        var cf = confronto(d), k = conteggi(d), p = piattiDel(d);
        var chi = coda.filter(function (r) { return r.data === d; }).map(function (r) { return "  " + tsIt(r.ts).slice(11) + " " + r.username + ": " + ({ annulla: "annullato", modifica: "modificato", ripristina: "aggiunto", prenota: "aggiunto" }[r.azione] || r.azione) + (r.da !== r.username ? " (da " + r.da + ")" : ""); });
        t += "VARIAZIONE MENSA – " + giornoL(d).toUpperCase() + " " + it(d) + "\nModifica del " + tsIt(n.ts) + "\n\n" + bloccoGiorno(d, k, p, false) +
          (cf ? "\nVariazioni rispetto " + cf.rifTesto + " (pasti da " + cf.pastiDa + " a " + cf.pastiA + "):\n" + righeVariazione(cf).map(function (x) { return "  – " + x; }).join("\n") + "\n" : "") +
          "Dettaglio (solo per i gestori mensa):\n" + chi.join("\n") + "\n\n";
        wa += testoVariazione(d, true) + "\n\n";
        salvaComunicato(d, "variazione");
      });
      segna();
      var ogg = "Mensa – VARIAZIONE " + futuri.map(function (d) { return giornoL(d) + " " + it(d).slice(0, 5); }).join(", ");
      var tit = "mensa_variazione_" + futuri.join("_");
      manda(emailAddetti(), ogg, "⚠ RICORDA: invia alla mensa l'ordine aggiornato (PDF allegato o testo WhatsApp qui sotto) e poi segnalo come inviato nella app.\n\n" + t + "----- testo per WhatsApp -----\n" + wa + (env.appUrl || ""), { name: tit + ".pdf", html: docHtml(fogli, tit) }, "variazione");
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
      // 1b) sblocchi: email in coda, pasti approvati che entrano nel totale la mattina del giorno, scadenze
      S.rows("sblocchi").forEach(function (x) {
        if ((x.stato === "richiesto" || x.stato === "inviato") && !x.notificata && feriale) { avvisaSblocco(x); fatti.push("sblocco " + x.id); }
        if ((x.stato === "richiesto" || x.stato === "sbloccato") && passato(n, fineSblocco(x.lunedi, c))) S.update("sblocchi", "id", x.id, { stato: "scaduto", gestitoIl: n.ts });
      });
      S.rows("ordini").forEach(function (o) {
        if (o.stato === "approvato" && o.data <= n.date && (o.data < n.date || n.time >= c.orarioSblocchi)) { attivaSblocco(o, "automatico (ordine sbloccato)"); fatti.push("sblocco attivo " + o.id); }
        else if ((o.stato === "attesa" || o.stato === "bozza") && passato(n, scadenzaApprov(o.data, c))) { S.update("ordini", "id", o.id, { stato: "decaduto", modificato: n.ts }); fatti.push("decaduto " + o.id); }
      });
      S.rows("sblocchi").forEach(function (x) {   // inviato ma senza più pasti in attesa (tutti decaduti): si chiude
        if (x.stato === "inviato" && !S.rows("ordini").some(function (o) { return o.uid === x.uid && lunedi(o.data) === x.lunedi && o.stato === "attesa"; })) S.update("sblocchi", "id", x.id, { stato: "chiuso", gestitoIl: n.ts });
      });
      // 2) variazioni in coda (mai nel weekend)
      if (feriale) { var v = mandaVariazioni(); if (v) fatti.push(v); }
      // 2b) richieste di annullamento: email in coda (nate nel weekend) e scadenza all'orario di approvazione
      S.rows("richieste").forEach(function (r) {
        if (r.stato !== "attesa") return;
        if (passato(n, scadenzaApprov(r.data, c))) { scadi(r); fatti.push("scaduta " + r.id); return; }
        if (!r.notificata && feriale) { avvisaRichiesta(r); fatti.push("richiesta " + r.id); }
      });
      // 2c) foglio di controllo consegna a gestori e amministrazione (giorni feriali con menu e pasti)
      if (c.orarioControllo && !weekend(n.date) && n.time >= c.orarioControllo && !giaFatto("controllo_" + n.date) && piattiDel(n.date).length) {
        segnaFatto("controllo_" + n.date);
        var kc = conteggi(n.date);
        if (kc.pasti) {
          var dest = uniq(emailAddetti().concat(String(c.emailAmministrazione || "").split(/[,;\s]+/).filter(Boolean)));
          var tc = "mensa_controllo_" + n.date, si = statoInvio(n.date);
          manda(dest, "Mensa – foglio di controllo " + giornoL(n.date) + " " + it(n.date) + " (" + pl(kc.pasti, "pasto", "pasti") + ")",
            "In allegato il foglio di controllo della consegna di oggi: " + pl(kc.pasti, "pasto", "pasti") + ".\nStampalo, compila il riquadro (conforme sì/no, pasti consegnati, note, firma) e allegalo ai documenti della mensa.\n" +
            (si.daInviare ? "\n⚠ ATTENZIONE: l'ordine aggiornato non risulta ancora inviato alla mensa.\n" : "") + "\n" + (env.appUrl || ""),
            { name: tc + ".pdf", html: docHtml(htmlControllo(n.date, stampa("", true)), tc) }, "controllo");
          fatti.push("controllo");
        }
      }
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
        ["cutoff", "chiusuraOra", "approvazioniFino", "orarioControllo", "orarioSblocchi"].forEach(function (k) { if (v[k] && !/^\d{2}:\d{2}$/.test(v[k])) throw err("dati", "Orario non valido."); });
        if (v.varianti) { var vv = {}; Object.keys(v.varianti).forEach(function (k) { var l = (v.varianti[k] || []).map(function (x) { return String(x).trim().toLowerCase(); }).filter(Boolean); if (k.trim() && l.length >= 2) vv[k.trim().toUpperCase()] = uniq(l); }); v.varianti = vv; }
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
      var pub = { cutoff: c.cutoff, chiusuraGiorno: c.chiusuraGiorno, chiusuraOra: c.chiusuraOra, aperturaGiorno: c.aperturaGiorno, variazioni: c.variazioni, limiti: c.limiti, minPiatti: c.minPiatti, nomeMensa: c.nomeMensa, varianti: c.varianti, approvazioniFino: c.approvazioniFino, orarioSblocchi: c.orarioSblocchi };
      // pasto di oggi, per il riquadro in alto
      var po = piattiDel(oggi), oo = S.rows("ordini").filter(function (o) { return o.data === oggi && o.uid === u.id; })[0];
      var r = { io: pubblico(u), cfg: pub, settimane: sett.map(function (w) { return Object.assign(w, infoSettimana(w.lunedi, c)); }), oggi: oggi, ora: now().time,
        settimana: lun ? settimana(u, { lunedi: lun }) : null,
        pastoOggi: po.length ? { data: oggi, ordine: oo ? pubOrd(oo) : null, piatti: po, stato: statoGiorno(oggi, c) } : null };
      if (u.ruolo === "admin") r.inAttesa = S.rows("utenti").filter(function (x) { return x.stato === "attesa"; }).length;
      if (isAddetto(u)) {
        r.richiesteAttesa = inAttesaGestori();
        var dg = [oggi].concat(giorniSettimana(lunedi(oggi)).filter(function (d) { return d > oggi; })).filter(function (d) { return piattiDel(d).length && statoInvio(d).daInviare; });
        r.daInviare = dg;
      }
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
      richieste: richieste, gestisciRichiesta: gestisciRichiesta, ritiraRichiesta: ritiraRichiesta, pdf: pdf,
      richiediSblocco: richiediSblocco, sblocca: sblocca, rifiutaSblocco: rifiutaSblocco, inviaSblocco: inviaSblocco, approvaSblocco: approvaSblocco, segnaNonConsumato: segnaNonConsumato,
      statoGestore: function (u) { serve(u, "addetto"); var o = now().date; return { richiesteAttesa: inAttesaGestori(),
        daInviare: [o].concat(giorniSettimana(lunedi(o)).filter(function (d) { return d > o; })).filter(function (d) { return piattiDel(d).length && statoInvio(d).daInviare; }) }; },
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

    return { call: call, paginaLink: paginaLink, htmlControllo: htmlControllo, statoInvio: statoInvio, storico: storico, tick: function () { _cfg = null; return tick(); }, cfg: cfg, riep: riep, conteggi: conteggi, testoGiorno: testoGiorno, testoSettimana: testoSettimana,
      htmlSettimana: htmlSettimana, htmlRiepilogo: htmlRiepilogo, htmlMensaGiorno: htmlMensaGiorno, htmlPersonale: htmlPersonale, stampa: stampa, docHtml: docHtml, calcReport: calcReport, csvReport: csvReport, statoGiorno: statoGiorno };
  }

  return { create: create, SCHEMA: SCHEMA, CATS: CATS, CATS_MENU: CATS_MENU, grp: grp, DEF_CFG: DEF_CFG, VERSIONE: VERSIONE, DATA_VERSIONE: DATA_VERSIONE,
    util: { pad: pad, iso: iso, it: it, pd: pd, lunedi: lunedi, addDays: addDays, giornoL: giornoL, giornoB: giornoB, tsIt: tsIt, cap: cap, esc: esc, periodo: periodo } };
})();
if (typeof module !== "undefined" && module.exports) module.exports = MensaCore;
