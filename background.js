const CLIENT_ID = "DOspouQ0Wv_lnJt4ogAkWA";
const REDIRECT_URI = "https://shajirr.github.io/reddit-comment-scrambler-a/redirect.html";
const SCOPES = "identity read history edit";

console.log("Background script loaded");
console.log("Extension ID:", browser.runtime.id);

let dashboardTabId = null;
let isDashboardTabReady = false;
let pendingStatusMessages = [];

// Send or queue status message based on tab readiness
async function sendStatusMessage(message) {
  const statusMessage = `${new Date().toLocaleTimeString()}: ${message}`;
  if (isDashboardTabReady && dashboardTabId) {
    try {
      await browser.tabs.sendMessage(dashboardTabId, {
        action: "updateStatus",
        message: statusMessage
      });
    } catch (err) {
      console.error("Failed to send status message:", err.message);
    }
  } else {
    console.log("Queuing status message:", statusMessage);
    pendingStatusMessages.push(statusMessage);
  }
}

// Flush queued status messages when tab is ready
async function flushPendingStatusMessages() {
  for (const message of pendingStatusMessages) {
    try {
      await browser.tabs.sendMessage(dashboardTabId, {
        action: "updateStatus",
        message
      });
    } catch (err) {
      console.error("Failed to send queued status message:", err.message);
    }
  }
  pendingStatusMessages = [];
}

// Start the OAuth flow
async function startAuthFlow() {
  await sendStatusMessage("Starting authentication...");
  const state = Math.random().toString(36).substring(2);
  const authUrl = `https://www.reddit.com/api/v1/authorize?client_id=${CLIENT_ID}&response_type=code&state=${state}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${SCOPES}`;
  console.log("Generated authUrl:", authUrl);

  return new Promise((resolve, reject) => {
    browser.tabs.create({ url: authUrl }).then(tab => {
      const tabId = tab.id;
      console.log("Opened auth tab with ID:", tabId);

      browser.runtime.onMessage.addListener(function listener(message, sender) {
        console.log("Received message:", message, "from sender:", sender);
        if (message.action === "oauthCallback" && message.state === state) {
          browser.runtime.onMessage.removeListener(listener);
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
    await sendStatusMessage("Exchanging code for token...");
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
    console.log("Access token received, expires in:", data.expires_in, "seconds");
    await browser.storage.local.set({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenExpiration: Date.now() + data.expires_in * 1000
    });
    await sendStatusMessage("Token received");
    return data.access_token;
  } catch (error) {
    console.error("Token exchange error:", error.message);
    throw error;
  }
}

async function getUsername(accessToken) {
  console.log("Fetching username with token:", accessToken);
  await sendStatusMessage("Fetching username...");
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
    await sendStatusMessage(`Username fetched: ${data.name}`);
    return data.name;
  } catch (error) {
    console.error("Fetch username error:", error.message);
    throw error;
  }
}

async function getValidToken() {
  console.log("Checking for valid token");
  await sendStatusMessage("Checking for valid token...");
  const { accessToken, refreshToken, tokenExpiration } = await browser.storage.local.get([
    "accessToken",
    "refreshToken",
    "tokenExpiration"
  ]);
  console.log("Stored token details:", {
    hasAccessToken: !!accessToken,
    hasRefreshToken: !!refreshToken,
    tokenExpiration: tokenExpiration ? new Date(tokenExpiration).toLocaleString() : "none",
    timeNow: new Date().toLocaleString()
  });
  if (accessToken && tokenExpiration && Date.now() < tokenExpiration) {
    console.log("Using existing access token");
    await sendStatusMessage("Using existing token");
    return accessToken;
  }
  if (refreshToken) {
    console.log("Refreshing token");
    await sendStatusMessage("Refreshing token...");
    return await refreshToken(refreshToken);
  }
  return null; // No valid token, require manual authentication
}

async function refreshToken(refreshToken) {
  try {
    await sendStatusMessage("Refreshing token...");
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
    console.log("Token refreshed, expires in:", data.expires_in, "seconds");
    await browser.storage.local.set({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenExpiration: Date.now() + data.expires_in * 1000
    });
    await sendStatusMessage("Token refreshed");
    return data.access_token;
  } catch (error) {
    console.error("Refresh token error:", error.message);
    throw error;
  }
}

async function deleteAuthToken() {
  await browser.storage.local.remove(["accessToken", "refreshToken", "tokenExpiration"]);
  await sendStatusMessage("Authentication token deleted");
  if (isDashboardTabReady && dashboardTabId) {
    await browser.tabs.sendMessage(dashboardTabId, {
      action: "updateAuthStatus",
      status: "No token present",
      username: ""
    });
  }
}

async function checkCommentExists(accessToken, commentId) {
  console.log(`Checking if comment exists with ID: ${commentId}`);
  await sendStatusMessage(`Checking comment with ID: ${commentId}...`);
  try {
    const response = await fetch(`https://oauth.reddit.com/api/info?id=t1_${commentId}`, {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Comment check HTTP error:", response.status, errorText);
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (data.error || !data.data || !data.data.children || data.data.children.length === 0) {
      throw new Error("Comment not found or inaccessible");
    }
    console.log(`Comment with ID: ${commentId} exists`);
    await sendStatusMessage(`Comment with ID: ${commentId} exists`);
    return true;
  } catch (error) {
    console.error("Comment check error:", error.message);
    await sendStatusMessage(`Error checking comment: ${error.message}`);
    throw error;
  }
}

async function fetchCommentById(accessToken, commentId) {
  console.log(`Fetching comment with ID: ${commentId}`);
  await sendStatusMessage(`Fetching comment with ID: ${commentId}...`);
  try {
    const response = await fetch(`https://oauth.reddit.com/api/info?id=t1_${commentId}`, {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Fetch comment HTTP error:", response.status, errorText);
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (data.error) {
      console.error("API error:", data.error);
      throw new Error(`API error: ${data.error}`);
    }
    const commentData = data.data?.children[0]?.data;
    if (!commentData) {
      throw new Error("Comment not found or inaccessible");
    }
    const comment = {
      id: commentData.id,
      body: commentData.body,
      subreddit: commentData.subreddit,
      created: new Date(commentData.created_utc * 1000).toLocaleString(),
      created_utc: commentData.created_utc,
      index: 1 // Single comment, assign index 1
    };
    console.log(`Fetched comment with ID: ${commentId}`);
    await sendStatusMessage(`Fetched comment with ID: ${commentId}`);
    return comment;
  } catch (error) {
    console.error("Fetch comment error:", error.message);
    await sendStatusMessage(`Error fetching comment: ${error.message}`);
    throw error;
  }
}

async function editComment(accessToken, commentId, newText) {
  console.log(`Editing comment with ID: ${commentId}`);
  await sendStatusMessage(`Editing comment with ID: ${commentId}...`);
  try {
    const response = await fetch("https://oauth.reddit.com/api/editusertext", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: `thing_id=t1_${commentId}&text=${encodeURIComponent(newText)}`
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Edit comment HTTP error:", response.status, errorText);
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (data.error) {
      console.error("API error:", data.error);
      throw new Error(`API error: ${data.error}`);
    }
    console.log(`Successfully edited comment with ID: ${commentId}`);
    await sendStatusMessage(`Successfully edited comment with ID: ${commentId}`);
    return data;
  } catch (error) {
    console.error("Edit comment error:", error.message);
    await sendStatusMessage(`Error editing comment: ${error.message}`);
    throw error;
  }
}

async function fetchComments(accessToken, maxComments, afterCommentId) {
  console.log(`Fetching up to ${maxComments} comments with token:`, accessToken, `afterCommentId: ${afterCommentId || 'none'}`);
  await sendStatusMessage(`Starting comment fetch${afterCommentId ? ` after ID: ${afterCommentId}` : ''}...`);
  try {
    if (afterCommentId) {
      await checkCommentExists(accessToken, afterCommentId);
    }
    const username = await getUsername(accessToken);
    let allComments = [];
    let after = afterCommentId ? `t1_${afterCommentId}` : null;
    const maxBatchSize = 100; // Reddit API max per request
    const delayMs = 600; // 0.6s delay for 100 QPM
    let batchNumber = 0;

    while (allComments.length < maxComments) {
      batchNumber++;
      const remainingComments = maxComments - allComments.length;
      const batchSize = Math.min(maxBatchSize, remainingComments);
      await sendStatusMessage(`Fetching batch ${batchNumber} of ${batchSize} comments${afterCommentId ? ` after ID: ${afterCommentId}` : ''}...`);
      const endpoint = `https://oauth.reddit.com/user/${username}/comments?limit=${batchSize}${after ? `&after=${after}` : ''}`;
      const response = await fetch(endpoint, {
        headers: { "Authorization": `Bearer ${accessToken}` }
      });
      if (!response.ok) {
        const errorText = await response.text();
        console.error("Fetch comments HTTP error:", response.status, errorText);
        throw new Error(`HTTP error: ${response.status} ${errorText}`);
      }
      const data = await response.json();
      if (data.error) {
        console.error("API error:", data.error);
        throw new Error(`API error: ${data.error}`);
      }
      const comments = data.data.children
        .map((comment, index) => ({
          id: comment.data.id,
          body: comment.data.body,
          subreddit: comment.data.subreddit,
          created: new Date(comment.data.created_utc * 1000).toLocaleString(),
          created_utc: comment.data.created_utc,
          index: allComments.length + index + 1 // 1-based index
        }));
      allComments = allComments.concat(comments);
      console.log(`Fetched ${comments.length} comments, total: ${allComments.length}`);
      // Send all comments for storage
      if (isDashboardTabReady && dashboardTabId) {
        try {
          await browser.tabs.sendMessage(dashboardTabId, {
            action: "addComments",
            allComments: comments
          });
        } catch (err) {
          console.error("Failed to send comments to tab:", err.message);
        }
      }
      await sendStatusMessage(`Fetched ${allComments.length}/${maxComments} comments${afterCommentId ? ` after ID: ${afterCommentId}` : ''}`);
      after = data.data.after;
      if (!after || allComments.length >= maxComments || comments.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    allComments = allComments.slice(0, maxComments);
    console.log(`Total comments fetched: ${allComments.length}`);
    await sendStatusMessage(`Completed: Fetched ${allComments.length} comments${afterCommentId ? ` after ID: ${afterCommentId}` : ''}`);
    return { comments: allComments.filter(comment => (comment.index % 50) === 0), totalFetched: allComments.length };
  } catch (error) {
    console.error("Fetch comments error:", error.message);
    await sendStatusMessage(`Error: ${error.message}`);
    throw error;
  }
}

// Trigger dashboard opening on icon click
browser.browserAction.onClicked.addListener(async () => {
  console.log("Add-on icon clicked");
  await sendStatusMessage("Opening dashboard...");
  const url = browser.runtime.getURL("dashboard.html");
  try {
    const tab = await browser.tabs.create({ url });
    dashboardTabId = tab.id;
    console.log("Opened dashboard tab with ID:", dashboardTabId);
  } catch (err) {
    console.error("Failed to open dashboard tab:", err.message);
    await sendStatusMessage(`Error opening dashboard tab: ${err.message}`);
  }
});

browser.runtime.onMessage.addListener(async (message) => {
  if (message.action === "dashboardTabReady") {
    console.log("Dashboard tab ready, ID:", message.tabId);
    dashboardTabId = message.tabId;
    isDashboardTabReady = true;
    flushPendingStatusMessages();
    // Check for existing token and update status
    try {
      const accessToken = await getValidToken();
      if (accessToken) {
        const username = await getUsername(accessToken);
        await browser.tabs.sendMessage(dashboardTabId, {
          action: "updateAuthStatus",
          status: "Valid token present",
          username: username
        });
      } else {
        await browser.tabs.sendMessage(dashboardTabId, {
          action: "updateAuthStatus",
          status: "No token present",
          username: ""
        });
      }
    } catch (error) {
      console.error("Error checking token on dashboard ready:", error.message);
      await browser.tabs.sendMessage(dashboardTabId, {
        action: "updateAuthStatus",
        status: `Error: ${error.message}`,
        username: ""
      });
    }
  } else if (message.action === "startAuth") {
    try {
      const accessToken = await startAuthFlow();
      const username = await getUsername(accessToken);
      if (isDashboardTabReady && dashboardTabId) {
        await browser.tabs.sendMessage(dashboardTabId, {
          action: "updateAuthStatus",
          status: "Authentication successful",
          username: username
        });
      }
    } catch (error) {
      console.error("Authentication error:", error.message);
      if (isDashboardTabReady && dashboardTabId) {
        await browser.tabs.sendMessage(dashboardTabId, {
          action: "updateAuthStatus",
          status: `Error: ${error.message}`,
          username: ""
        });
      }
    }
  } else if (message.action === "deleteAuthToken") {
    await deleteAuthToken();
  } else if (message.action === "fetchComments") {
    try {
      const accessToken = await getValidToken();
      if (!accessToken) {
        await browser.tabs.sendMessage(dashboardTabId, {
          action: "displayError",
          error: "No valid token. Please authenticate first."
        });
        return;
      }
      await fetchComments(accessToken, message.maxComments, message.afterCommentId);
    } catch (error) {
      console.error("Fetch comments error:", error.message);
      if (isDashboardTabReady && dashboardTabId) {
        await browser.tabs.sendMessage(dashboardTabId, {
          action: "displayError",
          error: error.message
        });
      }
    }
  } else if (message.action === "fetchCommentById") {
    try {
      const accessToken = await getValidToken();
      if (!accessToken) {
        await browser.tabs.sendMessage(dashboardTabId, {
          action: "displayError",
          error: "No valid token. Please authenticate first."
        });
        return;
      }
      const comment = await fetchCommentById(accessToken, message.commentId);
      await browser.tabs.sendMessage(dashboardTabId, {
        action: "addComments",
        allComments: [comment]
      });
    } catch (error) {
      console.error("Fetch comment by ID error:", error.message);
      if (isDashboardTabReady && dashboardTabId) {
        await browser.tabs.sendMessage(dashboardTabId, {
          action: "displayError",
          error: error.message
        });
      }
    }
  } else if (message.action === "editComment") {
    try {
      const accessToken = await getValidToken();
      if (!accessToken) {
        await browser.tabs.sendMessage(dashboardTabId, {
          action: "displayError",
          error: "No valid token. Please authenticate first."
        });
        return;
      }
      await editComment(accessToken, message.commentId, message.newText);
      await browser.tabs.sendMessage(dashboardTabId, {
        action: "editCommentSuccess",
        commentId: message.commentId,
        newText: message.newText
      });
    } catch (error) {
      console.error("Edit comment error:", error.message);
      if (isDashboardTabReady && dashboardTabId) {
        await browser.tabs.sendMessage(dashboardTabId, {
          action: "displayError",
          error: `Failed to edit comment: ${error.message}`
        });
      }
    }
  }
});

console.log("Message listener registered for dashboard tab");