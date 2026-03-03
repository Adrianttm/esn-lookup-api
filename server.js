const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

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

async function getCumminsSession() {
  const now = Date.now();
  if (cachedCookies && cachedXsrfToken && now < sessionExpiry) {
    return { cookies: cachedCookies, xsrfToken: cachedXsrfToken };
  }

  console.log('[Session] Fetching new Cummins public session...');
  const res = await fetch('https://parts.cummins.com/gateway/auth/login/publicUser', {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (!res.ok) {
    throw new Error('Cummins auth failed with status ' + res.status);
  }

  const setCookies = res.headers.raw()['set-cookie'] || [];
  const cookieString = setCookies.map(c => c.split(';')[0]).join('; ');

  let xsrfToken = null;
  for (const cookie of setCookies) {
    const match = cookie.match(/XSRF-TOKEN=([^;]+)/);
    if (match) {
      xsrfToken = decodeURIComponent(match[1]);
      break;
    }
  }

  if (!xsrfToken) {
    throw new Error('Could not extract XSRF token from Cummins session');
  }

  cachedCookies = cookieString;
  cachedXsrfToken = xsrfToken;
  sessionExpiry = now + 30 * 60 * 1000;

  console.log('[Session] New session established.');
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
      cachedCookies = null;
      cachedXsrfToken = null;
      sessionExpiry = 0;
      session = await getCumminsSession();
    }

    const dataplateUrl = 'https://parts.cummins.com/gateway/api/IACDataServices/v2/esnInfo/' + esn + '/dataplate?esnType=mbom';

    const dataplateRes = await fetch(dataplateUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-XSRF-TOKEN': session.xsrfToken,
        'Cookie': session.cookies,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (dataplateRes.status === 403) {
      console.log('[Lookup] Got 403, refreshing session...');
      cachedCookies = null;
      cachedXsrfToken = null;
      sessionExpiry = 0;
      const freshSession = await getCumminsSession();

      const retryRes = await fetch(dataplateUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'X-XSRF-TOKEN': freshSession.xsrfToken,
          'Cookie': freshSession.cookies,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (!retryRes.ok) {
        throw new Error('Cummins API returned ' + retryRes.status + ' after session refresh');
      }

      const retryData = await retryRes.json();
      return res.json(formatResponse(retryData, esn));
    }

    if (!dataplateRes.ok) {
      throw new Error('Cummins API returned ' + dataplateRes.status);
    }

    const data = await dataplateRes.json();
    return res.json(formatResponse(data, esn));

  } catch (err) {
    console.error('[Lookup] Error:', err.message);
    return res.status(502).json({
      error: 'Unable to retrieve engine information. Please try again in a moment.'
    });
  }
});

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

app.listen(PORT, () => {
  console.log('ESN Lookup API running on port ' + PORT);
});
