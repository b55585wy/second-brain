import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Secrets } from '../../server/secrets.mjs';
import { scratch, removeScratch } from './helpers.mjs';

const windowsOnly = { skip: process.platform !== 'win32' };

function aclMetadata(path) {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sections = [System.Security.AccessControl.AccessControlSections]::Access
$acl = if ([System.IO.Directory]::Exists($request.path)) {
  [System.IO.Directory]::GetAccessControl($request.path, $sections)
} else {
  [System.IO.File]::GetAccessControl($request.path, $sections)
}
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  @{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; type = $_.AccessControlType.ToString(); inherited = $_.IsInherited }
})
@{ userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; protected = $acl.AreAccessRulesProtected; rules = $rules } | ConvertTo-Json -Compress -Depth 4
`;
  return JSON.parse(execFileSync(resolve(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      input: JSON.stringify({ path }), encoding: 'utf8', shell: false, windowsHide: true,
    }));
}

function ownerOnly(path) {
  const metadata = aclMetadata(path);
  assert.equal(metadata.protected, true, 'Credential DACL must reject inherited permissions.');
  assert.deepEqual(metadata.rules, [{ sid: metadata.userSid, rights: 2032127, type: 'Allow', inherited: false }],
    'Credential DACL must contain only the current user FullControl rule.');
}

function publicRead(path) {
  execFileSync(resolve(process.env.SystemRoot, 'System32/icacls.exe'), [path, '/grant', '*S-1-1-0:(R)',
    '*S-1-5-18:(F)', '*S-1-5-5-0-358012:(RX)'], { encoding: 'utf8', shell: false, windowsHide: true });
  const metadata = aclMetadata(path);
  assert.ok(metadata.rules.some(rule => rule.sid === 'S-1-1-0' && !rule.inherited), 'Fixture must have an explicit Everyone read rule.');
  assert.ok(metadata.rules.some(rule => rule.sid === 'S-1-5-5-0-358012' && !rule.inherited), 'Fixture must retain an explicit non-owner logon rule.');
}

test('Windows saves protect real default file ACLs before persisting credentials', windowsOnly, t => {
  const root = scratch(); t.after(() => removeScratch(root));
  const directory = resolve(root, "private [literal] ' $value ` 中文"); mkdirSync(directory);
  const filename = resolve(directory, 'credentials.json');
  writeFileSync(filename, '{}');
  assert.ok(aclMetadata(filename).rules.length > 0, 'Inspect the real Windows-created file rather than a mocked ACL.');
  const secrets = new Secrets(filename);
  secrets.set('model.apiKey', 'synthetic-default-acl-key');
  ownerOnly(directory); ownerOnly(filename);
  assert.equal(new Secrets(filename).get('model.apiKey'), 'synthetic-default-acl-key');
  assert.deepEqual(readdirSync(directory), ['credentials.json']);
});

test('Windows updates remove explicit public and non-owner ACEs while retaining other credentials', windowsOnly, t => {
  const root = scratch(); t.after(() => removeScratch(root));
  const directory = resolve(root, 'private'); mkdirSync(directory);
  const filename = resolve(directory, 'credentials.json');
  writeFileSync(filename, JSON.stringify({ 'model.apiKey': 'synthetic-original-key', 'feishu.appSecret': 'synthetic-retained-key' }));
  const secrets = new Secrets(filename);
  publicRead(directory); publicRead(filename);
  secrets.set('model.apiKey', 'synthetic-replacement-key');
  ownerOnly(directory); ownerOnly(filename);
  assert.deepEqual(JSON.parse(readFileSync(filename, 'utf8')), {
    'model.apiKey': 'synthetic-replacement-key', 'feishu.appSecret': 'synthetic-retained-key',
  });
  publicRead(directory); publicRead(filename);
  secrets.set('model.apiKey', '');
  ownerOnly(directory); ownerOnly(filename);
  assert.deepEqual(JSON.parse(readFileSync(filename, 'utf8')), { 'feishu.appSecret': 'synthetic-retained-key' });
  assert.deepEqual(readdirSync(directory), ['credentials.json']);
});

test('Windows reopening legacy credentials repairs ACLs without changing stored values', windowsOnly, t => {
  const root = scratch(); t.after(() => removeScratch(root));
  const directory = resolve(root, 'private'); mkdirSync(directory);
  const filename = resolve(directory, 'credentials.json');
  const original = JSON.stringify({ 'model.apiKey': 'synthetic-legacy-key' });
  writeFileSync(filename, original);
  publicRead(directory); publicRead(filename);
  const secrets = new Secrets(filename);
  ownerOnly(directory); ownerOnly(filename);
  assert.equal(secrets.get('model.apiKey'), 'synthetic-legacy-key');
  assert.equal(readFileSync(filename, 'utf8'), original);
  assert.deepEqual(readdirSync(directory), ['credentials.json']);
});
