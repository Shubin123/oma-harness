/**
 * OMA Auth Manager - browser-based login and credential storage.
 *
 * Handles subscription-based authentication for:
 *   - Claude (claude.ai) via session cookie
 *   - ChatGPT (chatgpt.com) via access token
 *   - Gemini (gemini.google.com) via session cookie
 *
 * Flow:
 *   1. User clicks "Login" in GUI
 *   2. Browser opens provider's login page
 *   3. User authenticates normally
 *   4. OMA captures session cookie/token from callback
 *   5. Credentials stored securely on disk (encrypted with machine key)
 *
 * No API keys needed - uses the same paid subscriptions
 * the user already has (Claude Pro, ChatGPT Plus, Gemini Advanced).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { execSync } from 'node:child_process';

export enum AuthStatus {
  LOGGED_OUT = 'logged_out',
  LOGGING_IN = 'logging_in',
  LOGGED_IN = 'logged_in',
  EXPIRED = 'expired',
  ERROR = 'error',
}

export interface Credential {
  provider: string;
  auth_type: string; // "cookie", "token", "api_key"
  value: string;
  email?: string;
  display_name?: string;
  plan?: string;
  expires_at?: number;
  created_at: number;
}

function isCredentialExpired(cred: Credential): boolean {
  if (!cred.expires_at) return false;
  return Date.now() / 1000 > cred.expires_at;
}

// ---- provider login configs ----

export const PROVIDER_AUTH: Record<string, Record<string, string | null>> = {
  claude: {
    name: 'Claude',
    login_url: 'https://claude.ai/login',
    check_url: 'https://claude.ai/api/auth/session',
    cookie_domain: '.claude.ai',
    session_cookie: 'sessionKey',
    token_header: null,
    plan_field: 'account.plan',
  },
  chatgpt: {
    name: 'ChatGPT',
    login_url: 'https://chatgpt.com/auth/login',
    check_url: 'https://chatgpt.com/api/auth/session',
    cookie_domain: '.chatgpt.com',
    session_cookie: '__Secure-next-auth.session-token',
    token_header: 'Authorization',
    plan_field: 'user.subscription.plan',
  },
  gemini: {
    name: 'Gemini',
    login_url: 'https://accounts.google.com/ServiceLogin?continue=https://gemini.google.com/',
    check_url: 'https://gemini.google.com/',
    cookie_domain: '.google.com',
    session_cookie: '__Secure-1PSID',
    token_header: null,
    plan_field: null,
  },
};

export class CredentialStore {
  private _path: string;
  private _key: Buffer;
  private _creds: Record<string, Credential> = {};

  constructor(storePath?: string) {
    this._path = storePath ?? path.join(os.homedir(), '.oma', 'credentials.json');
    const dir = path.dirname(this._path);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this._restrictPermissions();
    this._key = this._deriveKey();
    this._load();
  }

  private _deriveKey(): Buffer {
    let machineId = '';

    // Linux: /etc/machine-id
    for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        machineId = fs.readFileSync(p, 'utf-8').trim();
        if (machineId) break;
      } catch { /* ignore */ }
    }

    // macOS: hardware UUID
    if (!machineId && process.platform === 'darwin') {
      try {
        const result = execSync('ioreg -rd1 -c IOPlatformExpertDevice', { timeout: 5000 }).toString();
        for (const line of result.split('\n')) {
          if (line.includes('IOPlatformUUID')) {
            machineId = line.split('"').at(-2) ?? '';
            break;
          }
        }
      } catch { /* ignore */ }
    }

    // fallback: hostname + username
    if (!machineId) {
      machineId = `${os.hostname()}:${os.userInfo().username}`;
    }

    return crypto.pbkdf2Sync(machineId, 'oma-credential-store', 100_000, 32, 'sha256');
  }

  private _encrypt(data: string): string {
    const raw = Buffer.from(data, 'utf-8');
    const key = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i++) {
      key[i] = this._key[i % this._key.length];
    }
    const encrypted = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i++) {
      encrypted[i] = raw[i] ^ key[i];
    }
    return encrypted.toString('base64');
  }

  private _decrypt(data: string): string {
    const encrypted = Buffer.from(data, 'base64');
    const key = Buffer.alloc(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) {
      key[i] = this._key[i % this._key.length];
    }
    const decrypted = Buffer.alloc(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) {
      decrypted[i] = encrypted[i] ^ key[i];
    }
    return decrypted.toString('utf-8');
  }

  private _load(): void {
    try {
      if (!fs.existsSync(this._path)) return;
      const encrypted = JSON.parse(fs.readFileSync(this._path, 'utf-8')) as { data: string };
      const decrypted = this._decrypt(encrypted.data);
      const raw = JSON.parse(decrypted) as Record<string, Credential>;
      this._creds = raw;
    } catch {
      this._creds = {};
    }
  }

  private _restrictPermissions(): void {
    const dir = path.dirname(this._path);
    try {
      if (fs.existsSync(dir)) fs.chmodSync(dir, 0o700);
    } catch { /* ignore */ }
    try {
      if (fs.existsSync(this._path)) fs.chmodSync(this._path, 0o600);
    } catch { /* ignore */ }
  }

  private _save(): void {
    const dir = path.dirname(this._path);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const raw = JSON.stringify(this._creds);
    const encrypted = this._encrypt(raw);

    // write through a temp file and rename for atomicity
    const tmp = this._path + '.tmp.' + process.pid;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ data: encrypted, v: 1 }), { mode: 0o600 });
      fs.renameSync(tmp, this._path);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw new Error('failed to save credentials');
    }
    this._restrictPermissions();
  }

  store(cred: Credential): void {
    this._creds[cred.provider] = cred;
    this._save();
  }

  get(provider: string): Credential | null {
    const cred = this._creds[provider];
    if (!cred) return null;
    if (isCredentialExpired(cred)) return null;
    return cred;
  }

  remove(provider: string): void {
    delete this._creds[provider];
    this._save();
  }

  allProviders(): Record<string, Credential> {
    const result: Record<string, Credential> = {};
    for (const [k, v] of Object.entries(this._creds)) {
      if (!isCredentialExpired(v)) {
        result[k] = v;
      }
    }
    return result;
  }

  status(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const name of Object.keys(PROVIDER_AUTH)) {
      const cred = this._creds[name];
      if (cred && !isCredentialExpired(cred)) {
        result[name] = {
          status: 'logged_in',
          email: cred.email,
          plan: cred.plan,
          display_name: cred.display_name,
        };
      } else {
        result[name] = { status: 'logged_out' };
      }
    }
    return result;
  }
}

export class AuthManager {
  store: CredentialStore;
  private _callbackPort = 18923;
  private _loginServer: http.Server | null = null;
  private _onStatusChange?: (provider: string, status: string, extra?: Record<string, unknown>) => void;

  constructor(store?: CredentialStore) {
    this.store = store ?? new CredentialStore();
  }

  setStatusCallback(fn: (provider: string, status: string, extra?: Record<string, unknown>) => void): void {
    this._onStatusChange = fn;
  }

  private _notify(provider: string, status: string, extra?: Record<string, unknown>): void {
    this._onStatusChange?.(provider, status, extra);
  }

  getCredential(provider: string): Credential | null {
    return this.store.get(provider);
  }

  isLoggedIn(provider: string): boolean {
    const cred = this.store.get(provider);
    return cred !== null;
  }

  status(): Record<string, Record<string, unknown>> {
    return this.store.status();
  }

  storeApiKey(provider: string, apiKey: string): void {
    this.store.store({
      provider,
      auth_type: 'api_key',
      value: apiKey,
      created_at: Date.now() / 1000,
    });
    this._notify(provider, 'logged_in');
  }

  storeSessionToken(
    provider: string,
    token: string,
    opts?: { email?: string; plan?: string; authType?: string },
  ): void {
    this.store.store({
      provider,
      auth_type: opts?.authType ?? 'cookie',
      value: token,
      email: opts?.email,
      plan: opts?.plan,
      expires_at: Date.now() / 1000 + 30 * 86400, // 30 days
      created_at: Date.now() / 1000,
    });
    this._notify(provider, 'logged_in');
  }

  startLogin(provider: string): string {
    const config = PROVIDER_AUTH[provider];
    if (!config) return '';

    this._notify(provider, 'logging_in');
    this._runLoginFlow(provider);

    return config.login_url ?? '';
  }

  private _runLoginFlow(provider: string): void {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const data = JSON.parse(body) as Record<string, string>;
            const token = data.token ?? data.cookie ?? data.api_key;
            if (token) {
              const authType = data.api_key ? 'api_key' : 'cookie';
              this.storeSessionToken(provider, token, {
                email: data.email,
                plan: data.plan,
                authType,
              });
            } else {
              this._notify(provider, 'error');
            }
          } catch {
            this._notify(provider, 'error');
          }

          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(JSON.stringify({ ok: true }));
          server.close();
        });
      } else if (req.method === 'OPTIONS') {
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
      } else if (req.url?.startsWith('/callback')) {
        const url = new URL(req.url, `http://127.0.0.1:${this._callbackPort}`);
        const token = url.searchParams.get('token') ?? url.searchParams.get('cookie');
        if (token) {
          this.storeSessionToken(provider, token, {
            email: url.searchParams.get('email') ?? undefined,
            plan: url.searchParams.get('plan') ?? undefined,
          });
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html>
<html><body style="font-family:system-ui;display:flex;justify-content:center;
align-items:center;height:100vh;background:#0d1117;color:#c9d1d9">
<div style="text-align:center">
<h2 style="color:#3fb950">Login successful</h2>
<p>You can close this tab and return to OMA.</p>
<script>setTimeout(()=>window.close(),2000)</script>
</div></body></html>`);
        server.close();
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(this._callbackPort, '127.0.0.1');
    this._loginServer = server;

    // timeout after 5 minutes
    setTimeout(() => {
      try { server.close(); } catch { /* ignore */ }
    }, 300_000);
  }

  logout(provider: string): void {
    this.store.remove(provider);
    this._notify(provider, 'logged_out');
  }

  logoutAll(): void {
    for (const provider of Object.keys(PROVIDER_AUTH)) {
      this.store.remove(provider);
      this._notify(provider, 'logged_out');
    }
  }
}
