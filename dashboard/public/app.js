/* ─── Dashboard App ────────────────────────────────────── */
class DashboardApp {
  constructor() {
    this.metrics = null;
    this.refreshInterval = null;
    this.init();
  }

  init() {
    this.setupTabs();
    this.setupRefreshButton();
    this.startAutoRefresh();
    this.fetchMetrics();
  }

  // ─── Tab Navigation ──────────────────────────────────
  setupTabs() {
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        document.querySelectorAll('.tab-content').forEach(tc => {
          tc.classList.remove('active');
        });
        document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
      });
    });
  }

  setupRefreshButton() {
    document.getElementById('refreshBtn').addEventListener('click', () => {
      this.fetchMetrics();
    });
  }

  startAutoRefresh() {
    this.refreshInterval = setInterval(() => this.fetchMetrics(), 5000);
  }

  // ─── API Fetch ───────────────────────────────────────
  async fetchMetrics() {
    try {
      const res = await fetch('/api/metrics');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.metrics = await res.json();
      this.updateUI();
    } catch (err) {
      console.error('Failed to fetch metrics:', err);
      this.showOffline();
    }
  }

  showOffline() {
    document.getElementById('healthText').textContent = 'Offline';
    document.querySelector('.health-dot').classList.add('error');
  }

  // ─── UI Update ───────────────────────────────────────
  updateUI() {
    if (!this.metrics) return;

    this.updateHealth();
    this.updateStats();
    this.updateCharts();
    this.updateEvents();
    this.updateDirectionTable();
    this.updateRateLimitTable();
    this.updateAdapterStatus();
    this.updateErrors();
  }

  updateHealth() {
    const { uptime, adapterStatus, timestamp } = this.metrics;
    const allConnected = Object.values(adapterStatus).every(s => s === 'connected');
    const healthText = document.getElementById('healthText');
    const healthDot = document.querySelector('.health-dot');

    healthText.textContent = allConnected ? 'All Connected' : 'Degraded';
    healthDot.classList.toggle('error', !allConnected);

    document.getElementById('uptime').textContent = `Uptime: ${this.formatDuration(uptime)}`;
  }

  updateStats() {
    const { syncOperations } = this.metrics;
    const total = syncOperations.total;
    const success = syncOperations.success;
    const failed = syncOperations.failed;
    const rate = total > 0 ? ((success / total) * 100).toFixed(1) : '100';

    document.getElementById('totalOps').textContent = total.toLocaleString();
    document.getElementById('successOps').textContent = success.toLocaleString();
    document.getElementById('failedOps').textContent = failed.toLocaleString();
    document.getElementById('successRate').textContent = `${rate}%`;
    document.getElementById('badgeSuccess').textContent = `${success} successful`;
    document.getElementById('badgeFailed').textContent = `${failed} failed`;
    document.getElementById('badgeTotal').textContent = `${total} total`;
  }

  updateCharts() {
    this.drawDirectionChart();
    this.drawSuccessChart();
  }

  drawDirectionChart() {
    const canvas = document.getElementById('directionChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const data = this.metrics.syncOperations.byDirection;
    const labels = Object.keys(data);
    const values = Object.values(data);
    const colors = ['#4f8cff', '#a78bfa', '#27e0e0'];
    const total = values.reduce((a, b) => a + b, 0) || 1;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 220 * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = 220;
    const barArea = w - 160;
    const barH = 28;
    const gap = 12;
    const startY = (h - (labels.length * (barH + gap))) / 2;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Title
    ctx.fillStyle = '#5c5f73';
    ctx.font = '12px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText('Sync Operations by Direction', 0, 16);

    // Bars
    labels.forEach((label, i) => {
      const y = startY + i * (barH + gap);
      const pct = (values[i] / total) * 100;
      const barW = Math.max(4, (pct / 100) * barArea);

      // Label
      ctx.fillStyle = '#9598a8';
      ctx.font = '12px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(this.formatDirection(label), 150, y + 18);

      // Bar background
      ctx.fillStyle = '#1a1d2e';
      ctx.beginPath();
      ctx.roundRect(156, y + 2, barArea - 4, barH, 4);
      ctx.fill();

      // Bar fill
      ctx.fillStyle = colors[i % colors.length];
      ctx.beginPath();
      ctx.roundRect(156, y + 2, barW - 4, barH, 4);
      ctx.fill();

      // Value
      ctx.fillStyle = '#e8eaf0';
      ctx.font = '600 13px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText(`${values[i]} (${pct.toFixed(0)}%)`, 164 + barW, y + 20);
    });
  }

  drawSuccessChart() {
    const canvas = document.getElementById('successChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { success, failed } = this.metrics.syncOperations;
    const total = success + failed || 1;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 220 * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = 220;
    const cx = w / 2;
    const cy = h / 2 + 10;
    const r = 70;
    const lineW = 28;

    ctx.clearRect(0, 0, w, h);

    // Draw donut
    const successAngle = (success / total) * Math.PI * 2;
    const failedAngle = (failed / total) * Math.PI * 2;

    // Background ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#1a1d2e';
    ctx.lineWidth = lineW;
    ctx.stroke();

    // Success arc
    if (success > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + successAngle);
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = lineW;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // Failed arc
    if (failed > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2 + successAngle, -Math.PI / 2 + successAngle + failedAngle);
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = lineW;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // Center text
    ctx.fillStyle = '#e8eaf0';
    ctx.font = '700 24px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${((success / total) * 100).toFixed(0)}%`, cx, cy - 8);

    ctx.fillStyle = '#5c5f73';
    ctx.font = '12px system-ui';
    ctx.fillText('Success Rate', cx, cy + 16);

    // Legend
    const legendY = h - 20;
    ctx.font = '12px system-ui';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = '#34d399';
    ctx.fillRect(cx - 100, legendY - 4, 10, 10);
    ctx.fillStyle = '#9598a8';
    ctx.textAlign = 'left';
    ctx.fillText(`Success (${success})`, cx - 86, legendY + 1);

    ctx.fillStyle = '#f87171';
    ctx.fillRect(cx + 40, legendY - 4, 10, 10);
    ctx.fillStyle = '#9598a8';
    ctx.fillText(`Failed (${failed})`, cx + 54, legendY + 1);
  }

  updateEvents() {
    const container = document.getElementById('recentEvents');
    if (!this.metrics.recentErrors && !this.metrics.syncOperations.total) {
      container.innerHTML = '<div class="loading">No sync events yet. Perform a sync operation to see it here.</div>';
      return;
    }

    // Show recent errors as events if we have them, otherwise show a message
    const errors = this.metrics.recentErrors || [];
    const ops = this.metrics.syncOperations;

    if (ops.total === 0 && errors.length === 0) {
      container.innerHTML = '<div class="loading">No sync events yet. Perform a sync operation to see it here.</div>';
      return;
    }

    let html = '';
    const dirs = Object.entries(ops.byDirection);

    // Show direction stats as pseudo-events
    for (const [dir, count] of dirs.slice(0, 5)) {
      const status = 'success';
      const dirClass = this.getDirectionClass(dir);
      html += `
        <div class="event-item">
          <span class="event-dot success"></span>
          <div class="event-meta">
            <span class="event-direction ${dirClass}">${this.formatDirection(dir)}</span>
            <span class="event-message">${count} operations completed</span>
          </div>
          <span class="event-time">Total: ${count}</span>
        </div>`;
    }

    // Show recent errors
    for (const err of errors.slice(0, 10)) {
      html += `
        <div class="event-item">
          <span class="event-dot failed"></span>
          <div class="event-meta">
            <span class="event-message" title="${this.escapeHtml(err.error)}">${this.escapeHtml(err.operation)} — ${this.escapeHtml(err.error.substring(0, 50))}${err.error.length > 50 ? '…' : ''}</span>
          </div>
          <span class="event-time">${this.formatTime(err.timestamp)}</span>
        </div>`;
    }

    container.innerHTML = html;
  }

  updateDirectionTable() {
    const body = document.getElementById('directionBody');
    const dirs = this.metrics.syncOperations.byDirection;
    const total = this.metrics.syncOperations.total;

    const entries = Object.entries(dirs);
    if (entries.length === 0) {
      body.innerHTML = '<tr><td colspan="3" class="loading">No sync operations recorded.</td></tr>';
      return;
    }

    body.innerHTML = entries.map(([dir, count]) => `
      <tr>
        <td>${this.formatDirection(dir)}</td>
        <td>${count}</td>
        <td>${total > 0 ? ((count / total) * 100).toFixed(1) : 0}%</td>
      </tr>
    `).join('');
  }

  updateRateLimitTable() {
    const body = document.getElementById('rateLimitBody');
    const keys = this.metrics.rateLimiter.keys || {};

    const entries = Object.entries(keys);
    if (entries.length === 0) {
      body.innerHTML = '<tr><td colspan="3" class="loading">No rate limit data. Perform some operations first.</td></tr>';
      return;
    }

    body.innerHTML = entries.map(([key, data]) => `
      <tr>
        <td><code>${this.escapeHtml(key)}</code></td>
        <td><span class="badge ${data.allowed ? 'allowed' : 'blocked'}">${data.allowed ? 'Allowed' : 'Blocked'}</span></td>
        <td>${data.remaining}</td>
      </tr>
    `).join('');
  }

  updateAdapterStatus() {
    const status = this.metrics.adapterStatus;
    ['soap', 'sql', 'redis'].forEach(name => {
      const el = document.getElementById(`${name}Status`);
      if (el) {
        const s = status[name];
        el.textContent = s === 'connected' ? 'Connected' : s === 'error' ? 'Error' : 'Disconnected';
        el.className = `status-badge ${s}`;
      }
    });
  }

  updateErrors() {
    const body = document.getElementById('errorsBody');
    const errors = this.metrics.recentErrors || [];

    if (errors.length === 0) {
      body.innerHTML = '<tr><td colspan="3" class="loading">No errors recorded. Bridge is healthy.</td></tr>';
      return;
    }

    body.innerHTML = errors.map(err => `
      <tr>
        <td class="event-time">${this.formatTime(err.timestamp)}</td>
        <td><code>${this.escapeHtml(err.operation)}</code></td>
        <td style="color: var(--accent-red)">${this.escapeHtml(err.error.substring(0, 80))}</td>
      </tr>
    `).join('');
  }

  // ─── Helpers ──────────────────────────────────────────
  formatDirection(dir) {
    const map = {
      'LEGACY_TO_SAAS': 'SOAP → SaaS',
      'SAAS_TO_LEGACY': 'SaaS → SOAP',
      'BIDIRECTIONAL': 'SOAP+SQL → SaaS',
      'sql_to_saas': 'SQL → SaaS',
      'saas_to_sql': 'SaaS → SQL',
    };
    return map[dir] || dir;
  }

  getDirectionClass(dir) {
    const map = {
      'LEGACY_TO_SAAS': 'soap-to-saas',
      'SAAS_TO_LEGACY': 'saas-to-soap',
      'BIDIRECTIONAL': 'bidirectional',
      'sql_to_saas': 'soap-to-saas',
      'saas_to_sql': 'saas-to-soap',
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
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

// ─── Polyfill for roundRect (for older browsers) ─────────
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
    if (r > w / 2) r = w / 2;
    if (r > h / 2) r = h / 2;
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w, y + h, r);
    this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r);
    this.arcTo(x, y, x + w, y, r);
    return this;
  };
}

// ─── Start ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  new DashboardApp();
});
