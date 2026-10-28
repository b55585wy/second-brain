import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, statSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fail } from './errors.mjs';

function systemTool(name) {
  const root = process.env.SystemRoot;
  if (!root || !isAbsolute(root)) fail(500, 'INTERNAL_ERROR', '无法定位可信的 Windows 凭据工具。');
  const file = resolve(root, 'System32', name);
  if (!existsSync(file) || !statSync(file).isFile()) fail(500, 'INTERNAL_ERROR', '可信的 Windows 凭据工具不可用。');
  return file;
}

const windowsAclScript = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sections = [System.Security.AccessControl.AccessControlSections]::Access
$directory = [System.IO.Directory]::Exists($request.path)
function Read-PathAcl {
  if ($directory) { return [System.IO.Directory]::GetAccessControl($request.path, $sections) }
  return [System.IO.File]::GetAccessControl($request.path, $sections)
}
$acl = Read-PathAcl
$acl.SetSecurityDescriptorSddlForm(('D:P(A;;FA;;;' + $request.sid + ')'), $sections)
if ($directory) { [System.IO.Directory]::SetAccessControl($request.path, $acl) }
else { [System.IO.File]::SetAccessControl($request.path, $acl) }
$check = Read-PathAcl
$rules = @($check.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (-not $check.AreAccessRulesProtected -or $rules.Count -ne 1) { throw 'Credential ACL verification failed.' }
$rule = $rules[0]
if ($rule.IdentityReference.Value -ne $request.sid -or $rule.IsInherited -or
  $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
  $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
  throw 'Credential ACL verification failed.'
}
`;

function restrict(path) {
  if (process.platform !== 'win32') {
    chmodSync(path, statSync(path).isDirectory() ? 0o700 : 0o600);
    if (statSync(path).mode & 0o077) fail(500, 'INTERNAL_ERROR', '本地凭据权限设置失败。');
    return;
  }
  const options = { encoding: 'utf8', shell: false, windowsHide: true };
  const identity = spawnSync(systemTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], options);
  const sid = identity.stdout?.match(/S-1-[0-9-]+/)?.[0];
  if (identity.status !== 0 || !sid) fail(500, 'INTERNAL_ERROR', '无法确认本地凭据文件所有者。');
  const aclTool = systemTool('icacls.exe');
  // Replacing the DACL removes explicit non-owner rules that /grant:r leaves intact.
  const result = spawnSync(systemTool('WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsAclScript], {
      ...options, input: JSON.stringify({ path: resolve(path), sid }),
    });
  if (result.status !== 0) fail(500, 'INTERNAL_ERROR', '本地凭据权限设置失败，未保存凭据。');
  if (spawnSync(aclTool, [path, '/verify'], options).status !== 0) fail(500, 'INTERNAL_ERROR', '本地凭据权限核验失败，未保存凭据。');
}

// Credentials live separately from product records and never enter exportable settings.
export class Secrets {
  constructor(filename) {
    this.filename = filename;
    try {
      if (existsSync(filename)) {
        restrict(dirname(filename));
        restrict(filename);
      }
      this.values = existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : {};
    }
    catch { fail(500, 'INTERNAL_ERROR', '本地凭据文件不可读或已损坏。'); }
  }

  get(name) { return this.values[name] ?? ''; }

  set(name, value) {
    mkdirSync(dirname(this.filename), { recursive: true });
    restrict(dirname(this.filename));
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    const next = { ...this.values };
    if (value) next[name] = value;
    else delete next[name];
    try {
      writeFileSync(temporary, '', { mode: 0o600, flag: 'wx' });
      restrict(temporary);
      writeFileSync(temporary, JSON.stringify(next));
      renameSync(temporary, this.filename);
      this.values = next;
    } catch (error) { rmSync(temporary, { force: true }); throw error; }
  }

  redact(value) {
    let content = String(value);
    for (const secret of Object.values(this.values)) {
      if (typeof secret === 'string' && secret) content = content.split(secret).join('[REDACTED]');
    }
    return content
      .replace(/\b(?:sk-|sk_)[a-zA-Z0-9_-]{8,}\b/g, '[REDACTED]')
      .replace(/\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/-]{6,}/gi, '[REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
      .replace(/(["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|password|secret|token|tokenFile|cookie|authorization)["']\s*:\s*)(["'])([^\r\n]*?)\2/gi,
        (match, prefix, quote) => `${prefix}${quote}[REDACTED]${quote}`)
      .replace(/\b(cookie|authorization)\s*:\s*[^\r\n]+/gi, '$1: [REDACTED]')
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|password|secret|tokenFile|token)\s*[=:]\s*["']?)(\[[^\]\r\n]*\]|[^\s"'`,;}\]]+)/gi,
        (match, prefix) => `${prefix}[REDACTED]`);
  }

  clean(value) {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map(item => this.clean(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.clean(item)]));
    return value;
  }
}
