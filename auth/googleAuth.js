const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { OAuth2Client } = require('google-auth-library');

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials.json');

function getTokenPath(userDataDir) {
  return path.join(userDataDir, 'token.json');
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
function runLoopbackAuth(oAuth2Client) {
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
        prompt: 'consent',
        scope: SCOPES,
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
 * Returns an authorized OAuth2Client, reusing a saved token if present and
 * valid, refreshing it if expired, or running the interactive loopback flow
 * if no token exists yet.
 */
async function getAuthorizedClient(userDataDir) {
  const oAuth2Client = createOAuthClient();
  const tokenPath = getTokenPath(userDataDir);

  if (fs.existsSync(tokenPath)) {
    const tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    oAuth2Client.setCredentials(tokens);
  } else {
    const tokens = await runLoopbackAuth(oAuth2Client);
    oAuth2Client.setCredentials(tokens);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }

  // Persist refreshed access tokens automatically.
  oAuth2Client.on('tokens', (tokens) => {
    const existing = fs.existsSync(tokenPath)
      ? JSON.parse(fs.readFileSync(tokenPath, 'utf-8'))
      : {};
    const merged = { ...existing, ...tokens };
    fs.writeFileSync(tokenPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
  });

  return oAuth2Client;
}

module.exports = { getAuthorizedClient, SCOPES };
