const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { OAuth2Client } = require('google-auth-library');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/gmail.modify', // readonly + the ability to change labels (mark read) — not send/delete
];

// A second (or third...) Gmail account only ever needs mail — asking for
// Calendar/Drive access it'll never use just makes the consent screen wider
// and the account harder to justify if anyone ever looks at what this app
// can touch.
const GMAIL_ONLY_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials.json');

/**
 * 'primary' is the original single-account identity (Calendar+Drive+Gmail,
 * `token.json`, unchanged filename for compatibility with accounts that
 * already exist). Any other key is a mail-only secondary account, saved as
 * `token-<key>.json` — see addMailAccount/listMailAccountKeys below for how
 * those keys get created and tracked.
 */
function getTokenPath(userDataDir, accountKey) {
  return path.join(userDataDir, accountKey === 'primary' ? 'token.json' : `token-${accountKey}.json`);
}

function scopesFor(accountKey) {
  return accountKey === 'primary' ? SCOPES : GMAIL_ONLY_SCOPES;
}

function getMailAccountsRegistryPath(userDataDir) {
  return path.join(userDataDir, 'mail-accounts.json');
}

/** Every secondary (non-primary) mail account key that's been added, in the order they were added. */
function listMailAccountKeys(userDataDir) {
  try {
    const raw = fs.readFileSync(getMailAccountsRegistryPath(userDataDir), 'utf-8');
    return JSON.parse(raw).accounts || [];
  } catch (_) {
    return [];
  }
}

function saveMailAccountKeys(userDataDir, keys) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(getMailAccountsRegistryPath(userDataDir), JSON.stringify({ accounts: keys }, null, 2));
}

function loadCredentials() {
  const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  return parsed.installed || parsed.web;
}

function createOAuthClient() {
  const { client_id, client_secret } = loadCredentials();
  // Loopback redirect: actual port is chosen at runtime and passed to authorize().
  return new OAuth2Client(client_id, client_secret);
}

/**
 * Runs the installed-app loopback OAuth flow: spins up a temporary local
 * server on a random port, opens the consent URL, and captures the
 * redirect containing the auth code.
 */
function runLoopbackAuth(oAuth2Client, scopes) {
  return new Promise((resolve, reject) => {
    let redirectUri;
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, 'http://localhost');
        const code = reqUrl.searchParams.get('code');
        const error = reqUrl.searchParams.get('error');

        if (error) {
          res.end(`Authorization failed: ${error}. You can close this tab.`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.end('No authorization code received.');
          return;
        }

        res.end('Login successful. You can close this tab and return to the app.');
        server.close();

        const { tokens } = await oAuth2Client.getToken({ code, redirect_uri: redirectUri });
        resolve(tokens);
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      redirectUri = `http://localhost:${port}`;
      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        // select_account forces Google's account chooser even when the
        // browser's already signed in somewhere — without it, adding a
        // second mail account tends to silently re-authorize whichever
        // account the browser session already favors instead of letting
        // you pick the other one.
        prompt: 'consent select_account',
        scope: scopes,
        redirect_uri: redirectUri,
      });

      console.log('Opening browser for Google sign-in...');
      console.log(authUrl);

      // Lazy require so this module works in both Node-only test runs and Electron.
      let opened = false;
      try {
        const { shell } = require('electron');
        shell.openExternal(authUrl);
        opened = true;
      } catch (_) {
        // Not running inside Electron.
      }
      if (!opened) {
        require('child_process').exec(`start "" "${authUrl}"`);
      }
    });

    server.on('error', reject);
  });
}

/**
 * Returns an authorized OAuth2Client for `accountKey` ('primary', or a
 * secondary mail-only key from listMailAccountKeys), reusing a saved token
 * if present and valid, refreshing it if expired, or running the
 * interactive loopback flow if no token exists yet.
 */
function hasAllScopes(tokens, scopes) {
  if (!tokens.scope) return true; // older token with no recorded scope — assume valid, let API calls fail loudly if not
  const granted = tokens.scope.split(' ');
  return scopes.every((s) => granted.includes(s));
}

// Cached per account-key across every IPC call in the process's lifetime —
// without this, each button click paid for a fresh disk read + client
// rebuild before it could even start the actual network request, which is
// most of why the notes window felt sluggish. Caching the in-flight
// *promise* (not just the resolved client) also means two calls landing at
// once — e.g. the widget's own startup fetch racing a background notes
// prefetch — await the same login attempt instead of each opening its own
// browser tab.
const cachedClientPromises = new Map(); // `${userDataDir}::${accountKey}` -> Promise<OAuth2Client>

function getAuthorizedClient(userDataDir, accountKey = 'primary') {
  const cacheKey = `${userDataDir}::${accountKey}`;
  if (cachedClientPromises.has(cacheKey)) return cachedClientPromises.get(cacheKey);

  const scopes = scopesFor(accountKey);
  const promise = (async () => {
    const oAuth2Client = createOAuthClient();
    const tokenPath = getTokenPath(userDataDir, accountKey);

    let tokens = fs.existsSync(tokenPath) ? JSON.parse(fs.readFileSync(tokenPath, 'utf-8')) : null;

    // A token saved before a new scope (e.g. Drive) was added won't carry it —
    // re-run consent so the user only has to log in once per new scope added.
    if (!tokens || !hasAllScopes(tokens, scopes)) {
      tokens = await runLoopbackAuth(oAuth2Client, scopes);
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    }
    oAuth2Client.setCredentials(tokens);

    // Persist refreshed access tokens automatically.
    oAuth2Client.on('tokens', (tokens) => {
      const existing = fs.existsSync(tokenPath)
        ? JSON.parse(fs.readFileSync(tokenPath, 'utf-8'))
        : {};
      const merged = { ...existing, ...tokens };
      fs.writeFileSync(tokenPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
    });

    return oAuth2Client;
  })().catch((err) => {
    cachedClientPromises.delete(cacheKey); // let a failed attempt (e.g. login cancelled) be retried
    throw err;
  });

  cachedClientPromises.set(cacheKey, promise);
  return promise;
}

/**
 * Interactively adds a new mail-only Google account: picks the next unused
 * key (mail-2, mail-3, ...), runs its own loopback consent flow, and records
 * it in the registry so future sessions know to load it. Returns the new key.
 */
async function addMailAccount(userDataDir) {
  const existing = listMailAccountKeys(userDataDir);
  const nextNumber = existing.length + 2; // primary is conceptually "account 1"
  const accountKey = `mail-${nextNumber}`;
  await getAuthorizedClient(userDataDir, accountKey); // runs the interactive login, writes the token file
  saveMailAccountKeys(userDataDir, [...existing, accountKey]);
  return accountKey;
}

function isInvalidGrantError(err) {
  return err?.response?.data?.error === 'invalid_grant' || /invalid_grant/i.test(String(err?.message || ''));
}

/** Drops the cached client and the on-disk token for one account so the next getAuthorizedClient() call for it starts fresh. */
function clearAuthCache(userDataDir, accountKey) {
  cachedClientPromises.delete(`${userDataDir}::${accountKey}`);
  try {
    const tokenPath = getTokenPath(userDataDir, accountKey);
    if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
  } catch (err) {
    console.error('Failed to clear stale token:', err);
  }
}

/**
 * Runs `fn(auth)` for `accountKey`; if the refresh token has died with
 * `invalid_grant` — expected roughly every 7 days while this app's OAuth
 * consent screen stays in "Testing" mode (avoiding Google's verification
 * process for sensitive scopes) — clears the dead token, signs in again
 * once, and retries.
 */
async function withAuthRetry(userDataDir, fn, accountKey = 'primary') {
  const auth = await getAuthorizedClient(userDataDir, accountKey);
  try {
    return await fn(auth);
  } catch (err) {
    if (!isInvalidGrantError(err)) throw err;
    console.warn(`Refresh token expired or was revoked for '${accountKey}' — signing in again...`);
    clearAuthCache(userDataDir, accountKey);
    const freshAuth = await getAuthorizedClient(userDataDir, accountKey);
    return fn(freshAuth);
  }
}

module.exports = { getAuthorizedClient, withAuthRetry, addMailAccount, listMailAccountKeys, SCOPES };
