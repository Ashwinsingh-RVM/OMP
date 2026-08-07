// PIN entry. Kept as a separate file rather than inline because the CSP drops
// script 'unsafe-inline' (see securityHeaders() in server.js).
(function () {
  var form = document.getElementById("form");
  var input = document.getElementById("pin");
  var button = document.getElementById("go");
  var err = document.getElementById("err");
  var who = document.getElementById("who");

  fetch("/api/me")
    .then(function (r) { return r.json(); })
    .then(function (me) {
      if (!me.authenticated) { location.href = "/login.html"; return; }
      // PIN already cleared on this session — nothing to do here.
      if (!me.pinRequired) { location.href = "/"; return; }
      who.textContent = (me.user && me.user.email) || "";
    })
    .catch(function () { who.textContent = ""; });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var value = input.value.trim();
    if (!value) return;
    button.disabled = true;
    err.textContent = "";
    fetch("/auth/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: value }),
    })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        if (res.status === 200 && res.body.ok) { location.href = "/"; return; }
        input.value = "";
        button.disabled = false;
        var msg = res.body.error || "Could not verify PIN";
        if (typeof res.body.attemptsLeft === "number") {
          msg += res.body.attemptsLeft > 0
            ? " — " + res.body.attemptsLeft + " attempt(s) left."
            : " — account locked for 15 minutes.";
        }
        err.textContent = msg;
        input.focus();
      })
      .catch(function () {
        button.disabled = false;
        err.textContent = "Network error. Try again.";
      });
  });
})();
