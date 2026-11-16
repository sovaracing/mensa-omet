/* Omet – Mensa · LOGICA COMUNE
   Lo stesso file gira:
   - nel browser in "modalità prova" (dati nel dispositivo, posta simulata);
   - in Google Apps Script come backend vero (dati nel Foglio Google, posta con Gmail), copiato come Core.gs.
   Nessuna dipendenza, tutto sincrono. L'ambiente (env) fornisce archivio, posta, file, orologio, hash. */
var MensaCore = (function () {
  "use strict";

  var VERSIONE = "v0.2";
  var DATA_VERSIONE = "16/11/2026";

  /* ---------- schema delle tabelle (anche intestazioni del Foglio) ---------- */
  // tipo: s testo (default), b sì/no, n numero, j JSON
  var SCHEMA = {
    utenti: [["id"], ["username"], ["pinHash"], ["salt"], ["email"], ["mailMenu", "b"], ["notifiche", "b"], ["ruolo"], ["stato"],
      ["creato"], ["approvatoDa"], ["approvatoIl"], ["errori", "n"], ["bloccatoFino"], ["ultimoAccesso"]],
    sessioni: [["token"], ["uid"], ["creato"], ["scade"], ["dispositivo"]],
    menu: [["data"], ["lunedi"], ["settimana"], ["cod"], ["nome"], ["all"], ["cat"], ["panna", "b"], ["maiale", "b"], ["pos", "n"]],
    menuNote: [["lunedi"], ["settimana"], ["note"], ["caricatoDa"], ["caricatoIl"], ["origine"]],
    ordini: [["id"], ["data"], ["uid"], ["username"], ["scelte"], ["acqua"], ["nota"], ["stato"], ["creato"], ["modificato"],
      ["inseritoDa"], ["tardivo", "b"], ["ospite", "b"]],
    registro: [["ts"], ["data"], ["uid"], ["username"], ["azione"], ["prima"], ["dopo"], ["entroLimite", "b"], ["da"], ["dopoInvio", "b"]],
    invii: [["id"], ["data"], ["ts"], ["da"], ["modo"], ["pasti", "n"], ["file"]],
    posta: [["ts"], ["a"], ["oggetto"], ["tipo"], ["esito"]],
    config: [["chiave"], ["valore", "j"]]
  };

  var CATS = [["primo", "Primi"], ["secondo", "Secondi"], ["contorno", "Contorni"], ["fine", "Frutta e dolce"]];
  var GIORNI = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
  var GIORNI_B = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];

  var DEF_CFG = {
    cutoff: "09:30",            // orario limite per ordinare, variare, annullare
    cutoffGiorno: "stesso",     // "stesso" = il giorno stesso, "prima" = il giorno prima
    limiti: { primo: 1, secondo: 1, contorno: 1, fine: 1 },
    minPiatti: 1,               // almeno N piatti per un ordine valido
    acqua: true,                // scelta acqua N/G
    annullaTardivo: true,       // l'utente può annullare dopo l'orario (segnalato in ritardo)
    notificaNuovi: false,       // mail agli addetti anche per i nuovi ordini (non solo variazioni)
    riepilogoAuto: true,        // all'orario limite: mail con PDF e testo WhatsApp agli addetti
    orarioMenuMail: "07:30",    // mail "menu del giorno" a chi l'ha chiesta
    nominativoWhatsApp: false,  // elenco nomi anche nel testo WhatsApp
    approvazione: true,         // i nuovi utenti devono essere approvati
    emailExtra: "",             // altre caselle per le notifiche (separate da virgola)
    emailAmministrazione: "",   // dove mandare il report mensile il giorno 1
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
  function giornoL(s) { return GIORNI[pd(s).getDay()]; }
  function giornoB(s) { return GIORNI_B[pd(s).getDay()]; }
  function tsIt(ts) { if (!ts) return ""; var p = ts.split("T"); return it(p[0]) + " ore " + (p[1] || "").slice(0, 5); }
  function cap(s) { s = String(s || "").toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function err(code, msg) { var e = new Error(msg); e.code = code; e.utente = true; return e; }
  function norm(u) { return String(u || "").trim().toLowerCase(); }
  function splitCodes(s) { return String(s || "").split(/\s+/).filter(Boolean); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function create(env) {
    var S = env.store, C = env.clock;

    /* ---------- configurazione ---------- */
    function cfg() {
      var c = clone(DEF_CFG);
      S.rows("config").forEach(function (r) { if (r.chiave in c) c[r.chiave] = r.valore; });
      c.limiti = Object.assign({}, DEF_CFG.limiti, c.limiti || {});
      return c;
    }
    function setCfg(patch) {
      var cur = {}; S.rows("config").forEach(function (r) { cur[r.chiave] = true; });
      Object.keys(patch).forEach(function (k) {
        if (!(k in DEF_CFG)) return;
        if (cur[k]) S.update("config", "chiave", k, { valore: patch[k] });
        else S.insert("config", { chiave: k, valore: patch[k] });
      });
    }

    /* ---------- tempo ---------- */
    function now() { return C.parts(); }               // {date:"AAAA-MM-GG", time:"HH:MM", ts:"AAAA-MM-GGTHH:MM:SS"}
    function chiusura(day, c) {                          // data e ora in cui si chiude il giorno
      c = c || cfg();
      return { date: c.cutoffGiorno === "prima" ? addDays(day, -1) : day, time: c.cutoff };
    }
    function chiuso(day, c) {
      var n = now(), ch = chiusura(day, c);
      return n.date > ch.date || (n.date === ch.date && n.time >= ch.time);
    }

    /* ---------- utenti e sessioni ---------- */
    function hashPin(pin, salt) { var h = salt + ":" + pin; for (var i = 0; i < 300; i++) h = env.hash(salt + h); return h; }
    function pubblico(u) {
      return { id: u.id, username: u.username, email: u.email || "", mailMenu: !!u.mailMenu, notifiche: !!u.notifiche, ruolo: u.ruolo, stato: u.stato,
        creato: u.creato, approvatoDa: u.approvatoDa || "", approvatoIl: u.approvatoIl || "", ultimoAccesso: u.ultimoAccesso || "" };
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
      if (p.mailMenu && !email) throw err("dati", "Per ricevere il menu serve un indirizzo email.");
      var tutti = S.rows("utenti");
      if (tutti.some(function (u) { return norm(u.username) === norm(username) && u.stato !== "rifiutato"; })) throw err("dati", "Nome utente già usato: scegline un altro.");
      var c = cfg(), primo = !tutti.some(function (u) { return u.ruolo === "admin" && u.stato === "attivo"; });
      var salt = env.uuid().replace(/-/g, "").slice(0, 16);
      var u = { id: "U" + env.uuid().replace(/-/g, "").slice(0, 10), username: username, pinHash: hashPin(String(p.pin), salt), salt: salt, email: email,
        mailMenu: !!p.mailMenu && !!email, notifiche: primo, ruolo: primo ? "admin" : "utente", stato: (primo || !c.approvazione) ? "attivo" : "attesa",
        creato: now().ts, approvatoDa: primo ? "(primo utente)" : (c.approvazione ? "" : "(automatica)"), approvatoIl: primo || !c.approvazione ? now().ts : "",
        errori: 0, bloccatoFino: "", ultimoAccesso: "" };
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
      if ("mailMenu" in p) patch.mailMenu = !!p.mailMenu;
      if ("notifiche" in p && isAddetto(u)) patch.notifiche = !!p.notifiche;
      var email = "email" in patch ? patch.email : u.email;
      if ((("mailMenu" in patch) ? patch.mailMenu : u.mailMenu) && !email) throw err("dati", "Per ricevere il menu serve un indirizzo email.");
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
    function settimane() {
      var map = {};
      S.rows("menu").forEach(function (r) { (map[r.lunedi] = map[r.lunedi] || { lunedi: r.lunedi, settimana: r.settimana, giorni: {} }).giorni[r.data] = 1; });
      return Object.keys(map).sort().map(function (k) { var w = map[k]; return { lunedi: k, settimana: w.settimana, giorni: Object.keys(w.giorni).sort() }; });
    }
    function settimana(u, p) {
      var lun = p.lunedi, c = cfg();
      var giorni = {};
      S.rows("menu").forEach(function (r) { if (r.lunedi === lun) giorni[r.data] = 1; });
      var note = S.rows("menuNote").filter(function (r) { return r.lunedi === lun; })[0];
      var miei = {};
      S.rows("ordini").forEach(function (o) { if (o.uid === u.id && lunedi(o.data) === lun) miei[o.data] = pubOrd(o); });
      return {
        lunedi: lun, settimana: note ? note.settimana : "", note: note ? String(note.note || "").split("\n").filter(Boolean) : [],
        giorni: Object.keys(giorni).sort().map(function (d) {
          var ch = chiusura(d, c);
          return { data: d, piatti: piattiDel(d), chiuso: chiuso(d, c), chiude: ch, ordine: miei[d] || null };
        })
      };
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
        (w.giorni || []).map(function (g) { return lunedi(g.data); }).filter(function (v, i, a) { return a.indexOf(v) === i; }).forEach(function (lun) {
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
    function descr(o, piatti) {
      if (!o || o.stato !== "ok") return "nessun pasto";
      var sc = splitCodes(o.scelte);
      return sc.map(function (c) { var p = piatti.filter(function (x) { return x.c === c; })[0]; return c + " " + (p ? cap(p.n) : "?"); }).join(", ") +
        (o.acqua ? ", acqua " + (o.acqua === "N" ? "naturale" : "gassata") : "") + (o.nota ? " – nota: " + o.nota : "");
    }
    function inviato(day) { return S.rows("invii").some(function (i) { return i.data === day; }); }

    function salvaOrdine(u, p) {
      var day = p.data, c = cfg();
      var piatti = piattiDel(day);
      if (!piatti.length) throw err("menu", "Per questo giorno non c'è il menu.");
      var perConto = !!(p.uid && p.uid !== u.id) || !!p.ospite;
      if (perConto) serve(u, "addetto");
      var cl = chiuso(day, c);
      if (cl && !isAddetto(u)) throw err("chiuso", "Ordini chiusi per " + giornoL(day) + " " + it(day) + " (orario limite " + c.cutoff + ").");
      // destinatario
      var dest;
      if (p.ospite) {
        var nome = String(p.nomeOspite || "").trim();
        if (!nome && !p.uid) throw err("dati", "Scrivi il nome dell'ospite.");
        dest = p.uid ? { id: p.uid, username: (S.rows("ordini").filter(function (o) { return o.uid === p.uid; })[0] || {}).username || nome } : { id: "OSP" + env.uuid().replace(/-/g, "").slice(0, 8), username: "Ospite – " + nome };
      } else if (p.uid && p.uid !== u.id) {
        dest = S.rows("utenti").filter(function (x) { return x.id === p.uid; })[0];
        if (!dest) throw err("dati", "Utente non trovato.");
      } else dest = u;
      // scelte e regole
      var sc = (p.scelte || []).map(function (x) { return String(x).toUpperCase(); }).filter(function (x, i, a) { return a.indexOf(x) === i; });
      sc.forEach(function (k) { if (!piatti.some(function (x) { return x.c === k; })) throw err("dati", "Codice " + k + " non presente nel menu del giorno."); });
      if (!perConto) CATS.forEach(function (cc) {
        var lim = +c.limiti[cc[0]], n = sc.filter(function (k) { return piatti.filter(function (x) { return x.c === k; })[0].cat === cc[0]; }).length;
        if (n > lim) throw err("regole", cc[1] + ": al massimo " + lim + ".");
      });
      if (sc.length < (+c.minPiatti || 1)) throw err("regole", "Scegli almeno " + (+c.minPiatti || 1) + " piatto.");
      var acqua = c.acqua && /^[NG]$/.test(p.acqua || "") ? p.acqua : "";
      var nota = String(p.nota || "").slice(0, 120);
      // ordina i codici come nel menu
      sc.sort(function (a, b) { return piatti.findIndex(function (x) { return x.c === a; }) - piatti.findIndex(function (x) { return x.c === b; }); });
      var id = day + "_" + dest.id, ex = S.rows("ordini").filter(function (o) { return o.id === id; })[0], n = now();
      var row = { id: id, data: day, uid: dest.id, username: dest.username, scelte: sc.join(" "), acqua: acqua, nota: nota, stato: "ok",
        creato: ex ? ex.creato : n.ts, modificato: n.ts, inseritoDa: perConto ? u.username : (ex ? ex.inseritoDa : ""), tardivo: cl, ospite: !!p.ospite };
      var azione = ex ? (ex.stato === "ok" ? "modifica" : "ripristina") : "prenota";
      if (ex && ex.stato === "ok" && ex.scelte === row.scelte && (ex.acqua || "") === acqua && (ex.nota || "") === nota) return { ordine: pubOrd(ex), invariato: true };
      if (ex) S.update("ordini", "id", id, row); else S.insert("ordini", row);
      registra_(day, dest, azione, descr(ex, piatti), descr(row, piatti), !cl, u.username, inviato(day));
      if (azione !== "prenota" || c.notificaNuovi || cl || perConto) notificaAddetti(day, dest, azione, descr(ex, piatti), descr(row, piatti), !cl, u);
      return { ordine: pubOrd(row) };
    }

    function annullaOrdine(u, p) {
      var day = p.data, c = cfg(), uid = p.uid || u.id;
      if (uid !== u.id) serve(u, "addetto");
      var cl = chiuso(day, c);
      if (cl && !isAddetto(u) && !c.annullaTardivo) throw err("chiuso", "Orario limite superato: per annullare chiedi agli addetti mensa.");
      var id = day + "_" + uid, ex = S.rows("ordini").filter(function (o) { return o.id === id; })[0];
      if (!ex || ex.stato !== "ok") throw err("dati", "Non c'è un ordine da annullare.");
      var n = now(), piatti = piattiDel(day);
      S.update("ordini", "id", id, { stato: "annullato", modificato: n.ts, tardivo: cl, inseritoDa: uid !== u.id ? u.username : ex.inseritoDa });
      var dest = { id: uid, username: ex.username };
      registra_(day, dest, "annulla", descr(ex, piatti), "nessun pasto", !cl, u.username, inviato(day));
      notificaAddetti(day, dest, "annulla", descr(ex, piatti), "nessun pasto", !cl, u);
      return { ok: true, tardivo: cl };
    }

    function registra_(day, dest, azione, prima, dopo, entro, da, dopoInvio) {
      S.insert("registro", { ts: now().ts, data: day, uid: dest.id, username: dest.username, azione: azione, prima: prima, dopo: dopo, entroLimite: entro, da: da, dopoInvio: !!dopoInvio });
    }

    /* ---------- posta ---------- */
    function manda(to, oggetto, testo, allegato, tipo) {
      to = (Array.isArray(to) ? to : [to]).filter(Boolean).filter(function (v, i, a) { return a.indexOf(v) === i; });
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
      String(c.emailExtra || "").split(/[,;\s]+/).filter(emailOk).filter(Boolean).forEach(function (e) { l.push(e); });
      return l;
    }
    var AZ = { prenota: "NUOVO ORDINE", modifica: "VARIAZIONE", annulla: "ANNULLAMENTO", ripristina: "NUOVO ORDINE (dopo annullamento)" };
    function notificaAddetti(day, dest, azione, prima, dopo, entro, chi) {
      var c = cfg();
      var ogg = "Mensa – " + AZ[azione] + (entro ? "" : " FUORI ORARIO") + " – " + giornoB(day) + " " + it(day).slice(0, 5) + " – " + dest.username;
      var t = AZ[azione] + (entro ? " entro l'orario limite (" + c.cutoff + ")" : " DOPO l'orario limite (" + c.cutoff + ")") + "\n\n" +
        "Giorno:  " + giornoL(day) + " " + it(day) + "\n" + "Utente:  " + dest.username + "\n" +
        (chi.username !== dest.username ? "Inserito da:  " + chi.username + "\n" : "") +
        "Prima:   " + prima + "\n" + "Ora:     " + dopo + "\n" + "Quando:  " + tsIt(now().ts) + "\n" +
        (inviato(day) ? "\nATTENZIONE: il riepilogo di questo giorno era già stato inviato alla mensa.\n" : "") +
        "\n" + (env.appUrl || "");
      manda(emailAddetti(), ogg, t, null, "variazione");
    }

    /* ---------- riepilogo del giorno ---------- */
    function riepilogo(u, p) {
      serve(u, "addetto");
      return riep(p.data);
    }
    function riep(day) {
      var piatti = piattiDel(day), c = cfg();
      var tutti = S.rows("ordini").filter(function (o) { return o.data === day; }).map(pubOrd);
      var ok = tutti.filter(function (o) { return o.stato === "ok"; }).sort(function (a, b) { return (a.ospite - b.ospite) || a.username.localeCompare(b.username); });
      var ann = tutti.filter(function (o) { return o.stato === "annullato"; });
      var cnt = {}; ok.forEach(function (o) { o.scelte.forEach(function (k) { cnt[k] = (cnt[k] || 0) + 1; }); });
      var reg = S.rows("registro").filter(function (r) { return r.data === day; }).sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
      var inv = S.rows("invii").filter(function (i) { return i.data === day; }).sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
      var attivi = S.rows("utenti").filter(function (x) { return x.stato === "attivo"; });
      var senza = attivi.filter(function (x) { return !tutti.some(function (o) { return o.uid === x.id; }); }).map(function (x) { return { id: x.id, username: x.username }; })
        .sort(function (a, b) { return a.username.localeCompare(b.username); });
      return {
        data: day, giorno: giornoL(day), piatti: piatti, ok: ok, annullati: ann, conteggi: cnt,
        acqua: { N: ok.filter(function (o) { return o.acqua === "N"; }).length, G: ok.filter(function (o) { return o.acqua === "G"; }).length },
        ospiti: ok.filter(function (o) { return o.ospite; }).length,
        chiuso: chiuso(day, c), chiude: chiusura(day, c), registro: reg.slice(0, 200), invii: inv, senzaOrdine: senza
      };
    }
    function testoWhatsApp(r, stamp) {
      var c = cfg();
      var t = "*OMET – ORDINE MENSA*\n*" + cap(r.giorno) + " " + it(r.data) + "*\n" + "Pasti: *" + r.ok.length + "*" + (r.ospiti ? " (di cui ospiti " + r.ospiti + ")" : "") + "\n";
      CATS.forEach(function (cc) {
        var righe = r.piatti.filter(function (x) { return x.cat === cc[0] && r.conteggi[x.c]; }).map(function (x) { return x.c + " " + cap(x.n) + ": *" + r.conteggi[x.c] + "*"; });
        if (righe.length) t += "\n_" + cc[1].toUpperCase() + "_\n" + righe.join("\n") + "\n";
      });
      if (c.acqua && (r.acqua.N || r.acqua.G)) t += "\n_ACQUA_\nNaturale: *" + r.acqua.N + "*\nGassata: *" + r.acqua.G + "*\n";
      var note = r.ok.filter(function (o) { return o.nota; });
      if (note.length) t += "\n_NOTE_\n" + note.map(function (o) { return o.username + ": " + o.nota; }).join("\n") + "\n";
      if (c.nominativoWhatsApp) t += "\n_NOMINATIVO_\n" + r.ok.map(function (o) { return o.username + ": " + o.scelte.join(" ") + (o.acqua ? " · " + o.acqua : ""); }).join("\n") + "\n";
      if (stamp) t += "\n" + stamp;
      return t;
    }
    // HTML per PDF (stampa da app e allegato email). Solo tabelle e stili semplici: lo converte anche Google Drive.
    function htmlRiepilogo(r, stamp, titoloDoc) {
      var c = cfg();
      var B = "#093E83", L = "#D7DEE8", BAND = "#EEF3F9";
      var td = "border:1px solid " + L + ";padding:4px 6px;font-size:11px;";
      var th = td + "background:" + B + ";color:#fff;font-weight:600;";
      var h = '<div class="foglio" style="font-family:Segoe UI,Arial,sans-serif;color:#1B2430;">' +
        '<table style="width:100%;border-collapse:collapse;margin-bottom:10px"><tr><td style="background:' + B + ';color:#fff;padding:8px 10px;font-size:11px;letter-spacing:.08em">OMET FOODTECH · MENSA</td>' +
        '<td style="background:' + B + ';color:#fff;padding:8px 10px;font-size:16px;font-weight:600;text-align:right">Ordine ' + esc(r.giorno) + " " + it(r.data) + '</td></tr></table>' +
        '<table style="border-collapse:collapse;margin-bottom:10px"><tr>' +
        '<td style="padding:4px 18px 4px 0;font-size:11px;color:#5D6B7C">PASTI<br><b style="font-size:22px;color:#1B2430">' + r.ok.length + "</b></td>" +
        (r.ospiti ? '<td style="padding:4px 18px 4px 0;font-size:11px;color:#5D6B7C">DI CUI OSPITI<br><b style="font-size:22px;color:#1B2430">' + r.ospiti + "</b></td>" : "") +
        (c.acqua ? '<td style="padding:4px 18px 4px 0;font-size:11px;color:#5D6B7C">ACQUA NAT. / GASS.<br><b style="font-size:22px;color:#1B2430">' + r.acqua.N + " / " + r.acqua.G + "</b></td>" : "") +
        '<td style="padding:4px 18px 4px 0;font-size:11px;color:#5D6B7C">ANNULLATI<br><b style="font-size:22px;color:#1B2430">' + r.annullati.length + "</b></td></tr></table>";
      // totali per piatto, quattro colonne
      h += '<table style="width:100%;border-collapse:collapse;margin-bottom:12px"><tr>';
      CATS.forEach(function (cc) {
        h += '<td style="vertical-align:top;padding-right:8px;width:25%"><table style="width:100%;border-collapse:collapse"><tr><th colspan="3" style="' + th + 'text-align:left">' + cc[1].toUpperCase() + "</th></tr>";
        r.piatti.filter(function (x) { return x.cat === cc[0]; }).forEach(function (x) {
          var n = r.conteggi[x.c] || 0;
          h += '<tr><td style="' + td + 'font-family:Consolas,monospace;font-weight:700;color:' + B + ';width:18px">' + esc(x.c) + '</td><td style="' + td + '">' + esc(cap(x.n)) +
            '</td><td style="' + td + 'text-align:right;font-weight:700;width:24px;' + (n ? "" : "color:#AEB6C4;") + '">' + (n || "–") + "</td></tr>";
        });
        h += "</table></td>";
      });
      h += "</tr></table>";
      // foglio nominativo
      var codes = r.piatti.map(function (x) { return x.c; });
      h += '<table style="width:100%;border-collapse:collapse"><tr><th style="' + th + 'text-align:left">NOMINATIVO</th>' + codes.map(function (k) { return '<th style="' + th + 'text-align:center;padding:4px 2px">' + esc(k) + "</th>"; }).join("") +
        (c.acqua ? '<th style="' + th + '">ACQUA</th>' : "") + '<th style="' + th + 'text-align:left">NOTE</th></tr>';
      r.ok.forEach(function (o, i) {
        var bg = i % 2 ? "background:" + BAND + ";" : "";
        h += '<tr><td style="' + td + bg + 'white-space:nowrap">' + esc(o.username) + (o.inseritoDa ? ' <span style="color:#C76A00">(' + (o.ospite ? "ospite, " : "") + "ins. " + esc(o.inseritoDa) + ")</span>" : "") + "</td>" +
          codes.map(function (k) { return '<td style="' + td + bg + 'text-align:center;padding:4px 2px;font-weight:700">' + (o.scelte.indexOf(k) >= 0 ? "X" : "") + "</td>"; }).join("") +
          (c.acqua ? '<td style="' + td + bg + 'text-align:center">' + (o.acqua || "") + "</td>" : "") + '<td style="' + td + bg + '">' + esc(o.nota) + "</td></tr>";
      });
      h += '<tr><td style="' + td + 'font-weight:700;background:' + BAND + '">TOTALE</td>' + codes.map(function (k) { return '<td style="' + td + 'text-align:center;padding:4px 2px;font-weight:700;background:' + BAND + '">' + (r.conteggi[k] || "") + "</td>"; }).join("") +
        (c.acqua ? '<td style="' + td + 'text-align:center;font-weight:700;background:' + BAND + '">' + r.acqua.N + "N " + r.acqua.G + "G</td>" : "") + '<td style="' + td + 'background:' + BAND + '"></td></tr></table>';
      if (r.annullati.length) h += '<p style="font-size:10px;color:#5D6B7C;margin:8px 0 0">Annullati: ' + r.annullati.map(function (o) { return esc(o.username) + (o.tardivo ? " (in ritardo)" : ""); }).join(", ") + "</p>";
      h += '<p style="font-size:9px;color:#5D6B7C;border-top:1px solid ' + L + ';padding-top:4px;margin-top:14px">Omet Foodtech · Mensa ' + VERSIONE + " del " + DATA_VERSIONE + " · " + esc(stamp || "") + "</p></div>";
      return h;
    }
    function docHtml(body, titolo) {
      return '<!doctype html><html lang="it"><head><meta charset="utf-8"><title>' + esc(titolo) + '</title><style>@page{size:A4 landscape;margin:10mm}body{margin:0}' +
        ".foglio{page-break-after:always}.foglio:last-child{page-break-after:auto}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}</style></head><body>" + body + "</body></html>";
    }
    function stampa(chi, modo) { return "Stampa del " + tsIt(now().ts) + " · " + (modo === "auto" ? "generato automaticamente all'orario limite" : "da " + chi); }

    function registraInvio(u, p) {
      serve(u, "addetto");
      var r = riep(p.data), n = now();
      var row = { id: env.uuid().slice(0, 8), data: p.data, ts: n.ts, da: u.username, modo: p.modo || "app", pasti: r.ok.length, file: "" };
      S.insert("invii", row);
      return { invio: row };
    }
    function documento(u, p) {   // HTML pronto da stampare/salvare in PDF, con timbro
      serve(u, "addetto");
      var days = p.giorni || [p.data], st = stampa(u.username, "app");
      var body = days.map(function (d) { return htmlRiepilogo(riep(d), st); }).join("");
      var titolo = days.length > 1 ? "mensa_settimana_" + lunedi(days[0]) : "mensa_ordine_" + days[0];
      return { html: docHtml(body, titolo), titolo: titolo, whatsapp: days.length === 1 ? testoWhatsApp(riep(days[0]), "Inviato da " + u.username + " il " + tsIt(now().ts)) : "" };
    }

    /* ---------- archivio settimanale ---------- */
    function archivio(u, p) {
      serve(u, "addetto");
      var lun = p.lunedi;
      var giorni = settimane().filter(function (w) { return w.lunedi === lun; })[0];
      return {
        lunedi: lun, giorni: (giorni ? giorni.giorni : []).map(function (d) {
          var r = riep(d);
          return { data: d, pasti: r.ok.length, ospiti: r.ospiti, annullati: r.annullati.length, variazioni: r.registro.filter(function (x) { return x.azione !== "prenota"; }).length, invii: r.invii };
        })
      };
    }

    /* ---------- report mensile ---------- */
    function report(u, p) {
      serve(u, "admin");
      return calcReport(p.mese);
    }
    function calcReport(mese) {
      var ord = S.rows("ordini").filter(function (o) { return o.data.slice(0, 7) === mese; });
      var reg = S.rows("registro").filter(function (r) { return r.data.slice(0, 7) === mese; });
      var per = {};
      function riga(uid, nome) { return per[uid] || (per[uid] = { uid: uid, username: nome, pasti: 0, prenotazioni: 0, variazioni: 0, annullati: 0, annullatiTardivi: 0, perConto: 0, ospite: false }); }
      ord.forEach(function (o) { var r = riga(o.uid, o.username); if (o.stato === "ok") r.pasti++; if (o.ospite) r.ospite = true; if (o.inseritoDa) r.perConto++; });
      reg.forEach(function (x) {
        var r = riga(x.uid, x.username);
        if (x.azione === "prenota" || x.azione === "ripristina") r.prenotazioni++;
        if (x.azione === "modifica") r.variazioni++;
        if (x.azione === "annulla") { r.annullati++; if (!x.entroLimite) r.annullatiTardivi++; }
      });
      var righe = Object.keys(per).map(function (k) { return per[k]; }).sort(function (a, b) { return (b.annullati - a.annullati) || (b.annullatiTardivi - a.annullatiTardivi) || a.username.localeCompare(b.username); });
      var giorni = {}; ord.forEach(function (o) { if (o.stato === "ok") giorni[o.data] = (giorni[o.data] || 0) + 1; });
      var tot = righe.reduce(function (s, r) { s.pasti += r.pasti; s.variazioni += r.variazioni; s.annullati += r.annullati; s.tardivi += r.annullatiTardivi; return s; }, { pasti: 0, variazioni: 0, annullati: 0, tardivi: 0 });
      return {
        mese: mese, righe: righe, totali: tot, perGiorno: Object.keys(giorni).sort().map(function (d) { return { data: d, pasti: giorni[d] }; }),
        annullamenti: reg.filter(function (x) { return x.azione === "annulla"; }).sort(function (a, b) { return a.ts < b.ts ? -1 : 1; })
      };
    }
    function csvReport(R) {
      var q = function (v) { v = String(v == null ? "" : v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      var L = [["REPORT MENSA " + R.mese], [], ["Utente", "Pasti consumati", "Prenotazioni", "Variazioni", "Annullamenti", "di cui fuori orario", "Inseriti da addetti", "Ospite"]];
      R.righe.forEach(function (r) { L.push([r.username, r.pasti, r.prenotazioni, r.variazioni, r.annullati, r.annullatiTardivi, r.perConto, r.ospite ? "SI" : ""]); });
      L.push(["TOTALE", R.totali.pasti, "", R.totali.variazioni, R.totali.annullati, R.totali.tardivi]);
      L.push([], ["PASTI PER GIORNO"], ["Data", "Pasti"]);
      R.perGiorno.forEach(function (g) { L.push([it(g.data), g.pasti]); });
      L.push([], ["DETTAGLIO ANNULLAMENTI"], ["Giorno", "Utente", "Quando", "Entro l'orario", "Fatto da", "Ordine annullato"]);
      R.annullamenti.forEach(function (a) { L.push([it(a.data), a.username, tsIt(a.ts), a.entroLimite ? "SI" : "NO", a.da, a.prima]); });
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

    /* ---------- lavori a orario (trigger ogni 5 minuti nel backend) ---------- */
    function giaFatto(chiave) { return S.rows("config").some(function (r) { return r.chiave === "_fatto_" + chiave; }); }
    function segnaFatto(chiave) { S.insert("config", { chiave: "_fatto_" + chiave, valore: now().ts }); }
    function tick() {
      var c = cfg(), n = now(), fatti = [];
      // 1) mail "menu del giorno" a chi l'ha chiesta
      var oggi = n.date, piatti = piattiDel(oggi);
      if (piatti.length && n.time >= c.orarioMenuMail && !giaFatto("menu_" + oggi)) {
        segnaFatto("menu_" + oggi);
        var ordiniOggi = S.rows("ordini").filter(function (o) { return o.data === oggi; });
        S.rows("utenti").filter(function (x) { return x.stato === "attivo" && x.mailMenu && x.email; }).forEach(function (x) {
          var o = ordiniOggi.filter(function (y) { return y.uid === x.id; })[0];
          var stato = o && o.stato === "ok" ? "Hai ordinato: " + descr(o, piatti) : (chiuso(oggi, c) ? "Non hai ordinato per oggi." : "Non hai ancora ordinato: hai tempo fino alle " + c.cutoff + ".");
          manda(x.email, "Mensa – menu di " + giornoL(oggi) + " " + it(oggi), testoMenu(oggi, piatti) + "\n" + stato + "\n\nPer ordinare: " + (env.appUrl || "apri la app Mensa Omet"), null, "menu");
        });
        fatti.push("menu");
      }
      // 2) riepilogo automatico all'orario limite (per il giorno che si chiude ora)
      if (c.riepilogoAuto) {
        [oggi, addDays(oggi, 1)].forEach(function (d) {
          var ch = chiusura(d, c);
          if (ch.date !== oggi || n.time < ch.time || giaFatto("riep_" + d) || !piattiDel(d).length) return;
          segnaFatto("riep_" + d);
          var r = riep(d), st = stampa("", "auto");
          var titolo = "mensa_ordine_" + d;
          var url = "";
          try { if (env.files) url = env.files.salvaPdf(d, docHtml(htmlRiepilogo(r, st), titolo), titolo) || ""; } catch (e) { url = ""; }
          S.insert("invii", { id: env.uuid().slice(0, 8), data: d, ts: n.ts, da: "automatico", modo: "auto", pasti: r.ok.length, file: url });
          manda(emailAddetti(), "Mensa – ORDINE " + giornoB(d) + " " + it(d) + " – " + r.ok.length + " pasti",
            "Riepilogo dell'ordine per " + giornoL(d) + " " + it(d) + ", chiuso alle " + c.cutoff + ".\nIn allegato il PDF; qui sotto il testo da copiare su WhatsApp.\n\n" +
            "----------\n" + testoWhatsApp(r, "Inviato il " + tsIt(n.ts)) + "\n----------\n" + (url ? "\nCopia nell'archivio: " + url + "\n" : "") + "\n" + (env.appUrl || ""),
            { name: titolo + ".pdf", html: docHtml(htmlRiepilogo(r, st), titolo) }, "riepilogo");
          fatti.push("riepilogo " + d);
        });
      }
      // 3) report mensile all'amministrazione il giorno 1
      var mesePrec = (function () { var d = pd(oggi); d.setDate(1); d.setMonth(d.getMonth() - 1); return iso(d).slice(0, 7); })();
      if (c.emailAmministrazione && oggi.slice(8) === "01" && !giaFatto("report_" + mesePrec)) {
        segnaFatto("report_" + mesePrec);
        var R = calcReport(mesePrec);
        manda(c.emailAmministrazione, "Mensa – report " + mesePrec, "Report mensile della mensa: " + R.totali.pasti + " pasti, " + R.totali.annullati + " annullamenti (" + R.totali.tardivi + " fuori orario).\n" +
          "In allegato il dettaglio per utente, ordinato per numero di annullamenti.\n\n" +
          R.righe.slice(0, 10).map(function (r) { return r.username + ": " + r.pasti + " pasti, " + r.annullati + " annullamenti" + (r.annullatiTardivi ? " (" + r.annullatiTardivi + " fuori orario)" : ""); }).join("\n"),
          { name: "mensa_report_" + mesePrec + ".csv", csv: csvReport(R) }, "report");
        fatti.push("report");
      }
      return { fatti: fatti, ora: n.ts };
    }
    function testoMenu(day, piatti) {
      var t = "MENU DI " + giornoL(day).toUpperCase() + " " + it(day) + "\n";
      CATS.forEach(function (cc) {
        var l = piatti.filter(function (x) { return x.cat === cc[0]; });
        if (l.length) t += "\n" + cc[1].toUpperCase() + "\n" + l.map(function (x) { return "  " + x.c + "  " + cap(x.n) + (x.panna ? " (panna)" : "") + (x.maiale ? " (maiale)" : "") + (x.all ? "  [all. " + x.all + "]" : ""); }).join("\n") + "\n";
      });
      return t;
    }

    /* ---------- impostazioni e stato ---------- */
    function impostazioni(u, p) {
      serve(u, "admin");
      if (p && p.salva) {
        var v = p.salva;
        if (v.cutoff && !/^\d{2}:\d{2}$/.test(v.cutoff)) throw err("dati", "Orario non valido.");
        if (v.orarioMenuMail && !/^\d{2}:\d{2}$/.test(v.orarioMenuMail)) throw err("dati", "Orario non valido.");
        setCfg(v);
      }
      return { cfg: cfg(), quota: env.mail.quota ? env.mail.quota() : null, posta: S.rows("posta").slice(-40).reverse() };
    }
    function io(u) {
      var c = cfg();
      var pub = { cutoff: c.cutoff, cutoffGiorno: c.cutoffGiorno, limiti: c.limiti, minPiatti: c.minPiatti, acqua: c.acqua, annullaTardivo: c.annullaTardivo, nomeMensa: c.nomeMensa };
      var r = { io: pubblico(u), cfg: pubblico_cfg(pub), settimane: settimane(), oggi: now().date, ora: now().time };
      if (u.ruolo === "admin") r.inAttesa = S.rows("utenti").filter(function (x) { return x.stato === "attesa"; }).length;
      return r;
    }
    function pubblico_cfg(x) { return x; }
    function ultimoOrdine(u, p) {   // per "come l'ultima volta"
      var o = S.rows("ordini").filter(function (x) { return x.uid === u.id && x.stato === "ok" && x.data < p.data; }).sort(function (a, b) { return a.data < b.data ? 1 : -1; })[0];
      if (!o) return { ordine: null };
      return { ordine: pubOrd(o), piatti: piattiDel(o.data) };
    }

    /* ---------- smistamento chiamate ---------- */
    var PUBBLICHE = { registra: registra, login: login, info: function () { return { versione: VERSIONE, data: DATA_VERSIONE, oggi: now().date, ora: now().time }; } };
    var PRIVATE = {
      io: io, esci: esci, profilo: profilo, settimana: settimana, salvaOrdine: salvaOrdine, annullaOrdine: annullaOrdine, ultimoOrdine: ultimoOrdine,
      riepilogo: riepilogo, registraInvio: registraInvio, documento: documento, archivio: archivio, salvaMenu: salvaMenu, eliminaGiorno: eliminaGiorno,
      report: report, utenti: utenti, gestisciUtente: gestisciUtente, impostazioni: impostazioni,
      csvReport: function (u, p) { serve(u, "admin"); return { csv: csvReport(calcReport(p.mese)), nome: "mensa_report_" + p.mese + ".csv" }; },
      tickOra: function (u) { serve(u, "admin"); return tick(); },
      provaEmail: function (u) { serve(u, "admin"); if (!u.email) throw err("dati", "Inserisci prima la tua email nel profilo."); return { ok: manda(u.email, "Mensa Omet – email di prova", "Se leggi questo messaggio, le email della mensa funzionano.", null, "prova") }; }
    };
    function call(action, params, token) {
      params = params || {};
      if (PUBBLICHE[action]) return PUBBLICHE[action](params);
      if (!PRIVATE[action]) throw err("dati", "Azione sconosciuta: " + action);
      var u = utenteDa(token);
      return PRIVATE[action](u, params, token);
    }

    return { call: call, tick: tick, cfg: cfg, riep: riep, htmlRiepilogo: htmlRiepilogo, testoWhatsApp: testoWhatsApp, docHtml: docHtml, calcReport: calcReport, csvReport: csvReport };
  }

  return { create: create, SCHEMA: SCHEMA, CATS: CATS, DEF_CFG: DEF_CFG, VERSIONE: VERSIONE, DATA_VERSIONE: DATA_VERSIONE,
    util: { pad: pad, iso: iso, it: it, pd: pd, lunedi: lunedi, addDays: addDays, giornoL: giornoL, giornoB: giornoB, tsIt: tsIt, cap: cap, esc: esc } };
})();
if (typeof module !== "undefined" && module.exports) module.exports = MensaCore;
