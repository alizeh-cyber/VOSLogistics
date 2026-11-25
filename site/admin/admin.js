/* VOS admin dashboard */
(function () {
  "use strict";
  var sb = vosClient();
  var $ = function (id) { return document.getElementById(id); };
  var app = $("app"), who = $("who");
  var session = null, tab = "apps";
  var DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var APP_STATUS = { new: ["New", "blue"], contacted: ["Contacted", "amber"], hired: ["Hired", "green"], not_a_fit: ["Not a fit", "red"] };
  var ASSOC_STATUS = { pending: ["Waiting for approval", "amber"], approved: ["Approved", "green"], declined: ["Declined", "red"] };
  var data = { apps: [], assoc: [], waivers: [], types: [], settings: null, sched: [] };
  var schedWeek = 0;
  try { tab = localStorage.getItem("vosAdminTab") || "apps"; } catch (e) {}

  function fmtDate(s) { return s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""; }
  function fmtDateTime(s) { return s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""; }
  function badge(map, k) { var v = map[k] || [k, ""]; return '<span class="badge ' + v[1] + '">' + esc(v[0]) + "</span>"; }
  function yn(b) { return b === true ? "Yes" : b === false ? "No" : "—"; }
  function list(a) { return a && a.length ? a.join(", ") : "—"; }
  function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function mondayOf(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function parseDate(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }

  // ---------- Login ----------
  function showLogin(msg) {
    who.innerHTML = "";
    app.innerHTML = '<div class="card" style="max-width:440px;margin:30px auto"><div class="eyebrow">VOS Logistics</div><h1>Admin login</h1>' +
      '<form id="lf" novalidate><label for="le">Email</label><input type="email" id="le" autocomplete="email">' +
      '<label for="lp">Password</label><input type="password" id="lp" autocomplete="current-password">' +
      '<button class="btn block" style="margin-top:20px" id="lb">Log in</button><div class="error" id="lerr">' + esc(msg || "") + "</div></form></div>";
    $("lf").onsubmit = async function (e) {
      e.preventDefault();
      var btn = $("lb"); btn.disabled = true; $("lerr").textContent = "";
      var r = await sb.auth.signInWithPassword({ email: $("le").value.trim(), password: $("lp").value });
      btn.disabled = false;
      if (r.error) { $("lerr").textContent = "That email and password don't match."; return; }
      session = r.data.session; start();
    };
  }

  async function start() {
    if (!session || session.user.is_anonymous) { showLogin(); return; }
    var a = await sb.rpc("is_admin");
    if (!a.data) { await sb.auth.signOut(); session = null; showLogin("This account doesn't have admin access."); return; }
    who.innerHTML = "<b>" + esc(session.user.email) + '</b><button class="btn ghost sm" id="lo">Log out</button>';
    $("lo").onclick = async function () { await sb.auth.signOut(); session = null; showLogin(); };
    app.innerHTML = '<div class="tabs" id="mainTabs"></div><div id="view"><p class="muted">Loading…</p></div>';
    await loadAll();
    draw();
  }

  async function loadAll() {
    var r = await Promise.all([
      sb.from("job_applications").select("*").order("applied_at", { ascending: false }),
      sb.from("associates").select("*").order("created_at", { ascending: false }),
      sb.from("waiver_signatures").select("id,signed_at,full_name,business_name,phone,email,waiver_version,pdf_path,user_id").order("signed_at", { ascending: false }),
      sb.from("shift_types").select("*").order("code"),
      sb.from("portal_settings").select("*").single(),
      sb.from("app_admins").select("user_id")
    ]);
    var admins = (r[5].data || []).map(function (x) { return x.user_id; });
    data.apps = r[0].data || [];
    data.assoc = (r[1].data || []).filter(function (a) { return admins.indexOf(a.user_id) < 0; });
    data.waivers = r[2].data || [];
    data.types = r[3].data || [];
    data.settings = r[4].data;
  }

  function draw() {
    var pending = data.assoc.filter(function (a) { return a.status === "pending"; }).length;
    var newApps = data.apps.filter(function (a) { return a.status === "new"; }).length;
    var tabs = [["apps", "Job applications", newApps], ["roster", "Associates", pending], ["schedule", "Schedule", 0], ["waivers", "Waivers", 0], ["settings", "Shift settings", 0]];
    $("mainTabs").innerHTML = tabs.map(function (t) {
      return '<button class="tab' + (tab === t[0] ? " on" : "") + '" data-t="' + t[0] + '">' + t[1] + (t[2] ? '<span class="count">' + t[2] + "</span>" : "") + "</button>";
    }).join("");
    $("mainTabs").querySelectorAll("button").forEach(function (b) { b.onclick = function () { tab = b.dataset.t; try { localStorage.setItem("vosAdminTab", tab); } catch (e) {} draw(); }; });
    ({ apps: drawApps, roster: drawRoster, schedule: drawSchedule, waivers: drawWaivers, settings: drawSettings })[tab]();
  }

  // ---------- Job applications ----------
  var appQ = "", appF = "";
  function drawApps() {
    var v = $("view");
    v.innerHTML = '<div class="toolbar"><input type="search" id="aq" placeholder="Search name, phone, email, ZIP…" value="' + esc(appQ) + '">' +
      '<select id="af"><option value="">All statuses</option>' + Object.keys(APP_STATUS).map(function (k) { return '<option value="' + k + '"' + (appF === k ? " selected" : "") + ">" + APP_STATUS[k][0] + "</option>"; }).join("") + "</select>" +
      '<span class="muted small" id="acount"></span></div><div id="alist"></div>';
    $("aq").oninput = function () { appQ = this.value; listApps(); };
    $("af").onchange = function () { appF = this.value; listApps(); };
    listApps();
  }
  function listApps() {
    var q = appQ.trim().toLowerCase();
    var rows = data.apps.filter(function (a) {
      if (appF && a.status !== appF) return false;
      if (!q) return true;
      return [a.full_name, a.phone, a.email, a.zip_code, a.vehicle_type, a.heard_from, a.notes].join(" ").toLowerCase().indexOf(q) >= 0;
    });
    $("acount").textContent = rows.length + " of " + data.apps.length;
    if (!rows.length) { $("alist").innerHTML = '<div class="card muted">' + (data.apps.length ? "No applications match." : "No applications yet.") + "</div>"; return; }
    $("alist").innerHTML = rows.map(function (a) {
      return '<details class="app"><summary><span><b>' + esc(a.full_name) + '</b> <span class="muted small">· ' + esc(a.phone) + " · applied " + fmtDate(a.applied_at) + "</span></span>" + badge(APP_STATUS, a.status) + "</summary>" +
        '<div class="appbody"><div class="toolbar"><label style="margin:0">Status</label><select data-id="' + a.id + '">' +
        Object.keys(APP_STATUS).map(function (k) { return '<option value="' + k + '"' + (a.status === k ? " selected" : "") + ">" + APP_STATUS[k][0] + "</option>"; }).join("") +
        '</select><a class="btn ghost sm" href="tel:' + esc(a.phone) + '">Call</a><a class="btn ghost sm" href="sms:' + esc(a.phone) + '">Text</a><a class="btn ghost sm" href="mailto:' + esc(a.email) + '">Email</a></div>' +
        '<dl class="kv"><dt>Email</dt><dd>' + esc(a.email) + "</dd><dt>Phone</dt><dd>" + esc(a.phone) + "</dd><dt>Home ZIP</dt><dd>" + esc(a.zip_code || "—") + "</dd>" +
        "<dt>Hours per week</dt><dd>" + esc(a.hours_per_week || a.max_hours || "—") + "</dd><dt>Days</dt><dd>" + esc(list(a.days_available)) + "</dd>" +
        "<dt>Times</dt><dd>" + esc(list(a.preferred_times)) + "</dd><dt>Earliest start</dt><dd>" + esc(a.start_date || "—") + "</dd>" +
        "<dt>Vehicle</dt><dd>" + esc(a.vehicle_type || yn(a.has_vehicle)) + "</dd><dt>License + insurance</dt><dd>" + yn(a.has_license_insurance) + "</dd>" +
        "<dt>Can lift 50+ lbs</dt><dd>" + yn(a.can_lift_50) + "</dd><dt>18 or older</dt><dd>" + yn(a.is_18_plus) + "</dd>" +
        "<dt>Heard about us</dt><dd>" + esc(a.heard_from || "—") + "</dd><dt>Anything else</dt><dd>" + esc(a.notes || "—") + "</dd>" +
        "<dt>Applied</dt><dd>" + esc(fmtDateTime(a.applied_at)) + "</dd></dl></div></details>";
    }).join("");
    $("alist").querySelectorAll("select[data-id]").forEach(function (s) {
      s.onchange = async function () {
        var id = s.dataset.id, st = s.value;
        var r = await sb.from("job_applications").update({ status: st, status_changed_at: new Date().toISOString() }).eq("id", id).select().single();
        if (r.error) { alert("Could not save the status."); return; }
        data.apps = data.apps.map(function (a) { return a.id === id ? r.data : a; });
        var open = s.closest("details"); listApps();
        var again = $("alist").querySelector('select[data-id="' + id + '"]'); if (again && open) again.closest("details").open = true;
        refreshTabCounts();
      };
    });
  }
  function refreshTabCounts() {
    var pending = data.assoc.filter(function (a) { return a.status === "pending"; }).length;
    var newApps = data.apps.filter(function (a) { return a.status === "new"; }).length;
    $("mainTabs").querySelectorAll("button").forEach(function (b) {
      var c = b.querySelector(".count"); var n = b.dataset.t === "apps" ? newApps : b.dataset.t === "roster" ? pending : 0;
      if (c) { if (n) c.textContent = n; else c.remove(); } else if (n) { var s = document.createElement("span"); s.className = "count"; s.textContent = n; b.appendChild(s); }
    });
  }

  // ---------- Associates / roster ----------
  var rosterQ = "";
  function waiverFor(uid) { return data.waivers.filter(function (w) { return w.user_id === uid; })[0] || null; }
  function drawRoster() {
    var v = $("view");
    var pend = data.assoc.filter(function (a) { return a.status === "pending"; });
    var h = "";
    if (pend.length) {
      h += '<div class="card warn"><h2>Account requests (' + pend.length + ")</h2><ul class=\"list\">" + pend.map(function (a) {
        return "<li><span><b>" + esc(a.full_name) + '</b><br><span class="small muted">' + esc(a.phone) + " · " + esc(a.email) + " · requested " + fmtDate(a.created_at) + "</span></span>" +
          '<span class="toolbar" style="margin:0;flex-wrap:nowrap"><button class="btn sm" data-approve="' + a.user_id + '">Approve</button><button class="btn danger sm" data-decline="' + a.user_id + '">Decline</button></span></li>';
      }).join("") + "</ul></div>";
    }
    h += '<div class="card"><h2>Roster</h2><div class="toolbar"><input type="search" id="rq" placeholder="Search name, phone, email…" value="' + esc(rosterQ) + '"><span class="muted small" id="rcount"></span></div><div class="tablewrap" id="rtable"></div></div>';
    v.innerHTML = h;
    v.querySelectorAll("[data-approve]").forEach(function (b) { b.onclick = function () { setStatus(b.dataset.approve, "approved"); }; });
    v.querySelectorAll("[data-decline]").forEach(function (b) { b.onclick = function () { if (confirm("Decline this account? They won't be able to see the schedule.")) setStatus(b.dataset.decline, "declined"); }; });
    $("rq").oninput = function () { rosterQ = this.value; rosterTable(); };
    rosterTable();
  }
  function rosterTable() {
    var q = rosterQ.trim().toLowerCase();
    var rows = data.assoc.filter(function (a) { return a.status !== "pending"; }).filter(function (a) { return !q || [a.full_name, a.phone, a.email].join(" ").toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, b) { return a.full_name.localeCompare(b.full_name); });
    $("rcount").textContent = rows.length + " associate" + (rows.length === 1 ? "" : "s");
    if (!rows.length) { $("rtable").innerHTML = '<p class="muted">No associates yet. New accounts appear above for approval.</p>'; return; }
    $("rtable").innerHTML = "<table><thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Waiver signed</th><th>Date signed</th><th>Account</th><th></th></tr></thead><tbody>" +
      rows.map(function (a) {
        var w = waiverFor(a.user_id);
        return "<tr><td><b>" + esc(a.full_name) + '</b></td><td><a href="tel:' + esc(a.phone) + '">' + esc(a.phone) + '</a></td><td><a href="mailto:' + esc(a.email) + '">' + esc(a.email) + "</a></td>" +
          "<td>" + (w ? '<span class="badge green">Yes</span>' : '<span class="badge amber">No</span>') + "</td><td>" + (w ? fmtDate(w.signed_at) : "—") + "</td>" +
          "<td>" + badge(ASSOC_STATUS, a.status) + "</td><td>" +
          (a.status === "approved" ? '<button class="btn danger sm" data-revoke="' + a.user_id + '">Remove access</button>' : '<button class="btn ghost sm" data-reapprove="' + a.user_id + '">Approve</button>') + "</td></tr>";
      }).join("") + "</tbody></table>";
    $("rtable").querySelectorAll("[data-revoke]").forEach(function (b) { b.onclick = function () { if (confirm("Remove this associate's access to the schedule? Their existing sign-ups stay until you remove them.")) setStatus(b.dataset.revoke, "declined"); }; });
    $("rtable").querySelectorAll("[data-reapprove]").forEach(function (b) { b.onclick = function () { setStatus(b.dataset.reapprove, "approved"); }; });
  }
  async function setStatus(uid, st) {
    var r = await sb.from("associates").update({ status: st }).eq("user_id", uid).select().single();
    if (r.error) { alert("Could not update the account."); return; }
    data.assoc = data.assoc.map(function (a) { return a.user_id === uid ? r.data : a; });
    draw();
  }

  // ---------- Schedule ----------
  function slotsOf(t) {
    var l = [];
    for (var n = 1; n <= t.advanced_seats; n++) l.push(n === 1 ? "" : "-" + n);
    for (var m = 1; m <= t.beginner_seats; m++) l.push(m === 1 ? "-t" : "-t" + m);
    return l;
  }
  async function drawSchedule() {
    var v = $("view");
    var startMon = mondayOf(parseDate(data.settings.schedule_start)), thisMon = mondayOf(new Date());
    var mon = new Date(thisMon > startMon ? thisMon : startMon); mon.setDate(mon.getDate() + schedWeek * 7);
    var sun = new Date(mon); sun.setDate(sun.getDate() + 6);
    v.innerHTML = '<div class="toolbar"><button class="btn ghost sm" id="pw">← Previous week</button><b id="wl"></b><button class="btn ghost sm" id="nw">Next week →</button>' +
      '<span class="muted small" id="wtot"></span></div><div class="weekgrid" id="wg"><p class="muted">Loading…</p></div>';
    $("wl").textContent = "Week of " + MON[mon.getMonth()] + " " + mon.getDate() + " – " + MON[sun.getMonth()] + " " + sun.getDate();
    $("pw").onclick = function () { schedWeek--; drawSchedule(); };
    $("nw").onclick = function () { schedWeek++; drawSchedule(); };
    var r = await sb.rpc("schedule_between", { d1: iso(mon), d2: iso(sun) });
    if (tab !== "schedule") return;
    if (r.error) { $("wg").innerHTML = '<p class="error">Could not load the schedule.</p>'; return; }
    var by = {}; (r.data || []).forEach(function (x) { by[x.slot_id] = x; });
    var types = data.types.filter(function (t) { return t.active; });
    var total = 0, people = {};
    var h = "";
    for (var i = 0; i < 7; i++) {
      var d = new Date(mon); d.setDate(d.getDate() + i);
      var di = iso(d), dayN = 0;
      var inner = types.map(function (t) {
        return '<div class="shift"><b>' + esc(t.start_label) + "</b> <span class=\"muted\">– " + esc(t.end_label) + "</span>" +
          slotsOf(t).map(function (suf) {
            var id = di + "-" + t.code + suf, x = by[id], tr = suf.indexOf("-t") === 0;
            if (x) { dayN++; total++; people[x.user_id] = (people[x.user_id] || 0) + 1; }
            return '<div class="person">' + (x ? "<span>" + (tr ? '<span class="tag">B</span>' : "") + esc(x.full_name) + '</span><button title="Remove" data-rm="' + esc(id) + '" data-name="' + esc(x.full_name) + '">×</button>'
              : '<span class="empty">' + (tr ? "Open (beginner)" : "Open") + "</span>") + "</div>";
          }).join("") + "</div>";
      }).join("");
      h += '<div class="daycol"><h3>' + DAYS[i] + " " + MON[d.getMonth()] + " " + d.getDate() + ' <span class="muted small">· ' + dayN + "/" + data.settings.day_cap + "</span></h3>" + inner + "</div>";
    }
    $("wg").innerHTML = h;
    $("wtot").textContent = total + " sign-ups · " + Object.keys(people).length + " people";
    $("wg").querySelectorAll("[data-rm]").forEach(function (b) {
      b.onclick = async function () {
        if (!confirm("Remove " + b.dataset.name + " from this shift?")) return;
        var x = await sb.from("shift_signups").delete().eq("slot_id", b.dataset.rm).select();
        if (x.error || !x.data.length) alert("Could not remove that sign-up.");
        drawSchedule();
      };
    });
  }

  // ---------- Waivers ----------
  var wQ = "";
  function drawWaivers() {
    var v = $("view");
    v.innerHTML = '<div class="card"><h2>Signed agreements and waivers</h2><div class="toolbar"><input type="search" id="wq" placeholder="Search name, phone, email…" value="' + esc(wQ) + '"><span class="muted small" id="wcount"></span></div><div class="tablewrap" id="wt"></div></div>';
    $("wq").oninput = function () { wQ = this.value; wTable(); };
    wTable();
  }
  function wTable() {
    var q = wQ.trim().toLowerCase();
    var rows = data.waivers.filter(function (w) { return !q || [w.full_name, w.phone, w.email, w.business_name].join(" ").toLowerCase().indexOf(q) >= 0; });
    $("wcount").textContent = rows.length + " of " + data.waivers.length;
    if (!rows.length) { $("wt").innerHTML = '<p class="muted">No waivers found.</p>'; return; }
    $("wt").innerHTML = "<table><thead><tr><th>Signed</th><th>Name</th><th>Business</th><th>Phone</th><th>Email</th><th>Version</th><th>Portal account</th><th></th></tr></thead><tbody>" +
      rows.map(function (w) {
        var a = w.user_id ? data.assoc.filter(function (x) { return x.user_id === w.user_id; })[0] : null;
        return "<tr><td>" + esc(fmtDateTime(w.signed_at)) + "</td><td><b>" + esc(w.full_name) + "</b></td><td>" + esc(w.business_name || "—") + "</td><td>" + esc(w.phone) + "</td><td>" + esc(w.email) + "</td>" +
          '<td class="small">' + esc(w.waiver_version.replace("waiver 2026-11-20 / ", "")) + "</td><td>" + (a ? esc(a.full_name) : '<span class="muted">Not linked</span>') + "</td>" +
          '<td><button class="btn ghost sm" data-pdf="' + esc(w.pdf_path) + '" data-n="' + esc(w.full_name) + '">Download PDF</button></td></tr>';
      }).join("") + "</tbody></table>";
    $("wt").querySelectorAll("[data-pdf]").forEach(function (b) {
      b.onclick = async function () {
        var name = "VOS_Logistics_Agreement_and_Waiver_" + b.dataset.n.replace(/[^a-z0-9]+/gi, "_") + ".pdf";
        var r = await sb.storage.from("waivers").createSignedUrl(b.dataset.pdf, 120, { download: name });
        if (r.error) { alert("Could not get that PDF."); return; }
        location.href = r.data.signedUrl;
      };
    });
  }

  // ---------- Shift settings ----------
  function drawSettings() {
    var v = $("view"), s = data.settings;
    v.innerHTML = '<div class="card"><h2>Schedule settings</h2><div class="row" style="max-width:520px">' +
      '<div><label for="ss">New schedule opens on</label><input type="date" id="ss" value="' + esc(s.schedule_start) + '"></div>' +
      '<div><label for="dc">Max sign-ups per day</label><input type="number" id="dc" min="1" max="99" value="' + esc(s.day_cap) + '"></div></div>' +
      '<button class="btn" style="margin-top:16px" id="saveS">Save settings</button><div class="error" id="sErr"></div></div>' +
      '<div class="card"><h2>Daily shifts</h2><p class="small muted">These shifts repeat every day. Changing seats only affects new sign-ups. Turning a shift off hides it from associates.</p>' +
      '<div class="tablewrap"><table><thead><tr><th>Start (24h)</th><th>Starts</th><th>Back by</th><th>Advanced spots</th><th>Beginner spots</th><th>On</th></tr></thead><tbody id="tt"></tbody></table></div>' +
      '<div class="toolbar" style="margin-top:14px"><button class="btn ghost" id="addT">Add a shift</button><button class="btn" id="saveT">Save shifts</button></div><div class="error" id="tErr"></div></div>';
    var types = data.types.map(function (t) { return Object.assign({}, t); });
    function rowsHtml() {
      $("tt").innerHTML = types.map(function (t, i) {
        return '<tr data-i="' + i + '"><td>' + (t._new ? '<input type="text" maxlength="4" placeholder="1730" data-f="code" value="' + esc(t.code) + '" style="width:80px">' : "<b>" + esc(t.code) + "</b>") + "</td>" +
          '<td><input type="text" data-f="start_label" value="' + esc(t.start_label) + '" style="width:110px"></td>' +
          '<td><input type="text" data-f="end_label" value="' + esc(t.end_label) + '" style="width:110px"></td>' +
          '<td><input type="number" min="0" max="9" data-f="advanced_seats" value="' + t.advanced_seats + '" style="width:70px"></td>' +
          '<td><input type="number" min="0" max="9" data-f="beginner_seats" value="' + t.beginner_seats + '" style="width:70px"></td>' +
          '<td><input type="checkbox" data-f="active"' + (t.active ? " checked" : "") + "></td></tr>";
      }).join("");
    }
    rowsHtml();
    $("addT").onclick = function () { types.push({ _new: true, code: "", start_label: "", end_label: "", advanced_seats: 1, beginner_seats: 0, active: true }); rowsHtml(); };
    $("saveS").onclick = async function () {
      var r = await sb.from("portal_settings").update({ schedule_start: $("ss").value, day_cap: +$("dc").value, updated_at: new Date().toISOString() }).eq("id", true).select().single();
      if (r.error) { $("sErr").className = "error"; $("sErr").textContent = "Could not save: " + r.error.message; return; }
      data.settings = r.data; $("sErr").className = "notice"; $("sErr").textContent = "Saved.";
    };
    $("saveT").onclick = async function () {
      var err = $("tErr"); err.className = "error"; err.textContent = "";
      $("tt").querySelectorAll("tr").forEach(function (tr) {
        var t = types[+tr.dataset.i];
        tr.querySelectorAll("[data-f]").forEach(function (inp) {
          var f = inp.dataset.f;
          t[f] = inp.type === "checkbox" ? inp.checked : inp.type === "number" ? +inp.value : inp.value.trim();
        });
      });
      for (var i = 0; i < types.length; i++) {
        var t = types[i];
        if (!/^[0-2][0-9][0-5][0-9]$/.test(t.code) || +t.code.slice(0, 2) > 23) { err.textContent = "Start (24h) must look like 0915 or 1730."; return; }
        if (!t.start_label || !t.end_label) { err.textContent = "Please fill in the start and back-by times."; return; }
      }
      var payload = types.map(function (t) { return { code: t.code, start_label: t.start_label, end_label: t.end_label, advanced_seats: t.advanced_seats, beginner_seats: t.beginner_seats, active: t.active }; });
      var r = await sb.from("shift_types").upsert(payload).select();
      if (r.error) { err.textContent = "Could not save: " + r.error.message; return; }
      data.types = r.data.sort(function (a, b) { return a.code.localeCompare(b.code); });
      err.className = "notice"; err.textContent = "Saved."; types = data.types.map(function (t) { return Object.assign({}, t); }); rowsHtml();
    };
  }

  // ---------- Start ----------
  sb.auth.getSession().then(function (r) { session = r.data.session; start(); });
})();
