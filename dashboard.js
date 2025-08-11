let commentCount = 0;
let allComments = []; // Store all fetched comments
let filteredComments = []; // Store filtered comments for display and actions
let safeWordsByLength = {};
let wordListLoaded = false;
let isProcessing = false; // Track mass operations
let abortController = null; // For stopping mass actions
let apiRequestCount = 0; // Track API requests

// Load word list from wordlist.txt
async function loadWordList() {
  if (wordListLoaded) return;
  const wordlistUrl = browser.runtime.getURL('wordlist.txt');
  try {
    const response = await fetch(wordlistUrl);
    if (!response.ok) {
      throw new Error(`Failed to load word list: HTTP ${response.status}`);
    }
    const text = await response.text();
    const words = text.split('\n')
      .map(word => word.trim().toLowerCase())
      .filter(word => word !== '');
    safeWordsByLength = {};
    words.forEach(word => {
      const length = word.length;
      if (!safeWordsByLength[length]) {
        safeWordsByLength[length] = [];
      }
      safeWordsByLength[length].push(word);
    });
    wordListLoaded = true;
  } catch (error) {
    console.error('Failed to load word list:', error.message);
    throw error;
  }
}

// Combine random words to match target length
function combineWordsToLength(targetLength, usedWords = []) {
  if (targetLength === 0) return '';
  
  // Handle single character case
  if (targetLength === 1) {
    return String.fromCharCode(97 + Math.floor(Math.random() * 26)); // Random lowercase letter
  }
  
  const availableLengths = Object.keys(safeWordsByLength)
    .map(Number)
    .filter(len => len <= targetLength && !usedWords.includes(len));
  if (availableLengths.length === 0) {
    throw new Error(`No words available to combine to length ${targetLength}`);
  }
  const length = availableLengths[Math.floor(Math.random() * availableLengths.length)];
  const words = safeWordsByLength[length];
  const word = words[Math.floor(Math.random() * words.length)];
  usedWords.push(length);
  return word + combineWordsToLength(targetLength - length, usedWords);
}

// Get a random word with exact length, preserving case
function getRandomWord(word) {
  const length = word.length;
  
  // Handle single characters specially
  if (length === 1) {
    const char = word[0];
    if (/[a-zA-Z]/.test(char)) {
      // Generate random letter preserving case
      const isUpper = char === char.toUpperCase();
      const randomLetter = String.fromCharCode(97 + Math.floor(Math.random() * 26)); // a-z
      return isUpper ? randomLetter.toUpperCase() : randomLetter;
    } else if (/\d/.test(char)) {
      // Generate random digit
      return Math.floor(Math.random() * 10).toString();
    } else {
      // Non-alphanumeric single character, return as-is
      return char;
    }
  }
  
  const words = safeWordsByLength[length];
  let randomWord;
  if (words && words.length > 0) {
    randomWord = words[Math.floor(Math.random() * words.length)];
  } else {
    randomWord = combineWordsToLength(length);
  }
  // Preserve case pattern
  let result = '';
  for (let i = 0; i < word.length; i++) {
    const char = word[i];
    const isUpper = char === char.toUpperCase();
    result += isUpper ? randomWord[i].toUpperCase() : randomWord[i].toLowerCase();
  }
  return result;
}

// Randomize digits while preserving length
function randomizeDigits(text) {
  return text.replace(/\d+/g, match => {
    return Array.from(match)
      .map(() => Math.floor(Math.random() * 10))
      .join('');
  });
}

// Randomize a comment's text
async function randomizeComment(text) {
  if (!wordListLoaded) {
    await loadWordList();
  }
  return text
    .split(/\b/)
    .map(part => {
      if (/^\w+$/.test(part)) {
        return getRandomWord(part);
      } else if (/\d+/.test(part)) {
        return randomizeDigits(part);
      }
      return part;
    })
    .join('');
}

// Perform search and replace on comment text
function performSearchReplace(text, searchTerm, replaceTerm, caseSensitive, wholeWords) {
  let flags = 'g';
  if (!caseSensitive) {
    flags += 'i';
  }
  
  let searchPattern;
  if (wholeWords) {
    // Escape special regex characters in search term
    const escapedSearch = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    searchPattern = new RegExp(`\\b${escapedSearch}\\b`, flags);
  } else {
    // Escape special regex characters in search term
    const escapedSearch = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    searchPattern = new RegExp(escapedSearch, flags);
  }
  
  return text.replace(searchPattern, replaceTerm);
}

// Find comments that match the search criteria
function findCommentsForReplacement(comments, searchTerm, caseSensitive, wholeWords) {
  if (!searchTerm.trim()) {
    return [];
  }
  
  let flags = caseSensitive ? 'g' : 'gi';
  let searchPattern;
  
  if (wholeWords) {
    const escapedSearch = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    searchPattern = new RegExp(`\\b${escapedSearch}\\b`, flags);
  } else {
    const escapedSearch = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    searchPattern = new RegExp(escapedSearch, flags);
  }
  
  return comments.filter(comment => {
    if (comment.isSaved) return false; // Skip saved comments
    return searchPattern.test(comment.body);
  });
}
// Check if subreddit exists
async function checkSubredditExists(subreddit) {
  try {
    const response = await fetch(`https://www.reddit.com/r/${subreddit}/about.json`, {
      method: 'GET',
      headers: { "User-Agent": "RedditMassCommentEditor/1.0" }
    });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Subreddit check failed: ${errorData.message || response.statusText}`);
    }
    const data = await response.json();
    if (data.error || !data.data) {
      throw new Error(`Subreddit not found or inaccessible`);
    }
    return true;
  } catch (error) {
    console.error(`Failed to check subreddit ${subreddit}:`, error.message);
    throw error;
  }
}

// Apply subreddit filter to comments
function applySubredditFilter(subreddit) {
  const subredditLower = subreddit.toLowerCase();
  filteredComments = allComments.filter(comment => comment.subreddit.toLowerCase() === subredditLower);
}

// Clear all loaded comments
function clearLoadedComments() {
  allComments = [];
  filteredComments = [];
  commentCount = 0;
  updateDisplayedComments();
  const consoleDiv = document.getElementById('console');
  const p = document.createElement('p');
  p.textContent = `${new Date().toLocaleTimeString()}: Cleared all loaded comments`;
  consoleDiv.appendChild(p);
  consoleDiv.scrollTop = consoleDiv.scrollHeight;
  document.getElementById('exportButton').disabled = true;
}
// Update displayed comments
function updateDisplayedComments() {
  const commentsDiv = document.getElementById('comments');
  const statusDiv = document.getElementById('status');
  const subredditFilter = document.getElementById('subredditFilter').checked;
  const subredditInput = document.getElementById('subredditInput').value.trim();
  const commentsToDisplay = subredditFilter && subredditInput ? filteredComments : allComments;
  commentCount = commentsToDisplay.length;
  statusDiv.textContent = `Showing ${commentCount} comments (Total fetched: ${allComments.length})`;
  let displayComments;
  if (commentCount <= 50) {
    // Display all comments if 50 or fewer
    displayComments = commentsToDisplay;
  } else {
    // Display first 50, every 50th, and the last comment
    displayComments = commentsToDisplay.slice(0, 50); // First 50 comments
    for (let i = 100; i <= commentCount; i += 50) {
      if (commentsToDisplay[i - 1]) { // i-1 for 1-based index
        displayComments.push(commentsToDisplay[i - 1]);
      }
    }
    // Add the last comment if not already included
    const lastComment = commentsToDisplay[commentCount - 1];
    if (lastComment && !displayComments.includes(lastComment)) {
      displayComments.push(lastComment);
    }
  }
  const html = displayComments
    .map(comment => `
      <div class="comment" data-comment-id="${comment.id}">
        <strong>Comment #${comment.index}</strong> (ID: ${comment.id})<br>
        <strong>Subreddit:</strong> ${comment.subreddit}<br>
        <strong>Posted:</strong> ${comment.created}<br>
        <p class="comment-body">${comment.body}</p>
        ${comment.isSaved ? '<span class="saved-label">Saved</span>' : '<button class="randomizeButton">Randomize</button>'}
      </div>
    `)
    .join('');
  commentsDiv.innerHTML = html;

  // Reattach randomize button listeners for non-saved comments
  document.querySelectorAll('.randomizeButton').forEach(button => {
    button.addEventListener('click', async () => {
      if (isProcessing) {
        const consoleDiv = document.getElementById('console');
        const p = document.createElement('p');
        p.textContent = `${new Date().toLocaleTimeString()}: Error: Mass operation in progress, please wait or stop`;
        consoleDiv.appendChild(p);
        consoleDiv.scrollTop = consoleDiv.scrollHeight;
        return;
      }
      const commentDiv = button.closest('.comment');
      const commentId = commentDiv.dataset.commentId;
      const commentBody = commentDiv.querySelector('.comment-body');
      const originalComment = (subredditFilter && subredditInput ? filteredComments : allComments)
        .find(c => c.id === commentId)?.body || commentBody.textContent;
      try {
        const randomizedText = await randomizeComment(originalComment);
        // Update UI
        commentBody.textContent = randomizedText;
        // Update stored comment
        const comment = allComments.find(c => c.id === commentId);
        if (comment) {
          comment.body = randomizedText;
        }
        const filteredComment = filteredComments.find(c => c.id === commentId);
        if (filteredComment) {
          filteredComment.body = randomizedText;
        }
        // Send to Reddit
        const editResponse = await browser.runtime.sendMessage({
          action: 'editComment',
          commentId: commentId,
          newText: randomizedText
        });
        if (!editResponse.success) {
          throw new Error(editResponse.error);
        }
        const consoleDiv = document.getElementById('console');
        const p = document.createElement('p');
        p.textContent = `${new Date().toLocaleTimeString()}: Randomized and updated comment ID: ${commentId}`;
        consoleDiv.appendChild(p);
        consoleDiv.scrollTop = consoleDiv.scrollHeight;
      } catch (error) {
        const consoleDiv = document.getElementById('console');
        const p = document.createElement('p');
        p.textContent = `${new Date().toLocaleTimeString()}: Error randomizing comment ID: ${commentId} - ${error.message}`;
        consoleDiv.appendChild(p);
        consoleDiv.scrollTop = consoleDiv.scrollHeight;
      }
    });
  });
}

// Export comments to JSON
function exportComments(comments, filenamePrefix) {
  const consoleDiv = document.getElementById('console');
  if (comments.length === 0) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: No comments to export`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    return false;
  }
  const json = JSON.stringify(comments, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenamePrefix}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  const p = document.createElement('p');
  p.textContent = `${new Date().toLocaleTimeString()}: Exported ${comments.length} comments`;
  consoleDiv.appendChild(p);
  consoleDiv.scrollTop = consoleDiv.scrollHeight;
  return true;
}

// Update API request counter display
function updateApiRequestCounter() {
  const apiCounterDiv = document.getElementById('apiRequestCounter');
  apiCounterDiv.textContent = `API Requests Made: ${apiRequestCount}`;
}
browser.runtime.getBackgroundPage().then(() => {
  browser.tabs.getCurrent().then(tab => {
    browser.runtime.sendMessage({
      action: 'dashboardTabReady',
      tabId: tab.id
    }).catch(err => console.error('Failed to send ready message:', err.message));
  });
});

browser.runtime.onMessage.addListener((message) => {
  console.log('Dashboard tab received message:', message);
  const consoleDiv = document.getElementById('console');
  const statusDiv = document.getElementById('status');
  const usernameDiv = document.getElementById('username');
  const authButton = document.getElementById('authButton');
  const deleteTokenButton = document.getElementById('deleteTokenButton');
  const exportButton = document.getElementById('exportButton');

  if (message.action === 'updateStatus') {
    const p = document.createElement('p');
    p.textContent = message.message;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  } else if (message.action === 'addComments') {
    allComments = allComments.concat(message.allComments);
    const subredditFilter = document.getElementById('subredditFilter').checked;
    const subredditInput = document.getElementById('subredditInput').value.trim();
    if (subredditFilter && subredditInput) {
      applySubredditFilter(subredditInput);
    } else {
      filteredComments = allComments;
    }
    updateDisplayedComments();
    exportButton.disabled = allComments.length === 0;
  } else if (message.action === 'editCommentSuccess') {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Successfully updated comment ID: ${message.commentId} on Reddit`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  } else if (message.action === 'displayError') {
    statusDiv.textContent = '';
    document.getElementById('comments').innerHTML = `<p class="error">Error: ${message.error}</p>`;
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Error: ${message.error}`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  } else if (message.action === 'updateAuthStatus') {
    statusDiv.textContent = message.status;
    usernameDiv.textContent = message.username ? `Username: ${message.username}` : 'Username: Not authenticated';
    authButton.disabled = message.status === 'Valid token present' || message.status === 'Authentication successful';
    deleteTokenButton.disabled = !message.username;
    if (message.status === 'Valid token present' || message.status === 'Authentication successful') {
      document.getElementById('comments').innerHTML = '';
    }
  } else if (message.action === 'updateApiRequestCounter') {
    // Update the API request counter display
    apiRequestCount = message.count;
    updateApiRequestCounter();
  } else if (message.action === 'incrementApiRequest') {
    apiRequestCount += 1;
    updateApiRequestCounter();
  } else if (message.action === 'updateRateLimitStatus') {
	const rateLimitStatusDiv = document.getElementById('rateLimitStatus');
	if (rateLimitStatusDiv) {
      rateLimitStatusDiv.textContent = `Delay for edits: ${message.delay}ms${message.temporary ? ' (temporary)' : ' (default)'}`;
    }
  } else if (message.action === 'updateRateLimitHeaders') {
    const rateLimitRemainingDiv = document.getElementById('rateLimitRemaining');
    if (rateLimitRemainingDiv) {
      if (message.remaining !== null) {
        rateLimitRemainingDiv.textContent = `Requests remaining: ${message.remaining}`;
      } else {
        rateLimitRemainingDiv.textContent = 'Requests remaining: --';
      }
    }
  }
});

document.getElementById('authButton').addEventListener('click', () => {
  browser.runtime.sendMessage({ action: 'startAuth' }).catch(err => {
    console.error('Failed to send auth message:', err.message);
  });
});

document.getElementById('deleteTokenButton').addEventListener('click', () => {
  browser.runtime.sendMessage({ action: 'deleteAuthToken' }).catch(err => {
    console.error('Failed to send delete token message:', err.message);
  });
});

document.getElementById('clearCommentsButton').addEventListener('click', () => {
  if (isProcessing) {
    const consoleDiv = document.getElementById('console');
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Cannot clear comments while processing is in progress`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    return;
  }
  clearLoadedComments();
});

document.getElementById('resetApiCounterButton').addEventListener('click', async () => {
  try {
    const response = await browser.runtime.sendMessage({ action: 'resetApiRequestCounter' });
  } catch (err) {
    console.error('Failed to reset API counter:', err.message);
	// Only show error messages in dashboard
    const consoleDiv = document.getElementById('console');
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Error resetting API counter: ${err.message}`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  }
});

document.getElementById('fetchButton').addEventListener('click', async () => {
  const commentCountInput = document.getElementById('commentCount');
  const maxComments = parseInt(commentCountInput.value, 10);
  const afterCommentFilter = document.getElementById('afterCommentFilter').checked;
  const afterCommentInput = document.getElementById('afterCommentInput').value.trim();
  const consoleDiv = document.getElementById('console');
  if (isProcessing) return;
  document.getElementById('fetchButton').disabled = true;
  try {
    if (isNaN(maxComments) || maxComments < 1 || maxComments > 10000) {
      const p = document.createElement('p');
      p.textContent = `${new Date().toLocaleTimeString()}: Error: Please enter a number between 1 and 10,000`;
      consoleDiv.appendChild(p);
      consoleDiv.scrollTop = consoleDiv.scrollHeight;
      return; 
    }
    if (afterCommentFilter && !afterCommentInput) {
      const p = document.createElement('p');
      p.textContent = `${new Date().toLocaleTimeString()}: Error: Please enter a comment ID`;
      consoleDiv.appendChild(p);
      consoleDiv.scrollTop = consoleDiv.scrollHeight;
      document.getElementById('afterCommentFilter').checked = false;
      return;
    }
    commentCount = 0;
    allComments = [];
    filteredComments = [];
    document.getElementById('comments').innerHTML = '';
    document.getElementById('exportButton').disabled = true;
    const response = await browser.runtime.sendMessage({
      action: 'fetchComments',
      maxComments: maxComments,
      afterCommentId: afterCommentFilter ? afterCommentInput : null
    });
    if (response && !response.success && response.error) {
      throw new Error(response.error);
    }
  } catch (err) {
    console.error('Failed to fetch comments:', err.message);
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Error fetching comments: ${err.message}`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  } finally {
    document.getElementById('fetchButton').disabled = false;
  }
});

document.getElementById('subredditFilter').addEventListener('change', async () => {
  const subredditFilter = document.getElementById('subredditFilter').checked;
  const subredditInput = document.getElementById('subredditInput').value.trim();
  const consoleDiv = document.getElementById('console');

  if (subredditFilter && !subredditInput) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Error: Please enter a subreddit name`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    document.getElementById('subredditFilter').checked = false;
    return;
  }

  if (subredditFilter) {
    try {
      await checkSubredditExists(subredditInput);
      applySubredditFilter(subredditInput);
      updateDisplayedComments();
      const p = document.createElement('p');
      p.textContent = `${new Date().toLocaleTimeString()}: Filtered comments to r/${subredditInput}`;
      consoleDiv.appendChild(p);
      consoleDiv.scrollTop = consoleDiv.scrollHeight;
    } catch (error) {
      const p = document.createElement('p');
      p.textContent = `${new Date().toLocaleTimeString()}: Error: Invalid or inaccessible subreddit - ${error.message}`;
      consoleDiv.appendChild(p);
      consoleDiv.scrollTop = consoleDiv.scrollHeight;
      document.getElementById('subredditFilter').checked = false;
      filteredComments = allComments;
      updateDisplayedComments();
    }
  } else {
    filteredComments = allComments;
    updateDisplayedComments();
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Removed subreddit filter`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  }
});

document.getElementById('subredditInput').addEventListener('input', async () => {
  const subredditFilter = document.getElementById('subredditFilter').checked;
  const subredditInput = document.getElementById('subredditInput').value.trim();
  const consoleDiv = document.getElementById('console');

  if (!subredditFilter || !subredditInput) {
    filteredComments = allComments;
    updateDisplayedComments();
    return;
  }

  try {
    await checkSubredditExists(subredditInput);
    applySubredditFilter(subredditInput);
    updateDisplayedComments();
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Filtered comments to r/${subredditInput}`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  } catch (error) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Error: Invalid or inaccessible subreddit - ${error.message}`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    filteredComments = allComments;
    updateDisplayedComments();
  }
});

document.getElementById('exportButton').addEventListener('click', () => {
  const subredditFilter = document.getElementById('subredditFilter').checked;
  const subredditInput = document.getElementById('subredditInput').value.trim();
  const commentsToExport = subredditFilter && subredditInput ? filteredComments : allComments;
  exportComments(commentsToExport, `reddit_comments`);
});

document.getElementById('loadCommentByIdButton').addEventListener('click', async () => {
  const commentIdInput = document.getElementById('commentIdInput');
  const commentId = commentIdInput.value.trim();
  const consoleDiv = document.getElementById('console');
  const exportButton = document.getElementById('exportButton');

  if (isProcessing) return;
  document.getElementById('loadCommentByIdButton').disabled = true;

  try {
    if (!commentId) {
      const p = document.createElement('p');
      p.textContent = `${new Date().toLocaleTimeString()}: Error: Please enter a comment ID`;
      consoleDiv.appendChild(p);
      consoleDiv.scrollTop = consoleDiv.scrollHeight;
      return;
    }
	
    const response = await browser.runtime.sendMessage({
      action: 'fetchCommentById',
      commentId: commentId
    });
	
    console.log("Received response from background:", response);
    
    if (response && response.success) {
      exportButton.disabled = false;
    } else {
      throw new Error(response?.error || 'Unknown error occurred');
    }
  } catch (err) {
    console.error('Failed to fetch comment by ID:', err.message);
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Error fetching comment ID ${commentId}: ${err.message}`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  } finally {
    document.getElementById('loadCommentByIdButton').disabled = false;
  }
});

document.getElementById('dangerousActionsConfirm').addEventListener('change', () => {
  const randomizeAllButton = document.getElementById('randomizeAllButton');
  const editAllButton = document.getElementById('editAllButton');
  const isChecked = document.getElementById('dangerousActionsConfirm').checked;
  randomizeAllButton.disabled = !isChecked;
  editAllButton.disabled = !isChecked;
});

document.getElementById('stopButton').addEventListener('click', () => {
  if (isProcessing && abortController) {
    abortController.abort();
    const consoleDiv = document.getElementById('console');
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Mass operation stopped by user`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    isProcessing = false;
    abortController = null;
    document.getElementById('stopButton').disabled = true;
    document.getElementById('randomizeAllButton').disabled = !document.getElementById('dangerousActionsConfirm').checked;
    document.getElementById('editAllButton').disabled = !document.getElementById('dangerousActionsConfirm').checked;
  }
});

document.getElementById('randomizeAllButton').addEventListener('click', async () => {
  const consoleDiv = document.getElementById('console');
  const subredditFilter = document.getElementById('subredditFilter').checked;
  const subredditInput = document.getElementById('subredditInput').value.trim();
  const commentsToRandomize = (subredditFilter && subredditInput ? filteredComments : allComments)
    .filter(comment => !comment.isSaved);
	
  if (!document.getElementById('dangerousActionsConfirm').checked) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Error: Please confirm you understand the risks of dangerous actions`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    return;
  }

  if (commentsToRandomize.length === 0) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: No eligible comments to randomize`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    return;
  }

  const confirmRandomize = window.confirm(`Are you sure you want to randomize all ${commentsToRandomize.length} loaded comments?`);
  if (!confirmRandomize) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Mass randomization cancelled`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    return;
  }

  // Export backup
  const backupSuccess = exportComments(commentsToRandomize, `reddit_comments_backup`);
  if (!backupSuccess) return;

  // Wait for download to "complete" (approximation)
  await new Promise(resolve => setTimeout(resolve, 1000));

  const confirmBackup = window.confirm(`Do you confirm that you have a valid backup and wish to proceed?`);
  if (!confirmBackup) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Mass randomization cancelled - backup not confirmed`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    return;
  }

  isProcessing = true;
  abortController = new AbortController();
  const stopButton = document.getElementById('stopButton');
  const randomizeAllButton = document.getElementById('randomizeAllButton');
  const editAllButton = document.getElementById('editAllButton');
  stopButton.disabled = false;
  randomizeAllButton.disabled = true;
  editAllButton.disabled = true;

  const pStart = document.createElement('p');
  pStart.textContent = `${new Date().toLocaleTimeString()}: Starting mass randomization of ${commentsToRandomize.length} comments`;
  consoleDiv.appendChild(pStart);
  consoleDiv.scrollTop = consoleDiv.scrollHeight;

  try {
    // Check token validity once before starting
    const tokenResponse = await browser.runtime.sendMessage({ action: 'checkToken' });
    console.log("Token response:", JSON.stringify(tokenResponse));
    if (!tokenResponse || !tokenResponse.valid || !tokenResponse.accessToken) {
      throw new Error('Invalid or expired authentication token');
    }
    const accessToken = tokenResponse.accessToken;

    for (let i = 0; i < commentsToRandomize.length; i++) {
      if (abortController.signal.aborted) {
        throw new Error('Mass randomization stopped by user');
      }
      const comment = commentsToRandomize[i];
      const commentDiv = document.querySelector(`.comment[data-comment-id="${comment.id}"]`);
      const commentBody = commentDiv ? commentDiv.querySelector('.comment-body') : null;
      const originalComment = comment.body;
	  
      try {
		  
        const randomizedText = await randomizeComment(originalComment);
        // Send to Reddit first
        const editResponse = await browser.runtime.sendMessage({
          action: 'editComment',
          commentId: comment.id,
          newText: randomizedText,
          accessToken: accessToken
        });
        console.log("editComment response for", comment.id, ":", JSON.stringify(editResponse));
        if (!editResponse.success) {
          throw new Error(editResponse.error || `Failed to update comment ${comment.id} on Reddit`);
        }
        // Update UI and storage only on success
        if (commentBody) {
          commentBody.textContent = randomizedText;
        }
        const allComment = allComments.find(c => c.id === comment.id);
        if (allComment) {
          allComment.body = randomizedText;
        }
        const filteredComment = filteredComments.find(c => c.id === comment.id);
        if (filteredComment) {
          filteredComment.body = randomizedText;
        }
        const p = document.createElement('p');
        p.textContent = `${new Date().toLocaleTimeString()}: Randomized and updated comment ID: ${comment.id} (${i + 1}/${commentsToRandomize.length})`;
        consoleDiv.appendChild(p);
        consoleDiv.scrollTop = consoleDiv.scrollHeight;
        // Rate limit delay (2000ms for safety)
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        const p = document.createElement('p');
        p.textContent = `${new Date().toLocaleTimeString()}: Error randomizing comment ID: ${comment.id} - ${error.message}`;
        consoleDiv.appendChild(p);
        consoleDiv.scrollTop = consoleDiv.scrollHeight;
      }
    }
    const pDone = document.createElement('p');
    pDone.textContent = `${new Date().toLocaleTimeString()}: Mass randomization completed`;
    consoleDiv.appendChild(pDone);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  } catch (error) {
    const pError = document.createElement('p');
    pError.textContent = `${new Date().toLocaleTimeString()}: ${error.message}`;
    consoleDiv.appendChild(pError);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  } finally {
    isProcessing = false;
    abortController = null;
    stopButton.disabled = true;
    const isConfirmed = document.getElementById('dangerousActionsConfirm').checked;
    randomizeAllButton.disabled = !isConfirmed;
    editAllButton.disabled = !isConfirmed;
  }
});

document.getElementById('editAllButton').addEventListener('click', async () => {
  const consoleDiv = document.getElementById('console');
  const subredditFilter = document.getElementById('subredditFilter').checked;
  const subredditInput = document.getElementById('subredditInput').value.trim();
  const searchInput = document.getElementById('searchInput').value;
  const replaceInput = document.getElementById('replaceInput').value;
  const caseSensitive = document.getElementById('caseSensitiveCheck').checked;
  const wholeWords = document.getElementById('wholeWordsCheck').checked;
  
  if (!document.getElementById('dangerousActionsConfirm').checked) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Error: Please confirm you understand the risks of dangerous actions`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    return;
  }

  if (!searchInput.trim()) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Error: Please enter text to search for`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    return;
  }

  // Find eligible comments first
  const sourceComments = subredditFilter && subredditInput ? filteredComments : allComments;
  const pSearching = document.createElement('p');
  pSearching.textContent = `${new Date().toLocaleTimeString()}: Searching for comments containing "${searchInput}"...`;
  consoleDiv.appendChild(pSearching);
  consoleDiv.scrollTop = consoleDiv.scrollHeight;

  const commentsToEdit = findCommentsForReplacement(sourceComments, searchInput, caseSensitive, wholeWords);

  if (commentsToEdit.length === 0) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: No eligible comments found containing "${searchInput}"`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    return;
  }

  const pFound = document.createElement('p');
  pFound.textContent = `${new Date().toLocaleTimeString()}: Found ${commentsToEdit.length} comments containing "${searchInput}"`;
  consoleDiv.appendChild(pFound);
  consoleDiv.scrollTop = consoleDiv.scrollHeight;

  const confirmEdit = window.confirm(`Are you sure you want to edit ${commentsToEdit.length} comments, replacing "${searchInput}" with "${replaceInput}"?`);
  if (!confirmEdit) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Mass edit cancelled`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    return;
  }

  // Export backup of only comments that will be edited
  const backupSuccess = exportComments(commentsToEdit, `reddit_comments_edit_backup`);
  if (!backupSuccess) return;

  // Wait for download to "complete" (approximation)
  await new Promise(resolve => setTimeout(resolve, 1000));

  const confirmBackup = window.confirm(`Do you confirm that you have a valid backup and wish to proceed with editing ${commentsToEdit.length} comments?`);
  if (!confirmBackup) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Mass edit cancelled - backup not confirmed`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    return;
  }

  isProcessing = true;
  abortController = new AbortController();
  const stopButton = document.getElementById('stopButton');
  const randomizeAllButton = document.getElementById('randomizeAllButton');
  const editAllButton = document.getElementById('editAllButton');
  stopButton.disabled = false;
  randomizeAllButton.disabled = true;
  editAllButton.disabled = true;

  const pStart = document.createElement('p');
  pStart.textContent = `${new Date().toLocaleTimeString()}: Starting mass edit of ${commentsToEdit.length} comments`;
  consoleDiv.appendChild(pStart);
  consoleDiv.scrollTop = consoleDiv.scrollHeight;

  try {
    // Check token validity once before starting
    const tokenResponse = await browser.runtime.sendMessage({ action: 'checkToken' });
    console.log("Token response:", JSON.stringify(tokenResponse));
    if (!tokenResponse || !tokenResponse.valid || !tokenResponse.accessToken) {
      throw new Error('Invalid or expired authentication token');
    }
    const accessToken = tokenResponse.accessToken;

    for (let i = 0; i < commentsToEdit.length; i++) {
      if (abortController.signal.aborted) {
        throw new Error('Mass edit stopped by user');
      }
      const comment = commentsToEdit[i];
      const commentDiv = document.querySelector(`.comment[data-comment-id="${comment.id}"]`);
      const commentBody = commentDiv ? commentDiv.querySelector('.comment-body') : null;
      const originalComment = comment.body;
	  
      try {
        const editedText = performSearchReplace(originalComment, searchInput, replaceInput, caseSensitive, wholeWords);
        
        // Only proceed if the text actually changed
        if (editedText === originalComment) {
          const p = document.createElement('p');
          p.textContent = `${new Date().toLocaleTimeString()}: Skipped comment ID: ${comment.id} - no changes needed (${i + 1}/${commentsToEdit.length})`;
          consoleDiv.appendChild(p);
          consoleDiv.scrollTop = consoleDiv.scrollHeight;
          continue;
        }
        
        // Send to Reddit first
        const editResponse = await browser.runtime.sendMessage({
          action: 'editComment',
          commentId: comment.id,
          newText: editedText,
          accessToken: accessToken
        });
        console.log("editComment response for", comment.id, ":", JSON.stringify(editResponse));
        if (!editResponse.success) {
          throw new Error(editResponse.error || `Failed to update comment ${comment.id} on Reddit`);
        }
        // Update UI and storage only on success
        if (commentBody) {
          commentBody.textContent = editedText;
        }
        const allComment = allComments.find(c => c.id === comment.id);
        if (allComment) {
          allComment.body = editedText;
        }
        const filteredComment = filteredComments.find(c => c.id === comment.id);
        if (filteredComment) {
          filteredComment.body = editedText;
        }
        const p = document.createElement('p');
        p.textContent = `${new Date().toLocaleTimeString()}: Edited and updated comment ID: ${comment.id} (${i + 1}/${commentsToEdit.length})`;
        consoleDiv.appendChild(p);
        consoleDiv.scrollTop = consoleDiv.scrollHeight;
        // Rate limit delay (2000ms for safety)
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        const p = document.createElement('p');
        p.textContent = `${new Date().toLocaleTimeString()}: Error editing comment ID: ${comment.id} - ${error.message}`;
        consoleDiv.appendChild(p);
        consoleDiv.scrollTop = consoleDiv.scrollHeight;
      }
    }
    const pDone = document.createElement('p');
    pDone.textContent = `${new Date().toLocaleTimeString()}: Mass edit completed`;
    consoleDiv.appendChild(pDone);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  } catch (error) {
    const pError = document.createElement('p');
    pError.textContent = `${new Date().toLocaleTimeString()}: ${error.message}`;
    consoleDiv.appendChild(pError);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  } finally {
    isProcessing = false;
    abortController = null;
    stopButton.disabled = true;
    const isConfirmed = document.getElementById('dangerousActionsConfirm').checked;
    randomizeAllButton.disabled = !isConfirmed;
    editAllButton.disabled = !isConfirmed;
  }
});