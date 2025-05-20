// 合并前后端的单一Worker解决方案

// D1 Table Schemas (for reference and creation)
const D1_SCHEMAS = {
  admin_credentials: `
    CREATE TABLE IF NOT EXISTS admin_credentials (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL
    );
    INSERT OR IGNORE INTO admin_credentials (username, password) VALUES ('admin', 'admin');
  `,
  servers: `
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      api_key TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      sort_order INTEGER,
      last_notified_down_at INTEGER DEFAULT NULL -- Timestamp of last "down" notification (1h interval for resend)
    );
  `,
  metrics: `
    CREATE TABLE IF NOT EXISTS metrics (
      server_id TEXT PRIMARY KEY,
      timestamp INTEGER,
      cpu TEXT,
      memory TEXT,
      disk TEXT,
      network TEXT,
      uptime INTEGER, -- Added for server uptime in seconds
      FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
    );
  `,
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
      last_notified_down_at INTEGER DEFAULT NULL -- Timestamp of last "down" notification (1h interval for resend)
    );
  `,
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
    CREATE INDEX IF NOT EXISTS idx_site_status_history_site_id_timestamp ON site_status_history (site_id, timestamp DESC);
  `,
  telegram_config: `
    CREATE TABLE IF NOT EXISTS telegram_config (
      id INTEGER PRIMARY KEY CHECK (id = 1), -- Ensures only one row
      bot_token TEXT,
      chat_id TEXT,
      enable_notifications INTEGER DEFAULT 0, -- 0 for false, 1 for true
      updated_at INTEGER
    );
    -- Initialize with a single row if it doesn't exist
    INSERT OR IGNORE INTO telegram_config (id, bot_token, chat_id, enable_notifications, updated_at) VALUES (1, NULL, NULL, 0, NULL);
  `,
  app_config: `
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    -- Default VPS report interval: 60 seconds
    INSERT OR IGNORE INTO app_config (key, value) VALUES ('vps_report_interval_seconds', '60');
  `
};

// Helper to ensure all tables exist
async function ensureTablesExist(db) {
  console.log("Ensuring all database tables exist...");
  const createTableStatements = Object.values(D1_SCHEMAS).map(sql => db.prepare(sql));
  try {
    await db.batch(createTableStatements);
    console.log("Database tables verified/created successfully.");
  } catch (error) {
    console.error("Error during initial table creation:", error);
    // Proceed, as ALTER statements might fix things or might also fail if table creation itself failed badly.
  }

  // Attempt to add new columns to existing tables if they are missing
  // These will fail if the columns already exist, which is fine.
  console.log("Attempting to apply schema alterations for new columns...");
  const alterStatements = [
    // For monitored_sites table - ensure last_notified_down_at exists if it was added later
    "ALTER TABLE monitored_sites ADD COLUMN last_notified_down_at INTEGER DEFAULT NULL",
    // For servers table - ensure last_notified_down_at exists if it was added later
    "ALTER TABLE servers ADD COLUMN last_notified_down_at INTEGER DEFAULT NULL",
    // For metrics table - ensure uptime exists if it was added later
    "ALTER TABLE metrics ADD COLUMN uptime INTEGER DEFAULT NULL"
    // NOTE: Columns 'enable_frequent_down_notifications' and 'last_frequent_notified_down_at'
    // are being removed from the schema. D1 does not easily support DROP COLUMN.
    // Existing columns will be ignored by the application logic.
    // New deployments won't create them.
  ];

  for (const alterSql of alterStatements) {
    try {
      await db.exec(alterSql);
      console.log(`Successfully executed: ${alterSql}`);
    } catch (e) {
      if (e.message && (e.message.includes("duplicate column name") || e.message.includes("already exists"))) {
        console.log(`Column in "${alterSql}" likely already exists (expected): ${e.message}`);
      } else if (e.message && e.message.includes("no such table")) {
        console.error(`Table for ALTER statement "${alterSql}" does not exist: ${e.message}`);
      } else {
        console.error(`Error executing ALTER statement "${alterSql}":`, e);
      }
    }
  }
  console.log("Schema alterations attempt finished (new columns for frequent notifications are no longer added).");
}


// 处理API请求
async function handleApiRequest(request, env, ctx) { // Added ctx
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  
  // CORS处理
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
  };
  
  // 处理OPTIONS请求
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  
  // 处理登录请求
  if (path === '/api/auth/login' && method === 'POST') {
    try {
      const { username, password } = await request.json();

      // 从D1获取管理员凭证
      let stmt = env.DB.prepare('SELECT password FROM admin_credentials WHERE username = ?');
      let result = await stmt.bind(username).first();

      let storedPassword = null;
      if (result) {
        storedPassword = result.password;
      } else if (username === 'admin') {
        // 如果是首次登录且用户是 'admin'，创建默认凭证
        const defaultPassword = 'admin'; // 简化版本，不使用哈希
        try {
          // 使用 INSERT OR IGNORE 避免并发问题
          await env.DB.prepare('INSERT OR IGNORE INTO admin_credentials (username, password) VALUES (?, ?)')
                      .bind('admin', defaultPassword)
                      .run();
          storedPassword = defaultPassword;
        } catch (dbError) {
           // 如果表不存在，尝试创建表并插入 (仅适用于开发或首次部署)
           // 注意：在生产环境中，表结构应预先创建好
           if (dbError.message.includes('no such table')) {
             console.warn("Admin credentials table not found. Attempting to create...");
             await env.DB.exec(`
               CREATE TABLE IF NOT EXISTS admin_credentials (
                 username TEXT PRIMARY KEY,
                 password TEXT NOT NULL
               );
               INSERT OR IGNORE INTO admin_credentials (username, password) VALUES ('admin', 'admin');
             `);
             storedPassword = defaultPassword; // 假设创建成功
           } else {
             throw dbError; // 重新抛出其他数据库错误
           }
        }
      }

      // 验证密码
      if (storedPassword && password === storedPassword) {
        // 生成简单token
        const token = btoa(username + ':' + Date.now());
        return new Response(JSON.stringify({ token }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 验证失败
      return new Response(JSON.stringify({ error: 'Invalid credentials', message: '用户名或密码错误' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Login error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  
  // 处理登录状态检查
  if (path === '/api/auth/status' && method === 'GET') {
    const authHeader = request.headers.get('Authorization');
    const authenticated = authHeader && authHeader.startsWith('Bearer ');
    
    return new Response(JSON.stringify({ authenticated }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
  
  // 处理获取服务器列表 (Public)
  if (path === '/api/servers' && method === 'GET') {
    try {
      // 从D1获取服务器列表 (按 sort_order 排序, NULLs last, 然后按 name)
      const stmt = env.DB.prepare('SELECT id, name, description FROM servers ORDER BY sort_order ASC NULLS LAST, name ASC');
      const { results } = await stmt.all();

      return new Response(JSON.stringify({ servers: results || [] }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
       console.error("Get servers error:", error);
       // 尝试创建表 (仅适用于开发或首次部署)
       if (error.message.includes('no such table')) {
         console.warn("Servers table not found. Returning empty list and attempting to create...");
         try {
           await env.DB.exec(`
             CREATE TABLE IF NOT EXISTS servers (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               description TEXT,
               api_key TEXT NOT NULL UNIQUE,
               created_at INTEGER NOT NULL,
               sort_order INTEGER
             );
           `);
           return new Response(JSON.stringify({ servers: [] }), { // 返回空列表
             headers: { 'Content-Type': 'application/json', ...corsHeaders }
           });
         } catch (createError) {
            console.error("Failed to create servers table:", createError);
            return new Response(JSON.stringify({ error: 'Database error', message: createError.message }), {
              status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
         }
       }
       return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
         status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
       });
    }
  }
  
  // 处理获取服务器状态 (Public)
  if (path.startsWith('/api/status/') && method === 'GET') {
    try {
      const serverId = path.split('/').pop();

      // 从D1获取服务器信息
      const serverStmt = env.DB.prepare('SELECT id, name, description FROM servers WHERE id = ?');
      const serverData = await serverStmt.bind(serverId).first();

      if (!serverData) {
        return new Response(JSON.stringify({ error: 'Server not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 从D1获取最新监控数据
      // 注意：metrics表存储JSON字符串，直接取出
      const metricsStmt = env.DB.prepare('SELECT timestamp, cpu, memory, disk, network, uptime FROM metrics WHERE server_id = ?');
      const metricsResult = await metricsStmt.bind(serverId).first();

      let metricsData = null;
      if (metricsResult) {
         // 解析存储的JSON字符串
         try {
            metricsData = {
                timestamp: metricsResult.timestamp,
                cpu: JSON.parse(metricsResult.cpu || '{}'),
                memory: JSON.parse(metricsResult.memory || '{}'),
                disk: JSON.parse(metricsResult.disk || '{}'),
                network: JSON.parse(metricsResult.network || '{}'),
                uptime: metricsResult.uptime // uptime is stored as INTEGER
            };
         } catch (parseError) {
             console.error(`Error parsing metrics JSON for server ${serverId}:`, parseError);
             // 可以选择返回错误或返回部分数据
             metricsData = { timestamp: metricsResult.timestamp, uptime: metricsResult.uptime }; // 至少返回时间戳和uptime
         }
      }


      // 准备响应数据
      const responseData = {
        server: serverData, // 包含 id, name, description
        metrics: metricsData
      };

      return new Response(JSON.stringify(responseData), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Get status error:", error);
       // 尝试创建表 (仅适用于开发或首次部署)
       if (error.message.includes('no such table')) {
         console.warn("Servers or metrics table not found. Attempting to create...");
         try {
           await env.DB.exec(`
             CREATE TABLE IF NOT EXISTS servers (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               description TEXT,
               api_key TEXT NOT NULL UNIQUE,
               created_at INTEGER NOT NULL,
               sort_order INTEGER
             );
             CREATE TABLE IF NOT EXISTS metrics (
               server_id TEXT PRIMARY KEY,
               timestamp INTEGER,
               cpu TEXT,
               memory TEXT,
               disk TEXT,
               network TEXT,
               uptime INTEGER,
               FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
             );
           `);
           // 返回 404 因为即使创建了表，数据也不存在
            return new Response(JSON.stringify({ error: 'Server not found (tables created)' }), {
              status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
         } catch (createError) {
            console.error("Failed to create tables:", createError);
            return new Response(JSON.stringify({ error: 'Database error', message: createError.message }), {
              status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
         }
       }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  
  // 处理管理API - 获取所有服务器
  if (path === '/api/admin/servers' && method === 'GET') {
    try {
      // 从D1获取所有服务器及其最新指标时间戳
      // 使用 LEFT JOIN 来包含没有指标的服务器
      const stmt = env.DB.prepare(`
        SELECT 
          s.id, s.name, s.description, s.created_at, s.sort_order,
          s.last_notified_down_at, -- Removed frequent notification fields
          m.timestamp as last_report
        FROM servers s
        LEFT JOIN metrics m ON s.id = m.server_id
        ORDER BY s.sort_order ASC NULLS LAST, s.name ASC
      `);
      const { results } = await stmt.all();

      return new Response(JSON.stringify({ servers: results || [] }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin get servers error:", error);
      // 尝试创建表 (仅适用于开发或首次部署)
       if (error.message.includes('no such table')) {
         console.warn("Servers or metrics table not found. Returning empty list and attempting to create...");
         try {
           await env.DB.exec(`
             CREATE TABLE IF NOT EXISTS servers (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               description TEXT,
               api_key TEXT NOT NULL UNIQUE,
               created_at INTEGER NOT NULL,
               sort_order INTEGER
             );
             CREATE TABLE IF NOT EXISTS metrics (
               server_id TEXT PRIMARY KEY,
               timestamp INTEGER,
               cpu TEXT,
               memory TEXT,
               disk TEXT,
               network TEXT,
               FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
             );
           `);
           return new Response(JSON.stringify({ servers: [] }), { // 返回空列表
             headers: { 'Content-Type': 'application/json', ...corsHeaders }
           });
         } catch (createError) {
            console.error("Failed to create tables:", createError);
            return new Response(JSON.stringify({ error: 'Database error', message: createError.message }), {
              status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
         }
       }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  
  // 处理管理API - 添加新服务器
  if (path === '/api/admin/servers' && method === 'POST') {
    try {
      const { name, description } = await request.json(); // Removed enable_frequent_down_notifications

      // 验证输入
      if (!name) {
        return new Response(JSON.stringify({ error: 'Server name is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 生成服务器ID和API密钥
      const serverId = Math.random().toString(36).substring(2, 10);
      const apiKey = Math.random().toString(36).substring(2, 15) +
                     Math.random().toString(36).substring(2, 15);
      const createdAt = Math.floor(Date.now() / 1000);

      // 获取当前最大的 sort_order
      const maxOrderStmt = env.DB.prepare('SELECT MAX(sort_order) as max_order FROM servers');
      const maxOrderResult = await maxOrderStmt.first();
      const nextSortOrder = (maxOrderResult && typeof maxOrderResult.max_order === 'number') ? maxOrderResult.max_order + 1 : 0;
      // Removed enableFrequentNotificationsValue

      // 保存服务器数据到D1
      const stmt = env.DB.prepare(
        'INSERT INTO servers (id, name, description, api_key, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)' // Removed enable_frequent_down_notifications
      );
      await stmt.bind(serverId, name, description || '', apiKey, createdAt, nextSortOrder).run(); // Removed binding

      // 返回服务器数据（包含API密钥和 sort_order）
      const serverData = {
        id: serverId,
        name,
        description: description || '',
        api_key: apiKey, // 返回密钥给管理员
        created_at: createdAt,
        sort_order: nextSortOrder
        // Removed enable_frequent_down_notifications
      };

      return new Response(JSON.stringify({ server: serverData }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin add server error:", error);
      // 检查是否因为 UNIQUE constraint 失败 (不太可能，但以防万一)
      if (error.message.includes('UNIQUE constraint failed')) {
         return new Response(JSON.stringify({ error: 'Server ID or API Key conflict', message: '服务器ID或API密钥冲突，请重试' }), {
           status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders }
         });
      }
      // 尝试创建表 (仅适用于开发或首次部署)
       if (error.message.includes('no such table')) {
         console.warn("Servers table not found. Attempting to create...");
         try {
           await env.DB.exec(`
             CREATE TABLE IF NOT EXISTS servers (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               description TEXT,
               api_key TEXT NOT NULL UNIQUE,
               created_at INTEGER NOT NULL,
               sort_order INTEGER
             );
           `);
           // 提示用户重试，因为表刚创建
            return new Response(JSON.stringify({ error: 'Database table created, please retry', message: '数据库表已创建，请重试添加操作' }), {
              status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } // Service Unavailable
            });
         } catch (createError) {
            console.error("Failed to create servers table:", createError);
            return new Response(JSON.stringify({ error: 'Database error', message: createError.message }), {
              status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
         }
       }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  
  // 处理管理API - 删除服务器
  if (path.match(/\/api\/admin\/servers\/[^\/]+$/) && method === 'DELETE') {
    try {
      const serverId = path.split('/').pop();

      // D1 外键约束 (ON DELETE CASCADE) 会自动删除关联的 metrics 数据
      const stmt = env.DB.prepare('DELETE FROM servers WHERE id = ?');
      const info = await stmt.bind(serverId).run();

      if (info.changes === 0) {
        return new Response(JSON.stringify({ error: 'Server not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin delete server error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  
  // 处理管理API - 更新服务器
  if (path.match(/\/api\/admin\/servers\/[^\/]+$/) && method === 'PUT') {
    try {
      const serverId = path.split('/').pop();
      const { name, description } = await request.json(); // Removed enable_frequent_down_notifications

      // 验证输入
      if (!name) {
        return new Response(JSON.stringify({ error: 'Server name is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 更新D1中的服务器数据
      // Construct the SET part of the query dynamically to only update provided fields
      // For this specific case, we expect name, description, and enable_frequent_down_notifications
      
      let setClauses = [];
      let bindings = [];

      if (name !== undefined) {
        setClauses.push("name = ?");
        bindings.push(name);
      }
      if (description !== undefined) {
        setClauses.push("description = ?");
        bindings.push(description || ''); // Ensure empty string if null/undefined
      }
      // Removed enable_frequent_down_notifications handling

      if (setClauses.length === 0) {
        return new Response(JSON.stringify({ error: 'No fields to update provided' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      bindings.push(serverId); // Add serverId for the WHERE clause

      const stmt = env.DB.prepare(
        `UPDATE servers SET ${setClauses.join(', ')} WHERE id = ?`
      );
      const info = await stmt.bind(...bindings).run();

      if (info.changes === 0) {
        return new Response(JSON.stringify({ error: 'Server not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin update server error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  
  // 处理数据上报API
  if (path.startsWith('/api/report/') && method === 'POST') {
    try {
      const serverId = path.split('/').pop();
      const apiKey = request.headers.get('X-API-Key');

      if (!apiKey) {
        return new Response(JSON.stringify({ error: 'API key required' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 从D1获取服务器API密钥
      const serverStmt = env.DB.prepare('SELECT api_key FROM servers WHERE id = ?');
      const serverData = await serverStmt.bind(serverId).first();

      if (!serverData) {
        return new Response(JSON.stringify({ error: 'Server not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 验证API密钥
      if (serverData.api_key !== apiKey) {
        return new Response(JSON.stringify({ error: 'Invalid API key' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 解析上报的数据
      const reportData = await request.json();

      // 验证数据格式
      if (!reportData.timestamp || !reportData.cpu || !reportData.memory || !reportData.disk || !reportData.network || typeof reportData.uptime === 'undefined') {
        return new Response(JSON.stringify({ error: 'Invalid data format, missing required fields including uptime' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 保存监控数据到D1 (使用REPLACE INTO进行插入或更新)
      // 将复杂的对象字符串化存储
      const metricsStmt = env.DB.prepare(`
        REPLACE INTO metrics (server_id, timestamp, cpu, memory, disk, network, uptime) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      await metricsStmt.bind(
        serverId,
        reportData.timestamp,
        JSON.stringify(reportData.cpu),
        JSON.stringify(reportData.memory),
        JSON.stringify(reportData.disk),
        JSON.stringify(reportData.network),
        reportData.uptime // uptime is an integer
      ).run();

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Report API error:", error);
       // 尝试创建表 (仅适用于开发或首次部署)
       if (error.message.includes('no such table')) {
         console.warn("Servers or metrics table not found. Attempting to create...");
         try {
           await env.DB.exec(`
             CREATE TABLE IF NOT EXISTS servers (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               description TEXT,
               api_key TEXT NOT NULL UNIQUE,
               created_at INTEGER NOT NULL,
               sort_order INTEGER
             );
             CREATE TABLE IF NOT EXISTS metrics (
               server_id TEXT PRIMARY KEY,
               timestamp INTEGER,
               cpu TEXT,
               memory TEXT,
               disk TEXT,
               network TEXT,
               uptime INTEGER,
               FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
             );
           `);
           // 提示需要重试，因为表刚创建，或者服务器可能不存在
            return new Response(JSON.stringify({ error: 'Database table created or server not found, please retry or verify server ID/API Key', message: '数据库表已创建或服务器不存在，请重试或验证服务器ID/API密钥' }), {
              status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders } // Service Unavailable
            });
         } catch (createError) {
            console.error("Failed to create tables:", createError);
            return new Response(JSON.stringify({ error: 'Database error', message: createError.message }), {
              status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
         }
       }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  
  // 处理管理API - 获取服务器的API密钥
  if (path.match(/\/api\/admin\/servers\/[^\/]+\/key$/) && method === 'GET') {
    try {
      const serverId = path.split('/')[4]; // 获取路径中的 serverId

      // 从D1获取API密钥
      const stmt = env.DB.prepare('SELECT api_key FROM servers WHERE id = ?');
      const result = await stmt.bind(serverId).first();

      if (!result) {
        return new Response(JSON.stringify({ error: 'Server not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      return new Response(JSON.stringify({ api_key: result.api_key }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin get API key error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // 处理管理API - 服务器排序
  if (path.match(/\/api\/admin\/servers\/[^\/]+\/reorder$/) && method === 'POST') {
    try {
      const serverId = path.split('/')[4]; // 获取路径中的 serverId
      const { direction } = await request.json(); // 'up' or 'down'

      if (!direction || (direction !== 'up' && direction !== 'down')) {
        return new Response(JSON.stringify({ error: 'Invalid direction' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 使用事务处理排序更新
      const results = await env.DB.batch([
        // 获取所有服务器的 ID 和 sort_order，按当前顺序排列
        env.DB.prepare('SELECT id, sort_order FROM servers ORDER BY sort_order ASC NULLS LAST, name ASC')
      ]);

      const allServers = results[0].results;
      const currentIndex = allServers.findIndex(s => s.id === serverId);

      if (currentIndex === -1) {
        return new Response(JSON.stringify({ error: 'Server not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      let targetIndex = -1;
      if (direction === 'up' && currentIndex > 0) {
        targetIndex = currentIndex - 1;
      } else if (direction === 'down' && currentIndex < allServers.length - 1) {
        targetIndex = currentIndex + 1;
      }

      if (targetIndex !== -1) {
        const currentServer = allServers[currentIndex];
        const targetServer = allServers[targetIndex];

        // 确保 sort_order 是数字，如果为 null 则分配
        let currentOrder = currentServer.sort_order;
        let targetOrder = targetServer.sort_order;

        // 如果任何一个 sort_order 为 null，需要重新分配所有 sort_order
        if (currentOrder === null || targetOrder === null) {
           console.warn("Reordering with NULL sort_order, re-assigning all orders.");
           const updateStmts = allServers.map((server, index) =>
             env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(index, server.id)
           );
           await env.DB.batch(updateStmts);
           // 重新获取更新后的顺序
           const updatedResults = await env.DB.batch([
              env.DB.prepare('SELECT id, sort_order FROM servers ORDER BY sort_order ASC')
           ]);
           const updatedServers = updatedResults[0].results;
           const newCurrentIndex = updatedServers.findIndex(s => s.id === serverId);
           let newTargetIndex = -1;
           if (direction === 'up' && newCurrentIndex > 0) newTargetIndex = newCurrentIndex - 1;
           else if (direction === 'down' && newCurrentIndex < updatedServers.length - 1) newTargetIndex = newCurrentIndex + 1;

           if (newTargetIndex !== -1) {
              currentOrder = updatedServers[newCurrentIndex].sort_order;
              targetOrder = updatedServers[newTargetIndex].sort_order;
              // 交换这两个明确的顺序
              await env.DB.batch([
                env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(targetOrder, serverId),
                env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(currentOrder, updatedServers[newTargetIndex].id)
              ]);
           }
        } else {
          // 如果都有 sort_order，直接交换
          await env.DB.batch([
            env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(targetOrder, serverId),
            env.DB.prepare('UPDATE servers SET sort_order = ? WHERE id = ?').bind(currentOrder, targetServer.id)
          ]);
        }
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });

    } catch (error) {
      console.error("Admin reorder server error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // 处理密码修改API
  if (path === '/api/auth/change-password' && method === 'POST') {
    try {
      // 假设只有一个管理员 'admin'
      const adminUsername = 'admin';
      const { current_password, new_password } = await request.json();

      // 验证输入
      if (!current_password || !new_password) {
        return new Response(JSON.stringify({ error: 'Current password and new password are required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 从D1获取当前密码
      let stmt = env.DB.prepare('SELECT password FROM admin_credentials WHERE username = ?');
      let result = await stmt.bind(adminUsername).first();

      if (!result) {
         return new Response(JSON.stringify({ error: 'Admin user not found', message: '管理员用户不存在' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 验证当前密码
      if (result.password !== current_password) {
        return new Response(JSON.stringify({ error: 'Current password is incorrect', message: '当前密码不正确' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // 更新密码
      stmt = env.DB.prepare('UPDATE admin_credentials SET password = ? WHERE username = ?');
      await stmt.bind(new_password, adminUsername).run();

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Change password error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // --- Website Monitoring API ---

  // 处理管理API - 获取监控站点列表
  if (path === '/api/admin/sites' && method === 'GET') {
    try {
      // Order by sort_order, then name/url
      const stmt = env.DB.prepare('SELECT id, name, url, added_at, last_checked, last_status, last_status_code, last_response_time_ms, sort_order, last_notified_down_at FROM monitored_sites ORDER BY sort_order ASC NULLS LAST, name ASC, url ASC'); // Removed enable_frequent_down_notifications
      const { results } = await stmt.all();
      return new Response(JSON.stringify({ sites: results || [] }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin get sites error:", error);
      // Basic table check/creation attempt
      if (error.message.includes('no such table')) {
         console.warn("Monitored sites table not found. Returning empty list and attempting to create...");
         try {
           await env.DB.exec(D1_SCHEMAS.monitored_sites);
           return new Response(JSON.stringify({ sites: [] }), { // Return empty list
             headers: { 'Content-Type': 'application/json', ...corsHeaders }
           });
         } catch (createError) {
            console.error("Failed to create monitored_sites table:", createError);
         }
       }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // 处理管理API - 添加监控站点
  if (path === '/api/admin/sites' && method === 'POST') {
    try {
      const { url, name } = await request.json(); // Removed enable_frequent_down_notifications

      if (!url || !isValidHttpUrl(url)) {
        return new Response(JSON.stringify({ error: 'Valid URL is required', message: '请输入有效的URL' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const siteId = Math.random().toString(36).substring(2, 12); // Longer ID
      const addedAt = Math.floor(Date.now() / 1000);

      // Get current max sort_order for sites
      const maxOrderStmt = env.DB.prepare('SELECT MAX(sort_order) as max_order FROM monitored_sites');
      const maxOrderResult = await maxOrderStmt.first();
      const nextSortOrder = (maxOrderResult && typeof maxOrderResult.max_order === 'number') ? maxOrderResult.max_order + 1 : 0;
      // Removed enableFrequentNotificationsValue

      const stmt = env.DB.prepare(
        'INSERT INTO monitored_sites (id, url, name, added_at, last_status, sort_order) VALUES (?, ?, ?, ?, ?, ?)' // Removed enable_frequent_down_notifications
      );
      await stmt.bind(siteId, url, name || '', addedAt, 'PENDING', nextSortOrder).run(); // Removed binding

      const siteData = {
        id: siteId,
        url,
        name: name || '',
        added_at: addedAt,
        last_status: 'PENDING',
        sort_order: nextSortOrder
        // Removed enable_frequent_down_notifications
      };

      // Immediately perform a health check for the new site
      const newSiteForCheck = {
        id: siteId,
        url: url,
        name: name || ''
      };
      // Use ctx.waitUntil to perform the check without blocking the response
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(checkWebsiteStatus(newSiteForCheck, env.DB, ctx));
        console.log(`Scheduled immediate health check for new site: ${siteId} (${url})`);
      } else {
        // Fallback if ctx.waitUntil is not available (e.g., local testing without full CF environment)
        console.warn("ctx.waitUntil not available for immediate site check. Attempting direct call (may block).");
        checkWebsiteStatus(newSiteForCheck, env.DB, ctx).catch(e => console.error("Error during direct immediate site check:", e));
      }

      return new Response(JSON.stringify({ site: siteData }), {
        status: 201, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin add site error:", error);
      if (error.message.includes('UNIQUE constraint failed')) {
         return new Response(JSON.stringify({ error: 'URL already exists or ID conflict', message: '该URL已被监控或ID冲突' }), {
           status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders }
         });
      }
      // Basic table check/creation attempt
      if (error.message.includes('no such table')) {
         console.warn("Monitored sites table not found. Attempting to create...");
         try {
           await env.DB.exec(D1_SCHEMAS.monitored_sites);
           return new Response(JSON.stringify({ error: 'Database table created, please retry', message: '数据库表已创建，请重试添加操作' }), {
              status: 503, headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
         } catch (createError) {
            console.error("Failed to create monitored_sites table:", createError);
         }
       }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // 处理管理API - 更新监控站点
  if (path.match(/\/api\/admin\/sites\/[^\/]+$/) && method === 'PUT') {
    try {
      const siteId = path.split('/').pop();
      const { url, name } = await request.json(); // Removed enable_frequent_down_notifications

      let setClauses = [];
      let bindings = [];

      if (url !== undefined) {
        if (!isValidHttpUrl(url)) {
          return new Response(JSON.stringify({ error: 'Valid URL is required if provided' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        setClauses.push("url = ?");
        bindings.push(url);
      }
      if (name !== undefined) {
        setClauses.push("name = ?");
        bindings.push(name || ''); // Ensure empty string if null/undefined
      }
      // Removed enable_frequent_down_notifications handling
      
      if (setClauses.length === 0) {
        return new Response(JSON.stringify({ error: 'No fields to update provided' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      bindings.push(siteId); // Add siteId for the WHERE clause

      const stmt = env.DB.prepare(
        `UPDATE monitored_sites SET ${setClauses.join(', ')} WHERE id = ?`
      );
      const info = await stmt.bind(...bindings).run();

      if (info.changes === 0) {
        return new Response(JSON.stringify({ error: 'Site not found or no changes made' }), {
          status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      const updatedSiteStmt = env.DB.prepare('SELECT id, url, name, added_at, last_checked, last_status, last_status_code, last_response_time_ms, sort_order FROM monitored_sites WHERE id = ?');
      const updatedSite = await updatedSiteStmt.bind(siteId).first();

      return new Response(JSON.stringify({ site: updatedSite }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });

    } catch (error) {
      console.error("Admin update site error:", error);
      if (error.message.includes('UNIQUE constraint failed')) {
         return new Response(JSON.stringify({ error: 'URL already exists for another site', message: '该URL已被其他监控站点使用' }), {
           status: 409, headers: { 'Content-Type': 'application/json', ...corsHeaders }
         });
      }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // 处理管理API - 删除监控站点
  if (path.match(/\/api\/admin\/sites\/[^\/]+$/) && method === 'DELETE') {
    try {
      const siteId = path.split('/').pop();
      const stmt = env.DB.prepare('DELETE FROM monitored_sites WHERE id = ?');
      const info = await stmt.bind(siteId).run();

      if (info.changes === 0) {
        return new Response(JSON.stringify({ error: 'Site not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Admin delete site error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // 处理管理API - 网站排序
  if (path.match(/\/api\/admin\/sites\/[^\/]+\/reorder$/) && method === 'POST') {
    try {
      const siteId = path.split('/')[4]; // Get siteId from path
      const { direction } = await request.json(); // 'up' or 'down'

      if (!direction || (direction !== 'up' && direction !== 'down')) {
        return new Response(JSON.stringify({ error: 'Invalid direction' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      // Get all sites ordered correctly
      const results = await env.DB.batch([
        env.DB.prepare('SELECT id, sort_order FROM monitored_sites ORDER BY sort_order ASC NULLS LAST, name ASC, url ASC')
      ]);
      const allSites = results[0].results;
      const currentIndex = allSites.findIndex(s => s.id === siteId);

      if (currentIndex === -1) {
        return new Response(JSON.stringify({ error: 'Site not found' }), {
          status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      let targetIndex = -1;
      if (direction === 'up' && currentIndex > 0) {
        targetIndex = currentIndex - 1;
      } else if (direction === 'down' && currentIndex < allSites.length - 1) {
        targetIndex = currentIndex + 1;
      }

      if (targetIndex !== -1) {
        const currentSite = allSites[currentIndex];
        const targetSite = allSites[targetIndex];

        // Handle potential NULL sort_order by re-assigning all if needed
        if (currentSite.sort_order === null || targetSite.sort_order === null) {
           console.warn("Reordering sites with NULL sort_order, re-assigning all orders.");
           const updateStmts = allSites.map((site, index) =>
             env.DB.prepare('UPDATE monitored_sites SET sort_order = ? WHERE id = ?').bind(index, site.id)
           );
           await env.DB.batch(updateStmts);
           // Re-fetch updated orders to perform the swap correctly
           const updatedResults = await env.DB.batch([
              env.DB.prepare('SELECT id, sort_order FROM monitored_sites ORDER BY sort_order ASC')
           ]);
           const updatedSites = updatedResults[0].results;
           const newCurrentIndex = updatedSites.findIndex(s => s.id === siteId);
           let newTargetIndex = -1;
           if (direction === 'up' && newCurrentIndex > 0) newTargetIndex = newCurrentIndex - 1;
           else if (direction === 'down' && newCurrentIndex < updatedSites.length - 1) newTargetIndex = newCurrentIndex + 1;

           if (newTargetIndex !== -1) {
              const currentOrder = updatedSites[newCurrentIndex].sort_order;
              const targetOrder = updatedSites[newTargetIndex].sort_order;
              await env.DB.batch([
                env.DB.prepare('UPDATE monitored_sites SET sort_order = ? WHERE id = ?').bind(targetOrder, siteId),
                env.DB.prepare('UPDATE monitored_sites SET sort_order = ? WHERE id = ?').bind(currentOrder, updatedSites[newTargetIndex].id)
              ]);
           }
        } else {
          // Swap existing sort_order values
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
      console.error("Admin reorder site error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }


  // 处理公共API - 获取所有监控站点状态 (URL removed)
  if (path === '/api/sites/status' && method === 'GET') {
     try {
      // Select necessary fields for public view (NO URL)
      // Order by sort_order, then name for public view consistency
      const stmt = env.DB.prepare('SELECT id, name, last_checked, last_status, last_status_code, last_response_time_ms FROM monitored_sites ORDER BY sort_order ASC NULLS LAST, name ASC, id ASC');
      const { results } = await stmt.all();
      return new Response(JSON.stringify({ sites: results || [] }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Get sites status error:", error);
       // Basic table check/creation attempt
      if (error.message.includes('no such table')) {
         console.warn("Monitored sites table not found. Returning empty list and attempting to create...");
         try {
           await env.DB.exec(D1_SCHEMAS.monitored_sites);
           return new Response(JSON.stringify({ sites: [] }), { // Return empty list
             headers: { 'Content-Type': 'application/json', ...corsHeaders }
           });
         } catch (createError) {
            console.error("Failed to create monitored_sites table:", createError);
         }
       }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // --- End Website Monitoring API ---

  // --- App Config Settings API (for VPS report interval) ---
  // GET /api/admin/settings/vps-report-interval
  if (path === '/api/admin/settings/vps-report-interval' && method === 'GET') {
    try {
      const stmt = env.DB.prepare('SELECT value FROM app_config WHERE key = ?');
      const result = await stmt.bind('vps_report_interval_seconds').first();
      const interval = result ? parseInt(result.value, 10) : 60; // Default to 60 if not found

      return new Response(JSON.stringify({ interval: interval }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Get VPS report interval error:", error);
      // Attempt to create table if it doesn't exist
      if (error.message.includes('no such table')) {
        try {
          await env.DB.exec(D1_SCHEMAS.app_config);
          return new Response(JSON.stringify({ interval: 60 }), { // Return default
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (createError) {
          console.error("Failed to create app_config table:", createError);
        }
      }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  // POST /api/admin/settings/vps-report-interval
  if (path === '/api/admin/settings/vps-report-interval' && method === 'POST') {
    try {
      const { interval } = await request.json();
      if (typeof interval !== 'number' || interval <= 0 || !Number.isInteger(interval)) {
        return new Response(JSON.stringify({ error: 'Invalid interval value. Must be a positive integer (seconds).' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }

      const stmt = env.DB.prepare('REPLACE INTO app_config (key, value) VALUES (?, ?)');
      await stmt.bind('vps_report_interval_seconds', interval.toString()).run();

      return new Response(JSON.stringify({ success: true, interval: interval }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Update VPS report interval error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  // --- End App Config Settings API ---


  // --- Telegram Settings API ---
  if (path === '/api/admin/telegram-settings' && method === 'GET') {
    try {
      const stmt = env.DB.prepare('SELECT bot_token, chat_id, enable_notifications FROM telegram_config WHERE id = 1');
      const settings = await stmt.first();
      return new Response(JSON.stringify(settings || { bot_token: null, chat_id: null, enable_notifications: 0 }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Get Telegram settings error:", error);
      // Attempt to create table if it doesn't exist (should be handled by ensureTablesExist)
      if (error.message.includes('no such table')) {
        try {
          await env.DB.exec(D1_SCHEMAS.telegram_config);
          return new Response(JSON.stringify({ bot_token: null, chat_id: null, enable_notifications: 0 }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        } catch (createError) {
          console.error("Failed to create telegram_config table:", createError);
        }
      }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  if (path === '/api/admin/telegram-settings' && method === 'POST') {
    try {
      const { bot_token, chat_id, enable_notifications } = await request.json();
      const updatedAt = Math.floor(Date.now() / 1000);

      // Validate enable_notifications
      const enableNotifValue = (enable_notifications === true || enable_notifications === 1) ? 1 : 0;

      const stmt = env.DB.prepare(
        'UPDATE telegram_config SET bot_token = ?, chat_id = ?, enable_notifications = ?, updated_at = ? WHERE id = 1'
      );
      await stmt.bind(bot_token || null, chat_id || null, enableNotifValue, updatedAt).run();
      
      // Send a test notification if enabled and configured
      if (enableNotifValue === 1 && bot_token && chat_id) {
        const testMessage = "✅ Telegram 通知已在此监控面板激活。这是一条测试消息。"; // Translated
        // We don't want to wait for this, so we use ctx.waitUntil if available, or just let it run
        if (ctx && typeof ctx.waitUntil === 'function') { // Use ctx directly
            ctx.waitUntil(sendTelegramNotification(env.DB, testMessage));
        } else {
            // Fallback if ctx or waitUntil is not available (should not happen in standard CF worker env)
            console.warn("ctx.waitUntil not available for sending test Telegram notification. Attempting direct call.");
            sendTelegramNotification(env.DB, testMessage).catch(e => console.error("Error sending test notification (direct call):", e));
        }
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Update Telegram settings error:", error);
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
  // --- End Telegram Settings API ---

  // 处理公共API - 获取特定监控站点的24小时历史状态
  if (path.match(/\/api\/sites\/[^\/]+\/history$/) && method === 'GET') {
    try {
      const siteId = path.split('/')[3]; // /api/sites/{siteId}/history

      // Fetch last 24 status records for the site
      // Fetch records from the last 24 hours for the site, newest first
      const nowSeconds = Math.floor(Date.now() / 1000);
      const twentyFourHoursAgoSeconds = nowSeconds - (24 * 60 * 60);

      const stmt = env.DB.prepare(
        'SELECT timestamp, status, status_code, response_time_ms FROM site_status_history WHERE site_id = ? AND timestamp >= ? ORDER BY timestamp DESC'
      );
      const { results } = await stmt.bind(siteId, twentyFourHoursAgoSeconds).all();

      return new Response(JSON.stringify({ history: results || [] }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (error) {
      console.error("Get site history error:", error);
      // Basic table check/creation attempt (though ensureTablesExist should handle it)
      if (error.message.includes('no such table')) {
         console.warn("site_status_history table not found. Returning empty list.");
         try {
           await env.DB.exec(D1_SCHEMAS.site_status_history); // Attempt to create if missing
           return new Response(JSON.stringify({ history: [] }), {
             headers: { 'Content-Type': 'application/json', ...corsHeaders }
           });
         } catch (createError) {
            console.error("Failed to create site_status_history table:", createError);
         }
      }
      return new Response(JSON.stringify({ error: 'Internal server error', message: error.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
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

// Helper function to send Telegram notification
async function sendTelegramNotification(db, message) {
  try {
    const configStmt = db.prepare('SELECT bot_token, chat_id, enable_notifications FROM telegram_config WHERE id = 1');
    const config = await configStmt.first();

    if (!config || !config.enable_notifications || !config.bot_token || !config.chat_id) {
      console.log("Telegram notifications are disabled or not configured.");
      return;
    }

    const telegramApiUrl = `https://api.telegram.org/bot${config.bot_token}/sendMessage`;
    const response = await fetch(telegramApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chat_id,
        text: message,
        parse_mode: 'Markdown' // Optional: for formatting
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error(`Failed to send Telegram notification: ${response.status}`, errorData);
    } else {
      console.log("Telegram notification sent successfully.");
    }
  } catch (error) {
    console.error("Error sending Telegram notification:", error);
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

// Combine fetch and scheduled handlers into a single default export
export default {
  async fetch(request, env, ctx) {
    // Ensure tables exist on first request (or periodically)
    // Using ctx.waitUntil to not block the response
    ctx.waitUntil(ensureTablesExist(env.DB));

    const url = new URL(request.url);
    const path = url.pathname;

    // API requests
    if (path.startsWith('/api/')) {
      return handleApiRequest(request, env, ctx); // Pass ctx
    }

    // Install script
    if (path === '/install.sh') {
      return handleInstallScript(request, url);
    }

    // Frontend static files
    return handleFrontendRequest(request, path);
  },

  async scheduled(event, env, ctx) {
    console.log(`Cron Trigger: ${event.cron} - Running website status checks...`);
    ctx.waitUntil(
      (async () => {
        try {
      // Ensure table exists before proceeding
      await ensureTablesExist(env.DB);

      // --- Part 1: Website Monitoring ---
      console.log("Starting scheduled website checks...");
      const siteStmt = env.DB.prepare('SELECT id, url, name FROM monitored_sites');
      const { results: sitesToCheck } = await siteStmt.all();

      if (sitesToCheck && sitesToCheck.length > 0) {
        console.log(`Found ${sitesToCheck.length} sites to check.`);
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
        console.log("Website status checks completed.");
      } else {
        console.log("No sites configured for monitoring.");
      }

      // --- Part 2: VPS Monitoring & Notifications ---
      console.log("开始计划的VPS状态检查以发送通知...");
      const serverConfigStmt = env.DB.prepare('SELECT bot_token, chat_id, enable_notifications FROM telegram_config WHERE id = 1');
      const telegramConfig = await serverConfigStmt.first();

      if (!telegramConfig || !telegramConfig.enable_notifications || !telegramConfig.bot_token || !telegramConfig.chat_id) {
        console.log("VPS的Telegram通知已禁用或未配置。跳过VPS检查。");
        return; // Exit if Telegram is not set up
      }
      
      const serverStmt = env.DB.prepare(`
        SELECT s.id, s.name, s.last_notified_down_at, m.timestamp as last_report
        FROM servers s
        LEFT JOIN metrics m ON s.id = m.server_id
      `); // Removed frequent notification fields
      const { results: serversToCheck } = await serverStmt.all();

      if (!serversToCheck || serversToCheck.length === 0) {
        console.log("未找到用于VPS状态检查的服务器。");
        return;
      }

      console.log(`找到 ${serversToCheck.length} 台服务器进行VPS状态检查。`);
      const nowSeconds = Math.floor(Date.now() / 1000);
      const staleThresholdSeconds = 5 * 60; // 5 minutes
      const NOTIFICATION_INTERVAL_SECONDS = 1 * 60 * 60; // 1 hour

      for (const server of serversToCheck) {
        const isStale = !server.last_report || (nowSeconds - server.last_report > staleThresholdSeconds);
        const serverDisplayName = server.name || server.id;
        const lastReportTimeStr = server.last_report ? new Date(server.last_report * 1000).toLocaleString('zh-CN') : '从未';

        if (isStale) {
          // Server is considered down/stale
          const shouldSendNotification = server.last_notified_down_at === null || (nowSeconds - server.last_notified_down_at > NOTIFICATION_INTERVAL_SECONDS);
          if (shouldSendNotification) {
            const message = `🔴 VPS 故障: 服务器 *${serverDisplayName}* 似乎已离线。最后报告: ${lastReportTimeStr}.`;
            ctx.waitUntil(sendTelegramNotification(env.DB, message));
            const updateStmt = env.DB.prepare('UPDATE servers SET last_notified_down_at = ? WHERE id = ?');
            ctx.waitUntil(updateStmt.bind(nowSeconds, server.id).run());
            console.log(`VPS ${serverDisplayName} 状态陈旧。已发送通知。last_notified_down_at 已更新。`);
          } else {
            console.log(`VPS ${serverDisplayName} 状态陈旧，但1小时通知间隔未到。`);
          }
        } else {
          // Server is reporting (online)
          if (server.last_notified_down_at !== null) {
            // Was previously notified as down, now it's recovered
            const message = `✅ VPS 恢复: 服务器 *${serverDisplayName}* 已恢复在线并正在报告。当前报告: ${lastReportTimeStr}.`;
            ctx.waitUntil(sendTelegramNotification(env.DB, message));
            const updateStmt = env.DB.prepare('UPDATE servers SET last_notified_down_at = NULL WHERE id = ?');
            ctx.waitUntil(updateStmt.bind(server.id).run());
            console.log(`VPS ${serverDisplayName} 已恢复。已发送通知。last_notified_down_at 已清除。`);
          } else {
            // Was online, still online. No action needed.
             console.log(`VPS ${serverDisplayName} 在线并正在报告。无需通知。`);
          }
        }
      }
      console.log("VPS状态检查以发送通知已完成。");

    } catch (error) {
      console.error("计划任务期间发生错误:", error);
    }
  })()
);
}
};


// --- Utility Functions ---

// Basic HTTP/HTTPS URL validation
function isValidHttpUrl(string) {
  let url;
  try {
    url = new URL(string);
  } catch (_) {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}


// --- Original Handlers (Install Script, Frontend) ---

// 处理安装脚本
async function handleInstallScript(request, url, env) { // Added env
  const baseUrl = url.origin;
  let vpsReportInterval = '60'; // Default

  try {
    // Ensure app_config table exists before trying to read from it.
    // This might be redundant if ensureTablesExist runs reliably on every fetch,
    // but good for robustness within this specific function.
    // Check if D1_SCHEMAS.app_config is defined before executing
    if (D1_SCHEMAS && D1_SCHEMAS.app_config) {
        await env.DB.exec(D1_SCHEMAS.app_config);
    } else {
        console.warn("D1_SCHEMAS.app_config is not defined. Skipping creation in handleInstallScript.");
    }
    
    const stmt = env.DB.prepare('SELECT value FROM app_config WHERE key = ?');
    const result = await stmt.bind('vps_report_interval_seconds').first();
    if (result && result.value) {
      const parsedInterval = parseInt(result.value, 10);
      if (!isNaN(parsedInterval) && parsedInterval > 0) {
        vpsReportInterval = parsedInterval.toString();
      }
    }
  } catch (e) {
    console.error("Error fetching VPS report interval for install script:", e);
    // Use default if error, or if table/value doesn't exist yet
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

// 处理前端请求
function handleFrontendRequest(request, path) {
  // 默认页面
  if (path === '/' || path === '') {
    return new Response(getIndexHtml(), {
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  // 登录页面
  if (path === '/login' || path === '/login.html') {
    return new Response(getLoginHtml(), {
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  // 管理页面
  if (path === '/admin' || path === '/admin.html') {
    return new Response(getAdminHtml(), {
      headers: { 'Content-Type': 'text/html' }
    });
  }
  
  // CSS文件
  if (path === '/css/style.css') {
    return new Response(getStyleCss(), {
      headers: { 'Content-Type': 'text/css' }
    });
  }
  
  // JavaScript文件
  if (path === '/js/main.js') {
    return new Response(getMainJs(), {
      headers: { 'Content-Type': 'application/javascript' }
    });
  }
  
  if (path === '/js/login.js') {
    return new Response(getLoginJs(), {
      headers: { 'Content-Type': 'application/javascript' }
    });
  }
  
  if (path === '/js/admin.js') {
    return new Response(getAdminJs(), {
      headers: { 'Content-Type': 'application/javascript' }
    });
  }
  
  // 404页面
  return new Response('Not Found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain' }
  });
}

// 前端HTML、CSS和JavaScript文件内容
function getIndexHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-bs-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VPS监控面板</title>
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
    </style>
</head>
<body>
    <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
        <div class="container">
            <a class="navbar-brand" href="/">VPS监控面板</a>
            <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav">
                <span class="navbar-toggler-icon"></span>
            </button>
            <div class="collapse navbar-collapse" id="navbarNav">
                <ul class="navbar-nav ms-auto align-items-center">
                    <li class="nav-item">
                        <a href="https://github.com/kadidalax/cf-vps-monitor" target="_blank" rel="noopener noreferrer" class="btn btn-outline-light btn-sm me-2" title="GitHub Repository">
                            <i class="bi bi-github"></i>
                        </a>
                    </li>
                    <li class="nav-item">
                        <button id="themeToggler" class="btn btn-outline-light btn-sm me-2" title="切换主题">
                            <i class="bi bi-moon-stars-fill"></i>
                        </button>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link" id="adminAuthLink" href="/login.html">管理员登录</a>
                    </li>
                </ul>
            </div>
        </div>
    </nav>

    <div class="container mt-4">
        <div id="noServers" class="alert alert-info d-none">
            暂无服务器数据，请先登录管理后台添加服务器。
        </div>

        <div class="table-responsive">
            <table class="table table-striped table-hover align-middle">
                <thead>
                    <tr>
                        <th>名称</th>
                        <th>状态</th>
                        <th>CPU</th>
                        <th>内存</th>
                        <th>硬盘</th>
                        <th>上传</th>
                        <th>下载</th>
                        <th>总上传</th>
                        <th>总下载</th>
                        <th>运行时长</th>
                        <th>最后更新</th>
                    </tr>
                </thead>
                <tbody id="serverTableBody">
                    <tr>
                        <td colspan="11" class="text-center">加载中...</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>

    <!-- Website Status Section -->
    <div class="container mt-5">
        <h2>网站在线状态</h2>
        <div id="noSites" class="alert alert-info d-none">
            暂无监控网站数据。
        </div>
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
                    <tr>
                        <td colspan="6" class="text-center">加载中...</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
    <!-- End Website Status Section -->

    <!-- Server Detailed row template (hidden by default) -->
    <template id="serverDetailsTemplate">
        <tr class="server-details-row d-none">
            <td colspan="11">
                <div class="server-details-content">
                    <!-- Detailed metrics will be populated here by JavaScript -->
                </div>
            </td>
        </tr>
    </template>

    <footer class="footer mt-5 py-3 bg-light">
        <div class="container text-center">
            <span class="text-muted">VPS监控面板 &copy; 2025</span>
            <a href="https://github.com/kadidalax/cf-vps-monitor" target="_blank" rel="noopener noreferrer" class="ms-3 text-muted" title="GitHub Repository">
                <i class="bi bi-github fs-5"></i>
            </a>
        </div>
    </footer>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
    <script src="/js/main.js"></script>
</body>
</html>`;
}

function getLoginHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-bs-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录 - VPS监控面板</title>
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
</head>
<body>
    <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
        <div class="container">
            <a class="navbar-brand" href="/">VPS监控面板</a>
            <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav">
                <span class="navbar-toggler-icon"></span>
            </button>
            <div class="collapse navbar-collapse" id="navbarNav">
                <ul class="navbar-nav ms-auto align-items-center">
                    <li class="nav-item">
                        <button id="themeToggler" class="btn btn-outline-light btn-sm me-2" title="切换主题">
                            <i class="bi bi-moon-stars-fill"></i>
                        </button>
                    </li>
                    <li class="nav-item">
                        <a class="nav-link" href="/">返回首页</a>
                    </li>
                </ul>
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
                        <small>初始账号密码: admin / admin</small>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <footer class="footer mt-5 py-3 bg-light">
        <div class="container text-center">
            <span class="text-muted">VPS监控面板 &copy; 2025</span>
            <a href="https://github.com/kadidalax/cf-vps-monitor" target="_blank" rel="noopener noreferrer" class="ms-3 text-muted" title="GitHub Repository">
                <i class="bi bi-github fs-5"></i>
            </a>
        </div>
    </footer>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
    <script src="/js/login.js"></script>
</body>
</html>`;
}

function getAdminHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-bs-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>管理后台 - VPS监控面板</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.8.1/font/bootstrap-icons.css" rel="stylesheet">
    <link href="/css/style.css" rel="stylesheet">
</head>
<body>
    <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
        <div class="container">
            <a class="navbar-brand" href="/">VPS监控面板</a>
            <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav">
                <span class="navbar-toggler-icon"></span>
            </button>
            <div class="collapse navbar-collapse" id="navbarNav">
                <ul class="navbar-nav me-auto">
                    <li class="nav-item">
                        <a class="nav-link" href="/">返回首页</a>
                    </li>
                </ul>
                <ul class="navbar-nav align-items-center">
                    <li class="nav-item">
                        <a href="https://github.com/kadidalax/cf-vps-monitor" target="_blank" rel="noopener noreferrer" class="btn btn-outline-light btn-sm me-2" title="GitHub Repository">
                            <i class="bi bi-github"></i>
                        </a>
                    </li>
                    <li class="nav-item">
                        <button id="themeToggler" class="btn btn-outline-light btn-sm me-2" title="切换主题">
                            <i class="bi bi-moon-stars-fill"></i>
                        </button>
                    </li>
                    <li class="nav-item">
                        <button id="changePasswordBtn" class="btn btn-outline-light btn-sm me-2">修改密码</button>
                    </li>
                    <li class="nav-item">
                        <button id="logoutBtn" class="btn btn-outline-light btn-sm">退出登录</button>
                    </li>
                </ul>
            </div>
        </div>
    </nav>

    <div class="container mt-4">
        <div class="d-flex align-items-center mb-4"> <!-- Main flex container for the header row -->
            <h2 class="mb-0 me-3">服务器管理</h2> <!-- Server Management Heading -->

            <!-- VPS Data Update Frequency Form -->
            <form id="globalSettingsFormPartial" class="row gx-2 gy-2 align-items-center me-auto"> <!-- me-auto pushes Add Server button to the right -->
                <div class="col-auto">
                     <label for="vpsReportInterval" class="col-form-label col-form-label-sm">VPS数据更新频率 (秒):</label>
                </div>
                <div class="col-auto">
                    <input type="number" class="form-control form-control-sm" id="vpsReportInterval" placeholder="例如: 60" min="1" style="width: 100px;">
                </div>
                <div class="col-auto">
                    <button type="button" id="saveVpsReportIntervalBtn" class="btn btn-info btn-sm">保存频率</button>
                </div>
            </form>

            <!-- Add Server Button -->
            <button id="addServerBtn" class="btn btn-primary">
                <i class="bi bi-plus-circle"></i> 添加服务器
            </button>
        </div>
        <!-- Removed globalSettingsAlert as serverAlert will be used -->
        <div id="serverAlert" class="alert d-none"></div>
        <div class="card">
            <div class="card-body">
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
                                <!-- Removed <th>频繁通知 (10分钟)</th> -->
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody id="serverTableBody">
                            <tr>
                                <td colspan="10" class="text-center">加载中...</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>

    <!-- Website Monitoring Section -->
    <div class="container mt-5">
        <div class="d-flex justify-content-between align-items-center mb-4">
            <h2>网站监控管理</h2>
            <button id="addSiteBtn" class="btn btn-success">
                <i class="bi bi-plus-circle"></i> 添加监控网站
            </button>
        </div>

        <div id="siteAlert" class="alert d-none"></div>

        <div class="card">
            <div class="card-body">
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
                                <!-- Removed <th>频繁通知 (10分钟)</th> -->
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody id="siteTableBody">
                            <tr>
                                <td colspan="10" class="text-center">加载中...</td>
                            </tr>
                        </tbody>
                    </table>
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

                        <div id="workerUrlDisplayGroup" class="mb-3 d-none">
                            <label for="workerUrlDisplay" class="form-label">Worker 地址</label>
                            <div class="input-group">
                                <input type="text" class="form-control" id="workerUrlDisplay" readonly>
                                <button class="btn btn-outline-secondary" type="button" id="copyWorkerUrlBtn">
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
            <span class="text-muted">VPS监控面板 &copy; 2025</span>
            <a href="https://github.com/kadidalax/cf-vps-monitor" target="_blank" rel="noopener noreferrer" class="ms-3 text-muted" title="GitHub Repository">
                <i class="bi bi-github fs-5"></i>
            </a>
        </div>
    </footer>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/js/bootstrap.bundle.min.js"></script>
    <script src="/js/admin.js"></script>
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
`;
}

function getMainJs() {
  return `// main.js - 首页面的JavaScript逻辑

// Global variables
let vpsUpdateInterval = null;
let siteUpdateInterval = null;
let serverDataCache = {}; // Cache server data to avoid re-fetching for details
const DEFAULT_VPS_REFRESH_INTERVAL_MS = 60000; // Default to 60 seconds for VPS data if backend setting fails
const DEFAULT_SITE_REFRESH_INTERVAL_MS = 60000; // Default to 60 seconds for Site data

// Function to fetch VPS refresh interval and start periodic VPS data updates
async function initializeVpsDataUpdates() {
    let vpsRefreshIntervalMs = DEFAULT_VPS_REFRESH_INTERVAL_MS;
    try {
        const response = await fetch('/api/admin/settings/vps-report-interval'); // This API is public for GET
        if (response.ok) {
            const data = await response.json();
            if (data && typeof data.interval === 'number' && data.interval > 0) {
                vpsRefreshIntervalMs = data.interval * 1000; // Convert seconds to milliseconds
                console.log(\`Using backend-defined VPS refresh interval: \${data.interval}s\`);
            } else {
                console.warn('Invalid VPS interval from backend, using default.');
            }
        } else {
            console.warn('Failed to fetch VPS refresh interval from backend, using default.');
        }
    } catch (error) {
        console.error('Error fetching VPS refresh interval, using default:', error);
    }

    // Clear existing interval if any
    if (vpsUpdateInterval) {
        clearInterval(vpsUpdateInterval);
    }

    // Set up new periodic updates for VPS data ONLY
    vpsUpdateInterval = setInterval(() => {
        loadAllServerStatuses();
    }, vpsRefreshIntervalMs);

    console.log(\`VPS data will refresh every \${vpsRefreshIntervalMs / 1000} seconds.\`);
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

// Execute after the page loads
document.addEventListener('DOMContentLoaded', function() {
    // Initialize theme
    initializeTheme();

    // Load initial data
    loadAllServerStatuses();
    loadAllSiteStatuses();

    // Initialize periodic updates separately
    initializeVpsDataUpdates();
    initializeSiteDataUpdates();

    // Add click event listener to the table body for row expansion
    document.getElementById('serverTableBody').addEventListener('click', handleRowClick);

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

        const response = await fetch('/api/auth/status', {
            headers: {
                'Authorization': \`Bearer \${token}\`
            }
        });

        if (response.ok) {
            const data = await response.json();
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
        } else {
            // API error, assume not logged in
            adminLink.textContent = '管理员登录';
            adminLink.href = '/login.html';
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
                总计: \${metrics.disk.total.toFixed(2)} GB<br>
                已用: \${metrics.disk.used.toFixed(2)} GB<br>
                空闲: \${metrics.disk.free.toFixed(2)} GB
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
    try {
        // 1. Get server list
        const serversResponse = await fetch('/api/servers');
        if (!serversResponse.ok) {
            throw new Error('Failed to get server list');
        }
        const serversData = await serversResponse.json();
        const servers = serversData.servers || [];

        const noServersAlert = document.getElementById('noServers');
        const serverTableBody = document.getElementById('serverTableBody');

        if (servers.length === 0) {
            noServersAlert.classList.remove('d-none');
            serverTableBody.innerHTML = '<tr><td colspan="11" class="text-center">No server data available. Please log in to the admin panel to add servers.</td></tr>';
            // Remove any existing detail rows if the server list becomes empty
            removeAllDetailRows();
            return;
        } else {
            noServersAlert.classList.add('d-none');
        }

        // 2. Fetch status for all servers in parallel
        const statusPromises = servers.map(server =>
            fetch(\`/api/status/\${server.id}\`)
                .then(res => res.ok ? res.json() : Promise.resolve({ server: server, metrics: null, error: true }))
                .catch(() => Promise.resolve({ server: server, metrics: null, error: true }))
        );

        const allStatuses = await Promise.all(statusPromises);

        // Update the serverDataCache with the latest data
        allStatuses.forEach(data => {
             serverDataCache[data.server.id] = data;
        });


        // 3. Render the table using DOM manipulation
        renderServerTable(allStatuses);

    } catch (error) {
        console.error('Error loading server statuses:', error);
        const serverTableBody = document.getElementById('serverTableBody');
        serverTableBody.innerHTML = '<tr><td colspan="11" class="text-center text-danger">Failed to load server data. Please refresh the page.</td></tr>';
         removeAllDetailRows();
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


// Render the server table using DOM manipulation
function renderServerTable(allStatuses) {
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

    tableBody.innerHTML = ''; // Clear existing rows

    allStatuses.forEach(data => {
        const serverId = data.server.id;
        const serverName = data.server.name;
        const metrics = data.metrics;
        const hasError = data.error;

        let statusBadge = '<span class="badge bg-secondary">未知</span>';
        let cpuHtml = '-';
        let memoryHtml = '-';
        let diskHtml = '-';
        let uploadSpeed = '-';
        let downloadSpeed = '-';
        let totalUpload = '-';
        let totalDownload = '-';
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

        // Create the main row
        const mainRow = document.createElement('tr');
        mainRow.classList.add('server-row');
        mainRow.setAttribute('data-server-id', serverId);
        mainRow.innerHTML = \`
            <td>\${serverName}</td>
            <td>\${statusBadge}</td>
            <td>\${cpuHtml}</td>
            <td>\${memoryHtml}</td>
            <td>\${diskHtml}</td>
            <td><span style="color: #000;">\${uploadSpeed}</span></td>
            <td><span style="color: #000;">\${downloadSpeed}</span></td>
            <td><span style="color: #000;">\${totalUpload}</span></td>
            <td><span style="color: #000;">\${totalDownload}</span></td>
            <td><span style="color: #000;">\${uptime}</span></td>
            <td><span style="color: #000;">\${lastUpdate}</span></td>
        \`;

        // Clone the details row template
        const detailsRowElement = detailsTemplate.content.cloneNode(true).querySelector('tr');
        // The template has d-none by default. We will remove it if needed.
        // Set a unique attribute for easier selection if needed, though direct reference is used here.
        // detailsRowElement.setAttribute('data-detail-for', serverId); 

        tableBody.appendChild(mainRow);
        tableBody.appendChild(detailsRowElement);

        // 2. If this server was previously expanded, re-expand it and populate its details
        if (expandedServerIds.has(serverId)) {
            detailsRowElement.classList.remove('d-none');
            populateDetailsRow(serverId, detailsRowElement); // Populate content
        }
    });
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
        const response = await fetch('/api/sites/status');
        if (!response.ok) {
            throw new Error('Failed to get website status list');
        }
        const data = await response.json();
        const sites = data.sites || [];

        const noSitesAlert = document.getElementById('noSites');
        const siteStatusTableBody = document.getElementById('siteStatusTableBody');

        if (sites.length === 0) {
            noSitesAlert.classList.remove('d-none');
            siteStatusTableBody.innerHTML = '<tr><td colspan="6" class="text-center">No websites are being monitored.</td></tr>'; // Colspan updated
            return;
        } else {
            noSitesAlert.classList.add('d-none');
        }

        renderSiteStatusTable(sites);

    } catch (error) {
        console.error('Error loading website statuses:', error);
        const siteStatusTableBody = document.getElementById('siteStatusTableBody');
        siteStatusTableBody.innerHTML = '<tr><td colspan="6" class="text-center text-danger">Failed to load website status data. Please refresh the page.</td></tr>'; // Colspan updated
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
        historyCell.innerHTML = '<div class="history-bar-container"></div>'; // Placeholder

        row.innerHTML = \`
            <td>\${site.name || '-'}</td>
            <td><span class="badge \${statusInfo.class}">\${statusInfo.text}</span></td>
            <td>\${site.last_status_code || '-'}</td>
            <td>\${responseTime}</td>
            <td>\${lastCheckTime}</td>
        \`;
        row.appendChild(historyCell);
        tableBody.appendChild(row);

        // Asynchronously fetch and render history for this site
        fetchAndRenderSiteHistory(site.id, historyCell.querySelector('.history-bar-container'));
    }
}

// Fetch and render 24h history for a site
async function fetchAndRenderSiteHistory(siteId, containerElement) {
    try {
        const response = await fetch(\`/api/sites/\${siteId}/history\`);
        if (!response.ok) {
            console.warn(\`Failed to fetch history for site \${siteId}\`);
            containerElement.innerHTML = '<small class="text-muted">Error fetching</small>';
            return;
        }
        const data = await response.json();
        const fetchedHistory = data.history || []; // API now returns newest first

        let historyHtml = '';
        const now = new Date();
        
        // Iterate over the last 24 hours, i=0 is current hour's slot, i=23 is 23 hours ago's slot
        for (let i = 0; i < 24; i++) {
            const slotTime = new Date(now);
            slotTime.setHours(now.getHours() - i); // Sets the hour for the slot (e.g., if now=4:30, i=0 -> 4:xx, i=1 -> 3:xx)

            const slotStart = new Date(slotTime);
            slotStart.setMinutes(0, 0, 0); // Start of that hour, e.g., 4:00:00

            const slotEnd = new Date(slotTime);
            slotEnd.setMinutes(59, 59, 999); // End of that hour, e.g., 4:59:59

            const slotStartTimestamp = Math.floor(slotStart.getTime() / 1000);
            const slotEndTimestamp = Math.floor(slotEnd.getTime() / 1000);

            // Find the most recent record within this hour slot
            // fetchedHistory is newest first, so the first match is the most recent in the slot
            const recordForHour = fetchedHistory.find(
                r => r.timestamp >= slotStartTimestamp && r.timestamp <= slotEndTimestamp
            );

            let barClass = 'history-bar-pending';
            // Display slot time, e.g., "04:00 - 05:00"
            let titleText = \`\${String(slotStart.getHours()).padStart(2, '0')}:00 - \${String((slotStart.getHours() + 1) % 24).padStart(2, '0')}:00: No record\`;

            if (recordForHour) {
                if (recordForHour.status === 'UP') {
                    barClass = 'history-bar-up';
                } else if (['DOWN', 'TIMEOUT', 'ERROR'].includes(recordForHour.status)) {
                    barClass = 'history-bar-down';
                }
                const recordDate = new Date(recordForHour.timestamp * 1000);
                // Keep detailed title if record exists
                titleText = \`\${recordDate.toLocaleString()}: \${recordForHour.status} (\${recordForHour.status_code || 'N/A'}), \${recordForHour.response_time_ms || '-'}ms\`;
            }
            // Append HTML. With flex-direction:row-reverse, first DOM element is rightmost.
            // i=0 (current hour slot) is added first, so it will be the rightmost.
            historyHtml += \`<div class="history-bar \${barClass}" title="\${titleText}"></div>\`;
        }
        
        if (!historyHtml) {
             containerElement.innerHTML = '<small class="text-muted">No records for last 24h</small>';
        } else {
             containerElement.innerHTML = historyHtml;
        }

    } catch (error) {
        console.error(\`Error fetching/rendering history for site \${siteId}:\`, error);
        containerElement.innerHTML = '<small class="text-muted">Error rendering</small>';
    }
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
    
    // 检查是否已登录
    checkLoginStatus();
});

// 检查登录状态
async function checkLoginStatus() {
    try {
        // 从localStorage获取token
        const token = localStorage.getItem('auth_token');
        if (!token) {
            return;
        }
        
        const response = await fetch('/api/auth/status', {
            headers: {
                'Authorization': \`Bearer \${token}\`
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            if (data.authenticated) {
                // 已登录，重定向到管理后台
                window.location.href = 'admin.html';
            }
        }
    } catch (error) {
        console.error('检查登录状态错误:', error);
    }
}

// 登录函数
async function login(username, password) {
    try {
        // 显示加载状态
        const submitBtn = loginForm.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 登录中...';
        
        // 发送登录请求
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password })
        });
        
        // 恢复按钮状态
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalBtnText;
        
        if (response.ok) {
            const data = await response.json();
            // 保存token到localStorage
            localStorage.setItem('auth_token', data.token);
            // 登录成功，重定向到管理后台
            window.location.href = 'admin.html';
        } else {
            // 登录失败
            const data = await response.json();
            showLoginError(data.message || '用户名或密码错误');
        }
    } catch (error) {
        console.error('登录错误:', error);
        showLoginError('登录请求失败，请稍后重试');
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


// 全局变量
let currentServerId = null;
let currentSiteId = null; // For site deletion
let serverList = [];
let siteList = []; // For monitored sites

// 页面加载完成后执行
document.addEventListener('DOMContentLoaded', function() {
    // Initialize theme
    initializeTheme();

    // 检查登录状态
    checkLoginStatus();
    
    // 初始化事件监听
    initEventListeners();
    
    // 加载服务器列表
    loadServerList();
    // 加载监控网站列表
    loadSiteList();
    // 加载Telegram设置
    loadTelegramSettings();
    // 加载全局设置 (VPS Report Interval) - will use serverAlert for notifications
    loadGlobalSettings();
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
        
        const response = await fetch('/api/auth/status', {
            headers: {
                'Authorization': \`Bearer \${token}\`
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            if (!data.authenticated) {
                // 未登录，重定向到登录页面
                window.location.href = 'login.html';
            }
        } else {
            // 请求失败，重定向到登录页面
            window.location.href = 'login.html';
        }
    } catch (error) {
        console.error('检查登录状态错误:', error);
        window.location.href = 'login.html';
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
    
    // 修改密码按钮
    document.getElementById('changePasswordBtn').addEventListener('click', function() {
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
}

// 获取认证头
function getAuthHeaders() {
    const token = localStorage.getItem('auth_token');
    return {
        'Content-Type': 'application/json',
        'Authorization': \`Bearer \${token}\`
    };
}

// 加载服务器列表
async function loadServerList() {
    try {
        const response = await fetch('/api/admin/servers', {
            headers: getAuthHeaders()
        });
        
        if (!response.ok) {
            throw new Error('获取服务器列表失败');
        }
        
        const data = await response.json();
        serverList = data.servers || [];
        
        renderServerTable(serverList);
    } catch (error) {
        console.error('加载服务器列表错误:', error);
        showAlert('danger', '加载服务器列表失败，请刷新页面重试。');
    }
}


// --- Server Management Functions ---

// 加载服务器列表
async function loadServerList() {
    try {
        const response = await fetch('/api/admin/servers', {
            headers: getAuthHeaders()
        });

        if (!response.ok) {
            throw new Error('获取服务器列表失败');
        }

        const data = await response.json();
        serverList = data.servers || [];

        renderServerTable(serverList);
    } catch (error) {
        console.error('加载服务器列表错误:', error);
        showAlert('danger', '加载服务器列表失败，请刷新页面重试。', 'serverAlert');
    }
}

// 渲染服务器表格
function renderServerTable(servers) {
    const tableBody = document.getElementById('serverTableBody');
    tableBody.innerHTML = '';
    
    if (servers.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="9" class="text-center">暂无服务器数据</td>'; // Updated colspan
        tableBody.appendChild(row);
        return;
    }
    
    servers.forEach((server, index) => {
        const row = document.createElement('tr');
        
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
        
        row.innerHTML = \`
            <td>
                <div class="btn-group">
                     <button class="btn btn-sm btn-outline-secondary move-server-btn" data-id="\${server.id}" data-direction="up" \${index === 0 ? 'disabled' : ''}>
                        <i class="bi bi-arrow-up"></i>
                    </button>
                     <button class="btn btn-sm btn-outline-secondary move-server-btn" data-id="\${server.id}" data-direction="down" \${index === servers.length - 1 ? 'disabled' : ''}>
                        <i class="bi bi-arrow-down"></i>
                    </button>
                </div>
            </td>
            <td>\${server.id}</td>
            <td>\${server.name}</td>
            <td>\${server.description || '-'}</td>
            <td>\${statusBadge}</td>
            <td>\${lastUpdateText}</td>
            <td>
                <button class="btn btn-sm btn-outline-secondary view-key-btn" data-id="\${server.id}">
                    <i class="bi bi-key"></i> 查看密钥
                </button>
            </td>
            <td>
                <button class="btn btn-sm btn-outline-info copy-vps-script-btn" data-id="\${server.id}" data-name="\${server.name}" title="复制VPS安装脚本">
                    <i class="bi bi-clipboard-plus"></i> 复制脚本
                </button>
            </td>
            <!-- Removed frequent notification toggle column -->
            <td>
                <div class="btn-group">
                    <button class="btn btn-sm btn-outline-primary edit-server-btn" data-id="\${server.id}">
                        <i class="bi bi-pencil"></i>
                    </button>
                    <button class="btn btn-sm btn-outline-danger delete-server-btn" data-id="\${server.id}" data-name="\${server.name}">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </td>
        \`;

        tableBody.appendChild(row);
    });
    
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

    // Removed event listener for server-frequent-notify-toggle as it's deleted from HTML
}


// Function to copy VPS installation script
async function copyVpsInstallScript(serverId, serverName, buttonElement) {
    const originalButtonHtml = buttonElement.innerHTML;
    buttonElement.disabled = true;
    buttonElement.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 获取中...';

    try {
        const apiKeyResponse = await fetch(\`/api/admin/servers/\${serverId}/key\`, {
            headers: getAuthHeaders()
        });

        if (!apiKeyResponse.ok) {
            const errorData = await apiKeyResponse.json().catch(() => ({}));
            throw new Error(errorData.message || '获取API密钥失败');
        }
        const apiKeyData = await apiKeyResponse.json();
        const apiKey = apiKeyData.api_key;

        if (!apiKey) {
            throw new Error('未能获取到API密钥');
        }

        // Fetch the current global VPS report interval
        let vpsReportInterval = 60; // Default if fetch fails
        try {
            const intervalResponse = await fetch('/api/admin/settings/vps-report-interval', { headers: getAuthHeaders() });
            if (intervalResponse.ok) {
                const intervalData = await intervalResponse.json();
                if (intervalData && typeof intervalData.interval === 'number' && intervalData.interval > 0) {
                    vpsReportInterval = intervalData.interval;
                }
            } else {
                console.warn('Failed to fetch VPS report interval for script, using default.');
            }
        } catch (e) {
            console.warn('Error fetching VPS report interval for script, using default:', e);
        }
        
        const workerUrl = window.location.origin;
        // The base script command provided by the user
        const baseScriptUrl = "https://raw.githubusercontent.com/aisuyi065/cf-vps-monitor/main/cf-vps-monitor.sh";
        // Include the fetched interval in the script command
        const scriptCommand = \`wget \${baseScriptUrl} -O cf-vps-monitor.sh && chmod +x cf-vps-monitor.sh && ./cf-vps-monitor.sh -i -k \${apiKey} -s \${serverId} -u \${workerUrl} --interval \${vpsReportInterval}\`;
        
        await navigator.clipboard.writeText(scriptCommand);
        
        buttonElement.innerHTML = '<i class="bi bi-check-lg"></i> 已复制!';
        buttonElement.classList.remove('btn-outline-info');
        buttonElement.classList.add('btn-success');
        
        showAlert('success', \`服务器 "\${serverName}" 的安装脚本已复制到剪贴板。\`, 'serverAlert');

    } catch (error) {
        console.error('复制VPS安装脚本错误:', error);
        showAlert('danger', \`复制脚本失败: \${error.message}\`, 'serverAlert');
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

// 移动服务器顺序
async function moveServer(serverId, direction) {
    try {
        const response = await fetch(\`/api/admin/servers/\${serverId}/reorder\`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ direction })
        });

        if (!response.ok) {
             const errorData = await response.json();
             throw new Error(errorData.message || '移动服务器失败');
        }

        // 重新加载列表以反映新顺序
        await loadServerList();
        showAlert('success', '服务器已成功' + (direction === 'up' ? '上移' : '下移'));

    } catch (error) {
        console.error('移动服务器错误:', error);
        showAlert('danger', \`移动服务器失败: \${error.message}\`, 'serverAlert');
    }
}

// 显示服务器模态框（添加模式）
function showServerModal() {
    // 重置表单
    document.getElementById('serverForm').reset();
    document.getElementById('serverId').value = '';
    document.getElementById('apiKeyGroup').classList.add('d-none');
    document.getElementById('serverIdDisplayGroup').classList.add('d-none');
    document.getElementById('workerUrlDisplayGroup').classList.add('d-none');
    
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
        let response;
        let data;
        
        if (serverId) {
            // 更新服务器
            response = await fetch(\`/api/admin/servers/\${serverId}\`, {
                method: 'PUT',
                headers: getAuthHeaders(),
                body: JSON.stringify({
                    name: serverName,
                    description: serverDescription
                    // enable_frequent_down_notifications: enableFrequentNotifications // Removed
                })
            });
        } else {
            // 添加服务器
            response = await fetch('/api/admin/servers', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({
                    name: serverName,
                    description: serverDescription
                    // enable_frequent_down_notifications: enableFrequentNotifications // Removed
                })
            });
        }
        
        if (!response.ok) {
            throw new Error('保存服务器失败');
        }
        
        data = await response.json();
        
        // 隐藏模态框
        const serverModal = bootstrap.Modal.getInstance(document.getElementById('serverModal'));
        serverModal.hide();
        
        // 如果是新添加的服务器，显示API密钥
        if (!serverId && data.server && data.server.api_key) {
            showApiKey(data.server);
        } else {
            // 重新加载服务器列表
            loadServerList();
            showAlert('success', serverId ? '服务器更新成功' : '服务器添加成功');
        }
    } catch (error) {
        console.error('保存服务器错误:', error);
        showAlert('danger', '保存服务器失败，请稍后重试', 'serverAlert');
    }
}

// 查看API密钥
async function viewApiKey(serverId) {
    try {
        const response = await fetch(\`/api/admin/servers/\${serverId}/key\`, {
            headers: getAuthHeaders()
        });
        
        if (!response.ok) {
            throw new Error('获取API密钥失败');
        }
        const data = await response.json();
        if (data.api_key) {
            // Find the server details from the cached list
            const server = serverList.find(s => s.id === serverId);
            if (server) {
                // Create a temporary object with the fetched key
                const serverWithKey = { ...server, api_key: data.api_key };
                showApiKey(serverWithKey); // Pass the complete server object
            } else {
                 showAlert('danger', '未找到服务器信息', 'serverAlert');
            }
        } else {
            showAlert('danger', '获取API密钥失败', 'serverAlert');
        }
    } catch (error) {
        console.error('查看API密钥错误:', error);
        showAlert('danger', '获取API密钥失败，请稍后重试', 'serverAlert');
    }
}

// 显示API密钥
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
        const response = await fetch(\`/api/admin/servers/\${serverId}\`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        
        if (!response.ok) {
            throw new Error('删除服务器失败');
        }
        
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

// 移动网站顺序
async function moveSite(siteId, direction) {
    try {
        const response = await fetch(\`/api/admin/sites/\${siteId}/reorder\`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ direction })
        });

        if (!response.ok) {
             const errorData = await response.json().catch(() => ({}));
             throw new Error(errorData.message || '移动网站失败');
        }

        // 重新加载列表以反映新顺序
        await loadSiteList();
        showAlert('success', '网站已成功' + (direction === 'up' ? '上移' : '下移'), 'siteAlert');

    } catch (error) {
        console.error('移动网站错误:', error);
        showAlert('danger', \`移动网站失败: \${error.message}\`, 'siteAlert');
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
        const response = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                current_password: currentPassword,
                new_password: newPassword
            })
        });
        
        if (response.ok) {
            // 隐藏模态框
            const passwordModal = bootstrap.Modal.getInstance(document.getElementById('passwordModal'));
            passwordModal.hide();
            
            showAlert('success', '密码修改成功', 'serverAlert'); // Use main alert
        } else {
            const data = await response.json();
            showPasswordAlert('danger', data.message || '密码修改失败');
        }
    } catch (error) {
        console.error('修改密码错误:', error);
        showPasswordAlert('danger', '密码修改请求失败，请稍后重试');
    }
}


// --- Auth Functions ---

// 退出登录
function logout() {
    // 清除localStorage中的token
    localStorage.removeItem('auth_token');
    
    // 重定向到登录页面
    window.location.href = 'login.html';
}


// --- Site Monitoring Functions ---

// 加载监控网站列表
async function loadSiteList() {
    try {
        const response = await fetch('/api/admin/sites', {
            headers: getAuthHeaders()
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || '获取监控网站列表失败');
        }
        const data = await response.json();
        siteList = data.sites || [];
        renderSiteTable(siteList);
    } catch (error) {
        console.error('加载监控网站列表错误:', error);
        showAlert('danger', \`加载监控网站列表失败: \${error.message}\`, 'siteAlert');
    }
}

// 渲染监控网站表格
function renderSiteTable(sites) {
    const tableBody = document.getElementById('siteTableBody');
    tableBody.innerHTML = '';

    if (sites.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="9" class="text-center">暂无监控网站</td></tr>'; // Colspan updated
        return;
    }

    sites.forEach((site, index) => { // Added index for sorting buttons
        const row = document.createElement('tr');
        const statusInfo = getSiteStatusBadge(site.last_status);
        const lastCheckTime = site.last_checked ? new Date(site.last_checked * 1000).toLocaleString() : '从未';
        const responseTime = site.last_response_time_ms !== null ? \`\${site.last_response_time_ms} ms\` : '-';

        row.innerHTML = \`
             <td>
                <div class="btn-group btn-group-sm">
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
            <!-- Removed frequent notification toggle column -->
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

    // Removed event listener for site-frequent-notify-toggle as it's deleted from HTML
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
        const response = await fetch(apiUrl, {
            method: method,
            headers: getAuthHeaders(),
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || \`\${siteId ? '更新' : '添加'}网站失败 (\${response.status})\`);
        }
        
        const responseData = await response.json();

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
        const response = await fetch(\`/api/admin/sites/\${siteId}\`, {
            method: 'DELETE',
            headers: getAuthHeaders()
        });

        if (!response.ok) {
             const errorData = await response.json().catch(() => ({}));
             throw new Error(errorData.message || \`删除网站失败 (\${response.status})\`);
        }

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
function showAlert(type, message, alertId = 'serverAlert') {
    const alertElement = document.getElementById(alertId);
    if (!alertElement) return; // Exit if alert element doesn't exist
    alertElement.className = \`alert alert-\${type}\`;
    alertElement.textContent = message;
    alertElement.classList.remove('d-none');
    
    // 5秒后自动隐藏
    setTimeout(() => {
        alertElement.classList.add('d-none');
    }, 5000);
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
        const response = await fetch('/api/admin/telegram-settings', {
            headers: getAuthHeaders()
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || '获取Telegram设置失败');
        }
        const settings = await response.json();
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
        const response = await fetch('/api/admin/telegram-settings', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                bot_token: botToken,
                chat_id: chatId,
                enable_notifications: enableNotifications // Use the potentially modified value
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || '保存Telegram设置失败');
        }
        
        await response.json(); // Consume response body
        showAlert('success', 'Telegram设置已成功保存。', 'telegramSettingsAlert');

    } catch (error) {
        console.error('保存Telegram设置错误:', error);
    showAlert('danger', \`保存Telegram设置失败: \${error.message}\`, 'telegramSettingsAlert');
    }
}

// --- Global Settings Functions (VPS Report Interval) ---
async function loadGlobalSettings() {
    try {
        const response = await fetch('/api/admin/settings/vps-report-interval', {
            headers: getAuthHeaders()
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || '获取VPS报告间隔失败');
        }
        const settings = await response.json();
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
        const response = await fetch('/api/admin/settings/vps-report-interval', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ interval: interval })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || '保存VPS报告间隔失败');
        }
        
        await response.json(); // Consume response body
        showAlert('success', 'VPS数据更新频率已成功保存。', 'serverAlert'); // Changed to serverAlert
        // Optionally, reload the value to confirm, though API returns it
        // loadGlobalSettings(); 
    } catch (error) {
        console.error('保存VPS报告间隔错误:', error);
        showAlert('danger', \`保存VPS报告间隔失败: \${error.message}\`, 'serverAlert'); // Changed to serverAlert
    }
}
`;
}
