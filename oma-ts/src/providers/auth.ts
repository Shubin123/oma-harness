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
import {
  describePermissions,
  machineId,
  makePrivateDir,
  restrictToOwner,
} from '../platformCompat.js';
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

export function cleanToken(provider: string, raw: string): string {
  if (!raw) return '';
  let token = raw.trim().replace(/^['"]|['"]$/g, '');

  if (token.toLowerCase().startsWith('bearer ')) {
    token = token.slice(7).trim();
  }

  if (token.includes('sessionKey=')) {
    for (const part of token.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith('sessionKey=')) {
        token = trimmed.split('=', 2)[1]?.trim() ?? '';
        break;
      }
    }
  } else if (token.startsWith('sessionKey:')) {
    token = token.split(':', 2)[1]?.trim() ?? '';
  }

  const cookieNameGpt = '__Secure-next-auth.session-token';
  if (token.includes(`${cookieNameGpt}=`)) {
    for (const part of token.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith(`${cookieNameGpt}=`)) {
        token = trimmed.split('=', 2)[1]?.trim() ?? '';
        break;
      }
    }
  }

  const cookieNameGem = '__Secure-1PSID';
  if (token.includes(`${cookieNameGem}=`)) {
    for (const part of token.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith(`${cookieNameGem}=`)) {
        token = trimmed.split('=', 2)[1]?.trim() ?? '';
        break;
      }
    }
  }

  if (token.includes(';')) {
    token = token.split(';', 2)[0]?.trim() ?? '';
  }

  return token.trim();
}

export function detectAuthType(provider: string, keyOrToken: string): 'cookie' | 'token' | 'api_key' {
  if (!keyOrToken) return 'api_key';

  const raw = keyOrToken.trim().replace(/^['"]|['"]$/g, '');

  if (raw.startsWith('sessionKey=') || raw.includes('sessionKey=')) {
    return 'cookie';
  }
  if (raw.startsWith('sk-ant-sid')) {
    return 'cookie';
  }
  if (raw.startsWith('sk-ant-oat')) {
    return 'token';
  }
  if (raw.startsWith('eyJ')) {
    return 'token';
  }
  if (raw.includes('__Secure-')) {
    return raw.toLowerCase().includes('token') ? 'token' : 'cookie';
  }

  const p = provider.toLowerCase();
  if (p === 'claude') {
    if (raw.startsWith('sk-ant-api')) {
      return 'api_key';
    }
    if (raw.length > 80 && !raw.startsWith('sk-')) {
      return 'cookie';
    }
    return 'api_key';
  } else if (p === 'chatgpt') {
    if (raw.startsWith('sk-proj-') || raw.startsWith('sk-')) {
      return 'api_key';
    }
    return raw.length > 100 ? 'token' : 'api_key';
  } else if (p === 'gemini') {
    if (raw.startsWith('AIzaSy')) {
      return 'api_key';
    }
    if (raw.length > 50) {
      return 'cookie';
    }
    return 'cookie';
  }

  return 'api_key';
}

export class CredentialStore {
  private _path: string;
  private _key: Buffer;
  private _creds: Record<string, Credential> = {};

  constructor(storePath?: string) {
    this._path = storePath ?? path.join(os.homedir(), '.oma', 'credentials.json');
    makePrivateDir(path.dirname(this._path));
    this._restrictPermissions();
    this._key = this._deriveKey();
    this._load();
  }

  private _deriveKey(): Buffer {
    return crypto.pbkdf2Sync(machineId(), 'oma-credential-store', 100_000, 32, 'sha256');
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
    restrictToOwner(path.dirname(this._path));
    restrictToOwner(this._path);
  }

  private _save(): void {
    makePrivateDir(path.dirname(this._path));

    const raw = JSON.stringify(this._creds);
    const encrypted = this._encrypt(raw);

    // write through a temp file and rename for atomicity
    const tmp = this._path + '.tmp.' + process.pid;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ data: encrypted, v: 1 }), { mode: 0o600 });
      restrictToOwner(tmp);
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

  get path(): string {
    return this._path;
  }

  remove(provider: string): void {
    delete this._creds[provider];
    this._save();
  }

  flush(secureWipe = true): number {
    const count = Object.keys(this._creds).length;
    this._creds = {};

    if (fs.existsSync(this._path)) {
      try {
        if (secureWipe) {
          const size = fs.statSync(this._path).size;
          const randomBuf = crypto.randomBytes(size || 128);
          fs.writeFileSync(this._path, randomBuf);
        }
        fs.unlinkSync(this._path);
      } catch { /* ignore */ }
    }

    try {
      const dir = path.dirname(this._path);
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith('.credentials-') && f.endsWith('.tmp')) {
            try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }

    return count;
  }

  storageInfo(): Record<string, unknown> {
    const exists = fs.existsSync(this._path);
    let sizeBytes = 0;
    let filePermissions: string | null = null;
    let dirPermissions: string | null = null;

    if (exists) {
      sizeBytes = fs.statSync(this._path).size;
      filePermissions = describePermissions(this._path);
    }
    dirPermissions = describePermissions(path.dirname(this._path));

    const stored: Record<string, unknown> = {};
    for (const [name, cred] of Object.entries(this._creds)) {
      const val = cred.value ?? '';
      const masked = val.length > 8 ? `${val.slice(0, 4)}...${val.slice(-4)}` : '***';
      stored[name] = {
        auth_type: cred.auth_type,
        email: cred.email,
        plan: cred.plan,
        is_expired: isCredentialExpired(cred),
        created_at: cred.created_at,
        expires_at: cred.expires_at,
        masked_value: masked,
      };
    }

    return {
      credentials_file: this._path,
      credentials_dir: path.dirname(this._path),
      file_exists: exists,
      size_bytes: sizeBytes,
      file_permissions: filePermissions,
      dir_permissions: dirPermissions,
      encryption: 'PBKDF2-HMAC-SHA256 (100k rounds) + Hardware UUID key + XOR stream',
      provider_count: Object.keys(this._creds).length,
      providers: stored,
    };
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
      } else if (cred && isCredentialExpired(cred)) {
        result[name] = { status: 'expired' };
      } else {
        result[name] = { status: 'logged_out' };
      }
    }
    for (const [name, cred] of Object.entries(this._creds)) {
      if (!(name in result)) {
        if (!isCredentialExpired(cred)) {
          result[name] = {
            status: 'logged_in',
            email: cred.email,
            plan: cred.plan,
            display_name: cred.display_name,
          };
        } else {
          result[name] = { status: 'expired' };
        }
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
    return cred !== null && !isCredentialExpired(cred);
  }

  status(): Record<string, Record<string, unknown>> {
    return this.store.status();
  }

  storeCredential(
    provider: string,
    value: string,
    opts?: { authType?: string; email?: string; plan?: string },
  ): Credential {
    const cleaned = cleanToken(provider, value);
    if (!cleaned) {
      throw new Error('Credential value cannot be empty');
    }

    const authType = (!opts?.authType || opts.authType === 'auto')
      ? detectAuthType(provider, value)
      : opts.authType;

    if (authType === 'cookie' || authType === 'token') {
      this.storeSessionToken(provider, cleaned, {
        email: opts?.email,
        plan: opts?.plan,
        authType,
      });
    } else {
      this.storeApiKey(provider, cleaned);
    }

    return this.store.get(provider)!;
  }

  storeApiKey(provider: string, apiKey: string): void {
    const cleaned = cleanToken(provider, apiKey);
    this.store.store({
      provider,
      auth_type: 'api_key',
      value: cleaned,
      created_at: Date.now() / 1000,
    });
    this._notify(provider, 'logged_in');
  }

  storeSessionToken(
    provider: string,
    token: string,
    opts?: { email?: string; plan?: string; authType?: string },
  ): void {
    const cleaned = cleanToken(provider, token);
    this.store.store({
      provider,
      auth_type: opts?.authType ?? 'cookie',
      value: cleaned,
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
    const providers = new Set([...Object.keys(PROVIDER_AUTH), ...Object.keys(this.store.allProviders())]);
    for (const provider of providers) {
      this.store.remove(provider);
      this._notify(provider, 'logged_out');
    }
  }

  flush(includeMemory = false, memoryDir = '.oma_memory'): {
    flushedCredentialsCount: number;
    memoryFilesRemoved: number;
    credentialsFile: string;
    status: string;
  } {
    const providers = new Set([...Object.keys(PROVIDER_AUTH), ...Object.keys(this.store.allProviders())]);
    for (const provider of providers) {
      this._notify(provider, 'logged_out');
    }

    const count = this.store.flush(true);

    let memoryFlushed = 0;
    if (includeMemory && fs.existsSync(memoryDir)) {
      try {
        for (const file of fs.readdirSync(memoryDir)) {
          if (file.endsWith('.json')) {
            try {
              fs.unlinkSync(path.join(memoryDir, file));
              memoryFlushed++;
            } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }

    return {
      flushedCredentialsCount: count,
      memoryFilesRemoved: memoryFlushed,
      credentialsFile: this.store.path,
      status: 'flushed',
    };
  }

  storageInfo(): Record<string, unknown> {
    return this.store.storageInfo();
  }
}
