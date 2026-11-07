(async () => {
  const heading = document.querySelector('h1');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // 1. Only allow download when the current tab URL contains "ep="
    if (!tab?.url || !tab.url.includes('ep=')) {
      heading.textContent = 'Blocked: URL must contain "ep="';
      return;
    }

    const urlObj = new URL(tab.url);
    const epNumber = urlObj.searchParams.get('ep') || 'unknown';
    heading.textContent = `Scanning ep=${epNumber} for Vimeo...`;

    // 2. Dynamically scan all frames (main page + Vimeo iframe) for the Vimeo & VTT links
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        let vimeoPageUrl = null;
        const iframe = document.querySelector('iframe[src*="vimeo.com"]');
        if (iframe) vimeoPageUrl = iframe.src;
        if (location.hostname.includes('vimeo.com')) vimeoPageUrl = location.href;

        // Method A: Find active <track> element in DOM
        const track = document.querySelector(
          '.vp-telecine track[kind="subtitles"], video track[src*=".vtt"], track[src]'
        );
        if (track && track.src) {
          return {
            vttUrl: track.src,
            id: track.id || 'captions',
            srclang: track.srclang || 'subtitles',
            vimeoUrl: vimeoPageUrl
          };
        }

        // Method B: Check network resource logs for any loaded .vtt URL
        const resources = performance.getEntriesByType('resource');
        const vttEntry = resources.find(
          r => r.name.includes('captions.vimeo.com') || r.name.includes('.vtt')
        );
        if (vttEntry) {
          return {
            vttUrl: vttEntry.name,
            id: 'vimeo-track',
            srclang: 'subtitles',
            vimeoUrl: vimeoPageUrl
          };
        }

        // Method C: Extract VTT URL from Vimeo's embedded JSON config (works even if CC is off)
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const s of scripts) {
          const text = s.textContent || '';
          if (text.includes('"text_tracks"')) {
            const match = text.match(/"text_tracks"\s*:\s*(\[\{.*?\}\])/);
            if (match) {
              try {
                const tracks = JSON.parse(match[1]);
                if (tracks.length > 0 && tracks[0].url) {
                  const fullUrl = new URL(tracks[0].url, location.origin).href;
                  return {
                    vttUrl: fullUrl,
                    id: `track-${tracks[0].id || 'vimeo'}`,
                    srclang: tracks[0].lang || 'subtitles',
                    vimeoUrl: vimeoPageUrl
                  };
                }
              } catch (e) {}
            }
          }
        }

        return vimeoPageUrl ? { vttUrl: null, vimeoUrl: vimeoPageUrl } : null;
      }
    });

    // Find the frame that returned a valid VTT caption URL
    const foundTrack = results.find(r => r.result?.vttUrl)?.result;
    const foundVimeo = results.find(r => r.result?.vimeoUrl)?.result;

    if (!foundTrack) {
      heading.textContent = foundVimeo
        ? 'Vimeo player found, but no captions loaded yet. Click Play/CC on the video first.'
        : 'No Vimeo video found on this page.';
      return;
    }

    // 3. Fetch the dynamically discovered .vtt URL
    heading.textContent = 'Fetching captions...';
    const response = await fetch(foundTrack.vttUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const vttText = await response.text();

    // 4. Clean VTT timestamps into readable text
    const plainText = vttText
      .replace(/^WEBVTT.*$/gm, '')
      .replace(/^\d+$/gm, '')
      .replace(/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}.*$/gm, '')
      .replace(/^\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}\.\d{3}.*$/gm, '')
      .replace(/<[^>]+>/g, '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .join('\n');

    // 5. Save to .txt file
    const blob = new Blob([plainText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ep${epNumber}_${foundTrack.id}_${foundTrack.srclang}.txt`;
    a.click();
    URL.revokeObjectURL(url);

    heading.textContent = `Saved ep=${epNumber} to TXT!`;
  } catch (err) {
    heading.textContent = 'Error: ' + err.message;
  }
})();