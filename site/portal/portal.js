/* VOS associate portal */
(function () {
  "use strict";
  var sb = vosClient();
  var $ = function (id) { return document.getElementById(id); };
  var app = $("app"), who = $("who");

  var session = null, me = null, waiver = null, settings = null, SLOTS = [], rows = {};
  var week = 0, day = (new Date().getDay() + 6) % 7, recovering = false, live = null, timer = null;

  var DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var HOWTO = "Start: take your charged batteries (40 on advanced spots, 25 on orange beginner spots). End: pull any finished batteries out of the chargers, then load your dead ones into open ports. Put extras on the rack and load the longest-waiting first.";

  function setWho() {
    if (!session) { who.innerHTML = ""; return; }
    who.innerHTML = "<b>" + esc(me ? me.full_name : session.user.email) + "</b>" +
      '<button class="btn ghost sm" id="logout">Log out</button>';
    $("logout").onclick = async function () { await sb.auth.signOut(); session = null; me = null; stopLive(); route(); };
  }

  // ---------- Auth views ----------
  function showAuth(mode, msg) {
    stopLive(); setWho();
    var t = { login: "Log in", signup: "Create your account", forgot: "Reset your password" }[mode];
    var h = '<div class="card"><div class="eyebrow">VOS Logistics associates</div><h1>' + t + "</h1>";
    if (mode === "login") h += '<p class="muted">Log in to see the shift schedule and sign up for shifts.</p>';
    if (mode === "signup") h += '<p class="muted">After you create your account, VOS will approve it. Then you\'ll sign your contractor agreement and can start picking shifts.</p>';
    if (mode === "forgot") h += '<p class="muted">We\'ll email you a link to set a new password.</p>';
    h += '<form id="authForm" novalidate>';
    if (mode === "signup") {
      h += '<label for="fName">Full name</label><input type="text" id="fName" autocomplete="name" maxlength="80">' +
           '<label for="fPhone">Phone</label><input type="tel" id="fPhone" autocomplete="tel" maxlength="30">';
    }
    h += '<label for="fEmail">Email</label><input type="email" id="fEmail" autocomplete="email">';
    if (mode !== "forgot") h += '<label for="fPass">Password' + (mode === "signup" ? " (at least 8 characters)" : "") + '</label><input type="password" id="fPass" autocomplete="' + (mode === "signup" ? "new-password" : "current-password") + '">';
    h += '<button class="btn block" style="margin-top:20px" id="authBtn">' + { login: "Log in", signup: "Create account", forgot: "Send reset link" }[mode] + "</button>";
    h += '<div class="error" id="authErr"></div><div class="notice" id="authOk">' + esc(msg || "") + "</div></form>";
    h += '<p class="small" style="margin-top:18px">';
    if (mode === "login") h += 'New to VOS? <button class="link" data-go="signup">Create an account</button> · <button class="link" data-go="forgot">Forgot password?</button>';
    else h += 'Already have an account? <button class="link" data-go="login">Log in</button>';
    h += "</p></div>";
    h += '<p class="small muted">Not working with us yet? <a href="' + esc(VOS.JOB_URL) + '">See the open role and apply</a>.</p>';
    app.innerHTML = h;
    app.querySelectorAll("[data-go]").forEach(function (b) { b.onclick = function () { showAuth(b.dataset.go); }; });
    $("authForm").onsubmit = async function (e) {
      e.preventDefault();
      var err = $("authErr"), ok = $("authOk"), btn = $("authBtn");
      err.textContent = ""; ok.textContent = "";
      var email = $("fEmail").value.trim(), pass = $("fPass") ? $("fPass").value : "";
      if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = "Please enter a valid email."; return; }
      btn.disabled = true;
      try {
        if (mode === "login") {
          if (!pass) { err.textContent = "Please enter your password."; return; }
          var r = await sb.auth.signInWithPassword({ email: email, password: pass });
          if (r.error) {
            err.textContent = /confirm/i.test(r.error.message) ? "Please confirm your email first. Check your inbox for the link we sent." : "That email and password don't match.";
            return;
          }
          session = r.data.session; route();
        } else if (mode === "signup") {
          var name = $("fName").value.trim(), phone = $("fPhone").value.trim();
          if (!name) { err.textContent = "Please enter your full name."; return; }
          if (!phone) { err.textContent = "Please enter your phone number."; return; }
          if (pass.length < 8) { err.textContent = "Password must be at least 8 characters."; return; }
          var s = await sb.auth.signUp({ email: email, password: pass, options: { data: { full_name: name, phone: phone }, emailRedirectTo: location.origin + "/portal/" } });
          if (s.error) {
            err.textContent = /already|registered|exists/i.test(s.error.message) ? "An account with that email already exists. Try logging in." : "Could not create the account: " + s.error.message;
            return;
          }
          if (s.data.session) { session = s.data.session; route(); }
          else showAuth("login", "Account created. Check your email (and spam folder) and click the link to confirm it, then log in.");
        } else {
          var f = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + "/portal/" });
          if (f.error) { err.textContent = "Could not send the email. Please try again in a few minutes."; return; }
          ok.textContent = "If that email has an account, a reset link is on its way.";
        }
      } catch (x) { console.error(x); err.textContent = "Something went wrong. Check your connection and try again."; }
      finally { btn.disabled = false; }
    };
  }

  function showSetPassword() {
    app.innerHTML = '<div class="card"><h1>Set a new password</h1><form id="pwForm" novalidate>' +
      '<label for="np">New password (at least 8 characters)</label><input type="password" id="np" autocomplete="new-password">' +
      '<button class="btn block" style="margin-top:20px">Save password</button><div class="error" id="pwErr"></div></form></div>';
    $("pwForm").onsubmit = async function (e) {
      e.preventDefault();
      var p = $("np").value;
      if (p.length < 8) { $("pwErr").textContent = "Password must be at least 8 characters."; return; }
      var r = await sb.auth.updateUser({ password: p });
      if (r.error) { $("pwErr").textContent = "Could not save: " + r.error.message; return; }
      recovering = false; history.replaceState(null, "", "/portal/"); route();
    };
  }

  // ---------- Routing ----------
  async function route() {
    if (recovering) { showSetPassword(); return; }
    if (!session) { showAuth("login"); return; }
    if (session.user.is_anonymous) { await sb.auth.signOut(); session = null; showAuth("login"); return; }
    app.innerHTML = '<p class="muted">Loading…</p>';
    var r = await sb.from("associates").select("*").eq("user_id", session.user.id).maybeSingle();
    me = r.data || null; setWho();
    if (!me) {
      var adm = await sb.rpc("is_admin");
      app.innerHTML = adm.data
        ? '<div class="card"><h1>This is the admin account</h1><p>Go to the <a href="/admin/">admin dashboard</a>.</p></div>'
        : '<div class="card"><h1>Profile not found</h1><p>Please contact your VOS lead.</p></div>';
      return;
    }
    if (me.status === "declined") {
      app.innerHTML = '<div class="card warn"><h1>Account not approved</h1><p>Your account wasn\'t approved for the schedule. If you think this is a mistake, contact your VOS lead.</p></div>';
      return;
    }
    if (me.status === "pending") { showPending(); return; }
    var w = await sb.from("waiver_signatures").select("id,signed_at,pdf_path,waiver_version,pay_plan").eq("user_id", me.user_id).order("signed_at", { ascending: false }).limit(1);
    waiver = (w.data && w.data[0]) || null;
    if (!waiver) { showNeedWaiver(false); return; }
    if (waiver.pay_plan !== me.pay_plan) { showNeedWaiver(true); return; }
    showDashboard();
  }

  function profileCard() {
    return '<div class="card"><h2>My details</h2><form id="profForm" novalidate>' +
      '<label for="pName">Full name</label><input type="text" id="pName" maxlength="80" value="' + esc(me.full_name) + '">' +
      '<div class="row"><div><label for="pPhone">Phone</label><input type="tel" id="pPhone" maxlength="30" value="' + esc(me.phone) + '"></div>' +
      '<div><label for="pEmail">Contact email</label><input type="email" id="pEmail" maxlength="200" value="' + esc(me.email) + '"></div></div>' +
      '<button class="btn ghost" style="margin-top:16px" id="profBtn">Save my details</button><div class="error" id="profErr"></div></form>' +
      '<p class="small muted" style="margin-top:8px">Your login email stays ' + esc(session.user.email) + ".</p></div>";
  }
  function bindProfile() {
    $("profForm").onsubmit = async function (e) {
      e.preventDefault();
      var err = $("profErr"); err.className = "error"; err.textContent = "";
      var d = { full_name: $("pName").value.trim(), phone: $("pPhone").value.trim(), email: $("pEmail").value.trim() };
      if (!d.full_name) { err.textContent = "Please enter your name."; return; }
      if (d.email && !/^\S+@\S+\.\S+$/.test(d.email)) { err.textContent = "Please enter a valid email."; return; }
      var r = await sb.from("associates").update(d).eq("user_id", me.user_id).select().single();
      if (r.error) { err.textContent = "Could not save. Please try again."; return; }
      me = r.data; setWho(); err.className = "notice"; err.textContent = "Saved.";
      if (Object.keys(rows).length) render();
    };
  }

  function showPending() {
    app.innerHTML = '<div class="card warn"><div class="eyebrow">Step 1 of 2</div><h1>Waiting for approval</h1>' +
      "<p>Thanks, " + esc(me.full_name.split(" ")[0]) + ". Your account is waiting for VOS to approve it. Once it's approved, you'll sign your contractor agreement and can start picking shifts.</p>" +
      '<button class="btn ghost sm" id="recheck">Check again</button></div>' + profileCard();
    $("recheck").onclick = route; bindProfile();
  }

  function showNeedWaiver(updated) {
    app.innerHTML = updated
      ? '<div class="card warn"><div class="eyebrow">Action needed</div><h1>Please sign your updated agreement</h1>' +
        "<p>Your pay terms with VOS have been updated. Please read and sign your updated Independent Contractor Agreement to keep picking shifts. Your existing shifts stay booked.</p>" +
        '<a class="btn" href="/sign/">Read and sign</a></div>' + profileCard()
      : '<div class="card ok"><div class="eyebrow">Step 2 of 2</div><h1>You\'re approved</h1>' +
      "<p>Before you can sign up for shifts, please read and sign the Independent Contractor Agreement and Liability Waiver. It takes about 5 minutes.</p>" +
      '<a class="btn" href="/sign/">Read and sign</a></div>' + profileCard();
    bindProfile();
  }

  // ---------- Dashboard ----------
  function mondayOf(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
  function parseDate(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  var base = null; // Monday of the first week shown
  function dateOf(w, i) { var d = new Date(base); d.setDate(d.getDate() + w * 7 + i); return d; }
  function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function key(w, d, s) { return iso(dateOf(w, d)) + "-" + s.k; }
  function isPast(w, d, s) { var t = dateOf(w, d); t.setHours(+s.k.slice(0, 2), +s.k.slice(2), 0, 0); return t < new Date(); }
  function notOpen(w, d) { return iso(dateOf(w, d)) < settings.schedule_start; }
  function dayCount(prefix) { return Object.keys(rows).filter(function (k) { return k.slice(0, 10) === prefix; }).length; }
  function swapsOf(k) { return /-t\d?$/.test(k) ? VOS.SWAPS_BEGINNER : VOS.SWAPS_ADVANCED; }
  function seatList(s) {
    var l = [];
    for (var n = 1; n <= s.seats; n++) l.push({ suf: n === 1 ? "" : "-" + n, tr: false });
    for (var m = 1; m <= s.trainee; m++) l.push({ suf: m === 1 ? "-t" : "-t" + m, tr: true });
    return l;
  }
  function slotLabel(k) {
    var d = parseDate(k.slice(0, 10)), s = SLOTS.filter(function (x) { return x.k === k.slice(11, 15); })[0];
    return DAYS[(d.getDay() + 6) % 7] + " " + MON[d.getMonth()] + " " + d.getDate() + ", " + (s ? s.t + " – " + s.e : k.slice(11, 15)) + (/-t\d?$/.test(k) ? " (beginner)" : "");
  }
  function showMsg(t) { var m = $("msg"); if (m) { m.textContent = t; m.hidden = !t; } }

  async function loadSchedule() {
    var a = settings.schedule_start, z = iso(dateOf(2, 6));
    var r = await sb.rpc("schedule_between", { d1: a < iso(base) ? a : iso(base), d2: z });
    if (r.error) { showMsg("Could not load shifts. Pull down to refresh."); return; }
    var o = {}; (r.data || []).forEach(function (x) { o[x.slot_id] = { name: x.full_name, uid: x.user_id }; });
    rows = o; render();
  }
  function stopLive() { if (live) { sb.removeChannel(live); live = null; } if (timer) { clearInterval(timer); timer = null; } }

  async function showDashboard() {
    var st = await sb.from("portal_settings").select("*").single();
    var ty = await sb.from("shift_types").select("*").eq("active", true).order("code");
    if (st.error || ty.error) { app.innerHTML = '<div class="card warn">Could not load the schedule. Please refresh.</div>'; return; }
    settings = st.data;
    SLOTS = ty.data.map(function (t) { return { k: t.code, t: t.start_label, e: t.end_label, seats: t.advanced_seats, trainee: t.beginner_seats }; });
    var thisMon = mondayOf(new Date()), startMon = mondayOf(parseDate(settings.schedule_start));
    base = startMon > thisMon ? startMon : thisMon;
    if (startMon > thisMon) day = 0;

    app.innerHTML =
      '<div class="eyebrow">Welcome back</div><h1>' + esc(me.full_name) + "</h1>" +
      '<p class="muted" id="headline"></p>' +
      '<div id="msg" class="error" hidden></div>' +
      '<div class="card"><h2>Shift schedule</h2>' +
      '<p class="small muted">Each shift is 4 hours. Advanced spots are 40 swaps. <span class="tag">BEGINNER · 25</span> spots (orange) are 25 swaps. Bring your batteries back by the time shown.</p>' +
      '<div class="tabs" id="weeks"></div><div class="tabs" id="tabs"></div><div id="slots"></div>' +
      '<p class="small muted">The 20-hour weekly minimum is 5 shifts. Shifts avoid rush hours. If you can\'t make a shift, drop it at least 24 hours ahead.</p></div>' +
      '<div class="card"><h2>My upcoming shifts</h2><div id="mine"></div><div id="sum"></div></div>' +
      '<div class="card"><h2>Refer a friend</h2><p>Know someone dependable with a truck, van or SUV? We\'re hiring Field Operations Associates in Austin: $30–$50/hr, paid weekly, 20+ hrs/week. Send them the job link so they can apply.</p>' +
      '<div class="toolbar" style="margin:0"><button class="btn" id="shareBtn">Share job link</button><button class="btn ghost" id="copyBtn">Copy link</button><a class="btn ghost" href="' + esc(VOS.JOB_URL) + '" target="_blank" rel="noopener">View job posting</a></div>' +
      '<div class="notice" id="shareOk"></div></div>' +
      '<div class="card"><h2>My signed agreement</h2><p class="small muted">Signed ' + esc(new Date(waiver.signed_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })) + ".</p>" +
      '<button class="btn ghost" id="dlWaiver">Download my signed copy (PDF)</button><div class="error" id="dlErr"></div></div>' +
      profileCard();
    bindProfile();

    $("shareBtn").onclick = async function () {
      var data = { title: "Lime Field Operations Associate – VOS Logistics", text: "VOS Logistics is hiring in Austin: $30–$50/hr, paid weekly. Apply here:", url: VOS.JOB_URL };
      if (navigator.share) { try { await navigator.share(data); } catch (e) { /* cancelled */ } }
      else copyLink();
    };
    $("copyBtn").onclick = copyLink;
    function copyLink() {
      var done = function () { $("shareOk").textContent = "Link copied. Paste it in a text or message."; };
      if (navigator.clipboard) navigator.clipboard.writeText(VOS.JOB_URL).then(done, function () { prompt("Copy this link:", VOS.JOB_URL); });
      else prompt("Copy this link:", VOS.JOB_URL);
    }
    $("dlWaiver").onclick = async function () {
      $("dlErr").textContent = "";
      var r = await sb.storage.from("waivers").createSignedUrl(waiver.pdf_path, 120, { download: "VOS_Logistics_Agreement_and_Waiver.pdf" });
      if (r.error) { $("dlErr").textContent = "Could not get your PDF. Please try again."; return; }
      location.href = r.data.signedUrl;
    };

    render();
    await loadSchedule();
    stopLive();
    live = sb.channel("shift-signups-live").on("postgres_changes", { event: "*", schema: "public", table: "shift_signups" }, function () { loadSchedule(); }).subscribe();
    timer = setInterval(loadSchedule, 60000);
  }

  function render() {
    if (!$("slots")) return;
    var wl = [0, 1, 2].map(function (i) { var a = dateOf(i, 0), z = dateOf(i, 6), now = mondayOf(new Date()).getTime();
      var label = a.getTime() === now ? "This week" : (a.getTime() - now === 7 * 864e5 ? "Next week" : "Week of " + MON[a.getMonth()] + " " + a.getDate());
      return label + " (" + MON[a.getMonth()] + " " + a.getDate() + "–" + (z.getMonth() !== a.getMonth() ? MON[z.getMonth()] + " " : "") + z.getDate() + ")"; });
    $("weeks").innerHTML = wl.map(function (l, i) { return '<button class="tab' + (i === week ? " on" : "") + '" data-w="' + i + '">' + l + "</button>"; }).join("");
    $("weeks").querySelectorAll("button").forEach(function (b) { b.onclick = function () { week = +b.dataset.w; render(); }; });
    $("tabs").innerHTML = DAYS.map(function (d, i) { return '<button class="tab' + (i === day ? " on" : "") + '" data-d="' + i + '">' + d + " " + dateOf(week, i).getDate() + "</button>"; }).join("");
    $("tabs").querySelectorAll("button").forEach(function (b) { b.onclick = function () { day = +b.dataset.d; render(); }; });

    var wrap = $("slots"); wrap.innerHTML = "";
    var dd = dateOf(week, day), full = dayCount(iso(dd)) >= settings.day_cap, closedDay = notOpen(week, day);
    if (closedDay) {
      var sd = parseDate(settings.schedule_start);
      wrap.innerHTML = '<div class="slot muted">The new schedule opens ' + DAYS[(sd.getDay() + 6) % 7] + ", " + MON[sd.getMonth()] + " " + sd.getDate() + ".</div>";
    }
    if (!closedDay) SLOTS.forEach(function (s) {
      var closed = isPast(week, day, s);
      var card = document.createElement("div"); card.className = "slot";
      card.innerHTML = '<div class="time">' + DAYS[day] + " " + MON[dd.getMonth()] + " " + dd.getDate() + ", " + esc(s.t) + '</div><div class="back">Back by ' + esc(s.e) + '</div><div class="how">' + esc(HOWTO) + "</div>";
      seatList(s).forEach(function (it) {
        var id = key(week, day, s) + it.suf, r = rows[id], mine = r && r.uid === me.user_id;
        var seat = document.createElement("div"); seat.className = "seat" + (it.tr ? " trainee" : "") + (r ? "" : " open") + (mine ? " mine" : "");
        var label = document.createElement("span");
        if (it.tr) { var g = document.createElement("span"); g.className = "tag"; g.textContent = "BEGINNER · 25"; label.appendChild(g); }
        if (r) {
          label.appendChild(document.createTextNode(r.name + (mine ? " (you)" : ""))); seat.appendChild(label);
          if (mine && !closed) { var d = document.createElement("button"); d.className = "btn danger sm"; d.textContent = "Drop"; d.onclick = function () { drop(id); }; seat.appendChild(d); }
        } else {
          label.appendChild(document.createTextNode(closed ? "Closed" : (full ? "Day full" : "Open")));
          if (!it.tr) label.style.color = "var(--muted)"; seat.appendChild(label);
          if (!closed && !full) { var b = document.createElement("button"); b.className = "btn sm" + (it.tr ? " tr" : ""); b.textContent = it.tr ? "Take beginner spot" : "Take advanced spot"; b.onclick = function () { take(id, b); }; seat.appendChild(b); }
        }
        card.appendChild(seat);
      });
      wrap.appendChild(card);
    });

    // My upcoming shifts
    var nowIso = new Date();
    var mineList = Object.keys(rows).filter(function (k) {
      if (rows[k].uid !== me.user_id) return false;
      var t = parseDate(k.slice(0, 10)); t.setHours(+k.slice(11, 13), +k.slice(13, 15)); return t > nowIso;
    }).sort();
    $("mine").innerHTML = mineList.length
      ? '<ul class="list">' + mineList.map(function (k) { return "<li><span>" + esc(slotLabel(k)) + '</span><button class="btn danger sm" data-drop="' + esc(k) + '">Drop</button></li>'; }).join("") + "</ul>"
      : '<p class="muted">No upcoming shifts yet. Pick some from the schedule above.</p>';
    $("mine").querySelectorAll("[data-drop]").forEach(function (b) { b.onclick = function () { drop(b.dataset.drop); }; });

    var wa = iso(dateOf(week, 0)), wb = iso(dateOf(week, 6)), mineN = 0;
    Object.keys(rows).forEach(function (k) { var kd = k.slice(0, 10); if (kd >= wa && kd <= wb && rows[k].uid === me.user_id) mineN++; });
    $("headline").textContent = mineN + " shift" + (mineN === 1 ? "" : "s") + " booked for the selected week (" + mineN * 4 + " hrs).";
    $("sum").innerHTML = gameHtml(wa, wb);
  }

  var LEVELS = ["Rookie", "Runner", "Charger", "Voltage", "Grid Legend"], XP_STEP = 400, QUEST = 5;
  function gameHtml(wa, wb) {
    var xp = 0, wn = 0, B = { night: 0, early: 0, adv: 0, bnr: 0 }, board = {};
    Object.keys(rows).forEach(function (k) {
      var r = rows[k], d = k.slice(0, 10), sw = swapsOf(k), t = k.slice(11, 15), inW = d >= wa && d <= wb;
      if (inW) { var o = board[r.uid] || (board[r.uid] = { uid: r.uid, n: 0, sw: 0 }); o.n++; o.sw += sw; }
      if (r.uid === me.user_id) {
        xp += sw; if (inW) wn++;
        if (t === "0000") B.night = 1; if (t === "0400") B.early = 1;
        if (/-t\d?$/.test(k)) B.bnr = 1; else B.adv = 1;
      }
    });
    var lv = Math.min(LEVELS.length - 1, Math.floor(xp / XP_STEP)), top = lv === LEVELS.length - 1, into = top ? XP_STEP : xp - lv * XP_STEP;
    var lb = Object.keys(board).map(function (k) { return board[k]; }).sort(function (a, b) { return b.sw - a.sw || b.n - a.n; });
    var leader = lb.length && lb[0].uid === me.user_id;
    var cells = ""; for (var i = 0; i < QUEST; i++) cells += '<div class="cell' + (i < wn ? " on" : "") + '">🔋</div>';
    function chip(on, t) { return '<span class="chip' + (on ? "" : " off") + '">' + t + "</span>"; }
    return '<div class="game"><div class="gcard"><div class="gh"><span class="lvl">Level ' + (lv + 1) + " · " + LEVELS[lv] + "</span><span>" + xp + " XP</span></div>" +
      '<div class="bar"><i style="width:' + Math.round(into / XP_STEP * 100) + '%"></i></div>' +
      '<div class="fine">' + (top ? "Max level reached." : (XP_STEP - into) + " XP to " + LEVELS[lv + 1]) + "</div>" +
      '<div class="chips">' + chip(B.adv, "⚡ Advanced") + chip(B.bnr, "🌱 Beginner") + chip(B.night, "🌙 Night Owl") + chip(B.early, "🌅 Early Bird") + chip(wn >= QUEST, "🔥 Full Week") + chip(leader, "🏆 #1 Of The Week") + "</div></div>" +
      '<div class="gcard"><div class="gh"><b>Weekly quest: book ' + QUEST + " shifts</b><span>" + Math.min(wn, QUEST) + " / " + QUEST + '</span></div><div class="cells">' + cells + "</div>" +
      '<div class="fine">' + (wn >= QUEST ? "Quest complete. You hit the 20-hour minimum." : wn + " shifts booked (" + wn * 4 + " hrs). " + (QUEST - wn) + " more to hit 20 hours.") + "</div></div></div>";
  }
  function pop(sw) {
    var p = document.createElement("div"); p.className = "pop"; p.textContent = "+" + sw + " XP"; document.body.appendChild(p); setTimeout(function () { p.remove(); }, 1400);
    var em = ["🔋", "⚡", "🌟", "🟢"];
    for (var i = 0; i < 18; i++) { var b = document.createElement("div"); b.className = "bit"; b.textContent = em[i % 4];
      b.style.left = "50%"; b.style.top = "42%"; b.style.setProperty("--dx", (Math.random() * 320 - 160) + "px"); b.style.setProperty("--dy", (Math.random() * -240 - 20) + "px");
      document.body.appendChild(b); (function (x) { setTimeout(function () { x.remove(); }, 1200); })(b); }
  }
  async function take(id, btn) {
    showMsg(""); if (btn) btn.disabled = true;
    try {
      var r = await sb.from("shift_signups").insert({ slot_id: id });
      if (!r.error) { pop(swapsOf(id)); }
      else if (r.error.code === "23505") showMsg("Someone just took that one.");
      else if (/day_full/.test(r.error.message)) showMsg("That day is full.");
      else if (/past/.test(r.error.message)) showMsg("That shift has already started.");
      else if (/not_open/.test(r.error.message)) showMsg("That day isn't open for sign-ups yet.");
      else if (/bad_slot/.test(r.error.message)) showMsg("That spot isn't available anymore. Refresh the page.");
      else if (r.error.code === "42501") showMsg("Your account can't book shifts right now. Contact your VOS lead.");
      else throw r.error;
    } catch (e) { console.error(e); showMsg("Could not save. Check your connection and try again."); }
    await loadSchedule();
  }
  async function drop(id) {
    if (!confirm("Drop your shift on " + slotLabel(id) + "?")) return;
    showMsg("");
    var r = await sb.from("shift_signups").delete().eq("slot_id", id).select();
    if (r.error || !r.data || !r.data.length) showMsg("Could not remove that shift.");
    await loadSchedule();
  }

  // ---------- Start ----------
  if (/type=recovery/.test(location.hash)) recovering = true;
  sb.auth.onAuthStateChange(function (ev, s) {
    if (ev === "PASSWORD_RECOVERY") { recovering = true; session = s; setTimeout(showSetPassword, 0); }
    else if (ev === "SIGNED_OUT") { session = null; }
    else if (s) { session = s; }
  });
  sb.auth.getSession().then(function (r) {
    session = r.data.session;
    if (recovering && session) { showSetPassword(); return; }
    if (recovering && !session) { setTimeout(function () { if (!session) { recovering = false; route(); } }, 1500); return; }
    route();
  });
})();
