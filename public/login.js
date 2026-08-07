// Sign-in page. Separate file because the CSP drops script 'unsafe-inline'.
(function () {
  var err = document.getElementById("err");
  var form = document.getElementById("pinForm");
  var button = document.getElementById("go");
  var emailInput = document.getElementById("email");
  var pinInput = document.getElementById("pin");

  var initial = new URLSearchParams(location.search).get("error");
  if (initial === "denied") err.textContent = "This account does not have access to OMP CRM. Contact the admin to be added.";
  else if (initial === "expired") err.textContent = "Your session has ended. Sign in again.";

  emailInput.focus();

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var email = emailInput.value.trim();
    var value = pinInput.value.trim();
    if (!email || !value) { err.textContent = "Enter your work email and PIN."; return; }
    button.disabled = true;
    err.textContent = "";
    fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, pin: value }),
    })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        if (res.status === 200 && res.body.ok) { location.href = "/"; return; }
        button.disabled = false;
        pinInput.value = "";
        err.textContent = res.body.error || "Could not sign you in.";
        pinInput.focus();
      })
      .catch(function () {
        button.disabled = false;
        err.textContent = "Network error. Try again.";
      });
  });
})();
