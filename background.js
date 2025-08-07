// background.js
const CLIENT_ID = "DOspouQ0Wv_lnJt4ogAkWA";
const REDIRECT_URI = "https://shajirr.github.io/reddit-comment-scrambler-a/redirect.html";
const SCOPES = "identity read history";

console.log("Background script loaded");
console.log("Extension ID:", browser.runtime.id);

// Start the OAuth flow
async function startAuthFlow() {
  const state = Math.random().toString(36).substring(2);
  const authUrl = `https://www.reddit.com/api/v1/authorize?client_id=${CLIENT_ID}&response_type=code&state=${state}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${SCOPES}`;
  console.log("Generated authUrl:", authUrl);

  return new Promise((resolve, reject) => {
    // Open the authorization URL in a new tab
    browser.tabs.create({ url: authUrl }).then(tab => {
      const tabId = tab.id;
      console.log("Opened auth tab with ID:", tabId);

      browser.runtime.onMessage.addListener(function listener(message, sender) {
        console.log("Received message:", message, "from sender:", sender);
        if (message.action === "oauthCallback" && message.state === state) {
          browser.runtime.onMessage.removeListener(listener);
          // Close the redirect tab
          if (sender.tab && sender.tab.id) {
            browser.tabs.remove(sender.tab.id).catch(err => console.error("Failed to close tab:", err.message));
          }
          const code = message.code;
          if (!code) {
            console.error("No authorization code returned");
            reject(new Error("No authorization code returned"));
            return;
          }
          exchangeCodeForToken(code, state).then(resolve).catch(reject);
        }
      });
    }).catch(error => {
      console.error("Tabs create error:", error.message);
      reject(new Error(`Tabs create failed: ${error.message}`));
    });
  });
}

// Exchange the code for an access token
async function exchangeCodeForToken(code, state) {
  try {
    const tokenUrl = "https://www.reddit.com/api/v1/access_token";
    const body = `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + btoa(`${CLIENT_ID}:`)
      },
      body: body
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Token exchange HTTP error:", response.status, errorText);
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (data.error) {
      console.error("Token exchange failed:", data.error);
      throw new Error(`Token request failed: ${data.error}`);
    }
    console.log("Access token:", data.access_token);
    await browser.storage.local.set({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenExpiration: Date.now() + data.expires_in * 1000
    });
    return data.access_token;
  } catch (error) {
    console.error("Token exchange error:", error.message);
    throw error;
  }
}

async function getUsername(accessToken) {
  console.log("Fetching username with token:", accessToken);
  try {
    const response = await fetch("https://oauth.reddit.com/api/v1/me", {
      headers: {
        "Authorization": `Bearer ${accessToken}`
      }
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Fetch username HTTP error:", response.status, errorText);
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (data.error) {
      console.error("API error:", data.error);
      throw new Error(`API error: ${data.error}`);
    }
    console.log("Username:", data.name);
    return data.name;
  } catch (error) {
    console.error("Fetch username error:", error.message);
    throw error;
  }
}

async function getValidToken() {
  console.log("Checking for valid token");
  const { accessToken, refreshToken, tokenExpiration } = await browser.storage.local.get([
    "accessToken",
    "refreshToken",
    "tokenExpiration"
  ]);
  if (accessToken && tokenExpiration && Date.now() < tokenExpiration) {
    console.log("Using existing access token");
    return accessToken;
  }
  if (refreshToken) {
    console.log("Refreshing token");
    return await refreshToken(refreshToken);
  }
  console.log("Starting new auth flow");
  return await startAuthFlow();
}

async function refreshToken(refreshToken) {
  try {
    const response = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + btoa(`${CLIENT_ID}:`)
      },
      body: `grant_type=refresh_token&refresh_token=${refreshToken}`
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Refresh token HTTP error:", response.status, errorText);
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (data.error) {
      console.error("Refresh token failed:", data.error);
      throw new Error(`Refresh token failed: ${data.error}`);
    }
    await browser.storage.local.set({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenExpiration: Date.now() + data.expires_in * 1000
    });
    console.log("Token refreshed successfully");
    return data.access_token;
  } catch (error) {
    console.error("Refresh token error:", error.message);
    throw error;
  }
}

async function fetchComments(accessToken) {
  console.log("Fetching comments with token:", accessToken);
  try {
    const username = await getUsername(accessToken);
    const response = await fetch(`https://oauth.reddit.com/user/${username}/comments?limit=5`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`
      }
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Fetch comments HTTP error:", response.status, errorText);
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (data.error) {
      console.error("API error:", data.error);
      throw new Error(`API error: ${data.error}`);
    }
    return data.data.children.map(comment => ({
      id: comment.data.id,
      body: comment.data.body,
      subreddit: comment.data.subreddit,
      created: new Date(comment.data.created_utc * 1000).toLocaleString()
    }));
  } catch (error) {
    console.error("Fetch comments error:", error.message);
    throw error;
  }
}

// Message listener for popup
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("Received message:", message, "from sender:", sender);
  if (message.action === "getComments") {
    getValidToken()
      .then(accessToken => fetchComments(accessToken))
      .then(comments => {
        console.log("Sending comments:", comments);
        sendResponse({ status: "success", comments });
      })
      .catch(error => {
        console.error("Get comments error:", error.message);
        sendResponse({ status: "error", message: error.message });
      });
    return true; // Keep the message channel open for async response
  }
});

console.log("Message listener registered");