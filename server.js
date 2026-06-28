const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS: Allow your Shopify domain
app.use(cors({
  origin: [
    'https://texastruckmarket.com',
    'https://www.texastruckmarket.com',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ],
  methods: ['GET'],
}));

app.use(express.json());

// Session cache
let cachedCookies = null;
let cachedXsrfToken = null;
let sessionExpiry = 0;
let browser = null;

// Launch or reuse a persistent browser instance
async function getBrowser() {
  if (browser && browser.isConnected()) {
    return browser;
  }
  console.log('[Browser] Launching new Chromium instance...');
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions'
    ]
  });
  console.log('[Browser] Chromium launched successfully.');
  return browser;
}

// Use a real browser to visit parts.cummins.com and get valid session cookies
async function getCumminsSession() {
  const now = Date.now();

  if (cachedCookies && cachedXsrfToken && now < sessionExpiry) {
    return { cookies: cachedCookies, xsrfToken: cachedXsrfToken };
  }

  console.log('[Session] Getting new Cummins session via headless browser...');

  const br = await getBrowser();
  const page = await br.newPage();

  try {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    console.log('[Session] Navigating to parts.cummins.com...');
    await page.goto('https://parts.cummins.com', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    console.log('[Session] Page loaded. Extracting cookies...');

    const cookies = await page.cookies();
    console.log('[Session] Total cookies:', cookies.length);

    let cookieString = cookies.map(c => c.name + '=' + c.value).join('; ');

    let xsrfToken = null;
    for (const cookie of cookies) {
      if (cookie.name === 'XSRF-TOKEN') {
        xsrfToken = decodeURIComponent(cookie.value);
        break;
      }
    }

    if (!xsrfToken || xsrfToken.length < 10) {
      console.log('[Session] No XSRF from page load, trying publicUser API...');

      const authResponse = await page.evaluate(async () => {
        const res = await fetch('/gateway/auth/login/publicUser', {
          method: 'GET',
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        return { status: res.status, ok: res.ok };
      });

      console.log('[Session] publicUser response:', authResponse.status);

      const updatedCookies = await page.cookies();
      cookieString = updatedCookies.map(c => c.name + '=' + c.value).join('; ');

      for (const cookie of updatedCookies) {
        if (cookie.name === 'XSRF-TOKEN' && cookie.value.length > 10) {
          xsrfToken = decodeURIComponent(cookie.value);
          break;
        }
      }

      if (!xsrfToken || xsrfToken.length < 10) {
        console.log('[Session] Cookie names:', updatedCookies.map(c => c.name + '=' + c.value.substring(0, 20)).join(', '));
        throw new Error('Could not get valid XSRF token from Cummins');
      }
    }

    cachedCookies = cookieString;
    cachedXsrfToken = xsrfToken;
    sessionExpiry = now + 25 * 60 * 1000;

    console.log('[Session] Session established! XSRF token length:', xsrfToken.length);
    return { cookies: cachedCookies, xsrfToken: cachedXsrfToken };

  } finally {
    await page.close();
  }
}

// Helper: make HTTPS request with session cookies
function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: headers
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.end();
  });
}

// ESN Lookup endpoint
app.get('/api/lookup/:esn', async (req, res) => {
  const { esn } = req.params;

  if (!/^\d{7,10}$/.test(esn)) {
    return res.status(400).json({
      error: 'Invalid ESN format. Please enter a 7-10 digit Engine Serial Number.'
    });
  }

  try {
    let session;
    try {
      session = await getCumminsSession();
    } catch (err) {
      console.log('[Lookup] First session attempt failed:', err.message);
      cachedCookies = null;
      cachedXsrfToken = null;
      sessionExpiry = 0;
      session = await getCumminsSession();
    }

    const dataplateUrl = 'https://parts.cummins.com/gateway/api/IACDataServices/v2/esnInfo/' + esn + '/dataplate?esnType=mbom';

    console.log('[Lookup] Calling dataplate API for ESN:', esn);

    const dataplateRes = await httpsGet(dataplateUrl, {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Referer': 'https://parts.cummins.com/',
      'Origin': 'https://parts.cummins.com',
      'X-XSRF-TOKEN': session.xsrfToken,
      'Cookie': session.cookies
    });

    console.log('[Lookup] Dataplate response status:', dataplateRes.status);

    if (dataplateRes.status === 403) {
      console.log('[Lookup] Got 403, refreshing session...');
      cachedCookies = null;
      cachedXsrfToken = null;
      sessionExpiry = 0;
      const freshSession = await getCumminsSession();

      const retryRes = await httpsGet(dataplateUrl, {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://parts.cummins.com/',
        'Origin': 'https://parts.cummins.com',
        'X-XSRF-TOKEN': freshSession.xsrfToken,
        'Cookie': freshSession.cookies
      });

      console.log('[Lookup] Retry response status:', retryRes.status);

      if (retryRes.status !== 200) {
        throw new Error('Cummins API returned ' + retryRes.status + ' after session refresh');
      }

      const retryData = JSON.parse(retryRes.body);
      return res.json(formatResponse(retryData, esn));
    }

    if (dataplateRes.status !== 200) {
      console.log('[Lookup] Response body:', dataplateRes.body.substring(0, 300));
      throw new Error('Cummins API returned ' + dataplateRes.status);
    }

    const data = JSON.parse(dataplateRes.body);
    return res.json(formatResponse(data, esn));

  } catch (err) {
    console.error('[Lookup] Error:', err.message);
    return res.status(502).json({
      error: 'Unable to retrieve engine information. Please try again in a moment.'
    });
  }
});

// Format the response
function formatResponse(data, esn) {
  const engine = Array.isArray(data) ? data[0] : data;

  if (!engine || !engine.cplNo) {
    return { error: 'No engine data found for ESN ' + esn + '. Please verify the number and try again.' };
  }

  const smn = engine.smn || '';
  const cmMatch = smn.match(/CM\d+/i);
  const cm = cmMatch ? cmMatch[0] : 'N/A';

  return {
    esn: esn,
    cpl: engine.cplNo,
    cm: cm,
    serviceModelName: smn,
    marketingModelName: engine.marketingModelName || 'N/A'
  };
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'esn-lookup-api', browser: browser ? 'running' : 'not started' });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Server] Shutting down...');
  if (browser) await browser.close();
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log('ESN Lookup API running on port ' + PORT);
});
