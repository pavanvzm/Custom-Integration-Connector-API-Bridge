/* ─── API Bridge Monitor Dashboard ────────────────────── */
class DashboardApp {
  constructor() {
    this.metrics = null;
    this.eventSource = null;
    this.currentTab = 'overview';
    this.auditFilter = 'all';
    this.updateTimers = { refresh: null, time: null };
    this.init();
  }

  init() {
    this.setupTabs();
    this.setupRefreshButton();
    this.setupAuditFilters();
    this.connectSSE();
    this.startClock();
  }

  // ─── SSE Connection ─────────────────────────────────
  connectSSE() {
    this.updateConnStatus('connecting');
    this.eventSource = new EventSource('/api/stream');

    this.eventSource.onopen = () => {
      this.updateConnStatus('connected');
    };

    this.eventSource.onmessage = (e) => {
      try {
        this.metrics = JSON.parse(e.data);
        this.updateUI();
      } catch (err) {
        console.error('Failed to parse SSE data:', err);
      }
    };

    this.eventSource.onerror = () => {
      this.updateConnStatus('disconnected');
      // Attempt to reconnect via polling as fallback
      if (!this.updateTimers.refresh) {
        this.updateTimers.refresh = setInterval(() => this.fetchMetrics(), 5000);
      }
    };
  }

  updateConnStatus(status) {
    const dot = document.getElementById('connDot');
    const text = document.getElementById('connText');
    if (!dot || !text) return;
    dot.className = 'connection-dot';
    if (status === 'connected') {
      dot.classList.add('connected');
      text.textContent = 'Connected';
    } else if (status === 'disconnected') {
      dot.classList.add('disconnected');
      text.textContent = 'Disconnected';
    } else {
      dot.classList.add('reconnecting');
      text.textContent = 'Reconnecting...';
    }
  }

  // ─── Fallback REST polling ──────────────────────────
  async fetchMetrics() {
    try {
      const res = await fetch('/api/metrics');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.metrics = await res.json();
      this.updateUI();
      this.updateConnStatus('connected');
    } catch (err) {
      console.error('Polling failed:', err);
      this.updateConnStatus('disconnected');
    }
  }

  // ─── Tab Navigation ─────────────────────────────────
  setupTabs() {
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.currentTab = tab.dataset.tab;
        document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
        const target = document.getElementById(`tab-${this.currentTab}`);
        if (target) target.classList.add('active');
        // Re-render charts when tab changes (fix sizing)
        if (this.currentTab === 'overview') setTimeout(() => this.renderOverviewCharts(), 100);
        if (this.currentTab === 'audit') setTimeout(() => this.renderAuditCharts(), 100);
        if (this.currentTab === 'sync') setTimeout(() => this.renderResponseTimeChart(), 100);
      });
    });
  }

  setupRefreshButton() {
    const btn = document.getElementById('refreshBtn');
    if (btn) btn.addEventListener('click', () => this.fetchMetrics());
  }

  setupAuditFilters() {
    const filters = document.querySelectorAll('.filter-btn');
    filters.forEach(btn => {
      btn.addEventListener('click', () => {
        filters.forEach(f => f.classList.remove('active'));
        btn.classList.add('active');
        this.auditFilter = btn.dataset.severity;
        this.renderAuditTable();
      });
    });
  }

  startClock() {
    const update = () => {
      const el = document.getElementById('lastUpdate');
      if (el) el.textContent = `Last update: ${new Date().toLocaleTimeString()}`;
    };
    update();
    this.updateTimers.time = setInterval(update, 1000);
  }

  // ─── Main UI Update ─────────────────────────────────
  updateUI() {
    if (!this.metrics) return;
    this.updateStatusBar();
    this.updateStats();
    this.updateEvents();
    this.updateDirectionTable();
    this.updateEntityTable();
    this.updateRateLimitTable();
    this.updateRetryTable();
    this.updateAuditTable();
    this.updateAdapterStatus();
    this.updateConfig();
    this.updateErrors();
    this.updateLastUpdate();

    // Render charts on visible tabs
    this.renderOverviewCharts();
    this.renderResponseTimeChart();
    this.renderAuditCharts();
  }

  updateLastUpdate() {
    const el = document.getElementById('lastUpdate');
    if (el) el.textContent = `Last update: ${new Date().toLocaleTimeString()}`;
  }

  // ─── Status Bar ─────────────────────────────────────
  updateStatusBar() {
    if (!this.metrics) return;
    const { adapters, sync, process } = this.metrics;

    const allConnected = adapters.soap.status === 'connected' &&
      adapters.sql.status === 'connected' &&
      adapters.redis.status === 'connected';
    const sysHealth = document.getElementById('sysHealth');
    if (sysHealth) {
      sysHealth.textContent = allConnected ? 'Healthy' : 'Degraded';
      sysHealth.className = `status-value ${allConnected ? 'healthy' : 'degraded'}`;
    }

    this.setStatus('ovSoapStatus', adapters.soap.status);
    this.setStatus('ovSqlStatus', adapters.sql.status);
    this.setStatus('ovRedisStatus', adapters.redis.status);

    const tp = document.getElementById('ovThroughput');
    if (tp) tp.textContent = `${sync.throughput1m}/m`;

    const el = document.getElementById('ovEventLoop');
    if (el) {
      const lag = process.eventLoopLag || 0;
      el.textContent = `${lag}ms`;
      el.className = `status-value ${lag < 50 ? 'healthy' : lag < 200 ? 'degraded' : 'unhealthy'}`;
    }

    const mem = document.getElementById('ovMemory');
    if (mem && process.memoryUsage) {
      const mb = (process.memoryUsage.heapUsed / 1024 / 1024).toFixed(0);
      mem.textContent = `${mb} MB`;
    }

    const pid = document.getElementById('ovPid');
    if (pid) pid.textContent = process.pid || '--';
  }

  setStatus(id, status) {
    const el = document.getElementById(id);
    if (!el) return;
    const map = {
      connected: 'Healthy',
      disconnected: 'Offline',
      error: 'Error',
    };
    el.textContent = map[status] || status;
    el.className = `status-value ${status === 'connected' ? 'healthy' : status === 'disconnected' ? 'degraded' : 'unhealthy'}`;
  }

  // ─── Stats ──────────────────────────────────────────
  updateStats() {
    if (!this.metrics) return;
    const { sync: s, rateLimiter, retry } = this.metrics;
    const total = s.total || 0;
    const success = s.success || 0;
    const failed = s.failed || 0;
    const rate = total > 0 ? ((success / total) * 100).toFixed(1) : '100';

    this.setText('totalOps', total.toLocaleString());
    this.setText('successOps', success.toLocaleString());
    this.setText('failedOps', failed.toLocaleString());
    this.setText('successRate', `${rate}%`);
    this.setText('activeRetries', (retry.activeOperations || 0).toLocaleString());
    this.setText('blockedCount', (rateLimiter.blockedCount || 0).toLocaleString());
    this.setText('avgDuration', `${s.avgDurationMs || 0}ms`);
    this.setText('throughput5m', `${s.throughput5m || 0}/m`);

    this.setText('rlTotalChecks', (rateLimiter.totalChecks || 0).toLocaleString());
    this.setText('rlBlocked', (rateLimiter.blockedCount || 0).toLocaleString());
    this.setText('rlFailOpen', (rateLimiter.failOpenCount || 0).toLocaleString());

    this.setText('retryTotalAttempts', (retry.totalAttempts || 0).toLocaleString());
    this.setText('retrySucceeded', (retry.succeededOperations || 0).toLocaleString());
    this.setText('retryExhausted', (retry.exhaustedOperations || 0).toLocaleString());
    this.setText('retryActive', (retry.activeOperations || 0).toLocaleString());
    this.setText('eventCount', `${s.total || 0} events`);
    this.setText('errorCount', `${failed} errors`);
  }

  setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // ─── Overview Charts ────────────────────────────────
  renderOverviewCharts() {
    if (this.currentTab !== 'overview') return;
    if (!this.metrics) return;
    this.drawDirectionChart();
    this.drawSuccessChart();
    this.drawSeverityChart();
  }

  drawDirectionChart() {
    const canvas = document.getElementById('directionChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const data = this.metrics.sync.byDirection || {};
    const labels = Object.keys(data);
    const values = Object.values(data);
    if (labels.length === 0) { this.drawEmptyChart(canvas, 'No data'); return; }

    const colors = ['#4a80f0', '#9678e8', '#22d4d4', '#2ec48e', '#e8b830'];
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const { dpr, w, h } = this.setupCanvas(canvas);
    const barArea = w - 160;
    const barH = 26;
    const gap = 10;
    const startY = (h - (labels.length * (barH + gap))) / 2 + 10;

    ctx.clearRect(0, 0, w, h);

    labels.forEach((label, i) => {
      const y = startY + i * (barH + gap);
      const pct = (values[i] / total) * 100;
      const barW = Math.max(4, (pct / 100) * barArea);

      ctx.fillStyle = '#8b90b0';
      ctx.font = '11px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(this.formatDirection(label), 148, y + 17);

      ctx.fillStyle = '#13173a';
      this.roundRect(ctx, 154, y + 1, barArea - 2, barH, 4);
      ctx.fill();

      const grad = ctx.createLinearGradient(154, 0, 154 + barW, 0);
      grad.addColorStop(0, colors[i % colors.length]);
      grad.addColorStop(1, this.lighten(colors[i % colors.length], 0.3));
      ctx.fillStyle = grad;
      this.roundRect(ctx, 154, y + 1, Math.max(4, barW - 2), barH, 4);
      ctx.fill();

      ctx.fillStyle = '#e2e6f0';
      ctx.font = '600 12px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText(`${values[i]} (${pct.toFixed(0)}%)`, 160 + barW, y + 18);
    });
  }

  drawSuccessChart() {
    const canvas = document.getElementById('successChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { success = 0, failed = 0 } = this.metrics.sync;
    const total = success + failed || 1;

    const { dpr, w, h } = this.setupCanvas(canvas);
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2 + 5;
    const r = Math.min(w * 0.35, 65);
    const lineW = 26;

    // Background ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#13173a';
    ctx.lineWidth = lineW;
    ctx.stroke();

    const successAngle = (success / total) * Math.PI * 2;
    const failedAngle = (failed / total) * Math.PI * 2;

    if (success > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + successAngle);
      ctx.strokeStyle = '#2ec48e';
      ctx.lineWidth = lineW;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    if (failed > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2 + successAngle, -Math.PI / 2 + successAngle + failedAngle);
      ctx.strokeStyle = '#e86060';
      ctx.lineWidth = lineW;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    ctx.fillStyle = '#e2e6f0';
    ctx.font = '700 22px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${((success / total) * 100).toFixed(0)}%`, cx, cy - 6);
    ctx.fillStyle = '#4f5480';
    ctx.font = '11px system-ui';
    ctx.fillText('Success Rate', cx, cy + 16);

    const lx = cx - 90;
    const ly = h - 18;
    ctx.font = '11px system-ui';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#2ec48e';
    ctx.fillRect(lx, ly - 3, 9, 9);
    ctx.fillStyle = '#8b90b0';
    ctx.textAlign = 'left';
    ctx.fillText(`Success (${success})`, lx + 13, ly + 1);
    ctx.fillStyle = '#e86060';
    ctx.fillRect(lx + 130, ly - 3, 9, 9);
    ctx.fillStyle = '#8b90b0';
    ctx.fillText(`Failed (${failed})`, lx + 143, ly + 1);
  }

  drawSeverityChart() {
    const canvas = document.getElementById('severityChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { bySeverity = {} } = this.metrics.audit || {};
    const keys = Object.keys(bySeverity);
    if (keys.length === 0) { this.drawEmptyChart(canvas, 'No audit data'); return; }

    const { dpr, w, h } = this.setupCanvas(canvas);
    ctx.clearRect(0, 0, w, h);

    const colors = { info: '#4a80f0', warn: '#e8b830', error: '#e86060', critical: '#e86060' };
    const total = keys.reduce((s, k) => s + (bySeverity[k] || 0), 0) || 1;
    const cx = w / 2;
    const cy = h / 2 + 5;
    const r = Math.min(w * 0.3, 55);
    const lineW = 22;

    let startAngle = -Math.PI / 2;
    ctx.lineCap = 'round';

    keys.forEach(key => {
      const angle = ((bySeverity[key] || 0) / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, startAngle, startAngle + angle);
      ctx.strokeStyle = colors[key] || '#4f5480';
      ctx.lineWidth = lineW;
      ctx.stroke();
      startAngle += angle;
    });

    ctx.fillStyle = '#e2e6f0';
    ctx.font = 'bold 18px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Audit Events', cx, cy - 8);
    ctx.fillStyle = '#4f5480';
    ctx.font = '11px system-ui';
    ctx.fillText(`${total} total`, cx, cy + 14);
  }

  drawResponseTimeChart() {
    // Handled separately via renderResponseTimeChart
  }

  drawEmptyChart(canvas, msg) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { dpr, w, h } = this.setupCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#4f5480';
    ctx.font = '13px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg, w / 2, h / 2);
  }

  // ─── Response Time Chart ────────────────────────────
  renderResponseTimeChart() {
    if (this.currentTab !== 'sync') return;
    const canvas = document.getElementById('responseTimeChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!this.metrics) return;

    const { responseTimes = {} } = this.metrics;
    const items = [
      { label: 'GraphQL', data: responseTimes.graphql, color: '#4a80f0' },
      { label: 'Sync', data: responseTimes.sync, color: '#22d4d4' },
      { label: 'API', data: responseTimes.api, color: '#9678e8' },
    ];

    const { dpr, w, h } = this.setupCanvas(canvas);
    ctx.clearRect(0, 0, w, h);

    const startX = 120;
    const chartW = w - startX - 40;
    const chartH = h - 50;
    const barGap = 30;
    const groupW = (chartW - items.length * barGap) / items.length;
    const barCount = 3; // avg, min, max
    const barW = Math.min(groupW / barCount * 0.7, 30);

    const allValues = items.flatMap(i => {
      const d = i.data || {};
      return [d.avgMs || 0, d.minMs || 0, d.maxMs || 0];
    });
    const maxVal = Math.max(...allValues, 1) * 1.15;
    const scaleY = chartH / maxVal;

    // Y axis grid
    const gridLines = 4;
    for (let i = 0; i <= gridLines; i++) {
      const val = (maxVal / gridLines) * i;
      const y = h - 30 - val * scaleY;
      ctx.strokeStyle = 'rgba(30, 35, 80, 0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(w - 20, y);
      ctx.stroke();
      ctx.fillStyle = '#4f5480';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(val)}ms`, startX - 8, y + 3);
    }

    // Bars
    items.forEach((item, i) => {
      const d = item.data || {};
      const x = startX + i * (groupW + barGap) + (groupW - barCount * barW) / 2;
      const stats = [
        { label: 'Avg', val: d.avgMs || 0, color: item.color },
        { label: 'Min', val: d.minMs || 0, color: this.lighten(item.color, 0.4) },
        { label: 'Max', val: d.maxMs === Infinity ? 0 : d.maxMs || 0, color: this.darken(item.color, 0.3) },
      ];

      stats.forEach((s, j) => {
        const barH = s.val * scaleY;
        const bx = x + j * (barW + 3);
        const by = h - 30 - barH;
        ctx.fillStyle = s.color;
        this.roundRect(ctx, bx, by, barW, barH, 3);
        ctx.fill();
      });

      // Label
      ctx.fillStyle = '#8b90b0';
      ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(item.label, x + (barCount * barW + 3 * (barCount - 1)) / 2, h - 10);
    });
  }

  // ─── Sync Events Feed ───────────────────────────────
  updateEvents() {
    const container = document.getElementById('recentEvents');
    if (!container) return;
    const events = this.metrics.sync.recentEvents || [];
    const dirs = this.metrics.sync.byDirection || {};
    const dirEntries = Object.entries(dirs);

    if (events.length === 0 && Object.keys(dirs).length === 0) {
      container.innerHTML = '<div class="loading">No sync events yet.</div>';
      return;
    }

    let html = '';
    // Show recent events
    for (const evt of events.slice(0, 12)) {
      const status = evt.status === 'SUCCESS' || evt.status === 'success' ? 'success' : 'failed';
      const dirClass = this.getDirectionClass(evt.direction || '');
      html += `<div class="event-item">
        <span class="event-dot ${status}"></span>
        <div class="event-meta">
          <span class="event-direction ${dirClass}">${this.formatDirection(evt.direction || '')}</span>
          <span class="event-message" title="${this.escapeHtml(evt.message || '')}">${this.escapeHtml((evt.message || evt.entityType || '').substring(0, 50))}</span>
        </div>
        <span class="event-time">${evt.timestamp ? this.formatTime(evt.timestamp) : ''}</span>
      </div>`;
    }

    container.innerHTML = html || '<div class="loading">No recent events.</div>';

    // Full event list in Sync tab
    const fullContainer = document.getElementById('fullEventList');
    if (fullContainer) {
      let fullHtml = '';
      for (const evt of events.slice(0, 50)) {
        const status = evt.status === 'SUCCESS' || evt.status === 'success' ? 'success' : 'failed';
        const dirClass = this.getDirectionClass(evt.direction || '');
        fullHtml += `<div class="event-item">
          <span class="event-dot ${status}"></span>
          <div class="event-meta">
            <span class="event-direction ${dirClass}">${this.formatDirection(evt.direction || '')}</span>
            <span class="event-message" title="${this.escapeHtml(JSON.stringify(evt.payload || ''))}">${this.escapeHtml((evt.message || evt.entityType || 'No message').substring(0, 80))}</span>
          </div>
          <span class="event-time">${evt.timestamp ? this.formatTime(evt.timestamp) : ''}</span>
        </div>`;
      }
      fullContainer.innerHTML = fullHtml || '<div class="loading">No events.</div>';
    }
  }

  // ─── Direction Table ────────────────────────────────
  updateDirectionTable() {
    const body = document.getElementById('directionBody');
    if (!body) return;
    const dirs = this.metrics.sync.byDirection || {};
    const total = this.metrics.sync.total || 0;
    const entries = Object.entries(dirs);
    if (entries.length === 0) {
      body.innerHTML = '<tr><td colspan="4" class="loading">No data.</td></tr>';
      return;
    }
    body.innerHTML = entries.map(([dir, count]) => {
      const pct = total > 0 ? ((count / total) * 100).toFixed(1) : 0;
      const dirClass = this.getDirectionClass(dir);
      return `<tr>
        <td><span class="event-direction ${dirClass}">${this.formatDirection(dir)}</span></td>
        <td>${count}</td>
        <td>${pct}%</td>
        <td><span class="badge ${count > 0 ? 'success' : ''}">${count > 0 ? 'Active' : 'Inactive'}</span></td>
      </tr>`;
    }).join('');
  }

  updateEntityTable() {
    const body = document.getElementById('entityBody');
    if (!body) return;
    const entities = this.metrics.sync.byEntityType || {};
    const total = this.metrics.sync.total || 0;
    const entries = Object.entries(entities);
    if (entries.length === 0) {
      body.innerHTML = '<tr><td colspan="3" class="loading">No data.</td></tr>';
      return;
    }
    body.innerHTML = entries.map(([type, count]) => {
      const pct = total > 0 ? ((count / total) * 100).toFixed(1) : 0;
      return `<tr><td><code>${this.escapeHtml(type)}</code></td><td>${count}</td><td>${pct}%</td></tr>`;
    }).join('');
  }

  // ─── Rate Limit Table ───────────────────────────────
  updateRateLimitTable() {
    const body = document.getElementById('rateLimitBody');
    if (!body) return;
    const keys = this.metrics.rateLimiter.keys || {};
    const entries = Object.entries(keys);
    if (entries.length === 0) {
      body.innerHTML = '<tr><td colspan="4" class="loading">No rate limit data yet.</td></tr>';
      return;
    }
    body.innerHTML = entries.map(([key, data]) => {
      return `<tr>
        <td><code title="${this.escapeHtml(key)}">${this.escapeHtml(key.substring(0, 40))}${key.length > 40 ? '…' : ''}</code></td>
        <td><span class="badge ${data.allowed ? 'allowed' : 'blocked'}">${data.allowed ? 'Allowed' : 'Blocked'}</span></td>
        <td>${data.remaining}</td>
        <td class="event-time">${data.resetAt ? this.formatTime(data.resetAt) : '--'}</td>
      </tr>`;
    }).join('');

    // Update config display
    this.setText('rlWindow', '60,000 ms');
    this.setText('rlMax', '100');
  }

  // ─── Retry Handler Table ────────────────────────────
  updateRetryTable() {
    const body = document.getElementById('retryBody');
    if (!body) return;
    const ops = this.metrics.retry.operationHistory || [];
    if (ops.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="loading">No retry operations recorded.</td></tr>';
      return;
    }
    body.innerHTML = ops.slice(0, 30).map(op => {
      const statusBadge = op.state === 'succeeded' ? 'succeeded' : op.state === 'exhausted' ? 'exhausted' : 'active';
      return `<tr>
        <td><code>${this.escapeHtml(op.operationName)}</code></td>
        <td>${op.attempt}</td>
        <td>${op.maxAttempts}</td>
        <td><span class="badge ${statusBadge}">${op.state}</span></td>
        <td class="event-time">${op.startedAt ? this.formatTime(op.startedAt) : '--'}</td>
        <td style="color: var(--accent-red); font-size: 0.72rem; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${op.lastError ? this.escapeHtml(op.lastError.substring(0, 50)) : '—'}</td>
      </tr>`;
    }).join('');

    this.setText('retryMaxAttempts', '5');
    this.setText('retryBaseDelay', '1,000 ms');
    this.setText('retryMaxDelay', '60,000 ms');
  }

  // ─── Audit Log ──────────────────────────────────────
  updateAuditTable() {
    const body = document.getElementById('auditBody');
    if (!body) return;
    const entries = this.metrics.audit.recentEntries || [];
    const filtered = this.auditFilter === 'all'
      ? entries
      : entries.filter(e => e.severity === this.auditFilter);

    if (filtered.length === 0) {
      body.innerHTML = '<tr><td colspan="6" class="loading">No audit entries.</td></tr>';
      return;
    }
    body.innerHTML = filtered.slice(0, 50).map(entry => {
      return `<tr>
        <td class="event-time">${entry.timestamp ? this.formatTime(entry.timestamp) : '--'}</td>
        <td><code>${this.escapeHtml(entry.eventType)}</code></td>
        <td><span class="severity-badge ${entry.severity}">${entry.severity}</span></td>
        <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${this.escapeHtml(entry.message || '').substring(0, 60)}</td>
        <td class="event-time">${entry.userId || '—'}</td>
        <td class="event-time">${entry.source || 'api-bridge'}</td>
      </tr>`;
    }).join('');
  }

  renderAuditCharts() {
    if (this.currentTab !== 'audit') return;
    if (!this.metrics) return;

    // Severity chart (horizontal bars)
    const severityCanvas = document.getElementById('auditSeverityChart');
    if (severityCanvas) {
      const ctx = severityCanvas.getContext('2d');
      if (ctx) {
        const { bySeverity = {} } = this.metrics.audit || {};
        const keys = Object.keys(bySeverity);
        const { dpr, w, h } = this.setupCanvas(severityCanvas);
        ctx.clearRect(0, 0, w, h);
        const colors = { info: '#4a80f0', warn: '#e8b830', error: '#e86060', critical: '#e86060' };
        const total = keys.reduce((s, k) => s + (bySeverity[k] || 0), 0) || 1;
        const barH = 22;
        const gap = 8;
        const startY = (h - keys.length * (barH + gap)) / 2;

        keys.forEach((key, i) => {
          const y = startY + i * (barH + gap);
          const pct = ((bySeverity[key] || 0) / total) * 100;
          const barW = Math.max(4, (pct / 100) * (w - 160));
          ctx.fillStyle = '#8b90b0';
          ctx.font = '11px system-ui';
          ctx.textAlign = 'right';
          ctx.fillText(key, 70, y + 15);
          ctx.fillStyle = '#13173a';
          this.roundRect(ctx, 76, y + 1, w - 90, barH, 4);
          ctx.fill();
          ctx.fillStyle = colors[key] || '#4f5480';
          this.roundRect(ctx, 76, y + 1, barW, barH, 4);
          ctx.fill();
          ctx.fillStyle = '#e2e6f0';
          ctx.font = '600 11px system-ui';
          ctx.textAlign = 'left';
          ctx.fillText(`${bySeverity[key]} (${pct.toFixed(0)}%)`, 82 + barW, y + 16);
        });
      }
    }

    // Event type chart (simplified)
    const typeCanvas = document.getElementById('auditTypeChart');
    if (typeCanvas) {
      const ctx = typeCanvas.getContext('2d');
      if (ctx) {
        const { byEventType = {} } = this.metrics.audit || {};
        const entries = Object.entries(byEventType).sort((a, b) => b[1] - a[1]).slice(0, 8);
        if (entries.length === 0) {
          this.drawEmptyChart(typeCanvas, 'No data');
          return;
        }
        const { dpr, w, h } = this.setupCanvas(typeCanvas);
        ctx.clearRect(0, 0, w, h);
        const colors = ['#4a80f0', '#22d4d4', '#9678e8', '#2ec48e', '#e8b830', '#e86060', '#e88440', '#e060a0'];
        const total = entries.reduce((s, e) => s + e[1], 0) || 1;
        const barH = 18;
        const gap = 6;
        const startY = (h - entries.length * (barH + gap)) / 2;

        entries.forEach(([type, count], i) => {
          const y = startY + i * (barH + gap);
          const pct = (count / total) * 100;
          const barW = Math.max(3, (pct / 100) * (w - 150));
          ctx.fillStyle = '#8b90b0';
          ctx.font = '10px system-ui';
          ctx.textAlign = 'right';
          ctx.fillText(type.substring(0, 16), 110, y + 13);
          ctx.fillStyle = '#13173a';
          this.roundRect(ctx, 116, y, w - 130, barH, 3);
          ctx.fill();
          ctx.fillStyle = colors[i % colors.length];
          this.roundRect(ctx, 116, y, barW, barH, 3);
          ctx.fill();
        });
      }
    }
  }

  // ─── Adapter Status ─────────────────────────────────
  updateAdapterStatus() {
    const status = this.metrics.adapters || {};
    ['soap', 'sql', 'redis'].forEach(name => {
      const el = document.getElementById(`${name}Status`);
      if (!el) return;
      const s = status[name]?.status || 'disconnected';
      el.textContent = s === 'connected' ? 'Connected' : s === 'error' ? 'Error' : 'Disconnected';
      el.className = `status-badge ${s}`;
    });

    const soap = status.soap || {};
    const sql = status.sql || {};
    this.setText('soapCalls', (soap.totalCalls || 0).toLocaleString());
    this.setText('soapErrors', (soap.errorCount || 0).toLocaleString());
    this.setText('soapLastCall', soap.lastCall ? this.formatTime(soap.lastCall) : '--');
    this.setText('sqlCalls', (sql.totalCalls || 0).toLocaleString());
    this.setText('sqlErrors', (sql.errorCount || 0).toLocaleString());
    this.setText('sqlLastCall', sql.lastCall ? this.formatTime(sql.lastCall) : '--');

    const redis = status.redis || {};
    this.setText('redisUptime', redis.uptime > 0 ? this.formatDuration(Date.now() - redis.uptime) : '--');
  }

  // ─── Configuration Viewer ───────────────────────────
  updateConfig() {
    const cfg = this.metrics.config || {};
    this.renderConfigSection('configServer', cfg, ['port', 'nodeEnv']);
    this.renderConfigSection('configSecurity', cfg.security || {}, ['authEnabled', 'jwtExpiresIn', 'graphqlIntrospection', 'maxQueryDepth', 'dashboardAuthEnabled', 'corsOrigins', 'maxPayloadSize', 'jwtSecret', 'encryptionKey']);
    this.renderConfigSection('configRedis', cfg.redis || {}, ['host', 'port', 'keyPrefix']);
    this.renderConfigSection('configRetry', cfg.retry || {}, ['maxAttempts', 'baseDelayMs', 'maxDelayMs']);
    this.renderConfigSection('configSoap', cfg.soap || {}, ['wsdlUrl', 'timeoutMs']);
    this.renderConfigSection('configSql', cfg.sql || {}, ['connectionString', 'schema', 'timeoutMs']);
    this.renderConfigSection('configSync', cfg.sync || {}, ['pollIntervalMs', 'batchSize']);
    this.renderConfigSection('configLog', cfg.log || {}, ['level', 'prettyPrint']);
  }

  renderConfigSection(containerId, data, keys) {
    const container = document.getElementById(containerId);
    if (!container || !data) return;
    const maskedKeys = ['jwtSecret', 'encryptionKey', 'password', 'secret', 'token'];
    container.innerHTML = keys.map(key => {
      const val = data[key];
      if (val === undefined || val === null) return '';
      const isMasked = maskedKeys.some(m => key.toLowerCase().includes(m));
      const displayVal = isMasked ? '••••••••' : Array.isArray(val) ? val.join(', ') : String(val);
      return `<div class="config-row">
        <span class="config-key">${key}</span>
        <span class="config-val ${isMasked ? 'masked' : ''}">${this.escapeHtml(displayVal)}</span>
      </div>`;
    }).filter(Boolean).join('') || '<div class="loading">No config data</div>';
  }

  // ─── Errors ─────────────────────────────────────────
  updateErrors() {
    const body = document.getElementById('errorsBody');
    if (!body) return;
    const errors = this.metrics.errors || [];
    if (errors.length === 0) {
      body.innerHTML = '<tr><td colspan="3" class="loading">No errors recorded. Bridge is healthy.</td></tr>';
      return;
    }
    body.innerHTML = errors.slice(0, 50).map(err => {
      return `<tr>
        <td class="event-time">${err.timestamp ? this.formatTime(err.timestamp) : '--'}</td>
        <td><code>${this.escapeHtml(err.source || '')}</code></td>
        <td style="color: var(--accent-red); max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${this.escapeHtml(err.error || '')}">${this.escapeHtml((err.error || err.message || '').substring(0, 80))}</td>
      </tr>`;
    }).join('');
  }

  // ─── Helpers ────────────────────────────────────────
  setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = (rect.height || 180) * dpr;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(dpr, dpr);
    return { dpr, w: rect.width, h: rect.height || 180 };
  }

  roundRect(ctx, x, y, w, h, r) {
    if (r > w / 2) r = w / 2;
    if (r > h / 2) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  lighten(hex, factor) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${Math.min(255, r + (255 - r) * factor)},${Math.min(255, g + (255 - g) * factor)},${Math.min(255, b + (255 - b) * factor)})`;
  }

  darken(hex, factor) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${Math.round(r * (1 - factor))},${Math.round(g * (1 - factor))},${Math.round(b * (1 - factor))})`;
  }

  formatDirection(dir) {
    const map = {
      'LEGACY_TO_SAAS': 'SOAP → SaaS',
      'SAAS_TO_LEGACY': 'SaaS → SOAP',
      'BIDIRECTIONAL': 'SOAP+SQL → SaaS',
      'sql_to_saas': 'SQL → SaaS',
      'saas_to_sql': 'SaaS → SQL',
    };
    return map[dir] || dir || 'Unknown';
  }

  getDirectionClass(dir) {
    const map = {
      'LEGACY_TO_SAAS': 'soap-to-saas',
      'SAAS_TO_LEGACY': 'saas-to-soap',
      'BIDIRECTIONAL': 'bidirectional',
      'sql_to_saas': 'sql-to-saas',
      'saas_to_sql': 'saas-to-sql',
    };
    return map[dir] || '';
  }

  formatDuration(ms) {
    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    const hrs = Math.floor(min / 60);
    const days = Math.floor(hrs / 24);
    if (days > 0) return `${days}d ${hrs % 24}h`;
    if (hrs > 0) return `${hrs}h ${min % 60}m`;
    if (min > 0) return `${min}m ${sec % 60}s`;
    return `${sec}s`;
  }

  formatTime(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return '--';
    }
  }

  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }
}

// ─── Start ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  new DashboardApp();
});
