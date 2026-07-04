const form = document.querySelector("#login-form");
const password = document.querySelector("#password");
const errorMessage = document.querySelector("#login-error");
const submitButton = form.querySelector("button");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  errorMessage.hidden = true;

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: password.value }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "First Look could not be unlocked.");
    }
    window.location.replace("/");
  } catch (error) {
    errorMessage.textContent =
      error instanceof Error
        ? error.message
        : "First Look could not be unlocked.";
    errorMessage.hidden = false;
    password.select();
  } finally {
    submitButton.disabled = false;
  }
});
