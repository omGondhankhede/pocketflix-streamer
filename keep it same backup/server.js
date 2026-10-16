const http = require('http');
const fs = require('fs');
const { URL } = require('url');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const PORT = 80;
let activeFfmpeg = null;

const XOR_KEY = 'nexus-super-secret-';

function decryptNexusHex(hexStr) {
  if (!hexStr || typeof hexStr !== 'string') return null;
  if (hexStr.startsWith('http')) return hexStr;

  try {
    const buf = Buffer.from(hexStr, 'hex');
    let out = '';
    for (let i = 0; i < buf.length; i++) {
      out += String.fromCharCode(buf[i] ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
    }
    return out.trim();
  } catch (e) {
    console.log(`RAW DECRYPT ERROR EXCEPTION:`, e);
    return null;
  }
}

function isCleanUrl(str) {
  if (!str) return false;
  try {
    const u = new URL(str);
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) && !str.includes('{') && !str.includes(';');
  } catch (e) {
    return false;
  }
}

async function getStealthStreamData(tmdbId, type = 'movie', season = 1, episode = 1) {
  let targetEmbed = type === 'tv'
    ? `https://moviesnexus.fun/tv/${tmdbId}/${season}/${episode}`
    : `https://moviesnexus.fun/movie/${tmdbId}`;

  console.log(`\n🕵️‍♂️ [STEALTH SNIFFER] Launching master browser for MoviesNexus: ${targetEmbed}`);
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-gpu',
        '--disable-web-security', 
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio'
      ]
    });
    
    let resolvedStream = null; 
    let apiPayloadServers = [];
    let fallbackReferer = 'https://moviesnexus.fun/';

    const initPage = await browser.newPage();
    await initPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    initPage.on('response', async (response) => {
      const respUrl = response.url();
      if (respUrl.includes('/api/extract')) {
        try {
          const json = await response.json();
          if (json.servers && json.servers.length > 0) {
            apiPayloadServers = json.servers;
          }
        } catch (e) {}
      }
    });

    await initPage.goto(targetEmbed, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    await initPage.close().catch(() => {});

    for (let w = 0; w < 6; w++) {
      if (apiPayloadServers.length > 0) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    if (apiPayloadServers.length === 0) {
      await browser.close();
      return null;
    }

    console.log(`\n🔄 [SERVER ITERATION START]: Testing ${apiPayloadServers.length} servers for video & Hindi audio streams...`);

    for (let index = 0; index < apiPayloadServers.length; index++) {
      if (resolvedStream) break;
      const serverObj = apiPayloadServers[index];
      
      console.log(`\n----------------------------------------`);
      console.log(`⚙️ [TRYING SERVER ${index + 1}/${apiPayloadServers.length}]: ${serverObj.name}`);

      let decryptedHindiAudio = null;
      if (serverObj.audioTracks && serverObj.audioTracks.length > 0) {
        const hindiTrack = serverObj.audioTracks.find(tr => tr.label && tr.label.toLowerCase().includes('hindi'));
        if (hindiTrack && hindiTrack.url) {
          decryptedHindiAudio = decryptNexusHex(hindiTrack.url);
          if (isCleanUrl(decryptedHindiAudio)) {
            console.log(`🎵 [HINDI AUDIO TRACK FOUND]: ${decryptedHindiAudio}`);
          } else {
            decryptedHindiAudio = null;
          }
        }
      }

      const rawDecrypted = decryptNexusHex(serverObj.url);
      if (rawDecrypted && isCleanUrl(rawDecrypted)) {
        resolvedStream = {
          url: rawDecrypted,
          audioUrl: decryptedHindiAudio,
          referer: (serverObj.headers && serverObj.headers.Referer) ? serverObj.headers.Referer : 'https://moviesnexus.fun/'
        };
        break;
      }

      let serverSuccess = false;
      let attempt = 0;
      const maxAttempts = 2;

      while (!serverSuccess && attempt < maxAttempts && !resolvedStream) {
        attempt++;
        const isolatedPage = await browser.newPage();
        await isolatedPage.setViewport({ width: 1280, height: 720 });
        await isolatedPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        isolatedPage.on('request', (req) => {
          const reqUrl = req.url();
          const rType = req.resourceType();
          if ((rType === 'media' || rType === 'fetch' || rType === 'xhr') && 
              (reqUrl.includes('.m3u8') || reqUrl.includes('.mp4') || reqUrl.includes('manifest') || reqUrl.includes('videoplayback'))) {
            if (!reqUrl.includes('googlesyndication') && !reqUrl.includes('analytics') && !reqUrl.includes('ads')) {
              if (!resolvedStream && (reqUrl.includes('.m3u8') || reqUrl.includes('.mp4'))) {
                const ref = req.headers()['referer'] || 'https://moviesnexus.fun/';
                resolvedStream = { url: reqUrl, audioUrl: decryptedHindiAudio, referer: ref };
                serverSuccess = true;
                console.log(`🎯 [SNIFFED STREAM WITH MUX TARGET]: ${reqUrl}`);
              }
            }
          }
        });

        try {
          fallbackReferer = (serverObj.headers && serverObj.headers.Referer) ? serverObj.headers.Referer : 'https://moviesnexus.fun/';
          await isolatedPage.goto(targetEmbed, { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

          await isolatedPage.evaluate((serverName) => {
            const elements = Array.from(document.querySelectorAll('*'));
            const target = elements.find(el => el.children.length === 0 && el.textContent.trim().toLowerCase() === serverName.toLowerCase());
            if (target) {
              target.click();
            } else {
              const partial = elements.find(el => el.children.length === 0 && el.textContent.trim().toLowerCase().includes(serverName.toLowerCase()));
              if (partial) partial.click();
            }
          }, serverObj.name);

          for (let t = 0; t < 5; t++) {
            if (resolvedStream) break;

            const hasErrorScreen = await isolatedPage.evaluate(() => {
              const errorKeywords = ['not found', 'error loading', 'video unavailable', 'removed', 'deleted', 'offline', 'err_'];
              const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
              return errorKeywords.some(keyword => bodyText.includes(keyword) && bodyText.length < 500);
            }).catch(() => false);

            if (hasErrorScreen) break;

            await isolatedPage.mouse.click(640, 360).catch(() => {});
            for (const frame of isolatedPage.frames()) {
              await frame.evaluate(() => {
                document.querySelectorAll('video').forEach(v => { v.muted = true; v.play().catch(() => {}); });
                document.querySelectorAll('button, div[class*="play"], div[class*="icon"]').forEach(el => el.click());
              }).catch(() => {});
            }
            await new Promise(r => setTimeout(r, 1000));
          }
        } catch (err) {}

        await isolatedPage.close().catch(() => {});
      }
    }

    await browser.close();
    return resolvedStream;
  } catch (err) {
    console.log(`❌ [FATAL ERROR]:`, err);
    if (browser) await browser.close();
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    fs.readFile('index.html', (err, data) => {
      res.writeHead(err ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(err ? 'Missing index.html' : data);
    });
    return;
  }

  if (pathname === '/api/get-stream') {
    const tmdbId = parsedUrl.searchParams.get('id');
    const type = parsedUrl.searchParams.get('type') || 'movie';
    const season = parsedUrl.searchParams.get('season') || 1;
    const episode = parsedUrl.searchParams.get('episode') || 1;

    if (!tmdbId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing ID' }));
    }

    const streamData = await getStealthStreamData(tmdbId, type, season, episode);
    if (streamData && streamData.url) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        url: streamData.url,
        audioUrl: streamData.audioUrl || null,
        referer: streamData.referer
      }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Could not resolve stream' }));
    }
    return;
  }

  if (pathname === '/stream') {
    const targetUrl = parsedUrl.searchParams.get('url');
    const audioUrl = parsedUrl.searchParams.get('audioUrl');
    if (!targetUrl) {
      res.writeHead(400);
      return res.end('Missing url parameter');
    }

    let referer = parsedUrl.searchParams.get('referer') || 'https://moviesnexus.fun/';

    if (activeFfmpeg) {
      try { activeFfmpeg.kill('SIGKILL'); } catch (e) {}
      activeFfmpeg = null;
    }

    console.log(`\n🎬 [PERSISTENT STREAM] Video: ${targetUrl}`);
    if (audioUrl) console.log(`🎵 [MUXING HINDI AUDIO]: ${audioUrl}`);

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    let ffmpegArgs = [
      '-headers', `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36\r\nReferer: ${referer}\r\n`,
      '-i', targetUrl
    ];

    if (audioUrl) {
      ffmpegArgs.push(
        '-headers', `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36\r\nReferer: ${referer}\r\n`,
        '-i', audioUrl,
        '-map', '0:v:0',
        '-map', '1:a:0'
      );
    } else {
      ffmpegArgs.push('-map', '0:v:0', '-map', '0:a:0?');
    }

    ffmpegArgs.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+dash',
      'pipe:1'
    );

    const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
    activeFfmpeg = ffmpeg;

    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on('data', (d) => {
      const s = d.toString();
      if (s.includes('frame=')) {
        process.stdout.write(`\r⚡ [STREAMING] ${s.trim().slice(0, 75)}`);
      }
    });

    req.on('close', () => {
      console.log('\n🛑 [CLIENT DISCONNECTED]');
      try { ffmpeg.kill('SIGKILL'); } catch (e) {}
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Fully Logged Server running on port 80`);
});