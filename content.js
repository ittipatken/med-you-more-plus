(() => {
  const isTopFrame = window === window.top;
  let isCapturingScreenshot = false;

  function isTyping(e) {
    const el = e.target;
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || Boolean(el.isContentEditable);
  }

  function getVideoTimestamp() {
    const timecodeEl = document.querySelector('[data-progress-bar-timecode="true"]');
    if (timecodeEl && timecodeEl.textContent) {
      return timecodeEl.textContent.trim();
    }
    const video = document.querySelector('.vp-telecine video, video');
    if (video) {
      const sec = video.currentTime || 0;
      const m = Math.floor(sec / 60).toString().padStart(2, '0');
      const s = Math.floor(sec % 60).toString().padStart(2, '0');
      return `${m}:${s}`;
    }
    return '00:00';
  }

  // Send captured JPEG frame up to the MedUMore top window UI
  function sendFrameDataToTop(jpegDataUrl, width, height) {
    window.top.postMessage(
      {
        type: 'VIMEO_FRAME_CAPTURED',
        dataUrl: jpegDataUrl,
        width: width || 1280,
        height: height || 720,
        timestamp: getVideoTimestamp()
      },
      '*'
    );
  }

  // Convert a Blob or URL from Vimeo's "Screenshot frame" into a JPEG Data URL
  function processCapturedBlobOrUrl(input) {
    const url = typeof input === 'string' ? input : URL.createObjectURL(input);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || 1280;
      canvas.height = img.naturalHeight || 720;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      sendFrameDataToTop(canvas.toDataURL('image/jpeg', 0.92), canvas.width, canvas.height);
      if (typeof input !== 'string') URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  // Direct capture from Vimeo's <video crossorigin="anonymous"> element
  function captureFromVideoElement() {
    const video = document.querySelector('.vp-telecine video, video');
    if (!video || !video.videoWidth || !video.videoHeight) return false;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      sendFrameDataToTop(dataUrl, canvas.width, canvas.height);
      return true;
    } catch (err) {
      console.error('Canvas video capture error:', err);
      return false;
    }
  }

  // =========================================================================
  // INTERCEPT VIMEO'S BUILT-IN "Screenshot frame" MENU ACTION
  // =========================================================================
  const origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...args) {
    const href = this.getAttribute('href') || this.href || '';
    const isDownload = this.hasAttribute('download') || Boolean(this.download);

    if (
      (isCapturingScreenshot || isDownload) &&
      (href.startsWith('blob:') || href.startsWith('data:image'))
    ) {
      isCapturingScreenshot = false;
      processCapturedBlobOrUrl(href);
      return; // Block browser from saving individual PNG file
    }
    return origAnchorClick.apply(this, args);
  };

  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreateObjectURL.apply(this, arguments);
    if (isCapturingScreenshot && obj instanceof Blob && obj.type.startsWith('image/')) {
      isCapturingScreenshot = false;
      processCapturedBlobOrUrl(obj);
    }
    return url;
  };

  function findScreenshotMenuItem() {
    const items = document.querySelectorAll(
      '[role="menuitem"], [class*="ContextMenuOption_module_menuItem"]'
    );
    for (const item of items) {
      const text = (item.textContent || '').trim().toLowerCase();
      if (text.includes('screenshot frame')) {
        return item;
      }
    }
    return null;
  }

  function triggerVimeoScreenshot() {
    const video = document.querySelector('.vp-telecine video, video');
    const player = document.querySelector('#player, .vp-video-wrapper') || video;
    if (!player) return false;

    isCapturingScreenshot = true;

    let hideStyle = document.getElementById('vimeo-hide-ctx-style');
    if (!hideStyle && document.head) {
      hideStyle = document.createElement('style');
      hideStyle.id = 'vimeo-hide-ctx-style';
      document.head.appendChild(hideStyle);
    }
    if (hideStyle) {
      hideStyle.textContent =
        '[class*="ContextMenu_module_contextMenu"] { opacity: 0 !important; pointer-events: none !important; }';
    }

    const rect = player.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    // Dispatch PointerEvent + MouseEvent so React opens the ContextMenu
    ['pointerdown', 'mousedown', 'contextmenu'].forEach((eventType) => {
      const EvtClass = eventType.startsWith('pointer') ? PointerEvent : MouseEvent;
      player.dispatchEvent(
        new EvtClass(eventType, {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 2,
          buttons: 2,
          clientX,
          clientY
        })
      );
    });

    let attempts = 0;
    const poll = setInterval(() => {
      attempts += 1;
      const menuItem = findScreenshotMenuItem();

      if (menuItem) {
        clearInterval(poll);
        menuItem.click();

        // Close context menu and fall back to direct video frame capture if needed
        setTimeout(() => {
          if (hideStyle) hideStyle.textContent = '';
          player.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          if (isCapturingScreenshot) {
            isCapturingScreenshot = false;
            captureFromVideoElement();
          }
        }, 120);
      } else if (attempts >= 8) {
        clearInterval(poll);
        if (hideStyle) hideStyle.textContent = '';
        isCapturingScreenshot = false;
        captureFromVideoElement();
      }
    }, 15);

    return true;
  }

  // =========================================================================
  // KEYBOARD SHORTCUTS: Shift + S (Capture) and X (Remove Last)
  // =========================================================================
  window.addEventListener(
    'keydown',
    (e) => {
      if (isTyping(e)) return;

      // Shift + S -> Capture frame
      if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'KeyS') {
        e.preventDefault();
        e.stopPropagation();

        if (!triggerVimeoScreenshot()) {
          document.querySelectorAll('iframe').forEach((iframe) => {
            if (iframe.contentWindow) {
              iframe.contentWindow.postMessage({ type: 'TRIGGER_VIMEO_SCREENSHOT' }, '*');
            }
          });
        }
      }

      // X -> Remove last captured frame
      if (!e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'KeyX') {
        window.top.postMessage({ type: 'REMOVE_LAST_VIMEO_FRAME' }, '*');
      }
    },
    true
  );

  // If running inside the Vimeo iframe, listen for capture triggers from the parent page
  if (!isTopFrame) {
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'TRIGGER_VIMEO_SCREENSHOT') {
        triggerVimeoScreenshot();
      }
    });
    return;
  }

  // =========================================================================
  // TOP FRAME ONLY (medumore.org): Always-Visible Bottom-Right Dock & PDF Builder
  // =========================================================================
  const capturedFrames = [];
  let panelEl = null;
  let listEl = null;
  let countEl = null;
  let statusEl = null;
  let pdfBtn = null;

  function ensureUI() {
    if (panelEl || !document.body) return;

    panelEl = document.createElement('div');
    panelEl.id = 'medumore-vimeo-pdf-dock';
    panelEl.style.cssText = [
      'position: fixed',
      'bottom: 20px',
      'right: 20px',
      'width: 350px',
      'background: #1e1e1e',
      'color: #fff',
      'border-radius: 12px',
      'box-shadow: 0 8px 28px rgba(0,0,0,0.55)',
      'font-family: system-ui, -apple-system, sans-serif',
      'z-index: 2147483647',
      'padding: 12px',
      'display: flex',
      'flex-direction: column',
      'gap: 10px',
      'border: 1px solid #3a3a3a'
    ].join(';');

    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:6px;';

    countEl = document.createElement('strong');
    countEl.style.cssText = 'font-size:13px; flex:1;';
    countEl.textContent = 'Captured Frames (0)';

    const captureBtn = document.createElement('button');
    captureBtn.textContent = '+ Capture (Shift+S)';
    captureBtn.style.cssText =
      'background:#2d7dd2; color:#fff; border:none; padding:6px 10px; border-radius:6px; cursor:pointer; font-weight:600; font-size:11px;';
    captureBtn.addEventListener('click', () => {
      document.querySelectorAll('iframe').forEach((iframe) => {
        if (iframe.contentWindow) {
          iframe.contentWindow.postMessage({ type: 'TRIGGER_VIMEO_SCREENSHOT' }, '*');
        }
      });
    });

    pdfBtn = document.createElement('button');
    pdfBtn.textContent = 'Save to PDF';
    pdfBtn.style.cssText =
      'background:#648d2f; color:#fff; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-weight:600; font-size:11px; opacity:0.5;';
    pdfBtn.addEventListener('click', downloadFramesAsPdf);

    headerRow.appendChild(countEl);
    headerRow.appendChild(captureBtn);
    headerRow.appendChild(pdfBtn);

    statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:11px; color:#bbb;';
    statusEl.textContent = 'Press Shift+S (or click + Capture) to grab frame, X to remove';

    listEl = document.createElement('div');
    listEl.style.cssText = 'display:none; gap:8px; overflow-x:auto; padding-bottom:4px;';

    panelEl.appendChild(headerRow);
    panelEl.appendChild(statusEl);
    panelEl.appendChild(listEl);
    document.body.appendChild(panelEl);
  }

  function renderTray(message) {
    ensureUI();
    if (!panelEl) return;

    countEl.textContent = `Captured Frames (${capturedFrames.length})`;
    pdfBtn.style.opacity = capturedFrames.length === 0 ? '0.5' : '1';
    if (message) statusEl.textContent = message;

    listEl.innerHTML = '';
    if (capturedFrames.length === 0) {
      listEl.style.display = 'none';
      return;
    }

    listEl.style.display = 'flex';
    capturedFrames.forEach((frame, index) => {
      const item = document.createElement('div');
      item.style.cssText =
        'position:relative; flex-shrink:0; width:104px; height:58px; border-radius:6px; overflow:hidden; border:1px solid #555; background:#000;';

      const img = document.createElement('img');
      img.src = frame.dataUrl;
      img.style.cssText = 'width:100%; height:100%; object-fit:cover; display:block;';

      const timeTag = document.createElement('span');
      timeTag.textContent = `#${index + 1} ${frame.timestamp}`;
      timeTag.style.cssText =
        'position:absolute; bottom:2px; left:2px; background:rgba(0,0,0,0.75); color:#fff; font-size:10px; padding:1px 4px; border-radius:3px;';

      const removeBtn = document.createElement('button');
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove frame';
      removeBtn.style.cssText =
        'position:absolute; top:2px; right:2px; width:18px; height:18px; background:rgba(220,53,69,0.9); color:#fff; border:none; border-radius:50%; cursor:pointer; font-size:12px; line-height:1; display:flex; align-items:center; justify-content:center; padding:0;';
      removeBtn.addEventListener('click', () => {
        capturedFrames.splice(index, 1);
        renderTray(`Removed frame #${index + 1}`);
      });

      item.appendChild(img);
      item.appendChild(timeTag);
      item.appendChild(removeBtn);
      listEl.appendChild(item);
    });

    listEl.scrollLeft = listEl.scrollWidth;
  }

  // Mount UI dock as soon as the page DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ensureUI());
  } else {
    ensureUI();
  }

  window.addEventListener('message', (e) => {
    if (!e.data) return;

    if (e.data.type === 'VIMEO_FRAME_CAPTURED') {
      capturedFrames.push({
        dataUrl: e.data.dataUrl,
        width: e.data.width,
        height: e.data.height,
        timestamp: e.data.timestamp
      });
      renderTray(`Captured frame at ${e.data.timestamp} (Press X to undo)`);
    } else if (e.data.type === 'REMOVE_LAST_VIMEO_FRAME') {
      if (capturedFrames.length !== 0) {
        const removed = capturedFrames.pop();
        renderTray(`Removed frame at ${removed.timestamp}`);
      }
    }
  });

  function downloadFramesAsPdf() {
    if (capturedFrames.length === 0) {
      renderTray('Capture at least 1 frame before saving to PDF!');
      return;
    }

    statusEl.textContent = 'Building PDF...';
    const pdfBlob = buildPdfFromJpegs(capturedFrames);
    const ep = new URLSearchParams(window.location.search).get('ep') || 'video';

    const url = origCreateObjectURL.call(URL, pdfBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ep${ep}_screenshots.pdf`;
    document.body.appendChild(a);
    origAnchorClick.call(a);
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    statusEl.textContent = `Saved ep${ep}_screenshots.pdf!`;
  }

  function buildPdfFromJpegs(frames) {
    const encoder = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let byteLength = 0;

    const pushStr = (str) => {
      const bytes = encoder.encode(str);
      chunks.push(bytes);
      byteLength += bytes.length;
    };

    const pushBytes = (bytes) => {
      chunks.push(bytes);
      byteLength += bytes.length;
    };

    const startObj = (id) => {
      offsets[id] = byteLength;
      pushStr(`${id} 0 obj\n`);
    };

    const endObj = () => pushStr('\nendobj\n');

    pushStr('%PDF-1.4\n');

    const pageIds = [];
    let nextId = 3;

    frames.forEach((frame) => {
      const pageId = nextId++;
      const contentId = nextId++;
      const imgId = nextId++;
      pageIds.push(pageId);

      const base64 = frame.dataUrl.split(',')[1];
      const raw = atob(base64);
      const imgBytes = new Uint8Array(raw.length);
      for (let i = 0; i !== raw.length; i += 1) {
        imgBytes[i] = raw.charCodeAt(i);
      }

      const w = frame.width;
      const h = frame.height;
      const contentStr = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ`;

      startObj(pageId);
      pushStr(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${contentId} 0 R /Resources << /XObject << /Im0 ${imgId} 0 R >> >> >>`
      );
      endObj();

      startObj(contentId);
      pushStr(`<< /Length ${contentStr.length} >>\nstream\n${contentStr}\nendstream`);
      endObj();

      startObj(imgId);
      pushStr(
        `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgBytes.length} >>\nstream\n`
      );
      pushBytes(imgBytes);
      pushStr('\nendstream');
      endObj();
    });

    startObj(1);
    pushStr('<< /Type /Catalog /Pages 2 0 R >>');
    endObj();

    startObj(2);
    pushStr(
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
    );
    endObj();

    const xrefOffset = byteLength;
    pushStr(`xref\n0 ${nextId}\n0000000000 65535 f \n`);
    for (let i = 1; i !== nextId; i += 1) {
      pushStr(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
    }

    pushStr(`trailer\n<< /Size ${nextId} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

    return new Blob(chunks, { type: 'application/pdf' });
  }
})();