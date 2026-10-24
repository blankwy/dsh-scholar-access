// Client half of dsh-scholar-access.
//
// Renders the plugin's configuration page (Plugins -> 校园网学术通道加速) and a
// one-line summary in the plugin row. All state comes from the Host bridge at
// /api/scholar-access/*; this module owns no network logic of its own.

window.__ModuleLoader__.load({
  id: 'dsh-scholar-access',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const API = '/api/scholar-access';

    // Read by the row summary renderer, refreshed on every successful status call.
    let lastSummary = '通道加速 · 读取中';

    const CSS = [
      '.dsa-card{display:flex;flex-direction:column;gap:18px;max-width:720px;padding:4px 2px 8px;font-size:13px;line-height:1.5;color:var(--dsw-alias-text-primary,#111827)}',
      '.dsa-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.dsa-title{font-size:15px;font-weight:600;letter-spacing:.01em}',
      '.dsa-sub{margin-top:2px;font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.dsa-pill{display:inline-flex;align-items:center;gap:6px;flex:none;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:500;border:1px solid transparent}',
      '.dsa-pill::before{content:"";width:6px;height:6px;border-radius:999px;background:currentColor}',
      '.dsa-pill-on{color:var(--dsw-alias-state-success,#15803d);background:var(--dsw-alias-bg-success-subtle,#f0fdf4);border-color:var(--dsw-alias-border-success,#bbf7d0)}',
      '.dsa-pill-off{color:var(--dsw-alias-text-secondary,#6b7280);background:var(--dsw-alias-bg-secondary,#f3f4f6);border-color:var(--dsw-alias-border-subtle,#e5e7eb)}',
      '.dsa-pill-warn{color:var(--dsw-alias-state-danger,#b91c1c);background:var(--dsw-alias-bg-danger-subtle,#fef2f2);border-color:var(--dsw-alias-border-danger,#fecaca)}',
      '.dsa-section{border:1px solid var(--dsw-alias-border-subtle,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-elevated,#fff);overflow:hidden}',
      '.dsa-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,#e5e7eb);font-size:12px;font-weight:600;color:var(--dsw-alias-text-secondary,#4b5563)}',
      '.dsa-row{display:flex;align-items:baseline;justify-content:space-between;gap:14px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,#f3f4f6)}',
      '.dsa-row:last-child{border-bottom:none}',
      '.dsa-label{flex:none;font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280)}',
      '.dsa-value{min-width:0;text-align:right;font-size:12px;word-break:break-all}',
      '.dsa-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}',
      '.dsa-muted{color:var(--dsw-alias-text-tertiary,#9ca3af)}',
      '.dsa-good{color:var(--dsw-alias-state-success,#15803d)}',
      '.dsa-bad{color:var(--dsw-alias-state-danger,#b91c1c)}',
      '.dsa-switch{position:relative;flex:none;width:38px;height:22px;padding:0;border:none;border-radius:999px;cursor:pointer;background:var(--dsw-alias-border-strong,#d1d5db);transition:background .15s ease}',
      '.dsa-switch[aria-checked="true"]{background:var(--dsw-alias-accent-base,#4c6fff)}',
      '.dsa-switch:disabled{cursor:progress;opacity:.6}',
      '.dsa-knob{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:999px;background:#fff;transition:transform .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.25)}',
      '.dsa-switch[aria-checked="true"] .dsa-knob{transform:translateX(16px)}',
      '.dsa-switch:focus-visible{outline:2px solid var(--dsw-alias-accent-base,#4c6fff);outline-offset:2px}',
      '.dsa-switchrow{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px}',
      '.dsa-switchlabel{font-size:13px;font-weight:500}',
      '.dsa-switchhint{margin-top:2px;font-size:11.5px;color:var(--dsw-alias-text-tertiary,#9ca3af)}',
      '.dsa-seg{display:inline-flex;padding:2px;border-radius:7px;background:var(--dsw-alias-bg-secondary,#f3f4f6);border:1px solid var(--dsw-alias-border-subtle,#e5e7eb)}',
      '.dsa-segbtn{padding:4px 10px;border:none;border-radius:5px;background:transparent;font-size:12px;color:var(--dsw-alias-text-secondary,#6b7280);cursor:pointer}',
      '.dsa-segbtn[data-active="true"]{background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-text-primary,#111827);box-shadow:0 1px 2px rgba(0,0,0,.08);font-weight:500}',
      '.dsa-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 14px;border-radius:7px;border:1px solid var(--dsw-alias-border-strong,#d1d5db);background:var(--dsw-alias-bg-elevated,#fff);font-size:12.5px;font-weight:500;color:var(--dsw-alias-text-primary,#111827);cursor:pointer}',
      '.dsa-btn:hover:not(:disabled){background:var(--dsw-alias-bg-secondary,#f9fafb)}',
      '.dsa-btn:disabled{cursor:progress;opacity:.65}',
      '.dsa-btn-primary{border-color:transparent;background:var(--dsw-alias-accent-base,#4c6fff);color:#fff}',
      '.dsa-btn-primary:hover:not(:disabled){background:var(--dsw-alias-accent-hover,#3b5bdb)}',
      '.dsa-link{color:var(--dsw-alias-accent-base,#4c6fff);text-decoration:none;font-size:12px}',
      '.dsa-link:hover{text-decoration:underline}',
      '.dsa-results{display:flex;flex-direction:column}',
      '.dsa-res{padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,#f3f4f6);display:flex;align-items:baseline;gap:10px}',
      '.dsa-res:last-child{border-bottom:none}',
      '.dsa-res.dsa-dim{opacity:.45}',
      '.dsa-reshost{flex:none;width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsa-resdetail{min-width:0;flex:1;font-size:11.5px;word-break:break-all}',
      '.dsa-tag{flex:none;padding:1px 6px;border-radius:4px;font-size:10.5px;border:1px solid var(--dsw-alias-border-subtle,#e5e7eb);color:var(--dsw-alias-text-tertiary,#9ca3af)}',
      '.dsa-foot{font-size:11.5px;color:var(--dsw-alias-text-tertiary,#9ca3af);line-height:1.6}',
      '.dsa-error{padding:10px 12px;border:1px solid var(--dsw-alias-border-danger,#fecaca);background:var(--dsw-alias-bg-danger-subtle,#fef2f2);border-radius:8px;font-size:12px;color:var(--dsw-alias-state-danger,#b91c1c);word-break:break-all}',
      '.dsa-notice{padding:10px 12px;border:1px solid var(--dsw-alias-border-warning,#fde68a);background:var(--dsw-alias-bg-warning-subtle,#fffbeb);border-radius:8px;font-size:12px;color:var(--dsw-alias-text-primary,#78350f);line-height:1.6}',
      '.dsa-actions{display:flex;gap:8px;flex:none}',
      '.dsa-pad{padding:10px 12px 2px}',
      '@media (prefers-reduced-motion: reduce){.dsa-switch,.dsa-knob{transition:none}}',
      '@media (max-width:560px){.dsa-reshost{width:120px}}',
    ].join('');

    async function callApi(path, init) {
      const response = await fetch(API + path, init);
      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { ok: false, error: text.slice(0, 200) || 'invalid JSON' };
      }
      if (!response.ok && body && body.error === undefined) body.error = 'HTTP ' + response.status;
      return body;
    }

    function message(error) {
      return error && error.message ? error.message : String(error);
    }

    function fingerprintShort(value) {
      if (!value) return '—';
      return String(value).split(':').slice(0, 6).join(':');
    }

    function Row(props) {
      return h(
        'div',
        { className: 'dsa-row' },
        h('span', { className: 'dsa-label' }, props.label),
        h('span', { className: 'dsa-value' + (props.mono ? ' dsa-mono' : '') + (props.className ? ' ' + props.className : '') }, props.children)
      );
    }

    function Switch(props) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': props.checked ? 'true' : 'false',
          'aria-label': props.label || '开关',
          className: 'dsa-switch',
          disabled: props.disabled,
          onClick: props.onClick,
        },
        h('span', { className: 'dsa-knob' })
      );
    }

    function Card() {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [testing, setTesting] = React.useState(false);
      const [result, setResult] = React.useState(null);
      const [testError, setTestError] = React.useState(null);
      const [certScan, setCertScan] = React.useState(null);
      const [certBusy, setCertBusy] = React.useState(false);
      const [certNote, setCertNote] = React.useState(null);

      const refresh = React.useCallback(async () => {
        try {
          const next = await callApi('/status');
          setStatus(next);
          setError(next && next.ok === false ? next.error || '状态接口返回失败' : null);
          const enabledNext = next && next.enabled;
          const channelCount = next && next.traffic ? next.traffic.channel : 0;
          lastSummary =
            '通道加速 · ' +
            (next && next.active ? '生效' : enabledNext ? '待信任证书' : '已关闭') +
            (channelCount ? ' · ' + channelCount + ' 次走通道' : '');
        } catch (failure) {
          setError(message(failure));
        }
      }, []);

      React.useEffect(() => {
        refresh();
        scanStores();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      async function toggleSystemTrust(disabled) {
        const text = disabled
          ? '将把 Scholar Root CA v1 加入「不信任证书」库：证书不删除，但整机不再信任它，scholartools / openbrowser 会暂时失效。需要管理员授权（会弹 UAC）。继续？'
          : '将从「不信任证书」库移除该证书：整机重新信任它，scholartools / openbrowser 恢复可用。需要管理员授权（会弹 UAC）。继续？';
        if (!window.confirm(text)) return;
        setCertBusy(true);
        setCertNote(null);
        try {
          const next = await callApi('/system-trust', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ disabled }),
          });
          if (!next || next.ok === false) {
            const reason = next && next.result && next.result.cancelled ? '已取消，未做任何改动' : (next && next.error) || '操作失败';
            throw new Error(reason);
          }
          setCertNote(disabled ? '系统信任已停用（证书仍保留在 Root，随时可恢复）。' : '系统信任已恢复。');
          setCertScan(next.after || null);
        } catch (failure) {
          setCertNote('失败：' + message(failure));
        } finally {
          setCertBusy(false);
        }
      }

      async function updateConfig(patch) {
        setSaving(true);
        setError(null);
        try {
          const next = await callApi('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          if (next && next.ok === false) throw new Error(next.error || '保存失败');
          await refresh();
        } catch (failure) {
          setError(message(failure));
        } finally {
          setSaving(false);
        }
      }

      async function runTest() {
        setTesting(true);
        setTestError(null);
        try {
          const next = await callApi('/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          if (next && next.ok === false && !next.results) throw new Error(next.error || '测试失败');
          setResult(next);
        } catch (failure) {
          setTestError(message(failure));
        } finally {
          setTesting(false);
        }
      }

      async function setTrust(trusted) {
        setCertBusy(true);
        setCertNote(null);
        try {
          const next = await callApi('/trust', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ trusted }),
          });
          if (next && next.ok === false) throw new Error(next.error || '操作失败');
          setCertNote(trusted ? '已信任：仅在本进程与它派生的子进程内生效，未写入系统证书库。' : '已注销：本地 PEM 已删除，通道立即停止。');
          await refresh();
        } catch (failure) {
          setCertNote('失败：' + message(failure));
        } finally {
          setCertBusy(false);
        }
      }

      async function scanStores() {
        setCertBusy(true);
        setCertNote(null);
        try {
          const next = await callApi('/system-certs');
          if (next && next.ok === false) throw new Error(next.error || '检查失败');
          setCertScan(next);
        } catch (failure) {
          setCertNote('检查失败：' + message(failure));
        } finally {
          setCertBusy(false);
        }
      }

      async function removeStore(scope, store) {
        if (scope === 'machine' && !window.confirm('将从「本机」证书库删除 Scholar Root CA v1，所有依赖该通道的程序（含 scholartools）都会失效。继续会弹出管理员授权窗口。')) return;
        setCertBusy(true);
        setCertNote(null);
        try {
          const next = await callApi('/system-certs/remove', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scope, store }),
          });
          if (!next || next.ok === false) throw new Error((next && next.error) || '删除失败');
          setCertNote('已从系统证书库移除。');
          setCertScan(next.after || null);
        } catch (failure) {
          setCertNote('删除失败：' + message(failure));
        } finally {
          setCertBusy(false);
        }
      }

      const enabled = Boolean(status && status.enabled);
      const trusted = Boolean(status && status.trusted);
      const active = Boolean(status && status.active);
      const ca = (status && status.ca) || {};
      const pinned = ca.pinned && ca.pinned.fingerprint256;
      const live = ca.live && ca.live.fingerprint256;
      const caMatches = Boolean(pinned && live && pinned === live);
      const traffic = (status && status.traffic) || { channel: 0, direct: 0, failed: 0, hosts: {} };
      const trafficHosts = Object.keys(traffic.hosts || {})
        .map((host) => ({ host, entry: traffic.hosts[host] }))
        .sort((left, right) => (right.entry.channel || 0) - (left.entry.channel || 0) || left.host.localeCompare(right.host))
        .slice(0, 5);

      const results = (result && result.results) || [];
      const passed = results.filter((item) => item.ok).length;

      return h(
        'div',
        { className: 'dsa-card' },
        h('style', null, CSS),

        h(
          'div',
          { className: 'dsa-head' },
          h(
            'div',
            null,
            h('div', { className: 'dsa-title' }, '校园网学术通道加速'),
            h('div', { className: 'dsa-sub' }, 'doh.scholar.work · 学术资源反向代理 · 无需 scholartools.exe 常驻')
          ),
          h('span', { className: 'dsa-pill ' + (active ? 'dsa-pill-on' : enabled ? 'dsa-pill-warn' : 'dsa-pill-off') },
            !status ? '读取中' : active ? '通道生效' : enabled ? '待信任证书' : '已关闭')
        ),

        error ? h('div', { className: 'dsa-error' }, error) : null,

        enabled && !trusted
          ? h(
              'div',
              { className: 'dsa-notice' },
              '通道已开启，但根证书尚未信任 —— 国际站点目前仍走直连。在下方「证书信任」里确认指纹后点「信任证书」才会生效。'
            )
          : null,

        h(
          'div',
          { className: 'dsa-section' },
          h(
            'div',
            { className: 'dsa-switchrow' },
            h(
              'div',
              null,
              h('div', { className: 'dsa-switchlabel' }, '启用学术通道'),
              h('div', { className: 'dsa-switchhint' }, '接管宿主 fetch 与子进程国际流量；关闭后立即恢复直连')
            ),
            h(Switch, {
              checked: enabled,
              disabled: !status || saving,
              label: '启用学术通道',
              onClick: () => updateConfig({ enabled: !enabled }),
            })
          )
        ),

        h(
          'div',
          { className: 'dsa-section' },
          h('div', { className: 'dsa-section-head' }, h('span', null, '运行状态'), h('a', { className: 'dsa-link', href: '#', onClick: (event) => { event.preventDefault(); refresh(); } }, '刷新')),
          h(Row, { label: '通道解析 DoH', mono: true }, status ? status.doh.endpoint : '—'),
          h(
            Row,
            { label: 'DoH 健康' },
            !status
              ? '—'
              : status.dohHealth && status.dohHealth.ok
                ? h('span', { className: 'dsa-good' }, '正常 · ' + status.dohHealth.ms + ' ms' + (status.dohHealth.addresses && status.dohHealth.addresses[0] ? ' · ' + status.dohHealth.addresses[0] : ''))
                : h('span', { className: 'dsa-bad' }, '不可用' + (status.dohHealth && status.dohHealth.error ? ' · ' + status.dohHealth.error : ''))
          ),
          h(
            Row,
            { label: '本地转发代理', mono: Boolean(status && status.proxy && status.proxy.running) },
            !status ? '—' : status.proxy && status.proxy.running
              ? status.proxy.url + ' · 隧道 ' + (status.proxy.stats ? status.proxy.stats.connect : 0) + ' 次'
              : '未运行'
          ),
          h(
            Row,
            { label: '宿主 fetch 接管' },
            !status ? '—' : status.hostFetchPatched ? h('span', { className: 'dsa-good' }, '已接管') : h('span', { className: 'dsa-muted' }, '未接管')
          ),
          h(
            Row,
            { label: '子进程环境变量' },
            !status
              ? '—'
              : status.env && status.env.injected
                ? h('span', { className: 'dsa-good' }, '已注入 · ' + status.env.keys.length + ' 项')
                : h('span', { className: 'dsa-muted' }, '未注入')
          ),
          h(
            Row,
            { label: '实测接管' },
            h(
              'span',
              null,
              h('span', { className: 'dsa-good' }, String(traffic.channel)),
              ' 次走通道 · ',
              h('span', null, String(traffic.direct)),
              ' 次直连 · ',
              h('span', { className: traffic.failed ? 'dsa-bad' : 'dsa-muted' }, String(traffic.failed)),
              ' 次失败'
            )
          ),
          h(
            Row,
            { label: '根证书' },
            h(
              'span',
              null,
              h('span', { className: 'dsa-mono' }, fingerprintShort(pinned)),
              ' ',
              !pinned
                ? h('span', { className: 'dsa-muted' }, '未知')
                : caMatches
                  ? h('span', { className: 'dsa-good' }, '已校验')
                  : h('span', { className: 'dsa-bad' }, '指纹不匹配'),
              ' ',
              h('a', { className: 'dsa-link', href: API + '/ca.pem', download: 'scholar-root-ca.pem' }, '下载')
            )
          ),
          trafficHosts.length
            ? h(
                'div',
                { className: 'dsa-row' },
                h('span', { className: 'dsa-label' }, '域名明细'),
                h(
                  'span',
                  { className: 'dsa-value dsa-mono' },
                  trafficHosts.map((item) => item.host + ' ×' + (item.entry.channel || 0)).join('  ')
                )
              )
            : null
        ),

        h(
          'div',
          { className: 'dsa-section' },
          h(
            'div',
            { className: 'dsa-section-head' },
            h('span', null, '证书信任（主动）'),
            h('span', { className: 'dsa-tag' }, trusted ? '已信任' : '未信任')
          ),
          h(
            Row,
            { label: '信任范围' },
            trusted ? h('span', { className: 'dsa-good' }, '仅本进程 + 派生子进程') : h('span', { className: 'dsa-muted' }, '未加载，通道不生效')
          ),
          h(Row, { label: '系统证书库' }, h('span', { className: 'dsa-muted' }, '本插件从不写入 Windows 证书存储')),
          h(
            Row,
            { label: '本地 PEM', mono: true },
            !status ? '—' : ca.filesPresent ? ca.files.bundle : '不存在（注销后即删除）'
          ),
          h(Row, { label: '指纹 SHA-256' }, h('span', { className: 'dsa-mono' }, fingerprintShort(pinned))),
          h(
            'div',
            { className: 'dsa-switchrow' },
            h(
              'div',
              null,
              h('div', { className: 'dsa-switchlabel' }, trusted ? '已主动信任' : '主动信任此根证书'),
              h('div', { className: 'dsa-switchhint' }, '只影响本插件建链；注销时同步删除本地 PEM 并立即停用通道')
            ),
            h(
              'div',
              { className: 'dsa-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsa-btn ' + (trusted ? '' : 'dsa-btn-primary'),
                  disabled: certBusy || !status,
                  onClick: () => setTrust(!trusted),
                },
                trusted ? '注销证书' : '信任证书'
              ),
              h('button', { type: 'button', className: 'dsa-btn', disabled: certBusy, onClick: scanStores }, certBusy ? '处理中…' : '检查系统证书库')
            )
          ),
          certNote ? h('div', { className: 'dsa-res dsa-muted' }, certNote) : null,
          certScan
            ? h(
                'div',
                { className: 'dsa-results' },
                h(
                  'div',
                  { className: 'dsa-res' },
                  h('span', { className: 'dsa-label' }, '扫描结果'),
                  h(
                    'span',
                    { className: 'dsa-resdetail ' + (certScan.anyPresent ? 'dsa-bad' : 'dsa-good') },
                    certScan.anyPresent
                      ? '发现 ' +
                          (certScan.results || []).filter((entry) => entry.present).length +
                          ' 处：' +
                          (certScan.results || [])
                            .filter((entry) => entry.present)
                            .map((entry) => entry.scope + '\\' + entry.store)
                            .join('、')
                      : '四个证书库均未发现该根证书'
                  )
                ),
                (certScan.results || [])
                  .filter((entry) => entry.present)
                  .map((entry) =>
                    h(
                      'div',
                      { className: 'dsa-res', key: entry.path },
                      h('span', { className: 'dsa-reshost dsa-mono' }, entry.scope + '\\' + entry.store),
                      h('span', { className: 'dsa-resdetail dsa-muted' }, entry.withinUserScope ? '当前用户级，可直接移除' : '本机级，移除需管理员授权'),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsa-btn',
                          disabled: certBusy,
                          onClick: () => removeStore(entry.withinUserScope ? 'user' : 'machine', entry.store),
                        },
                        entry.withinUserScope ? '移除' : '提权移除'
                      )
                    )
                  )
              )
            : null,
          certScan && certScan.anyPresent
            ? h(
                'div',
                { className: 'dsa-switchrow' },
                h(
                  'div',
                  null,
                  h('div', { className: 'dsa-switchlabel' }, '系统级信任（本机证书库）'),
                  h(
                    'div',
                    { className: 'dsa-switchhint' },
                    certScan.systemDisabled
                      ? '已停用：证书仍在 Root 里，但整机证书链判定为不受信任 —— scholartools / openbrowser 暂时不可用'
                      : '生效中：整台机器所有程序都信任该根证书（由 scholartools.exe 安装，不是本插件装的）'
                  )
                ),
                h(
                  'div',
                  { className: 'dsa-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsa-btn ' + (certScan.systemDisabled ? 'dsa-btn-primary' : ''),
                      disabled: certBusy,
                      onClick: () => toggleSystemTrust(!certScan.systemDisabled),
                    },
                    certBusy ? '处理中…' : certScan.systemDisabled ? '恢复系统信任' : '停用系统信任'
                  )
                )
              )
            : null,
          h(
            'div',
            { className: 'dsa-foot dsa-pad' },
            '说明：scholartools.exe 曾把同一个根证书装进本机证书库（本机级），那会让整台机器所有程序都信任它——与本插件无关，但可以在上面「检查」后移除。'
          )
        ),

        h(
          'div',
          { className: 'dsa-section' },
          h(
            'div',
            { className: 'dsa-switchrow' },
            h(
              'div',
              null,
              h('div', { className: 'dsa-switchlabel' }, '接管范围'),
              h('div', { className: 'dsa-switchhint' }, '自动：只接管已知国际站点，其余直连；全量：所有域名先经 DoH 解析')
            ),
            h(
              'div',
              { className: 'dsa-seg' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsa-segbtn',
                  'data-active': String((status && status.mode) === 'auto'),
                  disabled: !status || saving,
                  onClick: () => updateConfig({ mode: 'auto' }),
                },
                '自动'
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsa-segbtn',
                  'data-active': String((status && status.mode) === 'always'),
                  disabled: !status || saving,
                  onClick: () => updateConfig({ mode: 'always' }),
                },
                '全量'
              )
            )
          )
        ),

        h(
          'div',
          { className: 'dsa-section' },
          h(
            'div',
            { className: 'dsa-section-head' },
            h('span', null, '可访问性测试'),
            h(
              'button',
              { type: 'button', className: 'dsa-btn dsa-btn-primary', disabled: testing, onClick: runTest },
              testing ? '正在测试…' : '测试可访问性'
            )
          ),
          testError ? h('div', { className: 'dsa-res dsa-bad' }, testError) : null,
          results.length
            ? h(
                'div',
                { className: 'dsa-results' + (testing ? ' dsa-dim' : '') },
                h(
                  'div',
                  { className: 'dsa-res' },
                  h('span', { className: 'dsa-label' }, '汇总'),
                  h(
                    'span',
                    { className: 'dsa-resdetail ' + (passed === results.length ? 'dsa-good' : passed > 0 ? '' : 'dsa-bad') },
                    passed + '/' + results.length + ' 可达' + (result && result.at ? ' · ' + new Date(result.at).toLocaleTimeString() : '')
                  )
                ),
                results.map((item) =>
                  h(
                    'div',
                    { className: 'dsa-res', key: item.host + item.url },
                    h('span', { className: 'dsa-reshost dsa-mono' }, item.host),
                    h(
                      'span',
                      { className: 'dsa-resdetail' },
                      item.ok
                        ? h(
                            'span',
                            { className: item.verified === false ? 'dsa-muted' : 'dsa-good' },
                            (item.verified === false ? '未校验 · ' : '') +
                              '可达 ' +
                              item.status +
                              ' · ' +
                              (item.ip || '—') +
                              ' · ' +
                              item.ms +
                              ' ms' +
                              (item.cert && item.cert.matchesPin ? ' · 指纹匹配' : '')
                          )
                        : h(
                            'span',
                            { className: 'dsa-bad' },
                            '失败 · ' + (item.error || 'unknown') + (item.cert && item.cert.matchesPin === false ? ' · 指纹不匹配' : '')
                          )
                    ),
                    h('span', { className: 'dsa-tag' }, item.channel ? '通道' : '直连')
                  )
                )
              )
            : h('div', { className: 'dsa-row' }, h('span', { className: 'dsa-muted' }, testing ? '正在从通道探测 GitHub / Hugging Face / npm / PyPI …' : '点击「测试可访问性」从当前网络实测一次。'))
        ),

        h(
          'div',
          { className: 'dsa-foot' },
          '根证书仅在连接通道地址（205.164.0.0/16）时并入信任链，并按指纹每次校验；关闭开关即恢复系统原有信任与直连。'
        )
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            { name: 'plugins.row.config', key: 'dsh-scholar-access#scholar-access' },
            (slotProps) => (slotProps && slotProps.view === 'summary' ? lastSummary : h(Card))
          )
        );
      },
    };
  },
});
