import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cleanToken, detectAuthType, CredentialStore, AuthManager } from './auth.js';
import { PersistentMemory } from '../automation/memory.js';

test('cleanToken sanitizes quotes, bearer, and cookies', () => {
  assert.equal(cleanToken('claude', ' "sk-ant-api01" '), 'sk-ant-api01');
  assert.equal(cleanToken('chatgpt', 'Bearer eyJhbGciOi...'), 'eyJhbGciOi...');
  assert.equal(cleanToken('claude', 'sessionKey=sk-ant-sid01-test; Domain=.claude.ai'), 'sk-ant-sid01-test');
  assert.equal(cleanToken('chatgpt', '__Secure-next-auth.session-token=sess123; Path=/'), 'sess123');
  assert.equal(cleanToken('gemini', '__Secure-1PSID=gem123; Domain=.google.com'), 'gem123');
});

test('detectAuthType differentiates sessional vs api keys', () => {
  assert.equal(detectAuthType('claude', 'sk-ant-api03-abcdef1234567890'), 'api_key');
  assert.equal(detectAuthType('claude', 'sk-ant-sid01-abcdef1234567890'), 'cookie');
  assert.equal(detectAuthType('chatgpt', 'sk-proj-1234567890abcdef'), 'api_key');
  assert.equal(detectAuthType('chatgpt', 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...'), 'token');
  assert.equal(detectAuthType('gemini', 'AIzaSyD-1234567890abcdef'), 'api_key');
  assert.equal(detectAuthType('gemini', '__Secure-1PSID=cookie_val'), 'cookie');
  assert.equal(detectAuthType('deepseek', 'sk-32edf64d86974c07a609309610c7f225'), 'api_key');
});

test('CredentialStore and AuthManager safe storage and flush', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-test-'));
  const storePath = path.join(tmpDir, 'creds.json');
  const store = new CredentialStore(storePath);
  const mgr = new AuthManager(store);

  mgr.storeCredential('claude', 'sessionKey=sk-ant-sid01-val');
  mgr.storeCredential('deepseek', 'sk-deepseek-val');

  const info = mgr.storageInfo() as Record<string, unknown>;
  assert.equal(info.file_exists, true);
  assert.equal(info.provider_count, 2);
  assert.equal(info.file_permissions, '0o600');
  assert.equal(info.dir_permissions, '0o700');

  // Verify flush removes credentials and cleans up
  const res = mgr.flush();
  assert.equal(res.flushedCredentialsCount, 2);
  assert.equal(fs.existsSync(storePath), false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('PersistentMemory flush and permissions', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-mem-'));
  const mem = new PersistentMemory(tmpDir);

  mem.save('task_1', { hello: 'world' });
  mem.save('task_2', { foo: 'bar' });

  assert.deepEqual(mem.listTasks().sort(), ['task_1', 'task_2']);
  assert.equal(mem.flush('task_1'), 1);
  assert.deepEqual(mem.listTasks(), ['task_2']);
  assert.equal(mem.flush(), 1);
  assert.deepEqual(mem.listTasks(), []);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
