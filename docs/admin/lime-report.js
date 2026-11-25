/* Reads a Lime "Logistics Provider Weekly Report" PDF.
   Returns { weekStart: "YYYY-MM-DD", weekEnd: "YYYY-MM-DD", rows: [{ limeName, tasks, gross }], totalTasks, totalFee }.
   Works in the browser (window.pdfjsLib) and in Node (pass pdfjsLib). */
(function (root) {
  "use strict";
  var MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  function isoFrom(m, d, y) { return y + "-" + String(MONTHS[m]).padStart(2, "0") + "-" + String(d).padStart(2, "0"); }
  function money(s) { return Math.round(parseFloat(String(s).replace(/[$,]/g, "")) * 100) / 100; }

  // Group text pieces into lines (same y), each line sorted left to right.
  async function readLines(pdfjsLib, data) {
    var doc = await pdfjsLib.getDocument({ data: data, isEvalSupported: false }).promise;
    var lines = [];
    for (var p = 1; p <= doc.numPages; p++) {
      var page = await doc.getPage(p);
      var tc = await page.getTextContent();
      var byY = {};
      tc.items.forEach(function (it) {
        var s = (it.str || "").trim();
        if (!s) return;
        var y = Math.round(it.transform[5]);
        var key = Object.keys(byY).filter(function (k) { return Math.abs(k - y) <= 2; })[0];
        (byY[key !== undefined ? key : y] = byY[key !== undefined ? key : y] || []).push({ x: it.transform[4], s: s });
      });
      Object.keys(byY).map(Number).sort(function (a, b) { return b - a; }).forEach(function (y) {
        var items = byY[y].sort(function (a, b) { return a.x - b.x; });
        lines.push({ page: p, items: items, text: items.map(function (i) { return i.s; }).join(" ") });
      });
    }
    return lines;
  }

  function parseLines(lines) {
    var all = lines.map(function (l) { return l.text; }).join(" ");
    var per = all.match(/([A-Z][a-z]{2}) (\d{1,2}), (\d{4}),?\s*\d{1,2}:\d{2}\s*[AP]M\s+[A-Z]{2,4}\s+to\s+([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/);
    if (!per) throw new Error("Couldn't find the billing period. Is this a Lime Logistics Provider Weekly Report?");
    var start = isoFrom(per[1], +per[2], per[3]);
    var endExcl = new Date(Date.UTC(+per[6], MONTHS[per[4]] - 1, +per[5]));
    endExcl.setUTCDate(endExcl.getUTCDate() - 1);
    var end = endExcl.toISOString().slice(0, 10);

    // Column positions from the header row "Sub-Account  Task  Actual Fee  Potential Fee*"
    var header = lines.filter(function (l) { return /^Sub-Account\b/.test(l.text); })[0];
    if (!header) throw new Error("Couldn't find the Sub-Account table in this report.");
    var taskX = header.items.filter(function (i) { return /^Task/.test(i.s); })[0];
    var nameMaxX = taskX ? taskX.x - 5 : 120;

    var rows = [], name = null, inTable = false, totalTasks = null, totalFee = null;
    lines.forEach(function (l) {
      if (l === header) { inTable = true; return; }
      if (!inTable) return;
      var first = l.items[0];
      if (first.x < nameMaxX) {
        if (/^Total$/.test(first.s) && l.items.length > 1 && /Task/.test(l.text)) { name = "__TOTAL__"; return; }
        if (/^Sub-Account/.test(first.s)) return;
        name = /^\d+ Accounts?$/.test(first.s) ? "__TOTAL__" : first.s;
      }
      var m = l.text.match(/(\d+)\s*Total\s+\$?([\d,]+\.\d{2})/);
      if (m && name) {
        if (name === "__TOTAL__") { totalTasks = +m[1]; totalFee = money(m[2]); }
        else rows.push({ limeName: name, tasks: +m[1], gross: money(m[2]) });
        name = name === "__TOTAL__" ? name : null;
      }
    });
    if (!rows.length) throw new Error("No sub-accounts found in this report.");
    return { weekStart: start, weekEnd: end, rows: rows, totalTasks: totalTasks, totalFee: totalFee };
  }

  async function parseLimeReport(pdfjsLib, data) { return parseLines(await readLines(pdfjsLib, data)); }

  if (typeof module !== "undefined" && module.exports) module.exports = { parseLimeReport: parseLimeReport };
  else root.parseLimeReport = function (data) { return parseLimeReport(root.pdfjsLib, data); };
})(this);
