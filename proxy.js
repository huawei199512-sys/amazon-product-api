// 代理池管理模块 - 支持HTTP/HTTPS/SOCKS4/SOCKS5多协议（与1688/JD方案一致）
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
let SocksProxyAgent = null;
try { SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent; } catch { /* 可选依赖 */ }

class ProxyManager {
  constructor() {
    // 已知曾可用的代理（优先使用，由markSuccess动态添加）
    this.knownGoodProxies = [];
    this.proxies = [...this.knownGoodProxies];
    this.badProxies = new Map(); // proxy -> timestamp
    this.enabled = true; // 强制开启代理
    this.maxUsesPerProxy = 5; // 单个代理最多使用5次后轮换
    this.usedCount = new Map();
    this.lastRefreshTime = 0;
    this.refreshInterval = 300; // 5分钟最小刷新间隔（防抖）
    this.autoRefreshIntervalMs = 30 * 60 * 1000; // 自动刷新间隔：30分钟（与1688/JD方案一致）
    this.badProxyTTL = 60; // 1分钟后允许重新尝试坏代理
    this.proxyIndex = 0; // 轮询索引
    this.autoRefreshTimer = null; // 自动刷新定时器
    this.refreshing = false; // 防止并发刷新
  }

  // 判断代理协议
  getProxyProtocol(proxy) {
    if (proxy.startsWith('socks5://')) return 'socks5';
    if (proxy.startsWith('socks4://')) return 'socks4';
    if (proxy.startsWith('https://')) return 'https';
    return 'http'; // 默认http
  }

  // 规范化代理字符串（带协议前缀）
  normalizeProxy(proxy) {
    if (proxy.startsWith('socks') || proxy.startsWith('http')) return proxy;
    return `http://${proxy}`; // 默认http
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  isEnabled() {
    return this.enabled;
  }

  getStatus() {
    const httpCount = this.proxies.filter(p => !p.startsWith('socks')).length;
    const socksCount = this.proxies.filter(p => p.startsWith('socks')).length;
    return {
      proxy_enabled: this.enabled,
      proxy_count: this.proxies.length,
      http_count: httpCount,
      socks_count: socksCount,
      known_good_count: this.knownGoodProxies.length,
      bad_proxy_count: this.badProxies.size,
      max_uses_per_proxy: this.maxUsesPerProxy,
      mode: '纯代理模式（强制，不回退直连，与1688/JD方案一致）',
      auto_refresh: this.getAutoRefreshStatus(),
      proxy_sources: 13,
      refresh_interval_display: `${this.autoRefreshIntervalMs / (60 * 1000)}分钟`,
    };
  }

  createAgent(proxy) {
    const protocol = this.getProxyProtocol(proxy);
    const proxyUrl = this.normalizeProxy(proxy);

    // SOCKS代理
    if (protocol === 'socks5' || protocol === 'socks4') {
      if (SocksProxyAgent) {
        return new SocksProxyAgent(proxyUrl);
      }
      // 无SOCKS依赖时返回一个会失败的agent（保持纯代理模式，不回退直连）
      return new HttpsProxyAgent('http://0.0.0.0:1');
    }

    // HTTP/HTTPS 代理
    return new HttpsProxyAgent(proxyUrl);
  }

  // ============ 代理源获取（13源并发，与1688/JD方案一致）============

  async fetchFromProxyScrape() {
    try {
      const url = 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=8000&country=all&ssl=all&anonymity=all';
      const response = await axios.get(url, { timeout: 10000 });
      return response.data
        .split('\r\n')
        .filter((p) => p && p.includes(':'))
        .map((p) => p.trim());
    } catch {
      return [];
    }
  }

  async fetchFromGeonode() {
    try {
      const url = 'https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&protocols=http';
      const response = await axios.get(url, { timeout: 10000 });
      if (response.data && response.data.data) {
        return response.data.data
          .map((p) => `${p.ip}:${p.port}`)
          .filter((p) => p && p !== ':');
      }
      return [];
    } catch {
      return [];
    }
  }

  async fetchFromGeonodePage2() {
    try {
      const url = 'https://proxylist.geonode.com/api/proxy-list?limit=200&page=2&sort_by=lastChecked&sort_type=desc';
      const response = await axios.get(url, { timeout: 10000 });
      if (response.data && response.data.data) {
        return response.data.data
          .map((p) => `${p.ip}:${p.port}`)
          .filter((p) => p && p !== ':');
      }
      return [];
    } catch {
      return [];
    }
  }

  async fetchFromTheSpeedX() {
    try {
      const url = 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data
        .split('\n')
        .filter((p) => p && p.includes(':'))
        .map((p) => p.trim())
        .slice(0, 500);
    } catch {
      return [];
    }
  }

  async fetchFromFreeProxyList() {
    try {
      const url = 'https://raw.githubusercontent.com/fate0/proxylist/master/proxy.list';
      const response = await axios.get(url, { timeout: 15000 });
      const lines = response.data.split('\n').filter(Boolean);
      const result = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.host && obj.port) {
            result.push(`${obj.host}:${obj.port}`);
          }
        } catch {
          continue;
        }
      }
      return result.slice(0, 300);
    } catch {
      return [];
    }
  }

  async fetchFromSocksProxyScrape() {
    try {
      const url = 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks5&timeout=8000&country=all';
      const response = await axios.get(url, { timeout: 10000 });
      return response.data
        .split('\r\n')
        .filter((p) => p && p.includes(':'))
        .map((p) => `socks5://${p.trim()}`);
    } catch {
      return [];
    }
  }

  async fetchFromTheSpeedXSocks() {
    try {
      const url = 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data
        .split('\n')
        .filter((p) => p && p.includes(':'))
        .map((p) => `socks5://${p.trim()}`)
        .slice(0, 300);
    } catch {
      return [];
    }
  }

  async fetchFromJetkaiHttp() {
    try {
      const url = 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data
        .split('\n')
        .filter((p) => p && p.includes(':'))
        .map((p) => p.trim())
        .slice(0, 500);
    } catch {
      return [];
    }
  }

  async fetchFromJetkaiSocks5() {
    try {
      const url = 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data
        .split('\n')
        .filter((p) => p && p.includes(':'))
        .map((p) => `socks5://${p.trim()}`)
        .slice(0, 500);
    } catch {
      return [];
    }
  }

  async fetchFromHookzofSocks5() {
    try {
      const url = 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data
        .split('\n')
        .filter((p) => p && p.includes(':'))
        .map((p) => `socks5://${p.trim()}`)
        .slice(0, 300);
    } catch {
      return [];
    }
  }

  async fetchFromHubpAll() {
    try {
      const url = 'https://git.hubp.de/iplocate/free-proxy-list/raw/main/all-proxies.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data
        .split('\n')
        .filter((p) => p && p.includes(':'))
        .map((p) => p.trim())
        .slice(0, 500);
    } catch {
      return [];
    }
  }

  async fetchFromMonosansHttp() {
    try {
      const url = 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data
        .split('\n')
        .filter((p) => p && p.includes(':'))
        .map((p) => p.trim())
        .slice(0, 300);
    } catch {
      return [];
    }
  }

  async fetchFromMonosansSocks5() {
    try {
      const url = 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt';
      const response = await axios.get(url, { timeout: 15000 });
      return response.data
        .split('\n')
        .filter((p) => p && p.includes(':'))
        .map((p) => `socks5://${p.trim()}`)
        .slice(0, 300);
    } catch {
      return [];
    }
  }

  // ============ 代理源获取（13源并发，与1688/JD方案一致）============
  async fetchProxiesFast() {
    console.log('[AmazonProxy] 获取代理列表（13个源并发）...');
    const allProxies = new Set();

    // 13个代理源（与1688/JD方案一致）
    const sources = [
      this.fetchFromProxyScrape(),
      this.fetchFromGeonode(),
      this.fetchFromGeonodePage2(),
      this.fetchFromTheSpeedX(),
      this.fetchFromFreeProxyList(),
      this.fetchFromSocksProxyScrape(),
      this.fetchFromTheSpeedXSocks(),
      this.fetchFromJetkaiHttp(),
      this.fetchFromJetkaiSocks5(),
      this.fetchFromHookzofSocks5(),
      this.fetchFromHubpAll(),
      this.fetchFromMonosansHttp(),
      this.fetchFromMonosansSocks5(),
    ];

    const results = await Promise.allSettled(sources);

    let successSources = 0;
    results.forEach((result, idx) => {
      if (result.status === 'fulfilled' && result.value && result.value.length > 0) {
        successSources++;
        result.value.forEach((p) => allProxies.add(p));
      }
    });

    // 按协议统计
    const httpCount = Array.from(allProxies).filter(p => !p.startsWith('socks')).length;
    const socksCount = Array.from(allProxies).filter(p => p.startsWith('socks')).length;

    console.log(`[AmazonProxy] 获取到 ${allProxies.size} 个代理 (成功源:${successSources}/13, HTTP:${httpCount}, SOCKS:${socksCount})`);
    return Array.from(allProxies);
  }

  // ============ 代理刷新 ============
  async refreshProxies(force = false) {
    const now = Date.now() / 1000;

    // 防抖：非强制刷新时检查最小间隔
    if (!force && now - this.lastRefreshTime < this.refreshInterval && this.proxies.length > 0) {
      return this.proxies;
    }

    // 防止并发刷新
    if (this.refreshing) {
      console.log('[AmazonProxy] 刷新进行中，跳过本次请求');
      return this.proxies;
    }

    this.refreshing = true;
    try {
      const existingGood = this.proxies.filter((p) => !this.badProxies.has(p));
      const newProxies = await this.fetchProxiesFast();

      // 合并：已知好的 + 新获取的
      const merged = new Set([...this.knownGoodProxies, ...existingGood, ...newProxies]);
      const finalList = Array.from(merged).filter((p) => !this.badProxies.has(p));

      this.proxies = finalList;
      this.usedCount.clear();
      this.lastRefreshTime = now;

      console.log(`[AmazonProxy] 刷新完成: ${finalList.length} 个代理 (已知好:${this.knownGoodProxies.length})`);
      return finalList;
    } catch (e) {
      console.error('[AmazonProxy] 刷新失败:', e.message);
      this.proxies = [...this.knownGoodProxies];
      return this.proxies;
    } finally {
      this.refreshing = false;
    }
  }

  // ============ 自动刷新定时器（每30分钟，与1688/JD方案一致）============
  startAutoRefresh(intervalMinutes = 30) {
    // 先停止已有的定时器
    this.stopAutoRefresh();

    this.autoRefreshIntervalMs = intervalMinutes * 60 * 1000;

    console.log(`[AmazonProxy] 启动自动刷新定时器：每${intervalMinutes}分钟刷新一次`);

    this.autoRefreshTimer = setInterval(async () => {
      if (!this.enabled) {
        console.log('[AmazonProxy] 代理已禁用，跳过自动刷新');
        return;
      }
      try {
        console.log(`[AmazonProxy] 自动刷新触发 ${new Date().toISOString()}`);
        const before = this.proxies.length;
        const after = await this.refreshProxies(true);
        console.log(`[AmazonProxy] 自动刷新完成: ${before} → ${after.length} 个代理`);
      } catch (e) {
        console.error('[AmazonProxy] 自动刷新异常:', e.message);
      }
    }, this.autoRefreshIntervalMs);

    // 确保定时器不会阻止进程退出
    if (this.autoRefreshTimer.unref) {
      this.autoRefreshTimer.unref();
    }
  }

  // 停止自动刷新定时器
  stopAutoRefresh() {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
      console.log('[AmazonProxy] 已停止自动刷新定时器');
    }
  }

  // 获取自动刷新状态
  getAutoRefreshStatus() {
    return {
      enabled: this.autoRefreshTimer !== null,
      interval_minutes: this.autoRefreshIntervalMs / (60 * 1000),
      last_refresh_time: this.lastRefreshTime ? new Date(this.lastRefreshTime * 1000).toISOString() : null,
      next_refresh_in_seconds: this.autoRefreshTimer
        ? Math.max(0, this.autoRefreshIntervalMs / 1000 - (Date.now() / 1000 - this.lastRefreshTime))
        : null,
    };
  }

  // ============ 获取代理（轮询策略）============
  getProxy() {
    if (!this.enabled) {
      return null;
    }

    // 清理过期的坏代理标记
    const now = Date.now();
    this.badProxies.forEach((timestamp, proxy) => {
      if (proxy.startsWith('__')) return; // 跳过计数器
      if (now - timestamp > this.badProxyTTL * 1000) {
        this.badProxies.delete(proxy);
        this.badProxies.delete('__fail_count_' + proxy);
      }
    });

    // 优先使用已知好代理（必须是近期无失败的）
    const preferred = this.knownGoodProxies.filter(
      (p) =>
        !this.badProxies.has(p) &&
        (this.badProxies.get('__fail_count_' + p) || 0) === 0 &&
        (this.usedCount.get(p) || 0) < this.maxUsesPerProxy
    );

    if (preferred.length > 0) {
      const proxy = preferred[Math.floor(Math.random() * preferred.length)];
      const count = this.usedCount.get(proxy) || 0;
      this.usedCount.set(proxy, count + 1);
      return proxy;
    }

    // 从大代理池中轮询选择
    const available = this.proxies.filter(
      (p) =>
        !this.badProxies.has(p) &&
        !this.knownGoodProxies.includes(p) &&
        (this.usedCount.get(p) || 0) < this.maxUsesPerProxy
    );

    if (available.length > 0) {
      this.proxyIndex = (this.proxyIndex + 1) % available.length;
      const proxy = available[this.proxyIndex];
      const count = this.usedCount.get(proxy) || 0;
      this.usedCount.set(proxy, count + 1);
      return proxy;
    }

    // 兜底：重置所有使用计数
    if (this.proxies.length > 0) {
      const nonBad = this.proxies.filter((p) => !this.badProxies.has(p));
      if (nonBad.length > 0) {
        this.usedCount.clear();
        this.proxyIndex = (this.proxyIndex + 1) % nonBad.length;
        const proxy = nonBad[this.proxyIndex];
        this.usedCount.set(proxy, 1);
        return proxy;
      }
    }

    // 最后兜底：已知好代理
    if (this.knownGoodProxies.length > 0) {
      const proxy = this.knownGoodProxies[Math.floor(Math.random() * this.knownGoodProxies.length)];
      this.badProxies.delete(proxy);
      this.badProxies.delete('__fail_count_' + proxy);
      return proxy;
    }

    return null;
  }

  // ============ 标记失败/成功 ============
  markFailed(proxy) {
    if (!proxy) return;
    const isKnownGood = this.knownGoodProxies.includes(proxy);
    const failCount = (this.badProxies.get('__fail_count_' + proxy) || 0) + 1;

    if (isKnownGood) {
      // 已知好代理：失败3次后暂时标记，1分钟后恢复
      if (failCount >= 3) {
        this.badProxies.set(proxy, Date.now());
        this.badProxies.set('__fail_count_' + proxy, 0);
        console.log(`[AmazonProxy] 已知代理 ${proxy} 失败3次，暂时跳过`);
      } else {
        this.badProxies.set('__fail_count_' + proxy, failCount);
      }
    } else {
      // 其他代理：失败1次即标记为坏
      this.badProxies.set(proxy, Date.now());
      this.proxies = this.proxies.filter((p) => p !== proxy);
      this.usedCount.delete(proxy);
    }
  }

  markSuccess(proxy) {
    if (!proxy) return;
    this.badProxies.delete('__fail_count_' + proxy);
    this.badProxies.delete(proxy);
    // 成功的代理加入已知好代理列表
    if (!this.knownGoodProxies.includes(proxy) && this.knownGoodProxies.length < 20) {
      this.knownGoodProxies.push(proxy);
      console.log(`[AmazonProxy] 代理 ${proxy} 成功，加入已知好代理列表 (共${this.knownGoodProxies.length}个)`);
    }
  }

  getRandomUA() {
    const uas = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    ];
    return uas[Math.floor(Math.random() * uas.length)];
  }
}

module.exports = new ProxyManager();