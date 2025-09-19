const express = require('express');
const cors = require('cors');
const axios = require('axios');
const WebSocket = require('ws');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api', limiter);

// Angel One SmartAPI configuration
const SMART_API_CONFIG = {
  baseURL: 'https://apiconnect.angelbroking.com',
  timeout: 30000
};

// In-memory cache for storing data (use Redis in production)
const cache = {
  userSessions: new Map(),
  marketData: new Map(),
  watchlist: new Map(),
  portfolios: new Map()
};

// Angel One SmartAPI client
class SmartAPIClient {
  constructor() {
    this.baseURL = SMART_API_CONFIG.baseURL;
    this.jwtToken = null;
    this.refreshToken = null;
    this.feedToken = null;
  }

  // User login
  async login(clientId, password, totp) {
    try {
      const response = await axios.post(`${this.baseURL}/rest/auth/angelbroking/user/v1/loginByPassword`, {
        clientcode: clientId,
        password: password,
        totp: totp
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '192.168.1.1',
          'X-ClientPublicIP': '106.193.147.98',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': process.env.ANGEL_ONE_API_KEY
        }
      });

      if (response.data.status) {
        this.jwtToken = response.data.data.jwtToken;
        this.refreshToken = response.data.data.refreshToken;
        this.feedToken = response.data.data.feedToken;
        
        return {
          success: true,
          data: response.data.data
        };
      }
      
      return {
        success: false,
        message: response.data.message
      };
    } catch (error) {
      console.error('Login error:', error.response?.data || error.message);
      return {
        success: false,
        message: 'Login failed'
      };
    }
  }

  // Get user profile
  async getUserProfile(jwtToken) {
    try {
      const response = await axios.get(`${this.baseURL}/rest/secure/angelbroking/user/v1/getProfile`, {
        headers: {
          'Authorization': `Bearer ${jwtToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '192.168.1.1',
          'X-ClientPublicIP': '106.193.147.98',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': process.env.ANGEL_ONE_API_KEY
        }
      });

      return response.data;
    } catch (error) {
      console.error('Profile fetch error:', error.response?.data || error.message);
      throw error;
    }
  }

  // Get market data
  async getMarketData(jwtToken, exchange, tradingSymbol, symbolToken) {
    try {
      const response = await axios.post(`${this.baseURL}/rest/secure/angelbroking/market/v1/getMarketData`, {
        exchange: exchange,
        tradingsymbol: tradingSymbol,
        symboltoken: symbolToken
      }, {
        headers: {
          'Authorization': `Bearer ${jwtToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '192.168.1.1',
          'X-ClientPublicIP': '106.193.147.98',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': process.env.ANGEL_ONE_API_KEY
        }
      });

      return response.data;
    } catch (error) {
      console.error('Market data error:', error.response?.data || error.message);
      throw error;
    }
  }

  // Get holdings
  async getHoldings(jwtToken) {
    try {
      const response = await axios.get(`${this.baseURL}/rest/secure/angelbroking/portfolio/v1/getHolding`, {
        headers: {
          'Authorization': `Bearer ${jwtToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '192.168.1.1',
          'X-ClientPublicIP': '106.193.147.98',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': process.env.ANGEL_ONE_API_KEY
        }
      });

      return response.data;
    } catch (error) {
      console.error('Holdings error:', error.response?.data || error.message);
      throw error;
    }
  }

  // Get positions
  async getPositions(jwtToken) {
    try {
      const response = await axios.get(`${this.baseURL}/rest/secure/angelbroking/order/v1/getPosition`, {
        headers: {
          'Authorization': `Bearer ${jwtToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '192.168.1.1',
          'X-ClientPublicIP': '106.193.147.98',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': process.env.ANGEL_ONE_API_KEY
        }
      });

      return response.data;
    } catch (error) {
      console.error('Positions error:', error.response?.data || error.message);
      throw error;
    }
  }

  // Search instruments
  async searchInstruments(jwtToken, exchange, searchText) {
    try {
      const response = await axios.post(`${this.baseURL}/rest/secure/angelbroking/order/v1/searchScrip`, {
        exchange: exchange,
        searchscrip: searchText
      }, {
        headers: {
          'Authorization': `Bearer ${jwtToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '192.168.1.1',
          'X-ClientPublicIP': '106.193.147.98',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': process.env.ANGEL_ONE_API_KEY
        }
      });

      return response.data;
    } catch (error) {
      console.error('Search error:', error.response?.data || error.message);
      throw error;
    }
  }

  // Get historical data
  async getHistoricalData(jwtToken, exchange, symboltoken, interval, fromdate, todate) {
    try {
      const response = await axios.post(`${this.baseURL}/rest/secure/angelbroking/historical/v1/getCandleData`, {
        exchange: exchange,
        symboltoken: symboltoken,
        interval: interval,
        fromdate: fromdate,
        todate: todate
      }, {
        headers: {
          'Authorization': `Bearer ${jwtToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '192.168.1.1',
          'X-ClientPublicIP': '106.193.147.98',
          'X-MACAddress': '00:00:00:00:00:00',
          'X-PrivateKey': process.env.ANGEL_ONE_API_KEY
        }
      });

      return response.data;
    } catch (error) {
      console.error('Historical data error:', error.response?.data || error.message);
      throw error;
    }
  }
}

const smartAPI = new SmartAPIClient();

// Routes

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Login to Angel One
app.post('/api/auth/login', async (req, res) => {
  try {
    const { clientId, password, totp } = req.body;

    if (!clientId || !password || !totp) {
      return res.status(400).json({
        success: false,
        message: 'Client ID, password, and TOTP are required'
      });
    }

    const loginResult = await smartAPI.login(clientId, password, totp);

    if (loginResult.success) {
      // Store session
      const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      cache.userSessions.set(sessionId, {
        ...loginResult.data,
        clientId,
        loginTime: new Date()
      });

      res.json({
        success: true,
        sessionId,
        data: loginResult.data
      });
    } else {
      res.status(401).json(loginResult);
    }
  } catch (error) {
    console.error('Login route error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Get user profile
app.get('/api/user/profile', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    const session = cache.userSessions.get(sessionId);

    if (!session) {
      return res.status(401).json({
        success: false,
        message: 'Invalid session'
      });
    }

    const profile = await smartAPI.getUserProfile(session.jwtToken);
    res.json(profile);
  } catch (error) {
    console.error('Profile route error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch profile'
    });
  }
});

// Get market data for a symbol
app.post('/api/market/data', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    const session = cache.userSessions.get(sessionId);

    if (!session) {
      return res.status(401).json({
        success: false,
        message: 'Invalid session'
      });
    }

    const { exchange, tradingSymbol, symbolToken } = req.body;

    const marketData = await smartAPI.getMarketData(
      session.jwtToken,
      exchange,
      tradingSymbol,
      symbolToken
    );

    // Cache the data
    const cacheKey = `${exchange}_${symbolToken}`;
    cache.marketData.set(cacheKey, {
      ...marketData,
      timestamp: new Date()
    });

    res.json(marketData);
  } catch (error) {
    console.error('Market data route error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch market data'
    });
  }
});

// Get holdings
app.get('/api/portfolio/holdings', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    const session = cache.userSessions.get(sessionId);

    if (!session) {
      return res.status(401).json({
        success: false,
        message: 'Invalid session'
      });
    }

    const holdings = await smartAPI.getHoldings(session.jwtToken);
    res.json(holdings);
  } catch (error) {
    console.error('Holdings route error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch holdings'
    });
  }
});

// Get positions
app.get('/api/portfolio/positions', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    const session = cache.userSessions.get(sessionId);

    if (!session) {
      return res.status(401).json({
        success: false,
        message: 'Invalid session'
      });
    }

    const positions = await smartAPI.getPositions(session.jwtToken);
    res.json(positions);
  } catch (error) {
    console.error('Positions route error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch positions'
    });
  }
});

// Search instruments
app.post('/api/market/search', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    const session = cache.userSessions.get(sessionId);

    if (!session) {
      return res.status(401).json({
        success: false,
        message: 'Invalid session'
      });
    }

    const { exchange, searchText } = req.body;

    if (!exchange || !searchText) {
      return res.status(400).json({
        success: false,
        message: 'Exchange and search text are required'
      });
    }

    const results = await smartAPI.searchInstruments(
      session.jwtToken,
      exchange,
      searchText
    );

    res.json(results);
  } catch (error) {
    console.error('Search route error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to search instruments'
    });
  }
});

// Get historical data
app.post('/api/market/historical', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    const session = cache.userSessions.get(sessionId);

    if (!session) {
      return res.status(401).json({
        success: false,
        message: 'Invalid session'
      });
    }

    const { exchange, symboltoken, interval, fromdate, todate } = req.body;

    const historicalData = await smartAPI.getHistoricalData(
      session.jwtToken,
      exchange,
      symboltoken,
      interval,
      fromdate,
      todate
    );

    res.json(historicalData);
  } catch (error) {
    console.error('Historical data route error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch historical data'
    });
  }
});

// Watchlist management
app.get('/api/watchlist/:listId?', (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    const session = cache.userSessions.get(sessionId);

    if (!session) {
      return res.status(401).json({
        success: false,
        message: 'Invalid session'
      });
    }

    const { listId } = req.params;
    const userWatchlists = cache.watchlist.get(session.clientId) || {};

    if (listId) {
      const watchlist = userWatchlists[listId];
      if (!watchlist) {
        return res.status(404).json({
          success: false,
          message: 'Watchlist not found'
        });
      }
      return res.json({ success: true, data: watchlist });
    }

    res.json({
      success: true,
      data: userWatchlists
    });
  } catch (error) {
    console.error('Watchlist get error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch watchlist'
    });
  }
});

app.post('/api/watchlist', (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    const session = cache.userSessions.get(sessionId);

    if (!session) {
      return res.status(401).json({
        success: false,
        message: 'Invalid session'
      });
    }

    const { name, symbols } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Watchlist name is required'
      });
    }

    const userWatchlists = cache.watchlist.get(session.clientId) || {};
    const listId = `wl_${Date.now()}`;

    userWatchlists[listId] = {
      id: listId,
      name,
      symbols: symbols || [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    cache.watchlist.set(session.clientId, userWatchlists);

    res.json({
      success: true,
      data: userWatchlists[listId]
    });
  } catch (error) {
    console.error('Watchlist create error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create watchlist'
    });
  }
});

app.put('/api/watchlist/:listId', (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    const session = cache.userSessions.get(sessionId);

    if (!session) {
      return res.status(401).json({
        success: false,
        message: 'Invalid session'
      });
    }

    const { listId } = req.params;
    const { name, symbols, action, symbol } = req.body;

    const userWatchlists = cache.watchlist.get(session.clientId) || {};
    const watchlist = userWatchlists[listId];

    if (!watchlist) {
      return res.status(404).json({
        success: false,
        message: 'Watchlist not found'
      });
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

    watchlist.updatedAt = new Date();
    cache.watchlist.set(session.clientId, userWatchlists);

    res.json({
      success: true,
      data: watchlist
    });
  } catch (error) {
    console.error('Watchlist update error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update watchlist'
    });
  }
});

app.delete('/api/watchlist/:listId', (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    const session = cache.userSessions.get(sessionId);

    if (!session) {
      return res.status(401).json({
        success: false,
        message: 'Invalid session'
      });
    }

    const { listId } = req.params;
    const userWatchlists = cache.watchlist.get(session.clientId) || {};

    if (!userWatchlists[listId]) {
      return res.status(404).json({
        success: false,
        message: 'Watchlist not found'
      });
    }

    delete userWatchlists[listId];
    cache.watchlist.set(session.clientId, userWatchlists);

    res.json({
      success: true,
      message: 'Watchlist deleted successfully'
    });
  } catch (error) {
    console.error('Watchlist delete error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete watchlist'
    });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    
    if (sessionId && cache.userSessions.has(sessionId)) {
      cache.userSessions.delete(sessionId);
    }

    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      message: 'Logout failed'
    });
  }
});

// WebSocket server for real-time data
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('WebSocket client connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'subscribe' && data.symbols) {
        ws.subscribedSymbols = data.symbols;
        ws.send(JSON.stringify({
          type: 'subscription_confirmed',
          symbols: data.symbols
        }));
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });
});

// Simulate real-time data updates (in production, this would come from Angel One WebSocket feed)
setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.subscribedSymbols) {
      client.subscribedSymbols.forEach((symbol) => {
        // Simulate price updates
        const mockData = {
          type: 'market_data',
          symbolToken: symbol.symbolToken,
          ltp: (Math.random() * 1000 + 100).toFixed(2),
          change: ((Math.random() - 0.5) * 20).toFixed(2),
          timestamp: new Date().toISOString()
        };

        client.send(JSON.stringify(mockData));
      });
    }
  });
}, 5000); // Update every 5 seconds

// Clean up expired sessions every hour
cron.schedule('0 * * * *', () => {
  const now = new Date();
  const sessionTimeout = 8 * 60 * 60 * 1000; // 8 hours

  for (const [sessionId, session] of cache.userSessions.entries()) {
    if (now - session.loginTime > sessionTimeout) {
      cache.userSessions.delete(sessionId);
      console.log(`Cleaned up expired session: ${sessionId}`);
    }
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`FSTRENDER Stock Market Dashboard Backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`WebSocket server ready for real-time data`);
});
