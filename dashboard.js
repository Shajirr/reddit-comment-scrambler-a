let commentCount = 0;
let allComments = []; // Store all fetched comments
let filteredComments = []; // Store filtered comments for display and actions
let safeWordsByLength = {};
let wordListLoaded = false;

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

// Check if subreddit exists
async function checkSubredditExists(subreddit) {
  try {
    const response = await fetch(`https://www.reddit.com/r/${subreddit}/about.json`, {
      method: 'GET',
      headers: { 'User-Agent': 'RedditCommentFetcher/1.0' }
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
    console.error('Subreddit check error:', error.message);
    throw error;
  }
}

// Apply subreddit filter to comments
function applySubredditFilter(subreddit) {
  const subredditLower = subreddit.toLowerCase();
  filteredComments = allComments.filter(comment => comment.subreddit.toLowerCase() === subredditLower);
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
        <button class="randomizeButton">Randomize</button>
      </div>
    `)
    .join('');
  commentsDiv.innerHTML = html;

  // Reattach randomize button listeners
  document.querySelectorAll('.randomizeButton').forEach(button => {
    button.addEventListener('click', async () => {
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
        await browser.runtime.sendMessage({
          action: 'editComment',
          commentId: commentId,
          newText: randomizedText
        });
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

document.getElementById('fetchButton').addEventListener('click', async () => {
  const commentCountInput = document.getElementById('commentCount');
  const maxComments = parseInt(commentCountInput.value);
  const consoleDiv = document.getElementById('console');
  const afterCommentFilter = document.getElementById('afterCommentFilter').checked;
  const afterCommentInput = document.getElementById('afterCommentInput').value.trim();

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
  browser.runtime.sendMessage({
    action: 'fetchComments',
    maxComments: maxComments,
    afterCommentId: afterCommentFilter ? afterCommentInput : null
  }).catch(err => {
    console.error('Failed to send fetch comments message:', err.message);
  });
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
  const consoleDiv = document.getElementById('console');

  if (commentsToExport.length === 0) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: No comments to export`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    return;
  }
  const json = JSON.stringify(commentsToExport, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `reddit_comments_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  const p = document.createElement('p');
  p.textContent = `${new Date().toLocaleTimeString()}: Exported ${commentsToExport.length} comments${subredditFilter && subredditInput ? ` from r/${subredditInput}` : ''}`;
  consoleDiv.appendChild(p);
  consoleDiv.scrollTop = consoleDiv.scrollHeight;
});

document.getElementById('loadCommentByIdButton').addEventListener('click', () => {
  const commentIdInput = document.getElementById('commentIdInput');
  const commentId = commentIdInput.value.trim();
  const consoleDiv = document.getElementById('console');
  if (!commentId) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Error: Please enter a valid comment ID`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    return;
  }
  browser.runtime.sendMessage({
    action: 'fetchCommentById',
    commentId: commentId
  }).catch(err => {
    console.error('Failed to send fetch comment by ID message:', err.message);
  });
});