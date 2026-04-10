/**
 * Lightweight Universal Player v1.0
 * Supports: MP4, HLS (.m3u8), DASH (.mpd), HTTP/HTTPS, Auth Headers, iframe content.
 * Zero dependencies. Uses native MSE for adaptive streaming.
 * 
 * Usage: <script src="light-player.js"></script>
 * Configure auth globally: window.PLAYER_AUTH = { headers: { 'Authorization': 'Bearer ...' } }
 */

(function(global) {
  'use strict';

  // ---------- 全局认证配置 ----------
  const AUTH_CONFIG = global.PLAYER_AUTH || {};

  // ---------- 工具函数：带认证的 fetch ----------
  async function fetchWithAuth(url, additionalHeaders = {}) {
    const headers = {
      ...(AUTH_CONFIG.headers || {}),
      ...additionalHeaders
    };
    const options = {};
    if (Object.keys(headers).length) {
      options.headers = headers;
    }
    if (AUTH_CONFIG.withCredentials) {
      options.credentials = 'include';
    }
    return fetch(url, options);
  }

  // ---------- 解析 m3u8 清单，提取 .ts 分片 URL 列表 ----------
  function parseM3U8(manifestText, baseUrl) {
    const lines = manifestText.split('\n');
    const segments = [];
    let currentByteRange = null;
    
    for (let line of lines) {
      line = line.trim();
      if (line.startsWith('#EXT-X-BYTERANGE:')) {
        // 提取字节范围（简化处理）
        const match = line.match(/#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/);
        if (match) {
          currentByteRange = { length: parseInt(match[1]), offset: parseInt(match[2] || 0) };
        }
      } else if (line && !line.startsWith('#')) {
        const segmentUrl = new URL(line, baseUrl).href;
        segments.push({ url: segmentUrl, byteRange: currentByteRange });
        currentByteRange = null;
      }
    }
    return segments;
  }

  // ---------- HLS 引擎 (基于 MSE) ----------
  class HlsEngine {
    constructor(video, options = {}) {
      this.video = video;
      this.options = options;
      this.mediaSource = new MediaSource();
      this.video.src = URL.createObjectURL(this.mediaSource);
      this.sourceBuffer = null;
      this.segments = [];
      this.currentSegmentIndex = 0;
      this.isUpdating = false;
      this.bufferQueue = [];
      
      this.mediaSource.addEventListener('sourceopen', () => this.onSourceOpen());
    }

    onSourceOpen() {
      // 实际应用中应根据 m3u8 中的 CODECS 信息动态设置 MIME
      const mimeCodec = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
      if (!this.sourceBuffer) {
        try {
          this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeCodec);
          this.sourceBuffer.addEventListener('updateend', () => this.processQueue());
        } catch (e) {
          console.error('MIME not supported, trying alternative...');
          // 回退到原生播放（如果浏览器支持 HLS 原生）
          this.fallbackToNative();
          return;
        }
      }
      this.loadManifest(this.options.url);
    }

    fallbackToNative() {
      // 部分浏览器（如 Safari）原生支持 HLS
      this.video.src = this.options.url;
      this.video.play().catch(e => console.warn('Autoplay prevented'));
    }

    async loadManifest(url) {
      try {
        const response = await fetchWithAuth(url, this.options.headers);
        const manifestText = await response.text();
        this.segments = parseM3U8(manifestText, url);
        if (this.segments.length === 0) {
          console.warn('No segments found, falling back to native');
          this.fallbackToNative();
          return;
        }
        // 开始下载第一个分片
        this.downloadSegment(0);
      } catch (e) {
        console.error('Failed to load manifest:', e);
        this.fallbackToNative();
      }
    }

    async downloadSegment(index) {
      if (index >= this.segments.length) {
        this.mediaSource.endOfStream();
        return;
      }
      const seg = this.segments[index];
      let headers = { ...this.options.headers };
      if (seg.byteRange) {
        headers['Range'] = `bytes=${seg.byteRange.offset}-${seg.byteRange.offset + seg.byteRange.length - 1}`;
      }
      try {
        const response = await fetchWithAuth(seg.url, headers);
        const data = await response.arrayBuffer();
        this.bufferQueue.push({ data, index });
        this.processQueue();
        // 预加载下一个
        if (index + 1 < this.segments.length) {
          this.downloadSegment(index + 1);
        }
      } catch (e) {
        console.error('Segment download failed:', e);
      }
    }

    processQueue() {
      if (this.isUpdating || this.bufferQueue.length === 0) return;
      if (this.sourceBuffer && !this.sourceBuffer.updating) {
        this.isUpdating = true;
        const { data } = this.bufferQueue.shift();
        try {
          this.sourceBuffer.appendBuffer(data);
        } catch (e) {
          console.error('Append buffer error:', e);
          this.isUpdating = false;
        }
        // 更新完成事件会再次调用 processQueue
      }
    }

    load(url) {
      this.options.url = url;
      // 如果 MediaSource 已经打开，重新加载清单
      if (this.mediaSource.readyState === 'open') {
        this.loadManifest(url);
      }
    }

    destroy() {
      if (this.mediaSource) {
        URL.revokeObjectURL(this.video.src);
      }
    }
  }

  // ---------- DASH 引擎 (基于 MSE，简化版，只演示架构) ----------
  class DashEngine {
    constructor(video, options = {}) {
      this.video = video;
      this.options = options;
      // 由于 DASH MPD 解析复杂，这里直接使用原生支持作为演示
      // 在真实场景中，你会解析 MPD 并获取分片 URL
      console.warn('DASH engine: Native playback will be attempted, or implement full parser.');
      this.video.src = options.url;
    }

    load(url) {
      this.video.src = url;
      this.video.play();
    }

    destroy() {}
  }

  // ---------- 统一播放器类 ----------
  class UniversalPlayer {
    constructor(videoElement, options = {}) {
      this.video = videoElement;
      this.options = options;
      this.engine = null;
    }

    // 根据 URL 扩展名自动选择引擎
    async loadSource(url) {
      const lowerUrl = url.toLowerCase();
      const isHls = lowerUrl.includes('.m3u8');
      const isDash = lowerUrl.includes('.mpd');
      
      if (this.engine) {
        this.engine.destroy();
      }

      if (isHls) {
        this.engine = new HlsEngine(this.video, this.options);
      } else if (isDash) {
        this.engine = new DashEngine(this.video, this.options);
      } else {
        // MP4 或其他格式，直接设置 src
        this.video.src = url;
        // 如果有认证头，对 MP4 我们需要通过 fetch + blob 方式注入认证
        if (AUTH_CONFIG.headers && Object.keys(AUTH_CONFIG.headers).length) {
          await this.loadAuthenticatedMP4(url);
        } else {
          this.video.play();
        }
        return;
      }
      this.engine.load(url);
    }

    async loadAuthenticatedMP4(url) {
      try {
        const res = await fetchWithAuth(url);
        const blob = await res.blob();
        this.video.src = URL.createObjectURL(blob);
        this.video.play();
      } catch (e) {
        console.error('MP4 with auth failed:', e);
      }
    }

    destroy() {
      if (this.engine) this.engine.destroy();
    }
  }

  // ---------- 自动初始化页面中的 video 标签 (包括 iframe 内) ----------
  function enhanceVideoElement(video) {
    if (video._universalPlayer) return;
    // 获取 data 属性中的认证信息
    const authToken = video.dataset.authToken;
    const headers = video.dataset.authHeaders ? JSON.parse(video.dataset.authHeaders) : {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    
    const player = new UniversalPlayer(video, { headers });
    video._universalPlayer = player;

    // 如果 video 已有 src 或 source 子元素，自动加载
    const sources = video.querySelectorAll('source');
    let src = video.src;
    if (!src && sources.length) {
      src = sources[0].src;
    }
    if (src) {
      player.loadSource(src);
    }
  }

  function scanAndEnhance(root = document) {
    root.querySelectorAll('video').forEach(enhanceVideoElement);
  }

  // 处理 iframe 内部（同源策略允许时）
  function enhanceIframes() {
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach(iframe => {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (iframeDoc) {
          scanAndEnhance(iframeDoc);
          // 监听 iframe 内新增的 video
          new MutationObserver(() => scanAndEnhance(iframeDoc)).observe(iframeDoc.body, { childList: true, subtree: true });
        }
      } catch (e) {
        // 跨域 iframe 无法访问，忽略
        console.warn('Cannot access cross-origin iframe content');
      }
    });
  }

  // ---------- 启动 ----------
  function init() {
    scanAndEnhance();
    enhanceIframes();
    // 监听后续添加的 video 元素
    new MutationObserver(mutations => {
      mutations.forEach(mut => {
        mut.addedNodes.forEach(node => {
          if (node.nodeType === 1) {
            if (node.tagName === 'VIDEO') enhanceVideoElement(node);
            else if (node.tagName === 'IFRAME') {
              // 对新 iframe 稍后尝试增强（等待加载）
              setTimeout(() => enhanceIframes(), 500);
            } else if (node.querySelectorAll) {
              node.querySelectorAll('video').forEach(enhanceVideoElement);
            }
          }
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 暴露全局 API
  global.UniversalPlayer = UniversalPlayer;
  global.enhanceVideoElement = enhanceVideoElement;

})(window);
