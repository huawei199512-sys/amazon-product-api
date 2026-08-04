const axios = require('axios');
const cheerio = require('cheerio');
const proxyManager = require('./proxy');
const { getSiteConfig } = require('./sites');

// 超时与并发策略：
// - 单代理8秒超时：死代理连接在8s内必超时（DNS/ETIMEDOUT），快速淘汰
// - 每轮并发3个代理（Promise.race竞态）：第一个成功的立即返回
// - 60秒总超时（1分钟没返回JSON直接失败）
// - 8轮 × 3并发 = 最多24个代理在60s内
const SINGLE_PROXY_TIMEOUT = 8000; // 单个代理8秒超时
const TOTAL_REQUEST_TIMEOUT = 60000; // 总请求60秒超时
const CONCURRENT_PROXIES = 3; // 每轮并发的代理数量
const MIN_REQUEST_INTERVAL = 300; // 300ms间隔（降低延迟）

let lastRequestTime = 0;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL) {
    await sleep(MIN_REQUEST_INTERVAL - elapsed + Math.random() * 200);
  }
  lastRequestTime = Date.now();
}

function getHeaders(lang, domain) {
  const langMap = {
    en: 'en-US', ja: 'ja-JP', de: 'de-DE', fr: 'fr-FR',
    it: 'it-IT', es: 'es-ES', pt: 'pt-BR', ko: 'ko-KR',
    nl: 'nl-NL', sv: 'sv-SE', pl: 'pl-PL', zh: 'zh-CN',
  };
  return {
    'User-Agent': proxyManager.getRandomUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': `${langMap[lang] || lang},${lang};q=0.9`,
  };
}

function isBlocked(html) {
  const patterns = [
    'Robot Check', 'Enter the characters you see',
    'Sorry, we just need to make sure you\'re not a robot',
    'Sorry, you have been blocked', 'captcha', 'automated access',
    'request could not be processed',
  ];
  const lower = html.toLowerCase();
  return patterns.some(p => lower.includes(p.toLowerCase()));
}

async function makeRequestWithProxy(url, params, lang = 'en') {
  await rateLimit();

  let fullUrl = url;
  if (params && typeof params === 'object') {
    const queryString = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    fullUrl = url + (url.includes('?') ? '&' : '?') + queryString;
  }

  const domain = new URL(url).hostname;
  const headers = getHeaders(lang, domain);
  const startTime = Date.now();
  const attemptedProxies = [];

  if (!proxyManager.isEnabled()) {
    return { html: null, error: '代理模式未启用', attempted_proxies: attemptedProxies };
  }

  function getProxyBatch(count) {
    const batch = [];
    for (let i = 0; i < count; i++) {
      const p = proxyManager.getProxy();
      if (p) batch.push(p);
    }
    return batch;
  }

  // 为单个代理创建请求任务（返回promise和abort函数）
  function createProxyTask(proxy) {
    const agent = proxyManager.createAgent(proxy);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), SINGLE_PROXY_TIMEOUT);

    const taskPromise = axios.get(fullUrl, {
      headers, httpsAgent: agent, httpAgent: agent,
      timeout: SINGLE_PROXY_TIMEOUT, signal: controller.signal,
      maxRedirects: 5, validateStatus: () => true,
    }).then(response => {
      clearTimeout(abortTimer);
      if (response.status === 200) {
        const html = response.data;
        if (isBlocked(html)) return { ok: false, blocked: true, error: '被反爬机制拦截' };
        return { ok: true, html, error: null };
      } else if (response.status === 302) {
        const loc = response.headers.location || '';
        if (loc.includes('signin') || loc.includes('login')) return { ok: false, error: '被重定向到登录页面' };
        return { ok: true, html: response.data, error: null };
      }
      return { ok: false, error: `代理返回${response.status}` };
    }).catch(error => {
      clearTimeout(abortTimer);
      const isTimeout = error.name === 'CanceledError' || error.name === 'AbortError' ||
                        error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ||
                        error.code === 'ERR_CANCELED';
      return { ok: false, error: isTimeout ? '超时' : error.message };
    });

    return {
      proxy,
      promise: taskPromise,
      abort: () => {
        clearTimeout(abortTimer);
        try { controller.abort(); } catch {}
      }
    };
  }

  // 记录代理尝试结果
  function recordResult(proxy, result, roundStart) {
    const elapsed = ((Date.now() - roundStart) / 1000).toFixed(2);
    if (result.ok && result.html) {
      proxyManager.markSuccess(proxy);
      attemptedProxies.push({ proxy, status: 'success', time: elapsed });
    } else if (result.blocked) {
      proxyManager.markFailed(proxy);
      attemptedProxies.push({ proxy, status: 'blocked', time: elapsed });
    } else {
      proxyManager.markFailed(proxy);
      attemptedProxies.push({ proxy, status: result.error || 'error', time: elapsed });
    }
  }

  let round = 0;
  const maxRounds = 8;
  const seenProxies = new Set();

  while (round < maxRounds) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= TOTAL_REQUEST_TIMEOUT) {
      console.warn(`[Request] 总超时 (${(elapsed / 1000).toFixed(1)}s)`);
      break;
    }

    let batch = getProxyBatch(CONCURRENT_PROXIES * 2).filter(p => !seenProxies.has(p));
    batch = batch.slice(0, CONCURRENT_PROXIES);
    if (batch.length === 0) break;

    batch.forEach(p => seenProxies.add(p));
    console.log(`[Request] 第${round + 1}轮: 并发尝试 ${batch.length} 个代理 (竞态模式)...`);

    // 创建所有代理任务
    const tasks = batch.map(p => createProxyTask(p));
    const roundStartTime = Date.now();

    // 使用 Promise.race 实现真正的竞态
    // 第一个成功的代理立即返回，其余中止
    let successOutcome = null;
    let raceResolver;
    const racePromise = new Promise(resolve => { raceResolver = resolve; });

    const wrappedPromises = tasks.map(({ proxy, promise }) => {
      return promise.then(result => {
        if (!successOutcome && result.ok && result.html) {
          // 第一个成功的！记录并立即resolve race
          successOutcome = { proxy, result };
          recordResult(proxy, result, roundStartTime);
          raceResolver({ done: true });
        } else {
          recordResult(proxy, result, roundStartTime);
        }
        return { proxy, result };
      }).catch(err => {
        const result = { ok: false, error: err.message || '异常' };
        recordResult(proxy, result, roundStartTime);
        return { proxy, result };
      });
    });

    // 等待条件：racePromise(成功) 或 allDone(全部完成)
    const allDone = Promise.all(wrappedPromises);

    // 竞态：谁先完成用谁
    const raceResult = await Promise.race([
      racePromise,           // 第一个成功的立即完成
      allDone.then(() => ({ done: true, allFailed: !successOutcome })),  // 或全部失败
    ]);

    // 中止所有仍在运行的请求
    tasks.forEach(t => t.abort());

    if (successOutcome) {
      // 确保所有代理都被记录（被中止的标记为aborted）
      tasks.forEach(({ proxy }) => {
        if (!attemptedProxies.find(a => a.proxy === proxy)) {
          attemptedProxies.push({ proxy, status: 'aborted', time: ((Date.now() - roundStartTime) / 1000).toFixed(2) });
        }
      });

      return {
        html: successOutcome.result.html,
        error: null,
        proxy_used: successOutcome.proxy,
        elapsed: ((Date.now() - startTime) / 1000).toFixed(2),
        attempted_proxies: attemptedProxies,
      };
    }

    round++;
    await sleep(100);
  }

  const uniqueErrors = [...new Set(attemptedProxies.map(a => a.status))];
  const summary = uniqueErrors.length === 1 ? uniqueErrors[0] : uniqueErrors.join(', ');

  return {
    html: null,
    error: `所有${attemptedProxies.length}个代理失败 (${summary})`,
    proxy_used: 'none',
    attempted_proxies: attemptedProxies,
  };
}

function extractLdJson(html) {
  const results = [];
  const regex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1].trim());
      if (Array.isArray(data)) {
        results.push(...data);
      } else {
        results.push(data);
      }
    } catch {
      // ignore
    }
  }
  return results;
}

function extractAsinFromUrl(url) {
  const patterns = [
    /\/dp\/([A-Z0-9]{10})/i,
    /\/gp\/product\/([A-Z0-9]{10})/i,
    /\/exec\/obidos\/ASIN\/([A-Z0-9]{10})/i,
    /asin=([A-Z0-9]{10})/i,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function searchProducts(keyword, country = 'com', lang = 'en', page = 1) {
  const siteConfig = getSiteConfig(country);
  if (!siteConfig) {
    return { success: false, error: `不支持的站点: ${country}` };
  }

  const searchUrl = siteConfig.searchUrl;
  const params = { k: keyword, page: page, ref: 'nb_sb_noss' };

  console.log(`[Search] 搜索 "${keyword}" on ${siteConfig.domain}, page ${page}`);

  const { html, error, proxy_used, elapsed, attempted_proxies } = await makeRequestWithProxy(searchUrl, params, lang);
  
  if (!html) {
    return { 
      success: false, 
      error: `搜索失败: ${error}`,
      proxy_used: proxy_used || 'none',
      attempted_proxies: attempted_proxies || [],
    };
  }

  const products = parseSearchResults(html, siteConfig);
  const totalResults = extractTotalResults(html);

  return {
    success: true,
    keyword,
    country,
    page,
    total_results: totalResults || products.length,
    products,
    proxy_used: proxy_used,
    request_time: elapsed,
  };
}

function extractTotalResults(html) {
  try {
    const $ = cheerio.load(html);
    const text = $('span[data-component-type="s-result-info-bar"] .sg-col-inner').first().text();
    const match = text.replace(/,/g, '').match(/\d+/);
    if (match) return parseInt(match[0]);
  } catch {
    // ignore
  }
  return null;
}

function parseSearchResults(html, siteConfig) {
  const products = [];
  const $ = cheerio.load(html);
  const seenAsins = new Set();

  const items = $('div[data-asin]').filter((i, el) => {
    const asin = $(el).attr('data-asin');
    return asin && /^[A-Z0-9]{10}$/i.test(asin) && !seenAsins.has(asin);
  });

  items.each((i, element) => {
    try {
      const $item = $(element);
      const dataAsin = $item.attr('data-asin');
      if (!dataAsin || !/^[A-Z0-9]{10}$/i.test(dataAsin)) return;
      if (seenAsins.has(dataAsin)) return;
      seenAsins.add(dataAsin);

      const product = {
        asin: dataAsin,
        domain: siteConfig.domain,
        detail_url: `https://${siteConfig.domain}/dp/${dataAsin}`,
      };

      // 标题
      const titleSelectors = [
        'h2 a span', 'h2 span', '.a-text-normal', '[data-cy="title-recipe"] span',
      ];
      for (const sel of titleSelectors) {
        const titleElem = $item.find(sel).first();
        if (titleElem.length) {
          const titleText = titleElem.text().trim();
          if (titleText) {
            product.title = titleText;
            break;
          }
        }
      }

      // 链接和ASIN
      const linkElem = $item.find('h2 a').first();
      if (linkElem.length) {
        const href = linkElem.attr('href') || '';
        if (href) {
          const fullHref = href.startsWith('/') ? href : '/' + href;
          product.full_url = `https://${siteConfig.domain}${fullHref}`;
          const extractedAsin = extractAsinFromUrl(href);
          if (extractedAsin && extractedAsin !== dataAsin) {
            product.asin = extractedAsin;
            product.detail_url = `https://${siteConfig.domain}/dp/${extractedAsin}`;
          }
        }
      }

      // 图片
      const imageElem = $item.find('img.s-image, img[data-image-index]').first();
      if (imageElem.length) {
        product.image_url = imageElem.attr('src') || imageElem.attr('data-src') || '';
        product.image_alt = imageElem.attr('alt') || '';
      }

      // 价格
      const priceOffscreen = $item.find('.a-price .a-offscreen').first();
      if (priceOffscreen.length) {
        const priceText = priceOffscreen.text().trim();
        product.price = { display: priceText, currency: siteConfig.currency };
        const amountMatch = priceText.replace(/,/g, '').match(/[\d.]+/);
        if (amountMatch) product.price.amount = parseFloat(amountMatch[0]);
      } else {
        const priceWhole = $item.find('.a-price-whole').first();
        const priceFraction = $item.find('.a-price-fraction').first();
        const priceSymbol = $item.find('.a-price-symbol').first();
        if (priceWhole.length) {
          let priceText = priceWhole.text().trim().replace(/\.$/, '');
          if (priceFraction.length) priceText += '.' + priceFraction.text().trim();
          product.price = {
            display: `${priceSymbol.text().trim()}${priceText}`,
            currency: siteConfig.currency,
          };
        } else {
          product.price = null;
        }
      }

      // 评分
      const ratingElem = $item.find('span.a-icon-alt').first();
      if (ratingElem.length) {
        const ratingText = ratingElem.text().trim();
        product.rating = ratingText;
        product.rating_value = parseFloat(ratingText.split(' ')[0]) || null;
      }

      // 评论数
      const reviewCountSelectors = [
        'span[aria-label*="stars"] + span a span',
        '.a-size-small .a-link-normal .a-size-base',
        '[data-cy="review-rating-information"] .a-size-base',
      ];
      for (const sel of reviewCountSelectors) {
        const reviewElem = $item.find(sel).first();
        if (reviewElem.length) {
          const count = reviewElem.text().trim().replace(/,/g, '');
          if (count) {
            product.review_count = count;
            break;
          }
        }
      }

      // 是否Prime
      product.is_prime = $item.find('i.a-icon-prime, .a-icon-prime').length > 0;
      
      // 是否赞助
      const sponsoredElem = $item.find('span.a-color-secondary').first();
      product.is_sponsored = sponsoredElem.length > 0 && sponsoredElem.text().includes('Sponsored');

      if (product.title) {
        products.push(product);
      }
    } catch (e) {
      // ignore parse errors
    }
  });

  return products;
}

async function getProductDetail(asin, country = 'com', lang = 'en') {
  const siteConfig = getSiteConfig(country);
  if (!siteConfig) {
    return { success: false, error: `不支持的站点: ${country}` };
  }

  const detailUrl = `https://${siteConfig.domain}/dp/${asin}`;
  console.log(`[Detail] 获取商品详情: ${asin} from ${siteConfig.domain}`);

  const { html, error, proxy_used, elapsed, attempted_proxies } = await makeRequestWithProxy(detailUrl, null, lang);
  
  if (!html) {
    return { 
      success: false, 
      error: `获取商品详情失败: ${error}`,
      proxy_used: proxy_used || 'none',
      attempted_proxies: attempted_proxies || [],
    };
  }

  const product = parseProductDetail(html, asin, siteConfig, lang);
  const ldJson = extractLdJson(html);
  if (ldJson.length > 0) {
    product.ld_json = ldJson;
  }

  return {
    success: true,
    asin,
    country,
    product,
    proxy_used: proxy_used,
    request_time: elapsed,
  };
}

function parseProductDetail(html, asin, siteConfig, lang) {
  const $ = cheerio.load(html);
  const product = {
    asin,
    domain: siteConfig.domain,
    country: siteConfig.country,
    currency: siteConfig.currency,
    language: lang,
    url: `https://${siteConfig.domain}/dp/${asin}`,
  };

  // 标题
  const titleElem = $('#productTitle, #title span').first();
  if (titleElem.length) {
    product.title = titleElem.text().trim();
  } else {
    const ldJson = extractLdJson(html);
    if (ldJson.length > 0) {
      const productData = ldJson.find(item => item['@type'] === 'Product');
      if (productData) product.title = productData.name;
    }
  }

  // 品牌
  const brandElem = $('#bylineInfo, #brand, .po-brand').first();
  if (brandElem.length) {
    product.brand = brandElem.text().trim().replace(/^(Brand|Visit the|Brand:|Marque|Marke)\s*/i, '');
  } else {
    const ldJson = extractLdJson(html);
    if (ldJson.length > 0) {
      const productData = ldJson.find(item => item['@type'] === 'Product');
      if (productData && productData.brand) {
        product.brand = productData.brand.name || productData.brand;
      }
    }
  }

  // 价格
  const priceElem = $('#priceblock_ourprice, #priceblock_dealprice, #price_inside_buybox, #corePrice_feature_div .a-offscreen, #price, .a-price .a-offscreen').first();
  if (priceElem.length) {
    const priceText = priceElem.text().trim();
    product.price = { display: priceText, currency: siteConfig.currency };
    const amountMatch = priceText.replace(/,/g, '').match(/[\d.]+/);
    if (amountMatch) product.price.amount = parseFloat(amountMatch[0]);
  } else {
    const ldJson = extractLdJson(html);
    if (ldJson.length > 0) {
      const productData = ldJson.find(item => item['@type'] === 'Product');
      if (productData && productData.offers) {
        const offers = productData.offers;
        if (offers.price) {
          product.price = {
            display: `${offers.priceCurrency || siteConfig.currency} ${offers.price}`,
            currency: offers.priceCurrency || siteConfig.currency,
            amount: parseFloat(offers.price),
          };
        }
      }
    }
  }

  // 原价
  const listPriceElem = $('#listPrice, #priceblock_listprice').first();
  if (listPriceElem.length) {
    product.list_price = listPriceElem.text().trim();
  }

  // 折扣
  const discountElem = $('#savingsPercent, #savings-percentage').first();
  if (discountElem.length) {
    product.discount = discountElem.text().trim();
  }

  // 库存状态
  const availabilityElem = $('#availability span, #outOfStock, #availability .a-color-success').first();
  if (availabilityElem.length) {
    product.availability = availabilityElem.text().trim();
    const availLower = product.availability.toLowerCase();
    product.in_stock = availLower.includes('in stock') || availLower.includes('有货') || availLower.includes('在庫');
  }

  // 加购按钮
  product.can_add_to_cart = $('#add-to-cart-button').length > 0;
  product.can_buy_now = $('#buy-now-button').length > 0;

  // 评分
  const ratingElem = $('#acrPopover, span[data-hook="rating-out-of-text"]').first();
  if (ratingElem.length) {
    product.rating = ratingElem.attr('title') || ratingElem.text().trim();
  }

  const ratingValueElem = $('span.a-icon-alt').first();
  if (ratingValueElem.length) {
    product.rating_value = parseFloat(ratingValueElem.text().trim().split(' ')[0]) || null;
  }

  // 评论数
  const reviewCountElem = $('#acrCustomerReviewText, #revCount').first();
  if (reviewCountElem.length) {
    product.review_count = reviewCountElem.text().trim();
  }

  // 特性列表
  const featureBullets = $('#feature-bullets .a-list-item, #feature-bullets-btf .a-list-item');
  product.features = [];
  featureBullets.each((i, el) => {
    const text = $(el).text().trim();
    if (text) product.features.push(text);
  });

  // 描述
  const descriptionElem = $('#productDescription, #productDescription p').first();
  if (descriptionElem.length) {
    product.description = descriptionElem.text().trim();
  } else {
    const ldJson = extractLdJson(html);
    if (ldJson.length > 0) {
      const productData = ldJson.find(item => item['@type'] === 'Product');
      if (productData && productData.description) {
        product.description = productData.description;
      }
    }
  }

  // 描述图片
  const detailImages = [];
  $('#aplus img, #productDescription img').each((i, img) => {
    const src = $(img).attr('src') || $(img).attr('data-src') || '';
    if (src && !src.includes('sprite') && !src.includes('grey-pixel')) {
      detailImages.push(src);
    }
  });
  product.description_images = [...new Set(detailImages)];

  // 商品属性规格
  const bulletsElem = $('#detailBullets_feature_div').first();
  if (bulletsElem.length) {
    product.specifications = [];
    bulletsElem.find('li').each((i, li) => {
      const spans = $(li).find('span');
      if (spans.length >= 2) {
        const key = $(spans[0]).text().trim().replace(/:$/, '');
        const value = $(spans[1]).text().trim();
        if (key && value && key !== '\u200f') {
          product.specifications.push({ key, value });
        }
      }
    });
  }

  // 技术详情
  const techDetails = $('#productDetails_techSpec_section_1').first();
  if (techDetails.length) {
    product.tech_details = {};
    techDetails.find('tr').each((i, row) => {
      const key = $(row).find('th').text().trim();
      const value = $(row).find('td').text().trim();
      if (key) product.tech_details[key] = value;
    });
  }

  // 主图
  const mainImageElem = $('#landingImage, #main-image').first();
  if (mainImageElem.length) {
    product.main_image = mainImageElem.attr('data-old-hires') || mainImageElem.attr('data-hires') || mainImageElem.attr('src') || '';
  }

  // 缩略图
  const thumbnailImages = [];
  $('#altImages img, #imageBlock img, .a-button-text img').each((i, img) => {
    const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-old-hires') || '';
    if (src && !src.includes('sprite') && !src.includes('grey-pixel') && !src.includes('pixel')) {
      thumbnailImages.push(src);
    }
  });
  product.images = [...new Set(thumbnailImages)];

  // 画廊图
  const galleryImages = [];
  $('#imageBlock img, #main-image-container img').each((i, img) => {
    const src = $(img).attr('data-old-hires') || $(img).attr('data-hires') || $(img).attr('src') || '';
    if (src && !src.includes('sprite') && !src.includes('grey-pixel')) {
      galleryImages.push(src);
    }
  });
  product.gallery_images = [...new Set(galleryImages)];

  if (product.main_image && !product.gallery_images.includes(product.main_image)) {
    product.gallery_images.unshift(product.main_image);
  }

  // SKU变体
  const skuVariants = extractSkuVariants(html, $);
  product.sku_variants = skuVariants;
  product.sku_count = skuVariants.length;

  if (skuVariants.length === 0) {
    const twisterItems = $('#twister .a-button-text, #twister a[href*="/dp/"]');
    twisterItems.each((i, el) => {
      const href = $(el).attr('href') || '';
      const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/i);
      if (asinMatch) {
        const existing = product.sku_variants.find(v => v.asin === asinMatch[1]);
        if (!existing) {
          product.sku_variants.push({
            asin: asinMatch[1],
            title: $(el).text().trim(),
            image: $(el).find('img').attr('src') || '',
          });
        }
      }
    });
    product.sku_count = product.sku_variants.length;
  }

  // SKU维度
  const dimensions = [];
  $('#twister .twister-dim, [data-dimension-name]').each((i, dim) => {
    const dimName = $(dim).attr('data-dimension-name') || $(dim).attr('aria-label') || '';
    const variants = [];
    $(dim).find('.a-button-text, a[href*="/dp/"]').each((j, btn) => {
      const href = $(btn).attr('href') || '';
      const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/i);
      if (asinMatch) {
        variants.push({ asin: asinMatch[1], title: $(btn).text().trim() });
      }
    });
    if (variants.length > 0) {
      dimensions.push({ dimension: dimName, variants });
    }
  });
  if (dimensions.length > 0) {
    product.sku_dimensions = dimensions;
  }

  // 关联商品
  const alsoBought = [];
  $('#sims-fbt .a-link-normal, .sims-fbt-reference, #sims-consolidated-1 .a-link-normal').each((i, el) => {
    const href = $(el).attr('href') || $(el).parent().attr('href') || '';
    const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/i);
    if (asinMatch) alsoBought.push(asinMatch[1]);
  });
  product.also_bought = [...new Set(alsoBought)];

  const alsoViewed = [];
  $('#sims-fbt-compare .a-link-normal, #comparison-cards .a-link-normal').each((i, el) => {
    const href = $(el).attr('href') || '';
    const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/i);
    if (asinMatch) alsoViewed.push(asinMatch[1]);
  });
  product.also_viewed = [...new Set(alsoViewed)];

  // Prime标识
  product.is_prime = $('#pdp-obp-badge, .a-icon-prime, [data-prime], #badgePrime').length > 0;

  // 卖家信息
  const sellerSelectors = [
    '#merchant-info a', '#tabular-buybox .tabular-buybox-text a',
    '#merchant-info', '.tabular-buybox-trademark .seller-name', '#sellerProfileTriggerId',
  ];
  for (const sel of sellerSelectors) {
    const sellerElem = $(sel).first();
    if (sellerElem.length) {
      const text = sellerElem.text().trim();
      if (text) {
        product.seller = text;
        break;
      }
    }
  }

  // Buybox卖家
  const buyboxSelectors = ['#tabular-buybox .tabular-buybox-text', '#merchant-info .tabular-buybox-text', '.tabular-buybox'];
  for (const sel of buyboxSelectors) {
    const buyboxElem = $(sel).first();
    if (buyboxElem.length) {
      const text = buyboxElem.text().trim();
      if (text) {
        product.buybox_seller = text;
        break;
      }
    }
  }

  // 销售方/配送方
  const soldByElem = $('#merchant-info .seller-name, .tabular-buybox-trademark .seller-name').first();
  if (soldByElem.length) {
    product.sold_by = soldByElem.text().trim();
  }

  const fulfilledByElem = $('#merchant-info .fulfillment, .tabular-buybox-trademark .fulfillment').first();
  if (fulfilledByElem.length) {
    product.fulfilled_by = fulfilledByElem.text().trim();
  }

  return product;
}

function extractSkuVariants(html, $) {
  const variants = [];

  try {
    const patterns = [
      /"variationDisplayLabels":\s*(\[[\s\S]*?\])/,
      /"dimensionValuesDisplayData":\s*(\{[\s\S]*?\})/,
      /"variationLabels":\s*(\[[\s\S]*?\])/,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        try {
          const data = JSON.parse(match[1]);
          if (Array.isArray(data)) {
            for (const item of data) {
              if (typeof item === 'object') {
                const asin = item.defaultAsin || item.asin;
                if (asin) {
                  variants.push({ asin, title: item.displayLabel || item.label || '', image: item.image || '' });
                }
              } else if (typeof item === 'string' && /^[A-Z0-9]{10}$/i.test(item)) {
                variants.push({ asin: item });
              }
            }
          } else if (typeof data === 'object') {
            for (const [key, value] of Object.entries(data)) {
              if (Array.isArray(value)) {
                for (const asin of value) {
                  if (/^[A-Z0-9]{10}$/i.test(asin)) {
                    variants.push({ asin, attribute: key });
                  }
                }
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  if (variants.length === 0) {
    $('#twister .a-button-link, .variation_parts a').each((i, el) => {
      const href = $(el).attr('href') || '';
      const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/i);
      if (asinMatch) {
        variants.push({ asin: asinMatch[1], title: $(el).text().trim(), image: $(el).find('img').attr('src') || '' });
      }
    });
  }

  const seen = new Set();
  return variants.filter(v => {
    if (seen.has(v.asin)) return false;
    seen.add(v.asin);
    return true;
  });
}

module.exports = { searchProducts, getProductDetail };
