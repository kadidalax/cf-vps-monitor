// Donson - Cloudflare Worker解决方案

// ==================== 配置常量 ====================

// 默认管理员账户配置
const DEFAULT_ADMIN_CONFIG = {
    USERNAME: 'admin',
    PASSWORD: 'monitor2025!',
  };
  
  // 安全配置
  function getSecurityConfig(env) {
    return {
      JWT_SECRET: env.JWT_SECRET || 'default-jwt-secret-please-set-in-worker-variables',
      TOKEN_EXPIRY: 24 * 60 * 60 * 1000, // 24小时
      MAX_LOGIN_ATTEMPTS: 5,
      LOGIN_ATTEMPT_WINDOW: 15 * 60 * 1000, // 15分钟
      API_RATE_LIMIT: 60, // 每分钟60次
      MIN_PASSWORD_LENGTH: 8,
      ALLOWED_ORIGINS: env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',') : [],
    };
  }
  
  // ==================== 全局存储 ====================
  
  const rateLimitStore = new Map();
  const loginAttemptStore = new Map();
  
  // ==================== 工具函数 ====================
  
  // 路径参数验证
  function extractAndValidateServerId(path) {
    const serverId = path.split('/').pop();
    return serverId && /^[a-zA-Z0-9_-]{1,50}$/.test(serverId) ? serverId : null;
  }
    function extractPathSegment(path, index) {
    const segments = path.split('/');
    if (index >= segments.length) return null;
  
    const segment = segments[index];
    return segment && /^[a-zA-Z0-9_-]{1,50}$/.test(segment) ? segment : null;
  }
  
  // 月结流量工具函数
  function getCurrentYearMonth() {
    const now = new Date();
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1, // JavaScript月份从0开始，需要+1
      timestamp: Math.floor(now.getTime() / 1000)
    };
  }
  
  function getMonthFirstDayTimestamp(year, month) {
    const firstDay = new Date(year, month - 1, 1); // month-1因为JavaScript月份从0开始
    return Math.floor(firstDay.getTime() / 1000);
  }
  
  function formatTrafficSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const value = bytes / Math.pow(k, i);
    
    return `${value.toFixed(2)} ${units[i]}`;
  }
  
  // 计算月结流量使用量
  function calculateMonthlyTrafficUsage(currentTotal, baselineTotal) {
    if (!currentTotal || !baselineTotal) return 0;
    
    // 处理流量重置的情况（当前总量小于基线时）
    if (currentTotal < baselineTotal) {
      return currentTotal; // 假设系统重启后从0开始计算
    }
    
    return currentTotal - baselineTotal;
  }

  // 输入验证
  function validateInput(input, type, maxLength = 255) {
    if (!input || typeof input !== 'string' || input.length > maxLength) {
      return false;
    }

    const validators = {
      serverName: () => /^[\w\s\u4e00-\u9fa5-]{1,100}$/.test(input.trim()),
      description: () => input.trim().length <= 500,
      direction: () => ['up', 'down'].includes(input),
      url: () => {
        try {
          const url = new URL(input);
          return ['http:', 'https:'].includes(url.protocol);
        } catch {
          return false;
        }
      }
    };

    return validators[type] ? validators[type]() : input.trim().length > 0;
  }
  
  // ==================== 统一响应处理工具 ====================
  
  // 创建标准API响应
  function createApiResponse(data, status = 200, corsHeaders = {}) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
  
  // 创建错误响应
  function createErrorResponse(error, message, status = 500, corsHeaders = {}, details = null) {
    const errorData = {
      error,
      message,
      timestamp: Date.now()
    };
    if (details) errorData.details = details;
  
    return createApiResponse(errorData, status, corsHeaders);
  }
  
  // 创建成功响应
  function createSuccessResponse(data, corsHeaders = {}) {
    return createApiResponse({ success: true, ...data }, 200, corsHeaders);
  }
  
  // ==================== 统一验证工具 ====================
  
  // 服务器认证验证
  async function validateServerAuth(path, request, env) {
    const serverId = extractAndValidateServerId(path);
    if (!serverId) {
      return { error: 'Invalid server ID', message: '无效的服务器ID格式' };
    }
  
    const apiKey = request.headers.get('X-API-Key');
    if (!apiKey) {
      return { error: 'API key required', message: '需要API密钥' };
    }
  
    try {
      const serverData = await env.DB.prepare(
        'SELECT id, name, api_key FROM servers WHERE id = ?'
      ).bind(serverId).first();
  
      if (!serverData || serverData.api_key !== apiKey) {
        return { error: 'Invalid credentials', message: '无效的服务器ID或API密钥' };
      }
  
      return { success: true, serverId, serverData };
    } catch (error) {
      return { error: 'Database error', message: '数据库查询失败' };
    }
  }
  
  // ==================== 统一数据库错误处理 ====================
  
  function handleDbError(error, corsHeaders, operation = 'database operation') {
    console.error(`数据库操作错误 [${operation}]:`, error);
  
    if (error.message.includes('no such table')) {
      return createErrorResponse(
        'Database table missing',
        '数据库表不存在，请重试',
        503,
        corsHeaders,
        '如果问题持续存在，请联系管理员'
      );
    }
  
    return createErrorResponse(
      'Internal server error',
      `${operation}失败: ${error.message}`,
      500,
      corsHeaders,
      '请稍后重试，如果问题持续存在请联系管理员'
    );
  }
  
  // ==================== 缓存查询工具 ====================
  
  // VPS上报间隔缓存
  let vpsIntervalCache = {
    value: null,
    timestamp: 0,
    ttl: 60000 // 1分钟缓存
  };
  
  // 获取VPS上报间隔（带缓存）
  async function getVpsReportInterval(env) {
    const now = Date.now();
  
    // 检查缓存是否有效
    if (vpsIntervalCache.value !== null && (now - vpsIntervalCache.timestamp) < vpsIntervalCache.ttl) {
      return vpsIntervalCache.value;
    }
  
    try {
      const result = await env.DB.prepare(
        'SELECT value FROM app_config WHERE key = ?'
      ).bind('vps_report_interval_seconds').first();
  
      const interval = result?.value ? parseInt(result.value, 10) : 60;
      if (!isNaN(interval) && interval > 0) {
        // 更新缓存
        vpsIntervalCache.value = interval;
        vpsIntervalCache.timestamp = now;
        return interval;
      }
    } catch (error) {
      console.warn("获取VPS上报间隔失败，使用默认值:", error);
    }
  
    // 默认值也缓存
    vpsIntervalCache.value = 60;
    vpsIntervalCache.timestamp = now;
    return 60;
  }
  
  // 清除VPS间隔缓存（当设置更新时调用）
  function clearVpsIntervalCache() {
    vpsIntervalCache.value = null;
    vpsIntervalCache.timestamp = 0;
  }
  
  // ==================== 月结流量管理工具 ====================
  
  // 获取或创建当月流量基线
  async function getOrCreateMonthlyBaseline(env, serverId) {
    const { year, month, timestamp } = getCurrentYearMonth();
    
    try {
      // 先尝试获取当月基线
      let baseline = await env.DB.prepare(`
        SELECT * FROM monthly_traffic_baselines 
        WHERE server_id = ? AND year = ? AND month = ?
      `).bind(serverId, year, month).first();
      
      if (baseline) {
        return baseline;
      }
      
      // 如果当月基线不存在，需要创建新的基线
      // 获取当前服务器的最新网络数据
      const currentMetrics = await env.DB.prepare(`
        SELECT network FROM metrics WHERE server_id = ? ORDER BY timestamp DESC LIMIT 1
      `).bind(serverId).first();
      
      let baselineUpload = 0;
      let baselineDownload = 0;
      
      if (currentMetrics && currentMetrics.network) {
        try {
          const networkData = JSON.parse(currentMetrics.network);
          baselineUpload = networkData.total_upload || 0;
          baselineDownload = networkData.total_download || 0;
        } catch (parseError) {
          console.warn(`解析服务器 ${serverId} 网络数据失败:`, parseError);
        }
      }
      
      // 创建新的月度基线
      await env.DB.prepare(`
        INSERT INTO monthly_traffic_baselines 
        (server_id, year, month, baseline_upload, baseline_download, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(serverId, year, month, baselineUpload, baselineDownload, timestamp, timestamp).run();
      
      // 返回新创建的基线
      baseline = await env.DB.prepare(`
        SELECT * FROM monthly_traffic_baselines 
        WHERE server_id = ? AND year = ? AND month = ?
      `).bind(serverId, year, month).first();
      
      return baseline;
      
    } catch (error) {
      console.error(`获取或创建月度基线失败 (服务器: ${serverId}):`, error);
      return null;
    }
  }
  
  // 获取服务器月结流量数据
  async function getServerMonthlyTraffic(env, serverId) {
    try {
      // 获取当月基线
      const baseline = await getOrCreateMonthlyBaseline(env, serverId);
      if (!baseline) {
        throw new Error('无法获取月度基线数据');
      }
      
      // 获取最新的网络数据
      const currentMetrics = await env.DB.prepare(`
        SELECT network, timestamp FROM metrics WHERE server_id = ? ORDER BY timestamp DESC LIMIT 1
      `).bind(serverId).first();
      
      if (!currentMetrics || !currentMetrics.network) {
        return {
          baseline_upload: baseline.baseline_upload,
          baseline_download: baseline.baseline_download,
          current_upload: 0,
          current_download: 0,
          monthly_upload: 0,
          monthly_download: 0,
          monthly_total: 0,
          formatted: {
            baseline_upload: formatTrafficSize(baseline.baseline_upload),
            baseline_download: formatTrafficSize(baseline.baseline_download),
            monthly_upload: formatTrafficSize(0),
            monthly_download: formatTrafficSize(0),
            monthly_total: formatTrafficSize(0)
          },
          year: baseline.year,
          month: baseline.month,
          last_update: null
        };
      }
      
      let currentUpload = 0;
      let currentDownload = 0;
      
      try {
        const networkData = JSON.parse(currentMetrics.network);
        currentUpload = networkData.total_upload || 0;
        currentDownload = networkData.total_download || 0;
      } catch (parseError) {
        console.warn(`解析网络数据失败:`, parseError);
      }
      
      // 计算月结流量
      const monthlyUpload = calculateMonthlyTrafficUsage(currentUpload, baseline.baseline_upload);
      const monthlyDownload = calculateMonthlyTrafficUsage(currentDownload, baseline.baseline_download);
      const monthlyTotal = monthlyUpload + monthlyDownload;
      
      return {
        baseline_upload: baseline.baseline_upload,
        baseline_download: baseline.baseline_download,
        current_upload: currentUpload,
        current_download: currentDownload,
        monthly_upload: monthlyUpload,
        monthly_download: monthlyDownload,
        monthly_total: monthlyTotal,
        formatted: {
          baseline_upload: formatTrafficSize(baseline.baseline_upload),
          baseline_download: formatTrafficSize(baseline.baseline_download),
          current_upload: formatTrafficSize(currentUpload),
          current_download: formatTrafficSize(currentDownload),
          monthly_upload: formatTrafficSize(monthlyUpload),
          monthly_download: formatTrafficSize(monthlyDownload),
          monthly_total: formatTrafficSize(monthlyTotal)
        },
        year: baseline.year,
        month: baseline.month,
        last_update: currentMetrics.timestamp
      };
      
    } catch (error) {
      console.error(`获取服务器月结流量数据失败:`, error);
      throw error;
    }
  }
  
  // 重置月度基线（手动重置功能）
  async function resetMonthlyBaseline(env, serverId, year = null, month = null) {
    const { year: currentYear, month: currentMonth, timestamp } = getCurrentYearMonth();
    const targetYear = year || currentYear;
    const targetMonth = month || currentMonth;
    
    try {
      // 获取当前最新的网络数据作为新的基线
      const currentMetrics = await env.DB.prepare(`
        SELECT network FROM metrics WHERE server_id = ? ORDER BY timestamp DESC LIMIT 1
      `).bind(serverId).first();
      
      let newBaselineUpload = 0;
      let newBaselineDownload = 0;
      
      if (currentMetrics && currentMetrics.network) {
        try {
          const networkData = JSON.parse(currentMetrics.network);
          newBaselineUpload = networkData.total_upload || 0;
          newBaselineDownload = networkData.total_download || 0;
        } catch (parseError) {
          console.warn(`解析网络数据失败:`, parseError);
        }
      }
      
      // 更新或插入新的基线数据
      await env.DB.prepare(`
        INSERT OR REPLACE INTO monthly_traffic_baselines 
        (server_id, year, month, baseline_upload, baseline_download, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(serverId, targetYear, targetMonth, newBaselineUpload, newBaselineDownload, timestamp, timestamp).run();
      
      return {
        success: true,
        baseline_upload: newBaselineUpload,
        baseline_download: newBaselineDownload,
        year: targetYear,
        month: targetMonth
      };
      
    } catch (error) {
      console.error(`重置月度基线失败:`, error);
      throw error;
    }
  }

  // ==================== VPS数据验证工具 ====================
  
  // 验证JSON对象结构
  function validateJsonObject(obj, fieldName) {
    if (!obj || typeof obj !== 'object') {
      console.warn(`${fieldName}字段不是有效的对象:`, obj);
      return false;
    }
    return true;
  }
  
  // 验证VPS数据结构
  function validateVpsDataStructure(data, type) {
    if (!validateJsonObject(data, type)) {
      return false;
    }
  
    switch (type) {
      case 'CPU':
        return typeof data.usage_percent === 'number' &&
               Array.isArray(data.load_avg) &&
               data.load_avg.length === 3;
      case '内存':
      case '磁盘':
        return typeof data.total === 'number' &&
               typeof data.used === 'number' &&
               typeof data.free === 'number' &&
               typeof data.usage_percent === 'number';
      case '网络':
        return typeof data.upload_speed === 'number' &&
               typeof data.download_speed === 'number' &&
               typeof data.total_upload === 'number' &&
               typeof data.total_download === 'number';
      default:
        return true;
    }
  }
  
  // 验证和修复VPS上报数据
  function validateAndFixVpsData(reportData) {
    const requiredFields = ['timestamp', 'cpu', 'memory', 'disk', 'network'];
  
    // 检查必需字段
    for (const field of requiredFields) {
      if (!reportData[field]) {
        return {
          error: 'Invalid data format',
          message: `缺少必需字段: ${field}`,
          details: `上报数据必须包含以下字段: ${requiredFields.join(', ')}, uptime`,
          received_fields: Object.keys(reportData)
        };
      }
    }
  
    if (typeof reportData.uptime === 'undefined') {
      return {
        error: 'Invalid data format',
        message: '缺少uptime字段',
        details: 'uptime字段是必需的，用于记录系统运行时间（秒）',
        received_fields: Object.keys(reportData)
      };
    }
  
    // 验证和修复数据结构
    if (!validateVpsDataStructure(reportData.cpu, 'CPU')) {
      console.warn('CPU数据结构无效，使用默认值:', reportData.cpu);
      reportData.cpu = { usage_percent: 0, load_avg: [0, 0, 0] };
    }
    if (!validateVpsDataStructure(reportData.memory, '内存')) {
      console.warn('内存数据结构无效，使用默认值:', reportData.memory);
      reportData.memory = { total: 0, used: 0, free: 0, usage_percent: 0 };
    }
    if (!validateVpsDataStructure(reportData.disk, '磁盘')) {
      console.warn('磁盘数据结构无效，使用默认值:', reportData.disk);
      reportData.disk = { total: 0, used: 0, free: 0, usage_percent: 0 };
    }
    if (!validateVpsDataStructure(reportData.network, '网络')) {
      console.warn('网络数据结构无效，使用默认值:', reportData.network);
      reportData.network = { upload_speed: 0, download_speed: 0, total_upload: 0, total_download: 0 };
    }
  
    // 验证时间戳
    if (!Number.isInteger(reportData.timestamp) || reportData.timestamp <= 0) {
      console.warn('时间戳无效，使用当前时间:', reportData.timestamp);
      reportData.timestamp = Math.floor(Date.now() / 1000);
    }
  
    // 验证uptime
    if (!Number.isInteger(reportData.uptime) || reportData.uptime < 0) {
      console.warn('运行时间无效，设置为0:', reportData.uptime);
      reportData.uptime = 0;
    }
  
    return { success: true, data: reportData };
  }
  
  // ==================== 密码处理 ====================
  
  async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  
  async function verifyPassword(password, hashedPassword) {
    const hashedInput = await hashPassword(password);
    return hashedInput === hashedPassword;
  }
  
  // ==================== JWT处理 ====================
  
  // JWT验证缓存
  const jwtCache = new Map();
  const JWT_CACHE_TTL = 60000; // 1分钟缓存
  const MAX_CACHE_SIZE = 1000; // 最大缓存条目数
  
  // 清理过期的缓存条目
  function cleanupJWTCache() {
    const now = Date.now();
    for (const [key, value] of jwtCache.entries()) {
      if (now - value.timestamp > JWT_CACHE_TTL) {
        jwtCache.delete(key);
      }
    }
  
    // 如果缓存过大，删除最旧的条目
    if (jwtCache.size > MAX_CACHE_SIZE) {
      const entries = Array.from(jwtCache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toDelete = entries.slice(0, jwtCache.size - MAX_CACHE_SIZE);
      toDelete.forEach(([key]) => jwtCache.delete(key));
    }
  }
  
  async function createJWT(payload, env) {
    const config = getSecurityConfig(env);
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Date.now();
    const jwtPayload = { ...payload, iat: now, exp: now + config.TOKEN_EXPIRY };
  
    const encodedHeader = btoa(JSON.stringify(header));
    const encodedPayload = btoa(JSON.stringify(jwtPayload));
    const data = encodedHeader + '.' + encodedPayload;
  
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(config.JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
  
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
    const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)));
  
    return data + '.' + encodedSignature;
  }
  
  // 带缓存的JWT验证函数
  async function verifyJWTCached(token, env) {
    // 检查缓存
    const cached = jwtCache.get(token);
    if (cached && Date.now() - cached.timestamp < JWT_CACHE_TTL) {
      // 检查token是否过期
      if (cached.payload.exp && Date.now() > cached.payload.exp) {
        jwtCache.delete(token);
        return null;
      }
      return cached.payload;
    }
  
    // 缓存未命中，执行实际验证
    const payload = await verifyJWT(token, env);
    if (payload) {
      // 定期清理缓存
      if (Math.random() < 0.01) { // 1%的概率触发清理
        cleanupJWTCache();
      }
  
      // 存入缓存
      jwtCache.set(token, {
        payload,
        timestamp: Date.now()
      });
    }
  
    return payload;
  }
  
  // 原始JWT验证函数（不使用缓存）
  async function verifyJWT(token, env) {
    try {
      const config = getSecurityConfig(env);
      const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
      if (!encodedHeader || !encodedPayload || !encodedSignature) return null;
  
      const data = encodedHeader + '.' + encodedPayload;
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(config.JWT_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
      );
  
      const signature = Uint8Array.from(atob(encodedSignature), c => c.charCodeAt(0));
      const isValid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(data));
      if (!isValid) return null;
  
      const payload = JSON.parse(atob(encodedPayload));
      if (payload.exp && Date.now() > payload.exp) return null;
  
      // 检查是否需要刷新令牌
      const tokenAge = Date.now() - payload.iat;
      const halfLife = config.TOKEN_EXPIRY / 2;
      if (tokenAge > halfLife) {
        payload.shouldRefresh = true;
      }
  
      return payload;
    } catch (error) {
      console.error('JWT verification error:', error);
      return null;
    }
  }
  
  // ==================== 安全限制 ====================
  
  function checkRateLimit(clientIP, endpoint, env) {
    const config = getSecurityConfig(env);
    const key = `${clientIP}:${endpoint}`;
    const now = Date.now();
    const windowStart = now - 60000;
  
    if (!rateLimitStore.has(key)) {
      rateLimitStore.set(key, []);
    }
  
    const requests = rateLimitStore.get(key);
    const validRequests = requests.filter(timestamp => timestamp > windowStart);
  
    if (validRequests.length >= config.API_RATE_LIMIT) {
      return false;
    }
  
    validRequests.push(now);
    rateLimitStore.set(key, validRequests);
    return true;
  }
  
  function checkLoginAttempts(clientIP, env) {
    const config = getSecurityConfig(env);
    const now = Date.now();
    const windowStart = now - config.LOGIN_ATTEMPT_WINDOW;
  
    if (!loginAttemptStore.has(clientIP)) {
      loginAttemptStore.set(clientIP, []);
    }
  
    const attempts = loginAttemptStore.get(clientIP);
    const validAttempts = attempts.filter(timestamp => timestamp > windowStart);
    return validAttempts.length < config.MAX_LOGIN_ATTEMPTS;
  }
  
  function recordLoginAttempt(clientIP) {
    const now = Date.now();
    if (!loginAttemptStore.has(clientIP)) {
      loginAttemptStore.set(clientIP, []);
    }
    loginAttemptStore.get(clientIP).push(now);
  }
  
  function getClientIP(request) {
    return request.headers.get('CF-Connecting-IP') ||
           request.headers.get('X-Forwarded-For') ||
           request.headers.get('X-Real-IP') ||
           '127.0.0.1';
  }
  
  // ==================== 数据库结构 ====================
  
  const D1_SCHEMAS = {
    admin_credentials: `
      CREATE TABLE IF NOT EXISTS admin_credentials (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_login INTEGER,
        failed_attempts INTEGER DEFAULT 0,
        locked_until INTEGER DEFAULT NULL,
        must_change_password INTEGER DEFAULT 0,
        password_changed_at INTEGER DEFAULT NULL
      );`,
  
    servers: `
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        api_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        sort_order INTEGER,
        last_notified_down_at INTEGER DEFAULT NULL,
        is_public INTEGER DEFAULT 1
      );`,
  
    metrics: `
      CREATE TABLE IF NOT EXISTS metrics (
        server_id TEXT PRIMARY KEY,
        timestamp INTEGER,
        cpu TEXT,
        memory TEXT,
        disk TEXT,
        network TEXT,
        uptime INTEGER,
        FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
      );`,
  
    monitored_sites: `
      CREATE TABLE IF NOT EXISTS monitored_sites (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        name TEXT,
        added_at INTEGER NOT NULL,
        last_checked INTEGER,
        last_status TEXT DEFAULT 'PENDING',
        last_status_code INTEGER,
        last_response_time_ms INTEGER,
        sort_order INTEGER,
        last_notified_down_at INTEGER DEFAULT NULL,
        is_public INTEGER DEFAULT 1
      );`,
  
    site_status_history: `
      CREATE TABLE IF NOT EXISTS site_status_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        status TEXT NOT NULL,
        status_code INTEGER,
        response_time_ms INTEGER,
        FOREIGN KEY(site_id) REFERENCES monitored_sites(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_site_status_history_site_id_timestamp ON site_status_history (site_id, timestamp DESC);`,
  
    telegram_config: `
      CREATE TABLE IF NOT EXISTS telegram_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        bot_token TEXT,
        chat_id TEXT,
        enable_notifications INTEGER DEFAULT 0,
        updated_at INTEGER
      );
      INSERT OR IGNORE INTO telegram_config (id, bot_token, chat_id, enable_notifications, updated_at) VALUES (1, NULL, NULL, 0, NULL);`,
  
    app_config: `
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      INSERT OR IGNORE INTO app_config (key, value) VALUES ('vps_report_interval_seconds', '60');`,

    monthly_traffic_baselines: `
      CREATE TABLE IF NOT EXISTS monthly_traffic_baselines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT NOT NULL,
        year INTEGER NOT NULL,
        month INTEGER NOT NULL,
        baseline_upload INTEGER NOT NULL DEFAULT 0,
        baseline_download INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE,
        UNIQUE(server_id, year, month)
      );`
  };
  
  // ==================== 数据库初始化 ====================
  
  async function ensureTablesExist(db, env) {
    console.log("初始化数据库表...");
  
    try {
      const createTableStatements = Object.values(D1_SCHEMAS).map(sql => db.prepare(sql));
      await db.batch(createTableStatements);
      console.log("✅ 数据库表创建成功");
    } catch (error) {
      console.error("数据库表创建失败:", error);
    }
  
    await createDefaultAdmin(db, env);
    await applySchemaAlterations(db);
  }
    async function applySchemaAlterations(db) {
    console.log("应用数据库结构更新...");

    const alterStatements = [
      "ALTER TABLE monitored_sites ADD COLUMN last_notified_down_at INTEGER DEFAULT NULL",
      "ALTER TABLE servers ADD COLUMN last_notified_down_at INTEGER DEFAULT NULL",
      "ALTER TABLE metrics ADD COLUMN uptime INTEGER DEFAULT NULL",
      "ALTER TABLE admin_credentials ADD COLUMN password_hash TEXT",
      "ALTER TABLE admin_credentials ADD COLUMN created_at INTEGER",
      "ALTER TABLE admin_credentials ADD COLUMN last_login INTEGER",
      "ALTER TABLE admin_credentials ADD COLUMN failed_attempts INTEGER DEFAULT 0",
      "ALTER TABLE admin_credentials ADD COLUMN locked_until INTEGER DEFAULT NULL",
      "ALTER TABLE admin_credentials ADD COLUMN must_change_password INTEGER DEFAULT 0",
      "ALTER TABLE admin_credentials ADD COLUMN password_changed_at INTEGER DEFAULT NULL",
      "ALTER TABLE servers ADD COLUMN is_public INTEGER DEFAULT 1",
      "ALTER TABLE monitored_sites ADD COLUMN is_public INTEGER DEFAULT 1"
    ];

    for (const alterSql of alterStatements) {
      try {
        await db.exec(alterSql);
      } catch (e) {
        if (!e.message?.includes("duplicate column name") && !e.message?.includes("already exists")) {
          console.error('数据库结构更新错误:', e.message);
        }
      }
    }

    // 创建月结流量基线表索引（如果不存在）
    try {
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_monthly_baselines_server_date ON monthly_traffic_baselines (server_id, year, month)`);
      
      console.log("✅ 月结流量基线表索引创建/验证成功");
    } catch (e) {
      if (!e.message?.includes("already exists") && !e.message?.includes("duplicate")) {
        console.error('创建月结流量基线表索引失败:', e.message);
      }
    }
  }
  
  async function isUsingDefaultPassword(username, password) {
    return username === DEFAULT_ADMIN_CONFIG.USERNAME && password === DEFAULT_ADMIN_CONFIG.PASSWORD;
  }
  
  async function createDefaultAdmin(db, env) {
    try {
      console.log("检查管理员账户...");
  
      const adminExists = await db.prepare(
        "SELECT username FROM admin_credentials WHERE username = ?"
      ).bind(DEFAULT_ADMIN_CONFIG.USERNAME).first();
  
      if (!adminExists) {
        const adminPasswordHash = await hashPassword(DEFAULT_ADMIN_CONFIG.PASSWORD);
        const now = Math.floor(Date.now() / 1000);
  
        await db.prepare(`
          INSERT INTO admin_credentials (username, password_hash, created_at, failed_attempts, must_change_password)
          VALUES (?, ?, ?, 0, 0)
        `).bind(DEFAULT_ADMIN_CONFIG.USERNAME, adminPasswordHash, now).run();
  
        console.log('✅ 已创建默认管理员账户:', DEFAULT_ADMIN_CONFIG.USERNAME);
        console.log('✅ 默认密码:', DEFAULT_ADMIN_CONFIG.PASSWORD);
      } else {
        console.log('✅ 管理员账户已存在:', DEFAULT_ADMIN_CONFIG.USERNAME);
      }
    } catch (error) {
      console.error("创建管理员账户失败:", error);
      if (!error.message.includes('no such table')) {
        throw error;
      }
    }
  }
  
  
  // ==================== 身份验证 ====================
  
  // 优化的认证函数，使用JWT缓存和智能数据库查询
  async function authenticateRequest(request, env) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return null;
  
    const token = authHeader.substring(7);
    const payload = await verifyJWTCached(token, env);
    if (!payload) return null;
  
    // 只有在token需要刷新时才查询数据库验证用户状态
    // 这大大减少了数据库查询次数
    if (payload.shouldRefresh) {
      const user = await env.DB.prepare(
        'SELECT username, locked_until FROM admin_credentials WHERE username = ?'
      ).bind(payload.username).first();
  
      if (!user || (user.locked_until && Date.now() < user.locked_until)) {
        return null;
      }
    }
  
    return payload;
  }
  
  // 可选认证函数 - 用于前台API，支持游客和管理员两种模式
  async function authenticateRequestOptional(request, env) {
    try {
      return await authenticateRequest(request, env);
    } catch (error) {
      return null; // 未登录或认证失败返回null
    }
  }
  
  // ==================== CORS处理 ====================
  
  function getSecureCorsHeaders(origin, env) {
    const config = getSecurityConfig(env);
    const allowedOrigins = config.ALLOWED_ORIGINS;
  
    let allowedOrigin = 'null';
    if (allowedOrigins.length === 0) {
      allowedOrigin = origin || '*';
    } else if (allowedOrigins.includes('*')) {
      allowedOrigin = '*';
    } else if (origin && allowedOrigins.includes(origin)) {
      allowedOrigin = origin;
    }
  
    return {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
      'Access-Control-Allow-Credentials': allowedOrigin !== '*' ? 'true' : 'false',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data:; font-src 'self' https://cdn.jsdelivr.net;"
    };
  }
  
  // ==================== API路由模块 ====================
  
  // 认证路由处理器
  async function handleAuthRoutes(path, method, request, env, corsHeaders, clientIP) {
    // 登录处理
    if (path === '/api/auth/login' && method === 'POST') {
      try {
        if (!checkLoginAttempts(clientIP, env)) {
          return createErrorResponse(
            'Too many login attempts',
            '登录尝试次数过多，请15分钟后再试',
            429,
            corsHeaders
          );
        }
  
        const { username, password } = await request.json();
        if (!username || !password) {
          recordLoginAttempt(clientIP);
          return createErrorResponse(
            'Missing credentials',
            '用户名和密码不能为空',
            400,
            corsHeaders
          );
        }
  
        const user = await env.DB.prepare(
          'SELECT username, password_hash, locked_until, failed_attempts FROM admin_credentials WHERE username = ?'
        ).bind(username).first();
  
        if (!user) {
          recordLoginAttempt(clientIP);
          return createErrorResponse(
            'Invalid credentials',
            '用户名或密码错误',
            401,
            corsHeaders
          );
        }
  
        if (user.locked_until && Date.now() < user.locked_until) {
          return createErrorResponse(
            'Account locked',
            '账户已被锁定，请稍后再试',
            423,
            corsHeaders
          );
        }
  
        const isValidPassword = await verifyPassword(password, user.password_hash);
        if (!isValidPassword) {
          recordLoginAttempt(clientIP);
  
          const newFailedAttempts = (user.failed_attempts || 0) + 1;
          const config = getSecurityConfig(env);
          let lockedUntil = null;
  
          if (newFailedAttempts >= config.MAX_LOGIN_ATTEMPTS) {
            lockedUntil = Date.now() + config.LOGIN_ATTEMPT_WINDOW;
          }
  
          await env.DB.prepare(
            'UPDATE admin_credentials SET failed_attempts = ?, locked_until = ? WHERE username = ?'
          ).bind(newFailedAttempts, lockedUntil, username).run();
  
          return createErrorResponse(
            'Invalid credentials',
            '用户名或密码错误',
            401,
            corsHeaders
          );
        }
  
        // 登录成功，重置失败次数
        await env.DB.prepare(
          'UPDATE admin_credentials SET failed_attempts = 0, locked_until = NULL, last_login = ? WHERE username = ?'
        ).bind(Date.now(), username).run();
  
        const isUsingDefault = await isUsingDefaultPassword(username, password);
        const token = await createJWT({ username, usingDefaultPassword: isUsingDefault }, env);
  
        return createSuccessResponse({
          token,
          user: { username, usingDefaultPassword: isUsingDefault }
        }, corsHeaders);
  
      } catch (error) {
        console.error("登录API错误:", error);
        return handleDbError(error, corsHeaders, '登录');
      }
    }
  
    // 认证状态检查
    if (path === '/api/auth/status' && method === 'GET') {
      try {
        const user = await authenticateRequest(request, env);
        if (!user) {
          return createApiResponse({ authenticated: false }, 200, corsHeaders);
        }
  
        const dbUser = await env.DB.prepare(
          'SELECT username FROM admin_credentials WHERE username = ?'
        ).bind(user.username).first();
  
        if (!dbUser) {
          return createApiResponse({ authenticated: false }, 200, corsHeaders);
        }
  
        return createApiResponse({
          authenticated: true,
          user: {
            username: user.username,
            usingDefaultPassword: user.usingDefaultPassword || false
          }
        }, 200, corsHeaders);
  
      } catch (error) {
        console.error("认证状态检查错误:", error);
        return createApiResponse({ authenticated: false }, 200, corsHeaders);
      }
    }
  
    // 修改密码
    if (path === '/api/auth/change-password' && method === 'POST') {
      try {
        const user = await authenticateRequest(request, env);
        if (!user) {
          return createErrorResponse('Unauthorized', '需要登录', 401, corsHeaders);
        }
  
        const { current_password, new_password } = await request.json();
        if (!current_password || !new_password) {
          return createErrorResponse(
            'Missing fields',
            '当前密码和新密码不能为空',
            400,
            corsHeaders
          );
        }
  
        const config = getSecurityConfig(env);
        if (new_password.length < config.MIN_PASSWORD_LENGTH) {
          return createErrorResponse(
            'Password too short',
            `密码长度至少为${config.MIN_PASSWORD_LENGTH}位`,
            400,
            corsHeaders
          );
        }
  
        const dbUser = await env.DB.prepare(
          'SELECT password_hash FROM admin_credentials WHERE username = ?'
        ).bind(user.username).first();
  
        if (!dbUser || !await verifyPassword(current_password, dbUser.password_hash)) {
          return createErrorResponse(
            'Invalid current password',
            '当前密码错误',
            400,
            corsHeaders
          );
        }
  
        const newPasswordHash = await hashPassword(new_password);
        await env.DB.prepare(
          'UPDATE admin_credentials SET password_hash = ?, password_changed_at = ?, must_change_password = 0 WHERE username = ?'
        ).bind(newPasswordHash, Date.now(), user.username).run();
  
        return createSuccessResponse({ message: '密码修改成功' }, corsHeaders);
  
      } catch (error) {
        console.error("修改密码错误:", error);
        return handleDbError(error, corsHeaders, '修改密码');
      }
    }
  
    return null; // 不匹配此模块的路由
  }
  
  // 服务器管理路由处理器
  async function handleServerRoutes(path, method, request, env, corsHeaders) {
    // 获取服务器列表（公开，支持管理员和游客模式）
    if (path === '/api/servers' && method === 'GET') {
      try {
        const user = await authenticateRequestOptional(request, env);
        const isAdmin = user !== null;
  
        let query = 'SELECT id, name, description FROM servers';
        if (!isAdmin) {
          query += ' WHERE is_public = 1';
        }
        query += ' ORDER BY sort_order ASC NULLS LAST, name ASC';
  
        const { results } = await env.DB.prepare(query).all();
        return createApiResponse({ servers: results || [] }, 200, corsHeaders);
  
      } catch (error) {
        console.error("获取服务器列表错误:", error);
        return handleDbError(error, corsHeaders, '获取服务器列表');
      }
    }
  
    // 管理员获取服务器列表（包含详细信息）
    if (path === '/api/admin/servers' && method === 'GET') {
      const user = await authenticateRequest(request, env);
      if (!user) {
        return createErrorResponse('Unauthorized', '需要管理员权限', 401, corsHeaders);
      }
  
      try {
        const { results } = await env.DB.prepare(`
          SELECT s.id, s.name, s.description, s.created_at, s.sort_order,
                 s.last_notified_down_at, s.api_key, s.is_public, m.timestamp as last_report
          FROM servers s
          LEFT JOIN metrics m ON s.id = m.server_id
          ORDER BY s.sort_order ASC NULLS LAST, s.name ASC
        `).all();
  
        return createApiResponse({ servers: results || [] }, 200, corsHeaders);
  
      } catch (error) {
        console.error("获取管理员服务器列表错误:", error);
        return handleDbError(error, corsHeaders, '获取管理员服务器列表');
      }
    }
  
    // 添加服务器（管理员）
    if (path === '/api/admin/servers' && method === 'POST') {
      const user = await authenticateRequest(request, env);
      if (!user) {
        return createErrorResponse('Unauthorized', '需要管理员权限', 401, corsHeaders);
      }
  
      try {
        const { name, description } = await request.json();
        if (!validateInput(name, 'serverName')) {
          return createErrorResponse(
            'Invalid server name',
            '服务器名称格式无效',
            400,
            corsHeaders
          );
        }
  
        const serverId = Math.random().toString(36).substring(2, 8);
        const apiKey = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
  
        await env.DB.prepare(`
          INSERT INTO servers (id, name, description, api_key, created_at, sort_order, is_public)
          VALUES (?, ?, ?, ?, ?, 0, 1)
        `).bind(serverId, name, description || '', apiKey, now).run();
  
        return createSuccessResponse({
          server: {
            id: serverId,
            name,
            description: description || '',
            api_key: apiKey,
            created_at: now
          }
        }, corsHeaders);
  
      } catch (error) {
        console.error("添加服务器错误:", error);
        return handleDbError(error, corsHeaders, '添加服务器');
      }
    }
  
    // 更新服务器（管理员）
    if (path.match(/\/api\/admin\/servers\/[^\/]+$/) && method === 'PUT') {
      const user = await authenticateRequest(request, env);
      if (!user) {
        return createErrorResponse('Unauthorized', '需要管理员权限', 401, corsHeaders);
      }
  
      try {
        const serverId = extractAndValidateServerId(path);
        if (!serverId) {
          return createErrorResponse(
            'Invalid server ID',
            '无效的服务器ID格式',
            400,
            corsHeaders
          );
        }
  
        const { name, description } = await request.json();
        if (!validateInput(name, 'serverName')) {
          return createErrorResponse(
            'Invalid server name',
            '服务器名称格式无效',
            400,
            corsHeaders
          );
        }
  
        const info = await env.DB.prepare(`
          UPDATE servers SET name = ?, description = ? WHERE id = ?
        `).bind(name, description || '', serverId).run();
  
        if (info.changes === 0) {
          return createErrorResponse('Server not found', '服务器不存在', 404, corsHeaders);
        }
  
        return createSuccessResponse({
          id: serverId,
          name,
          description: description || '',
          message: '服务器更新成功'
        }, corsHeaders);
  
      } catch (error) {
        console.error("更新服务器错误:", error);
        return handleDbError(error, corsHeaders, '更新服务器');
      }
    }
  
    // 删除服务器（管理员）
    if (path.match(/\/api\/admin\/servers\/[^\/]+$/) && method === 'DELETE') {
      const user = await authenticateRequest(request, env);
      if (!user) {
        return createErrorResponse('Unauthorized', '需要管理员权限', 401, corsHeaders);
      }
  
      try {
        const serverId = extractAndValidateServerId(path);
        if (!serverId) {
          return createErrorResponse(
            'Invalid server ID',
            '无效的服务器ID格式',
            400,
            corsHeaders
          );
        }
  
        const info = await env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(serverId).run();
        if (info.changes === 0) {
          return createErrorResponse('Server not found', '服务器不存在', 404, corsHeaders);
        }
  
        // 同时删除相关的监控数据
        await env.DB.prepare('DELETE FROM metrics WHERE server_id = ?').bind(serverId).run();
  
        return createSuccessResponse({ message: '服务器已删除' }, corsHeaders);
  
      } catch (error) {
        console.error("删除服务器错误:", error);
        return handleDbError(error, corsHeaders, '删除服务器');
      }
    }
  
    return null; // 不匹配此模块的路由
  }
  
  // VPS监控路由处理器
  async function handleVpsRoutes(path, method, request, env, corsHeaders) {
    // VPS配置获取（使用API密钥认证）
    if (path.startsWith('/api/config/') && method === 'GET') {
      try {
        const authResult = await validateServerAuth(path, request, env);
        if (!authResult.success) {
          return createErrorResponse(authResult.error, authResult.message,
            authResult.error === 'Invalid server ID' ? 400 : 401, corsHeaders);
        }
  
        const { serverId, serverData } = authResult;
        const reportInterval = await getVpsReportInterval(env);
  
        const configData = {
          success: true,
          config: {
            report_interval: reportInterval,
            enabled_metrics: ['cpu', 'memory', 'disk', 'network', 'uptime'],
            server_info: {
              id: serverData.id,
              name: serverData.name,
              description: serverData.description || ''
            }
          },
          timestamp: Math.floor(Date.now() / 1000)
        };
  
        return createApiResponse(configData, 200, corsHeaders);
  
      } catch (error) {
        console.error("配置获取API错误:", error);
        return handleDbError(error, corsHeaders, '配置获取');
      }
    }
  
    // VPS数据上报
    if (path.startsWith('/api/report/') && method === 'POST') {
      try {
        const authResult = await validateServerAuth(path, request, env);
        if (!authResult.success) {
          return createErrorResponse(authResult.error, authResult.message,
            authResult.error === 'Invalid server ID' ? 400 : 401, corsHeaders);
        }
  
        const { serverId } = authResult;
  
        // 解析和验证上报数据
        let reportData;
        try {
          const rawBody = await request.text();
          console.log('收到的原始数据:', rawBody.substring(0, 200) + '...');
          reportData = JSON.parse(rawBody);
        } catch (parseError) {
          console.error('JSON解析错误:', parseError.message);
          return createErrorResponse(
            'Invalid JSON format',
            `JSON解析失败: ${parseError.message}`,
            400,
            corsHeaders,
            '请检查上报的JSON格式是否正确'
          );
        }
  
        const validationResult = validateAndFixVpsData(reportData);
        if (!validationResult.success) {
          console.error(`VPS数据验证失败:`, validationResult);
          return createErrorResponse(
            validationResult.error,
            validationResult.message,
            400,
            corsHeaders,
            validationResult.details
          );
        }        reportData = validationResult.data;

        // 保存监控数据
        await env.DB.prepare(`
          REPLACE INTO metrics (server_id, timestamp, cpu, memory, disk, network, uptime)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          serverId,
          reportData.timestamp,
          JSON.stringify(reportData.cpu),
          JSON.stringify(reportData.memory),
          JSON.stringify(reportData.disk),
          JSON.stringify(reportData.network),
          reportData.uptime
        ).run();

        // 维护月结流量基线（异步处理，不影响上报响应速度）
        try {
          await getOrCreateMonthlyBaseline(env, serverId);
        } catch (baselineError) {
          console.warn(`维护月结流量基线失败 (服务器: ${serverId}):`, baselineError);
          // 不影响主要的数据上报流程
        }

        const currentInterval = await getVpsReportInterval(env);
        return createSuccessResponse({ interval: currentInterval }, corsHeaders);
  
      } catch (error) {
        console.error("数据上报API错误:", error);
        return handleDbError(error, corsHeaders, '数据上报');
      }
    }
    // VPS状态查询（公开，无需认证）
    if (path.startsWith('/api/status/') && method === 'GET') {
      try {
        const serverId = path.split('/')[3]; // 从 /api/status/{serverId} 提取ID
        if (!serverId) {
          return createErrorResponse('Invalid server ID', '无效的服务器ID', 400, corsHeaders);
        }

        // 查询服务器信息（移除权限限制，让前台能正常显示）
        const serverData = await env.DB.prepare(
          'SELECT id, name, description FROM servers WHERE id = ?'
        ).bind(serverId).first();

        if (!serverData) {
          return createErrorResponse('Server not found', '服务器不存在', 404, corsHeaders);
        }

        // 查询最新的VPS监控数据
        const metricsData = await env.DB.prepare(`
          SELECT * FROM metrics
          WHERE server_id = ?
          ORDER BY timestamp DESC
          LIMIT 1
        `).bind(serverId).first();

        // 解析JSON字符串为对象
        if (metricsData) {
          try {
            if (metricsData.cpu) metricsData.cpu = JSON.parse(metricsData.cpu);
            if (metricsData.memory) metricsData.memory = JSON.parse(metricsData.memory);
            if (metricsData.disk) metricsData.disk = JSON.parse(metricsData.disk);
            if (metricsData.network) metricsData.network = JSON.parse(metricsData.network);
          } catch (parseError) {
            console.error("监控数据JSON解析错误:", parseError);
          }
        }

        return createApiResponse({
          server: serverData,
          metrics: metricsData || null,
          error: false
        }, 200, corsHeaders);

      } catch (error) {
        console.error("VPS状态查询错误:", error);
        return handleDbError(error, corsHeaders, 'VPS状态查询');
      }
    }

    // 获取服务器月结流量数据（公开，无需认证）
    if (path.startsWith('/api/traffic/') && path.endsWith('/monthly') && method === 'GET') {
      try {
        const serverId = path.split('/')[3]; // 从 /api/traffic/{serverId}/monthly 提取ID
        if (!serverId) {
          return createErrorResponse('Invalid server ID', '无效的服务器ID', 400, corsHeaders);
        }

        // 验证服务器是否存在
        const serverData = await env.DB.prepare(
          'SELECT id, name FROM servers WHERE id = ?'
        ).bind(serverId).first();

        if (!serverData) {
          return createErrorResponse('Server not found', '服务器不存在', 404, corsHeaders);
        }

        // 获取月结流量数据
        const monthlyTraffic = await getServerMonthlyTraffic(env, serverId);

        return createApiResponse({
          server: { id: serverData.id, name: serverData.name },
          monthly_traffic: monthlyTraffic,
          success: true
        }, 200, corsHeaders);

      } catch (error) {
        console.error("获取月结流量数据错误:", error);
        return handleDbError(error, corsHeaders, '获取月结流量数据');
      }
    }

    // 重置服务器月结流量基线（管理员）
    if (path.startsWith('/api/admin/traffic/') && path.endsWith('/reset-baseline') && method === 'POST') {
      try {
        const user = await authenticateRequest(request, env);
        if (!user) {
          return createErrorResponse('Unauthorized', '需要管理员权限', 401, corsHeaders);
        }

        const serverId = path.split('/')[4]; // 从 /api/admin/traffic/{serverId}/reset-baseline 提取ID
        if (!serverId) {
          return createErrorResponse('Invalid server ID', '无效的服务器ID', 400, corsHeaders);
        }

        // 验证服务器是否存在
        const serverData = await env.DB.prepare(
          'SELECT id, name FROM servers WHERE id = ?'
        ).bind(serverId).first();

        if (!serverData) {
          return createErrorResponse('Server not found', '服务器不存在', 404, corsHeaders);
        }

        // 重置月度基线
        const resetResult = await resetMonthlyBaseline(env, serverId);

        return createSuccessResponse({
          message: `服务器 ${serverData.name} 的月结流量基线已重置`,
          baseline: resetResult,
          server: { id: serverData.id, name: serverData.name }
        }, corsHeaders);

      } catch (error) {
        console.error("重置月结流量基线错误:", error);
        return handleDbError(error, corsHeaders, '重置月结流量基线');
      }
    }

    return null; // 不匹配此模块的路由
  }
  
  // ==================== API请求处理 ====================
  
  async function handleApiRequest(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const clientIP = getClientIP(request);
    const origin = request.headers.get('Origin');
    const corsHeaders = getSecureCorsHeaders(origin, env);
  
    // OPTIONS请求处理
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
  
    // 速率限制检查（登录接口除外）
    if (path !== '/api/auth/login' && !checkRateLimit(clientIP, path, env)) {
      return createErrorResponse(
        'Rate limit exceeded',
        '请求过于频繁，请稍后再试',
        429,
        corsHeaders
      );
    }
  
    // ==================== 路由分发 ====================
  
    // 认证相关路由
    if (path.startsWith('/api/auth/')) {
      const authResult = await handleAuthRoutes(path, method, request, env, corsHeaders, clientIP);
      if (authResult) return authResult;
    }
  
    // 服务器管理路由
    if (path.startsWith('/api/servers') || path.startsWith('/api/admin/servers')) {
      const serverResult = await handleServerRoutes(path, method, request, env, corsHeaders);
      if (serverResult) return serverResult;
    }
  
    // VPS监控路由
    if (path.startsWith('/api/config/') || path.startsWith('/api/report/') || path.startsWith('/api/status/') || 
        path.startsWith('/api/traffic/') || path.startsWith('/api/admin/traffic/')) {
      const vpsResult = await handleVpsRoutes(path, method, request, env, corsHeaders);
      if (vpsResult) return vpsResult;
    }
  
    // 数据库初始化API（无需认证）
    if (path === '/api/init-db' && ['POST', 'GET'].includes(method)) {
      try {
        console.log("手动触发数据库初始化...");
        await ensureTablesExist(env.DB, env);
        return createSuccessResponse({
          message: '数据库初始化完成'
        }, corsHeaders);
      } catch (error) {
        console.error("数据库初始化失败:", error);
        return createErrorResponse(
          'Database initialization failed',
          `数据库初始化失败: ${error.message}`,
          500,
          corsHeaders
        );
      }
    }
  
  
  
    
  
  
  
  
  
    
  
  
  
  
  
  
  
  
    
  
  
  
  
    
  
  
    // ==================== 高级排序功能 ====================
  
    // 批量服务器排序（管理员）
    if (path === '/api/admin/servers/batch-reorder' && method === 'POST') {
      const user = await authenticateRequest(request, env);
      if (!user) {
        return new Response(JSON.stringify({
          error: 'Unauthorized',
          message: '需要管理员权限'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
  
      try {
        const { serverIds } = await request.json(); // 按新顺序排列的服务器ID数组
  
        if (!Array.isArray(serverIds) || serverIds.length === 0) {
          return new Response(JSON.stringify({
            error: 'Invalid server IDs',
            message: '服务器ID数组无效'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        // 批量更新排序
        const updateStmts = serverIds.map((serverId, index) =>
          env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(index, serverId)
        );
  
        await env.DB.batch(updateStmts);
  
        return new Response(JSON.stringify({
          success: true,
          message: '批量排序完成'
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("批量服务器排序错误:", error);
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
    // 自动服务器排序（管理员）
    if (path === '/api/admin/servers/auto-sort' && method === 'POST') {
      const user = await authenticateRequest(request, env);
      if (!user) {
        return new Response(JSON.stringify({
          error: 'Unauthorized',
          message: '需要管理员权限'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
  
      try {
        const { sortBy, order } = await request.json(); // sortBy: 'custom'|'name'|'status', order: 'asc'|'desc'
  
        const validSortFields = ['custom', 'name', 'status'];
        const validOrders = ['asc', 'desc'];
  
        if (!validSortFields.includes(sortBy) || !validOrders.includes(order)) {
          return new Response(JSON.stringify({
            error: 'Invalid sort parameters',
            message: '无效的排序参数'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        // 如果是自定义排序，直接返回成功，不做任何操作
        if (sortBy === 'custom') {
          return new Response(JSON.stringify({
            success: true,
            message: '已设置为自定义排序'
          }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        // 获取所有服务器并排序
        let orderClause = '';
        if (sortBy === 'name') {
          orderClause = `ORDER BY name ${order.toUpperCase()}`;
        } else if (sortBy === 'status') {
          orderClause = `ORDER BY (CASE WHEN m.timestamp IS NULL OR (strftime('%s', 'now') - m.timestamp) > 300 THEN 1 ELSE 0 END) ${order.toUpperCase()}, name ASC`;
        }
  
        const { results: servers } = await env.DB.prepare(`
          SELECT s.id FROM servers s
          LEFT JOIN metrics m ON s.id = m.server_id
          ${orderClause}
        `).all();
  
        // 批量更新排序
        const updateStmts = servers.map((server, index) =>
          env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(index, server.id)
        );
  
        await env.DB.batch(updateStmts);
  
        return new Response(JSON.stringify({
          success: true,
          message: `已按${sortBy}${order === 'asc' ? '升序' : '降序'}排序`
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("自动服务器排序错误:", error);
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
    // 服务器排序（管理员）- 保留原有的单个移动功能
    if (path.match(/\/api\/admin\/servers\/[^\/]+\/reorder$/) && method === 'POST') {
      try {
        const serverId = extractPathSegment(path, 4);
        if (!serverId) {
          return new Response(JSON.stringify({
            error: 'Invalid server ID',
            message: '无效的服务器ID格式'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        const { direction } = await request.json();
        if (!['up', 'down'].includes(direction)) {
          return new Response(JSON.stringify({
            error: 'Invalid direction'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        // 获取所有服务器排序信息
        const results = await env.DB.batch([
          env.DB.prepare('SELECT id, sort_order FROM servers ORDER BY sort_order ASC NULLS LAST, name ASC')
        ]);
  
        const allServers = results[0].results;
        const currentIndex = allServers.findIndex(s => s.id === serverId);
  
        if (currentIndex === -1) {
          return new Response(JSON.stringify({
            error: 'Server not found'
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        // 计算目标位置
        let targetIndex = -1;
        if (direction === 'up' && currentIndex > 0) {
          targetIndex = currentIndex - 1;
        } else if (direction === 'down' && currentIndex < allServers.length - 1) {
          targetIndex = currentIndex + 1;
        }
  
        if (targetIndex !== -1) {
          const currentServer = allServers[currentIndex];
          const targetServer = allServers[targetIndex];
  
          // 处理排序值交换
          if (currentServer.sort_order === null || targetServer.sort_order === null) {
            console.warn("检测到NULL排序值，重新分配所有排序");
            const updateStmts = allServers.map((server, index) =>
              env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(index, server.id)
            );
            await env.DB.batch(updateStmts);
  
            // 重新获取并交换
            const updatedResults = await env.DB.batch([
              env.DB.prepare('SELECT id, sort_order FROM servers ORDER BY sort_order ASC')
            ]);
            const updatedServers = updatedResults[0].results;
            const newCurrentIndex = updatedServers.findIndex(s => s.id === serverId);
            let newTargetIndex = -1;
  
            if (direction === 'up' && newCurrentIndex > 0) {
              newTargetIndex = newCurrentIndex - 1;
            } else if (direction === 'down' && newCurrentIndex < updatedServers.length - 1) {
              newTargetIndex = newCurrentIndex + 1;
            }
  
            if (newTargetIndex !== -1) {
              const newCurrentOrder = updatedServers[newCurrentIndex].sort_order;
              const newTargetOrder = updatedServers[newTargetIndex].sort_order;
              await env.DB.batch([
                env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(newTargetOrder, serverId),
                env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(newCurrentOrder, updatedServers[newTargetIndex].id)
              ]);
            }
          } else {
            // 直接交换排序值
            await env.DB.batch([
              env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(targetServer.sort_order, serverId),
              env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(currentServer.sort_order, targetServer.id)
            ]);
          }
        }
  
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("管理员服务器排序错误:", error);
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
    // 更新服务器显示状态（管理员）
    if (path.match(/^\/api\/admin\/servers\/([^\/]+)\/visibility$/) && method === 'POST') {
      const user = await authenticateRequest(request, env);
      if (!user) {
        return new Response(JSON.stringify({
          error: 'Unauthorized',
          message: '需要管理员权限'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
  
      try {
        const serverId = path.split('/')[4];
        const { is_public } = await request.json();
  
        // 验证输入
        if (typeof is_public !== 'boolean') {
          return new Response(JSON.stringify({
            error: 'Invalid input',
            message: '显示状态必须为布尔值'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        // 更新服务器显示状态
        await env.DB.prepare(`
          UPDATE servers SET is_public = ? WHERE id = ?
        `).bind(is_public ? 1 : 0, serverId).run();
  
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("更新服务器显示状态错误:", error);
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
  
  
    // ==================== 网站监控API ====================
  
    // 获取监控站点列表（管理员）
    if (path === '/api/admin/sites' && method === 'GET') {
      const user = await authenticateRequest(request, env);
      if (!user) {
        return new Response(JSON.stringify({
          error: 'Unauthorized',
          message: '需要管理员权限'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
  
      try {
        const { results } = await env.DB.prepare(`
          SELECT id, name, url, added_at, last_checked, last_status, last_status_code,
                 last_response_time_ms, sort_order, last_notified_down_at, is_public
          FROM monitored_sites
          ORDER BY sort_order ASC NULLS LAST, name ASC, url ASC
        `).all();
  
        return new Response(JSON.stringify({ sites: results || [] }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("管理员获取监控站点错误:", error);
        if (error.message.includes('no such table')) {
          console.warn("监控站点表不存在，尝试创建...");
          try {
            await env.DB.exec(D1_SCHEMAS.monitored_sites);
            return new Response(JSON.stringify({ sites: [] }), {
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          } catch (createError) {
            console.error("创建监控站点表失败:", createError);
          }
        }
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: '服务器内部错误'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
    // 添加监控站点（管理员）
    if (path === '/api/admin/sites' && method === 'POST') {
      const user = await authenticateRequest(request, env);
      if (!user) {
        return new Response(JSON.stringify({
          error: 'Unauthorized',
          message: '需要管理员权限'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
  
      try {
        const { url, name } = await request.json();
  
        if (!url || !isValidHttpUrl(url)) {
          return new Response(JSON.stringify({
            error: 'Valid URL is required',
            message: '请输入有效的URL'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        const siteId = Math.random().toString(36).substring(2, 12);
        const addedAt = Math.floor(Date.now() / 1000);
  
        // 获取下一个排序序号
        const maxOrderResult = await env.DB.prepare(
          'SELECT MAX(sort_order) as max_order FROM monitored_sites'
        ).first();
        const nextSortOrder = (maxOrderResult?.max_order && typeof maxOrderResult.max_order === 'number')
          ? maxOrderResult.max_order + 1
          : 0;
  
        await env.DB.prepare(`
          INSERT INTO monitored_sites (id, url, name, added_at, last_status, sort_order)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(siteId, url, name || '', addedAt, 'PENDING', nextSortOrder).run();
  
        const siteData = {
          id: siteId,
          url,
          name: name || '',
          added_at: addedAt,
          last_status: 'PENDING',
          sort_order: nextSortOrder
        };
  
        // 立即执行健康检查
        const newSiteForCheck = { id: siteId, url, name: name || '' };
        if (ctx?.waitUntil) {
          ctx.waitUntil(checkWebsiteStatus(newSiteForCheck, env.DB, ctx));
          console.log(`已安排新站点立即健康检查: ${siteId} (${url})`);
        } else {
          console.warn("ctx.waitUntil不可用，尝试直接调用检查");
          checkWebsiteStatus(newSiteForCheck, env.DB, ctx).catch(e =>
            console.error("直接站点检查错误:", e)
          );
        }
  
        return new Response(JSON.stringify({ site: siteData }), {
          status: 201,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("管理员添加监控站点错误:", error);
  
        if (error.message.includes('UNIQUE constraint failed')) {
          return new Response(JSON.stringify({
            error: 'URL already exists or ID conflict',
            message: '该URL已被监控或ID冲突'
          }), {
            status: 409,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        if (error.message.includes('no such table')) {
          console.warn("监控站点表不存在，尝试创建...");
          try {
            await env.DB.exec(D1_SCHEMAS.monitored_sites);
            return new Response(JSON.stringify({
              error: 'Database table created, please retry',
              message: '数据库表已创建，请重试添加操作'
            }), {
              status: 503,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          } catch (createError) {
            console.error("创建监控站点表失败:", createError);
          }
        }
  
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
    // 更新监控站点（管理员）
    if (path.match(/\/api\/admin\/sites\/[^\/]+$/) && method === 'PUT') {
      try {
        const siteId = extractAndValidateServerId(path);
        if (!siteId) {
          return new Response(JSON.stringify({
            error: 'Invalid site ID',
            message: '无效的站点ID格式'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        const { url, name } = await request.json();
        const setClauses = [];
        const bindings = [];
  
        if (url !== undefined) {
          if (!isValidHttpUrl(url)) {
            return new Response(JSON.stringify({
              error: 'Valid URL is required if provided'
            }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          setClauses.push("url = ?");
          bindings.push(url);
        }
  
        if (name !== undefined) {
          setClauses.push("name = ?");
          bindings.push(name || '');
        }
  
        if (setClauses.length === 0) {
          return new Response(JSON.stringify({
            error: 'No fields to update provided'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        bindings.push(siteId);
        const info = await env.DB.prepare(
          `UPDATE monitored_sites SET ${setClauses.join(', ')} WHERE id = ?`
        ).bind(...bindings).run();
  
        if (info.changes === 0) {
          return new Response(JSON.stringify({
            error: 'Site not found or no changes made'
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        const updatedSite = await env.DB.prepare(`
          SELECT id, url, name, added_at, last_checked, last_status, last_status_code,
                 last_response_time_ms, sort_order
          FROM monitored_sites WHERE id = ?
        `).bind(siteId).first();
  
        return new Response(JSON.stringify({ site: updatedSite }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
  
      } catch (error) {
        console.error("管理员更新监控站点错误:", error);
        if (error.message.includes('UNIQUE constraint failed')) {
          return new Response(JSON.stringify({
            error: 'URL already exists for another site',
            message: '该URL已被其他监控站点使用'
          }), {
            status: 409,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
    // 更新监控站点（管理员）
    if (path.match(/\/api\/admin\/sites\/[^\/]+$/) && method === 'PUT') {
      const user = await authenticateRequest(request, env);
      if (!user) {
        return createErrorResponse('Unauthorized', '需要管理员权限', 401, corsHeaders);
      }
  
      try {
        const siteId = path.split('/').pop();
        if (!siteId) {
          return createErrorResponse('Invalid site ID', '无效的网站ID', 400, corsHeaders);
        }
  
        const { url, name } = await request.json();
        if (!url || !url.trim()) {
          return createErrorResponse('Invalid URL', 'URL不能为空', 400, corsHeaders);
        }
  
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          return createErrorResponse('Invalid URL format', 'URL必须以http://或https://开头', 400, corsHeaders);
        }
  
        const info = await env.DB.prepare(`
          UPDATE monitored_sites SET url = ?, name = ? WHERE id = ?
        `).bind(url.trim(), name?.trim() || '', siteId).run();
  
        if (info.changes === 0) {
          return createErrorResponse('Site not found', '网站不存在', 404, corsHeaders);
        }
  
        return createSuccessResponse({
          id: siteId,
          url: url.trim(),
          name: name?.trim() || '',
          message: '网站更新成功'
        }, corsHeaders);
  
      } catch (error) {
        console.error("更新监控站点错误:", error);
        return handleDbError(error, corsHeaders, '更新监控站点');
      }
    }
  
    // 删除监控站点（管理员）
    if (path.match(/\/api\/admin\/sites\/[^\/]+$/) && method === 'DELETE') {
      try {
        const siteId = extractAndValidateServerId(path);
        if (!siteId) {
          return new Response(JSON.stringify({
            error: 'Invalid site ID',
            message: '无效的站点ID格式'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        const info = await env.DB.prepare('DELETE FROM monitored_sites WHERE id = ?').bind(siteId).run();
  
        if (info.changes === 0) {
          return new Response(JSON.stringify({
            error: 'Site not found'
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("管理员删除监控站点错误:", error);
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
    // 批量网站排序（管理员）
    if (path === '/api/admin/sites/batch-reorder' && method === 'POST') {
      const user = await authenticateRequest(request, env);
      if (!user) {
        return new Response(JSON.stringify({
          error: 'Unauthorized',
          message: '需要管理员权限'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
  
      try {
        const { siteIds } = await request.json(); // 按新顺序排列的站点ID数组
  
        if (!Array.isArray(siteIds) || siteIds.length === 0) {
          return new Response(JSON.stringify({
            error: 'Invalid site IDs',
            message: '站点ID数组无效'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        // 批量更新排序
        const updateStmts = siteIds.map((siteId, index) =>
          env.DB.prepare('UPDATE monitored_sites SET sort_order = ? WHERE id = ?').bind(index, siteId)
        );
  
        await env.DB.batch(updateStmts);
  
        return new Response(JSON.stringify({
          success: true,
          message: '批量排序完成'
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("批量网站排序错误:", error);
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
    // 自动网站排序（管理员）
    if (path === '/api/admin/sites/auto-sort' && method === 'POST') {
      const user = await authenticateRequest(request, env);
      if (!user) {
        return new Response(JSON.stringify({
          error: 'Unauthorized',
          message: '需要管理员权限'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
  
      try {
        const { sortBy, order } = await request.json(); // sortBy: 'custom'|'name'|'url'|'status', order: 'asc'|'desc'
  
        const validSortFields = ['custom', 'name', 'url', 'status'];
        const validOrders = ['asc', 'desc'];
  
        if (!validSortFields.includes(sortBy) || !validOrders.includes(order)) {
          return new Response(JSON.stringify({
            error: 'Invalid sort parameters',
            message: '无效的排序参数'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        // 如果是自定义排序，直接返回成功，不做任何操作
        if (sortBy === 'custom') {
          return new Response(JSON.stringify({
            success: true,
            message: '已设置为自定义排序'
          }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        // 获取所有站点并排序
        const { results: sites } = await env.DB.prepare(`
          SELECT id FROM monitored_sites
          ORDER BY ${sortBy} ${order.toUpperCase()}
        `).all();
  
        // 批量更新排序
        const updateStmts = sites.map((site, index) =>
          env.DB.prepare('UPDATE monitored_sites SET sort_order = ? WHERE id = ?').bind(index, site.id)
        );
  
        await env.DB.batch(updateStmts);
  
        return new Response(JSON.stringify({
          success: true,
          message: `已按${sortBy}${order === 'asc' ? '升序' : '降序'}排序`
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("自动网站排序错误:", error);
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
    // 网站排序（管理员）- 保留原有的单个移动功能
    if (path.match(/\/api\/admin\/sites\/[^\/]+\/reorder$/) && method === 'POST') {
      try {
        const siteId = extractPathSegment(path, 4);
        if (!siteId) {
          return new Response(JSON.stringify({
            error: 'Invalid site ID',
            message: '无效的站点ID格式'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        const { direction } = await request.json();
        if (!['up', 'down'].includes(direction)) {
          return new Response(JSON.stringify({
            error: 'Invalid direction'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        // 获取所有站点排序信息
        const results = await env.DB.batch([
          env.DB.prepare('SELECT id, sort_order FROM monitored_sites ORDER BY sort_order ASC NULLS LAST, name ASC, url ASC')
        ]);
        const allSites = results[0].results;
        const currentIndex = allSites.findIndex(s => s.id === siteId);
  
        if (currentIndex === -1) {
          return new Response(JSON.stringify({
            error: 'Site not found'
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        // 计算目标位置
        let targetIndex = -1;
        if (direction === 'up' && currentIndex > 0) {
          targetIndex = currentIndex - 1;
        } else if (direction === 'down' && currentIndex < allSites.length - 1) {
          targetIndex = currentIndex + 1;
        }
  
        if (targetIndex !== -1) {
          const currentSite = allSites[currentIndex];
          const targetSite = allSites[targetIndex];
  
          // 处理排序值交换
          if (currentSite.sort_order === null || targetSite.sort_order === null) {
            console.warn("检测到NULL排序值，重新分配所有站点排序");
            const updateStmts = allSites.map((site, index) =>
              env.DB.prepare('UPDATE monitored_sites SET sort_order = ? WHERE id = ?').bind(index, site.id)
            );
            await env.DB.batch(updateStmts);
  
            // 重新获取并交换
            const updatedResults = await env.DB.batch([
              env.DB.prepare('SELECT id, sort_order FROM monitored_sites ORDER BY sort_order ASC')
            ]);
            const updatedSites = updatedResults[0].results;
            const newCurrentIndex = updatedSites.findIndex(s => s.id === siteId);
            let newTargetIndex = -1;
  
            if (direction === 'up' && newCurrentIndex > 0) {
              newTargetIndex = newCurrentIndex - 1;
            } else if (direction === 'down' && newCurrentIndex < updatedSites.length - 1) {
              newTargetIndex = newCurrentIndex + 1;
            }
  
            if (newTargetIndex !== -1) {
              const newCurrentOrder = updatedSites[newCurrentIndex].sort_order;
              const newTargetOrder = updatedSites[newTargetIndex].sort_order;
              await env.DB.batch([
                env.DB.prepare('UPDATE monitored_sites SET sort_order = ? WHERE id = ?').bind(newTargetOrder, siteId),
                env.DB.prepare('UPDATE monitored_sites SET sort_order = ? WHERE id = ?').bind(newCurrentOrder, updatedSites[newTargetIndex].id)
              ]);
            }
          } else {
            // 直接交换排序值
            await env.DB.batch([
              env.DB.prepare('UPDATE monitored_sites SET sort_order = ? WHERE id = ?').bind(targetSite.sort_order, siteId),
              env.DB.prepare('UPDATE monitored_sites SET sort_order = ? WHERE id = ?').bind(currentSite.sort_order, targetSite.id)
            ]);
          }
        }
  
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("管理员网站排序错误:", error);
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
    // 更新网站显示状态（管理员）
    if (path.match(/^\/api\/admin\/sites\/([^\/]+)\/visibility$/) && method === 'POST') {
      const user = await authenticateRequest(request, env);
      if (!user) {
        return new Response(JSON.stringify({
          error: 'Unauthorized',
          message: '需要管理员权限'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
  
      try {
        const siteId = path.split('/')[4];
        const { is_public } = await request.json();
  
        // 验证输入
        if (typeof is_public !== 'boolean') {
          return new Response(JSON.stringify({
            error: 'Invalid input',
            message: '显示状态必须为布尔值'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        // 更新网站显示状态
        await env.DB.prepare(`
          UPDATE monitored_sites SET is_public = ? WHERE id = ?
        `).bind(is_public ? 1 : 0, siteId).run();
  
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("更新网站显示状态错误:", error);
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
  
    // ==================== 公共API ====================
  
    // 获取所有监控站点状态（公开，支持管理员和游客模式）
    if (path === '/api/sites/status' && method === 'GET') {
      try {
        // 检查是否为管理员登录状态
        const user = await authenticateRequestOptional(request, env);
        const isAdmin = user !== null;
  
        let query = `
          SELECT id, name, last_checked, last_status, last_status_code, last_response_time_ms
          FROM monitored_sites
        `;
        if (!isAdmin) {
          query += ` WHERE is_public = 1`;
        }
        query += ` ORDER BY sort_order ASC NULLS LAST, name ASC, id ASC`;
  
        const { results } = await env.DB.prepare(query).all();
        const sites = results || [];
  
        // 为每个站点附加24小时历史数据
        const nowSeconds = Math.floor(Date.now() / 1000);
        const twentyFourHoursAgoSeconds = nowSeconds - (24 * 60 * 60);
  
        for (const site of sites) {
          try {
            const { results: historyResults } = await env.DB.prepare(`
              SELECT timestamp, status, status_code, response_time_ms
              FROM site_status_history
              WHERE site_id = ? AND timestamp >= ?
              ORDER BY timestamp DESC
            `).bind(site.id, twentyFourHoursAgoSeconds).all();
  
            site.history = historyResults || [];
          } catch (historyError) {
            console.error(`获取站点 ${site.id} 历史数据错误:`, historyError);
            site.history = [];
          }
        }
  
        return new Response(JSON.stringify({ sites }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("获取站点状态错误:", error);
        if (error.message.includes('no such table')) {
          console.warn("监控站点表不存在，尝试创建...");
          try {
            await env.DB.exec(D1_SCHEMAS.monitored_sites);
            return new Response(JSON.stringify({ sites: [] }), {
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          } catch (createError) {
            console.error("创建监控站点表失败:", createError);
          }
        }
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
    // ==================== VPS配置API ====================
  
    // 获取VPS上报间隔（公开，优化版本）
    if (path === '/api/admin/settings/vps-report-interval' && method === 'GET') {
      try {
        // 优化：减少数据库查询，快速返回默认值或缓存值
        let interval = 60; // 默认值
  
        try {
          const result = await env.DB.prepare(
            'SELECT value FROM app_config WHERE key = ?'
          ).bind('vps_report_interval_seconds').first();
  
          if (result && result.value) {
            const parsedInterval = parseInt(result.value, 10);
            if (!isNaN(parsedInterval) && parsedInterval > 0) {
              interval = parsedInterval;
            }
          }
        } catch (dbError) {
          console.warn("数据库查询VPS间隔失败，使用默认值:", dbError);
          // 继续使用默认值，不阻塞响应
        }
  
        return new Response(JSON.stringify({ interval }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("获取VPS上报间隔错误:", error);
        // 任何错误都返回默认值，确保系统继续工作
        return new Response(JSON.stringify({ interval: 60 }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
    // 设置VPS上报间隔（管理员）
    if (path === '/api/admin/settings/vps-report-interval' && method === 'POST') {
      const user = await authenticateRequest(request, env);
      if (!user) {
        return new Response(JSON.stringify({
          error: 'Unauthorized',
          message: '需要管理员权限'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
  
      try {
        const { interval } = await request.json();
        if (typeof interval !== 'number' || interval <= 0 || !Number.isInteger(interval)) {
          return new Response(JSON.stringify({
            error: 'Invalid interval value. Must be a positive integer (seconds).'
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
  
        await env.DB.prepare('REPLACE INTO app_config (key, value) VALUES (?, ?)').bind(
          'vps_report_interval_seconds',
          interval.toString()
        ).run();
  
        return new Response(JSON.stringify({ success: true, interval }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("更新VPS上报间隔错误:", error);
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
  
    // ==================== Telegram配置API ====================
  
    // 获取Telegram设置（管理员）
    if (path === '/api/admin/telegram-settings' && method === 'GET') {
      const user = await authenticateRequest(request, env);
      if (!user) {
        return new Response(JSON.stringify({
          error: 'Unauthorized',
          message: '需要管理员权限'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
  
      try {
        const settings = await env.DB.prepare(
          'SELECT bot_token, chat_id, enable_notifications FROM telegram_config WHERE id = 1'
        ).first();
  
        return new Response(JSON.stringify(
          settings || { bot_token: null, chat_id: null, enable_notifications: 0 }
        ), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("获取Telegram设置错误:", error);
        if (error.message.includes('no such table')) {
          try {
            await env.DB.exec(D1_SCHEMAS.telegram_config);
            return new Response(JSON.stringify({
              bot_token: null,
              chat_id: null,
              enable_notifications: 0
            }), {
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          } catch (createError) {
            console.error("创建Telegram配置表失败:", createError);
          }
        }
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
    // 设置Telegram配置（管理员）
    if (path === '/api/admin/telegram-settings' && method === 'POST') {
      const user = await authenticateRequest(request, env);
      if (!user) {
        return new Response(JSON.stringify({
          error: 'Unauthorized',
          message: '需要管理员权限'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
  
      try {
        const { bot_token, chat_id, enable_notifications } = await request.json();
        const updatedAt = Math.floor(Date.now() / 1000);
        const enableNotifValue = (enable_notifications === true || enable_notifications === 1) ? 1 : 0;
  
        await env.DB.prepare(`
          UPDATE telegram_config SET bot_token = ?, chat_id = ?, enable_notifications = ?, updated_at = ? WHERE id = 1
        `).bind(bot_token || null, chat_id || null, enableNotifValue, updatedAt).run();
  
        // 发送测试通知
        if (enableNotifValue === 1 && bot_token && chat_id) {
          const testMessage = "✅ Telegram通知已在此监控面板激活。这是一条测试消息。";
          if (ctx?.waitUntil) {
            ctx.waitUntil(sendTelegramNotification(env.DB, testMessage));
          } else {
            console.warn("ctx.waitUntil不可用，尝试直接发送测试通知");
            sendTelegramNotification(env.DB, testMessage).catch(e =>
              console.error("发送测试通知错误:", e)
            );
          }
        }
  
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("更新Telegram设置错误:", error);
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
  
  
  
  
    // 获取监控站点24小时历史状态（公开）
    if (path.match(/\/api\/sites\/[^\/]+\/history$/) && method === 'GET') {
      try {
        const siteId = path.split('/')[3];
        const nowSeconds = Math.floor(Date.now() / 1000);
        const twentyFourHoursAgoSeconds = nowSeconds - (24 * 60 * 60);
  
        const { results } = await env.DB.prepare(`
          SELECT timestamp, status, status_code, response_time_ms
          FROM site_status_history
          WHERE site_id = ? AND timestamp >= ?
          ORDER BY timestamp DESC
        `).bind(siteId, twentyFourHoursAgoSeconds).all();
  
        return new Response(JSON.stringify({ history: results || [] }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (error) {
        console.error("获取站点历史错误:", error);
        if (error.message.includes('no such table')) {
          console.warn("站点状态历史表不存在，返回空列表");
          try {
            await env.DB.exec(D1_SCHEMAS.site_status_history);
            return new Response(JSON.stringify({ history: [] }), {
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          } catch (createError) {
            console.error("创建站点状态历史表失败:", createError);
          }
        }
        return new Response(JSON.stringify({
          error: 'Internal server error',
          message: error.message
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
    }
  
  
    // 未找到匹配的API路由
    return new Response(JSON.stringify({ error: 'API endpoint not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
  
  
  // --- Scheduled Task for Website Monitoring ---
  
  // ==================== Telegram通知 ====================
  
  async function sendTelegramNotification(db, message) {
    try {
      const config = await db.prepare(
        'SELECT bot_token, chat_id, enable_notifications FROM telegram_config WHERE id = 1'
      ).first();
  
      if (!config?.enable_notifications || !config.bot_token || !config.chat_id) {
        console.log("Telegram通知未启用或配置不完整");
        return;
      }
  
      const response = await fetch(`https://api.telegram.org/bot${config.bot_token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.chat_id,
          text: message,
          parse_mode: 'Markdown'
        })
      });
  
      if (response.ok) {
        console.log("Telegram通知发送成功");
      } else {
        const errorData = await response.json();
        console.error(`Telegram通知发送失败: ${response.status}`, errorData);
      }
    } catch (error) {
      console.error("Telegram通知发送错误:", error);
    }
  }
  
  
  async function checkWebsiteStatus(site, db, ctx) { // Added ctx for waitUntil
    const { id, url, name } = site; // Added name
    const startTime = Date.now();
    let newStatus = 'PENDING'; // Renamed to newStatus to avoid conflict
    let newStatusCode = null; // Renamed
    let newResponseTime = null; // Renamed
  
    // Get current status and last notification time from DB
    let previousStatus = 'PENDING';
    let siteLastNotifiedDownAt = null;
  
    try {
      const siteDetailsStmt = db.prepare('SELECT last_status, last_notified_down_at FROM monitored_sites WHERE id = ?'); // Removed enable_frequent_down_notifications
      const siteDetailsResult = await siteDetailsStmt.bind(id).first();
      if (siteDetailsResult) {
        previousStatus = siteDetailsResult.last_status || 'PENDING';
        siteLastNotifiedDownAt = siteDetailsResult.last_notified_down_at;
      }
    } catch (e) {
      console.error(`获取网站 ${id} 详情错误:`, e);
    }
    const NOTIFICATION_INTERVAL_SECONDS = 1 * 60 * 60; // 1 hour
  
  
    try {
      const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15000) });
      newResponseTime = Date.now() - startTime;
      newStatusCode = response.status;
  
      if (response.ok || (response.status >= 300 && response.status < 500)) { // 2xx, 3xx, and 4xx are considered UP
        newStatus = 'UP';
      } else {
        newStatus = 'DOWN';
      }
    } catch (error) {
      newResponseTime = Date.now() - startTime;
      if (error.name === 'TimeoutError') {
        newStatus = 'TIMEOUT';
      } else {
        newStatus = 'ERROR';
        console.error(`检查网站 ${id} (${url}) 错误:`, error.message);
      }
    }
  
    const checkTime = Math.floor(Date.now() / 1000);
    const siteDisplayName = name || url;
    let newSiteLastNotifiedDownAt = siteLastNotifiedDownAt; // Preserve by default
  
    if (['DOWN', 'TIMEOUT', 'ERROR'].includes(newStatus)) {
      const isFirstTimeDown = !['DOWN', 'TIMEOUT', 'ERROR'].includes(previousStatus);
      if (isFirstTimeDown) {
        // Site just went down
        const message = `🔴 网站故障: *${siteDisplayName}* 当前状态 ${newStatus.toLowerCase()} (状态码: ${newStatusCode || '无'}).\n网址: ${url}`;
        ctx.waitUntil(sendTelegramNotification(db, message));
        newSiteLastNotifiedDownAt = checkTime;
        console.log(`网站 ${siteDisplayName} 刚刚故障。已发送初始通知。last_notified_down_at 已更新。`);
      } else {
        // Site is still down, check if 1-hour interval has passed for resend
        const shouldResend = siteLastNotifiedDownAt === null || (checkTime - siteLastNotifiedDownAt > NOTIFICATION_INTERVAL_SECONDS);
        if (shouldResend) {
          const message = `🔴 网站持续故障: *${siteDisplayName}* 状态 ${newStatus.toLowerCase()} (状态码: ${newStatusCode || '无'}).\n网址: ${url}`;
          ctx.waitUntil(sendTelegramNotification(db, message));
          newSiteLastNotifiedDownAt = checkTime;
          console.log(`网站 ${siteDisplayName} 持续故障。已发送重复通知。last_notified_down_at 已更新。`);
        } else {
          console.log(`网站 ${siteDisplayName} 持续故障，但1小时通知间隔未到。`);
        }
      }
    } else if (newStatus === 'UP' && ['DOWN', 'TIMEOUT', 'ERROR'].includes(previousStatus)) {
      // Site just came back up
      const message = `✅ 网站恢复: *${siteDisplayName}* 已恢复在线!\n网址: ${url}`;
      ctx.waitUntil(sendTelegramNotification(db, message));
      newSiteLastNotifiedDownAt = null; // Clear notification timestamp as site is up
      console.log(`网站 ${siteDisplayName} 已恢复。已发送通知。last_notified_down_at 已清除。`);
    }
  
    // Update D1
    try {
      const updateSiteStmt = db.prepare(
        'UPDATE monitored_sites SET last_checked = ?, last_status = ?, last_status_code = ?, last_response_time_ms = ?, last_notified_down_at = ? WHERE id = ?'
      );
      const recordHistoryStmt = db.prepare(
        'INSERT INTO site_status_history (site_id, timestamp, status, status_code, response_time_ms) VALUES (?, ?, ?, ?, ?)'
      );
      
      await db.batch([
        updateSiteStmt.bind(checkTime, newStatus, newStatusCode, newResponseTime, newSiteLastNotifiedDownAt, id),
        recordHistoryStmt.bind(id, checkTime, newStatus, newStatusCode, newResponseTime)
      ]);
      console.log(`已检查网站 ${id} (${url}): ${newStatus} (${newStatusCode || '无'}), ${newResponseTime}ms。历史已记录。通知时间戳已更新。`);
    } catch (dbError) {
      console.error(`更新网站 ${id} (${url}) 状态或记录历史到D1失败:`, dbError);
    }
  }
  
  // ==================== 主函数导出 ====================
  
  export default {
    async fetch(request, env, ctx) {
      // 初始化数据库表
      try {
        await ensureTablesExist(env.DB, env);
      } catch (error) {
        console.error("数据库初始化失败:", error);
        // 继续执行，各个端点会处理缺失的表
      }
  
      const url = new URL(request.url);
      const path = url.pathname;
  
      // API请求处理
      if (path.startsWith('/api/')) {
        return handleApiRequest(request, env, ctx);
      }
  
      // 安装脚本处理
      if (path === '/install.sh') {
        return handleInstallScript(request, url, env);
      }
  
      // 前端静态文件处理
      return handleFrontendRequest(request, path);
    },
  
    async scheduled(event, env, ctx) {
      console.log(`定时任务触发: ${event.cron} - 开始执行状态检查...`);
      ctx.waitUntil(
        (async () => {
          try {
            // 确保数据库表存在
            await ensureTablesExist(env.DB, env);
  
            // ==================== 网站监控部分 ====================
            console.log("开始定时网站检查...");
            const { results: sitesToCheck } = await env.DB.prepare(
              'SELECT id, url, name FROM monitored_sites'
            ).all();
  
            if (sitesToCheck?.length > 0) {
              console.log(`发现 ${sitesToCheck.length} 个站点需要检查`);
              const sitePromises = [];
              const siteConcurrencyLimit = 10;
  
              for (const site of sitesToCheck) {
                sitePromises.push(checkWebsiteStatus(site, env.DB, ctx));
                if (sitePromises.length >= siteConcurrencyLimit) {
                  await Promise.all(sitePromises);
                  sitePromises.length = 0;
                }
              }
  
              if (sitePromises.length > 0) {
                await Promise.all(sitePromises);
              }
              console.log("网站状态检查完成");
            } else {
              console.log("未配置监控网站");
            }
  
            // ==================== VPS监控部分 ====================
            console.log("开始定时VPS状态检查...");
            const telegramConfig = await env.DB.prepare(
              'SELECT bot_token, chat_id, enable_notifications FROM telegram_config WHERE id = 1'
            ).first();
  
            if (!telegramConfig?.enable_notifications || !telegramConfig.bot_token || !telegramConfig.chat_id) {
              console.log("VPS的Telegram通知已禁用或未配置，跳过VPS检查");
              return;
            }
  
            const { results: serversToCheck } = await env.DB.prepare(`
              SELECT s.id, s.name, s.last_notified_down_at, m.timestamp as last_report
              FROM servers s LEFT JOIN metrics m ON s.id = m.server_id
            `).all();
  
            if (!serversToCheck?.length) {
              console.log("未找到用于VPS状态检查的服务器");
              return;
            }
  
            console.log(`发现 ${serversToCheck.length} 台服务器需要VPS状态检查`);
            const nowSeconds = Math.floor(Date.now() / 1000);
            const staleThresholdSeconds = 5 * 60; // 5分钟
            const NOTIFICATION_INTERVAL_SECONDS = 1 * 60 * 60; // 1小时
  
            for (const server of serversToCheck) {
              const isStale = !server.last_report || (nowSeconds - server.last_report > staleThresholdSeconds);
              const serverDisplayName = server.name || server.id;
              const lastReportTimeStr = server.last_report
                ? new Date(server.last_report * 1000).toLocaleString('zh-CN')
                : '从未';
  
              if (isStale) {
                // 服务器被认为离线/过期
                const shouldSendNotification = server.last_notified_down_at === null ||
                  (nowSeconds - server.last_notified_down_at > NOTIFICATION_INTERVAL_SECONDS);
  
                if (shouldSendNotification) {
                  const message = `🔴 VPS故障: 服务器 *${serverDisplayName}* 似乎已离线。最后报告: ${lastReportTimeStr}`;
                  ctx.waitUntil(sendTelegramNotification(env.DB, message));
                  ctx.waitUntil(env.DB.prepare('UPDATE servers SET last_notified_down_at = ? WHERE id = ?').bind(nowSeconds, server.id).run());
                  console.log(`VPS ${serverDisplayName} 状态过期，已发送通知`);
                } else {
                  console.log(`VPS ${serverDisplayName} 状态过期，但1小时通知间隔未到`);
                }
              } else {
                // 服务器正在报告（在线）
                if (server.last_notified_down_at !== null) {
                  // 之前被通知为离线，现在已恢复
                  const message = `✅ VPS恢复: 服务器 *${serverDisplayName}* 已恢复在线并正在报告。当前报告: ${lastReportTimeStr}`;
                  ctx.waitUntil(sendTelegramNotification(env.DB, message));
                  ctx.waitUntil(env.DB.prepare('UPDATE servers SET last_notified_down_at = NULL WHERE id = ?').bind(server.id).run());
                  console.log(`VPS ${serverDisplayName} 已恢复，已发送通知`);
                } else {
                  console.log(`VPS ${serverDisplayName} 在线并正在报告，无需通知`);
                }
              }
            }
            console.log("VPS状态检查完成");
  
          } catch (error) {
            console.error("定时任务执行错误:", error);
          }
        })()
      );
    }
  };
  
  
  // ==================== 工具函数 ====================
  
  // HTTP/HTTPS URL验证
  function isValidHttpUrl(string) {
    try {
      const url = new URL(string);
      return ['http:', 'https:'].includes(url.protocol);
    } catch {
      return false;
    }
  }
  
  
  // ==================== 处理函数 ====================
  
  // 安装脚本处理
  async function handleInstallScript(request, url, env) {
    const baseUrl = url.origin;
    let vpsReportInterval = '60'; // 默认值
  
    try {
      // 确保app_config表存在
      if (D1_SCHEMAS?.app_config) {
        await env.DB.exec(D1_SCHEMAS.app_config);
      } else {
        console.warn("D1_SCHEMAS.app_config未定义，跳过创建");
      }
  
      const result = await env.DB.prepare(
        'SELECT value FROM app_config WHERE key = ?'
      ).bind('vps_report_interval_seconds').first();
  
      if (result?.value) {
        const parsedInterval = parseInt(result.value, 10);
        if (!isNaN(parsedInterval) && parsedInterval > 0) {
          vpsReportInterval = parsedInterval.toString();
        }
      }
    } catch (e) {
      console.error("获取VPS上报间隔失败:", e);
      // 使用默认值
    }
    
    const script = `#!/bin/bash
  # VPS监控脚本 - 安装程序
  
  # 默认值
  API_KEY=""
  SERVER_ID=""
  WORKER_URL="${baseUrl}"
  INSTALL_DIR="/opt/vps-monitor"
  SERVICE_NAME="vps-monitor"
  
  # 解析参数
  while [[ $# -gt 0 ]]; do
    case $1 in
      -k|--key)
        API_KEY="$2"
        shift 2
        ;;
      -s|--server)
        SERVER_ID="$2"
        shift 2
        ;;
      -u|--url)
        WORKER_URL="$2"
        shift 2
        ;;
      -d|--dir)
        INSTALL_DIR="$2"
        shift 2
        ;;
      *)
        echo "未知参数: $1"
        exit 1
        ;;
    esac
  done
  
  # 检查必要参数
  if [ -z "$API_KEY" ] || [ -z "$SERVER_ID" ]; then
    echo "错误: API密钥和服务器ID是必需的"
    echo "用法: $0 -k API_KEY -s SERVER_ID [-u WORKER_URL] [-d INSTALL_DIR]"
    exit 1
  fi
  
  # 检查权限
  if [ "$(id -u)" -ne 0 ]; then
    echo "错误: 此脚本需要root权限"
    exit 1
  fi
  
  echo "=== VPS监控脚本安装程序 ==="
  echo "安装目录: $INSTALL_DIR"
  echo "Worker URL: $WORKER_URL"
  
  # 创建安装目录
  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR" || exit 1
  
  # 创建监控脚本
  cat > "$INSTALL_DIR/monitor.sh" << 'EOF'
  #!/bin/bash
  
  # 配置
  API_KEY="__API_KEY__"
  SERVER_ID="__SERVER_ID__"
  WORKER_URL="__WORKER_URL__"
  INTERVAL=${vpsReportInterval}  # 上报间隔（秒）
  
  # 日志函数
  log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1"
  }
  
  # 获取CPU使用率
  get_cpu_usage() {
    cpu_usage=$(top -bn1 | grep "Cpu(s)" | sed "s/.*, *\\([0-9.]*\\)%* id.*/\\1/" | awk '{print 100 - $1}')
    cpu_load=$(cat /proc/loadavg | awk '{print $1","$2","$3}')
    echo "{\"usage_percent\":$cpu_usage,\"load_avg\":[$cpu_load]}"
  }
  
  # 获取内存使用情况
  get_memory_usage() {
    total=$(free -k | grep Mem | awk '{print $2}')
    used=$(free -k | grep Mem | awk '{print $3}')
    free=$(free -k | grep Mem | awk '{print $4}')
    usage_percent=$(echo "scale=1; $used * 100 / $total" | bc)
    echo "{\"total\":$total,\"used\":$used,\"free\":$free,\"usage_percent\":$usage_percent}"
  }
  
  # 获取硬盘使用情况
  get_disk_usage() {
    disk_info=$(df -k / | tail -1)
    total=$(echo "$disk_info" | awk '{print $2 / 1024 / 1024}')
    used=$(echo "$disk_info" | awk '{print $3 / 1024 / 1024}')
    free=$(echo "$disk_info" | awk '{print $4 / 1024 / 1024}')
    usage_percent=$(echo "$disk_info" | awk '{print $5}' | tr -d '%')
    echo "{\"total\":$total,\"used\":$used,\"free\":$free,\"usage_percent\":$usage_percent}"
  }
  
  # 获取网络使用情况
  get_network_usage() {
    # 检查是否安装了ifstat
    if ! command -v ifstat &> /dev/null; then
      log "ifstat未安装，无法获取网络速度"
      echo "{\"upload_speed\":0,\"download_speed\":0,\"total_upload\":0,\"total_download\":0}"
      return
    fi
    
    # 获取网络接口
    interface=$(ip route | grep default | awk '{print $5}')
    
    # 获取网络速度（KB/s）
    network_speed=$(ifstat -i "$interface" 1 1 | tail -1)
    download_speed=$(echo "$network_speed" | awk '{print $1 * 1024}')
    upload_speed=$(echo "$network_speed" | awk '{print $2 * 1024}')
    
    # 获取总流量
    rx_bytes=$(cat /proc/net/dev | grep "$interface" | awk '{print $2}')
    tx_bytes=$(cat /proc/net/dev | grep "$interface" | awk '{print $10}')
    
    echo "{\"upload_speed\":$upload_speed,\"download_speed\":$download_speed,\"total_upload\":$tx_bytes,\"total_download\":$rx_bytes}"
  }
  
  # 上报数据
  report_metrics() {
    timestamp=$(date +%s)
    cpu=$(get_cpu_usage)
    memory=$(get_memory_usage)
    disk=$(get_disk_usage)
    network=$(get_network_usage)
    
    data="{\"timestamp\":$timestamp,\"cpu\":$cpu,\"memory\":$memory,\"disk\":$disk,\"network\":$network}"
    
    log "正在上报数据..."
    log "API密钥: $API_KEY"
    log "服务器ID: $SERVER_ID"
    log "Worker URL: $WORKER_URL"
    
    response=$(curl -s -X POST "$WORKER_URL/api/report/$SERVER_ID" \
      -H "Content-Type: application/json" \
      -H "X-API-Key: $API_KEY" \
      -d "$data")
    
    if [[ "$response" == *"success"* ]]; then
      log "数据上报成功"
    else
      log "数据上报失败: $response"
    fi
  }
  
  # 安装依赖
  install_dependencies() {
    log "检查并安装依赖..."
    
    # 检测包管理器
    if command -v apt-get &> /dev/null; then
      PKG_MANAGER="apt-get"
    elif command -v yum &> /dev/null; then
      PKG_MANAGER="yum"
    else
      log "不支持的系统，无法自动安装依赖"
      return 1
    fi
    
    # 安装依赖
    $PKG_MANAGER update -y
    $PKG_MANAGER install -y bc curl ifstat
    
    log "依赖安装完成"
    return 0
  }
  
  # 主函数
  main() {
    log "VPS监控脚本启动"
    
    # 安装依赖
    install_dependencies
    
    # 主循环
    while true; do
      report_metrics
      sleep $INTERVAL
    done
  }
  
  # 启动主函数
  main
  EOF
  
  # 替换配置
  sed -i "s|__API_KEY__|$API_KEY|g" "$INSTALL_DIR/monitor.sh"
  sed -i "s|__SERVER_ID__|$SERVER_ID|g" "$INSTALL_DIR/monitor.sh"
  sed -i "s|__WORKER_URL__|$WORKER_URL|g" "$INSTALL_DIR/monitor.sh"
  # This line ensures the INTERVAL placeholder is replaced with the fetched value.
  sed -i "s|^INTERVAL=.*|INTERVAL=${vpsReportInterval}|g" "$INSTALL_DIR/monitor.sh"
  
  # 设置执行权限
  chmod +x "$INSTALL_DIR/monitor.sh"
  
  # 创建systemd服务
  cat > "/etc/systemd/system/$SERVICE_NAME.service" << EOF
  [Unit]
  Description=VPS Monitor Service
  After=network.target
  
  [Service]
  ExecStart=$INSTALL_DIR/monitor.sh
  Restart=always
  User=root
  Group=root
  Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  
  [Install]
  WantedBy=multi-user.target
  EOF
  
  # 启动服务
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl start "$SERVICE_NAME"
  
  echo "=== 安装完成 ==="
  echo "服务已启动并设置为开机自启"
  echo "查看服务状态: systemctl status $SERVICE_NAME"
  echo "查看服务日志: journalctl -u $SERVICE_NAME -f"
  `;
  
    return new Response(script, {
      headers: {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="install.sh"'
      }
    });
  }
  
  // 前端请求处理
  function handleFrontendRequest(request, path) {
    const routes = {
      '/': () => new Response(getIndexHtml(), { headers: { 'Content-Type': 'text/html' } }),
      '': () => new Response(getIndexHtml(), { headers: { 'Content-Type': 'text/html' } }),
      '/login': () => new Response(getLoginHtml(), { headers: { 'Content-Type': 'text/html' } }),
      '/login.html': () => new Response(getLoginHtml(), { headers: { 'Content-Type': 'text/html' } }),
      '/admin': () => new Response(getAdminHtml(), { headers: { 'Content-Type': 'text/html' } }),
      '/admin.html': () => new Response(getAdminHtml(), { headers: { 'Content-Type': 'text/html' } }),
      '/css/style.css': () => new Response(getStyleCss(), { headers: { 'Content-Type': 'text/css' } }),
      '/js/main.js': () => new Response(getMainJs(), { headers: { 'Content-Type': 'application/javascript' } }),
      '/js/login.js': () => new Response(getLoginJs(), { headers: { 'Content-Type': 'application/javascript' } }),
      '/js/admin.js': () => new Response(getAdminJs(), { headers: { 'Content-Type': 'application/javascript' } })
    };
  
    const handler = routes[path];
    if (handler) {
      return handler();
    }
  
    // 404页面
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
  
  // ==================== 前端代码 ====================
  
  // 主页HTML
  function getIndexHtml() {
    return `<!DOCTYPE html>
  <html lang="zh-CN" data-bs-theme="light">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Azure实时监测</title>
      <script>
          // 立即设置主题，避免闪烁
          (function() {
              const theme = localStorage.getItem('vps-monitor-theme') || 'light';
              document.documentElement.setAttribute('data-bs-theme', theme);
          })();
      </script>
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
      <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.8.1/font/bootstrap-icons.css" rel="stylesheet">
      <link href="/css/style.css" rel="stylesheet">
      <style>
          .server-row {
              cursor: pointer; /* Indicate clickable rows */
          }
          .server-details-row {
              /* display: none; /* Initially hidden - controlled by JS */ */
          }
          .server-details-row td {
              padding: 1rem;
              background-color: #f8f9fa; /* Light background for details */
          }
          .server-details-content {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
              gap: 1rem;
          }
          .detail-item {
              background-color: #e9ecef;
              padding: 0.75rem;
              border-radius: 0.25rem;
          }
          .detail-item strong {
              display: block;
              margin-bottom: 0.25rem;
          }
          .history-bar-container {
              display: inline-flex; /* Changed to inline-flex for centering within td */
              flex-direction: row-reverse; /* Newest on the right */
              align-items: center;
              justify-content: center; /* Center the bars within this container */
              height: 25px; /* Increased height */
              gap: 2px; /* Space between bars */
          }
          .history-bar {
              width: 8px; /* Increased width of each bar */
              height: 100%;
              /* margin-left: 1px; /* Replaced by gap */
              border-radius: 1px;
          }
          .history-bar-up { background-color: #28a745; } /* Green */
          .history-bar-down { background-color: #dc3545; } /* Red */
          .history-bar-pending { background-color: #6c757d; } /* Gray */
  
          /* Default styling for progress bar text (light mode) */
          .progress span {
              color: #000000; /* Black text for progress bars by default */
              /* font-weight: bold; is handled by inline style in JS */
          }
  
          /* Center the "24h记录" (site table) and "上传" (server table) headers and their data cells */
          .table > thead > tr > th:nth-child(6), /* Targets 6th header in both tables */
          #siteStatusTableBody tr > td:nth-child(6), /* Targets 6th data cell in site status table */
          #serverTableBody tr > td:nth-child(6) { /* Targets 6th data cell in server status table */
              text-align: center;
          }
  
          /* Dark Theme Adjustments */
          [data-bs-theme="dark"] body {
              background-color: #212529 !important; /* Bootstrap dark bg */
              color: #ffffff !important; /* White text for dark mode */
          }
          [data-bs-theme="dark"] h1, [data-bs-theme="dark"] h2, [data-bs-theme="dark"] h3, [data-bs-theme="dark"] h4, [data-bs-theme="dark"] h5, [data-bs-theme="dark"] h6 {
              color: #ffffff; /* White color for headings */
          }
          [data-bs-theme="dark"] a:not(.btn):not(.nav-link):not(.dropdown-item):not(.navbar-brand) {
              color: #87cefa; /* LightSkyBlue for general links, good contrast on dark */
          }
          [data-bs-theme="dark"] a:not(.btn):not(.nav-link):not(.dropdown-item):not(.navbar-brand):hover {
              color: #add8e6; /* Lighter blue on hover */
          }
          [data-bs-theme="dark"] .navbar-dark {
              background-color: #343a40 !important; /* Darker navbar */
          }
          [data-bs-theme="dark"] .table {
              color: #ffffff; /* White table text */
          }
          [data-bs-theme="dark"] .table-striped > tbody > tr:nth-of-type(odd) > * {
              --bs-table-accent-bg: rgba(255, 255, 255, 0.05); /* Darker stripe */
              color: #ffffff; /* Ensure text in striped rows is white */
          }
          [data-bs-theme="dark"] .table-hover > tbody > tr:hover > * {
              --bs-table-accent-bg: rgba(255, 255, 255, 0.075); /* Darker hover */
              color: #ffffff; /* Ensure text in hovered rows is white */
          }
          [data-bs-theme="dark"] .server-details-row td {
              background-color: #343a40; /* Darker details background */
              border-top: 1px solid #495057;
          }
          [data-bs-theme="dark"] .detail-item {
              background-color: #495057; /* Darker detail item background */
              color: #ffffff; /* White text for detail items */
          }
          [data-bs-theme="dark"] .progress {
              background-color: #495057; /* Darker progress bar background */
          }
          [data-bs-theme="dark"] .progress span { /* Text on progress bar */
              color: #000000 !important; /* Black text for progress bars */
              text-shadow: none; /* Remove shadow for black text or use a very light one if needed */
          }
          [data-bs-theme="dark"] .footer.bg-light {
              background-color: #343a40 !important; /* Darker footer */
              border-top: 1px solid #495057;
          }
          [data-bs-theme="dark"] .footer .text-muted {
              color: #adb5bd !important; /* Lighter muted text */
          }
          [data-bs-theme="dark"] .alert-info {
              background-color: #17a2b8; /* Bootstrap info color, adjust if needed */
              color: #fff;
              border-color: #17a2b8;
          }
          [data-bs-theme="dark"] .btn-outline-light {
              color: #f8f9fa;
              border-color: #f8f9fa;
          }
          [data-bs-theme="dark"] .btn-outline-light:hover {
              color: #212529;
              background-color: #f8f9fa;
          }
          [data-bs-theme="dark"] .card {
              background-color: #343a40;
              border: 1px solid #495057;
          }
          [data-bs-theme="dark"] .card-header {
              background-color: #495057;
              border-bottom: 1px solid #5b6167;
          }
          [data-bs-theme="dark"] .modal-content {
              background-color: #343a40;
              color: #ffffff; /* White modal text */
          }
          [data-bs-theme="dark"] .modal-header {
              border-bottom-color: #495057;
          }
          [data-bs-theme="dark"] .modal-footer {
              border-top-color: #495057;
          }
          [data-bs-theme="dark"] .form-control {
              background-color: #495057;
              color: #ffffff; /* White form control text */
              border-color: #5b6167;
          }
          [data-bs-theme="dark"] .form-control:focus {
              background-color: #495057;
              color: #ffffff; /* White form control text on focus */
              border-color: #86b7fe; /* Bootstrap focus color */
              box-shadow: 0 0 0 0.25rem rgba(13, 110, 253, 0.25);
          }
          [data-bs-theme="dark"] .form-label {
              color: #adb5bd;
          }
          [data-bs-theme="dark"] .text-danger { /* Ensure custom text-danger is visible */
              color: #ff8888 !important;
          }
          [data-bs-theme="dark"] .text-muted {
               color: #adb5bd !important;
          }
          [data-bs-theme="dark"] span[style*="color: #000"] { /* For inline styled black text */
              color: #ffffff !important; /* Change to white */
          }
  
          /* 拖拽排序样式 */
          .server-row-draggable, .site-row-draggable {
              transition: all 0.2s ease;
          }
          .server-row-draggable:hover, .site-row-draggable:hover {
              background-color: rgba(0, 123, 255, 0.1) !important;
          }
          .server-row-draggable.drag-over-top, .site-row-draggable.drag-over-top {
              border-top: 3px solid #007bff !important;
              background-color: rgba(0, 123, 255, 0.1) !important;
          }
          .server-row-draggable.drag-over-bottom, .site-row-draggable.drag-over-bottom {
              border-bottom: 3px solid #007bff !important;
              background-color: rgba(0, 123, 255, 0.1) !important;
          }
          .server-row-draggable[draggable="true"], .site-row-draggable[draggable="true"] {
              cursor: grab;
          }
          .server-row-draggable[draggable="true"]:active, .site-row-draggable[draggable="true"]:active {
              cursor: grabbing;
          }
  
          /* 暗色主题下的拖拽样式 */
          [data-bs-theme="dark"] .server-row-draggable:hover,
          [data-bs-theme="dark"] .site-row-draggable:hover {
              background-color: rgba(13, 110, 253, 0.2) !important;
          }
          [data-bs-theme="dark"] .server-row-draggable.drag-over-top,
          [data-bs-theme="dark"] .site-row-draggable.drag-over-top {
              border-top: 3px solid #0d6efd !important;
              background-color: rgba(13, 110, 253, 0.2) !important;
          }
          [data-bs-theme="dark"] .server-row-draggable.drag-over-bottom,
          [data-bs-theme="dark"] .site-row-draggable.drag-over-bottom {
              border-bottom: 3px solid #0d6efd !important;
              background-color: rgba(13, 110, 253, 0.2) !important;
          }
      </style>
      <script src="//widget.time.is/zh.js"></script>
  </head>
  <body>
      <nav class="navbar navbar-dark bg-primary">
          <div class="container">
              <div class="d-flex flex-column flex-md-row align-items-center">
                  <a class="navbar-brand" href="/">Azure实时监测</a>
                  <div class="ms-md-3 mt-2 mt-md-0">
                      <a href="https://time.is/Beijing" id="time_is_link" rel="nofollow" style="font-size:18px; color: white; text-decoration: none;">北京时间:</a>
                      <span id="Beijing_z43d" style="font-size:18px; color: white;"></span>
                  </div>
              </div>
              <div class="d-flex align-items-center">
                  <a href="https://github.com/kadidalax/cf-vps-monitor" target="_blank" rel="noopener noreferrer" class="btn btn-outline-light btn-sm me-2" title="GitHub Repository">
                      <i class="bi bi-github"></i>
                  </a>
                  <button id="themeToggler" class="btn btn-outline-light btn-sm me-2" title="切换主题">
                      <i class="bi bi-moon-stars-fill"></i>
                  </button>
                  <a class="nav-link text-light" id="adminAuthLink" href="/login.html" style="white-space: nowrap;">管理员登录</a>
              </div>
          </div>
      </nav>
  
      <div class="container mt-4">
          <div id="noServers" class="alert alert-info d-none">
              暂无服务器数据，请先登录管理后台添加服务器。
          </div>
  
          <!-- 桌面端表格视图 -->
          <div class="table-responsive">
              <table class="table table-striped table-hover align-middle">
                  <thead>
                      <tr>
                          <th>名称</th>
                          <th>状态</th>
                          <th>CPU</th>
                          <th>内存</th>
                          <th>硬盘</th>
                          <th>上传速度</th>
                          <th>下载速度</th>
                          <th style="display: none;">总上传</th>
                          <th style="display: none;">总下载</th>
                          <th id="monthlyUploadHeader">本月上传</th>
                          <th id="monthlyDownloadHeader">本月下载</th>
                          <th>运行时长</th>
                          <th>最后更新</th>
                      </tr>
                  </thead>
                  <tbody id="serverTableBody">
                      <!-- 内容将通过JavaScript动态加载 -->
                  </tbody>
              </table>
          </div>
  
          <!-- 移动端卡片视图 -->
          <div class="mobile-card-container" id="mobileServerContainer">
              <!-- 内容将通过JavaScript动态加载 -->
          </div>
      </div>
  
      <!-- Website Status Section -->
      <div class="container mt-5">
          <h2>网站在线状态</h2>
          <div id="noSites" class="alert alert-info d-none">
              暂无监控网站数据。
          </div>
          <!-- 桌面端表格视图 -->
          <div class="table-responsive">
              <table class="table table-striped table-hover align-middle">
                  <thead>
                      <tr>
                          <th>名称</th>
                          <th>状态</th>
                          <th>状态码</th>
                          <th>响应时间 (ms)</th>
                          <th>最后检查</th>
                          <th>24h记录</th>
                      </tr>
                  </thead>
                  <tbody id="siteStatusTableBody">
                      <!-- 内容将通过JavaScript动态加载 -->
                  </tbody>
              </table>
          </div>
  
          <!-- 移动端卡片视图 -->
          <div class="mobile-card-container" id="mobileSiteContainer">
              <!-- 内容将通过JavaScript动态加载 -->
          </div>
      </div>
      <!-- End Website Status Section -->
  
      <!-- Server Detailed row template (hidden by default) -->
      <template id="serverDetailsTemplate">
          <tr class="server-details-row d-none">
              <td colspan="13">
                  <div class="server-details-content">
                      <!-- Detailed metrics will be populated here by JavaScript -->
                  </div>
              </td>
          </tr>
      </template>
  
      <footer class="footer mt-5 py-3 bg-light">
          <div class="container text-center">
              <span class="text-muted">Donsonの探针 &copy; 2025</span>
              <a href="https://github.com/kadidalax/cf-vps-monitor" target="_blank" rel="noopener noreferrer" class="ms-3 text-muted" title="GitHub Repository">
                  <i class="bi bi-github fs-5"></i>
              </a>
          </div>
      </footer>
  
      <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
      <script src="/js/main.js"></script>
      <script>
      time_is_widget.init({Beijing_z43d:{template:"TIME<br>DATE", date_format:"year-monthnum-daynum dname"}});
      </script>
  </body>
  </html>`;
  }
  
  function getLoginHtml() {
    return `<!DOCTYPE html>
  <html lang="zh-CN" data-bs-theme="light">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>登录 - Donsonの探针</title>
      <script>
          // 立即设置主题，避免闪烁
          (function() {
              const theme = localStorage.getItem('vps-monitor-theme') || 'light';
              document.documentElement.setAttribute('data-bs-theme', theme);
          })();
      </script>
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
      <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.8.1/font/bootstrap-icons.css" rel="stylesheet">
      <link href="/css/style.css" rel="stylesheet">
      <style>
          .server-row {
              cursor: pointer; /* Indicate clickable rows */
          }
          .server-details-row {
              /* display: none; /* Initially hidden - controlled by JS */ */
          }
          .server-details-row td {
              padding: 1rem;
              background-color: #f8f9fa; /* Light background for details */
          }
          .server-details-content {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
              gap: 1rem;
          }
          .detail-item {
              background-color: #e9ecef;
              padding: 0.75rem;
              border-radius: 0.25rem;
          }
          .detail-item strong {
              display: block;
              margin-bottom: 0.25rem;
          }
          .history-bar-container {
              display: inline-flex; /* Changed to inline-flex for centering within td */
              flex-direction: row-reverse; /* Newest on the right */
              align-items: center;
              justify-content: center; /* Center the bars within this container */
              height: 25px; /* Increased height */
              gap: 2px; /* Space between bars */
          }
          .history-bar {
              width: 8px; /* Increased width of each bar */
              height: 100%;
              /* margin-left: 1px; /* Replaced by gap */
              border-radius: 1px;
          }
          .history-bar-up { background-color: #28a745; } /* Green */
          .history-bar-down { background-color: #dc3545; } /* Red */
          .history-bar-pending { background-color: #6c757d; } /* Gray */
  
          /* Default styling for progress bar text (light mode) */
          .progress span {
              color: #000000; /* Black text for progress bars by default */
              /* font-weight: bold; is handled by inline style in JS */
          }
  
          /* Center the "24h记录" (site table) and "上传" (server table) headers and their data cells */
          .table > thead > tr > th:nth-child(6), /* Targets 6th header in both tables */
          #siteStatusTableBody tr > td:nth-child(6), /* Targets 6th data cell in site status table */
          #serverTableBody tr > td:nth-child(6) { /* Targets 6th data cell in server status table */
              text-align: center;
          }
  
          /* Dark Theme Adjustments */
          [data-bs-theme="dark"] body {
              background-color: #212529; /* Bootstrap dark bg */
              color: #ffffff; /* White text for dark mode */
          }
          [data-bs-theme="dark"] h1, [data-bs-theme="dark"] h2, [data-bs-theme="dark"] h3, [data-bs-theme="dark"] h4, [data-bs-theme="dark"] h5, [data-bs-theme="dark"] h6 {
              color: #ffffff; /* White color for headings */
          }
          [data-bs-theme="dark"] a:not(.btn):not(.nav-link):not(.dropdown-item):not(.navbar-brand) {
              color: #87cefa; /* LightSkyBlue for general links, good contrast on dark */
          }
          [data-bs-theme="dark"] a:not(.btn):not(.nav-link):not(.dropdown-item):not(.navbar-brand):hover {
              color: #add8e6; /* Lighter blue on hover */
          }
          [data-bs-theme="dark"] .navbar-dark {
              background-color: #343a40 !important; /* Darker navbar */
          }
          [data-bs-theme="dark"] .table {
              color: #ffffff; /* White table text */
          }
          [data-bs-theme="dark"] .table-striped > tbody > tr:nth-of-type(odd) > * {
              --bs-table-accent-bg: rgba(255, 255, 255, 0.05); /* Darker stripe */
              color: #ffffff; /* Ensure text in striped rows is white */
          }
          [data-bs-theme="dark"] .table-hover > tbody > tr:hover > * {
              --bs-table-accent-bg: rgba(255, 255, 255, 0.075); /* Darker hover */
              color: #ffffff; /* Ensure text in hovered rows is white */
          }
          [data-bs-theme="dark"] .server-details-row td {
              background-color: #343a40; /* Darker details background */
              border-top: 1px solid #495057;
          }
          [data-bs-theme="dark"] .detail-item {
              background-color: #495057; /* Darker detail item background */
              color: #ffffff; /* White text for detail items */
          }
          [data-bs-theme="dark"] .progress {
              background-color: #495057; /* Darker progress bar background */
          }
          [data-bs-theme="dark"] .progress span { /* Text on progress bar */
              color: #000000 !important; /* Black text for progress bars */
              text-shadow: none; /* Remove shadow for black text or use a very light one if needed */
          }
          [data-bs-theme="dark"] .footer.bg-light {
              background-color: #343a40 !important; /* Darker footer */
              border-top: 1px solid #495057;
          }
          [data-bs-theme="dark"] .footer .text-muted {
              color: #adb5bd !important; /* Lighter muted text */
          }
          [data-bs-theme="dark"] .alert-info {
              background-color: #17a2b8; /* Bootstrap info color, adjust if needed */
              color: #fff;
              border-color: #17a2b8;
          }
          [data-bs-theme="dark"] .btn-outline-light {
              color: #f8f9fa;
              border-color: #f8f9fa;
          }
          [data-bs-theme="dark"] .btn-outline-light:hover {
              color: #212529;
              background-color: #f8f9fa;
          }
          [data-bs-theme="dark"] .card {
              background-color: #343a40;
              border: 1px solid #495057;
          }
          [data-bs-theme="dark"] .card-header {
              background-color: #495057;
              border-bottom: 1px solid #5b6167;
          }
          [data-bs-theme="dark"] .modal-content {
              background-color: #343a40;
              color: #ffffff; /* White modal text */
          }
          [data-bs-theme="dark"] .modal-header {
              border-bottom-color: #495057;
          }
          [data-bs-theme="dark"] .modal-footer {
              border-top-color: #495057;
          }
          [data-bs-theme="dark"] .form-control {
              background-color: #495057;
              color: #ffffff; /* White form control text */
              border-color: #5b6167;
          }
          [data-bs-theme="dark"] .form-control:focus {
              background-color: #495057;
              color: #ffffff; /* White form control text on focus */
              border-color: #86b7fe; /* Bootstrap focus color */
              box-shadow: 0 0 0 0.25rem rgba(13, 110, 253, 0.25);
          }
          [data-bs-theme="dark"] .form-label {
              color: #adb5bd;
          }
          [data-bs-theme="dark"] .text-danger { /* Ensure custom text-danger is visible */
              color: #ff8888 !important;
          }
          [data-bs-theme="dark"] .text-muted {
               color: #adb5bd !important;
          }
          [data-bs-theme="dark"] span[style*="color: #000"] { /* For inline styled black text */
              color: #ffffff !important; /* Change to white */
          }
      </style>
      <script src="//widget.time.is/zh.js"></script>
  </head>
  <body>
      <nav class="navbar navbar-dark bg-primary">
          <div class="container">
              <div class="d-flex flex-column flex-md-row align-items-center">
                  <a class="navbar-brand" href="/">Azure实时监测</a>
                  <div class="ms-md-3 mt-2 mt-md-0">
                      <a href="https://time.is/Beijing" id="time_is_link" rel="nofollow" style="font-size:18px; color: white; text-decoration: none;">北京时间:</a>
                      <span id="Beijing_z43d" style="font-size:18px; color: white;"></span>
                  </div>
              </div>
              <div class="d-flex align-items-center">
                  <button id="themeToggler" class="btn btn-outline-light btn-sm me-2" title="切换主题">
                      <i class="bi bi-moon-stars-fill"></i>
                  </button>
                  <a class="nav-link text-light" href="/" style="white-space: nowrap;">返回首页</a>
              </div>
          </div>
      </nav>
  
      <div class="container mt-5">
          <div class="row justify-content-center">
              <div class="col-md-6 col-lg-4">
                  <div class="card">
                      <div class="card-header">
                          <h4 class="card-title mb-0">管理员登录</h4>
                      </div>
                      <div class="card-body">
                          <div id="loginAlert" class="alert alert-danger d-none"></div>
                          <form id="loginForm">
                              <div class="mb-3">
                                  <label for="username" class="form-label">用户名</label>
                                  <input type="text" class="form-control" id="username" required>
                              </div>
                              <div class="mb-3">
                                  <label for="password" class="form-label">密码</label>
                                  <input type="password" class="form-control" id="password" required>
                              </div>
                              <div class="d-grid">
                                  <button type="submit" class="btn btn-primary">登录</button>
                              </div>
                          </form>
                      </div>
                      <div class="card-footer text-muted">
                          <small id="defaultCredentialsInfo">加载默认凭据信息中...</small>
                      </div>
                  </div>
              </div>
          </div>
      </div>
  
      <footer class="footer mt-5 py-3 bg-light">
          <div class="container text-center">
              <span class="text-muted">Donsonの探针 &copy; 2025</span>
              <a href="https://github.com/kadidalax/cf-vps-monitor" target="_blank" rel="noopener noreferrer" class="ms-3 text-muted" title="GitHub Repository">
                  <i class="bi bi-github fs-5"></i>
              </a>
          </div>
      </footer>
  
      <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
      <script src="/js/login.js"></script>
      <script>
      time_is_widget.init({Beijing_z43d:{template:"TIME<br>DATE", date_format:"year-monthnum-daynum dname"}});
      </script>
  </body>
  </html>`;
  }
  
  function getAdminHtml() {
    return `<!DOCTYPE html>
  <html lang="zh-CN" data-bs-theme="light">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>管理后台 - Azure实时监测</title>
      <script>
          // 立即设置主题，避免闪烁
          (function() {
              const theme = localStorage.getItem('vps-monitor-theme') || 'light';
              document.documentElement.setAttribute('data-bs-theme', theme);
          })();
      </script>
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
      <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.8.1/font/bootstrap-icons.css" rel="stylesheet">
      <link href="/css/style.css" rel="stylesheet">
      <script src="//widget.time.is/zh.js"></script>
  </head>
  <body>
      <nav class="navbar navbar-dark bg-primary">
          <div class="container">
              <div class="d-flex flex-column flex-md-row align-items-center">
                  <a class="navbar-brand" href="/">Azure实时监测</a>
                  <div class="ms-md-3 mt-2 mt-md-0">
                      <a href="https://time.is/Beijing" id="time_is_link" rel="nofollow" style="font-size:18px; color: white; text-decoration: none;">北京时间:</a>
                      <span id="Beijing_z43d" style="font-size:18px; color: white;"></span>
                  </div>
              </div>
              <div class="d-flex align-items-center flex-wrap">
                  <a class="nav-link text-light me-2" href="/" style="white-space: nowrap;">返回首页</a>
  
                  <!-- PC端直接显示的按钮 -->
                  <a href="https://github.com/kadidalax/cf-vps-monitor" target="_blank" rel="noopener noreferrer" class="btn btn-outline-light btn-sm me-2 desktop-only" title="GitHub Repository">
                      <i class="bi bi-github"></i>
                  </a>
  
                  <button id="themeToggler" class="btn btn-outline-light btn-sm me-2" title="切换主题">
                      <i class="bi bi-moon-stars-fill"></i>
                  </button>
  
                  <button class="btn btn-outline-light btn-sm me-1 desktop-only" id="changePasswordBtnDesktop" title="修改密码">
                      <i class="bi bi-key"></i>
                  </button>
  
                  <!-- 移动端下拉菜单 -->
                  <div class="dropdown me-1 mobile-only">
                      <button class="btn btn-outline-light btn-sm dropdown-toggle" type="button" id="adminMenuDropdown" data-bs-toggle="dropdown" aria-expanded="false" title="更多选项">
                          <i class="bi bi-three-dots"></i>
                      </button>
                      <ul class="dropdown-menu dropdown-menu-end" aria-labelledby="adminMenuDropdown">
                          <li><a class="dropdown-item" href="https://github.com/kadidalax/cf-vps-monitor" target="_blank" rel="noopener noreferrer">
                              <i class="bi bi-github me-2"></i>GitHub
                          </a></li>
                          <li><button class="dropdown-item" id="changePasswordBtn">
                              <i class="bi bi-key me-2"></i>修改密码
                          </button></li>
                      </ul>
                  </div>
  
                  <button id="logoutBtn" class="btn btn-outline-light btn-sm" style="font-size: 0.75rem; padding: 0.25rem 0.5rem;">退出</button>
              </div>
          </div>
      </nav>
  
      <div class="container mt-4">
          <div class="admin-header-row mb-4"> <!-- 优化的标题行容器 -->
              <div class="admin-header-title">
                  <h2 class="mb-0">服务器管理</h2>
              </div>
              <div class="admin-header-content">
                  <!-- VPS Data Update Frequency Form -->
                  <form id="globalSettingsFormPartial" class="admin-settings-form">
                      <div class="settings-group">
                          <label for="vpsReportInterval" class="form-label">VPS数据更新频率 (秒):</label>
                          <div class="input-group">
                              <input type="number" class="form-control form-control-sm" id="vpsReportInterval" placeholder="例如: 60" min="1" style="width: 100px;">
                              <button type="button" id="saveVpsReportIntervalBtn" class="btn btn-info btn-sm">保存频率</button>
                          </div>
                      </div>
                  </form>
  
                  <!-- Action Buttons Group -->
                  <div class="admin-actions-group">
                      <!-- Server Auto Sort Dropdown -->
                      <div class="dropdown me-2">
                          <button class="btn btn-outline-secondary dropdown-toggle" type="button" id="serverAutoSortDropdown" data-bs-toggle="dropdown" aria-expanded="false">
                              <i class="bi bi-sort-alpha-down"></i> 自动排序
                          </button>
                          <ul class="dropdown-menu" aria-labelledby="serverAutoSortDropdown">
                              <li><a class="dropdown-item active" href="#" onclick="autoSortServers('custom')">自定义排序</a></li>
                              <li><a class="dropdown-item" href="#" onclick="autoSortServers('name')">按名称排序</a></li>
                              <li><a class="dropdown-item" href="#" onclick="autoSortServers('status')">按状态排序</a></li>
                          </ul>
                      </div>
  
                      <!-- Add Server Button -->
                      <button id="addServerBtn" class="btn btn-primary">
                          <i class="bi bi-plus-circle"></i> 添加服务器
                      </button>
                  </div>
              </div>
          </div>
          <!-- Removed globalSettingsAlert as serverAlert will be used -->
          <div id="serverAlert" class="alert d-none"></div>
          <div class="card">
              <div class="card-body">
                  <!-- 桌面端表格视图 -->
                  <div class="table-responsive">
                      <table class="table table-striped table-hover">
                          <thead>
                              <tr>
                                  <th>排序</th>
                                  <th>ID</th>
                                  <th>名称</th>
                                  <th>描述</th>
                                  <th>状态</th>
                                  <th>最后更新</th>
                                  <th>API密钥</th>
                                  <th>VPS脚本</th>
                                  <th>显示 <i class="bi bi-question-circle text-muted" data-bs-toggle="tooltip" data-bs-placement="top" data-bs-title="是否对游客展示此服务器"></i></th>
                                  <th>操作</th>
                              </tr>
                          </thead>
                          <tbody id="serverTableBody">
                              <!-- 内容将通过JavaScript动态加载 -->
                          </tbody>
                      </table>
                  </div>
  
                  <!-- 移动端卡片视图 -->
                  <div class="mobile-card-container" id="mobileAdminServerContainer">
                      <!-- 内容将通过JavaScript动态加载 -->
                  </div>
              </div>
          </div>
      </div>
  
      <!-- Website Monitoring Section -->
      <div class="container mt-5">
          <div class="admin-header-row mb-4"> <!-- 优化的标题行容器 -->
              <div class="admin-header-title">
                  <h2 class="mb-0">网站监控管理</h2>
              </div>
              <div class="admin-header-content">
                  <!-- Action Buttons Group -->
                  <div class="admin-actions-group">
                      <!-- Site Auto Sort Dropdown -->
                      <div class="dropdown me-2">
                          <button class="btn btn-outline-secondary dropdown-toggle" type="button" id="siteAutoSortDropdown" data-bs-toggle="dropdown" aria-expanded="false">
                              <i class="bi bi-sort-alpha-down"></i> 自动排序
                          </button>
                          <ul class="dropdown-menu" aria-labelledby="siteAutoSortDropdown">
                              <li><a class="dropdown-item active" href="#" onclick="autoSortSites('custom')">自定义排序</a></li>
                              <li><a class="dropdown-item" href="#" onclick="autoSortSites('name')">按名称排序</a></li>
                              <li><a class="dropdown-item" href="#" onclick="autoSortSites('url')">按URL排序</a></li>
                              <li><a class="dropdown-item" href="#" onclick="autoSortSites('status')">按状态排序</a></li>
                          </ul>
                      </div>
  
                      <button id="addSiteBtn" class="btn btn-success">
                          <i class="bi bi-plus-circle"></i> 添加监控网站
                      </button>
                  </div>
              </div>
          </div>
  
          <div id="siteAlert" class="alert d-none"></div>
  
          <div class="card">
              <div class="card-body">
                  <!-- 桌面端表格视图 -->
                  <div class="table-responsive">
                      <table class="table table-striped table-hover">
                          <thead>
                              <tr>
                                  <th>排序</th>
                                  <th>名称</th>
                                  <th>URL</th>
                                  <th>状态</th>
                                  <th>状态码</th>
                                  <th>响应时间 (ms)</th>
                                  <th>最后检查</th>
                                  <th>显示 <i class="bi bi-question-circle text-muted" data-bs-toggle="tooltip" data-bs-placement="top" data-bs-title="是否对游客展示此网站"></i></th>
                                  <th>操作</th>
                              </tr>
                          </thead>
                          <tbody id="siteTableBody">
                              <!-- 内容将通过JavaScript动态加载 -->
                          </tbody>
                      </table>
                  </div>
  
                  <!-- 移动端卡片视图 -->
                  <div class="mobile-card-container" id="mobileAdminSiteContainer">
                      <!-- 内容将通过JavaScript动态加载 -->
                  </div>
              </div>
          </div>
      </div>
      <!-- End Website Monitoring Section -->
  
      <!-- Telegram Notification Settings Section -->
      <div class="container mt-5">
          <div class="d-flex justify-content-between align-items-center mb-4">
              <h2>Telegram 通知设置</h2>
          </div>
          <div id="telegramSettingsAlert" class="alert d-none"></div>
          <div class="card">
              <div class="card-body">
                  <form id="telegramSettingsForm">
                      <div class="mb-3">
                          <label for="telegramBotToken" class="form-label">Bot Token</label>
                          <input type="text" class="form-control" id="telegramBotToken" placeholder="请输入 Telegram Bot Token">
                      </div>
                      <div class="mb-3">
                          <label for="telegramChatId" class="form-label">Chat ID</label>
                          <input type="text" class="form-control" id="telegramChatId" placeholder="请输入接收通知的 Chat ID">
                      </div>
                      <div class="form-check mb-3">
                          <input class="form-check-input" type="checkbox" id="enableTelegramNotifications">
                          <label class="form-check-label" for="enableTelegramNotifications">
                              启用通知
                          </label>
                      </div>
                      <button type="button" id="saveTelegramSettingsBtn" class="btn btn-info">保存Telegram设置</button>
                  </form>
              </div>
          </div>
      </div>
      <!-- End Telegram Notification Settings Section -->
  
      <!-- Global Settings Section (Now integrated above Server Management List) -->
      <!-- The form is now part of the header for Server Management -->
      <!-- End Global Settings Section -->
  
  
      <!-- 服务器模态框 -->
      <div class="modal fade" id="serverModal" tabindex="-1">
          <div class="modal-dialog">
              <div class="modal-content">
                  <div class="modal-header">
                      <h5 class="modal-title" id="serverModalTitle">添加服务器</h5>
                      <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                  </div>
                  <div class="modal-body">
                      <form id="serverForm">
                          <input type="hidden" id="serverId">
                          <div class="mb-3">
                              <label for="serverName" class="form-label">服务器名称</label>
                              <input type="text" class="form-control" id="serverName" required>
                          </div>
                          <div class="mb-3">
                              <label for="serverDescription" class="form-label">描述（可选）</label>
                              <textarea class="form-control" id="serverDescription" rows="2"></textarea>
                          </div>
                          <!-- Removed serverEnableFrequentNotifications checkbox -->
  
                          <div id="serverIdDisplayGroup" class="mb-3 d-none">
                              <label for="serverIdDisplay" class="form-label">服务器ID</label>
                              <div class="input-group">
                                  <input type="text" class="form-control" id="serverIdDisplay" readonly>
                                  <button class="btn btn-outline-secondary" type="button" id="copyServerIdBtn">
                                      <i class="bi bi-clipboard"></i>
                                  </button>
                              </div>
                          </div>
  
                          <div id="apiKeyGroup" class="mb-3 d-none">
                              <label for="apiKey" class="form-label">API密钥</label>
                              <div class="input-group">
                                  <input type="text" class="form-control" id="apiKey" readonly>
                                  <button class="btn btn-outline-secondary" type="button" id="copyApiKeyBtn">
                                      <i class="bi bi-clipboard"></i>
                                  </button>
                              </div>
                          </div>
  
                          <div id="workerUrlDisplayGroup" class="mb-3 d-none">
                              <label for="workerUrlDisplay" class="form-label">Worker 地址</label>
                              <div class="input-group">
                                  <input type="text" class="form-control" id="workerUrlDisplay" readonly>
                                  <button class="btn btn-outline-secondary" type="button" id="copyWorkerUrlBtn">
                                      <i class="bi bi-clipboard"></i>
                                  </button>
                              </div>
                          </div>
                      </form>
                  </div>
                  <div class="modal-footer">
                      <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">关闭</button>
                      <button type="button" class="btn btn-primary" id="saveServerBtn">保存</button>
                  </div>
              </div>
          </div>
      </div>
  
      <!-- 网站监控模态框 -->
      <div class="modal fade" id="siteModal" tabindex="-1">
          <div class="modal-dialog">
              <div class="modal-content">
                  <div class="modal-header">
                      <h5 class="modal-title" id="siteModalTitle">添加监控网站</h5>
                      <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                  </div>
                  <div class="modal-body">
                      <form id="siteForm">
                          <input type="hidden" id="siteId">
                          <div class="mb-3">
                              <label for="siteName" class="form-label">网站名称（可选）</label>
                              <input type="text" class="form-control" id="siteName">
                          </div>
                          <div class="mb-3">
                              <label for="siteUrl" class="form-label">网站URL</label>
                              <input type="url" class="form-control" id="siteUrl" placeholder="https://example.com" required>
                          </div>
                          <!-- Removed siteEnableFrequentNotifications checkbox -->
                      </form>
                  </div>
                  <div class="modal-footer">
                      <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">关闭</button>
                      <button type="button" class="btn btn-primary" id="saveSiteBtn">保存</button>
                  </div>
              </div>
          </div>
      </div>
  
      <!-- 服务器删除确认模态框 -->
      <div class="modal fade" id="deleteModal" tabindex="-1">
          <div class="modal-dialog">
              <div class="modal-content">
                  <div class="modal-header">
                      <h5 class="modal-title">确认删除</h5>
                      <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                  </div>
                  <div class="modal-body">
                      <p>确定要删除服务器 "<span id="deleteServerName"></span>" 吗？</p>
                      <p class="text-danger">此操作不可逆，所有相关的监控数据也将被删除。</p>
                  </div>
                  <div class="modal-footer">
                      <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
                      <button type="button" class="btn btn-danger" id="confirmDeleteBtn">删除</button>
                  </div>
              </div>
          </div>
      </div>
  
       <!-- 网站删除确认模态框 -->
      <div class="modal fade" id="deleteSiteModal" tabindex="-1">
          <div class="modal-dialog">
              <div class="modal-content">
                  <div class="modal-header">
                      <h5 class="modal-title">确认删除网站监控</h5>
                      <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                  </div>
                  <div class="modal-body">
                      <p>确定要停止监控网站 "<span id="deleteSiteName"></span>" (<span id="deleteSiteUrl"></span>) 吗？</p>
                      <p class="text-danger">此操作不可逆。</p>
                  </div>
                  <div class="modal-footer">
                      <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
                      <button type="button" class="btn btn-danger" id="confirmDeleteSiteBtn">删除</button>
                  </div>
              </div>
          </div>
      </div>
  
      <!-- 修改密码模态框 -->
      <div class="modal fade" id="passwordModal" tabindex="-1">
          <div class="modal-dialog">
              <div class="modal-content">
                  <div class="modal-header">
                      <h5 class="modal-title">修改密码</h5>
                      <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                  </div>
                  <div class="modal-body">
                      <div id="passwordAlert" class="alert d-none"></div>
                      <form id="passwordForm">
                          <div class="mb-3">
                              <label for="currentPassword" class="form-label">当前密码</label>
                              <input type="password" class="form-control" id="currentPassword" required>
                          </div>
                          <div class="mb-3">
                              <label for="newPassword" class="form-label">新密码</label>
                              <input type="password" class="form-control" id="newPassword" required>
                          </div>
                          <div class="mb-3">
                              <label for="confirmPassword" class="form-label">确认新密码</label>
                              <input type="password" class="form-control" id="confirmPassword" required>
                          </div>
                      </form>
                  </div>
                  <div class="modal-footer">
                      <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
                      <button type="button" class="btn btn-primary" id="savePasswordBtn">保存</button>
                  </div>
              </div>
          </div>
      </div>
  
      <footer class="footer mt-5 py-3 bg-light">
          <div class="container text-center">
              <span class="text-muted">Donsonの探针 &copy; 2025</span>
              <a href="https://github.com/kadidalax/cf-vps-monitor" target="_blank" rel="noopener noreferrer" class="ms-3 text-muted" title="GitHub Repository">
                  <i class="bi bi-github fs-5"></i>
              </a>
          </div>
      </footer>
  
      <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
      <script src="/js/admin.js"></script>
      <script>
      time_is_widget.init({Beijing_z43d:{template:"TIME<br>DATE", date_format:"year-monthnum-daynum dname"}});
      </script>
  </body>
  </html>`;
  }
  
  function getStyleCss() {
    return `/* 全局样式 */
  body {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
  }
  
  .footer {
      margin-top: auto;
  }
  
  /* 图表容器 */
  .chart-container {
      position: relative;
      height: 200px;
      width: 100%;
  }
  
  /* 卡片样式 */
  .card {
      box-shadow: 0 0.125rem 0.25rem rgba(0, 0, 0, 0.075);
      margin-bottom: 1.5rem;
  }
  
  .card-header {
      background-color: rgba(0, 0, 0, 0.03);
      border-bottom: 1px solid rgba(0, 0, 0, 0.125);
  }
  
  /* 进度条样式 */
  .progress {
      height: 0.75rem;
  }
  
  /* 表格样式 */
  .table th {
      font-weight: 600;
  }
  
  /* Modal centering and light theme transparency */
  .modal-dialog {
      display: flex;
      align-items: center;
      min-height: calc(100% - 1rem); /* Adjust as needed */
  }
  
  .modal-content {
      background-color: rgba(255, 255, 255, 0.9); /* Semi-transparent white for light theme */
      /* backdrop-filter: blur(5px); /* Optional: adds a blur effect to content behind modal */
  }
  
  
  /* 响应式调整 */
  @media (max-width: 768px) {
      .chart-container {
          height: 150px;
      }
  
      /* 移动端隐藏表格，显示卡片 */
      .table-responsive {
          display: none !important;
      }
  
      .mobile-card-container {
          display: block !important;
      }
  
      /* 移动端隐藏桌面端按钮 */
      .desktop-only {
          display: none !important;
      }
  
      /* 移动端导航栏优化 */
      .navbar-brand {
          font-size: 1rem;
          margin-right: 0.5rem;
      }
  
      .container {
          padding-left: 10px;
          padding-right: 10px;
      }
  
      /* 移动端导航栏按钮组优化 */
      .navbar .d-flex {
          gap: 0.25rem;
          flex-wrap: wrap;
      }
  
      .navbar .btn-sm {
          padding: 0.25rem 0.5rem;
          font-size: 0.75rem;
          min-width: auto;
          border-width: 1px;
      }
  
      .navbar .nav-link {
          font-size: 0.8rem;
          padding: 0.25rem 0.5rem;
          margin: 0;
      }
  
      /* 移动端导航栏下拉菜单优化 */
      .navbar .dropdown-menu {
          font-size: 0.875rem;
          min-width: 150px;
      }
  
      .navbar .dropdown-item {
          padding: 0.5rem 1rem;
          font-size: 0.875rem;
      }
  
      .navbar .dropdown-item i {
          width: 1.2rem;
      }
  
      /* 移动端管理区域标题行优化 */
      .admin-header-row {
          display: flex;
          flex-direction: column;
          gap: 1rem;
      }
  
      .admin-header-title h2 {
          font-size: 1.5rem;
          margin-bottom: 0;
      }
  
      .admin-header-content {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
      }
  
      .admin-settings-form {
          order: 2; /* 设置表单在移动端显示在按钮组下方 */
      }
  
      .admin-actions-group {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
          order: 1; /* 按钮组在移动端显示在上方 */
      }
  
      .settings-group {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
      }
  
      .settings-group .form-label {
          font-size: 0.875rem;
          margin-bottom: 0;
          font-weight: 500;
      }
  
      .settings-group .input-group {
          max-width: 250px;
      }
  
      /* 超小屏幕优化 (小于400px) */
      @media (max-width: 400px) {
          .navbar-brand {
              font-size: 0.9rem;
          }
  
          .navbar .btn-sm {
              padding: 0.2rem 0.4rem;
              font-size: 0.7rem;
          }
  
          .navbar .nav-link {
              font-size: 0.75rem;
              padding: 0.2rem 0.4rem;
          }
  
          .container {
              padding-left: 8px;
              padding-right: 8px;
          }
      }
  
      /* 移动端按钮优化 */
      .btn-sm {
          padding: 0.375rem 0.75rem;
          font-size: 0.875rem;
      }
  }
  
  /* 桌面端隐藏卡片容器和移动端菜单 */
  @media (min-width: 769px) {
      .mobile-card-container {
          display: none !important;
      }
  
      .mobile-only {
          display: none !important;
      }
  }
  
      /* 桌面端管理区域标题行样式 */
      .admin-header-row {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          flex-wrap: wrap;
          gap: 1rem;
      }
  
      .admin-header-title {
          flex: 0 0 auto;
      }
  
      .admin-header-content {
          display: flex;
          align-items: center;
          gap: 1rem;
          flex: 1 1 auto;
          justify-content: flex-end;
      }
  
      .admin-settings-form {
          order: 1;
          margin-right: auto; /* 推送到左侧 */
      }
  
      .admin-actions-group {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          order: 2;
      }
  
      .settings-group {
          display: flex;
          flex-direction: row;
          align-items: center;
          gap: 0.5rem;
      }
  
      .settings-group .form-label {
          margin-bottom: 0;
          white-space: nowrap;
          font-size: 0.875rem;
      }
  }
  
  /* 移动端卡片样式 */
  .mobile-card-container {
      display: none; /* 默认隐藏，通过媒体查询控制 */
  }
  
  .mobile-server-card, .mobile-site-card {
      background: var(--bs-card-bg, #fff);
      border: 1px solid var(--bs-border-color, rgba(0,0,0,.125));
      border-radius: 0.5rem;
      margin-bottom: 0.75rem;
      box-shadow: 0 0.125rem 0.25rem rgba(0, 0, 0, 0.075);
      overflow: hidden;
      transition: box-shadow 0.15s ease-in-out, transform 0.15s ease-in-out;
  }
  
  @media (max-width: 768px) {
      .mobile-server-card:hover, .mobile-site-card:hover {
          box-shadow: 0 0.25rem 0.5rem rgba(0, 0, 0, 0.1);
          transform: translateY(-1px);
      }
  }
  
  .mobile-card-header {
      padding: 0.75rem;
      background-color: var(--bs-card-cap-bg, rgba(0,0,0,.03));
      border-bottom: 1px solid var(--bs-border-color, rgba(0,0,0,.125));
      display: flex;
      justify-content: space-between;
      align-items: center;
  }
  
  .mobile-card-header-left {
      flex: 0 0 auto;
  }
  
  .mobile-card-header-right {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      font-size: 0.875rem;
  }
  
  .mobile-card-footer {
      margin-top: 0.5rem;
      padding-top: 0.5rem;
      border-top: 1px solid var(--bs-border-color, rgba(0,0,0,.125));
      font-size: 0.875rem;
      color: var(--bs-secondary);
  }
  
  @media (max-width: 768px) {
      .mobile-card-header:hover {
          background-color: var(--bs-card-cap-bg, rgba(0,0,0,.05));
      }
  }
  
  .mobile-card-title {
      font-weight: 600;
      margin: 0;
      font-size: 1rem;
      line-height: 1.3;
  }
  
  .mobile-card-status {
      flex-shrink: 0;
  }
  
  .mobile-card-body {
      padding: 0.75rem;
  }
  
  .mobile-card-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--bs-border-color-translucent, rgba(0,0,0,.08));
  }
  
  .mobile-card-row:last-child {
      border-bottom: none;
      padding-bottom: 0;
  }
  
  /* 两列布局样式 */
  .mobile-card-two-columns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--bs-border-color-translucent, rgba(0,0,0,.08));
  }
  
  .mobile-card-two-columns:last-child {
      border-bottom: none;
      padding-bottom: 0.25rem;
  }
  
  .mobile-card-column-item {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      min-height: 2rem;
      justify-content: center;
  }
  
  .mobile-card-column-item .mobile-card-label {
      font-size: 0.7rem;
      margin-bottom: 0;
      color: var(--bs-secondary-color, #6c757d);
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.02em;
  }
  
  .mobile-card-column-item .mobile-card-value {
      font-size: 0.85rem;
      font-weight: 600;
      text-align: left;
      max-width: 100%;
      word-break: break-word;
      line-height: 1.2;
  }
  
  /* 移动端单行样式优化 */
  @media (max-width: 768px) {
      .mobile-card-row {
          padding: 0.5rem 0;
          min-height: 2rem;
          align-items: center;
      }
  
      .mobile-card-label {
          font-weight: 500;
          font-size: 0.875rem;
      }
  
      .mobile-card-value {
          font-weight: 600;
          font-size: 0.875rem;
          word-break: break-word;
      }
  }
  
  .mobile-card-label {
      font-weight: 500;
      color: var(--bs-secondary-color, #6c757d);
      font-size: 0.875rem;
  }
  
  .mobile-card-value {
      text-align: right;
      flex-shrink: 0;
      max-width: 60%;
  }
  
  
  
  /* 移动端进度条优化 */
  @media (max-width: 768px) {
      .progress {
          height: 1rem;
          margin-top: 0.25rem;
          border-radius: 0.5rem;
      }
  
      .progress span {
          font-size: 0.75rem;
          line-height: 1rem;
      }
  }
  
  /* 移动端状态徽章优化 */
  @media (max-width: 768px) {
      .badge {
          font-size: 0.75rem;
          padding: 0.35em 0.65em;
          border-radius: 0.375rem;
      }
  }
  
  /* 移动端历史记录条优化 */
  @media (max-width: 768px) {
      .history-bar-container {
          height: 1.5rem;
          border-radius: 0.25rem;
          overflow: hidden;
      }
  
      .history-bar {
          min-width: 2px;
          border-radius: 0;
      }
  }
  
  /* 移动端历史记录条优化 */
  .mobile-history-container {
      margin-top: 0.5rem;
  }
  
  .mobile-history-label {
      font-size: 0.75rem;
      color: var(--bs-secondary-color, #6c757d);
      margin-bottom: 0.25rem;
  }
  
  
  
  /* 移动端按钮优化 */
  @media (max-width: 768px) {
      .mobile-card-body .btn-sm {
          padding: 0.5rem 0.75rem;
          font-size: 0.8rem;
          border-radius: 0.375rem;
          transition: all 0.15s ease-in-out;
      }
  
      .mobile-card-body .d-flex.gap-2 {
          gap: 0.5rem !important;
      }
  
      .mobile-card-body .btn i {
          font-size: 0.875rem;
      }
  
      /* 移动端触摸反馈 */
      .mobile-card-header:active {
          background-color: var(--bs-card-cap-bg, rgba(0,0,0,.08)) !important;
          transform: scale(0.98);
      }
  
      .mobile-card-body .btn:active {
          transform: scale(0.95);
      }
  
      /* 移动端容器标题优化 */
      .container h2 {
          font-size: 1.5rem;
          margin-bottom: 1rem;
      }
  
      /* 移动端卡片标题层次优化 */
      .mobile-card-title {
          font-size: 1rem;
          line-height: 1.3;
          font-weight: 600;
      }
  
      /* 移动端管理页面按钮优化 */
      .admin-actions-group .btn {
          font-size: 0.875rem;
          padding: 0.5rem 0.75rem;
          border-radius: 0.375rem;
          transition: all 0.2s ease-in-out;
      }
  
      .admin-actions-group .btn:active {
          transform: scale(0.95);
      }
  
      .admin-actions-group .dropdown-toggle {
          min-width: auto;
      }
  
      /* 移动端卡片间距优化 */
      .mobile-server-card, .mobile-site-card {
          margin-bottom: 1rem;
      }
  
      .mobile-card-body {
          padding: 0.75rem;
      }
  
      .mobile-card-row {
          padding: 0.375rem 0;
          border-bottom: 1px solid var(--bs-border-color-translucent, rgba(0,0,0,.08));
      }
  
      .mobile-card-row:last-child {
          border-bottom: none;
      }
  }
  
  /* 自定义浅绿色进度条 */
  .bg-light-green {
      background-color: #90ee90 !important; /* LightGreen */
  }
  
  /* Custom styles for non-disruptive alerts in admin page */
  #serverAlert, #siteAlert, #telegramSettingsAlert {
      position: fixed !important; /* Use !important to override Bootstrap if necessary */
      top: 70px; /* Below navbar */
      left: 50%;
      transform: translateX(-50%);
      z-index: 1055; /* Higher than Bootstrap modals (1050) */
      padding: 0.75rem 1.25rem;
      /* margin-bottom: 1rem; /* Not needed for fixed */
      border: 1px solid transparent;
      border-radius: 0.25rem;
      min-width: 300px; /* Minimum width */
      max-width: 90%; /* Max width */
      text-align: center;
      box-shadow: 0 0.5rem 1rem rgba(0,0,0,0.15);
      /* Ensure d-none works to hide them, !important might be needed if Bootstrap's .alert.d-none is too specific */
  }
  
  #serverAlert.d-none, #siteAlert.d-none, #telegramSettingsAlert.d-none {
      display: none !important;
  }
  
  /* Semi-transparent backgrounds for different alert types */
  /* Light Theme Overrides for fixed alerts */
  #serverAlert.alert-success, #siteAlert.alert-success, #telegramSettingsAlert.alert-success {
      color: #0f5132; /* Bootstrap success text color */
      background-color: rgba(209, 231, 221, 0.95) !important; /* Semi-transparent success, !important for specificity */
      border-color: rgba(190, 221, 208, 0.95) !important;
  }
  
  #serverAlert.alert-danger, #siteAlert.alert-danger, #telegramSettingsAlert.alert-danger {
      color: #842029; /* Bootstrap danger text color */
      background-color: rgba(248, 215, 218, 0.95) !important; /* Semi-transparent danger */
      border-color: rgba(245, 198, 203, 0.95) !important;
  }
  
  #serverAlert.alert-warning, #siteAlert.alert-warning, #telegramSettingsAlert.alert-warning { /* For siteAlert if it uses warning */
      color: #664d03; /* Bootstrap warning text color */
      background-color: rgba(255, 243, 205, 0.95) !important; /* Semi-transparent warning */
      border-color: rgba(255, 238, 186, 0.95) !important;
  }
  
  
      [data-bs-theme="dark"] {
          body {
              background-color: #121212; /* 深色背景 */
              color: #e0e0e0; /* 浅色文字 */
          }
  
          .card {
              background-color: #1e1e1e; /* 卡片深色背景 */
              border: 1px solid #333;
              color: #e0e0e0; /* 卡片内文字颜色 */
          }
  
          .card-header {
              background-color: #2a2a2a;
              border-bottom: 1px solid #333;
              color: #f5f5f5;
          }
  
          .table {
              color: #e0e0e0; /* 表格文字颜色 */
          }
  
          .table th, .table td {
              border-color: #333; /* 表格边框颜色 */
          }
  
          .table-striped > tbody > tr:nth-of-type(odd) > * {
               background-color: rgba(255, 255, 255, 0.05); /* 深色模式下的条纹 */
               color: #e0e0e0;
          }
          
          .table-hover > tbody > tr:hover > * {
              background-color: rgba(255, 255, 255, 0.075); /* 深色模式下的悬停 */
              color: #f0f0f0;
          }
  
          .modal-content {
              background-color: rgba(30, 30, 30, 0.9); /* Semi-transparent dark grey for dark theme */
              color: #e0e0e0;
              /* backdrop-filter: blur(5px); /* Optional: adds a blur effect to content behind modal */
          }
  
          .modal-header {
              border-bottom-color: #333;
          }
          
          .modal-footer {
              border-top-color: #333;
          }
  
          .form-control {
              background-color: #2a2a2a;
              color: #e0e0e0;
              border-color: #333;
          }
  
          .form-control:focus {
              background-color: #2a2a2a;
              color: #e0e0e0;
              border-color: #555;
              box-shadow: 0 0 0 0.25rem rgba(100, 100, 100, 0.25);
          }
          
          .btn-outline-secondary {
               color: #adb5bd;
               border-color: #6c757d;
          }
          .btn-outline-secondary:hover {
               color: #fff;
               background-color: #6c757d;
               border-color: #6c757d;
          }
  
          .navbar {
              background-color: #1e1e1e !important; /* 确保覆盖 Bootstrap 默认 */
          }
  
          /* 暗色主题移动端卡片样式 */
          .mobile-server-card, .mobile-site-card {
              background: var(--bs-dark, #212529);
              border-color: var(--bs-border-color, #495057);
          }
  
          .mobile-card-header {
              background-color: rgba(255, 255, 255, 0.05);
              border-bottom-color: var(--bs-border-color, #495057);
          }
  
          .mobile-card-title {
              color: #ffffff !important;
          }
  
          .mobile-card-label {
              color: #ced4da !important;
          }
  
          .mobile-card-value {
              color: #ffffff !important;
          }
  
  
  
          .mobile-card-row {
              border-bottom-color: rgba(255, 255, 255, 0.08);
          }
  
          .mobile-card-two-columns {
              border-bottom-color: rgba(255, 255, 255, 0.08);
          }
  
          .mobile-card-column-item .mobile-card-label {
              color: #ced4da !important;
          }
  
          .mobile-card-column-item .mobile-card-value {
              color: #ffffff !important;
          }
  
          .mobile-history-label {
              color: #ced4da !important;
          }
  
          /* 暗色主题下的空状态和错误状态文字 */
          .mobile-card-container .text-muted {
              color: #ced4da !important;
          }
  
          .mobile-card-container .text-danger {
              color: #ff6b6b !important;
          }
  
          .mobile-card-container h6 {
              color: #ffffff !important;
          }
  
          .mobile-card-container small {
              color: #adb5bd !important;
          }
  
          /* 暗色主题下的移动端按钮优化 */
          .mobile-card-body .btn-outline-primary {
              color: #6ea8fe !important;
              border-color: #6ea8fe !important;
          }
  
          .mobile-card-body .btn-outline-primary:hover {
              color: #000 !important;
              background-color: #6ea8fe !important;
              border-color: #6ea8fe !important;
          }
  
          .mobile-card-body .btn-outline-info {
              color: #6edff6 !important;
              border-color: #6edff6 !important;
          }
  
          .mobile-card-body .btn-outline-info:hover {
              color: #000 !important;
              background-color: #6edff6 !important;
              border-color: #6edff6 !important;
          }
  
          .mobile-card-body .btn-outline-danger {
              color: #ea868f !important;
              border-color: #ea868f !important;
          }
  
          .mobile-card-body .btn-outline-danger:hover {
              color: #000 !important;
              background-color: #ea868f !important;
              border-color: #ea868f !important;
          }
  
          /* 暗色主题下的Badge徽章优化 */
          .mobile-card-header .badge.bg-success {
              background-color: #198754 !important;
              color: #ffffff !important;
          }
  
          .mobile-card-header .badge.bg-danger {
              background-color: #dc3545 !important;
              color: #ffffff !important;
          }
  
          .mobile-card-header .badge.bg-warning {
              background-color: #ffc107 !important;
              color: #000000 !important;
          }
  
          .mobile-card-header .badge.bg-secondary {
              background-color: #6c757d !important;
              color: #ffffff !important;
          }
  
          .mobile-card-header .badge.bg-primary {
              background-color: #0d6efd !important;
              color: #ffffff !important;
          }
  
          /* 暗色主题下的移动端容器标题优化 */
          .container h2 {
              color: #ffffff !important;
          }
  
          /* 暗色主题下的移动端加载状态优化 */
          .mobile-card-container .spinner-border {
              color: #6ea8fe !important;
          }
  
          .mobile-card-container .mt-2 {
              color: #ced4da !important;
          }
  
          /* 暗色主题下的导航栏按钮优化 */
          .navbar .btn-outline-light {
              color: #f8f9fa !important;
              border-color: #f8f9fa !important;
          }
  
          .navbar .btn-outline-light:hover {
              color: #000 !important;
              background-color: #f8f9fa !important;
              border-color: #f8f9fa !important;
          }
  
          .navbar .nav-link {
              color: #f8f9fa !important;
          }
  
          .navbar .nav-link:hover {
              color: #e9ecef !important;
          }
          .navbar-light .navbar-nav .nav-link {
               color: #ccc;
          }
          .navbar-light .navbar-nav .nav-link:hover {
               color: #fff;
          }
          .navbar-light .navbar-brand {
               color: #fff;
          }
           .footer {
              background-color: #1e1e1e !important;
              color: #cccccc; /* 修复夜间模式页脚文本颜色 */
          }
          a {
              color: #8ab4f8; /* 示例链接颜色 */
          }
          a:hover {
              color: #a9c9fc;
          }
  
          /* Dark Theme Overrides for fixed alerts */
          [data-bs-theme="dark"] #serverAlert.alert-success,
          [data-bs-theme="dark"] #siteAlert.alert-success,
          [data-bs-theme="dark"] #telegramSettingsAlert.alert-success {
              color: #75b798; /* Lighter green text for dark theme */
              background-color: rgba(40, 167, 69, 0.85) !important; /* Darker semi-transparent success */
              border-color: rgba(34, 139, 57, 0.85) !important;
          }
  
          [data-bs-theme="dark"] #serverAlert.alert-danger,
          [data-bs-theme="dark"] #siteAlert.alert-danger,
          [data-bs-theme="dark"] #telegramSettingsAlert.alert-danger {
              color: #ea868f; /* Lighter red text for dark theme */
              background-color: rgba(220, 53, 69, 0.85) !important; /* Darker semi-transparent danger */
              border-color: rgba(187, 45, 59, 0.85) !important;
          }
          
          [data-bs-theme="dark"] #serverAlert.alert-warning,
          [data-bs-theme="dark"] #siteAlert.alert-warning,
          [data-bs-theme="dark"] #telegramSettingsAlert.alert-warning {
              color: #ffd373; /* Lighter yellow text for dark theme */
              background-color: rgba(255, 193, 7, 0.85) !important; /* Darker semi-transparent warning */
              border-color: rgba(217, 164, 6, 0.85) !important;
          }
      }
  
  /* 拖拽排序样式 */
  .server-row-draggable, .site-row-draggable {
      transition: all 0.2s ease;
  }
  .server-row-draggable:hover, .site-row-draggable:hover {
      background-color: rgba(0, 123, 255, 0.1) !important;
  }
  .server-row-draggable.drag-over-top, .site-row-draggable.drag-over-top {
      border-top: 3px solid #007bff !important;
      background-color: rgba(0, 123, 255, 0.1) !important;
  }
  .server-row-draggable.drag-over-bottom, .site-row-draggable.drag-over-bottom {
      border-bottom: 3px solid #007bff !important;
      background-color: rgba(0, 123, 255, 0.1) !important;
  }
  .server-row-draggable[draggable="true"], .site-row-draggable[draggable="true"] {
      cursor: grab;
  }
  .server-row-draggable[draggable="true"]:active, .site-row-draggable[draggable="true"]:active {
      cursor: grabbing;
  }
  
  /* 暗色主题下的拖拽样式 */
  [data-bs-theme="dark"] .server-row-draggable:hover,
  [data-bs-theme="dark"] .site-row-draggable:hover {
      background-color: rgba(13, 110, 253, 0.2) !important;
  }
  [data-bs-theme="dark"] .server-row-draggable.drag-over-top,
  [data-bs-theme="dark"] .site-row-draggable.drag-over-top {
      border-top: 3px solid #0d6efd !important;
      background-color: rgba(13, 110, 253, 0.2) !important;
  }
  [data-bs-theme="dark"] .server-row-draggable.drag-over-bottom,
  [data-bs-theme="dark"] .site-row-draggable.drag-over-bottom {
      border-bottom: 3px solid #0d6efd !important;
      background-color: rgba(13, 110, 253, 0.2) !important;
  }
  `;
  }
  
  function getMainJs() {
    return `// main.js - 首页面的JavaScript逻辑
  
  // Global variables
  let vpsUpdateInterval = null;
  let siteUpdateInterval = null;
  let serverDataCache = {}; // Cache server data to avoid re-fetching for details
  let monthlyTrafficCache = {}; // Cache monthly traffic data
  let lastMonthlyTrafficFetch = 0; // Timestamp of last monthly traffic fetch
  const DEFAULT_VPS_REFRESH_INTERVAL_MS = 60000; // Default to 60 seconds for VPS data if backend setting fails
  const DEFAULT_SITE_REFRESH_INTERVAL_MS = 60000; // Default to 60 seconds for Site data
  const MONTHLY_TRAFFIC_CACHE_DURATION = 300000; // Cache monthly traffic for 5 minutes (300 seconds)
  
  // ==================== 统一API请求工具 ====================
  
  // 获取认证头
  function getAuthHeaders() {
      const token = localStorage.getItem('auth_token');
      const headers = { 'Content-Type': 'application/json' };
      if (token) {
          headers['Authorization'] = 'Bearer ' + token;
      }
      return headers;
  }
  
  // 统一API请求函数（用于需要认证的请求）
  async function apiRequest(url, options = {}) {
      const defaultOptions = {
          headers: getAuthHeaders(),
          ...options
      };
  
      try {
          const response = await fetch(url, defaultOptions);
  
          // 处理认证失败
          if (response.status === 401) {
              localStorage.removeItem('auth_token');
              if (window.location.pathname !== '/login.html') {
                  window.location.href = 'login.html';
              }
              throw new Error('认证失败，请重新登录');
          }
  
          if (!response.ok) {
              const errorData = await response.json().catch(() => ({}));
              throw new Error(errorData.message || \`请求失败 (\${response.status})\`);
          }
  
          return await response.json();
      } catch (error) {
          console.error(\`API请求错误 [\${url}]:\`, error);
          throw error;
      }
  }
  
  // 公开API请求函数（用于不需要认证的请求）
  async function publicApiRequest(url, options = {}) {
      const defaultOptions = {
          headers: getAuthHeaders(), // 仍然发送token（如果有），但不强制要求
          ...options
      };
  
      try {
          const response = await fetch(url, defaultOptions);
  
          if (!response.ok) {
              const errorData = await response.json().catch(() => ({}));
              throw new Error(errorData.message || \`请求失败 (\${response.status})\`);
          }
  
          return await response.json();
      } catch (error) {
          console.error(\`公开API请求错误 [\${url}]:\`, error);
          throw error;
      }
  }
  
  // 显示错误消息
  function showError(message, containerId = null) {
      console.error('错误:', message);
      if (containerId) {
          const container = document.getElementById(containerId);
          if (container) {
              container.innerHTML = \`<div class="alert alert-danger">\${message}</div>\`;
          }
      }
  }
  
  // 显示成功消息
  function showSuccess(message, containerId = null) {
      console.log('成功:', message);
      if (containerId) {
          const container = document.getElementById(containerId);
          if (container) {
              container.innerHTML = \`<div class="alert alert-success">\${message}</div>\`;
          }
      }
  }
  
  // Function to fetch VPS refresh interval and start periodic VPS data updates
  async function initializeVpsDataUpdates() {
      console.log('initializeVpsDataUpdates() called');
      let vpsRefreshIntervalMs = DEFAULT_VPS_REFRESH_INTERVAL_MS;
  
      try {
          console.log('Fetching VPS refresh interval from API...');
          const data = await publicApiRequest('/api/admin/settings/vps-report-interval');
          console.log('API response data:', data);
  
          if (data && typeof data.interval === 'number' && data.interval > 0) {
              vpsRefreshIntervalMs = data.interval * 1000; // Convert seconds to milliseconds
              console.log(\`Using backend-defined VPS refresh interval: \${data.interval}s (\${vpsRefreshIntervalMs}ms)\`);
          } else {
              console.warn('Invalid VPS interval from backend, using default:', data);
          }
      } catch (error) {
          console.error('Error fetching VPS refresh interval, using default:', error);
      }
  
      // Clear existing interval if any
      if (vpsUpdateInterval) {
          console.log('Clearing existing VPS update interval');
          clearInterval(vpsUpdateInterval);
      }
  
      // Set up new periodic updates for VPS data ONLY
      console.log('Setting up new VPS update interval with', vpsRefreshIntervalMs, 'ms');
      vpsUpdateInterval = setInterval(() => {
          console.log('VPS data refresh triggered by interval');
          loadAllServerStatuses();
      }, vpsRefreshIntervalMs);
  
      console.log(\`VPS data will refresh every \${vpsRefreshIntervalMs / 1000} seconds. Interval ID: \${vpsUpdateInterval}\`);
  }
  
  // Function to start periodic site status updates
  function initializeSiteDataUpdates() {
      const siteRefreshIntervalMs = DEFAULT_SITE_REFRESH_INTERVAL_MS; // Using a fixed interval for sites
  
      // Clear existing interval if any
      if (siteUpdateInterval) {
          clearInterval(siteUpdateInterval);
      }
  
      // Set up new periodic updates for site statuses ONLY
      siteUpdateInterval = setInterval(() => {
          loadAllSiteStatuses();
      }, siteRefreshIntervalMs);
  
      console.log(\`Site status data will refresh every \${siteRefreshIntervalMs / 1000} seconds.\`);
  }
  
  // Execute after the page loads (only for main page)
  document.addEventListener('DOMContentLoaded', function() {
      console.log('DOMContentLoaded event fired');
  
      // Check if we're on the main page by looking for the server table
      const serverTableBody = document.getElementById('serverTableBody');
      if (!serverTableBody) {
          // Not on the main page, only initialize theme
          console.log('Not on main page, only initializing theme');
          initializeTheme();
          return;
      }
  
      console.log('On main page, initializing all features');      // Initialize theme
      initializeTheme();

      // Update monthly headers with current month
      updateMonthlyHeaders();

      // Load initial data
      loadAllServerStatuses();
      loadAllSiteStatuses();
  
      // Initialize periodic updates separately
      console.log('Initializing VPS data updates...');
      initializeVpsDataUpdates();
      console.log('Initializing site data updates...');
      initializeSiteDataUpdates();
  
      // Add click event listener to the table body for row expansion
      serverTableBody.addEventListener('click', handleRowClick);
  
      // Check login status and update admin link
      updateAdminLink();
  });
  
  // --- Theme Management ---
  const THEME_KEY = 'themePreference';
  const LIGHT_THEME = 'light';
  const DARK_THEME = 'dark';
  
  function initializeTheme() {
      const themeToggler = document.getElementById('themeToggler');
      if (!themeToggler) return;
  
      const storedTheme = localStorage.getItem(THEME_KEY) || LIGHT_THEME;
      applyTheme(storedTheme);
  
      themeToggler.addEventListener('click', () => {
          const currentTheme = document.documentElement.getAttribute('data-bs-theme');
          const newTheme = currentTheme === DARK_THEME ? LIGHT_THEME : DARK_THEME;
          applyTheme(newTheme);
          localStorage.setItem(THEME_KEY, newTheme);
      });
  }
  
  function applyTheme(theme) {
      document.documentElement.setAttribute('data-bs-theme', theme);
      const themeTogglerIcon = document.querySelector('#themeToggler i');
      if (themeTogglerIcon) {
          if (theme === DARK_THEME) {
              themeTogglerIcon.classList.remove('bi-moon-stars-fill');
              themeTogglerIcon.classList.add('bi-sun-fill');
          } else {
              themeTogglerIcon.classList.remove('bi-sun-fill');
              themeTogglerIcon.classList.add('bi-moon-stars-fill');
          }
      }
  }
  // --- End Theme Management ---
  
  // --- Monthly Headers Management ---
  function getCurrentMonthName() {
      const now = new Date();
      const currentMonth = now.getMonth() + 1; // JavaScript月份从0开始，需要+1
      return currentMonth + '月';
  }

  function updateMonthlyHeaders() {
      const monthName = getCurrentMonthName();
      
      const monthlyUploadHeader = document.getElementById('monthlyUploadHeader');
      const monthlyDownloadHeader = document.getElementById('monthlyDownloadHeader');
      
      if (monthlyUploadHeader) {
          monthlyUploadHeader.textContent = monthName + '上传';
      }
      
      if (monthlyDownloadHeader) {
          monthlyDownloadHeader.textContent = monthName + '下载';
      }
      
      console.log('Updated monthly headers to ' + monthName);
  }
  // --- End Monthly Headers Management ---
  
  // Check login status and update the admin link in the navbar
  async function updateAdminLink() {
      const adminLink = document.getElementById('adminAuthLink');
      if (!adminLink) return; // Exit if link not found
  
      try {
          const token = localStorage.getItem('auth_token');
          if (!token) {
              // Not logged in (no token)
              adminLink.textContent = '管理员登录';
              adminLink.href = '/login.html';
              return;
          }
  
          const data = await publicApiRequest('/api/auth/status');
          if (data.authenticated) {
              // Logged in
              adminLink.textContent = '管理后台';
              adminLink.href = '/admin.html';
          } else {
              // Invalid token or not authenticated
              adminLink.textContent = '管理员登录';
              adminLink.href = '/login.html';
              localStorage.removeItem('auth_token'); // Clean up invalid token
          }
      } catch (error) {
          console.error('Error checking auth status for navbar link:', error);
          // Network error, assume not logged in
          adminLink.textContent = '管理员登录';
          adminLink.href = '/login.html';
      }
  }
  
  
  // Handle click on a server row
  function handleRowClick(event) {
      const clickedRow = event.target.closest('tr.server-row');
      if (!clickedRow) return; // Not a server row
  
      const serverId = clickedRow.getAttribute('data-server-id');
      const detailsRow = clickedRow.nextElementSibling; // The details row is the next sibling
  
      if (detailsRow && detailsRow.classList.contains('server-details-row')) {
          // Toggle visibility
          detailsRow.classList.toggle('d-none');
  
          // If showing, populate with detailed data
          if (!detailsRow.classList.contains('d-none')) {
              populateDetailsRow(serverId, detailsRow);
          }
      }
  }
  
  // Populate the detailed row with data
  function populateDetailsRow(serverId, detailsRow) {
      const serverData = serverDataCache[serverId];
      const detailsContentDiv = detailsRow.querySelector('.server-details-content');
  
      if (!serverData || !serverData.metrics || !detailsContentDiv) {
          detailsContentDiv.innerHTML = '<p class="text-muted">无详细数据</p>';
          return;
      }
  
      const metrics = serverData.metrics;
  
      let detailsHtml = '';
  
      // CPU Details
      if (metrics.cpu && metrics.cpu.load_avg) {
          detailsHtml += \`
              <div class="detail-item">
                  <strong>CPU负载 (1m, 5m, 15m):</strong> \${metrics.cpu.load_avg.join(', ')}
              </div>
          \`;
      }
  
      // Memory Details
      if (metrics.memory) {
          detailsHtml += \`
              <div class="detail-item">
                  <strong>内存:</strong>
                  总计: \${formatDataSize(metrics.memory.total * 1024)}<br>
                  已用: \${formatDataSize(metrics.memory.used * 1024)}<br>
                  空闲: \${formatDataSize(metrics.memory.free * 1024)}
              </div>
          \`;
      }
  
      // Disk Details
      if (metrics.disk) {
           detailsHtml += \`
              <div class="detail-item">
                  <strong>硬盘 (/):</strong>
                  总计: \${typeof metrics.disk.total === 'number' ? metrics.disk.total.toFixed(2) : '-'} GB<br>
                  已用: \${typeof metrics.disk.used === 'number' ? metrics.disk.used.toFixed(2) : '-'} GB<br>
                  空闲: \${typeof metrics.disk.free === 'number' ? metrics.disk.free.toFixed(2) : '-'} GB
              </div>
          \`;
      }
  
      // Network Totals
      if (metrics.network) {
          detailsHtml += \`
              <div class="detail-item">
                  <strong>总流量:</strong>
                  上传: \${formatDataSize(metrics.network.total_upload)}<br>
                  下载: \${formatDataSize(metrics.network.total_download)}
              </div>
          \`;
      }
  
      detailsContentDiv.innerHTML = detailsHtml || '<p class="text-muted">无详细数据</p>';
  }
  
  
  // Load all server statuses
  async function loadAllServerStatuses() {
      console.log('loadAllServerStatuses() called at', new Date().toLocaleTimeString());
      try {
          // 1. Get server list (with optional authentication for admin users)
          let serversData;
          try {
              serversData = await publicApiRequest('/api/servers');
          } catch (error) {
              // 如果获取服务器列表失败，可能是数据库未初始化，尝试初始化
              console.log('服务器列表获取失败，尝试初始化数据库...');
              await publicApiRequest('/api/init-db');
              serversData = await publicApiRequest('/api/servers');
          }
          const servers = serversData.servers || [];
          console.log('Found', servers.length, 'servers');
  
          const noServersAlert = document.getElementById('noServers');
          const serverTableBody = document.getElementById('serverTableBody');
  
          if (servers.length === 0) {
              noServersAlert.classList.remove('d-none');
              serverTableBody.innerHTML = '<tr><td colspan="13" class="text-center">No server data available. Please log in to the admin panel to add servers.</td></tr>';
              // Remove any existing detail rows if the server list becomes empty
              removeAllDetailRows();
              // 同时更新移动端卡片容器
              renderMobileServerCards([], {});
              return;
          } else {
              noServersAlert.classList.add('d-none');
          }
  
          // 2. Fetch status for all servers in parallel
          const statusPromises = servers.map(server =>
              publicApiRequest(\`/api/status/\${server.id}\`)
                  .then(data => data)
                  .catch(() => ({ server: server, metrics: null, error: true }))
          );
  
          const allStatuses = await Promise.all(statusPromises);
  
          // Update the serverDataCache with the latest data
          allStatuses.forEach(data => {
               serverDataCache[data.server.id] = data;
          });
  
          // 3. Render the table using DOM manipulation
          await renderServerTable(allStatuses);
  
      } catch (error) {
          console.error('Error loading server statuses:', error);
          const serverTableBody = document.getElementById('serverTableBody');
          serverTableBody.innerHTML = '<tr><td colspan="13" class="text-center text-danger">Failed to load server data. Please refresh the page.</td></tr>';
          removeAllDetailRows();
          // 同时更新移动端卡片容器显示错误状态
          const mobileContainer = document.getElementById('mobileServerContainer');
          if (mobileContainer) {
              mobileContainer.innerHTML = '<div class="text-center p-3 text-danger">加载服务器数据失败，请刷新页面重试。</div>';
          }
      }
  }
  
  // Remove all existing server detail rows
  function removeAllDetailRows() {
      document.querySelectorAll('.server-details-row').forEach(row => row.remove());
  }
  
  
  // Generate progress bar HTML
  function getProgressBarHtml(percentage) {
      if (typeof percentage !== 'number' || isNaN(percentage)) return '-';
      const percent = Math.max(0, Math.min(100, percentage)); // Ensure percentage is between 0 and 100
      let bgColorClass = 'bg-light-green'; // Use custom light green for < 50%
  
      if (percent >= 80) {
          bgColorClass = 'bg-danger'; // Red for >= 80%
      } else if (percent >= 50) {
          bgColorClass = 'bg-warning'; // Yellow for 50% - 79%
      }
  
      // Use relative positioning on the container and absolute for the text, centered over the whole bar
      return \`
          <div class="progress" style="height: 25px; font-size: 0.8em; position: relative; background-color: #e9ecef;">
              <div class="progress-bar \${bgColorClass}" role="progressbar" style="width: \${percent}%;" aria-valuenow="\${percent}" aria-valuemin="0" aria-valuemax="100"></div>
              <span style="position: absolute; width: 100%; text-align: center; line-height: 25px; font-weight: bold;">
                  \${percent.toFixed(1)}%
              </span>
          </div>
      \`;
  }
  
  
  // 移动端辅助函数
  function getServerStatusBadge(status) {
      if (status === 'online') {
          return { class: 'bg-success', text: '在线' };
      } else if (status === 'offline') {
          return { class: 'bg-danger', text: '离线' };
      } else if (status === 'error') {
          return { class: 'bg-warning text-dark', text: '错误' };
      } else {
          return { class: 'bg-secondary', text: '未知' };
      }
  }
  
  function formatBytes(bytes) {
      if (typeof bytes !== 'number' || isNaN(bytes)) return '-';
      if (bytes < 1024) return \`\${bytes.toFixed(1)} B\`;
      if (bytes < 1024 * 1024) return \`\${(bytes / 1024).toFixed(1)} KB\`;
      if (bytes < 1024 * 1024 * 1024) return \`\${(bytes / (1024 * 1024)).toFixed(1)} MB\`;
      return \`\${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB\`;
  }
  
  
    // 移动端服务器卡片渲染函数
  function renderMobileServerCards(allStatuses, monthlyTrafficMap = {}) {
      const mobileContainer = document.getElementById('mobileServerContainer');
      if (!mobileContainer) return;

      if (!allStatuses || allStatuses.length === 0) {
          mobileContainer.innerHTML = \`
              <div class="text-center p-4">
                  <i class="bi bi-server text-muted" style="font-size: 3rem;"></i>
                  <div class="mt-3 text-muted">
                      <h6>暂无服务器数据</h6>
                      <small>请登录管理后台添加服务器</small>
                  </div>
              </div>
          \`;
          return;
      }

      // 获取现有卡片
      const existingCards = new Map();
      mobileContainer.querySelectorAll('.mobile-server-card').forEach(card => {
          const serverId = card.getAttribute('data-server-id');
          if (serverId) {
              existingCards.set(serverId, card);
          }
      });

      // 创建新服务器ID集合
      const newServerIds = new Set(allStatuses.map(data => data.server.id));

      // 删除不再存在的服务器卡片
      existingCards.forEach((card, serverId) => {
          if (!newServerIds.has(serverId)) {
              card.remove();
          }
      });

      allStatuses.forEach(data => {
          const serverId = data.server.id;
          const serverName = data.server.name;
          const metrics = data.metrics;
          const hasError = data.error;
          const monthlyTraffic = monthlyTrafficMap[serverId];

          // 确定服务器状态
          let status = 'unknown';
          let lastUpdate = '从未';

          if (hasError) {
              status = 'error';
          } else if (metrics) {
              const now = new Date();
              const lastReportTime = new Date(metrics.timestamp * 1000);
              const diffMinutes = (now - lastReportTime) / (1000 * 60);

              if (diffMinutes <= 5) {
                  status = 'online';
              } else {
                  status = 'offline';
              }
              lastUpdate = lastReportTime.toLocaleString();
          }

          const statusInfo = getServerStatusBadge(status);

          // 获取所有数据
          const cpuValue = metrics && metrics.cpu && typeof metrics.cpu.usage_percent === 'number' ? \`\${metrics.cpu.usage_percent.toFixed(1)}%\` : '-';
          const memoryValue = metrics && metrics.memory && typeof metrics.memory.usage_percent === 'number' ? \`\${metrics.memory.usage_percent.toFixed(1)}%\` : '-';
          const diskValue = metrics && metrics.disk && typeof metrics.disk.usage_percent === 'number' ? \`\${metrics.disk.usage_percent.toFixed(1)}%\` : '-';
          const uptimeValue = metrics && metrics.uptime ? formatUptime(metrics.uptime) : '-';
          const uploadSpeed = metrics && metrics.network ? formatNetworkSpeed(metrics.network.upload_speed) : '-';
          const downloadSpeed = metrics && metrics.network ? formatNetworkSpeed(metrics.network.download_speed) : '-';
          const totalUpload = metrics && metrics.network ? formatDataSize(metrics.network.total_upload) : '-';
          const totalDownload = metrics && metrics.network ? formatDataSize(metrics.network.total_download) : '-';
          
          // 月结流量数据
          const monthlyUpload = monthlyTraffic ? formatDataSize(monthlyTraffic.monthly_upload) : '-';
          const monthlyDownload = monthlyTraffic ? formatDataSize(monthlyTraffic.monthly_download) : '-';

          // 生成卡片内容HTML
          const cardContentHtml = \`
              <div class="mobile-card-header">
                  <h6 class="mobile-card-title">\${serverName || '未命名服务器'}</h6>
                  <span class="badge \${statusInfo.class}">\${statusInfo.text}</span>
              </div>
              <div class="mobile-card-body">
                  <div class="mobile-card-two-columns">
                      <div class="mobile-card-column-item">
                          <span class="mobile-card-label">上传速度</span>
                          <span class="mobile-card-value">\${uploadSpeed}</span>
                      </div>
                      <div class="mobile-card-column-item">
                          <span class="mobile-card-label">下载速度</span>
                          <span class="mobile-card-value">\${downloadSpeed}</span>
                      </div>
                  </div>
                  <div class="mobile-card-two-columns">
                      <div class="mobile-card-column-item">
                          <span class="mobile-card-label">CPU</span>
                          <span class="mobile-card-value">\${cpuValue}</span>
                      </div>
                      <div class="mobile-card-column-item">
                          <span class="mobile-card-label">内存</span>
                          <span class="mobile-card-value">\${memoryValue}</span>
                      </div>
                  </div>
                  <div class="mobile-card-two-columns">
                      <div class="mobile-card-column-item">
                          <span class="mobile-card-label">硬盘</span>
                          <span class="mobile-card-value">\${diskValue}</span>
                      </div>
                      <div class="mobile-card-column-item">
                          <span class="mobile-card-label">运行时长</span>
                          <span class="mobile-card-value">\${uptimeValue}</span>
                      </div>
                  </div>
                  <div class="mobile-card-two-columns">
                      <div class="mobile-card-column-item">
                          <span class="mobile-card-label">\${getCurrentMonthName()}上传</span>
                          <span class="mobile-card-value">\${monthlyUpload}</span>
                      </div>
                      <div class="mobile-card-column-item">
                          <span class="mobile-card-label">\${getCurrentMonthName()}下载</span>
                          <span class="mobile-card-value">\${monthlyDownload}</span>
                      </div>
                  </div>
                  <div class="mobile-card-row">
                      <span class="mobile-card-label">最后更新</span>
                      <span class="mobile-card-value">\${lastUpdate}</span>
                  </div>
              </div>
          \`;

          const existingCard = existingCards.get(serverId);
          if (existingCard) {
              // 更新现有卡片（只在内容发生变化时更新）
              if (existingCard.innerHTML !== cardContentHtml) {
                  existingCard.innerHTML = cardContentHtml;
              }
          } else {
              // 创建新卡片
              const card = document.createElement('div');
              card.className = 'mobile-server-card';
              card.setAttribute('data-server-id', serverId);
              card.innerHTML = cardContentHtml;
              mobileContainer.appendChild(card);
          }
      });
  }
  
  // 移动端网站卡片渲染函数
  function renderMobileSiteCards(sites) {
      const mobileContainer = document.getElementById('mobileSiteContainer');
      if (!mobileContainer) return;
  
      mobileContainer.innerHTML = '';
  
      if (!sites || sites.length === 0) {
          mobileContainer.innerHTML = \`
              <div class="text-center p-4">
                  <i class="bi bi-globe text-muted" style="font-size: 3rem;"></i>
                  <div class="mt-3 text-muted">
                      <h6>暂无监控网站数据</h6>
                      <small>请登录管理后台添加监控网站</small>
                  </div>
              </div>
          \`;
          return;
      }
  
      sites.forEach(site => {
          const card = document.createElement('div');
          card.className = 'mobile-site-card';
  
          const statusInfo = getSiteStatusBadge(site.last_status);
          const lastCheckTime = site.last_checked ? new Date(site.last_checked * 1000).toLocaleString() : '从未';
          const responseTime = site.last_response_time_ms !== null ? \`\${site.last_response_time_ms} ms\` : '-';
  
          // 卡片头部
          const cardHeader = document.createElement('div');
          cardHeader.className = 'mobile-card-header';
          cardHeader.innerHTML = \`
              <h6 class="mobile-card-title">\${site.name || '未命名网站'}</h6>
              <span class="badge \${statusInfo.class}">\${statusInfo.text}</span>
          \`;
  
          // 卡片主体
          const cardBody = document.createElement('div');
          cardBody.className = 'mobile-card-body';
  
          // 网站信息 - 两列布局
          const statusCode = site.last_status_code || '-';
  
          // 状态码 | 响应时间
          const statusResponseRow = document.createElement('div');
          statusResponseRow.className = 'mobile-card-two-columns';
          statusResponseRow.innerHTML = \`
              <div class="mobile-card-column-item">
                  <span class="mobile-card-label">状态码</span>
                  <span class="mobile-card-value">\${statusCode}</span>
              </div>
              <div class="mobile-card-column-item">
                  <span class="mobile-card-label">响应时间</span>
                  <span class="mobile-card-value">\${responseTime}</span>
              </div>
          \`;
          cardBody.appendChild(statusResponseRow);
  
          // 最后检查 - 单行
          const lastCheckRow = document.createElement('div');
          lastCheckRow.className = 'mobile-card-row';
          lastCheckRow.innerHTML = \`
              <span class="mobile-card-label">最后检查</span>
              <span class="mobile-card-value">\${lastCheckTime}</span>
          \`;
          cardBody.appendChild(lastCheckRow);
  
          // 24小时历史记录 - 始终显示，即使没有数据
          const historyContainer = document.createElement('div');
          historyContainer.className = 'mobile-history-container';
          historyContainer.innerHTML = \`
              <div class="mobile-history-label">24小时记录</div>
              <div class="history-bar-container"></div>
          \`;
          cardBody.appendChild(historyContainer);
  
          // 使用统一的历史记录渲染函数
          const historyBarContainer = historyContainer.querySelector('.history-bar-container');
          renderSiteHistoryBar(historyBarContainer, site.history || []);
  
          // 组装卡片
          card.appendChild(cardHeader);
          card.appendChild(cardBody);
  
          mobileContainer.appendChild(card);
      });
  }
  
  
  
  
    // Render the server table using DOM manipulation
  async function renderServerTable(allStatuses) {
      const tableBody = document.getElementById('serverTableBody');
      const detailsTemplate = document.getElementById('serverDetailsTemplate');

      // 1. Store IDs of currently expanded servers
      const expandedServerIds = new Set();
      // Iterate over main server rows to find their expanded detail rows
      tableBody.querySelectorAll('tr.server-row').forEach(mainRow => {
          const detailRow = mainRow.nextElementSibling;
          if (detailRow && detailRow.classList.contains('server-details-row') && !detailRow.classList.contains('d-none')) {
              const serverId = mainRow.getAttribute('data-server-id');
              if (serverId) {
                  expandedServerIds.add(serverId);
              }
          }
      });

      // 2. 获取所有服务器的月结流量数据（使用缓存）
      let monthlyTrafficMap = {};
      const now = Date.now();
      
      // 检查是否需要重新获取月结流量数据
      if (now - lastMonthlyTrafficFetch > MONTHLY_TRAFFIC_CACHE_DURATION) {
          console.log('Fetching fresh monthly traffic data...');
          const monthlyTrafficPromises = allStatuses.map(data => 
              publicApiRequest(\`/api/traffic/\${data.server.id}/monthly\`)
                  .then(response => ({ serverId: data.server.id, monthlyData: response.monthly_traffic }))
                  .catch(() => ({ serverId: data.server.id, monthlyData: null }))
          );
          
          const monthlyTrafficResults = await Promise.all(monthlyTrafficPromises);
          monthlyTrafficResults.forEach(result => {
              monthlyTrafficCache[result.serverId] = result.monthlyData;
              monthlyTrafficMap[result.serverId] = result.monthlyData;
          });
          lastMonthlyTrafficFetch = now;
      } else {
          console.log('Using cached monthly traffic data...');
          // 使用缓存数据
          allStatuses.forEach(data => {
              monthlyTrafficMap[data.server.id] = monthlyTrafficCache[data.server.id] || null;
          });
      }

      // 3. 获取当前表格中的所有服务器行
      const existingRows = new Map();
      tableBody.querySelectorAll('tr.server-row').forEach(row => {
          const serverId = row.getAttribute('data-server-id');
          if (serverId) {
              existingRows.set(serverId, row);
          }
      });

      // 4. 创建新服务器ID集合
      const newServerIds = new Set(allStatuses.map(data => data.server.id));

      // 5. 删除不再存在的服务器行
      existingRows.forEach((row, serverId) => {
          if (!newServerIds.has(serverId)) {
              // 删除服务器行和对应的详情行
              const detailRow = row.nextElementSibling;
              if (detailRow && detailRow.classList.contains('server-details-row')) {
                  detailRow.remove();
              }
              row.remove();
          }
      });

      allStatuses.forEach(data => {
          const serverId = data.server.id;
          const serverName = data.server.name;
          const metrics = data.metrics;
          const hasError = data.error;
          const monthlyTraffic = monthlyTrafficMap[serverId];

          let statusBadge = '<span class="badge bg-secondary">未知</span>';
          let cpuHtml = '-';
          let memoryHtml = '-';
          let diskHtml = '-';
          let uploadSpeed = '-';
          let downloadSpeed = '-';
          let totalUpload = '-';
          let totalDownload = '-';
          let monthlyUpload = '-';
          let monthlyDownload = '-';
          let uptime = '-';
          let lastUpdate = '-';

          if (hasError) {
              statusBadge = '<span class="badge bg-warning text-dark">错误</span>';
          } else if (metrics) {
              const now = new Date();
              const lastReportTime = new Date(metrics.timestamp * 1000);
              const diffMinutes = (now - lastReportTime) / (1000 * 60);

              if (diffMinutes <= 5) { // Considered online within 5 minutes
                  statusBadge = '<span class="badge bg-success">在线</span>';
              } else {
                  statusBadge = '<span class="badge bg-danger">离线</span>';
              }

              cpuHtml = getProgressBarHtml(metrics.cpu.usage_percent);
              memoryHtml = getProgressBarHtml(metrics.memory.usage_percent);
              diskHtml = getProgressBarHtml(metrics.disk.usage_percent);
              uploadSpeed = formatNetworkSpeed(metrics.network.upload_speed);
              downloadSpeed = formatNetworkSpeed(metrics.network.download_speed);
              totalUpload = formatDataSize(metrics.network.total_upload);
              totalDownload = formatDataSize(metrics.network.total_download);
              uptime = metrics.uptime ? formatUptime(metrics.uptime) : '-';
              lastUpdate = lastReportTime.toLocaleString();
          }

          // 处理月结流量数据
          if (monthlyTraffic) {
              monthlyUpload = formatDataSize(monthlyTraffic.monthly_upload);
              monthlyDownload = formatDataSize(monthlyTraffic.monthly_download);
          }

          const newRowHtml = \`
              <td>\${serverName}</td>
              <td>\${statusBadge}</td>
              <td>\${cpuHtml}</td>
              <td>\${memoryHtml}</td>
              <td>\${diskHtml}</td>
              <td><span style="color: #000;">\${uploadSpeed}</span></td>
              <td><span style="color: #000;">\${downloadSpeed}</span></td>
              <td style="display: none;"><span style="color: #000;">\${totalUpload}</span></td>
              <td style="display: none;"><span style="color: #000;">\${totalDownload}</span></td>
              <td><span style="color: #000;">\${monthlyUpload}</span></td>
              <td><span style="color: #000;">\${monthlyDownload}</span></td>
              <td><span style="color: #000;">\${uptime}</span></td>
              <td><span style="color: #000;">\${lastUpdate}</span></td>
          \`;

          const existingRow = existingRows.get(serverId);
          if (existingRow) {
              // 6. 更新现有行（只在内容发生变化时更新）
              if (existingRow.innerHTML !== newRowHtml) {
                  existingRow.innerHTML = newRowHtml;
              }
          } else {
              // 7. 创建新行
              const mainRow = document.createElement('tr');
              mainRow.classList.add('server-row');
              mainRow.setAttribute('data-server-id', serverId);
              mainRow.innerHTML = newRowHtml;

              // Clone the details row template
              const detailsRowElement = detailsTemplate.content.cloneNode(true).querySelector('tr');

              tableBody.appendChild(mainRow);
              tableBody.appendChild(detailsRowElement);

              // 添加到已存在行映射中
              existingRows.set(serverId, mainRow);
          }

          // 8. 如果这个服务器之前是展开的，重新展开它
          if (expandedServerIds.has(serverId)) {
              const currentRow = existingRows.get(serverId);
              const detailRow = currentRow.nextElementSibling;
              if (detailRow && detailRow.classList.contains('server-details-row')) {
                  detailRow.classList.remove('d-none');
                  populateDetailsRow(serverId, detailRow);
              }
          }
      });

      // 9. 同时渲染移动端卡片（传递月结流量数据）
      renderMobileServerCards(allStatuses, monthlyTrafficMap);
  }
  
  
  // Format network speed
  function formatNetworkSpeed(bytesPerSecond) {
      if (typeof bytesPerSecond !== 'number' || isNaN(bytesPerSecond)) return '-';
      if (bytesPerSecond < 1024) {
          return \`\${bytesPerSecond.toFixed(1)} B/s\`;
      } else if (bytesPerSecond < 1024 * 1024) {
          return \`\${(bytesPerSecond / 1024).toFixed(1)} KB/s\`;
      } else if (bytesPerSecond < 1024 * 1024 * 1024) {
          return \`\${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s\`;
      } else {
          return \`\${(bytesPerSecond / (1024 * 1024 * 1024)).toFixed(1)} GB/s\`;
      }
  }
  
  // Format data size
  function formatDataSize(bytes) {
      if (typeof bytes !== 'number' || isNaN(bytes)) return '-';
      if (bytes < 1024) {
          return \`\${bytes.toFixed(1)} B\`;
      } else if (bytes < 1024 * 1024) {
          return \`\${(bytes / 1024).toFixed(1)} KB\`;
      } else if (bytes < 1024 * 1024 * 1024) {
          return \`\${(bytes / (1024 * 1024)).toFixed(1)} MB\`;
      } else if (bytes < 1024 * 1024 * 1024 * 1024) {
          return \`\${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB\`;
      } else {
          return \`\${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TB\`;
      }
  }
  
  // Format uptime from seconds to a human-readable string
  function formatUptime(totalSeconds) {
      if (typeof totalSeconds !== 'number' || isNaN(totalSeconds) || totalSeconds < 0) {
          return '-';
      }
  
      const days = Math.floor(totalSeconds / (3600 * 24));
      totalSeconds %= (3600 * 24);
      const hours = Math.floor(totalSeconds / 3600);
      totalSeconds %= 3600;
      const minutes = Math.floor(totalSeconds / 60);
  
      let uptimeString = '';
      if (days > 0) {
          uptimeString += \`\${days}天 \`;
      }
      if (hours > 0) {
          uptimeString += \`\${hours}小时 \`;
      }
      if (minutes > 0 || (days === 0 && hours === 0)) { // Show minutes if it's the only unit or if other units are zero
          uptimeString += \`\${minutes}分钟\`;
      }
      
      return uptimeString.trim() || '0分钟'; // Default to 0 minutes if string is empty
  }
  
  
  // --- Website Status Functions ---
  
  // Load all website statuses
  async function loadAllSiteStatuses() {
      try {
          let data;
          try {
              data = await publicApiRequest('/api/sites/status');
          } catch (error) {
              // 如果获取网站状态失败，可能是数据库未初始化，尝试初始化
              console.log('网站状态获取失败，尝试初始化数据库...');
              await publicApiRequest('/api/init-db');
              data = await publicApiRequest('/api/sites/status');
          }
          const sites = data.sites || [];
  
          const noSitesAlert = document.getElementById('noSites');
          const siteStatusTableBody = document.getElementById('siteStatusTableBody');
  
          if (sites.length === 0) {
              noSitesAlert.classList.remove('d-none');
              siteStatusTableBody.innerHTML = '<tr><td colspan="6" class="text-center">No websites are being monitored.</td></tr>'; // Colspan updated
              // 同时更新移动端卡片容器
              renderMobileSiteCards([]);
              return;
          } else {
              noSitesAlert.classList.add('d-none');
          }
  
          renderSiteStatusTable(sites);
  
      } catch (error) {
          console.error('Error loading website statuses:', error);
          const siteStatusTableBody = document.getElementById('siteStatusTableBody');
          siteStatusTableBody.innerHTML = '<tr><td colspan="6" class="text-center text-danger">Failed to load website status data. Please refresh the page.</td></tr>'; // Colspan updated
          // 同时更新移动端卡片容器显示错误状态
          const mobileContainer = document.getElementById('mobileSiteContainer');
          if (mobileContainer) {
              mobileContainer.innerHTML = '<div class="text-center p-3 text-danger">加载网站数据失败，请刷新页面重试。</div>';
          }
      }
  }
  
  // Render the website status table
  async function renderSiteStatusTable(sites) {
      const tableBody = document.getElementById('siteStatusTableBody');
      tableBody.innerHTML = ''; // Clear existing rows
  
      for (const site of sites) {
          const row = document.createElement('tr');
          const statusInfo = getSiteStatusBadge(site.last_status);
          const lastCheckTime = site.last_checked ? new Date(site.last_checked * 1000).toLocaleString() : '从未';
          const responseTime = site.last_response_time_ms !== null ? \`\${site.last_response_time_ms} ms\` : '-';
  
          const historyCell = document.createElement('td');
          const historyContainer = document.createElement('div');
          historyContainer.className = 'history-bar-container';
          historyCell.appendChild(historyContainer);
  
          row.innerHTML = \`
              <td>\${site.name || '-'}</td>
              <td><span class="badge \${statusInfo.class}">\${statusInfo.text}</span></td>
              <td>\${site.last_status_code || '-'}</td>
              <td>\${responseTime}</td>
              <td>\${lastCheckTime}</td>
          \`;
          row.appendChild(historyCell);
          tableBody.appendChild(row);
  
          // 直接使用站点的历史数据渲染历史条
          renderSiteHistoryBar(historyContainer, site.history || []);
      }
  
      // 同时渲染移动端卡片
      renderMobileSiteCards(sites);
  }
  
  // Render 24h history bar for a site (unified function for PC and mobile)
  function renderSiteHistoryBar(containerElement, history) {
      let historyHtml = '';
      const now = new Date();
  
      for (let i = 0; i < 24; i++) {
          const slotTime = new Date(now);
          slotTime.setHours(now.getHours() - i);
          const slotStart = new Date(slotTime);
          slotStart.setMinutes(0, 0, 0);
          const slotEnd = new Date(slotTime);
          slotEnd.setMinutes(59, 59, 999);
  
          const slotStartTimestamp = Math.floor(slotStart.getTime() / 1000);
          const slotEndTimestamp = Math.floor(slotEnd.getTime() / 1000);
  
          const recordForHour = history?.find(
              r => r.timestamp >= slotStartTimestamp && r.timestamp <= slotEndTimestamp
          );
  
          let barClass = 'history-bar-pending';
          let titleText = \`\${String(slotStart.getHours()).padStart(2, '0')}:00 - \${String((slotStart.getHours() + 1) % 24).padStart(2, '0')}:00: 无记录\`;
  
          if (recordForHour) {
              if (recordForHour.status === 'UP') {
                  barClass = 'history-bar-up';
              } else if (['DOWN', 'TIMEOUT', 'ERROR'].includes(recordForHour.status)) {
                  barClass = 'history-bar-down';
              }
              const recordDate = new Date(recordForHour.timestamp * 1000);
              titleText = \`\${recordDate.toLocaleString()}: \${recordForHour.status} (\${recordForHour.status_code || 'N/A'}), \${recordForHour.response_time_ms || '-'}ms\`;
          }
  
          historyHtml += \`<div class="history-bar \${barClass}" title="\${titleText}"></div>\`;
      }
  
      containerElement.innerHTML = historyHtml;
  }
  
  
  // Get website status badge class and text (copied from admin.js for reuse)
  function getSiteStatusBadge(status) {
      switch (status) {
          case 'UP': return { class: 'bg-success', text: '正常' };
          case 'DOWN': return { class: 'bg-danger', text: '故障' };
          case 'TIMEOUT': return { class: 'bg-warning text-dark', text: '超时' };
          case 'ERROR': return { class: 'bg-danger', text: '错误' };
          case 'PENDING': return { class: 'bg-secondary', text: '待检测' };
          default: return { class: 'bg-secondary', text: '未知' };
      }
  }
  `;
  }
  
  function getLoginJs() {
    return `// login.js - 登录页面的JavaScript逻辑
  
  // ==================== 统一API请求工具 ====================
  
  // 统一API请求函数
  async function apiRequest(url, options = {}) {
      const defaultOptions = {
          headers: { 'Content-Type': 'application/json' },
          ...options
      };
  
      try {
          const response = await fetch(url, defaultOptions);
  
          if (!response.ok) {
              const errorData = await response.json().catch(() => ({}));
              throw new Error(errorData.message || \`请求失败 (\${response.status})\`);
          }
  
          return await response.json();
      } catch (error) {
          console.error(\`API请求错误 [\${url}]:\`, error);
          throw error;
      }
  }
  
  // --- Theme Management (copied from main.js) ---
  const THEME_KEY = 'themePreference';
  const LIGHT_THEME = 'light';
  const DARK_THEME = 'dark';
  
  function initializeTheme() {
      const themeToggler = document.getElementById('themeToggler');
      if (!themeToggler) return;
  
      const storedTheme = localStorage.getItem(THEME_KEY) || LIGHT_THEME;
      applyTheme(storedTheme);
  
      themeToggler.addEventListener('click', () => {
          const currentTheme = document.documentElement.getAttribute('data-bs-theme');
          const newTheme = currentTheme === DARK_THEME ? LIGHT_THEME : DARK_THEME;
          applyTheme(newTheme);
          localStorage.setItem(THEME_KEY, newTheme);
      });
  }
  
  function applyTheme(theme) {
      document.title = \`Admin Panel - Theme: \${theme.toUpperCase()}\`; // Diagnostic line
      document.documentElement.setAttribute('data-bs-theme', theme);
      const themeTogglerIcon = document.querySelector('#themeToggler i');
      if (themeTogglerIcon) {
          if (theme === DARK_THEME) {
              themeTogglerIcon.classList.remove('bi-moon-stars-fill');
              themeTogglerIcon.classList.add('bi-sun-fill');
          } else {
              themeTogglerIcon.classList.remove('bi-sun-fill');
              themeTogglerIcon.classList.add('bi-moon-stars-fill');
          }
      }
  }
  // --- End Theme Management ---
  
  
  // 页面加载完成后执行
  document.addEventListener('DOMContentLoaded', function() {
      // Initialize theme
      initializeTheme();
  
      // 获取登录表单元素
      const loginForm = document.getElementById('loginForm');
      const loginAlert = document.getElementById('loginAlert');
  
      // 添加表单提交事件监听
      loginForm.addEventListener('submit', function(e) {
          e.preventDefault();
  
          // 获取用户输入
          const username = document.getElementById('username').value.trim();
          const password = document.getElementById('password').value.trim();
  
          // 验证输入
          if (!username || !password) {
              showLoginError('请输入用户名和密码');
              return;
          }
  
          // 执行登录
          login(username, password);
      });
  
      // 加载默认凭据信息
      loadDefaultCredentials();
  
      // 检查是否已登录
      checkLoginStatus();
  });
  
  // 加载默认凭据信息（本地显示，无需API调用）
  function loadDefaultCredentials() {
      const credentialsInfo = document.getElementById('defaultCredentialsInfo');
      if (credentialsInfo) {
          credentialsInfo.innerHTML = '<strong>喵呜</strong>🐱';
      }
  }
  
  // 检查登录状态
  async function checkLoginStatus() {
      try {
          // 从localStorage获取token
          const token = localStorage.getItem('auth_token');
          if (!token) {
              return;
          }
  
          const data = await apiRequest('/api/auth/status', {
              headers: { 'Authorization': 'Bearer ' + token }
          });
  
          if (data.authenticated) {
              // 已登录，重定向到管理后台
              window.location.href = 'admin.html';
          }
      } catch (error) {
          console.error('检查登录状态错误:', error);
      }
  }
  
  // 登录函数
  async function login(username, password) {
      try {
          // 显示加载状态
          const loginForm = document.getElementById('loginForm');
          const submitBtn = loginForm.querySelector('button[type="submit"]');
          const originalBtnText = submitBtn.innerHTML;
          submitBtn.disabled = true;
          submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 登录中...';
  
          // 发送登录请求
          const data = await apiRequest('/api/auth/login', {
              method: 'POST',
              body: JSON.stringify({ username, password })
          });
  
          // 恢复按钮状态
          submitBtn.disabled = false;
          submitBtn.innerHTML = originalBtnText;
  
          // 保存token到localStorage
          localStorage.setItem('auth_token', data.token);
  
          // 直接跳转到管理后台
          window.location.href = 'admin.html';
  
      } catch (error) {
          console.error('登录错误:', error);
  
          // 恢复按钮状态
          const loginForm = document.getElementById('loginForm');
          const submitBtn = loginForm.querySelector('button[type="submit"]');
          submitBtn.disabled = false;
          submitBtn.innerHTML = '登录';
  
          showLoginError(error.message || '登录请求失败，请稍后重试');
      }
  }
  
  // 显示登录错误
  function showLoginError(message) {
      const loginAlert = document.getElementById('loginAlert');
      loginAlert.textContent = message;
      loginAlert.classList.remove('d-none');
      
      // 5秒后自动隐藏错误信息
      setTimeout(() => {
          loginAlert.classList.add('d-none');
      }, 5000);
  }`;
  }
  // Helper functions for updating server/site settings are no longer needed for frequent notifications
  // as that feature is removed.
  
  function getAdminJs() {
    return `// admin.js - 管理后台的JavaScript逻辑
  
  // ==================== 统一API请求工具 ====================
  
  // 获取认证头
  function getAuthHeaders() {
      const token = localStorage.getItem('auth_token');
      const headers = { 'Content-Type': 'application/json' };
      if (token) {
          headers['Authorization'] = 'Bearer ' + token;
      }
      return headers;
  }
  
  // 统一API请求函数
  async function apiRequest(url, options = {}) {
      const defaultOptions = {
          headers: getAuthHeaders(),
          ...options
      };
  
      try {
          const response = await fetch(url, defaultOptions);
  
          // 处理认证失败
          if (response.status === 401) {
              localStorage.removeItem('auth_token');
              window.location.href = 'login.html';
              throw new Error('认证失败，请重新登录');
          }
  
          if (!response.ok) {
              const errorData = await response.json().catch(() => ({}));
              throw new Error(errorData.message || \`请求失败 (\${response.status})\`);
          }
  
          return await response.json();
      } catch (error) {
          console.error(\`API请求错误 [\${url}]:\`, error);
          throw error;
      }
  }
  
  // Global variables for VPS data updates
  let vpsUpdateInterval = null;
  const DEFAULT_VPS_REFRESH_INTERVAL_MS = 60000; // Default to 60 seconds for VPS data if backend setting fails
  
  // Function to fetch VPS refresh interval and start periodic VPS data updates
  async function initializeVpsDataUpdates() {
      console.log('initializeVpsDataUpdates() called in admin page');
      let vpsRefreshIntervalMs = DEFAULT_VPS_REFRESH_INTERVAL_MS;
  
      try {
          console.log('Fetching VPS refresh interval from API...');
          const data = await apiRequest('/api/admin/settings/vps-report-interval');
          console.log('API response data:', data);
  
          if (data && typeof data.interval === 'number' && data.interval > 0) {
              vpsRefreshIntervalMs = data.interval * 1000; // Convert seconds to milliseconds
              console.log(\`Using backend-defined VPS refresh interval: \${data.interval}s (\${vpsRefreshIntervalMs}ms)\`);
          } else {
              console.warn('Invalid VPS interval from backend, using default:', data);
          }
      } catch (error) {
          console.error('Error fetching VPS refresh interval, using default:', error);
      }
  
      // Clear existing interval if any
      if (vpsUpdateInterval) {
          console.log('Clearing existing VPS update interval');
          clearInterval(vpsUpdateInterval);
      }
  
      // Set up new periodic updates for VPS data ONLY
      console.log('Setting up new VPS update interval with', vpsRefreshIntervalMs, 'ms');
      vpsUpdateInterval = setInterval(() => {
          console.log('VPS data refresh triggered by interval in admin page');
          // Reload server list to get updated data
          if (typeof loadServerList === 'function') {
              loadServerList();
          }
      }, vpsRefreshIntervalMs);
  
      console.log(\`VPS data will refresh every \${vpsRefreshIntervalMs / 1000} seconds. Interval ID: \${vpsUpdateInterval}\`);
  }
  
  // --- Theme Management (copied from main.js) ---
  const THEME_KEY = 'themePreference';
  const LIGHT_THEME = 'light';
  const DARK_THEME = 'dark';
  
  function initializeTheme() {
      const themeToggler = document.getElementById('themeToggler');
      if (!themeToggler) return;
  
      const storedTheme = localStorage.getItem(THEME_KEY) || LIGHT_THEME;
      applyTheme(storedTheme);
  
      themeToggler.addEventListener('click', () => {
          const currentTheme = document.documentElement.getAttribute('data-bs-theme');
          const newTheme = currentTheme === DARK_THEME ? LIGHT_THEME : DARK_THEME;
          applyTheme(newTheme);
          localStorage.setItem(THEME_KEY, newTheme);
      });
  }
  
  function applyTheme(theme) {
      document.documentElement.setAttribute('data-bs-theme', theme);
      const themeTogglerIcon = document.querySelector('#themeToggler i');
      if (themeTogglerIcon) {
          if (theme === DARK_THEME) {
              themeTogglerIcon.classList.remove('bi-moon-stars-fill');
              themeTogglerIcon.classList.add('bi-sun-fill');
          } else {
              themeTogglerIcon.classList.remove('bi-sun-fill');
              themeTogglerIcon.classList.add('bi-moon-stars-fill');
          }
      }
  }
  // --- End Theme Management ---
  
  // 工具提示现在使用浏览器原生title属性，无需JavaScript初始化
  
  // 优化的清理函数 - 清理可能卡住的开关
  function cleanupStuckToggles() {
      const stuckToggles = document.querySelectorAll('[data-updating="true"]');
      if (stuckToggles.length > 0) {
          console.log('清理', stuckToggles.length, '个卡住的开关');
          stuckToggles.forEach(toggle => {
              toggle.disabled = false;
              delete toggle.dataset.updating;
              toggle.style.opacity = '1';
          });
      }
  }
  
  // 移除了复杂的waitForToggleReady函数，现在直接在API响应后更新UI状态
  
  // 全局变量
  let currentServerId = null;
  let currentSiteId = null; // For site deletion
  let serverList = [];
  let siteList = []; // For monitored sites
  let hasAddedNewServer = false; // 标记是否添加了新服务器
  
  // 页面加载完成后执行
  document.addEventListener('DOMContentLoaded', async function() {
      // Initialize theme
      initializeTheme();
  
      // 检查登录状态 - 必须先完成认证检查
      await checkLoginStatus();
  
      // 初始化事件监听
      initEventListeners();
  
      // 初始化Bootstrap tooltips
      const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
      tooltipTriggerList.map(function (tooltipTriggerEl) {
          return new bootstrap.Tooltip(tooltipTriggerEl);
      });
  
      // 加载服务器列表
      loadServerList();
      // 加载监控网站列表
      loadSiteList();
      // 加载Telegram设置
      loadTelegramSettings();
      // 加载全局设置 (VPS Report Interval) - will use serverAlert for notifications
      loadGlobalSettings();
  
      // 初始化管理后台的定时刷新机制
      initializeVpsDataUpdates();
  
      // 检查是否使用默认密码
      checkDefaultPasswordUsage();
  
      // 启动定期状态清理，每30秒检查一次卡住的开关（优化后减少频率）
      setInterval(cleanupStuckToggles, 30000);
  });
  
  // 检查登录状态
  async function checkLoginStatus() {
      try {
          // 从localStorage获取token
          const token = localStorage.getItem('auth_token');
          if (!token) {
              // 未登录，重定向到登录页面
              window.location.href = 'login.html';
              return;
          }
  
          const data = await apiRequest('/api/auth/status');
          if (!data.authenticated) {
              // 未登录，重定向到登录页面
              window.location.href = 'login.html';
          }
      } catch (error) {
          console.error('检查登录状态错误:', error);
          window.location.href = 'login.html';
      }
  }
  
  // 检查是否使用默认密码
  async function checkDefaultPasswordUsage() {
      try {
          // 从localStorage获取是否显示过默认密码提醒
          const hasShownDefaultPasswordWarning = localStorage.getItem('hasShownDefaultPasswordWarning');
          console.log('hasShownDefaultPasswordWarning:', hasShownDefaultPasswordWarning);
          if (hasShownDefaultPasswordWarning === 'true') {
              return; // 已经显示过提醒，不再显示
          }
  
          // 检查当前用户登录状态和默认密码使用情况
          const token = localStorage.getItem('auth_token');
          console.log('检查token:', token ? '存在' : '不存在');
          if (token) {
              try {
                  const statusData = await apiRequest('/api/auth/status');
                  console.log('状态数据:', statusData);
                  if (statusData.authenticated && statusData.user && statusData.user.usingDefaultPassword) {
                      console.log('检测到使用默认密码，显示提醒');
                      // 显示默认密码提醒，5秒自动消失
                      showAlert('warning',
                          '<i class="bi bi-exclamation-triangle-fill"></i> ' +
                          '<strong>安全提醒：</strong>您正在使用默认密码登录。' +
                          '<br>为了您的账户安全，建议尽快修改密码。' +
                          '<br><small>点击右上角的"修改密码"按钮来更改密码。</small>'
                      , 'serverAlert', 5000); // 5秒自动隐藏
  
                      // 标记已显示过提醒
                      localStorage.setItem('hasShownDefaultPasswordWarning', 'true');
                  } else {
                      console.log('未检测到使用默认密码');
                  }
              } catch (error) {
                  console.error('检查默认密码使用情况错误:', error);
              }
          }
      } catch (error) {
          console.error('检查默认密码使用情况错误:', error);
      }
  }
  
  // 初始化事件监听
  function initEventListeners() {
      // 添加服务器按钮
      document.getElementById('addServerBtn').addEventListener('click', function() {
          showServerModal();
      });
      
      // 保存服务器按钮
      document.getElementById('saveServerBtn').addEventListener('click', function() {
          saveServer();
      });
  
      // Helper function for copying text to clipboard and providing button feedback
      function copyToClipboard(textToCopy, buttonElement) {
          navigator.clipboard.writeText(textToCopy).then(() => {
              const originalHtml = buttonElement.innerHTML;
              buttonElement.innerHTML = '<i class="bi bi-check-lg"></i>'; // Using a larger check icon
              buttonElement.classList.add('btn-success');
              buttonElement.classList.remove('btn-outline-secondary');
              
              setTimeout(() => {
                  buttonElement.innerHTML = originalHtml;
                  buttonElement.classList.remove('btn-success');
                  buttonElement.classList.add('btn-outline-secondary');
              }, 2000);
          }).catch(err => {
              console.error('Failed to copy text: ', err);
              // Optionally, show an error message to the user
              const originalHtml = buttonElement.innerHTML;
              buttonElement.innerHTML = '<i class="bi bi-x-lg"></i>'; // Error icon
              buttonElement.classList.add('btn-danger');
              buttonElement.classList.remove('btn-outline-secondary');
              setTimeout(() => {
                  buttonElement.innerHTML = originalHtml;
                  buttonElement.classList.remove('btn-danger');
                  buttonElement.classList.add('btn-outline-secondary');
              }, 2000);
          });
      }
      
      // 复制API密钥按钮
      document.getElementById('copyApiKeyBtn').addEventListener('click', function() {
          const apiKeyInput = document.getElementById('apiKey');
          copyToClipboard(apiKeyInput.value, this);
      });
  
      // 复制服务器ID按钮
      document.getElementById('copyServerIdBtn').addEventListener('click', function() {
          const serverIdInput = document.getElementById('serverIdDisplay');
          copyToClipboard(serverIdInput.value, this);
      });
  
      // 复制Worker地址按钮
      document.getElementById('copyWorkerUrlBtn').addEventListener('click', function() {
          const workerUrlInput = document.getElementById('workerUrlDisplay');
          copyToClipboard(workerUrlInput.value, this);
      });
      
      // 确认删除按钮
      document.getElementById('confirmDeleteBtn').addEventListener('click', function() {
          if (currentServerId) {
              deleteServer(currentServerId);
          }
      });
      
      // 修改密码按钮（移动端）
      document.getElementById('changePasswordBtn').addEventListener('click', function() {
          showPasswordModal();
      });
  
      // 修改密码按钮（PC端）
      document.getElementById('changePasswordBtnDesktop').addEventListener('click', function() {
          showPasswordModal();
      });
      
      // 保存密码按钮
      document.getElementById('savePasswordBtn').addEventListener('click', function() {
          changePassword();
      });
      
      // 退出登录按钮
      document.getElementById('logoutBtn').addEventListener('click', function() {
          logout();
      });
  
      // --- Site Monitoring Event Listeners ---
      document.getElementById('addSiteBtn').addEventListener('click', function() {
          showSiteModal();
      });
  
      document.getElementById('saveSiteBtn').addEventListener('click', function() {
          saveSite();
      });
  
       document.getElementById('confirmDeleteSiteBtn').addEventListener('click', function() {
          if (currentSiteId) {
              deleteSite(currentSiteId);
          }
      });
  
      // 保存Telegram设置按钮
      document.getElementById('saveTelegramSettingsBtn').addEventListener('click', function() {
          saveTelegramSettings();
      });
  
      // Global Settings Event Listener
      document.getElementById('saveVpsReportIntervalBtn').addEventListener('click', function() {
          saveVpsReportInterval();
      });
  
      // 服务器模态框关闭事件监听器
      const serverModal = document.getElementById('serverModal');
      if (serverModal) {
          serverModal.addEventListener('hidden.bs.modal', function() {
              // 检查是否有新添加的服务器需要刷新列表
              if (hasAddedNewServer) {
                  hasAddedNewServer = false; // 重置标记
                  loadServerList(); // 刷新服务器列表
              }
          });
      }
  
      // 初始化排序下拉菜单默认选择
      setTimeout(() => {
          // 确保DOM已完全加载
          updateServerSortDropdownSelection('custom');
          updateSiteSortDropdownSelection('custom');
      }, 100);
  }
  
  // 获取认证头
  function getAuthHeaders() {
      const token = localStorage.getItem('auth_token');
      const headers = { 'Content-Type': 'application/json' };
      if (token) {
          headers['Authorization'] = 'Bearer ' + token;
      }
      return headers;
  }
  
  // --- Server Management Functions ---
  
  // 加载服务器列表
  async function loadServerList() {
      try {
          const data = await apiRequest('/api/admin/servers');
          serverList = data.servers || [];
  
          // 简化逻辑：直接渲染，智能状态显示会处理更新中的按钮
          renderServerTable(serverList);
      } catch (error) {
          console.error('加载服务器列表错误:', error);
          showAlert('danger', '加载服务器列表失败，请刷新页面重试。', 'serverAlert');
      }
  }
  
  // 渲染服务器表格
  function renderServerTable(servers) {
      const tableBody = document.getElementById('serverTableBody');
  
      // 简化状态管理：不再需要复杂的状态保存机制
  
      tableBody.innerHTML = '';
  
      if (servers.length === 0) {
          const row = document.createElement('tr');
          row.innerHTML = '<td colspan="10" class="text-center">暂无服务器数据</td>'; // Updated colspan
          tableBody.appendChild(row);
          // 同时更新移动端卡片
          renderMobileAdminServerCards([]);
          return;
      }
  
      servers.forEach((server, index) => {
          const row = document.createElement('tr');
          row.setAttribute('data-server-id', server.id);
          row.classList.add('server-row-draggable');
          row.draggable = true;
  
          // 格式化最后更新时间
          let lastUpdateText = '从未';
          let statusBadge = '<span class="badge bg-secondary">未知</span>';
  
          if (server.last_report) {
              const lastUpdate = new Date(server.last_report * 1000);
              lastUpdateText = lastUpdate.toLocaleString();
  
              // 检查是否在线（最后报告时间在5分钟内）
              const now = new Date();
              const diffMinutes = (now - lastUpdate) / (1000 * 60);
  
              if (diffMinutes <= 5) {
                  statusBadge = '<span class="badge bg-success">在线</span>';
              } else {
                  statusBadge = '<span class="badge bg-danger">离线</span>';
              }
          }
  
          // 智能状态显示：完整保存更新中按钮的所有状态
          const existingToggle = document.querySelector('.server-visibility-toggle[data-server-id="' + server.id + '"]');
          const isCurrentlyUpdating = existingToggle && existingToggle.dataset.updating === 'true';
          const displayState = isCurrentlyUpdating ? existingToggle.checked : server.is_public;
          const needsUpdatingState = isCurrentlyUpdating;
  
          row.innerHTML =
              '<td>' +
                  '<div class="btn-group">' +
                      '<i class="bi bi-grip-vertical text-muted me-2" style="cursor: grab;" title="拖拽排序"></i>' +
                       '<button class="btn btn-sm btn-outline-secondary move-server-btn" data-id="' + server.id + '" data-direction="up" ' + (index === 0 ? 'disabled' : '') + '>' +
                          '<i class="bi bi-arrow-up"></i>' +
                      '</button>' +
                       '<button class="btn btn-sm btn-outline-secondary move-server-btn" data-id="' + server.id + '" data-direction="down" ' + (index === servers.length - 1 ? 'disabled' : '') + '>' +
                          '<i class="bi bi-arrow-down"></i>' +
                      '</button>' +
                  '</div>' +
              '</td>' +
              '<td>' + server.id + '</td>' +
              '<td>' + server.name + '</td>' +
              '<td>' + (server.description || '-') + '</td>' +
              '<td>' + statusBadge + '</td>' +
              '<td>' + lastUpdateText + '</td>' +
              '<td>' +
                  '<button class="btn btn-sm btn-outline-secondary view-key-btn" data-id="' + server.id + '">' +
                      '<i class="bi bi-key"></i> 查看密钥' +
                  '</button>' +
              '</td>' +
              '<td>' +
                  '<button class="btn btn-sm btn-outline-info copy-vps-script-btn" data-id="' + server.id + '" data-name="' + server.name + '" title="复制VPS安装脚本">' +
                      '<i class="bi bi-clipboard-plus"></i> 复制脚本' +
                  '</button>' +
              '</td>' +
              '<td>' +
                  '<div class="form-check form-switch">' +
                      '<input class="form-check-input server-visibility-toggle" type="checkbox" data-server-id="' + server.id + '" ' + (displayState ? 'checked' : '') + (needsUpdatingState ? ' data-updating="true"' : '') + '>' +
                  '</div>' +
              '</td>' +
              '<td>' +
                  '<div class="btn-group">' +
                      '<button class="btn btn-sm btn-outline-primary edit-server-btn" data-id="' + server.id + '">' +
                          '<i class="bi bi-pencil"></i>' +
                      '</button>' +
                      '<button class="btn btn-sm btn-outline-danger delete-server-btn" data-id="' + server.id + '" data-name="' + server.name + '">' +
                          '<i class="bi bi-trash"></i>' +
                      '</button>' +
                  '</div>' +
              '</td>';
  
          tableBody.appendChild(row);
      });
  
      // 初始化拖拽排序
      initializeServerDragSort();
      
      // 添加事件监听
      document.querySelectorAll('.view-key-btn').forEach(btn => {
          btn.addEventListener('click', function() {
              const serverId = this.getAttribute('data-id');
              viewApiKey(serverId);
          });
      });
      
      document.querySelectorAll('.edit-server-btn').forEach(btn => {
          btn.addEventListener('click', function() {
              const serverId = this.getAttribute('data-id');
              editServer(serverId);
          });
      });
      
      document.querySelectorAll('.delete-server-btn').forEach(btn => {
          btn.addEventListener('click', function() {
              const serverId = this.getAttribute('data-id');
              const serverName = this.getAttribute('data-name');
              showDeleteConfirmation(serverId, serverName);
          });
      });
  
      document.querySelectorAll('.move-server-btn').forEach(btn => {
          btn.addEventListener('click', function() {
              const serverId = this.getAttribute('data-id');
              const direction = this.getAttribute('data-direction');
              moveServer(serverId, direction);
          });
      });
  
      document.querySelectorAll('.copy-vps-script-btn').forEach(btn => {
          btn.addEventListener('click', function() {
              const serverId = this.getAttribute('data-id');
              const serverName = this.getAttribute('data-name');
              copyVpsInstallScript(serverId, serverName, this);
          });
      });
  
      // 优化的显示开关事件监听 - 直接处理状态切换
      document.querySelectorAll('.server-visibility-toggle').forEach(toggle => {
          toggle.addEventListener('click', function(event) {
              // 如果开关正在更新中，忽略点击
              if (this.disabled || this.dataset.updating === 'true') {
                  event.preventDefault();
                  return;
              }
  
              const serverId = this.getAttribute('data-server-id');
              const targetState = this.checked; // 点击后的状态就是目标状态
              const originalState = !this.checked; // 原始状态是目标状态的相反
  
              console.log('用户点击开关，服务器:', serverId, '原始状态:', originalState, '目标状态:', targetState);
  
              // 立即设置为加载状态
              this.disabled = true;
              this.style.opacity = '0.6';
              this.dataset.updating = 'true';
  
              updateServerVisibility(serverId, targetState, originalState, this);
          });
      });
  
      // 重新应用正在更新按钮的视觉状态（因为重新渲染会创建新元素）
      document.querySelectorAll('.server-visibility-toggle[data-updating="true"]').forEach(toggle => {
          toggle.disabled = true;
          toggle.style.opacity = '0.6';
      });
  
      // 同时渲染移动端卡片
      renderMobileAdminServerCards(servers);
  }
  
  // 初始化服务器拖拽排序
  function initializeServerDragSort() {
      const tableBody = document.getElementById('serverTableBody');
      if (!tableBody) return;
  
      let draggedElement = null;
      let draggedOverElement = null;
  
      // 为所有可拖拽行添加事件监听
      const draggableRows = tableBody.querySelectorAll('.server-row-draggable');
  
      draggableRows.forEach(row => {
          row.addEventListener('dragstart', function(e) {
              draggedElement = this;
              this.style.opacity = '0.5';
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/html', this.outerHTML);
          });
  
          row.addEventListener('dragend', function(e) {
              this.style.opacity = '';
              draggedElement = null;
              draggedOverElement = null;
  
              // 移除所有拖拽样式
              draggableRows.forEach(r => {
                  r.classList.remove('drag-over-top', 'drag-over-bottom');
              });
          });
  
          row.addEventListener('dragover', function(e) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
  
              if (this === draggedElement) return;
  
              draggedOverElement = this;
  
              // 移除其他行的拖拽样式
              draggableRows.forEach(r => {
                  if (r !== this) {
                      r.classList.remove('drag-over-top', 'drag-over-bottom');
                  }
              });
  
              // 确定插入位置
              const rect = this.getBoundingClientRect();
              const midpoint = rect.top + rect.height / 2;
  
              if (e.clientY < midpoint) {
                  this.classList.add('drag-over-top');
                  this.classList.remove('drag-over-bottom');
              } else {
                  this.classList.add('drag-over-bottom');
                  this.classList.remove('drag-over-top');
              }
          });
  
          row.addEventListener('drop', function(e) {
              e.preventDefault();
  
              if (this === draggedElement) return;
  
              const draggedServerId = draggedElement.getAttribute('data-server-id');
              const targetServerId = this.getAttribute('data-server-id');
  
              // 确定插入位置
              const rect = this.getBoundingClientRect();
              const midpoint = rect.top + rect.height / 2;
              const insertBefore = e.clientY < midpoint;
  
              // 执行拖拽排序
              performServerDragSort(draggedServerId, targetServerId, insertBefore);
          });
      });
  }
  
  // 执行服务器拖拽排序
  async function performServerDragSort(draggedServerId, targetServerId, insertBefore) {
      try {
          // 获取当前服务器列表的ID顺序
          const currentOrder = serverList.map(server => server.id);
  
          // 计算新的排序
          const draggedIndex = currentOrder.indexOf(draggedServerId);
          const targetIndex = currentOrder.indexOf(targetServerId);
  
          if (draggedIndex === -1 || targetIndex === -1) {
              throw new Error('无法找到服务器');
          }
  
          // 创建新的排序数组
          const newOrder = [...currentOrder];
          newOrder.splice(draggedIndex, 1); // 移除拖拽的元素
  
          // 计算插入位置
          let insertIndex = targetIndex;
          if (draggedIndex < targetIndex) {
              insertIndex = targetIndex - 1;
          }
          if (!insertBefore) {
              insertIndex += 1;
          }
  
          newOrder.splice(insertIndex, 0, draggedServerId); // 插入到新位置
  
          // 发送批量排序请求
          await apiRequest('/api/admin/servers/batch-reorder', {
              method: 'POST',
              body: JSON.stringify({ serverIds: newOrder })
          });
  
          // 重新加载服务器列表
          await loadServerList();
          showAlert('success', '服务器排序已更新', 'serverAlert');
  
      } catch (error) {
          console.error('拖拽排序错误:', error);
          showAlert('danger', '拖拽排序失败: ' + error.message, 'serverAlert');
          // 重新加载以恢复原始状态
          loadServerList();
      }
  }
  
  
  // Function to copy VPS installation script
  async function copyVpsInstallScript(serverId, serverName, buttonElement) {
      const originalButtonHtml = buttonElement.innerHTML;
      buttonElement.disabled = true;
      buttonElement.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 生成中...';
  
      try {
          // 直接从本地缓存的服务器列表中获取API密钥，避免API调用
          const server = serverList.find(s => s.id === serverId);
          if (!server || !server.api_key) {
              throw new Error('未找到服务器或API密钥，请刷新页面重试');
          }
  
          const apiKey = server.api_key;
          const workerUrl = window.location.origin;
  
          // 使用GitHub上的脚本地址
          const baseScriptUrl = "https://raw.githubusercontent.com/kadidalax/cf-vps-monitor/main/cf-vps-monitor.sh";
          // 生成安装命令（让脚本自动从服务器获取上报间隔）
          const scriptCommand = 'wget ' + baseScriptUrl + ' -O cf-vps-monitor.sh && chmod +x cf-vps-monitor.sh && ./cf-vps-monitor.sh -i -k ' + apiKey + ' -s ' + serverId + ' -u ' + workerUrl;
  
          await navigator.clipboard.writeText(scriptCommand);
  
          buttonElement.innerHTML = '<i class="bi bi-check-lg"></i> 已复制!';
          buttonElement.classList.remove('btn-outline-info');
          buttonElement.classList.add('btn-success');
  
          showAlert('success', '服务器 "' + serverName + '" 的安装脚本已复制到剪贴板。', 'serverAlert');
  
      } catch (error) {
          console.error('复制VPS安装脚本错误:', error);
          showAlert('danger', '复制脚本失败: ' + error.message, 'serverAlert');
          buttonElement.innerHTML = '<i class="bi bi-x-lg"></i> 复制失败';
          buttonElement.classList.remove('btn-outline-info');
          buttonElement.classList.add('btn-danger');
      } finally {
          setTimeout(() => {
              buttonElement.disabled = false;
              buttonElement.innerHTML = originalButtonHtml;
              buttonElement.classList.remove('btn-success', 'btn-danger');
              buttonElement.classList.add('btn-outline-info');
          }, 3000); // Revert button state after 3 seconds
      }
  }
  
  // 更新服务器显示状态
  async function updateServerVisibility(serverId, isPublic, originalState, toggleElement) {
      const startTime = Date.now();
      console.log('API请求开始：服务器', serverId, '从', originalState, '切换到', isPublic, '时间:', new Date().toISOString());
  
      try {
          const data = await apiRequest('/api/admin/servers/' + serverId + '/visibility', {
              method: 'POST',
              body: JSON.stringify({ is_public: isPublic })
          });
  
          const requestTime = Date.now() - startTime;
          console.log('API成功：服务器', serverId, '最终状态', isPublic);
  
          // 更新本地数据
          const serverIndex = serverList.findIndex(s => s.id === serverId);
          if (serverIndex !== -1) {
              serverList[serverIndex].is_public = isPublic;
          }
  
          // 成功后设置最终正常状态 - 使用可靠的恢复机制
          function restoreButtonState(retryCount = 0) {
              const currentToggle = document.querySelector('.server-visibility-toggle[data-server-id="' + serverId + '"]');
              if (currentToggle) {
                  console.log('API成功，恢复按钮状态：', serverId, '目标状态:', isPublic, '重试次数:', retryCount);
                  currentToggle.checked = isPublic;
                  currentToggle.style.opacity = '1';
                  currentToggle.disabled = false;
                  delete currentToggle.dataset.updating;
  
                  // 直接显示成功提醒
                  showAlert('success', '服务器显示状态已' + (isPublic ? '开启' : '关闭'), 'serverAlert');
              } else if (retryCount < 3) {
                  console.log('按钮元素未找到，100ms后重试：', serverId, '重试次数:', retryCount);
                  setTimeout(() => restoreButtonState(retryCount + 1), 100);
              } else {
                  console.error('API成功但多次重试后仍找不到按钮元素：', serverId);
              }
          }
  
          // 立即尝试恢复，如果失败则重试
          restoreButtonState();
  
      } catch (error) {
          console.error('API失败：服务器', serverId, '错误:', error);
  
          // 失败时恢复原始状态
          const currentToggle = document.querySelector('.server-visibility-toggle[data-server-id="' + serverId + '"]');
          if (currentToggle) {
              currentToggle.checked = originalState;
              currentToggle.style.opacity = '1';
              currentToggle.disabled = false;
              delete currentToggle.dataset.updating;
  
              // 直接显示错误提醒，不需要等待状态变化
              showAlert('danger', '更新显示状态失败: ' + error.message, 'serverAlert');
          } else {
              // 如果找不到开关元素，立即显示错误
              showAlert('danger', '更新显示状态失败: ' + error.message, 'serverAlert');
          }
      }
  }
  
  // 移动服务器顺序
  async function moveServer(serverId, direction) {
      try {
          await apiRequest('/api/admin/servers/' + serverId + '/reorder', {
              method: 'POST',
              body: JSON.stringify({ direction })
          });
  
          // 重新加载列表以反映新顺序
          await loadServerList();
          showAlert('success', '服务器已成功' + (direction === 'up' ? '上移' : '下移'));
  
      } catch (error) {
          console.error('移动服务器错误:', error);
          showAlert('danger', '移动服务器失败: ' + error.message, 'serverAlert');
      }
  }
  
  // 显示服务器模态框（添加模式）
  function showServerModal() {
      // 重置表单和标记
      document.getElementById('serverForm').reset();
      document.getElementById('serverId').value = '';
      document.getElementById('apiKeyGroup').classList.add('d-none');
      document.getElementById('serverIdDisplayGroup').classList.add('d-none');
      document.getElementById('workerUrlDisplayGroup').classList.add('d-none');
      hasAddedNewServer = false; // 重置新服务器标记
  
      // 设置模态框标题
      document.getElementById('serverModalTitle').textContent = '添加服务器';
  
      // 显示模态框
      const serverModal = new bootstrap.Modal(document.getElementById('serverModal'));
      serverModal.show();
  }
  
  // 编辑服务器
  function editServer(serverId) {
      const server = serverList.find(s => s.id === serverId);
      if (!server) return;
      
      // 填充表单
      document.getElementById('serverId').value = server.id;
      document.getElementById('serverName').value = server.name;
      document.getElementById('serverDescription').value = server.description || '';
      document.getElementById('apiKeyGroup').classList.add('d-none');
      document.getElementById('serverIdDisplayGroup').classList.add('d-none');
      document.getElementById('workerUrlDisplayGroup').classList.add('d-none');
      
      // 设置模态框标题
      document.getElementById('serverModalTitle').textContent = '编辑服务器';
      
      // 显示模态框
      const serverModal = new bootstrap.Modal(document.getElementById('serverModal'));
      serverModal.show();
  }
  
  // 保存服务器
  async function saveServer() {
      const serverId = document.getElementById('serverId').value;
      const serverName = document.getElementById('serverName').value.trim();
      const serverDescription = document.getElementById('serverDescription').value.trim();
      // const enableFrequentNotifications = document.getElementById('serverEnableFrequentNotifications').checked; // Removed
      
      if (!serverName) {
          showAlert('danger', '服务器名称不能为空', 'serverAlert'); // Added alertId
          return;
      }
      
      try {
          let data;
  
          if (serverId) {
              // 更新服务器
              data = await apiRequest('/api/admin/servers/' + serverId, {
                  method: 'PUT',
                  body: JSON.stringify({
                      name: serverName,
                      description: serverDescription
                  })
              });
          } else {
              // 添加服务器
              data = await apiRequest('/api/admin/servers', {
                  method: 'POST',
                  body: JSON.stringify({
                      name: serverName,
                      description: serverDescription
                  })
              });
          }
  
          // 如果是新添加的服务器，流畅地切换到密钥显示（不隐藏模态框）
          if (!serverId && data.server && data.server.api_key) {
              hasAddedNewServer = true; // 标记已添加新服务器
  
              // 直接在当前模态框中显示密钥信息，提供流畅的用户体验
              // 不隐藏模态框，而是切换内容，让用户感觉是自然的过渡
              showApiKeyInCurrentModal(data.server);
              showAlert('success', '服务器添加成功');
  
              // 在后台异步刷新服务器列表
              loadServerList().catch(error => {
                  console.error('后台刷新服务器列表失败:', error);
              });
          } else {
              // 编辑服务器的情况，正常隐藏模态框并刷新列表
              const serverModal = bootstrap.Modal.getInstance(document.getElementById('serverModal'));
              serverModal.hide();
  
              await loadServerList();
              showAlert('success', serverId ? '服务器更新成功' : '服务器添加成功');
          }
      } catch (error) {
          console.error('保存服务器错误:', error);
          showAlert('danger', '保存服务器失败，请稍后重试', 'serverAlert');
      }
  }
  
  // 查看API密钥（优化版本：直接从本地缓存获取）
  function viewApiKey(serverId) {
      try {
          // 直接从本地缓存的服务器列表中获取服务器信息
          const server = serverList.find(s => s.id === serverId);
          if (server && server.api_key) {
              showApiKey(server);
          } else {
              showAlert('danger', '未找到服务器信息或API密钥，请刷新页面重试', 'serverAlert');
          }
      } catch (error) {
          console.error('查看API密钥错误:', error);
          showAlert('danger', '查看API密钥失败，请稍后重试', 'serverAlert');
      }
  }
  
  // 在当前模态框中显示API密钥（用于添加服务器后的流畅过渡）
  function showApiKeyInCurrentModal(server) {
      // 填充表单数据
      document.getElementById('serverId').value = server.id;
      document.getElementById('serverName').value = server.name;
      document.getElementById('serverDescription').value = server.description || '';
  
      // 显示API密钥、服务器ID和Worker URL
      document.getElementById('apiKey').value = server.api_key;
      document.getElementById('apiKeyGroup').classList.remove('d-none');
  
      document.getElementById('serverIdDisplay').value = server.id;
      document.getElementById('serverIdDisplayGroup').classList.remove('d-none');
  
      document.getElementById('workerUrlDisplay').value = window.location.origin;
      document.getElementById('workerUrlDisplayGroup').classList.remove('d-none');
  
      // 更新模态框标题
      document.getElementById('serverModalTitle').textContent = '服务器详细信息与密钥';
  
      // 注意：不创建新的模态框，而是在当前模态框中切换内容
      // 这样用户感觉是自然的内容过渡，而不是突然弹出新窗口
  }
  
  // 显示API密钥（用于查看密钥按钮）
  function showApiKey(server) {
      // 填充表单
      document.getElementById('serverId').value = server.id; // Hidden input for form submission if needed
      document.getElementById('serverName').value = server.name;
      document.getElementById('serverDescription').value = server.description || '';
  
      // Populate and show API Key, Server ID, and Worker URL
      document.getElementById('apiKey').value = server.api_key;
      document.getElementById('apiKeyGroup').classList.remove('d-none');
  
      document.getElementById('serverIdDisplay').value = server.id;
      document.getElementById('serverIdDisplayGroup').classList.remove('d-none');
  
      document.getElementById('workerUrlDisplay').value = window.location.origin;
      document.getElementById('workerUrlDisplayGroup').classList.remove('d-none');
  
      // 设置模态框标题
      document.getElementById('serverModalTitle').textContent = '服务器详细信息与密钥';
  
      // 显示模态框
      const serverModal = new bootstrap.Modal(document.getElementById('serverModal'));
      serverModal.show();
  }
  
  // 显示删除确认
  function showDeleteConfirmation(serverId, serverName) {
      currentServerId = serverId;
      document.getElementById('deleteServerName').textContent = serverName;
      
      const deleteModal = new bootstrap.Modal(document.getElementById('deleteModal'));
      deleteModal.show();
  }
  
  // 删除服务器
  async function deleteServer(serverId) {
      try {
          await apiRequest('/api/admin/servers/' + serverId, {
              method: 'DELETE'
          });
  
          // 隐藏模态框
          const deleteModal = bootstrap.Modal.getInstance(document.getElementById('deleteModal'));
          deleteModal.hide();
  
          // 重新加载服务器列表
          loadServerList();
          showAlert('success', '服务器删除成功');
      } catch (error) {
          console.error('删除服务器错误:', error);
          showAlert('danger', '删除服务器失败，请稍后重试', 'serverAlert');
      }
  }
  
  
  // --- Site Monitoring Functions (Continued) ---
  
  // 更新网站显示状态
  async function updateSiteVisibility(siteId, isPublic, originalState, toggleElement) {
      const startTime = Date.now();
      console.log('API请求开始：网站', siteId, '从', originalState, '切换到', isPublic, '时间:', new Date().toISOString());
  
      try {
          await apiRequest('/api/admin/sites/' + siteId + '/visibility', {
              method: 'POST',
              body: JSON.stringify({ is_public: isPublic })
          });
  
          const requestTime = Date.now() - startTime;
          console.log('API请求完成：网站', siteId, '耗时:', requestTime + 'ms');
  
          console.log('API成功：网站', siteId, '最终状态', isPublic);
  
          // 更新本地数据
          const siteIndex = siteList.findIndex(s => s.id === siteId);
          if (siteIndex !== -1) {
              siteList[siteIndex].is_public = isPublic;
          }
  
          // 成功后设置最终正常状态 - 使用可靠的恢复机制
          function restoreButtonState(retryCount = 0) {
              const currentToggle = document.querySelector('.site-visibility-toggle[data-site-id="' + siteId + '"]');
              if (currentToggle) {
                  console.log('API成功，恢复网站按钮状态：', siteId, '目标状态:', isPublic, '重试次数:', retryCount);
                  currentToggle.checked = isPublic;
                  currentToggle.style.opacity = '1';
                  currentToggle.disabled = false;
                  delete currentToggle.dataset.updating;
  
                  // 直接显示成功提醒
                  showAlert('success', '网站显示状态已' + (isPublic ? '开启' : '关闭'), 'siteAlert');
              } else if (retryCount < 3) {
                  console.log('网站按钮元素未找到，100ms后重试：', siteId, '重试次数:', retryCount);
                  setTimeout(() => restoreButtonState(retryCount + 1), 100);
              } else {
                  console.error('API成功但多次重试后仍找不到网站按钮元素：', siteId);
              }
          }
  
          // 立即尝试恢复，如果失败则重试
          restoreButtonState();
  
      } catch (error) {
          console.error('API失败：网站', siteId, '错误:', error);
  
          // 失败时恢复原始状态
          const currentToggle = document.querySelector('.site-visibility-toggle[data-site-id="' + siteId + '"]');
          if (currentToggle) {
              currentToggle.checked = originalState;
              currentToggle.style.opacity = '1';
              currentToggle.disabled = false;
              delete currentToggle.dataset.updating;
  
              // 直接显示错误提醒，不需要等待状态变化
              showAlert('danger', '更新显示状态失败: ' + error.message, 'siteAlert');
          } else {
              // 如果找不到开关元素，立即显示错误
              showAlert('danger', '更新显示状态失败: ' + error.message, 'siteAlert');
          }
      }
  }
  
  // 移动网站顺序
  async function moveSite(siteId, direction) {
      try {
          await apiRequest('/api/admin/sites/' + siteId + '/reorder', {
              method: 'POST',
              body: JSON.stringify({ direction })
          });
  
          // 重新加载列表以反映新顺序
          await loadSiteList();
          showAlert('success', '网站已成功' + (direction === 'up' ? '上移' : '下移'), 'siteAlert');
  
      } catch (error) {
          console.error('移动网站错误:', error);
          showAlert('danger', '移动网站失败: ' + error.message, 'siteAlert');
      }
  }
  
  
  // --- Password Management Functions ---
  
  // 显示密码修改模态框
  function showPasswordModal() {
      // 重置表单
      document.getElementById('passwordForm').reset();
      document.getElementById('passwordAlert').classList.add('d-none');
      
      const passwordModal = new bootstrap.Modal(document.getElementById('passwordModal'));
      passwordModal.show();
  }
  
  // 修改密码
  async function changePassword() {
      const currentPassword = document.getElementById('currentPassword').value;
      const newPassword = document.getElementById('newPassword').value;
      const confirmPassword = document.getElementById('confirmPassword').value;
      
      // 验证输入
      if (!currentPassword || !newPassword || !confirmPassword) {
          showPasswordAlert('danger', '所有密码字段都必须填写');
          return;
      }
      
      if (newPassword !== confirmPassword) {
          showPasswordAlert('danger', '新密码和确认密码不匹配');
          return;
      }
      
      try {
          await apiRequest('/api/auth/change-password', {
              method: 'POST',
              body: JSON.stringify({
                  current_password: currentPassword,
                  new_password: newPassword
              })
          });
  
          // 隐藏模态框
          const passwordModal = bootstrap.Modal.getInstance(document.getElementById('passwordModal'));
          passwordModal.hide();
  
          // 清除默认密码提醒标记，这样如果用户再次使用默认密码登录会重新提醒
          localStorage.removeItem('hasShownDefaultPasswordWarning');
  
          showAlert('success', '密码修改成功', 'serverAlert'); // Use main alert
      } catch (error) {
          console.error('修改密码错误:', error);
          showPasswordAlert('danger', '密码修改请求失败，请稍后重试');
      }
  }
  
  
  // --- Auth Functions ---
  
  // 退出登录
  function logout() {
      // 清除localStorage中的token和提醒标记
      localStorage.removeItem('auth_token');
      localStorage.removeItem('hasShownDefaultPasswordWarning');
  
      // 重定向到登录页面
      window.location.href = 'login.html';
  }
  
  
  // --- Site Monitoring Functions ---
  
  // 加载监控网站列表
  async function loadSiteList() {
      try {
          const data = await apiRequest('/api/admin/sites');
          siteList = data.sites || [];
  
          // 简化逻辑：直接渲染，智能状态显示会处理更新中的按钮
          renderSiteTable(siteList);
      } catch (error) {
          console.error('加载监控网站列表错误:', error);
          showAlert('danger', '加载监控网站列表失败: ' + error.message, 'siteAlert');
      }
  }
  
  // 渲染监控网站表格
  function renderSiteTable(sites) {
      const tableBody = document.getElementById('siteTableBody');
  
      // 简化状态管理：不再需要复杂的状态保存机制
  
      tableBody.innerHTML = '';
  
      if (sites.length === 0) {
          tableBody.innerHTML = '<tr><td colspan="9" class="text-center">暂无监控网站</td></tr>'; // Colspan updated
          // 同时更新移动端卡片
          renderMobileAdminSiteCards([]);
          return;
      }
  
      sites.forEach((site, index) => { // Added index for sorting buttons
          const row = document.createElement('tr');
          row.setAttribute('data-site-id', site.id);
          row.classList.add('site-row-draggable');
          row.draggable = true;
  
          const statusInfo = getSiteStatusBadge(site.last_status);
          const lastCheckTime = site.last_checked ? new Date(site.last_checked * 1000).toLocaleString() : '从未';
          const responseTime = site.last_response_time_ms !== null ? \`\${site.last_response_time_ms} ms\` : '-';
  
          // 智能状态显示：完整保存更新中按钮的所有状态
          const existingToggle = document.querySelector('.site-visibility-toggle[data-site-id="' + site.id + '"]');
          const isCurrentlyUpdating = existingToggle && existingToggle.dataset.updating === 'true';
          const displayState = isCurrentlyUpdating ? existingToggle.checked : site.is_public;
          const needsUpdatingState = isCurrentlyUpdating;
  
          row.innerHTML = \`
               <td>
                  <div class="btn-group btn-group-sm">
                      <i class="bi bi-grip-vertical text-muted me-2" style="cursor: grab;" title="拖拽排序"></i>
                       <button class="btn btn-outline-secondary move-site-btn" data-id="\${site.id}" data-direction="up" \${index === 0 ? 'disabled' : ''} title="上移">
                          <i class="bi bi-arrow-up"></i>
                      </button>
                       <button class="btn btn-outline-secondary move-site-btn" data-id="\${site.id}" data-direction="down" \${index === sites.length - 1 ? 'disabled' : ''} title="下移">
                          <i class="bi bi-arrow-down"></i>
                      </button>
                  </div>
              </td>
              <td>\${site.name || '-'}</td>
              <td><a href="\${site.url}" target="_blank" rel="noopener noreferrer">\${site.url}</a></td>
              <td><span class="badge \${statusInfo.class}">\${statusInfo.text}</span></td>
              <td>\${site.last_status_code || '-'}</td>
              <td>\${responseTime}</td>
              <td>\${lastCheckTime}</td>
              <td>
                  <div class="form-check form-switch">
                      <input class="form-check-input site-visibility-toggle" type="checkbox" data-site-id="\${site.id}" \${displayState ? 'checked' : ''}\${needsUpdatingState ? ' data-updating="true"' : ''}>
                  </div>
              </td>
              <td>
                  <div class="btn-group">
                      <button class="btn btn-sm btn-outline-primary edit-site-btn" data-id="\${site.id}" title="编辑">
                          <i class="bi bi-pencil"></i>
                      </button>
                      <button class="btn btn-sm btn-outline-danger delete-site-btn" data-id="\${site.id}" data-name="\${site.name || site.url}" data-url="\${site.url}" title="删除">
                          <i class="bi bi-trash"></i>
                      </button>
                  </div>
              </td>
          \`;
          tableBody.appendChild(row);
      });
  
      // 初始化拖拽排序
      initializeSiteDragSort();
  
      // Add event listeners for edit and delete buttons
      document.querySelectorAll('.edit-site-btn').forEach(btn => {
          btn.addEventListener('click', function() {
              const siteId = this.getAttribute('data-id');
              editSite(siteId);
          });
      });
  
      document.querySelectorAll('.delete-site-btn').forEach(btn => {
          btn.addEventListener('click', function() {
              const siteId = this.getAttribute('data-id');
              const siteName = this.getAttribute('data-name');
              const siteUrl = this.getAttribute('data-url');
              showDeleteSiteConfirmation(siteId, siteName, siteUrl);
          });
      });
  
      // Add event listeners for move buttons
      document.querySelectorAll('.move-site-btn').forEach(btn => {
          btn.addEventListener('click', function() {
              const siteId = this.getAttribute('data-id');
              const direction = this.getAttribute('data-direction');
              moveSite(siteId, direction);
          });
      });
  
      // 优化的网站显示开关事件监听 - 直接处理状态切换
      document.querySelectorAll('.site-visibility-toggle').forEach(toggle => {
          toggle.addEventListener('click', function(event) {
              // 如果开关正在更新中，忽略点击
              if (this.disabled || this.dataset.updating === 'true') {
                  event.preventDefault();
                  return;
              }
  
              const siteId = this.getAttribute('data-site-id');
              const targetState = this.checked; // 点击后的状态就是目标状态
              const originalState = !this.checked; // 原始状态是目标状态的相反
  
              console.log('用户点击开关，网站:', siteId, '原始状态:', originalState, '目标状态:', targetState);
  
              // 立即设置为加载状态
              this.disabled = true;
              this.style.opacity = '0.6';
              this.dataset.updating = 'true';
  
              updateSiteVisibility(siteId, targetState, originalState, this);
          });
      });
  
      // 重新应用正在更新按钮的视觉状态（因为重新渲染会创建新元素）
      document.querySelectorAll('.site-visibility-toggle[data-updating="true"]').forEach(toggle => {
          toggle.disabled = true;
          toggle.style.opacity = '0.6';
      });
  
      // 同时渲染移动端卡片
      renderMobileAdminSiteCards(sites);
  }
  
  // 初始化网站拖拽排序
  function initializeSiteDragSort() {
      const tableBody = document.getElementById('siteTableBody');
      if (!tableBody) return;
  
      let draggedElement = null;
      let draggedOverElement = null;
  
      // 为所有可拖拽行添加事件监听
      const draggableRows = tableBody.querySelectorAll('.site-row-draggable');
  
      draggableRows.forEach(row => {
          row.addEventListener('dragstart', function(e) {
              draggedElement = this;
              this.style.opacity = '0.5';
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/html', this.outerHTML);
          });
  
          row.addEventListener('dragend', function(e) {
              this.style.opacity = '';
              draggedElement = null;
              draggedOverElement = null;
  
              // 移除所有拖拽样式
              draggableRows.forEach(r => {
                  r.classList.remove('drag-over-top', 'drag-over-bottom');
              });
          });
  
          row.addEventListener('dragover', function(e) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
  
              if (this === draggedElement) return;
  
              draggedOverElement = this;
  
              // 移除其他行的拖拽样式
              draggableRows.forEach(r => {
                  if (r !== this) {
                      r.classList.remove('drag-over-top', 'drag-over-bottom');
                  }
              });
  
              // 确定插入位置
              const rect = this.getBoundingClientRect();
              const midpoint = rect.top + rect.height / 2;
  
              if (e.clientY < midpoint) {
                  this.classList.add('drag-over-top');
                  this.classList.remove('drag-over-bottom');
              } else {
                  this.classList.add('drag-over-bottom');
                  this.classList.remove('drag-over-top');
              }
          });
  
          row.addEventListener('drop', function(e) {
              e.preventDefault();
  
              if (this === draggedElement) return;
  
              const draggedSiteId = draggedElement.getAttribute('data-site-id');
              const targetSiteId = this.getAttribute('data-site-id');
  
              // 确定插入位置
              const rect = this.getBoundingClientRect();
              const midpoint = rect.top + rect.height / 2;
              const insertBefore = e.clientY < midpoint;
  
              // 执行拖拽排序
              performSiteDragSort(draggedSiteId, targetSiteId, insertBefore);
          });
      });
  }
  
  // 执行网站拖拽排序
  async function performSiteDragSort(draggedSiteId, targetSiteId, insertBefore) {
      try {
          // 获取当前网站列表的ID顺序
          const currentOrder = siteList.map(site => site.id);
  
          // 计算新的排序
          const draggedIndex = currentOrder.indexOf(draggedSiteId);
          const targetIndex = currentOrder.indexOf(targetSiteId);
  
          if (draggedIndex === -1 || targetIndex === -1) {
              throw new Error('无法找到网站');
          }
  
          // 创建新的排序数组
          const newOrder = [...currentOrder];
          newOrder.splice(draggedIndex, 1); // 移除拖拽的元素
  
          // 计算插入位置
          let insertIndex = targetIndex;
          if (draggedIndex < targetIndex) {
              insertIndex = targetIndex - 1;
          }
          if (!insertBefore) {
              insertIndex += 1;
          }
  
          newOrder.splice(insertIndex, 0, draggedSiteId); // 插入到新位置
  
          // 发送批量排序请求
          await apiRequest('/api/admin/sites/batch-reorder', {
              method: 'POST',
              body: JSON.stringify({ siteIds: newOrder })
          });
  
          // 重新加载网站列表
          await loadSiteList();
          showAlert('success', '网站排序已更新', 'siteAlert');
  
      } catch (error) {
          console.error('拖拽排序错误:', error);
          showAlert('danger', '拖拽排序失败: ' + error.message, 'siteAlert');
          // 重新加载以恢复原始状态
          loadSiteList();
      }
  }
  
  // 获取网站状态对应的Badge样式和文本
  function getSiteStatusBadge(status) {
      switch (status) {
          case 'UP': return { class: 'bg-success', text: '正常' };
          case 'DOWN': return { class: 'bg-danger', text: '故障' };
          case 'TIMEOUT': return { class: 'bg-warning text-dark', text: '超时' };
          case 'ERROR': return { class: 'bg-danger', text: '错误' };
          case 'PENDING': return { class: 'bg-secondary', text: '待检测' };
          default: return { class: 'bg-secondary', text: '未知' };
      }
  }
  
  
  // 显示添加/编辑网站模态框 (handles both add and edit)
  function showSiteModal(siteIdToEdit = null) {
      const form = document.getElementById('siteForm');
      form.reset();
      const modalTitle = document.getElementById('siteModalTitle');
      const siteIdInput = document.getElementById('siteId');
  
      if (siteIdToEdit) {
          const site = siteList.find(s => s.id === siteIdToEdit);
          if (site) {
              modalTitle.textContent = '编辑监控网站';
              siteIdInput.value = site.id;
              document.getElementById('siteName').value = site.name || '';
              document.getElementById('siteUrl').value = site.url;
              // document.getElementById('siteEnableFrequentNotifications').checked = site.enable_frequent_down_notifications || false; // Removed
          } else {
              showAlert('danger', '未找到要编辑的网站信息。', 'siteAlert');
              return;
          }
      } else {
          modalTitle.textContent = '添加监控网站';
          siteIdInput.value = ''; // Clear ID for add mode
          // document.getElementById('siteEnableFrequentNotifications').checked = false; // Removed
      }
  
      const siteModal = new bootstrap.Modal(document.getElementById('siteModal'));
      siteModal.show();
  }
  
  // Function to call when edit button is clicked
  function editSite(siteId) {
      showSiteModal(siteId);
  }
  
  // 保存网站（添加或更新）
  async function saveSite() {
      const siteId = document.getElementById('siteId').value; // Get ID from hidden input
      const siteName = document.getElementById('siteName').value.trim();
      const siteUrl = document.getElementById('siteUrl').value.trim();
      // const enableFrequentNotifications = document.getElementById('siteEnableFrequentNotifications').checked; // Removed
  
      if (!siteUrl) {
          showAlert('warning', '请输入网站URL', 'siteAlert');
          return;
      }
      if (!siteUrl.startsWith('http://') && !siteUrl.startsWith('https://')) {
           showAlert('warning', 'URL必须以 http:// 或 https:// 开头', 'siteAlert');
           return;
      }
  
      const requestBody = {
          url: siteUrl,
          name: siteName
          // enable_frequent_down_notifications: enableFrequentNotifications // Removed
      };
      let apiUrl = '/api/admin/sites';
      let method = 'POST';
  
      if (siteId) { // If siteId exists, it's an update
          apiUrl = \`/api/admin/sites/\${siteId}\`;
          method = 'PUT';
      }
  
      try {
          const responseData = await apiRequest(apiUrl, {
              method: method,
              body: JSON.stringify(requestBody)
          });
  
          const siteModalInstance = bootstrap.Modal.getInstance(document.getElementById('siteModal'));
          if (siteModalInstance) {
              siteModalInstance.hide();
          }
          
          await loadSiteList(); // Reload the list
          showAlert('success', \`监控网站\${siteId ? '更新' : '添加'}成功\`, 'siteAlert');
  
      } catch (error) {
          console.error('保存网站错误:', error);
          showAlert('danger', \`保存网站失败: \${error.message}\`, 'siteAlert');
      }
  }
  
  // 显示删除网站确认模态框
  function showDeleteSiteConfirmation(siteId, siteName, siteUrl) {
      currentSiteId = siteId;
      document.getElementById('deleteSiteName').textContent = siteName;
      document.getElementById('deleteSiteUrl').textContent = siteUrl;
      const deleteModal = new bootstrap.Modal(document.getElementById('deleteSiteModal'));
      deleteModal.show();
  }
  
  
  // 删除网站监控
  async function deleteSite(siteId) {
      try {
          await apiRequest(\`/api/admin/sites/\${siteId}\`, {
              method: 'DELETE'
          });
  
          // Hide modal and reload list
          const deleteModal = bootstrap.Modal.getInstance(document.getElementById('deleteSiteModal'));
          deleteModal.hide();
          await loadSiteList(); // Reload list
          showAlert('success', '网站监控已删除', 'siteAlert');
          currentSiteId = null; // Reset current ID
  
      } catch (error) {
          console.error('删除网站错误:', error);
          showAlert('danger', \`删除网站失败: \${error.message}\`, 'siteAlert');
      }
  }
  
  
  // --- Utility Functions ---
  
  // 显示警告信息 (specify alert element ID)
  function showAlert(type, message, alertId = 'serverAlert', autoHideDelay = 5000) {
      const alertElement = document.getElementById(alertId);
      if (!alertElement) return; // Exit if alert element doesn't exist
  
      alertElement.className = \`alert alert-\${type} alert-dismissible\`;
  
      // 添加关闭按钮和消息内容
      alertElement.innerHTML = \`
          \${message}
          <button type="button" class="btn-close" aria-label="Close" onclick="this.parentElement.classList.add('d-none')"></button>
      \`;
  
      alertElement.classList.remove('d-none');
  
      // 如果autoHideDelay大于0，则自动隐藏
      if (autoHideDelay > 0) {
          setTimeout(() => {
              alertElement.classList.add('d-none');
          }, autoHideDelay);
      }
  }
  
  // 显示密码修改警告信息 (uses its own dedicated alert element)
  function showPasswordAlert(type, message) {
      const alertElement = document.getElementById('passwordAlert');
      if (!alertElement) return;
      alertElement.className = \`alert alert-\${type}\`;
      alertElement.textContent = message;
      alertElement.classList.remove('d-none');
      // Auto-hide not typically needed for modal alerts, but can be added if desired
  }
  
  // --- Telegram Settings Functions ---
  
  // 加载Telegram通知设置
  async function loadTelegramSettings() {
      try {
          const settings = await apiRequest('/api/admin/telegram-settings');
          if (settings) {
              document.getElementById('telegramBotToken').value = settings.bot_token || '';
              document.getElementById('telegramChatId').value = settings.chat_id || '';
              document.getElementById('enableTelegramNotifications').checked = !!settings.enable_notifications;
          }
      } catch (error) {
          console.error('加载Telegram设置错误:', error);
          showAlert('danger', \`加载Telegram设置失败: \${error.message}\`, 'telegramSettingsAlert');
      }
  }
  
  // 保存Telegram通知设置
  async function saveTelegramSettings() {
      const botToken = document.getElementById('telegramBotToken').value.trim();
      const chatId = document.getElementById('telegramChatId').value.trim();
      let enableNotifications = document.getElementById('enableTelegramNotifications').checked;
  
      // If Bot Token or Chat ID is empty, automatically disable notifications
      if (!botToken || !chatId) {
          enableNotifications = false;
          document.getElementById('enableTelegramNotifications').checked = false; // Update the checkbox UI
          if (document.getElementById('enableTelegramNotifications').checked && (botToken || chatId)) { // Only show warning if user intended to enable
               showAlert('warning', 'Bot Token 和 Chat ID 均不能为空才能启用通知。通知已自动禁用。', 'telegramSettingsAlert');
          }
      } else if (enableNotifications && (!botToken || !chatId)) { // This case should ideally not be hit due to above logic, but kept for safety
          showAlert('warning', '启用通知时，Bot Token 和 Chat ID 不能为空。', 'telegramSettingsAlert');
          return;
      }
  
  
      try {
          await apiRequest('/api/admin/telegram-settings', {
              method: 'POST',
              body: JSON.stringify({
                  bot_token: botToken,
                  chat_id: chatId,
                  enable_notifications: enableNotifications // Use the potentially modified value
              })
          });
  
          showAlert('success', 'Telegram设置已成功保存。', 'telegramSettingsAlert');
  
      } catch (error) {
          console.error('保存Telegram设置错误:', error);
      showAlert('danger', \`保存Telegram设置失败: \${error.message}\`, 'telegramSettingsAlert');
      }
  }
  
  // --- Global Settings Functions (VPS Report Interval) ---
  async function loadGlobalSettings() {
      try {
          const settings = await apiRequest('/api/admin/settings/vps-report-interval');
          if (settings && typeof settings.interval === 'number') {
              document.getElementById('vpsReportInterval').value = settings.interval;
          } else {
              document.getElementById('vpsReportInterval').value = 60; // Default if not set
          }
      } catch (error) {
          console.error('加载VPS报告间隔错误:', error);
          showAlert('danger', \`加载VPS报告间隔失败: \${error.message}\`, 'serverAlert'); // Changed to serverAlert
          document.getElementById('vpsReportInterval').value = 60; // Default on error
      }
  }
  
  async function saveVpsReportInterval() {
      const intervalInput = document.getElementById('vpsReportInterval');
      const interval = parseInt(intervalInput.value, 10);
  
      if (isNaN(interval) || interval < 1) { // Changed to interval < 1
          showAlert('warning', 'VPS报告间隔必须是一个大于或等于1的数字。', 'serverAlert'); // Changed to serverAlert and message
          return;
      }
      // Removed warning for interval < 10
  
      try {
          await apiRequest('/api/admin/settings/vps-report-interval', {
              method: 'POST',
              body: JSON.stringify({ interval: interval })
          });
  
          showAlert('success', 'VPS数据更新频率已成功保存。前端刷新间隔已立即更新。', 'serverAlert'); // Changed to serverAlert
  
          // Immediately update the frontend refresh interval
          // Check if we're on a page that has VPS data updates running
          if (typeof initializeVpsDataUpdates === 'function') {
              try {
                  await initializeVpsDataUpdates();
                  console.log('VPS data refresh interval updated immediately');
              } catch (error) {
                  console.error('Error updating VPS refresh interval:', error);
              }
          }
      } catch (error) {
          console.error('保存VPS报告间隔错误:', error);
          showAlert('danger', \`保存VPS报告间隔失败: \${error.message}\`, 'serverAlert'); // Changed to serverAlert
      }
  }
  
  // --- 自动排序功能 ---
  
  // 服务器自动排序
  async function autoSortServers(sortBy) {
      try {
          await apiRequest('/api/admin/servers/auto-sort', {
              method: 'POST',
              body: JSON.stringify({ sortBy: sortBy, order: 'asc' })
          });
  
          // 更新下拉菜单选中状态
          updateServerSortDropdownSelection(sortBy);
  
          // 重新加载服务器列表
          await loadServerList();
          showAlert('success', \`服务器已按\${getSortDisplayName(sortBy)}排序\`, 'serverAlert');
  
      } catch (error) {
          console.error('服务器自动排序错误:', error);
          showAlert('danger', '服务器自动排序失败: ' + error.message, 'serverAlert');
      }
  }
  
  // 网站自动排序
  async function autoSortSites(sortBy) {
      try {
          await apiRequest('/api/admin/sites/auto-sort', {
              method: 'POST',
              body: JSON.stringify({ sortBy: sortBy, order: 'asc' })
          });
  
          // 更新下拉菜单选中状态
          updateSiteSortDropdownSelection(sortBy);
  
          // 重新加载网站列表
          await loadSiteList();
          showAlert('success', \`网站已按\${getSortDisplayName(sortBy)}排序\`, 'siteAlert');
  
      } catch (error) {
          console.error('网站自动排序错误:', error);
          showAlert('danger', '网站自动排序失败: ' + error.message, 'siteAlert');
      }
  }
  
  // 获取排序字段的显示名称
  function getSortDisplayName(sortBy) {
      const displayNames = {
          'custom': '自定义',
          'name': '名称',
          'status': '状态',
          'created_at': '创建时间',
          'added_at': '添加时间',
          'url': 'URL'
      };
      return displayNames[sortBy] || sortBy;
  }
  
  // 更新服务器排序下拉菜单选中状态
  function updateServerSortDropdownSelection(selectedSortBy) {
      const dropdown = document.querySelector('#serverAutoSortDropdown + .dropdown-menu');
      if (!dropdown) return;
  
      // 移除所有active类
      dropdown.querySelectorAll('.dropdown-item').forEach(item => {
          item.classList.remove('active');
      });
  
      // 为选中的项添加active类
      const selectedItem = dropdown.querySelector(\`[onclick="autoSortServers('\${selectedSortBy}')"]\`);
      if (selectedItem) {
          selectedItem.classList.add('active');
      }
  }
  
  // 更新网站排序下拉菜单选中状态
  function updateSiteSortDropdownSelection(selectedSortBy) {
      const dropdown = document.querySelector('#siteAutoSortDropdown + .dropdown-menu');
      if (!dropdown) return;
  
      // 移除所有active类
      dropdown.querySelectorAll('.dropdown-item').forEach(item => {
          item.classList.remove('active');
      });
  
      // 为选中的项添加active类
      const selectedItem = dropdown.querySelector(\`[onclick="autoSortSites('\${selectedSortBy}')"]\`);
      if (selectedItem) {
          selectedItem.classList.add('active');
      }
  }
  
  // 管理页面移动端服务器卡片渲染函数
  function renderMobileAdminServerCards(servers) {
      const mobileContainer = document.getElementById('mobileAdminServerContainer');
      if (!mobileContainer) return;
  
      mobileContainer.innerHTML = '';
  
      if (!servers || servers.length === 0) {
          mobileContainer.innerHTML = '<div class="text-center p-3 text-muted">暂无服务器数据</div>';
          return;
      }
  
      servers.forEach(server => {
          const card = document.createElement('div');
          card.className = 'mobile-server-card';
          card.setAttribute('data-server-id', server.id);
  
          // 状态显示逻辑（与PC端一致）
          let statusBadge = '<span class="badge bg-secondary">未知</span>';
          let lastUpdateText = '从未';
  
          if (server.last_report) {
              const lastUpdate = new Date(server.last_report * 1000);
              lastUpdateText = lastUpdate.toLocaleString();
  
              // 检查是否在线（最后报告时间在5分钟内）
              const now = new Date();
              const diffMinutes = (now - lastUpdate) / (1000 * 60);
  
              if (diffMinutes <= 5) {
                  statusBadge = '<span class="badge bg-success">在线</span>';
              } else {
                  statusBadge = '<span class="badge bg-danger">离线</span>';
              }
          }
  
          // 卡片头部
          const cardHeader = document.createElement('div');
          cardHeader.className = 'mobile-card-header';
          cardHeader.innerHTML = \`
              <div class="mobile-card-header-left">
                  \${statusBadge}
              </div>
              <h6 class="mobile-card-title text-center">\${server.name || '未命名服务器'}</h6>
              <div class="mobile-card-header-right">
                  <span class="me-2">显示</span>
                  <div class="form-check form-switch d-inline-block">
                      <input class="form-check-input server-visibility-toggle" type="checkbox"
                             data-server-id="\${server.id}" \${server.is_public ? 'checked' : ''}>
                  </div>
              </div>
          \`;
  
          // 卡片主体
          const cardBody = document.createElement('div');
          cardBody.className = 'mobile-card-body';
  
          // 描述 - 单行
          if (server.description) {
              const descRow = document.createElement('div');
              descRow.className = 'mobile-card-row';
              descRow.innerHTML = \`
                  <span class="mobile-card-label">描述</span>
                  <span class="mobile-card-value">\${server.description}</span>
              \`;
              cardBody.appendChild(descRow);
          }
  
  
  
          // 四个按钮 - 两行两列布局
          const buttonsContainer = document.createElement('div');
          buttonsContainer.className = 'mobile-card-buttons-grid';
          buttonsContainer.innerHTML = \`
              <div class="d-flex gap-2 mb-2">
                  <button class="btn btn-outline-secondary btn-sm flex-fill" onclick="showServerApiKey('\${server.id}')">
                      <i class="bi bi-key"></i> 查看密钥
                  </button>
                  <button class="btn btn-outline-info btn-sm flex-fill" onclick="copyVpsInstallScript('\${server.id}', '\${server.name}', this)">
                      <i class="bi bi-clipboard"></i> 复制脚本
                  </button>
              </div>
              <div class="d-flex gap-2">
                  <button class="btn btn-outline-primary btn-sm flex-fill" onclick="editServer('\${server.id}')">
                      <i class="bi bi-pencil"></i> 编辑
                  </button>
                  <button class="btn btn-outline-danger btn-sm flex-fill" onclick="deleteServer('\${server.id}')">
                      <i class="bi bi-trash"></i> 删除
                  </button>
              </div>
          \`;
          cardBody.appendChild(buttonsContainer);
  
          // 最后更新时间 - 底部单行（与PC端功能一致）
          const lastUpdateRow = document.createElement('div');
          lastUpdateRow.className = 'mobile-card-row mobile-card-footer';
          lastUpdateRow.innerHTML = \`
              <span class="mobile-card-label">最后更新</span>
              <span class="mobile-card-value">\${lastUpdateText}</span>
          \`;
          cardBody.appendChild(lastUpdateRow);
  
          // 组装卡片
          card.appendChild(cardHeader);
          card.appendChild(cardBody);
  
          mobileContainer.appendChild(card);
      });
  
      // 为移动端显示开关添加事件监听器
      document.querySelectorAll('.server-visibility-toggle').forEach(toggle => {
          toggle.addEventListener('change', function() {
              const serverId = this.dataset.serverId;
              const isPublic = this.checked;
              toggleServerVisibility(serverId, isPublic);
          });
      });
  }
  
  // 切换服务器显示状态
  async function toggleServerVisibility(serverId, isPublic) {
      try {
          const toggle = document.querySelector(\`.server-visibility-toggle[data-server-id="\${serverId}"]\`);
          if (toggle) {
              toggle.disabled = true;
              toggle.style.opacity = '0.6';
          }
  
          await apiRequest(\`/api/admin/servers/\${serverId}/visibility\`, {
              method: 'POST',
              body: JSON.stringify({ is_public: isPublic })
          });
  
          // 更新本地数据
          const serverIndex = serverList.findIndex(s => s.id === serverId);
          if (serverIndex !== -1) {
              serverList[serverIndex].is_public = isPublic;
          }
  
          if (toggle) {
              toggle.disabled = false;
              toggle.style.opacity = '1';
          }
  
          showAlert('success', '服务器显示状态已' + (isPublic ? '开启' : '关闭'), 'serverAlert');
  
      } catch (error) {
          console.error('切换服务器显示状态错误:', error);
  
          // 恢复开关状态
          const toggle = document.querySelector(\`.server-visibility-toggle[data-server-id="\${serverId}"]\`);
          if (toggle) {
              toggle.checked = !isPublic;
              toggle.disabled = false;
              toggle.style.opacity = '1';
          }
  
          showAlert('danger', '切换显示状态失败: ' + error.message, 'serverAlert');
      }
  }
  
  // 管理页面移动端网站卡片渲染函数
  function renderMobileAdminSiteCards(sites) {
      const mobileContainer = document.getElementById('mobileAdminSiteContainer');
      if (!mobileContainer) return;
  
      mobileContainer.innerHTML = '';
  
      if (!sites || sites.length === 0) {
          mobileContainer.innerHTML = '<div class="text-center p-3 text-muted">暂无监控网站数据</div>';
          return;
      }
  
      sites.forEach(site => {
          const card = document.createElement('div');
          card.className = 'mobile-site-card';
  
          const statusInfo = getSiteStatusBadge(site.last_status);
          const lastCheckTime = site.last_checked ? new Date(site.last_checked * 1000).toLocaleString() : '从未';
          const responseTime = site.last_response_time_ms !== null ? \`\${site.last_response_time_ms} ms\` : '-';
  
          // 卡片头部
          const cardHeader = document.createElement('div');
          cardHeader.className = 'mobile-card-header';
          cardHeader.innerHTML = \`
              <h6 class="mobile-card-title">\${site.name || '未命名网站'}</h6>
              <span class="badge \${statusInfo.class}">\${statusInfo.text}</span>
          \`;
  
          // 卡片主体
          const cardBody = document.createElement('div');
          cardBody.className = 'mobile-card-body';
  
          // URL - 单行
          const urlRow = document.createElement('div');
          urlRow.className = 'mobile-card-row';
          urlRow.innerHTML = \`
              <span class="mobile-card-label">URL</span>
              <span class="mobile-card-value" style="word-break: break-all;">\${site.url}</span>
          \`;
          cardBody.appendChild(urlRow);
  
          // 状态码 | 响应时间
          const statusCode = site.last_status_code || '-';
          const statusResponseRow = document.createElement('div');
          statusResponseRow.className = 'mobile-card-two-columns';
          statusResponseRow.innerHTML = \`
              <div class="mobile-card-column-item">
                  <span class="mobile-card-label">状态码</span>
                  <span class="mobile-card-value">\${statusCode}</span>
              </div>
              <div class="mobile-card-column-item">
                  <span class="mobile-card-label">响应时间</span>
                  <span class="mobile-card-value">\${responseTime}</span>
              </div>
          \`;
          cardBody.appendChild(statusResponseRow);
  
          // 最后检查和显示开关 - 两列
          const lastCheckVisibilityRow = document.createElement('div');
          lastCheckVisibilityRow.className = 'mobile-card-two-columns';
          lastCheckVisibilityRow.innerHTML = \`
              <div class="mobile-card-column-item">
                  <span class="mobile-card-label">最后检查</span>
                  <span class="mobile-card-value">\${lastCheckTime}</span>
              </div>
              <div class="mobile-card-column-item">
                  <span class="mobile-card-label">显示开关</span>
                  <div class="form-check form-switch">
                      <input class="form-check-input site-visibility-toggle" type="checkbox"
                             data-site-id="\${site.id}" \${site.is_public ? 'checked' : ''}>
                  </div>
              </div>
          \`;
          cardBody.appendChild(lastCheckVisibilityRow);
  
          // 操作按钮
          const actionsRow = document.createElement('div');
          actionsRow.className = 'mobile-card-row';
          actionsRow.innerHTML = \`
              <div class="d-flex gap-2 w-100">
                  <button class="btn btn-outline-primary btn-sm flex-fill" onclick="editSite('\${site.id}')">
                      <i class="bi bi-pencil"></i> 编辑
                  </button>
                  <button class="btn btn-outline-danger btn-sm" onclick="deleteSite('\${site.id}')">
                      <i class="bi bi-trash"></i> 删除
                  </button>
              </div>
          \`;
          cardBody.appendChild(actionsRow);
  
          // 组装卡片
          card.appendChild(cardHeader);
          card.appendChild(cardBody);
  
          mobileContainer.appendChild(card);
      });
  
      // 为移动端网站显示开关添加事件监听器
      document.querySelectorAll('.site-visibility-toggle').forEach(toggle => {
          toggle.addEventListener('change', function() {
              const siteId = this.dataset.siteId;
              const isPublic = this.checked;
              toggleSiteVisibility(siteId, isPublic);
          });
      });
  }
  
  // 切换网站显示状态
  async function toggleSiteVisibility(siteId, isPublic) {
      try {
          const toggle = document.querySelector(\`.site-visibility-toggle[data-site-id="\${siteId}"]\`);
          if (toggle) {
              toggle.disabled = true;
              toggle.style.opacity = '0.6';
          }
  
          await apiRequest(\`/api/admin/sites/\${siteId}/visibility\`, {
              method: 'POST',
              body: JSON.stringify({ is_public: isPublic })
          });
  
          // 更新本地数据
          const siteIndex = siteList.findIndex(s => s.id === siteId);
          if (siteIndex !== -1) {
              siteList[siteIndex].is_public = isPublic;
          }
  
          if (toggle) {
              toggle.disabled = false;
              toggle.style.opacity = '1';
          }
  
          showAlert('success', '网站显示状态已' + (isPublic ? '开启' : '关闭'), 'siteAlert');
  
      } catch (error) {
          console.error('切换网站显示状态错误:', error);
  
          // 恢复开关状态
          const toggle = document.querySelector(\`.site-visibility-toggle[data-site-id="\${siteId}"]\`);
          if (toggle) {
              toggle.checked = !isPublic;
              toggle.disabled = false;
              toggle.style.opacity = '1';
          }
  
          showAlert('danger', '切换显示状态失败: ' + error.message, 'siteAlert');
      }
  }
  
  // 移动端查看服务器API密钥
  function showServerApiKey(serverId) {
      viewApiKey(serverId);
  }
  `;
  }