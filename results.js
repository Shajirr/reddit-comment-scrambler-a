// results.js
let commentCount = 0;

browser.runtime.getBackgroundPage().then(() => {
  browser.tabs.getCurrent().then(tab => {
    browser.runtime.sendMessage({
      action: "resultsTabReady",
      tabId: tab.id
    }).catch(err => console.error("Failed to send ready message:", err.message));
  });
});

browser.runtime.onMessage.addListener((message) => {
  console.log("Results tab received message:", message);
  const consoleDiv = document.getElementById("console");
  const statusDiv = document.getElementById("status");
  const commentsDiv = document.getElementById("comments");

  if (message.action === "updateStatus") {
    const p = document.createElement("p");
    p.textContent = message.message;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  } else if (message.action === "addComments") {
    commentCount += message.comments.length;
    statusDiv.textContent = `Showing ${commentCount} comments (Total fetched: ${message.totalFetched})`;
    const newComments = message.comments.map(
      comment => `
        <div class="comment">
          <strong>Comment #${comment.index}</strong><br>
          <strong>Subreddit:</strong> ${comment.subreddit}<br>
          <strong>Posted:</strong> ${comment.created}<br>
          <p>${comment.body}</p>
        </div>`
    ).join("");
    commentsDiv.innerHTML += newComments;
  } else if (message.action === "displayError") {
    statusDiv.textContent = "";
    commentsDiv.innerHTML = `<p class="error">Error: ${message.error}</p>`;
    const p = document.createElement("p");
    p.textContent = `${new Date().toLocaleTimeString()}: Error: ${message.error}`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  }
});