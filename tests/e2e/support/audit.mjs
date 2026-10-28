import { expect } from '@playwright/test';
import { isRedirect, requestViolation, validateFaultInjection } from './safety.mjs';

export function createAudit(context, { origin, attestation }) {
  const failures = [];
  const consoleErrors = [];
  const rules = [];
  const expectedResources = new Map();
  const work = [];
  const observed = new WeakSet();

  function expectFailure(rule) {
    const entry = { min: 1, max: 1, count: 0, ...rule };
    rules.push(entry);
    return entry;
  }

  async function responseReceived(response) {
    if (response.status() < 400) return;
    const req = response.request();
    const payload = await response.json().catch(() => null);
    const path = new URL(response.url()).pathname;
    const rule = rules.find(item => item.path === path && item.method === req.method() && item.status === response.status() && item.code === payload?.error?.code && item.count < item.max);
    if (!rule) {
      failures.push(`Unexpected HTTP ${response.status()} ${req.method()} ${path} (${payload?.error?.code || 'no error code'}).`);
      return;
    }
    rule.count += 1;
    const key = `${response.url()}|${response.status()}`;
    expectedResources.set(key, (expectedResources.get(key) || 0) + 1);
  }

  function observePage(page) {
    if (observed.has(page)) return;
    observed.add(page);
    page.on('pageerror', error => failures.push(`pageerror: ${error.message}`));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url });
    });
    page.on('response', response => work.push(responseReceived(response).catch(error => failures.push(`Response audit failed: ${error.message}`))));
    page.on('requestfailed', req => failures.push(`Request failed: ${req.method()} ${new URL(req.url()).pathname}: ${req.failure()?.errorText}.`));
  }

  async function install() {
    context.on('page', observePage);
    context.pages().forEach(observePage);
    await context.routeWebSocket('**/*', async socket => {
      failures.push(`Unexpected WebSocket connection: ${socket.url()}. Use a built isolated frontend.`);
      await socket.close({ code: 1008, reason: 'E2E isolated HTTP-only boundary' });
    });
    await context.route('**/*', async route => {
      const req = route.request();
      const raw = req.postData();
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch {}
      const violation = requestViolation({ url: req.url(), method: req.method(), headers: req.headers(), body }, origin, attestation);
      if (violation) {
        failures.push(`Safety guard: ${req.method()} ${new URL(req.url()).pathname}: ${violation}`);
        await route.abort('blockedbyclient');
        return;
      }
      try {
        // Fetch once without following redirects; pass through the actual server response unchanged.
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 25_000 });
        if (isRedirect(response.status())) {
          failures.push(`HTTP redirect blocked before follow: ${req.method()} ${new URL(req.url()).pathname} (${response.status()}).`);
          await route.abort('blockedbyclient');
          return;
        }
        await route.fulfill({ response });
      } catch (error) {
        failures.push(`Isolated request forwarding failed: ${req.method()} ${new URL(req.url()).pathname}: ${error.message}`);
        await route.abort('failed');
      }
    });
  }

  async function injectFailure(page, { path, method, status = 503, code, message, max = 1 }) {
    validateFaultInjection({ path, method, status, code, max });
    const rule = expectFailure({ path, method, status, code, max });
    let injected = 0;
    await page.route(url => url.origin === origin && url.pathname === path, async route => {
      if (route.request().method() !== method || injected >= max) { await route.fallback(); return; }
      injected += 1;
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code, message, retryable: true } }) });
    });
    return rule;
  }

  async function finish(testInfo) {
    await Promise.all(work);
    for (const error of consoleErrors) {
      const status = /^Failed to load resource: the server responded with a status of (\d{3}) \([^\r\n]*\)$/.exec(error.text)?.[1];
      const key = `${error.url}|${status}`;
      const remaining = expectedResources.get(key) || 0;
      if (status && remaining > 0) { expectedResources.set(key, remaining - 1); continue; }
      failures.push(`Unexpected console error: ${error.text} (${error.url || 'no resource URL'}).`);
    }
    for (const rule of rules) {
      if (rule.count < rule.min || rule.count > rule.max) failures.push(`Expected ${rule.method} ${rule.path} ${rule.status}/${rule.code} ${rule.min}–${rule.max} times, saw ${rule.count}.`);
    }
    const report = { failures, consoleErrors, expectedFailures: rules };
    await testInfo.attach('browser-diagnostics', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    expect(failures, 'Unexpected browser/network failures; inspect browser-diagnostics attachment.').toEqual([]);
  }

  return { install, expectFailure, injectFailure, finish };
}
