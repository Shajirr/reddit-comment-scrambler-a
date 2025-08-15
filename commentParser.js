function parseRedditComments() {
    const fileInput = document.getElementById('fileInput');
    const statusDiv = document.getElementById('fileImportStatus');
    const convertButton = document.getElementById('convertToJsonButton');
    const file = fileInput.files[0];

    if (!file) {
        statusDiv.textContent = 'Please select an HTML or TXT file.';
        return;
    }

    // Get input filename and replace extension with .json
    const outputFilename = file.name.replace(/\.[^/.]+$/, '.json');
    statusDiv.textContent = 'Processing...';
    convertButton.disabled = true;

    const reader = new FileReader();
    reader.onload = function(event) {
        try {
            const htmlContent = event.target.result;
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlContent, 'text/html');

            const comments = [];
            const commentUnits = doc.querySelectorAll('div[data-testid="search-sdui-comment-unit"]');

            commentUnits.forEach((unit, index) => {
                try {
                    // Extract post title
                    const postTitleElement = unit.querySelector('h2.i18n-search-comment-post-title');
                    const postTitle = postTitleElement ? postTitleElement.textContent.trim() : '';

                    // Extract post ID and subreddit from search-telemetry-tracker
                    const postData = unit.querySelector('search-telemetry-tracker[data-faceplate-tracking-context]');
                    let postId = '';
                    let subredditName = '';
                    if (postData) {
                        const postDataJson = JSON.parse(postData.getAttribute('data-faceplate-tracking-context') || '{}');
                        postId = postDataJson.post?.id?.replace('t3_', '') || '';
                        subredditName = postDataJson.subreddit?.name || '';
                    }

                    // Extract comment ID
                    const commentContentDiv = unit.querySelector('div[id^="search-comment-t1_"]');
                    const commentId = commentContentDiv ? commentContentDiv.id.replace('search-comment-t1_', '').replace('-post-rtjson-content', '') : '';

                    // Extract comment body
                    const commentBodyElement = unit.querySelector('div[id^="search-comment-t1_"]');
                    const commentBody = commentBodyElement ? commentBodyElement.innerHTML.trim() : '';

                    // Extract timestamp
                    const timeElement = unit.querySelector('faceplate-timeago time');
                    let created = '';
                    let createdUtc = 0;
                    if (timeElement) {
                        const date = new Date(timeElement.getAttribute('datetime'));
						if (!isNaN(date)) {
							// Format as DD/MM/YYYY, HH:MM:SS
							created = date.toLocaleString('en-GB', {
								day: '2-digit',
								month: '2-digit',
								year: 'numeric',
								hour: '2-digit',
								minute: '2-digit',
								second: '2-digit',
								hour12: false
							}).replace(',', '');
							// Unix timestamp in seconds
							createdUtc = Math.floor(date.getTime() / 1000);
						}
                    }

                    // Extract votes
                    const votesElement = unit.querySelector('p.text-neutral-content-weak span faceplate-number');
                    const votes = votesElement ? parseInt(votesElement.getAttribute('number')) || 0 : 0;

                    // Create comment object
                    const comment = {
                        id: commentId,
                        body: commentBody,
                        subreddit: subredditName,
                        created: created,
                        created_utc: createdUtc,
                        index: index + 1,
                        post_id: postId,
                        post_title: postTitle,
                        votes: votes
                    };

                    // Add to comments array if essential fields are present
                    if (commentId && commentBody && subredditName && created && createdUtc) {
                        comments.push(comment);
                    }
                } catch (error) {
                    console.warn(`Error processing comment at index ${index}:`, error.message);
                }
            });
			
            // Check if any comments were processed
            if (comments.length === 0) {
                statusDiv.textContent = 'Invalid file: No valid comments found.';
                convertButton.disabled = false;
                return;
            }
			
            // Create and download JSON file
            const jsonContent = JSON.stringify(comments, null, 2);
            const blob = new Blob([jsonContent], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = outputFilename;
            a.click();
            URL.revokeObjectURL(url);

            // Load the generated JSON file into fileInput
            const jsonFile = new File([jsonContent], outputFilename, { type: 'application/json' });
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(jsonFile);
            fileInput.files = dataTransfer.files;

            statusDiv.textContent = `Processed ${comments.length} comments. JSON file downloaded as ${outputFilename}`;
            convertButton.disabled = false;
        } catch (error) {
            statusDiv.textContent = `Error: ${error.message}`;
            console.error('Processing error:', error);
            convertButton.disabled = false;
        }
    };
    reader.onerror = function() {
        statusDiv.textContent = 'Error reading file.';
        convertButton.disabled = false;
    };
    reader.readAsText(file);
}

// Attach event listener to Convert button
document.getElementById('convertToJsonButton').addEventListener('click', parseRedditComments);