const express = require('express');
const cors = require('cors');
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

// Browser-like headers (no gzip to avoid decompression issues)
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://parts.cummins.com/',
  'Origin': 'https://parts.cummins.com',
  'Connection': 'keep-alive',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"'
};

// Helper: make HTTPS request (native, to get raw set-cookie)
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
        resolve({
          status: res.statusCode,
          headers: res.headers,
          rawHeaders: res.rawHeaders,
          setCookies: res.headers['set-cookie'] || [],
          body: data
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.end();
  });
}

// Session cache
let cachedCookies = null;
let cachedXsrfToken = null;
let sessionExpiry = 0;

async function getCumminsSession() {
  const now = Date.now();

  if (cachedCookies && cachedXsrfToken && now < sessionExpiry) {
    return { cookies: cachedCookies, xsrfToken: cachedXsrfToken };
  }

  console.log('[Session] Fetching new Cummins public session...');

  const res = await httpsGet('https://parts.cummins.com/gateway/auth/login/publicUser', {
    ...BROWSER_HEADERS
  });

  console.log('[Session] Auth response status:', res.status);
  console.log('[Session] Set-Cookie count:', res.setCookies.length);

  // The auth endpoint may return 401 but still set valid session cookies
  const setCookies = res.setCookies;
  const cookieString = setCookies.map(c => c.split(';')[0]).join('; ');

  console.log('[Session] Cookie string:', cookieString.substring(0, 200));

  let xsrfToken = null;
  for (const cookie of setCookies) {
    const match = cookie.match(/XSRF-TOKEN=([^;]+)/);
    if (match) {
      xsrfToken = decodeURIComponent(match[1]);
      break;
    }
  }

  if (!xsrfToken) {
    console.log('[Session] All cookies:', JSON.stringify(setCookies));
    console.log('[Session] Response body:', res.body.substring(0, 500));
    throw new Error('Could not extract XSRF token (status ' + res.status + ')');
  }

  console.log('[Session] Got XSRF token despite status', res.status);

  cachedCookies = cookieString;
  cachedXsrfToken = xsrfToken;
  sessionExpiry = now + 30 * 60 * 1000;

  console.log('[Session] New session established. XSRF token length:', xsrfToken.length);
  return { cookies: cookieString, xsrfToken };
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
      ...BROWSER_HEADERS,
      'X-XSRF-TOKEN': session.xsrfToken,
      'Cookie': session.cookies
    });

    console.log('[Lookup] Dataplate response status:', dataplateRes.status);
    console.log('[Lookup] Dataplate body preview:', dataplateRes.body.substring(0, 200));

    if (dataplateRes.status === 403) {
      console.log('[Lookup] Got 403, refreshing session...');
      cachedCookies = null;
      cachedXsrfToken = null;
      sessionExpiry = 0;
      const freshSession = await getCumminsSession();

      const retryRes = await httpsGet(dataplateUrl, {
        ...BROWSER_HEADERS,
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
  res.json({ status: 'ok', service: 'esn-lookup-api' });
});

// Start server
app.listen(PORT, () => {
  console.log('ESN Lookup API running on port ' + PORT);
});
