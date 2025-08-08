// contentScript.js
console.log("Content script loaded on redirect page");
const params = new URLSearchParams(window.location.search);
const code = params.get("code");
const state = params.get("state");

if (code && state) {
  console.log("Sending oauthCallback message:", { code, state });
  browser.runtime.sendMessage({
    action: "oauthCallback",
    code: code,
    state: state
  }).then(() => {
    console.log("Message sent successfully");
  }).catch(error => {
    console.error("Error sending oauthCallback message:", error.message);
  });
} else {
  console.error("No code or state found in redirect URL:", window.location.href);
}