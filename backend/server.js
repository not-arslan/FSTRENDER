const express = require('express');
const cors = require('cors');
const axios = require('axios');
const WebSocket = require('ws');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cron = require('node-cron');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Environment validation
const requiredEnvVars = ['ANGEL_ONE_API_KEY'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || ['http://localhost:3000', 'http://127.0.0.1:5500'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { success: false, message: 'Too many requests from this IP, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

// Angel One SmartAPI configuration
const SMART_API_CONFIG = {
  baseURL: 'https://apiconnect.angelbroking.com',
  timeout: 30000
};

// In-memory cache for storing data
const cache = {
  userSessions: new Map(),
  marketData: new Map(),
  watchlist: new Map(),
  portfolios: new Map(),
  optionChain: new Map(),
  pcrData: new Map(),
  sentimentData: new Map(),
  historicalData: new Map()
};

// Utility functions
const getClientIP = (req) => {
  return req.headers['x-forwarded-for'] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress ||
         (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
         '127.0.0.1';
};

const errorResponse = (res, statusCode, message, error = null) => {
  res.status(statusCode).json({
    success: false,
    message,
    timestamp: new Date().toISOString(),
    ...(process.env.NODE_ENV === 'development' && error && { 
      error: error.message,
      stack: error.stack 
    })
  });
};

const successResponse = (res, data, message = 'Success') => {
  res.json({
    success: true,
    message,
    data,
    timestamp: new Date().toISOString()
  });
};

// Input validation middleware
const validateLoginInput = (req, res, next) => {
  const { clientId, password, totp } = req.body;
  
  if (!clientId || !password || !totp) {
    return errorResponse(res, 400, 'Client ID, password, and TOTP are required');
  }
  
  if (typeof clientId !== 'string' || typeof password !== 'string' || typeof totp !== 'string') {
    return errorResponse(res, 400, 'Invalid input format');
  }
  
  next();
};

const validateSession = (req, res, next) => {
  const sessionId = req.headers['x-session-id'];
  
  if (!sessionId) {
    return errorResponse(res, 401, 'Session ID required');
  }
  
  const session = cache.userSessions.get(sessionId);
  if (!session) {
    return errorResponse(res, 401, 'Invalid or expired session');
  }
  
  // Check session timeout (8 hours)
  const sessionTimeout = 8 * 60 * 60 * 1000;
  if (Date.now() - session.loginTime > sessionTimeout) {
    cache.userSessions.delete(sessionId);
    return errorResponse(res, 401, 'Session expired');
  }
  
  req.session = session;
  next();
};

// Enhanced SmartAPI client
class SmartAPIClient {
  constructor() {
    this.baseURL = SMART_API_CONFIG.baseURL;
    this.jwtToken = null;
    this.refreshToken = null;
    this.feedToken = null;
  }

  getHeaders(jwtToken = null, clientIP = '127.0.0.1') {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': clientIP,
      'X-ClientPublicIP': clientIP,
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': process.env.ANGEL_ONE_API_KEY,
      ...(jwtToken && { 'Authorization': `Bearer ${jwtToken}` })
    };
  }

  async makeRequest(endpoint, method = 'GET', data = null, jwtToken = null, clientIP = '127.0.0.1') {
    try {
      const config = {
        method,
        url: `${this.baseURL}${endpoint}`,
        headers: this.getHeaders(jwtToken, clientIP),
        timeout: SMART_API_CONFIG.timeout
      };

      if (data && (method === 'POST' || method === 'PUT')) {
        config.data = data;
      }

      const response = await axios(config);
      return response.data;
    } catch (error) {
      console.error(`API Error [${method} ${endpoint}]:`, error.response?.data || error.message);
      throw new Error(`API request failed: ${error.response?.data?.message || error.message}`);
    }
  }

  // User authentication
  async login(clientId, password, totp, clientIP = '127.0.0.1') {
    try {
      const data = await this.makeRequest('/rest/auth/angelbroking/user/v1/loginByPassword', 'POST', {
        clientcode: clientId,
        password: password,
        totp: totp
      }, null, clientIP);

      if (data.status) {
        this.jwtToken = data.data.jwtToken;
        this.refreshToken = data.data.refreshToken;
        this.feedToken = data.data.feedToken;
        
        return { success: true, data: data.data };
      }
      
      return { success: false, message: data.message || 'Login failed' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  // User profile
  async getUserProfile(jwtToken, clientIP = '127.0.0.1') {
    return await this.makeRequest('/rest/secure/angelbroking/user/v1/getProfile', 'GET', null, jwtToken, clientIP);
  }

  // Market data
  async getMarketData(jwtToken, exchange, tradingSymbol, symbolToken, clientIP = '127.0.0.1') {
    return await this.makeRequest('/rest/secure/angelbroking/market/v1/getMarketData', 'POST', {
      exchange,
      tradingsymbol: tradingSymbol,
      symboltoken: symbolToken
    }, jwtToken, clientIP);
  }

  // Portfolio methods
  async getHoldings(jwtToken, clientIP = '127.0.0.1') {
    return await this.makeRequest('/rest/secure/angelbroking/portfolio/v1/getHolding', 'GET', null, jwtToken, clientIP);
  }

  async getPositions(jwtToken, clientIP = '127.0.0.1') {
    return await this.makeRequest('/rest/secure/angelbroking/order/v1/getPosition', 'GET', null, jwtToken, clientIP);
  }

  // Search and historical data
  async searchInstruments(jwtToken, exchange, searchText, clientIP = '127.0.0.1') {
    return await this.makeRequest('/rest/secure/angelbroking/order/v1/searchScrip', 'POST', {
      exchange,
      searchscrip: searchText
    }, jwtToken, clientIP);
  }

  async getHistoricalData(jwtToken, exchange, symboltoken, interval, fromdate, todate, clientIP = '127.0.0.1') {
    return await this.makeRequest('/rest/secure/angelbroking/historical/v1/getCandleData', 'POST', {
      exchange,
      symboltoken,
      interval,
      fromdate,
      todate
    }, jwtToken, clientIP);
  }

  // Option chain (mock implementation - Angel One doesn't provide this directly)
  async getOptionChain(jwtToken, symbol, expiry, clientIP = '127.0.0.1') {
    // This would need to be implemented with actual option chain data
    // For now, returning mock data structure
    return {
      status: true,
      data: {
        symbol,
        expiry,
        underlyingValue: 19500.50,
        calls: this.generateMockOptionData('CALL', symbol, expiry),
        puts: this.generateMockOptionData('PUT', symbol, expiry)
      }
    };
  }

  generateMockOptionData(type, symbol, expiry) {
    const strikes = [];
    const basePrice = 19500;
    const strikeInterval = 50;
    
    for (let i = -20; i <= 20; i++) {
      const strike = basePrice + (i * strikeInterval);
      strikes.push({
        strike,
        type,
        ltp: Math.random() * 200 + 10,
        volume: Math.floor(Math.random() * 10000),
        oi: Math.floor(Math.random() * 50000),
        change: (Math.random() - 0.5) * 20,
        iv: Math.random() * 30 + 10,
        delta: type === 'CALL' ? Math.random() * 1 : -Math.random() * 1,
        gamma: Math.random() * 0.01,
        theta: -Math.random() * 5,
        vega: Math.random() * 10
      });
    }
    
    return strikes;
  }
}

const smartAPI = new SmartAPIClient();

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    angelone_connected: !!process.env.ANGEL_ONE_API_KEY,
    active_sessions: cache.userSessions.size,
    cache_stats: {
      market_data_entries: cache.marketData.size,
      watchlists: cache.watchlist.size,
      portfolios: cache.portfolios.size
    }
  });
});

// Static file routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/pcr.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pcr.html'));
});

app.get('/sentiment.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sentiment.html'));
});

// Authentication routes
app.post('/api/auth/login', validateLoginInput, async (req, res) => {
  try {
    const { clientId, password, totp } = req.body;
    const clientIP = getClientIP(req);

    const loginResult = await smartAPI.login(clientId, password, totp, clientIP);

    if (loginResult.success) {
      const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      cache.userSessions.set(sessionId, {
        ...loginResult.data,
        clientId,
        clientIP,
        loginTime: Date.now()
      });

      successResponse(res, {
        sessionId,
        user: loginResult.data
      }, 'Login successful');
    } else {
      errorResponse(res, 401, loginResult.message || 'Login failed');
    }
  } catch (error) {
    console.error('Login route error:', error);
    errorResponse(res, 500, 'Internal server error', error);
  }
});

app.post('/api/auth/logout', (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    
    if (sessionId && cache.userSessions.has(sessionId)) {
      cache.userSessions.delete(sessionId);
    }

    successResponse(res, null, 'Logged out successfully');
  } catch (error) {
    console.error('Logout error:', error);
    errorResponse(res, 500, 'Logout failed', error);
  }
});

// User routes
app.get('/api/user/profile', validateSession, async (req, res) => {
  try {
    const profile = await smartAPI.getUserProfile(req.session.jwtToken, req.session.clientIP);
    successResponse(res, profile.data, 'Profile fetched successfully');
  } catch (error) {
    console.error('Profile route error:', error);
    errorResponse(res, 500, 'Failed to fetch profile', error);
  }
});

// Market data routes
app.post('/api/market/data', validateSession, async (req, res) => {
  try {
    const { exchange, tradingSymbol, symbolToken } = req.body;

    if (!exchange || !tradingSymbol || !symbolToken) {
      return errorResponse(res, 400, 'Exchange, trading symbol, and symbol token are required');
    }

    const marketData = await smartAPI.getMarketData(
      req.session.jwtToken,
      exchange,
      tradingSymbol,
      symbolToken,
      req.session.clientIP
    );

    // Cache the data
    const cacheKey = `${exchange}_${symbolToken}`;
    cache.marketData.set(cacheKey, {
      ...marketData,
      timestamp: Date.now()
    });

    successResponse(res, marketData.data, 'Market data fetched successfully');
  } catch (error) {
    console.error('Market data route error:', error);
    errorResponse(res, 500, 'Failed to fetch market data', error);
  }
});

app.post('/api/market/search', validateSession, async (req, res) => {
  try {
    const { exchange, searchText } = req.body;

    if (!exchange || !searchText) {
      return errorResponse(res, 400, 'Exchange and search text are required');
    }

    const results = await smartAPI.searchInstruments(
      req.session.jwtToken,
      exchange,
      searchText,
      req.session.clientIP
    );

    successResponse(res, results.data, 'Search completed successfully');
  } catch (error) {
    console.error('Search route error:', error);
    errorResponse(res, 500, 'Failed to search instruments', error);
  }
});

app.post('/api/market/historical', validateSession, async (req, res) => {
  try {
    const { exchange, symboltoken, interval, fromdate, todate } = req.body;

    if (!exchange || !symboltoken || !interval || !fromdate || !todate) {
      return errorResponse(res, 400, 'All parameters are required');
    }

    const historicalData = await smartAPI.getHistoricalData(
      req.session.jwtToken,
      exchange,
      symboltoken,
      interval,
      fromdate,
      todate,
      req.session.clientIP
    );

    // Cache historical data
    const cacheKey = `${exchange}_${symboltoken}_${interval}_${fromdate}_${todate}`;
    cache.historicalData.set(cacheKey, {
      ...historicalData,
      timestamp: Date.now()
    });

    successResponse(res, historicalData.data, 'Historical data fetched successfully');
  } catch (error) {
    console.error('Historical data route error:', error);
    errorResponse(res, 500, 'Failed to fetch historical data', error);
  }
});

// Option chain routes
app.post('/api/options/chain', validateSession, async (req, res) => {
  try {
    const { symbol, expiry } = req.body;

    if (!symbol) {
      return errorResponse(res, 400, 'Symbol is required');
    }

    const optionChain = await smartAPI.getOptionChain(
      req.session.jwtToken,
      symbol,
      expiry || 'current',
      req.session.clientIP
    );

    // Cache option chain data
    const cacheKey = `${symbol}_${expiry || 'current'}`;
    cache.optionChain.set(cacheKey, {
      ...optionChain,
      timestamp: Date.now()
    });

    successResponse(res, optionChain.data, 'Option chain fetched successfully');
  } catch (error) {
    console.error('Option chain route error:', error);
    errorResponse(res, 500, 'Failed to fetch option chain', error);
  }
});

// PCR (Put-Call Ratio) routes
app.get('/api/pcr/:symbol?', validateSession, (req, res) => {
  try {
    const { symbol } = req.params;
    const targetSymbol = symbol || 'NIFTY';

    // Generate mock PCR data
    const pcrData = {
      symbol: targetSymbol,
      current_pcr: +(Math.random() * 0.8 + 0.6).toFixed(2), // 0.6 to 1.4
      timestamp: new Date().toISOString(),
      historical: generateHistoricalPCR(5), // 5 days
      statistics: {
        avg_5d: 1.08,
        high_5d: 1.45,
        low_5d: 0.72,
        volatility: 12.5
      },
      interpretation: getPCRInterpretation(+(Math.random() * 0.8 + 0.6).toFixed(2))
    };

    cache.pcrData.set(targetSymbol, pcrData);
    successResponse(res, pcrData, 'PCR data fetched successfully');
  } catch (error) {
    console.error('PCR route error:', error);
    errorResponse(res, 500, 'Failed to fetch PCR data', error);
  }
});

function generateHistoricalPCR(days) {
  const historical = [];
  const now = new Date();
  
  for (let i = days; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    
    historical.push({
      date: date.toISOString().split('T')[0],
      open: +(Math.random() * 0.8 + 0.6).toFixed(2),
      high: +(Math.random() * 0.8 + 1.0).toFixed(2),
      low: +(Math.random() * 0.6 + 0.4).toFixed(2),
      close: +(Math.random() * 0.8 + 0.6).toFixed(2),
      average: +(Math.random() * 0.8 + 0.7).toFixed(2)
    });
  }
  
  return historical;
}

function getPCRInterpretation(pcr) {
  if (pcr < 0.8) {
    return {
      sentiment: 'Bullish',
      description: 'Low PCR indicates bullish sentiment with more call options being traded',
      signal: 'BUY',
      strength: 'Strong'
    };
  } else if (pcr > 1.2) {
    return {
      sentiment: 'Bearish',
      description: 'High PCR indicates bearish sentiment with more put options being traded',
      signal: 'SELL',
      strength: 'Strong'
    };
  } else {
    return {
      sentiment: 'Neutral',
      description: 'PCR in neutral range, balanced options activity',
      signal: 'HOLD',
      strength: 'Moderate'
    };
  }
}

// Sentiment analysis routes
app.get('/api/sentiment/:market?', validateSession, (req, res) => {
  try {
    const { market } = req.params;
    const targetMarket = market || 'NIFTY';

    const sentimentData = {
      market: targetMarket,
      overall_sentiment: {
        score: Math.floor(Math.random() * 40 + 50), // 50-90
        label: 'Greed',
        description: 'Market showing signs of optimism with increased buying pressure'
      },
      fear_greed_index: {
        current: Math.floor(Math.random() * 40 + 50),
        previous: Math.floor(Math.random() * 40 + 45),
        change: Math.floor(Math.random() * 10 - 5)
      },
      social_sentiment: {
        twitter: { score: Math.floor(Math.random() * 40 + 50), change: Math.random() * 10 - 5 },
        reddit: { score: Math.floor(Math.random() * 40 + 50), change: Math.random() * 10 - 5 },
        linkedin: { score: Math.floor(Math.random() * 40 + 30), change: Math.random() * 6 - 3 },
        whatsapp: { score: Math.floor(Math.random() * 40 + 60), change: Math.random() * 10 - 2 }
      },
      technical_indicators: {
        rsi: { value: Math.random() * 40 + 40, signal: 'BUY' },
        macd: { value: Math.random() * 5 - 2.5, signal: 'BUY' },
        stochastic: { value: Math.random() * 100, signal: 'HOLD' },
        williams_r: { value: -Math.random() * 100, signal: 'SELL' },
        bollinger_bands: { position: 'Upper', signal: 'BUY' },
        moving_averages: { position: 'Above', signal: 'BUY' }
      },
      market_mood: {
        volatility: 'Medium',
        trend_strength: 'Strong',
        risk_appetite: 'High'
      },
      timestamp: new Date().toISOString()
    };

    cache.sentimentData.set(targetMarket, sentimentData);
    successResponse(res, sentimentData, 'Sentiment data fetched successfully');
  } catch (error) {
    console.error('Sentiment route error:', error);
    errorResponse(res, 500, 'Failed to fetch sentiment data', error);
  }
});

// Portfolio routes
app.get('/api/portfolio/holdings', validateSession, async (req, res) => {
  try {
    const holdings = await smartAPI.getHoldings(req.session.jwtToken, req.session.clientIP);
    successResponse(res, holdings.data, 'Holdings fetched successfully');
  } catch (error) {
    console.error('Holdings route error:', error);
    errorResponse(res, 500, 'Failed to fetch holdings', error);
  }
});

app.get('/api/portfolio/positions', validateSession, async (req, res) => {
  try {
    const positions = await smartAPI.getPositions(req.session.jwtToken, req.session.clientIP);
    successResponse(res, positions.data, 'Positions fetched successfully');
  } catch (error) {
    console.error('Positions route error:', error);
    errorResponse(res, 500, 'Failed to fetch positions', error);
  }
});

// Watchlist management routes
app.get('/api/watchlist/:listId?', validateSession, (req, res) => {
  try {
    const { listId } = req.params;
    const userWatchlists = cache.watchlist.get(req.session.clientId) || {};

    if (listId) {
      const watchlist = userWatchlists[listId];
      if (!watchlist) {
        return errorResponse(res, 404, 'Watchlist not found');
      }
      return successResponse(res, watchlist, 'Watchlist fetched successfully');
    }

    successResponse(res, userWatchlists, 'Watchlists fetched successfully');
  } catch (error) {
    console.error('Watchlist get error:', error);
    errorResponse(res, 500, 'Failed to fetch watchlist', error);
  }
});

app.post('/api/watchlist', validateSession, (req, res) => {
  try {
    const { name, symbols } = req.body;

    if (!name) {
      return errorResponse(res, 400, 'Watchlist name is required');
    }

    const userWatchlists = cache.watchlist.get(req.session.clientId) || {};
    const listId = `wl_${Date.now()}`;

    userWatchlists[listId] = {
      id: listId,
      name,
      symbols: symbols || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    cache.watchlist.set(req.session.clientId, userWatchlists);
    successResponse(res, userWatchlists[listId], 'Watchlist created successfully');
  } catch (error) {
    console.error('Watchlist create error:', error);
    errorResponse(res, 500, 'Failed to create watchlist', error);
  }
});

app.put('/api/watchlist/:listId', validateSession, (req, res) => {
  try {
    const { listId } = req.params;
    const { name, symbols, action, symbol } = req.body;

    const userWatchlists = cache.watchlist.get(req.session.clientId) || {};
    const watchlist = userWatchlists[listId];

    if (!watchlist) {
      return errorResponse(res, 404, 'Watchlist not found');
    }

    if (action === 'add' && symbol) {
      if (!watchlist.symbols.find(s => s.symbolToken === symbol.symbolToken)) {
        watchlist.symbols.push(symbol);
      }
    } else if (action === 'remove' && symbol) {
      watchlist.symbols = watchlist.symbols.filter(s => s.symbolToken !== symbol.symbolToken);
    } else {
      if (name) watchlist.name = name;
      if (symbols) watchlist.symbols = symbols;
    }

    watchlist.updatedAt = new Date().toISOString();
    cache.watchlist.set(req.session.clientId, userWatchlists);

    successResponse(res, watchlist, 'Watchlist updated successfully');
  } catch (error) {
    console.error('Watchlist update error:', error);
    errorResponse(res, 500, 'Failed to update watchlist', error);
  }
});

app.delete('/api/watchlist/:listId', validateSession, (req, res) => {
  try {
    const { listId } = req.params;
    const userWatchlists = cache.watchlist.get(req.session.clientId) || {};

    if (!userWatchlists[listId]) {
      return errorResponse(res, 404, 'Watchlist not found');
    }

    delete userWatchlists[listId];
    cache.watchlist.set(req.session.clientId, userWatchlists);

    successResponse(res, null, 'Watchlist deleted successfully');
  } catch (error) {
    console.error('Watchlist delete error:', error);
    errorResponse(res, 500, 'Failed to delete watchlist', error);
  }
});

// WebSocket server for real-time data
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ 
  server,
  path: '/ws',
  clientTracking: true
});

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  console.log('WebSocket client connected from:', req.connection.remoteAddress);
  
  ws.isAlive = true;
  ws.subscribedSymbols = [];

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'subscribe':
          if (data.symbols && Array.isArray(data.symbols)) {
            ws.subscribedSymbols = data.symbols;
            ws.send(JSON.stringify({
              type: 'subscription_confirmed',
              symbols: data.symbols,
              timestamp: new Date().toISOString()
            }));
          }
          break;
          
        case 'unsubscribe':
          ws.subscribedSymbols = [];
          ws.send(JSON.stringify({
            type: 'unsubscription_confirmed',
            timestamp: new Date().toISOString()
          }));
          break;
          
        case 'ping':
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: new Date().toISOString()
          }));
          break;
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format',
        timestamp: new Date().toISOString()
      }));
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`WebSocket client disconnected: ${code} ${reason}`);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  // Send initial connection confirmation
  ws.send(JSON.stringify({
    type: 'connection_established',
    timestamp: new Date().toISOString(),
    server_time: new Date().toISOString()
  }));
});

// Heartbeat to detect broken connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
}, 30000); // 30 seconds

// Simulate real-time market data updates
const marketDataInterval = setInterval(() => {
  if (wss.clients.size === 0) return;

  const symbols = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX'];
  const marketUpdate = {
    type: 'market_update',
    timestamp: new Date().toISOString(),
    data: {}
  };

  symbols.forEach(symbol => {
    const basePrice = getBasePrice(symbol);
    const change = (Math.random() - 0.5) * basePrice * 0.02; // ±2% change
    const currentPrice = basePrice + change;
    
    marketUpdate.data[symbol] = {
      symbol,
      ltp: +currentPrice.toFixed(2),
      change: +change.toFixed(2),
      changePercent: +((change / basePrice) * 100).toFixed(2),
      volume: Math.floor(Math.random() * 1000000),
      high: +(currentPrice * 1.015).toFixed(2),
      low: +(currentPrice * 0.985).toFixed(2),
      open: +(basePrice * (0.995 + Math.random() * 0.01)).toFixed(2)
    };
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.subscribedSymbols.length > 0) {
      // Send data for subscribed symbols only
      const filteredData = {};
      client.subscribedSymbols.forEach(symbol => {
        if (marketUpdate.data[symbol]) {
          filteredData[symbol] = marketUpdate.data[symbol];
        }
      });

      if (Object.keys(filteredData).length > 0) {
        client.send(JSON.stringify({
          ...marketUpdate,
          data: filteredData
        }));
      }
    }
  });
}, 5000); // Update every 5 seconds

function getBasePrice(symbol) {
  const basePrices = {
    'NIFTY': 19500,
    'BANKNIFTY': 44000,
    'FINNIFTY': 19800,
    'SENSEX': 65000
  };
  return basePrices[symbol] || 19500;
}

// Send PCR updates
const pcrUpdateInterval = setInterval(() => {
  if (wss.clients.size === 0) return;

  const symbols = ['NIFTY', 'BANKNIFTY'];
  
  symbols.forEach(symbol => {
    const pcrUpdate = {
      type: 'pcr_update',
      symbol,
      timestamp: new Date().toISOString(),
      data: {
        current_pcr: +(Math.random() * 0.8 + 0.6).toFixed(2),
        call_volume: Math.floor(Math.random() * 1000000),
        put_volume: Math.floor(Math.random() * 1000000),
        call_oi: Math.floor(Math.random() * 5000000),
        put_oi: Math.floor(Math.random() * 5000000)
      }
    };

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(pcrUpdate));
      }
    });
  });
}, 10000); // Update every 10 seconds

// Send sentiment updates
const sentimentUpdateInterval = setInterval(() => {
  if (wss.clients.size === 0) return;

  const sentimentUpdate = {
    type: 'sentiment_update',
    timestamp: new Date().toISOString(),
    data: {
      fear_greed_index: Math.floor(Math.random() * 100),
      market_sentiment: Math.random() > 0.5 ? 'bullish' : 'bearish',
      volatility_index: +(Math.random() * 30 + 10).toFixed(2),
      trend_strength: Math.random() > 0.7 ? 'strong' : Math.random() > 0.4 ? 'moderate' : 'weak'
    }
  };

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(sentimentUpdate));
    }
  });
}, 15000); // Update every 15 seconds

// Clean up expired sessions and cache every hour
cron.schedule('0 * * * *', () => {
  const now = Date.now();
  const sessionTimeout = 8 * 60 * 60 * 1000; // 8 hours
  const cacheTimeout = 24 * 60 * 60 * 1000; // 24 hours

  // Clean expired sessions
  for (const [sessionId, session] of cache.userSessions.entries()) {
    if (now - session.loginTime > sessionTimeout) {
      cache.userSessions.delete(sessionId);
      console.log(`Cleaned up expired session: ${sessionId}`);
    }
  }

  // Clean expired cache entries
  [cache.marketData, cache.historicalData, cache.optionChain].forEach(cacheMap => {
    for (const [key, data] of cacheMap.entries()) {
      if (now - (data.timestamp || 0) > cacheTimeout) {
        cacheMap.delete(key);
      }
    }
  });

  console.log(`Cache cleanup completed at ${new Date().toISOString()}`);
});

// Enhanced error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  
  // Don't leak error details in production
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    timestamp: new Date().toISOString(),
    ...(isDevelopment && {
      error: error.message,
      stack: error.stack
    })
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
    timestamp: new Date().toISOString()
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  
  // Clear intervals
  clearInterval(marketDataInterval);
  clearInterval(pcrUpdateInterval);
  clearInterval(sentimentUpdateInterval);
  clearInterval(heartbeatInterval);
  
  // Close WebSocket server
  wss.clients.forEach((client) => {
    client.close(1000, 'Server shutting down');
  });
  
  wss.close(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.emit('SIGTERM');
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
server.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log(`🚀 FS DASH Backend Server Started`);
  console.log(`📡 Server running on port: ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔌 WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`🔐 Angel One API: ${process.env.ANGEL_ONE_API_KEY ? '✅ Connected' : '❌ Not configured'}`);
  console.log('='.repeat(50));
});

module.exports = { app, server, wss };
