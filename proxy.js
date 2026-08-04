const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
let SocksProxyAgent = null;
try { SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent; } catch { /* 可选依赖 */ }

class ProxyManager {
  constructor() {
    // 已知曾可用的代理（优先使用）
    this.knownGoodProxies = [
      '148.251.86.68:16379',
      '185.166.24.221:1981',
    ];
    this.proxies = [...this.knownGoodProxies];
    this.badProxies = new Map(); // proxy -> timestamp
    this.enabled = true; // 强制开启代理
    this.maxUsesPerProxy = 5; // 单个代理最多使用5次后轮换
    this.usedCount = new Map();
    this.lastRefreshTime = 0;
    this.refreshInterval = 30; // 30秒刷新一次
    this.badProxyTTL = 60; // 1分钟后允许重新尝试坏代理
    this.proxyIndex = 0; // 轮询索引
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
    return {
      proxy_enabled: this.enabled,
      proxy_count: this.proxies.length,
      known_good_count: this.knownGoodProxies.length,
      bad_proxy_count: this.badProxies.size,
      max_uses_per_proxy: this.maxUsesPerProxy,
      mode: '纯代理模式（强制，不回退直连）',
    };
  }

  createAgent(proxy) {
    const protocol = this.getProxyProtocol(proxy);
    const proxyUrl = this.normalizeProxy(proxy);

    // SOCKS代理：优先使用 socks-proxy-agent
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

  // ============ 代理源获取（18个免费源：含HTTP/SOCKS多协议）============
  async fetchProxiesFast(skipValidation = false) {
    console.log('[Proxy] 获取代理列表...');
    const allProxies = new Set();
    const startTime = Date.now();

    // 18个免费代理源（HTTP + SOCKS 多协议，符合多协议轮换约束）
    const sources = [
      // HTTP 代理源（原10个）
      this.fetchFromOpenProxyList(),
      this.fetchFromSpysMe(),
      this.fetchFromProxyScrape(),
      this.fetchFromGeonode(),
      this.fetchFromFreeProxyList(),
      this.fetchFromProxyListDownload(),
      this.fetchFromPubProxy(),
      this.fetchFromProxyDB(),
      this.fetchFromClarketm(),
      this.fetchFromTheSpeedX(),
      // 新增 HTTP 代理源（4个）
      this.fetchFromMonosans(),
      this.fetchFromRoosterkid(),
      this.fetchFromSunny9577(),
      this.fetchFromMuRongPIG(),
      // SOCKS 代理源（4个，支持多协议约束）
      this.fetchFromSocks5TheSpeedX(),
      this.fetchFromSocks4TheSpeedX(),
      this.fetchFromMonosansSocks(),
      this.fetchFromProxyScrapeSocks5(),
    ];

    try {
      const results = await Promise.allSettled(sources.map(s =>
        s.catch(() => [])
      ));

      let sourceCount = 0;
      let httpCount = 0;
      let socksCount = 0;
      results.forEach(result => {
        if (result.status === 'fulfilled' && Array.isArray(result.value)) {
          if (result.value.length > 0) sourceCount++;
          result.value.forEach(p => {
            allProxies.add(p);
            if (p.startsWith('socks')) socksCount++;
            else httpCount++;
          });
        }
      });
      console.log(`[Proxy] 成功从 ${sourceCount}/${sources.length} 个源获取代理 (HTTP:${httpCount}, SOCKS:${socksCount})`);
    } catch (e) {
      console.error('[Proxy] 获取代理源出错:', e.message);
    }

    // 加入已知好代理
    this.knownGoodProxies.forEach(p => allProxies.add(p));

    const proxyArray = Array.from(allProxies);
    console.log(`[Proxy] 获取到 ${proxyArray.length} 个代理，耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    if (proxyArray.length === 0) {
      console.warn('[Proxy] 未获取到任何代理，使用已知代理');
      return [...this.knownGoodProxies];
    }

    // 不验证，直接使用全部（验证太慢，让请求时自然淘汰）
    console.log(`[Proxy] 直接使用全部 ${proxyArray.length} 个代理（请求时自然淘汰）`);
    return proxyArray;
  }

  // 源1: openproxylist.xyz（最稳定，6000+代理）
  async fetchFromOpenProxyList() {
    try {
      const response = await axios.get('https://openproxylist.xyz/http.txt', {
        timeout: 8000,
        headers: { 'User-Agent': this.getRandomUA() },
      });
      return String(response.data).split('\n').filter(line => line && line.includes(':'));
    } catch {
      return [];
    }
  }

  // 源2: spys.me（400+代理）
  async fetchFromSpysMe() {
    try {
      const response = await axios.get('https://spys.me/proxy.txt', {
        timeout: 8000,
        headers: { 'User-Agent': this.getRandomUA() },
      });
      const text = String(response.data);
      const lines = text.split('\n').filter(line => line && !line.startsWith('#'));
      const proxies = [];
      for (const line of lines) {
        const match = line.match(/(\d+\.\d+\.\d+\.\d+:\d+)/);
        if (match) proxies.push(match[1]);
      }
      return proxies;
    } catch {
      return [];
    }
  }

  // 源3: api.proxyscrape.com
  async fetchFromProxyScrape() {
    try {
      const response = await axios.get(
        'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all',
        { timeout: 10000, headers: { 'User-Agent': this.getRandomUA() } }
      );
      return String(response.data).trim().split('\n').filter(line => line && line.includes(':'));
    } catch {
      return [];
    }
  }

  // 源4: proxylist.geonode.com
  async fetchFromGeonode() {
    try {
      const response = await axios.get(
        'https://proxylist.geonode.com/api/proxy-list?limit=50&page=1&sort_by=lastChecked&sort_type=desc',
        { timeout: 8000, headers: { 'User-Agent': this.getRandomUA() } }
      );
      const data = response.data.data || [];
      return data.map(item => `${item.ip}:${item.port}`);
    } catch {
      return [];
    }
  }

  // 源5: free-proxy-list.net
  async fetchFromFreeProxyList() {
    try {
      const response = await axios.get('https://free-proxy-list.net/', {
        timeout: 8000,
        headers: { 'User-Agent': this.getRandomUA() },
      });
      const text = response.data;
      const regex = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}/g;
      const matches = text.match(regex) || [];
      return matches.filter(p => !p.startsWith('0.') && !p.startsWith('127.'));
    } catch {
      return [];
    }
  }

  // 源6: proxy-list.download
  async fetchFromProxyListDownload() {
    try {
      const response = await axios.get(
        'https://www.proxy-list.download/api/v1/get?type=http',
        { timeout: 8000, headers: { 'User-Agent': this.getRandomUA() } }
      );
      const lines = String(response.data).split('\n').filter(l => l && l.includes(':'));
      return lines;
    } catch {
      return [];
    }
  }

  // 源7: pubproxy.com
  async fetchFromPubProxy() {
    try {
      const response = await axios.get(
        'http://pubproxy.com/api/proxy?limit=20&format=txt',
        { timeout: 8000, headers: { 'User-Agent': this.getRandomUA() } }
      );
      return String(response.data).trim().split('\n').filter(l => l && l.includes(':'));
    } catch {
      return [];
    }
  }

  // 源8: proxydb.net
  async fetchFromProxyDB() {
    try {
      const response = await axios.get('http://proxydb.net/?protocol=http&anonlvl=4', {
        timeout: 8000,
        headers: { 'User-Agent': this.getRandomUA() },
      });
      const text = String(response.data);
      const matches = text.match(/\d+\.\d+\.\d+\.\d+:\d+/g) || [];
      return matches;
    } catch {
      return [];
    }
  }

  // 源9: clarketm/raw-proxy-list (GitHub)
  async fetchFromClarketm() {
    try {
      const response = await axios.get(
        'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list.txt',
        { timeout: 8000, headers: { 'User-Agent': this.getRandomUA() } }
      );
      const lines = String(response.data).split('\n');
      const proxies = [];
      for (const line of lines) {
        const match = line.match(/(\d+\.\d+\.\d+\.\d+:\d+)/);
        if (match) proxies.push(match[1]);
      }
      return proxies;
    } catch {
      return [];
    }
  }

  // 源10: TheSpeedX/PROXY-List (GitHub)
  async fetchFromTheSpeedX() {
    try {
      const response = await axios.get(
        'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
        { timeout: 8000, headers: { 'User-Agent': this.getRandomUA() } }
      );
      return String(response.data).split('\n').filter(l => l && l.includes(':'));
    } catch {
      return [];
    }
  }

  // 源11: monosans/proxy-list (GitHub，活跃维护，HTTP)
  async fetchFromMonosans() {
    try {
      const response = await axios.get(
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
        { timeout: 8000, headers: { 'User-Agent': this.getRandomUA() } }
      );
      return String(response.data).split('\n').filter(l => l && l.includes(':'));
    } catch {
      return [];
    }
  }

  // 源12: roosterkid/openproxylist (GitHub，HTTPS)
  async fetchFromRoosterkid() {
    try {
      const response = await axios.get(
        'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
        { timeout: 8000, headers: { 'User-Agent': this.getRandomUA() } }
      );
      return String(response.data).split('\n').filter(l => l && l.includes(':'));
    } catch {
      return [];
    }
  }

  // 源13: sunny9577/proxy-scraper (GitHub)
  async fetchFromSunny9577() {
    try {
      const response = await axios.get(
        'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/http_proxies.txt',
        { timeout: 8000, headers: { 'User-Agent': this.getRandomUA() } }
      );
      return String(response.data).split('\n').filter(l => l && l.includes(':'));
    } catch {
      return [];
    }
  }

  // 源14: MuRongPIG/Proxy (GitHub)
  async fetchFromMuRongPIG() {
    try {
      const response = await axios.get(
        'https://raw.githubusercontent.com/MuRongPIG/Proxy/master/http.txt',
        { timeout: 8000, headers: { 'User-Agent': this.getRandomUA() } }
      );
      return String(response.data).split('\n').filter(l => l && l.includes(':'));
    } catch {
      return [];
    }
  }

  // 源15: TheSpeedX/SOCKS-List SOCKS5 (GitHub，多协议约束)
  async fetchFromSocks5TheSpeedX() {
    try {
      const response = await axios.get(
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt',
        { timeout: 8000, headers: { 'User-Agent': this.getRandomUA() } }
      );
      return String(response.data).split('\n')
        .filter(l => l && l.includes(':'))
        .map(p => `socks5://${p}`);
    } catch {
      return [];
    }
  }

  // 源16: TheSpeedX/SOCKS-List SOCKS4 (GitHub，多协议约束)
  async fetchFromSocks4TheSpeedX() {
    try {
      const response = await axios.get(
        'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks4.txt',
        { timeout: 8000, headers: { 'User-Agent': this.getRandomUA() } }
      );
      return String(response.data).split('\n')
        .filter(l => l && l.includes(':'))
        .map(p => `socks4://${p}`);
    } catch {
      return [];
    }
  }

  // 源17: monosans/proxy-list SOCKS5 (GitHub)
  async fetchFromMonosansSocks() {
    try {
      const response = await axios.get(
        'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
        { timeout: 8000, headers: { 'User-Agent': this.getRandomUA() } }
      );
      return String(response.data).split('\n')
        .filter(l => l && l.includes(':'))
        .map(p => `socks5://${p}`);
    } catch {
      return [];
    }
  }

  // 源18: ProxyScrape SOCKS5 (多协议约束)
  async fetchFromProxyScrapeSocks5() {
    try {
      const response = await axios.get(
        'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=5000&country=all',
        { timeout: 10000, headers: { 'User-Agent': this.getRandomUA() } }
      );
      return String(response.data).trim().split('\n')
        .filter(l => l && l.includes(':'))
        .map(p => `socks5://${p}`);
    } catch {
      return [];
    }
  }

  // ============ 代理刷新 ============
  async refreshProxies(force = false) {
    const now = Date.now() / 1000;

    if (!force && now - this.lastRefreshTime < this.refreshInterval && this.proxies.length > 0) {
      return this.proxies;
    }

    try {
      const existingGood = this.proxies.filter(p => !this.badProxies.has(p));
      const newProxies = await this.fetchProxiesFast(false);

      // 合并：已知好的 + 新获取的
      const merged = new Set([...this.knownGoodProxies, ...existingGood, ...newProxies]);
      const finalList = Array.from(merged).filter(p => !this.badProxies.has(p));

      this.proxies = finalList;
      this.usedCount.clear();
      this.lastRefreshTime = now;

      console.log(`[Proxy] 刷新完成: ${finalList.length} 个代理`);
      return finalList;
    } catch (e) {
      console.error('[Proxy] 刷新失败:', e.message);
      this.proxies = [...this.knownGoodProxies];
      return this.proxies;
    }
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

    // 优先使用已知好代理（必须是近期无失败的，否则跳过让位给大代理池）
    const preferred = this.knownGoodProxies.filter(p =>
      !this.badProxies.has(p) &&
      (this.badProxies.get('__fail_count_' + p) || 0) === 0 && // 近期无失败
      (this.usedCount.get(p) || 0) < this.maxUsesPerProxy
    );

    if (preferred.length > 0) {
      const proxy = preferred[Math.floor(Math.random() * preferred.length)];
      const count = this.usedCount.get(proxy) || 0;
      this.usedCount.set(proxy, count + 1);
      return proxy;
    }

    // 从大代理池中轮询选择（11000+ 代理，主力来源）
    const available = this.proxies.filter(p =>
      !this.badProxies.has(p) &&
      !this.knownGoodProxies.includes(p) &&
      (this.usedCount.get(p) || 0) < this.maxUsesPerProxy
    );

    if (available.length > 0) {
      // 轮询选择（不是随机，确保每个代理都有机会）
      this.proxyIndex = (this.proxyIndex + 1) % available.length;
      const proxy = available[this.proxyIndex];
      const count = this.usedCount.get(proxy) || 0;
      this.usedCount.set(proxy, count + 1);
      return proxy;
    }

    // 兜底：重置所有使用计数，从大代理池重新轮换（避免计数耗尽导致无代理可用）
    if (this.proxies.length > 0) {
      const nonBad = this.proxies.filter(p => !this.badProxies.has(p));
      if (nonBad.length > 0) {
        this.usedCount.clear();
        this.proxyIndex = (this.proxyIndex + 1) % nonBad.length;
        const proxy = nonBad[this.proxyIndex];
        this.usedCount.set(proxy, 1);
        return proxy;
      }
    }

    // 最后兜底：已知好代理（即使近期失败也尝试）
    if (this.knownGoodProxies.length > 0) {
      const proxy = this.knownGoodProxies[Math.floor(Math.random() * this.knownGoodProxies.length)];
      this.badProxies.delete(proxy);
      this.badProxies.delete('__fail_count_' + proxy);
      return proxy;
    }

    return null;
  }

  // ============ 标记失败 ============
  markFailed(proxy) {
    const isKnownGood = this.knownGoodProxies.includes(proxy);
    const failCount = (this.badProxies.get('__fail_count_' + proxy) || 0) + 1;

    if (isKnownGood) {
      // 已知好代理：失败3次后暂时标记，1分钟后恢复
      if (failCount >= 3) {
        this.badProxies.set(proxy, Date.now());
        this.badProxies.set('__fail_count_' + proxy, 0);
        console.log(`[Proxy] 已知代理 ${proxy} 失败3次，暂时跳过`);
      } else {
        this.badProxies.set('__fail_count_' + proxy, failCount);
      }
    } else {
      // 其他代理：失败1次即标记为坏
      this.badProxies.set(proxy, Date.now());
      this.proxies = this.proxies.filter(p => p !== proxy);
      this.usedCount.delete(proxy);
    }
  }

  markSuccess(proxy) {
    this.badProxies.delete('__fail_count_' + proxy);
    this.badProxies.delete(proxy);
    // 成功的代理加入已知好代理列表（动态学习，扩大容量支持更多轮换）
    if (!this.knownGoodProxies.includes(proxy) && this.knownGoodProxies.length < 20) {
      this.knownGoodProxies.push(proxy);
      console.log(`[Proxy] 代理 ${proxy} 成功，加入已知好代理列表 (共${this.knownGoodProxies.length}个)`);
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
    ];
    return uas[Math.floor(Math.random() * uas.length)];
  }
}

module.exports = new ProxyManager();