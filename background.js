const DEFAULT_CLIENT_ID = "HgQTMaSrLS4wYX2eZ-eR0Q";
const REDIRECT_URI = "https://shajirr.github.io/reddit-mass-comment-editor/redirect.html";
const SCOPES = "identity read history edit";

// will be updated from storage
let CLIENT_ID = DEFAULT_CLIENT_ID; 

console.log("Background script loaded");

let dashboardTabId = null;
let isDashboardTabReady = false;
let pendingStatusMessages = [];

// rate limiting system variables

let currentDelay = 2000; // Default 2 seconds
let raisedDelayTimeout = null; // Timer for returning to default
let consecutiveRateLimitErrors = 0; // Track consecutive errors at 5000ms
let lastRequestTime = 0;

// Rate limiting configuration
const DEFAULT_DELAY = 2000;
const RAISED_DELAY_1 = 3000;
const RAISED_DELAY_2 = 5000;
const RAISED_DELAY_DURATION = 60000; // 1 minute
const PAUSE_DURATION = 60000; // 1 minute pause
const MAX_CONSECUTIVE_ERRORS = 3;

// Tracking rate limit headers
let rateLimitRemaining = null;
let rateLimitUsed = null;
let rateLimitReset = null;

// Function to parse and store rate limit headers
function parseRateLimitHeaders(response) {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const used = response.headers.get('x-ratelimit-used');
  const reset = response.headers.get('x-ratelimit-reset');
  
  if (remaining !== null) {
    rateLimitRemaining = Math.floor(parseFloat(remaining)); // Remove decimal part
  }
  if (used !== null) {
    rateLimitUsed = Math.floor(parseFloat(used));
  }
  if (reset !== null) {
    rateLimitReset = parseInt(reset);
  }
  // Send update to dashboard
  updateRateLimitHeaderDisplay();
}

// Send rate limit header info to dashboard
async function updateRateLimitHeaderDisplay() {
  if (isDashboardTabReady && dashboardTabId) {
    try {
      await browser.tabs.sendMessage(dashboardTabId, {
        action: "updateRateLimitHeaders",
        remaining: rateLimitRemaining,
        used: rateLimitUsed,
        reset: rateLimitReset
      });
    } catch (err) {
      console.error("Failed to send rate limit headers update:", err.message);
    }
  }
}

// Send CLIENT_ID status update to dashboard
async function updateClientIdStatus() {
  if (isDashboardTabReady && dashboardTabId) {
    try {
      const isDefault = CLIENT_ID === DEFAULT_CLIENT_ID;
      await browser.tabs.sendMessage(dashboardTabId, {
        action: "updateClientIdStatus",
        clientId: CLIENT_ID,
        isDefault: isDefault,
        preview: CLIENT_ID.substring(0, 10) + (CLIENT_ID.length > 10 ? "..." : "")
      });
    } catch (err) {
      console.error("Failed to send CLIENT_ID status update:", err.message);
    }
  }
}

// Reset delay to default and clear timer
function resetToDefaultDelay() {
  currentDelay = DEFAULT_DELAY;
  if (raisedDelayTimeout) {
    clearTimeout(raisedDelayTimeout);
    raisedDelayTimeout = null;
  }
  consecutiveRateLimitErrors = 0;
  console.log("Rate limit delay reset to default:", DEFAULT_DELAY + "ms");
  sendRateLimitStatusUpdate();
}

// Raise delay with timer to reset back to default
function raiseDelayTemporarily(newDelay) {
  currentDelay = newDelay;
  
  // Clear existing timer if any
  if (raisedDelayTimeout) {
    clearTimeout(raisedDelayTimeout);
  }
  
  // Set new timer to reset to default after 1 minute
  raisedDelayTimeout = setTimeout(() => {
    resetToDefaultDelay();
  }, RAISED_DELAY_DURATION);
  
  console.log(`Rate limit delay raised to ${newDelay}ms for 1 minute`);
  sendRateLimitStatusUpdate();
}

// Wait for rate limit based on current delay
async function waitForRateLimit() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < currentDelay) {
    const waitTime = currentDelay - timeSinceLastRequest;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  
  lastRequestTime = Date.now();
}

// Check if error is a rate limit error
function isRateLimitError(error) {
  const errorText = error.message.toLowerCase();
  return errorText.includes("doing it too much") || 
         errorText.includes("rate limit") ||
         errorText.includes("wait");
}

// Handle rate limit error with escalating timeouts
async function handleRateLimitError(error) {
  if (!isRateLimitError(error)) {
    // Reset consecutive errors if this isn't a rate limit error
    consecutiveRateLimitErrors = 0;
    return false;
  }
  
  await sendStatusMessage(`Rate limit detected: ${error.message}`);
  
  if (currentDelay === DEFAULT_DELAY) {
    // First rate limit error - raise to 3000ms
    raiseDelayTemporarily(RAISED_DELAY_1);
    await sendStatusMessage(`Increased delay to ${RAISED_DELAY_1}ms for 1 minute`);
    consecutiveRateLimitErrors = 0;
  } else if (currentDelay === RAISED_DELAY_1) {
    // Second rate limit error - raise to 5000ms
    raiseDelayTemporarily(RAISED_DELAY_2);
    await sendStatusMessage(`Increased delay to ${RAISED_DELAY_2}ms for 1 minute`);
    consecutiveRateLimitErrors = 0;
  } else if (currentDelay === RAISED_DELAY_2) {
    // At maximum delay - count consecutive errors
    consecutiveRateLimitErrors++;
    await sendStatusMessage(`Rate limit error ${consecutiveRateLimitErrors}/${MAX_CONSECUTIVE_ERRORS} at maximum delay`);
    
    if (consecutiveRateLimitErrors >= MAX_CONSECUTIVE_ERRORS) {
      // Pause operation for 1 minute
      await sendStatusMessage(`Too many rate limit errors - pausing for 1 minute`);
      await new Promise(resolve => setTimeout(resolve, PAUSE_DURATION));
      
      // Reset everything after pause
      resetToDefaultDelay();
      await sendStatusMessage(`Resumed after pause - delay reset to ${DEFAULT_DELAY}ms`);
      return true; // Indicate that we paused
    }
  }
  
  return true; // Indicate this was a rate limit error
}

// Send rate limit status updates
async function sendRateLimitStatusUpdate() {
  if (isDashboardTabReady && dashboardTabId) {
    try {
      await browser.tabs.sendMessage(dashboardTabId, {
        action: "updateRateLimitStatus",
        delay: currentDelay,
        temporary: currentDelay !== DEFAULT_DELAY
      });
    } catch (err) {
      console.error("Failed to send rate limit status update:", err.message);
    }
  }
}



// Initialize API request counter
async function incrementApiRequestCounter() {
  const { apiRequestCount = 0 } = await browser.storage.local.get("apiRequestCount");
  const newCount = apiRequestCount + 1;
  await browser.storage.local.set({ apiRequestCount: newCount });
  await updateApiRequestCounterDisplay();
  return newCount;
}
// Update API counter display
async function updateApiRequestCounterDisplay() {
  const { apiRequestCount = 0 } = await browser.storage.local.get("apiRequestCount");
  if (isDashboardTabReady && dashboardTabId) {
    try {
      await browser.tabs.sendMessage(dashboardTabId, {
        action: "updateApiRequestCounter",
        count: apiRequestCount
      });
    } catch (err) {
      console.error("Failed to send API request counter update:", err.message);
    }
  }
}

// Reset API request counter
async function resetApiRequestCounter() {
  await browser.storage.local.set({ apiRequestCount: 0 });
  await updateApiRequestCounterDisplay();
}

// Decode HTML entities (simple version for common entities)
function decodeHtmlEntities(text) {
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&al;': '&',
    '&not;': '¬'
  };
  return text.replace(/&amp;|&lt;|&gt;|&quot;|&apos;|&al;|&not;/g, match => entities[match] || match);
}

// Calculate Levenshtein distance for text similarity
function levenshteinDistance(a, b) {
  const matrix = Array(b.length + 1).fill().map(() => Array(a.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1, // deletion
        matrix[j - 1][i] + 1, // insertion
        matrix[j - 1][i - 1] + indicator // substitution
      );
    }
  }
  return matrix[b.length][a.length];
}

// Calculate similarity percentage between two strings
function calculateSimilarity(text1, text2) {
  const maxLength = Math.max(text1.length, text2.length);
  if (maxLength === 0) return 100; // Both empty
  const distance = levenshteinDistance(text1, text2);
  return ((maxLength - distance) / maxLength) * 100;
}

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
  await resetApiRequestCounter(); // Reset counter on new authentication
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
    await incrementApiRequestCounter(); // Count token exchange request
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
    parseRateLimitHeaders(response);
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

// Refresh an access token using a refresh token
async function refreshToken(refreshToken) {
  try {
    await sendStatusMessage("Refreshing token...");
    await incrementApiRequestCounter(); // Count token refresh request
    const response = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + btoa(`${CLIENT_ID}:`)
      },
      body: `grant_type=refresh_token&refresh_token=${refreshToken}`
    });
    parseRateLimitHeaders(response);
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Token refresh HTTP error:", response.status, errorText);
      throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (data.error) {
      console.error("Token refresh failed:", data.error);
      throw new Error(`Token refresh failed: ${data.error}`);
    }
    console.log("Refreshed token, expires in:", data.expires_in, "seconds");
    await browser.storage.local.set({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      tokenExpiration: Date.now() + data.expires_in * 1000
    });
    await sendStatusMessage("Token refreshed");
    return data.access_token;
  } catch (error) {
    console.error("Token refresh error:", error.message);
    await sendStatusMessage(`Token refresh failed: ${error.message}`);
    return null;
  }
}

// Fetch username using access token
async function getUsername(accessToken) {
  console.log("Fetching username with token:", accessToken);
  await sendStatusMessage("Fetching username...");
  await incrementApiRequestCounter(); // Count username fetch request
  try {
    const response = await fetch("https://oauth.reddit.com/api/v1/me", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": "RedditMassCommentEditor/1.0"
      }
    });
    parseRateLimitHeaders(response);
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
    await browser.storage.local.set({ username: data.name }); // Cache username
    await sendStatusMessage(`Username fetched: ${data.name}`);
    return data.name;
  } catch (error) {
    console.error("Fetch username error:", error.message);
    throw error;
  }
}

// Get a valid access token, refreshing if necessary
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

// Delete authentication token
async function deleteAuthToken() {
  await browser.storage.local.remove(["accessToken", "refreshToken", "tokenExpiration", "username"]);
  console.log("Auth token and username deleted");
  await sendStatusMessage("Auth token and username deleted");
  await resetApiRequestCounter(); // Reset counter on token deletion
  await sendStatusMessage("Authentication token deleted");
  if (isDashboardTabReady && dashboardTabId) {
    try {
      await browser.tabs.sendMessage(dashboardTabId, {
        action: "updateAuthStatus",
        status: "No token present",
        username: ""
      });
    } catch (err) {
      console.error("Failed to send auth status update:", err.message);
    }
  }
}

// Edit a comment
async function editComment(accessToken, commentId, newText) {
  console.log("Editing comment with ID:", commentId);
  await sendStatusMessage(`Editing comment with ID: ${commentId}...`);
  await incrementApiRequestCounter();
  
  try {
    // Wait for rate limit before making request
    await waitForRateLimit();
    
    console.log("Using access token:", accessToken.substring(0, 20) + "...");
    const response = await fetch(`https://oauth.reddit.com/api/editusertext`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": "RedditMassCommentEditor/1.0",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        api_type: "json",
        thing_id: `t1_${commentId}`,
        text: newText
      }).toString()
    });
    parseRateLimitHeaders(response);
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Edit comment HTTP error:", response.status, errorText);
      const error = new Error(`HTTP error: ${response.status} ${errorText}`);
      
      await handleRateLimitError(error);
      throw error;
    }
    
    const data = await response.json();
    if (data.json && data.json.errors && data.json.errors.length > 0) {
      console.error("Edit comment API error:", data.json.errors);
      const error = new Error(`API error: ${data.json.errors[0][1]}`);
      
      await handleRateLimitError(error);
      throw error;
    }
    
    // Success - reset consecutive error counter, keep current delay and timer)
    consecutiveRateLimitErrors = 0;
    
    // Rest of existing validation logic
    if (!data.json || !data.json.data || !data.json.data.things || data.json.data.things.length === 0) {
      console.error("Invalid edit response structure:", data);
      throw new Error("Invalid response structure from Reddit API");
    }
    
    const updatedComment = data.json.data.things[0].data.body;
    const normalizedNewText = decodeHtmlEntities(newText);
    const normalizedUpdatedComment = decodeHtmlEntities(updatedComment);
    const similarity = calculateSimilarity(normalizedNewText, normalizedUpdatedComment);
    
    console.log(`Similarity between expected and received text: ${similarity}%`);
    if (similarity > 80) {
      console.log("Successfully edited comment with ID:", commentId);
      await sendStatusMessage(`Successfully edited comment with ID: ${commentId}`);
      return { success: true };
    } else {
      console.error("Comment edit not applied: expected", normalizedNewText.substring(0, 20) + "...", "got", normalizedUpdatedComment.substring(0, 20) + "...");
      await sendStatusMessage(`Failed to edit comment ${commentId}: Comment ${commentId} edit not applied: expected "${normalizedNewText.substring(0, 20)}...", got "${normalizedUpdatedComment.substring(0, 20)}..."`);
      return { success: false, error: `Comment ${commentId} edit not applied: expected "${normalizedNewText.substring(0, 20)}...", got "${normalizedUpdatedComment.substring(0, 20)}..."` };
    }
  } catch (error) {
    console.error("Edit comment error:", error.message);
    await sendStatusMessage(`Failed to edit comment ${commentId}: ${error.message}`);
    return { success: false, error: `Failed to edit comment ${commentId}: ${error.message}` };
  }
}

// Check if a comment exists
async function checkCommentExists(commentId) {
  console.log("Checking if comment exists with ID:", commentId);
  await sendStatusMessage(`Checking comment existence with ID: ${commentId}...`);
  const { accessToken } = await browser.storage.local.get("accessToken");
  if (!accessToken) {
    throw new Error("No access token available for comment validation");
  }
  await incrementApiRequestCounter(); // Count comment existence check
  try {
    const response = await fetch(`https://oauth.reddit.com/api/info?id=t1_${commentId}`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": "RedditMassCommentEditor/1.0"
      }
    });
    parseRateLimitHeaders(response);
    if (!response.ok) {
	  const errorText = await response.text();
      console.error("Check comment exists HTTP error:", response.status, errorText);
      throw new Error(`HTTP error: ${response.status} ${errorText}`);
    }
    const data = await response.json();
    if (!data.data || !data.data.children || data.data.children.length === 0) {
	  console.error("Invalid check comment response:", data);
      throw new Error(`Comment ID ${commentId} not found or inaccessible`);																
    }
    console.log("Comment exists with ID:", commentId);
    await sendStatusMessage(`Comment exists with ID: ${commentId}`);
    return true;
  } catch (error) {
      console.error("Check comment exists error:", error.message);
      await sendStatusMessage(`Failed to check comment ${commentId}: ${error.message}`);
      return false;
  }
}
// Fetch a single comment by ID
async function fetchCommentById(accessToken, commentId) {
  console.log("Fetching comment with ID:", commentId);
  await incrementApiRequestCounter();
  try {
    const response = await fetch(`https://oauth.reddit.com/api/info?id=t1_${commentId}`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": "RedditMassCommentEditor/1.0"
      }
    });
    parseRateLimitHeaders(response);
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Fetch comment by ID HTTP error:", response.status, errorText);
      throw new Error(`HTTP error: ${response.status} ${errorText}`);
    }
    const data = await response.json();
    if (data.error || !data.data || !data.data.children || data.data.children.length === 0) {
      console.error("Invalid fetch comment response:", data);
      throw new Error(`API error: ${data.error || "No comment data returned"}`);
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
      index: 1, // Single comment, assign index 1
      isSaved: commentData.saved
    };
    console.log(`Fetched comment with ID: ${commentId}, isSaved: ${comment.isSaved}`);
    await sendStatusMessage(`Fetched comment with ID: ${commentId}`);
    return comment;
  } catch (error) {
    console.error("Fetch comment error:", error.message);
    await sendStatusMessage(`Error: ${error.message}`);
    throw error;
  }
}

// Delete a comment
async function deleteComment(accessToken, commentId) {
  console.log("Deleting comment with ID:", commentId);
  await sendStatusMessage(`Deleting comment with ID: ${commentId}...`);
  await incrementApiRequestCounter();
  try {
    console.log("Using access token:", accessToken.substring(0, 20) + "...");
    const response = await fetch(`https://oauth.reddit.com/api/del`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": "RedditMassCommentEditor/1.0",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        api_type: "json",
        id: `t1_${commentId}`
      }).toString()
    });
    parseRateLimitHeaders(response);
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Delete comment HTTP error:", response.status, errorText);
      throw new Error(`HTTP error: ${response.status} ${errorText}`);
    }
    const data = await response.json();
    if (data.json && data.json.errors && data.json.errors.length > 0) {
      console.error("Delete comment API error:", data.json.errors);
      throw new Error(`API error: ${data.json.errors[0][1]}`);
    }
    console.log("Successfully deleted comment with ID:", commentId);
    await sendStatusMessage(`Successfully deleted comment with ID: ${commentId}`);
    return { success: true };
  } catch (error) {
    console.error("Delete comment error:", error.message);
    await sendStatusMessage(`Failed to delete comment ${commentId}: ${error.message}`);
    return { success: false, error: `Failed to delete comment ${commentId}: ${error.message}` };
  }
}

// Fetch user comments
async function fetchComments(accessToken, maxComments, afterCommentId) {
  const { username } = await browser.storage.local.get("username");
  if (!username) {
    console.error("No username found in storage");
    await sendStatusMessage("No username found. Please re-authenticate.");
    throw new Error("No username found. Please re-authenticate.");
  }
  console.log(`Fetching up to ${maxComments} comments with token:`, accessToken, `afterCommentId: ${afterCommentId || 'none'}`);
  await sendStatusMessage(`Starting comment fetch${afterCommentId ? ` after ID: ${afterCommentId}` : ''}...`);
  try {
    if (afterCommentId) {
      await checkCommentExists(afterCommentId);
    }
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
      await incrementApiRequestCounter(); // Count each batch fetch
      const endpoint = `https://oauth.reddit.com/user/${username}/comments?limit=${batchSize}${after ? `&after=${after}` : ''}`;
      const response = await fetch(endpoint, {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "User-Agent": "RedditMassCommentEditor/1.0"
        }
      });
      parseRateLimitHeaders(response);
      if (!response.ok) {
        const errorText = await response.text();
        console.error("Fetch comments HTTP error:", response.status, errorText);
        throw new Error(`HTTP error: ${response.status} ${errorText}`);
      }
      const data = await response.json();
      if (data.error || !data.data || !data.data.children) {
        console.error("Invalid fetch comments response:", data);
        throw new Error(`API error: ${data.error || "No comment data returned"}`);
      }
      const comments = data.data.children
        .map((comment, index) => ({
          id: comment.data.id,
          body: comment.data.body,
          subreddit: comment.data.subreddit,
          created: new Date(comment.data.created_utc * 1000).toLocaleString(),
          created_utc: comment.data.created_utc,
          index: allComments.length + index + 1, // 1-based index
          isSaved: comment.data.saved
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

browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  console.log("Received message:", message, "from sender:", sender);
  if (message.action === "dashboardTabReady") {
    dashboardTabId = message.tabId;
    isDashboardTabReady = true;
    console.log("Dashboard tab ready, ID:", dashboardTabId);
    flushPendingStatusMessages();
	// Send initial rate limit status
	await sendRateLimitStatusUpdate();
    await updateRateLimitHeaderDisplay();
    
    // Update CLIENT_ID status on dashboard ready
    await updateClientIdStatus();
    
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
      // Send initial API request count
      const { apiRequestCount = 0 } = await browser.storage.local.get("apiRequestCount");
      await browser.tabs.sendMessage(dashboardTabId, {
        action: "updateApiRequestCounter",
        count: apiRequestCount
      });
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
        const errorMsg = "No valid token. Please authenticate first.";
        await browser.tabs.sendMessage(dashboardTabId, {
          action: "displayError",
          error: errorMsg
        });
        return { success: false, error: errorMsg };
      }
      const result = await fetchComments(accessToken, message.maxComments, message.afterCommentId);
      return { success: true, result: result };
    } catch (error) {
      console.error("Fetch comments error:", error.message);
      if (isDashboardTabReady && dashboardTabId) {
        await browser.tabs.sendMessage(dashboardTabId, {
          action: "displayError",
          error: error.message
        });
      }
      return { success: false, error: error.message };
    }
  } else if (message.action === "fetchCommentById") {
    try {
      const accessToken = await getValidToken();
      if (!accessToken) {
        const errorMsg = "No valid token. Please authenticate first.";
        await browser.tabs.sendMessage(dashboardTabId, {
          action: "displayError",
          error: errorMsg
        });
        return { success: false, error: errorMsg };
      }
      const comment = await fetchCommentById(accessToken, message.commentId);
      await browser.tabs.sendMessage(dashboardTabId, {
        action: "addComments",
        allComments: [comment]
      });
      return { success: true, comment: comment };
    } catch (error) {
      console.error("Fetch comment by ID error:", error.message);
      if (isDashboardTabReady && dashboardTabId) {
        await browser.tabs.sendMessage(dashboardTabId, {
          action: "displayError",
          error: error.message
        });
      }
      return { success: false, error: error.message };
    }
  } else if (message.action === "editComment") {
    console.log("Processing editComment request for comment ID:", message.commentId);
    try {
      const accessToken = message.accessToken || await getValidToken();
      if (!accessToken) {
        console.error("No valid token for editComment");
        return { success: false, error: "No valid token. Please authenticate first." };
      }
      const result = await editComment(accessToken, message.commentId, message.newText);
      console.log("editComment response:", result);
      return result;
    } catch (error) {
      console.error("Edit comment error:", error.message);
      await sendStatusMessage(`Failed to edit comment ID: ${message.commentId} - ${error.message}`);
      return { success: false, error: `Failed to edit comment ${message.commentId}: ${error.message}` };
    }
  } else if (message.action === "checkToken") {
    console.log("Processing checkToken request");
    try {
      const accessToken = await getValidToken();
      if (!accessToken) {
        console.error("No valid token found in getValidToken");
        await sendStatusMessage("No valid token found");
        return { valid: false, accessToken: null };
      }
      console.log("Returning valid token:", accessToken.substring(0, 20) + "...");
      await sendStatusMessage("Valid token confirmed");
      return { valid: true, accessToken: accessToken };
    } catch (err) {
      console.error("Check token error:", err.message);
      await sendStatusMessage(`Check token failed: ${err.message}`);
      return { valid: false, accessToken: null };
    }
  } else if (message.action === "deleteComment") {
    console.log("Processing deleteComment request for comment ID:", message.commentId);
    try {
      const accessToken = message.accessToken || await getValidToken();
      if (!accessToken) {
        console.error("No valid token for deleteComment");
        return { success: false, error: "No valid token. Please authenticate first." };
      }
      const result = await deleteComment(accessToken, message.commentId);
      console.log("deleteComment response:", result);
      return result;
    } catch (error) {
      console.error("Delete comment error:", error.message);
      await sendStatusMessage(`Failed to delete comment ID: ${message.commentId} - ${error.message}`);
      return { success: false, error: `Failed to delete comment ${message.commentId}: ${error.message}` };
    }
  } else if (message.action === "resetApiRequestCounter") {
    await resetApiRequestCounter();
    await sendStatusMessage("API request counter reset");
	return { success: true };						 
  } else if (message.action === "setCustomClientId") {
    try {
      const result = await setCustomClientId(message.clientId);
      return result;
    } catch (error) {
      console.error("Set custom CLIENT_ID error:", error.message);
      return { success: false, error: error.message };
    }
  } else if (message.action === "resetToDefaultClientId") {
    try {
      const result = await resetToDefaultClientId();
      return result;
    } catch (error) {
      console.error("Reset CLIENT_ID error:", error.message);
      return { success: false, error: error.message };
    }
  } else if (message.action === "getCurrentClientId") {
    const isDefault = CLIENT_ID === DEFAULT_CLIENT_ID;
    return { 
      success: true, 
      clientId: CLIENT_ID,
      isDefault: isDefault,
      preview: CLIENT_ID.substring(0, 10) + (CLIENT_ID.length > 10 ? "..." : "")
    };
  }
});

console.log("Message listener registered for dashboard tab");

// Load custom CLIENT_ID from storage on startup
async function loadCustomClientId() {
  try {
    const { customClientId } = await browser.storage.local.get("customClientId");
    if (customClientId) {
      CLIENT_ID = customClientId;
      console.log("Loaded custom CLIENT_ID:", CLIENT_ID.substring(0, 10) + "...");
    } else {
      CLIENT_ID = DEFAULT_CLIENT_ID;
      console.log("Using default CLIENT_ID");
    }
  } catch (error) {
    console.error("Failed to load custom CLIENT_ID:", error.message);
    CLIENT_ID = DEFAULT_CLIENT_ID;
  }
}

// Set custom CLIENT_ID
async function setCustomClientId(newClientId) {
  const oldClientId = CLIENT_ID;
  
  try {
    // Test the new CLIENT_ID first
    const testResult = await testClientId(newClientId);
    if (!testResult.success) {
      throw new Error(testResult.error);
    }
    
    // If test succeeds, clear existing tokens since they're tied to the old CLIENT_ID
    await browser.storage.local.remove(["accessToken", "refreshToken", "tokenExpiration", "username"]);
    await sendStatusMessage("Cleared existing authentication tokens due to CLIENT_ID change");
    
    // Set the new CLIENT_ID
    CLIENT_ID = newClientId;
    await browser.storage.local.set({ customClientId: newClientId });
    
    // Update dashboard auth status to reflect cleared tokens
    if (isDashboardTabReady && dashboardTabId) {
      try {
        await browser.tabs.sendMessage(dashboardTabId, {
          action: "updateAuthStatus",
          status: "No token present (CLIENT_ID changed)",
          username: ""
        });
      } catch (err) {
        console.error("Failed to send auth status update:", err.message);
      }
    }
    
    await sendStatusMessage(`Custom CLIENT_ID set: ${newClientId.substring(0, 10)}... ${testResult.warning || ''}`);
    // Update dashboard CLIENT_ID status display
    await updateClientIdStatus();
    return { success: true, warning: testResult.warning };
    
  } catch (error) {
    CLIENT_ID = oldClientId; // Revert on failure
    await sendStatusMessage(`Failed to set custom CLIENT_ID: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Reset to default CLIENT_ID
async function resetToDefaultClientId() {
  const wasCustom = CLIENT_ID !== DEFAULT_CLIENT_ID;
  CLIENT_ID = DEFAULT_CLIENT_ID;
  await browser.storage.local.remove("customClientId");
  
  // If we were using a custom CLIENT_ID, clear tokens
  if (wasCustom) {
    await browser.storage.local.remove(["accessToken", "refreshToken", "tokenExpiration", "username"]);
    await sendStatusMessage("Reset to default CLIENT_ID and cleared authentication tokens");
    // Update dashboard CLIENT_ID status display
    await updateClientIdStatus();
    
    // Update dashboard auth status
    if (isDashboardTabReady && dashboardTabId) {
      try {
        await browser.tabs.sendMessage(dashboardTabId, {
          action: "updateAuthStatus",
          status: "No token present (CLIENT_ID reset)",
          username: ""
        });
      } catch (err) {
        console.error("Failed to send auth status update:", err.message);
      }
    }
  } else {
    await sendStatusMessage("Reset to default CLIENT_ID");
  }
  
  return { success: true };
}

// Test CLIENT_ID by attempting OAuth authorization URL creation and basic validation
async function testClientId(clientId) {
  try {
    // Basic validation
    if (!clientId || clientId.trim().length === 0) {
      return { success: false, error: "CLIENT_ID cannot be empty" };
    }
    
    if (clientId.trim().length < 14) {
      return { success: false, error: "CLIENT_ID appears to be too short (Reddit CLIENT_IDs are typically 14+ characters)" };
    }
    
    // Check for invalid characters (Reddit CLIENT_IDs are alphanumeric with some symbols)
    if (!/^[A-Za-z0-9_-]+$/.test(clientId)) {
      return { success: false, error: "CLIENT_ID contains invalid characters (only letters, numbers, underscore, and dash allowed)" };
    }
    
    // Test by making an actual authorization request to Reddit
    // We'll try to create an auth URL and see if Reddit accepts it
    const state = Math.random().toString(36).substring(2);
    const testAuthUrl = `https://www.reddit.com/api/v1/authorize?client_id=${clientId}&response_type=code&state=${state}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${SCOPES}`;
    
    try {
      // Make a HEAD request to see if Reddit accepts this CLIENT_ID
      const response = await fetch(testAuthUrl, { method: 'HEAD' });
      
      // If we get a redirect or 200, the CLIENT_ID is likely valid
      // If we get 400/401/403, the CLIENT_ID is likely invalid
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        return { success: false, error: "CLIENT_ID rejected by Reddit (invalid or non-existent)" };
      }
      
      // Any other response (including redirects) suggests the CLIENT_ID format is accepted
      return { success: true };
    } catch (fetchError) {
      // Network errors or CORS issues - assume CLIENT_ID might be valid
      // (we can't definitively test due to browser restrictions)
      return { success: true, warning: "Could not fully validate CLIENT_ID due to network restrictions, but format appears valid" };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Load custom CLIENT_ID on startup
loadCustomClientId();
