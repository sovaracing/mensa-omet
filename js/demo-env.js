/* Omet – Mensa · ambiente di PROVA nel browser (e nel collaudo con Node).
   Dati in memoria salvati nel dispositivo (localStorage, chiave omet.mensa.prova); la posta non parte:
   finisce in una "casella simulata" visibile in Gestione → Impostazioni. */
(function (root) {
  "use strict";

  // SHA-256 sincrono (piccolo, senza dipendenze)
  function sha256(ascii) {
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    var mp = Math.pow, mw = mp(2, 32), i, j, res = "", words = [], al = unescape(encodeURIComponent(ascii)), abl = al.length * 8;
    var hash = sha256.h = sha256.h || [], k = sha256.k = sha256.k || [], pl = k.length, ic = {};
    for (var c = 2; pl < 64; c++) { if (!ic[c]) { for (i = 0; i < 313; i += c) ic[i] = c; hash[pl] = (mp(c, .5) * mw) | 0; k[pl++] = (mp(c, 1 / 3) * mw) | 0; } }
    hash = hash.slice(0, 8); al += "\x80";
    while (al.length % 64 - 56) al += "\x00";
    for (i = 0; i < al.length; i++) { j = al.charCodeAt(i); words[i >> 2] |= j << ((3 - i) % 4) * 8; }
    words[words.length] = ((abl / mw) | 0); words[words.length] = (abl);
    for (j = 0; j < words.length;) {
      var w = words.slice(j, j += 16), oh = hash; hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2], a = hash[0], e = hash[4];
        var t1 = hash[7] + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & hash[5]) ^ ((~e) & hash[6])) + k[i] +
          (w[i] = (i < 16) ? w[i] : (w[i - 16] + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0);
        var t2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(t1 + t2) | 0].concat(hash); hash[4] = (hash[4] + t1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oh[i]) | 0;
    }
    for (i = 0; i < 8; i++) for (j = 3; j + 1; j--) { var b = (hash[i] >> (j * 8)) & 255; res += ((b < 16) ? 0 : "") + b.toString(16); }
    return res;
  }

  function uuid() {
    try { if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID(); } catch (e) {}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); });
  }

  function memStore(data, onChange) {
    data = data || {};
    function t(n) { return data[n] || (data[n] = []); }
    function ch() { if (onChange) onChange(data); }
    return {
      data: data,
      rows: function (n) { return t(n).map(function (r) { return Object.assign({}, r); }); },
      insert: function (n, r) { t(n).push(Object.assign({}, r)); ch(); },
      insertMany: function (n, rs) { rs.forEach(function (r) { t(n).push(Object.assign({}, r)); }); ch(); },
      update: function (n, k, v, p) { t(n).forEach(function (r) { if (r[k] === v) Object.assign(r, p); }); ch(); },
      remove: function (n, k, v) { data[n] = t(n).filter(function (r) { return r[k] !== v; }); ch(); },
      removeWhere: function (n, f) { data[n] = t(n).filter(function (r) { return !f(Object.assign({}, r)); }); ch(); }
    };
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function parts(d) {
    d = d || new Date();
    var date = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    var time = pad(d.getHours()) + ":" + pad(d.getMinutes());
    return { date: date, time: time, ts: date + "T" + time + ":" + pad(d.getSeconds()) };
  }

  // env completo; opts: {data, onChange, now(), appUrl}
  function makeEnv(opts) {
    opts = opts || {};
    var store = memStore(opts.data, opts.onChange);
    var outbox = opts.outbox || [];
    var clockNow = opts.now || function () { return new Date(); };
    return {
      store: store, outbox: outbox, appUrl: opts.appUrl || "", webUrl: opts.webUrl || "",
      hash: sha256, uuid: uuid,
      clock: { now: clockNow, parts: function (d) { return parts(d || clockNow()); } },
      mail: {
        send: function (m) { outbox.push({ ts: parts(clockNow()).ts, to: m.to, subject: m.subject, body: m.body, allegato: m.attachment ? m.attachment.name : "" }); },
        quota: function () { return 100 - outbox.filter(function (m) { return m.ts.slice(0, 10) === parts(clockNow()).date; }).reduce(function (s, m) { return s + m.to.length; }, 0); }
      },
      files: { salvaPdf: function () { return ""; } }
    };
  }

  var api = { makeEnv: makeEnv, memStore: memStore, sha256: sha256, parts: parts };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MensaDemoEnv = api;
})(typeof self !== "undefined" ? self : this);
