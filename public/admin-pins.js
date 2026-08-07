// Admin PIN administration. External file because the CSP drops script
// 'unsafe-inline'. Every action here is re-checked server-side in
// /api/admin/pins — this page is a convenience, not the access control.
(function () {
  var rows = document.getElementById("rows");
  var msg = document.getElementById("msg");

  function say(text, good) {
    msg.textContent = text;
    msg.className = "msg " + (good ? "ok" : "bad");
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function load() {
    fetch("/api/admin/pins")
      .then(function (r) {
        if (r.status === 403) { location.href = "/"; return null; }
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        if (!data.roster) { say(data.error || "Could not load the roster", false); return; }
        rows.innerHTML = data.roster.map(function (p) {
          return (
            // data-label feeds the stacked card layout on phones, where the
            // table header is hidden and each cell prints its own label.
            "<tr data-email=\"" + esc(p.email) + "\">" +
            "<td data-label=\"Account\">" + esc(p.email) + (p.internal ? "<br><span style=\"color:#9aa4b2;font-size:12px\">" + esc(p.internal) + "</span>" : "") + "</td>" +
            "<td data-label=\"Role\"><span class=\"tag " + (p.role === "admin" ? "admin" : "") + "\">" + esc(p.role) + "</span></td>" +
            "<td data-label=\"PIN status\"><span class=\"tag " + (p.hasPin ? "set" : "unset") + "\">" + (p.hasPin ? "PIN set" : "No PIN") + "</span></td>" +
            "<td>" +
            "<input type=\"text\" inputmode=\"numeric\" maxlength=\"12\" placeholder=\"6-12 digits\" />" +
            " <button data-act=\"set\">Save</button>" +
            (p.hasPin ? " <button class=\"ghost\" data-act=\"clear\">Clear</button>" : "") +
            "</td></tr>"
          );
        }).join("");
      })
      .catch(function () { say("Could not load the roster", false); });
  }

  rows.addEventListener("click", function (event) {
    var button = event.target.closest("button");
    if (!button) return;
    var tr = button.closest("tr");
    var email = tr.getAttribute("data-email");
    var input = tr.querySelector("input");
    var body = { email: email };

    if (button.dataset.act === "clear") {
      if (!confirm("Clear the PIN for " + email + "? They will not be able to sign in until you set a new one.")) return;
      body.clear = true;
    } else {
      var value = input.value.trim();
      if (!/^[0-9]{6,12}$/.test(value)) { say("PIN must be 6-12 digits", false); input.focus(); return; }
      body.pin = value;
    }

    button.disabled = true;
    fetch("/api/admin/pins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        button.disabled = false;
        if (res.status === 200 && res.body.ok) {
          input.value = "";
          say(body.clear ? "PIN cleared for " + email : "PIN set for " + email + " — pass it to them directly.", true);
          load();
        } else {
          say(res.body.error || "Could not update the PIN", false);
        }
      })
      .catch(function () { button.disabled = false; say("Network error. Try again.", false); });
  });

  load();
})();
