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

// Get a random word or digit with exact length, preserving case or type
function getRandomWord(word) {
  const length = word.length;
  
  // Handle single characters
  if (length === 1) {
    const char = word[0];
    if (/\d/.test(char)) {
      // Generate random digit for single digit
      return Math.floor(Math.random() * 10).toString();
    } else if (/[a-zA-Z]/.test(char)) {
      // Generate random letter preserving case
      const isUpper = char === char.toUpperCase();
      const randomLetter = String.fromCharCode(97 + Math.floor(Math.random() * 26)); // a-z
      return isUpper ? randomLetter.toUpperCase() : randomLetter;
    } else {
      // Non-alphanumeric single character, return as-is
      return char;
    }
  }
  
  // Handle multi-character words
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

// Randomize digits in a string
function randomizeDigits(text) {
	return text.replace(/\d/g, () => Math.floor(Math.random() * 10).toString());
}

// Randomize a comment's text
async function randomizeComment(text) {
  if (!wordListLoaded) {
    await loadWordList();
  }
  // Split text into words, digits, and other characters
  return text
    .split(/([0-9]+|[a-zA-Z]+|[^0-9a-zA-Z]+)/)
    .map(part => {
      if (/^[a-zA-Z]+$/.test(part)) {
        // Replace words with random words of the same length
        return getRandomWord(part);
      } else if (/^[0-9]+$/.test(part)) {
        // Replace digits with random digits of the same length
        return randomizeDigits(part);
      }
      // Preserve non-alphanumeric characters
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
  
  // Clear existing content
  while (commentsDiv.firstChild) {
    commentsDiv.removeChild(commentsDiv.firstChild);
  }
  
  // Create elements using DOM methods
  displayComments.forEach(comment => {
    const commentDiv = document.createElement('div');
    commentDiv.className = 'comment';
    commentDiv.setAttribute('data-comment-id', comment.id);

    // Create comment header and posted date
    const headerDiv = document.createElement('div');
    headerDiv.style.display = 'flex';
    headerDiv.style.justifyContent = 'space-between';
    headerDiv.style.marginBottom = '5px';

    const headerStrong = document.createElement('strong');
    headerStrong.textContent = `Comment #${comment.index} (ID: ${comment.id})`;
    headerDiv.appendChild(headerStrong);

    const postedSpan = document.createElement('span');
    postedSpan.textContent = `Posted: ${comment.created}`;
    postedSpan.style.marginLeft = 'auto';
    headerDiv.appendChild(postedSpan);
    commentDiv.appendChild(headerDiv);

    // Create subreddit info and votes
    const subredditVotesDiv = document.createElement('div');
    subredditVotesDiv.style.display = 'flex';
    subredditVotesDiv.style.justifyContent = 'space-between';
    subredditVotesDiv.style.marginBottom = '5px';

    const subredditStrong = document.createElement('strong');
    subredditStrong.textContent = 'Subreddit:';
    const subredditText = document.createTextNode(` ${comment.subreddit}`);
    subredditVotesDiv.appendChild(subredditStrong);
    subredditVotesDiv.appendChild(subredditText);

    if (typeof comment.votes !== 'undefined') {
      const votesSpan = document.createElement('span');
      votesSpan.style.marginLeft = 'auto';
      const votesStrong = document.createElement('strong');
      votesStrong.textContent = 'Votes:';
      votesSpan.appendChild(votesStrong);
      votesSpan.appendChild(document.createTextNode(` ${comment.votes}`));
      subredditVotesDiv.appendChild(votesSpan);
    }
    commentDiv.appendChild(subredditVotesDiv);

    // Add post title if available
    if (comment.post_title) {
      const postTitleStrong = document.createElement('strong');
      postTitleStrong.textContent = 'Post:';
      commentDiv.appendChild(postTitleStrong);
      
      const postTitleText = document.createTextNode(` ${comment.post_title}`);
      commentDiv.appendChild(postTitleText);
      commentDiv.appendChild(document.createElement('br'));
    }

    // Create comment body
    const commentBodyP = document.createElement('p');
    commentBodyP.className = 'comment-body';
    parseRedditMarkdown(comment.body, commentBodyP);
    commentDiv.appendChild(commentBodyP);

    // Add saved label or randomize button
    if (comment.isSaved) {
      const savedSpan = document.createElement('span');
      savedSpan.className = 'saved-label';
      savedSpan.textContent = 'Saved';
      commentDiv.appendChild(savedSpan);
    } else {
      const randomizeBtn = document.createElement('button');
      randomizeBtn.className = 'randomizeButton';
      randomizeBtn.textContent = 'Randomize';
      commentDiv.appendChild(randomizeBtn);
    }

    commentsDiv.appendChild(commentDiv);
  });

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

// HTML-to-markdown conversion function
function convertHtmlToRedditMarkdown(html) {
  if (!html || typeof html !== 'string') return html;
  
  // Don't convert if it doesn't look like HTML
  if (!html.includes('<') || !html.includes('>')) {
    return html;
  }
  
  let text = html;
  
  // Convert common HTML elements to Reddit markdown
  // Blockquotes
  text = text.replace(/<blockquote>\s*<p>\s*(.*?)\s*<\/p>\s*<\/blockquote>/gs, (match, content) => {
    return content.split('\n').map(line => line.trim() ? `&gt; ${line.trim()}` : '').join('\n');
  });
  text = text.replace(/<blockquote>\s*(.*?)\s*<\/blockquote>/gs, (match, content) => {
    return content.split('\n').map(line => line.trim() ? `&gt; ${line.trim()}` : '').join('\n');
  });
  
  // Paragraphs - convert to double newlines
  text = text.replace(/<\/p>\s*<p>/g, '\n\n');
  text = text.replace(/<p\s*[^>]*>/g, '');
  text = text.replace(/<\/p>/g, '\n\n');
  
  // Line breaks
  text = text.replace(/<br\s*\/?>/g, '\n');
  
  // Bold text
  text = text.replace(/<(strong|b)(\s[^>]*)?>(.*?)<\/(strong|b)>/gs, '**$3**');
  
  // Italic text
  text = text.replace(/<(em|i)(\s[^>]*)?>(.*?)<\/(em|i)>/gs, '*$3*');
  
  // Links
  text = text.replace(/<a\s+[^>]*href=['"]([^'"]*)['"][^>]*>(.*?)<\/a>/gs, '[$2]($1)');
  
  // Code blocks
  text = text.replace(/<pre(\s[^>]*)?><code(\s[^>]*)?>(.*?)<\/code><\/pre>/gs, (match, p1, p2, code) => {
    return '\n\n    ' + code.replace(/\n/g, '\n    ') + '\n\n';
  });
  
  // Inline code
  text = text.replace(/<code(\s[^>]*)?>(.*?)<\/code>/gs, '`$2`');
  
  // Lists
  text = text.replace(/<ul(\s[^>]*)?>(.*?)<\/ul>/gs, (match, attrs, content) => {
    return content.replace(/<li(\s[^>]*)?>(.*?)<\/li>/gs, '* $2\n');
  });
  text = text.replace(/<ol(\s[^>]*)?>(.*?)<\/ol>/gs, (match, attrs, content) => {
    let counter = 1;
    return content.replace(/<li(\s[^>]*)?>(.*?)<\/li>/gs, () => `${counter++}. $2\n`);
  });
  
  // Remove remaining HTML tags
  text = text.replace(/<[^>]*>/g, '');
  
  // Clean up whitespace
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n'); // Multiple newlines to double
  text = text.replace(/^\s+|\s+$/g, ''); // Trim
  
  // Decode HTML entities
  const entityMap = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&#39;': "'",
    '&nbsp;': ' '
  };
  text = text.replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (match, entity) => {
    return entityMap[`&${entity};`] || match;
  });
  
  return text;
}

// Function to escape HTML characters to prevent XSS (excluding single quotes)
function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Function to decode HTML entities (e.g., &gt; to >)
function decodeHtmlEntities(text) {
    const entities = {
        '&gt;': '>',
        '&lt;': '<',
        '&amp;': '&',
        '&quot;': '"',
        '&#039;': "'",
        '&apos;': "'"
    };
    return text.replace(/&gt;|&lt;|&amp;|&quot;|&#039;|&apos;/g, match => entities[match]);
}

// Function to create a text node with escaped content
function createSafeTextNode(text) {
    // Decode entities first, then escape only what's needed for safety
    const decodedText = decodeHtmlEntities(text);
    return document.createTextNode(decodedText);
}

// Function to parse inline Markdown and append to a parent element
function parseInlineMarkdown(text, parentElement) {
    let currentText = decodeHtmlEntities(text);
    let index = 0;
    let currentNode = parentElement;

    while (index < currentText.length) {
        // Handle spoilers (>!text!<)
        const spoilerMatch = currentText.slice(index).match(/^>!(.+?)!</);
        if (spoilerMatch) {
            const spoilerText = spoilerMatch[1];
            const spoilerSpan = document.createElement('span');
            spoilerSpan.className = 'spoiler';
            spoilerSpan.appendChild(createSafeTextNode(spoilerText));
            currentNode.appendChild(spoilerSpan);
            index += spoilerMatch[0].length;
            continue;
        }

        // Handle bold (**text**)
        const boldMatch = currentText.slice(index).match(/^\*\*([^\*]+)\*\*/);
        if (boldMatch) {
            const boldText = boldMatch[1];
            const boldElement = document.createElement('strong');
            boldElement.appendChild(createSafeTextNode(boldText));
            currentNode.appendChild(boldElement);
            index += boldMatch[0].length;
            continue;
        }

        // Handle italic (*text*)
        const italicMatch = currentText.slice(index).match(/^\*([^\*]+)\*/);
        if (italicMatch) {
            const italicText = italicMatch[1];
            const italicElement = document.createElement('em');
            italicElement.appendChild(createSafeTextNode(italicText));
            currentNode.appendChild(italicElement);
            index += italicMatch[0].length;
            continue;
        }

        // Handle links ([text](url))
        const linkMatch = currentText.slice(index).match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/);
        if (linkMatch) {
            const linkText = linkMatch[1];
            const linkUrl = linkMatch[2];
            const linkElement = document.createElement('a');
            linkElement.href = linkUrl;
            linkElement.appendChild(createSafeTextNode(linkText));
            currentNode.appendChild(linkElement);
            index += linkMatch[0].length;
            continue;
        }

        // Handle plain text
        const nextMatch = currentText.slice(index).search(/>!|\*\*|\*|\[.*?\]\(/);
        const endIndex = nextMatch === -1 ? currentText.length : index + nextMatch;
        if (endIndex > index) {
            const plainText = currentText.slice(index, endIndex);
            currentNode.appendChild(createSafeTextNode(plainText));
            index = endIndex;
        } else {
            index++;
        }
    }
}

// Function to parse Reddit Markdown and build DOM structure
function parseRedditMarkdown(text, parentElement) {
    const lines = decodeHtmlEntities(text).split('\n');
    let inList = false;
    let inBlockquote = false;
    let currentList = null;
    let currentBlockquote = null;

    for (let line of lines) {
        line = line.trim();
        if (!line) {
            if (inList) {
                parentElement.appendChild(currentList);
                inList = false;
                currentList = null;
            }
            if (inBlockquote) {
                parentElement.appendChild(currentBlockquote);
                inBlockquote = false;
                currentBlockquote = null;
            }
            const p = document.createElement('p');
            parentElement.appendChild(p);
            continue;
        }

        // Handle blockquotes
        if (line.startsWith('>')) {
            if (!inBlockquote) {
                currentBlockquote = document.createElement('blockquote');
                inBlockquote = true;
            }
            line = line.slice(1).trim();
            const p = document.createElement('p');
            parseInlineMarkdown(line, p);
            currentBlockquote.appendChild(p);
            continue;
        } else if (inBlockquote) {
            parentElement.appendChild(currentBlockquote);
            inBlockquote = false;
            currentBlockquote = null;
        }

        // Handle lists
        if (line.match(/^[-*]\s/)) {
            if (!inList) {
                currentList = document.createElement('ul');
                inList = true;
            }
            line = line.replace(/^[-*]\s/, '');
            const li = document.createElement('li');
            parseInlineMarkdown(line, li);
            currentList.appendChild(li);
            continue;
        } else if (inList) {
            parentElement.appendChild(currentList);
            inList = false;
            currentList = null;
        }

        // Handle paragraphs
        const p = document.createElement('p');
        parseInlineMarkdown(line, p);
        parentElement.appendChild(p);
    }

    // Close any open elements
    if (inList && currentList) {
        parentElement.appendChild(currentList);
    }
    if (inBlockquote && currentBlockquote) {
        parentElement.appendChild(currentBlockquote);
    }
}

// Export comments to JSON file
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

// Load comments from a JSON file 
async function loadJsonComments() {
  const fileInput = document.getElementById('fileInput');
  const file = fileInput.files[0];
  const consoleDiv = document.getElementById('console');
  const exportButton = document.getElementById('exportButton');

  if (!file) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Error: No file selected`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    return;
  }

  if (!file.name.toLowerCase().endsWith('.json')) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Error: Please select a JSON file`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
    return;
  }

  try {
    const text = await file.text();
    const jsonData = JSON.parse(text);
    
    // Ensure it's an array
    const comments = Array.isArray(jsonData) ? jsonData : [jsonData];
    
    // Validate and normalize comment structure
    const normalizedComments = comments.map((comment, index) => {
      if (!comment.id || !comment.body) {
        throw new Error(`Invalid comment structure at index ${index}: missing id or body`);
      }
      
      return {
        id: comment.id,
        body: convertHtmlToRedditMarkdown(comment.body),
        subreddit: comment.subreddit || 'unknown',
        created: comment.created || 'Unknown date',
        created_utc: comment.created_utc || 0,
        index: comment.index || (index + 1),
        isSaved: comment.isSaved || false,
        post_id: comment.post_id,
        post_title: comment.post_title,
        votes: comment.votes
      };
    });

    // Clear existing comments and add new ones
    allComments = normalizedComments;
    filteredComments = allComments;
    updateDisplayedComments();
    exportButton.disabled = false;

    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Successfully loaded ${normalizedComments.length} comments from JSON file`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;

  } catch (error) {
    const p = document.createElement('p');
    p.textContent = `${new Date().toLocaleTimeString()}: Error loading JSON file: ${error.message}`;
    consoleDiv.appendChild(p);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
  }
}

// Update API request counter display
function updateApiRequestCounter() {
  const apiCounterDiv = document.getElementById('apiRequestCounter');
  apiCounterDiv.textContent = `API Requests Made: ${apiRequestCount}`;
}

// Update CLIENT_ID status display
async function updateClientIdStatus() {
  try {
    const result = await browser.runtime.sendMessage({
      action: 'getCurrentClientId'
    });
    
    if (result.success) {
      const clientIdStatusDiv = document.getElementById('clientIdStatus');
      if (clientIdStatusDiv) {
        const statusText = result.isDefault 
          ? 'CLIENT_ID: Default'
          : `CLIENT_ID: Custom (${result.preview})`;
        clientIdStatusDiv.textContent = statusText;
      }
    }
  } catch (error) {
    console.error('Failed to update CLIENT_ID status:', error.message);
    const statusDiv = document.getElementById('clientIdStatus');
    if (statusDiv) {
      statusDiv.textContent = 'CLIENT_ID: Error loading';
    }
  }
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
    
	const commentsDiv = document.getElementById('comments');
	// Clear existing content
	while (commentsDiv.firstChild) {
		commentsDiv.removeChild(commentsDiv.firstChild);
	}
	// Create error element
	const errorP = document.createElement('p');
	errorP.className = 'error';
	errorP.textContent = `Error: ${message.error}`; // Safe text assignment
	commentsDiv.appendChild(errorP);

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
  } else if (message.action === 'updateClientIdStatus') {
	console.log("Received updateClientIdStatus message:", message);
    const clientIdStatusDiv = document.getElementById('clientIdStatus');
    if (clientIdStatusDiv) {
      const statusText = message.isDefault 
        ? 'CLIENT_ID: Default'
        : `CLIENT_ID: Custom (${message.preview})`;
      clientIdStatusDiv.textContent = statusText;
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
      afterCommentId: afterCommentFilter ? afterCommentInput : null,
      includeMetadata: true
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
      commentId: commentId,
      includeMetadata: true
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

// Show CLIENT_ID popup
function showClientIdPopup() {
  const overlay = document.createElement('div');
  overlay.className = 'popup-overlay';
  
  const popup = document.createElement('div');
  popup.className = 'popup-content';
  
  const title = document.createElement('h3');
  title.textContent = 'Set Custom CLIENT_ID';
  
  const description = document.createElement('p');
  description.textContent = 'Enter your custom Reddit app CLIENT_ID. Leave empty to use default.';
  description.style.marginBottom = '15px';
  description.style.fontSize = '14px';
  description.style.color = '#666';
  
  const label = document.createElement('label');
  label.textContent = 'CLIENT_ID:';
  
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Enter CLIENT_ID (e.g., ABC123def456...)';
  input.style.fontFamily = 'monospace';
  
  const buttonContainer = document.createElement('div');
  buttonContainer.className = 'popup-buttons';
  
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'confirm-btn';
  confirmBtn.textContent = 'Confirm';
  
  const defaultBtn = document.createElement('button');
  defaultBtn.className = 'default-btn';
  defaultBtn.textContent = 'Use Default';
  
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'cancel-btn';
  cancelBtn.textContent = 'Cancel';
  
  // Event listeners
  confirmBtn.addEventListener('click', async () => {
    const newClientId = input.value.trim();
    if (!newClientId) {
      alert('Please enter a CLIENT_ID');
      return;
    }
    
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Testing...';
    
    try {
      const result = await browser.runtime.sendMessage({
        action: 'setCustomClientId',
        clientId: newClientId
      });
      
      if (result.success) {
        updateClientIdStatus();
        document.body.removeChild(overlay);
        
        // Show warning if present
        if (result.warning) {
          const consoleDiv = document.getElementById('console');
          const p = document.createElement('p');
          p.textContent = `${new Date().toLocaleTimeString()}: Warning: ${result.warning}`;
          consoleDiv.appendChild(p);
          consoleDiv.scrollTop = consoleDiv.scrollHeight;
        }
      } else {
        alert(`Failed to set CLIENT_ID: ${result.error}`);
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Confirm';
      }
    } catch (error) {
      alert(`Error: ${error.message}`);
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirm';
    }
  });
  
  defaultBtn.addEventListener('click', async () => {
    try {
      const result = await browser.runtime.sendMessage({
        action: 'resetToDefaultClientId'
      });
      
      if (result.success) {
        updateClientIdStatus();
        document.body.removeChild(overlay);
      }
    } catch (error) {
      alert(`Error: ${error.message}`);
    }
  });
  
  cancelBtn.addEventListener('click', () => {
    document.body.removeChild(overlay);
  });
  
  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      document.body.removeChild(overlay);
    }
  });
  
  // Assemble popup
  buttonContainer.appendChild(confirmBtn);
  buttonContainer.appendChild(defaultBtn);
  buttonContainer.appendChild(cancelBtn);
  
  popup.appendChild(title);
  popup.appendChild(description);
  popup.appendChild(label);
  popup.appendChild(input);
  popup.appendChild(buttonContainer);
  
  overlay.appendChild(popup);
  document.body.appendChild(overlay);
  
  // Focus input
  input.focus();
}

document.getElementById('setClientIdButton').addEventListener('click', () => {
  showClientIdPopup();
});

// Event listener for Load JSON button
document.getElementById('loadJsonButton').addEventListener('click', loadJsonComments);

// Enable/disable Convert/Load buttons based on file selection
document.getElementById('fileInput').addEventListener('change', function() {
    const convertButton = document.getElementById('convertToJsonButton');
    const loadJsonButton = document.getElementById('loadJsonButton');
    const hasFile = this.files.length > 0;
    const fileName = hasFile ? this.files[0].name.toLowerCase() : '';
    
    // Enable Convert button for HTML/TXT files
    convertButton.disabled = !hasFile || (!fileName.endsWith('.html') && !fileName.endsWith('.txt'));
    
    // Enable Load JSON button for JSON files
    loadJsonButton.disabled = !hasFile || !fileName.endsWith('.json');
});