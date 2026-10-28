import { dateInZone, digest } from './validation.mjs';

export class Scheduler {
  constructor(store, settings, domain, learning, collector, jobs) {
    Object.assign(this, { store, settings, domain, learning, collector, jobs });
    this.startedAt = Date.now();
  }

  start() {
    this.timer = setInterval(() => { try { this.tick(); } catch {} }, 15000);
    this.timer.unref();
    this.tick();
  }

  stop() { clearInterval(this.timer); }

  tick(clock = new Date()) {
    const config = this.settings.raw();
    const scheduler = config.scheduler;
    if (!scheduler.enabled) return;
    const previous = this.store.get('scheduler-state', 'tick');
    const zone = this.domain.profile().timeZone;
    const date = dateInZone(clock, zone);
    const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(clock);
    const oldClock = previous ? new Date(previous.at) : null;
    const oldTime = oldClock ? new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(oldClock) : null;
    if (scheduler.dailyPlanEnabled && localTime >= scheduler.dailyPlanLocalTime) {
      const crossed = oldClock && +clock - +oldClock <= 120000 && dateInZone(oldClock, zone) === date && oldTime < scheduler.dailyPlanLocalTime;
      const timely = localTime === scheduler.dailyPlanLocalTime || crossed || scheduler.catchUpEnabled;
      this.slot(`plan:${date}:${zone}`, timely, () => {
        const profile = this.domain.profile();
        const plan = this.learning.plan(date, zone);
        if (plan.revision) return null;
        const payload = { date, timeZone: zone, expectedProfileRevision: profile.revision, expectedPlanRevision: 0, mode: 'template', allowTemplateFallback: true, trigger: 'scheduler' };
        return this.jobs.enqueue('daily_plan_generate', payload, `scheduler_${digest(['plan', date, zone]).slice(0, 48)}`, `plan:${date}:${zone}`);
      });
    }
    if (scheduler.codexSyncEnabled) {
      const interval = scheduler.codexSyncIntervalMinutes * 60000;
      const slotTime = Math.floor(+clock / interval) * interval;
      const timely = +clock - slotTime < 15000 || scheduler.catchUpEnabled;
      this.slot(`codex:${slotTime}`, timely, () => {
        const scope = this.collector.scope();
        if (!scope.enabled || !scope.allowedThreadIds.length && !scope.allowedProjectPaths.length) return null;
        return this.jobs.enqueue('codex_sync', { scope, request: {}, trigger: 'scheduler' }, `scheduler_${digest(['codex', slotTime]).slice(0, 48)}`, `codex:${scope.revision}`);
      });
    }
    this.store.put('scheduler-state', { at: clock.toISOString() }, 'tick');
  }

  slot(key, timely, enqueue) {
    const slotId = digest(key);
    this.store.transaction(() => {
      if (this.store.get('scheduler-slot', slotId)) return;
      let ack = null;
      try { if (timely) ack = enqueue(); }
      catch (error) { if (error.code === 'JOB_OVERLAP') return; throw error; }
      this.store.put('scheduler-slot', { key, jobId: ack?.jobId ?? null, status: ack ? 'queued' : 'skipped' }, slotId);
    });
  }
}
