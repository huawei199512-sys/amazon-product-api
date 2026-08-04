const express = require('express');
const cors = require('cors');
const scraper = require('./scraper');
const sites = require('./sites');
const proxyManager = require('./proxy');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

// 纯代理模式 - 启动时初始化代理池
(async () => {
  try {
    console.log('[Init] 正在初始化代理池...');
    await proxyManager.refreshProxies(true);
    console.log('[Init] 代理池初始化完成');
  } catch (e) {
    console.warn('[Init] 代理池初始化失败，将在请求时重试:', e.message);
  }
})();

// 定时刷新代理池（每30秒）
setInterval(async () => {
  try {
    await proxyManager.refreshProxies(false);
  } catch (e) {
    console.warn('[AutoRefresh] 代理刷新失败:', e.message);
  }
}, 30000);

app.get('/', (req, res) => {
  res.json({
    service: 'Amazon Product API',
    version: '2.0.0 (Pro)',
    description: 'Amazon商品详情和关键字搜索API - 纯代理模式',
    mode: 'proxy',
    features: {
      proxy_mode: '纯代理模式（所有请求通过代理IP）',
      supported_sites: sites.getAllSiteKeys(),
      search_params: {
        keyword: '搜索关键字（必填）',
        country: '站点代码，如: com, jp, de, co.uk, fr, it, es, ca',
        lang: '语言代码，如: en, ja, de, fr, zh',
        page: '页码，从1开始',
      },
      product_params: {
        asin: '商品ASIN（路径参数）',
        country: '站点代码',
        lang: '语言代码',
      },
    },
    proxy_status: proxyManager.getStatus(),
  });
});

app.get('/api/sites', (req, res) => {
  const siteList = Object.entries(sites.SITES).map(([code, config]) => ({
    code,
    domain: config.domain,
    country: config.country,
    currency: config.currency,
    language: config.language,
  }));
  res.json(siteList);
});

app.get('/api/search', async (req, res) => {
  try {
    const { keyword, country = 'com', lang = 'en', page = 1 } = req.query;
    
    if (!keyword) {
      return res.status(400).json({ success: false, error: 'keyword参数必填' });
    }
    
    if (!sites.getSiteConfig(country)) {
      return res.status(400).json({ 
        success: false, 
        error: `不支持的站点: ${country}`,
        supported_sites: sites.getAllSiteKeys()
      });
    }
    
    // 强制启用代理
    proxyManager.setEnabled(true);
    
    const result = await scraper.searchProducts(keyword, country, lang, parseInt(page));
    res.json(result);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/product/:asin', async (req, res) => {
  try {
    const { asin } = req.params;
    const { country = 'com', lang = 'en' } = req.query;
    
    if (!sites.getSiteConfig(country)) {
      return res.status(400).json({ 
        success: false, 
        error: `不支持的站点: ${country}`,
        supported_sites: sites.getAllSiteKeys()
      });
    }
    
    // 强制启用代理
    proxyManager.setEnabled(true);
    
    const result = await scraper.getProductDetail(asin, country, lang);
    res.json(result);
  } catch (error) {
    console.error('Product detail error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/proxy/status', (req, res) => {
  res.json(proxyManager.getStatus());
});

app.post('/api/proxy/refresh', async (req, res) => {
  try {
    await proxyManager.refreshProxies(true);
    res.json({ success: true, ...proxyManager.getStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 保留toggle接口但强制开启
app.post('/api/proxy/toggle', (req, res) => {
  const { enabled } = req.query;
  // 忽略用户设置，强制开启代理
  proxyManager.setEnabled(true);
  res.json({ success: true, proxy_enabled: true, note: '代理模式为强制开启状态' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  Amazon Product API Pro 已启动');
  console.log('  访问地址: http://localhost:' + PORT);
  console.log('  模式: 强制代理模式');
  console.log('  站点数: ' + sites.getAllSiteKeys().length);
  console.log('========================================');
  console.log();
});