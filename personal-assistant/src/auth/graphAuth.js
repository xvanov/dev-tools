'use strict';

// Microsoft identity, device-code flow.
//
// Device code rather than an interactive browser redirect because this runs
// headless: workers poll on a timer, and `pa login` may well be typed over
// termhub from a phone. Device code needs no listening socket and no redirect
// URI that has to match a registration.
//
// The scopes come from config and default to read-only. `Mail.Send` and
// `ChatMessage.Send` are deliberately not in that default: consent for sending
// is a separate ask from consent for reading, and a token that cannot send is a
// token that cannot be talked into sending.

const { PublicClientApplication, LogLevel } = require('@azure/msal-node');
const { config } = require('../config');
const { cachePlugin } = require('./tokenStore');
const { logger } = require('../log');

const log = logger('auth');

let app = null;

function client() {
  if (!config.graph.clientId) {
    throw new Error(
      'PA_GRAPH_CLIENT_ID is not set — register an app in Entra and put its Application (client) ID in .env'
    );
  }
  if (!app) {
    app = new PublicClientApplication({
      auth: {
        clientId: config.graph.clientId,
        authority: `https://login.microsoftonline.com/${config.graph.tenantId}`,
      },
      cache: { cachePlugin: cachePlugin() },
      system: {
        loggerOptions: {
          logLevel: LogLevel.Error,
          piiLoggingEnabled: false,
          loggerCallback(_level, message) {
            log.debug('msal', { message });
          },
        },
      },
    });
  }
  return app;
}

async function cachedAccount() {
  const accounts = await client().getTokenCache().getAllAccounts();
  return accounts[0] ?? null;
}

// Interactive. Prints a code and a URL; resolves once the user has finished.
async function login(onCode) {
  const result = await client().acquireTokenByDeviceCode({
    scopes: config.graph.scopes,
    deviceCodeCallback: (response) => {
      if (onCode) onCode(response);
      else process.stdout.write(response.message + '\n');
    },
  });
  return result;
}

// Non-interactive. Throws a recognisable error when a login is needed, so
// workers can log "not signed in" once rather than spraying stack traces.
class NeedsLogin extends Error {
  constructor(message) {
    super(message || 'not signed in — run `pa login`');
    this.name = 'NeedsLogin';
  }
}

async function accessToken() {
  const account = await cachedAccount();
  if (!account) throw new NeedsLogin();
  try {
    const result = await client().acquireTokenSilent({
      account,
      scopes: config.graph.scopes,
    });
    return result.accessToken;
  } catch (err) {
    // A refresh token that expired, was revoked, or had its consent withdrawn
    // all land here, and they all have the same remedy.
    throw new NeedsLogin(`silent token refresh failed: ${err.message}`);
  }
}

async function whoAmI() {
  const account = await cachedAccount();
  if (!account) return null;
  return {
    username: account.username,
    name: account.name,
    tenantId: account.tenantId,
    homeAccountId: account.homeAccountId,
  };
}

module.exports = { login, accessToken, whoAmI, cachedAccount, NeedsLogin };
