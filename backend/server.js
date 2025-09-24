/**
 * FS DASH Trading Dashboard Backend
 * File: server.js
 * Angel One SmartAPI Integration with WebSocket Real-time Data
 *
 * UPDATED: Changed from password to MPIN authentication
 * NOTE: This file includes hardcoded credentials for demonstration purposes.
 * FOR PRODUCTION USE, IT IS STRONGLY RECOMMENDED TO USE A SEPARATE .env FILE.
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { SmartAPI } = require('smartapi-javascript');

// --- WARNING: HARDCODED CREDENTIALS ---
// These credentials are now part of your code.
// This is not a secure way to handle secrets.
//
const ANGEL_API_KEY = 'XXXXXXXXXXXX';
const ANGEL_CLIENT_CODE = 'XXXXXXXX';
const ANGEL_MPIN = 'XXXX'; // Changed from password to MPIN (4-digit PIN)
const ANGEL_TOTP = 'XXXXXXXXXXXXXXXXXXX';

const speakeasy = require('speakeasy');

// Generate and log TOTP for Angel One
const generatedTotp = speakeasy.totp({
    secret: ANGEL_TOTP,
    encoding: 'base32'
});
console.log("泊 Generated TOTP for Angel One:", generatedTotp);

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuration
const PORT = process.env.PORT || 25602;

// Angel One SmartAPI Configuration - UPDATED FOR MPIN
const SMARTAPI_CONFIG = {
    api_key: ANGEL_API_KEY,
    client_code: ANGEL_CLIENT_CODE,
    mpin: ANGEL_MPIN,  // Changed from pwd to mpin
    factor2: generatedTotp
};

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.static('public'));

// Database setup
const db = new sqlite3.Database('./fsdash.db');

// Initialize database tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS portfolio (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        avg_price REAL NOT NULL,
        current_price REAL DEFAULT 0,
        pnl REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        trade_type TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        price REAL NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        status TEXT DEFAULT 'COMPLETED'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS market_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        price REAL NOT NULL,
        change_value REAL NOT NULL,
        change_percent REAL NOT NULL,
        volume INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS option_chain (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        expiry TEXT NOT NULL,
        strike REAL NOT NULL,
        call_ltp REAL DEFAULT 0,
        call_oi INTEGER DEFAULT 0,
        call_volume INTEGER DEFAULT 0,
        put_ltp REAL DEFAULT 0,
        put_oi INTEGER DEFAULT 0,
        put_volume INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Global variables
let smartAPI = null;
let connectedClients = new Set();
let marketDataCache = new Map();
let optionChainCache = new Map();
let pcrCache = new Map();
let isSmartAPIConnected = false;
let dataUpdateInterval = null;

/**
 * SmartAPI Helper Class - UPDATED FOR MPIN
 */
class SmartAPIManager {
    constructor() {
        this.smartapi = new SmartAPI({
            api_key: SMARTAPI_CONFIG.api_key
        });
        this.isLoggedIn = false;
        this.userProfile = null;
    }

    async login() {
        try {
            console.log('Attempting login with MPIN authentication...');
            
            // Updated login method for MPIN
            const loginData = await this.smartapi.generateSession(
                SMARTAPI_CONFIG.client_code,
                SMARTAPI_CONFIG.mpin,  // Using MPIN instead of password
                SMARTAPI_CONFIG.factor2
            );

            if (loginData.status) {
                this.isLoggedIn = true;
                this.userProfile = loginData.data;
                isSmartAPIConnected = true;
                console.log('✅ SmartAPI Login successful:', loginData.data.clientcode);
                console.log('📱 Authentication method: MPIN');

                this.smartapi.setSessionExpiryHook(() => {
                    console.log('⚠️  Session expired. Attempting to relogin...');
                    this.login();
                });

                return true;
            } else {
                console.error('❌ SmartAPI Login failed:', loginData.message);
                console.error('💡 Troubleshooting tips:');
                console.error('   1. Verify your MPIN is correct (4-digit number)');
                console.error('   2. Check if your Angel One account is active');
                console.error('   3. Ensure TOTP is generating correctly');
                console.error('   4. Try logging into Angel One app manually first');
                return false;
            }
        } catch (error) {
            console.error('❌ SmartAPI Login error:', error.message);
            console.error('🔧 Error details:', error);
            
            // Provide more specific error handling
            if (error.message.includes('MPIN')) {
                console.error('💡 MPIN related error - check your 4-digit MPIN');
            } else if (error.message.includes('TOTP')) {
                console.error('💡 TOTP related error - check your secret key and time sync');
            } else if (error.message.includes('network') || error.message.includes('timeout')) {
                console.error('💡 Network error - check your internet connection');
            }
            
            isSmartAPIConnected = false;
            return false;
        }
    }

    async getProfile() {
        try {
            if (!this.isLoggedIn) {
                await this.login();
            }
            return await this.smartapi.getProfile();
        } catch (error) {
            console.error('Error getting profile:', error);
            return null;
        }
    }

    async getMarketData(symbol) {
        try {
            if (!this.isLoggedIn) {
                await this.login();
            }

            const token = this.getSymbolToken(symbol);
            const data = await this.smartapi.getLtpData("NSE", symbol, token);

            if (data.status) {
                return data.data;
            }
            return null;
        } catch (error) {
            console.error(`Error getting market data for ${symbol}:`, error);
            return null;
        }
    }

    async getOptionChain(symbol, expiry) {
        try {
            if (!this.isLoggedIn) {
                await this.login();
            }

            const optionData = await this.smartapi.getOptionChain({
                exchange: 'NFO',
                symboltoken: this.getSymbolToken(symbol),
                expirydate: expiry
            });

            if (optionData.status) {
                return optionData.data;
            }
            return null;
        } catch (error) {
            console.error(`Error getting option chain for ${symbol}:`, error);
            return null;
        }
    }

    async getPortfolio() {
        try {
            if (!this.isLoggedIn) {
                await this.login();
            }

            const holdings = await this.smartapi.getHolding();
            const positions = await this.smartapi.getPosition();

            return {
                holdings: holdings.status ? holdings.data : [],
                positions: positions.status ? positions.data : []
            };
        } catch (error) {
            console.error('Error getting portfolio:', error);
            return { holdings: [], positions: [] };
        }
    }

    getSymbolToken(symbol) {
        const tokenMap = {
            'NIFTY': '99926000',
            'BANKNIFTY': '99926009',
            'FINNIFTY': '99926037',
            'MIDCPNIFTY': '99926074'
        };
        return tokenMap[symbol] || symbol;
    }
}

// Initialize SmartAPI
const smartAPIManager = new SmartAPIManager();

/**
 * Market Data Generator (fallback when API is not available)
 */
class MarketDataGenerator {
    constructor() {
        this.baseData = {
            'NIFTY': { price: 21725.00, volume: 145000000 },
            'BANKNIFTY': { price: 46850.00, volume: 98000000 },
            'FINNIFTY': { price: 20150.00, volume: 42000000 },
            'MIDCPNIFTY': { price: 10450.00, volume: 28000000 }
        };
    }

    generateRealtimeData(symbol) {
        const base = this.baseData[symbol] || this.baseData['NIFTY'];
        const volatility = 0.02;
        const change = (Math.random() - 0.5) * volatility * base.price;
        const currentPrice = base.price + change;
        const changePercent = (change / base.price) * 100;
        const volumeVariation = 0.3;
        const currentVolume = Math.floor(
            base.volume * (1 + (Math.random() - 0.5) * volumeVariation)
        );

        return {
            symbol: symbol,
            price: parseFloat(currentPrice.toFixed(2)),
            change: parseFloat(change.toFixed(2)),
            change_percent: parseFloat(changePercent.toFixed(2)),
            volume: currentVolume,
            timestamp: new Date().toISOString()
        };
    }

    generateOptionChain(symbol, strikes = 15) {
        const baseDataForSymbol = this.baseData[symbol];
        const basePrice = (baseDataForSymbol && baseDataForSymbol.price) || 21725;
        const atmStrike = Math.round(basePrice / 100) * 100;
        const optionData = [];

        for (let i = -strikes; i <= strikes; i++) {
            const strike = atmStrike + (i * 100);
            const distanceFromATM = Math.abs(strike - basePrice);
            const callIntrinsic = Math.max(basePrice - strike, 0);
            const putIntrinsic = Math.max(strike - basePrice, 0);
            const timeValue = Math.max(50 - (distanceFromATM / 20), 5);
            const iv = Math.random() * 30 + 15;

            optionData.push({
                strike: strike,
                call_ltp: parseFloat(Math.max(callIntrinsic + timeValue + (Math.random() * 20 - 10), 0.05).toFixed(2)),
                call_oi: Math.floor(Math.random() * 50000 + 10000),
                call_volume: Math.floor(Math.random() * 10000 + 1000),
                call_iv: parseFloat(iv.toFixed(2)),
                put_ltp: parseFloat(Math.max(putIntrinsic + timeValue + (Math.random() * 20 - 10), 0.05).toFixed(2)),
                put_oi: Math.floor(Math.random() * 50000 + 10000),
                put_volume: Math.floor(Math.random() * 10000 + 1000),
                put_iv: parseFloat(iv.toFixed(2))
            });
        }

        return optionData;
    }

    calculatePCR(optionChainData) {
        let totalCallOI = 0;
        let totalPutOI = 0;

        optionChainData.forEach(option => {
            totalCallOI += option.call_oi;
            totalPutOI += option.put_oi;
        });

        const pcr = totalPutOI / totalCallOI;
        let sentiment = 'NEUTRAL';

        if (pcr < 0.8) sentiment = 'BULLISH';
        else if (pcr > 1.2) sentiment = 'BEARISH';

        return {
            pcr_ratio: parseFloat(pcr.toFixed(2)),
            call_oi: totalCallOI,
            put_oi: totalPutOI,
            sentiment: sentiment,
            timestamp: new Date().toISOString()
        };
    }
}

const marketDataGenerator = new MarketDataGenerator();

/**
 * WebSocket Connection Handler
 */
wss.on('connection', (ws) => {
    console.log('New client connected');
    connectedClients.add(ws);

    ws.send(JSON.stringify({
        type: 'connection',
        status: 'connected',
        angelone_connected: isSmartAPIConnected
    }));

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'subscribe':
                    await handleSubscription(ws, data);
                    break;
                case 'unsubscribe':
                    await handleUnsubscription(ws, data);
                    break;
                default:
                    console.log('Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        connectedClients.delete(ws);
    });
});

async function handleSubscription(ws, data) {
    console.log(`Subscribing to ${data.symbol || 'market data'}`);

    if (data.symbol) {
        const marketData = await getCurrentMarketData(data.symbol);
        ws.send(JSON.stringify({
            type: 'market_update',
            data: { [data.symbol]: marketData }
        }));
    }
}

async function handleUnsubscription(ws, data) {
    console.log(`Unsubscribing from ${data.symbol}`);
}

/**
 * Data fetching functions
 */
async function getCurrentMarketData(symbol) {
    try {
        if (isSmartAPIConnected) {
            const apiData = await smartAPIManager.getMarketData(symbol);
            if (apiData) {
                const marketData = {
                    symbol: symbol,
                    price: parseFloat(apiData.close || apiData.ltp || 0),
                    change: parseFloat((apiData.close - apiData.open) || 0),
                    change_percent: parseFloat(((apiData.close - apiData.open) / apiData.open * 100) || 0),
                    volume: parseInt(apiData.volume || 0),
                    timestamp: new Date().toISOString()
                };

                marketDataCache.set(symbol, marketData);
                return marketData;
            }
        }

        const generatedData = marketDataGenerator.generateRealtimeData(symbol);
        marketDataCache.set(symbol, generatedData);
        return generatedData;

    } catch (error) {
        console.error(`Error fetching market data for ${symbol}:`, error);
        return marketDataGenerator.generateRealtimeData(symbol);
    }
}

/**
 * REST API Endpoints
 */

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        angelone_connected: isSmartAPIConnected,
        smartapi_status: smartAPIManager.isLoggedIn ? 'connected' : 'disconnected',
        auth_method: 'MPIN'
    });
});

// Market data endpoint
app.get('/api/market/:symbol', async (req, res) => {
    try {
        const symbol = req.params.symbol.toUpperCase();
        const marketData = await getCurrentMarketData(symbol);
        res.json(marketData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Multiple symbols market data
app.post('/api/market/batch', async (req, res) => {
    try {
        const { symbols } = req.body;
        const marketData = {};

        for (const symbol of symbols) {
            marketData[symbol] = await getCurrentMarketData(symbol);
        }

        res.json(marketData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Option chain endpoint
app.get('/api/optionchain/:symbol/:expiry?', async (req, res) => {
    try {
        const symbol = req.params.symbol.toUpperCase();
        const expiry = req.params.expiry || getNextExpiry();

        let optionData;

        if (isSmartAPIConnected) {
            optionData = await smartAPIManager.getOptionChain(symbol, expiry);
        }

        if (!optionData) {
            optionData = marketDataGenerator.generateOptionChain(symbol);
        }

        optionChainCache.set(`${symbol}_${expiry}`, optionData);

        res.json({
            symbol: symbol,
            expiry: expiry,
            data: optionData,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PCR Analysis endpoint
app.get('/api/pcr/:symbol/:expiry?', async (req, res) => {
    try {
        const symbol = req.params.symbol.toUpperCase();
        const expiry = req.params.expiry || getNextExpiry();

        let optionChainData = optionChainCache.get(`${symbol}_${expiry}`);

        if (!optionChainData) {
            if (isSmartAPIConnected) {
                optionChainData = await smartAPIManager.getOptionChain(symbol, expiry);
            } else {
                optionChainData = marketDataGenerator.generateOptionChain(symbol);
            }
        }

        const pcrData = marketDataGenerator.calculatePCR(optionChainData);
        pcrCache.set(symbol, pcrData);

        res.json(pcrData);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Portfolio endpoint
app.get('/api/portfolio', async (req, res) => {
    try {
        let portfolioData;

        if (isSmartAPIConnected) {
            portfolioData = await smartAPIManager.getPortfolio();
        } else {
            portfolioData = {
                holdings: [
                    { symbol: 'RELIANCE', quantity: 50, avgprice: 2485.50, ltp: 2542.30 },
                    { symbol: 'TCS', quantity: 30, avgprice: 3650.00, ltp: 3720.15 },
                    { symbol: 'HDFCBANK', quantity: 65, avgprice: 1520.30, ltp: 1485.75 },
                    { symbol: 'INFY', quantity: 55, avgprice: 1680.20, ltp: 1724.80 },
                    { symbol: 'ICICIBANK', quantity: 80, avgprice: 980.50, ltp: 1025.30 }
                ],
                positions: []
            };
        }

        let totalValue = 0;
        let totalInvested = 0;
        let totalPnL = 0;

        portfolioData.holdings.forEach(holding => {
            const value = holding.quantity * holding.ltp;
            const invested = holding.quantity * holding.avgprice;
            totalValue += value;
            totalInvested += invested;
            totalPnL += (value - invested);
        });

        const summary = {
            total_value: totalValue,
            total_invested: totalInvested,
            total_pnl: totalPnL,
            day_change: totalPnL * 0.1,
            holdings_count: portfolioData.holdings.length
        };

        res.json({
            summary: summary,
            holdings: portfolioData.holdings,
            positions: portfolioData.positions
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Historical data endpoint
app.get('/api/history/:symbol/:period?', async (req, res) => {
    try {
        const symbol = req.params.symbol.toUpperCase();
        const period = req.params.period || '1D';

        const data = generateHistoricalData(symbol, period);

        res.json({
            symbol: symbol,
            period: period,
            data: data
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Utility functions
 */
function getNextExpiry() {
    const now = new Date();
    const nextThursday = new Date(now);
    const daysUntilThursday = (4 - now.getDay() + 7) % 7;
    nextThursday.setDate(now.getDate() + daysUntilThursday);

    return nextThursday.toISOString().split('T')[0];
}

function generateHistoricalData(symbol, period) {
    const baseDataForSymbol = marketDataGenerator.baseData[symbol];
    const basePrice = (baseDataForSymbol && baseDataForSymbol.price) || 21725;
    const data = [];
    const labels = [];

    const periods = {
        '1D': { points: 24, interval: 'hour' },
        '1W': { points: 7, interval: 'day' },
        '1M': { points: 30, interval: 'day' },
        '3M': { points: 90, interval: 'day' },
        '1Y': { points: 365, interval: 'day' }
    };

    const config = periods[period] || periods['1D'];

    for (let i = 0; i < config.points; i++) {
        const date = new Date();
        if (config.interval === 'hour') {
            date.setHours(date.getHours() - (config.points - i));
        } else {
            date.setDate(date.getDate() - (config.points - i));
        }

        const volatility = 0.02;
        const change = (Math.random() - 0.5) * volatility;
        const price = basePrice * (1 + change * i * 0.01);

        labels.push(date.toISOString());
        data.push({
            timestamp: date.toISOString(),
            open: price * 0.999,
            high: price * 1.002,
            low: price * 0.998,
            close: price,
            volume: Math.floor(Math.random() * 1000000 + 100000)
        });
    }

    return { labels, data };
}

/**
 * Background tasks
 */
function startDataUpdates() {
    dataUpdateInterval = setInterval(async () => {
        if (connectedClients.size === 0) return;

        const symbols = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];
        const marketData = {};

        for (const symbol of symbols) {
            marketData[symbol] = await getCurrentMarketData(symbol);
        }

        const message = JSON.stringify({
            type: 'market_update',
            data: marketData
        });

        connectedClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });

    }, 5000);
}

/**
 * Server initialization
 */
async function initializeServer() {
    try {
        console.log('🚀 Initializing FS DASH Backend Server...');
        console.log('📱 Authentication Method: MPIN');

        const loginSuccess = await smartAPIManager.login();
        if (loginSuccess) {
            console.log('✅ SmartAPI connected successfully with MPIN');
        } else {
            console.log('⚠️  SmartAPI connection failed, using mock data');
            console.log('💡 Check your MPIN and TOTP credentials');
        }

        startDataUpdates();

        server.listen(PORT, () => {
            console.log(`\n🟢 FS DASH Server running on port ${PORT}`);
            console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/ws`);
            console.log(`🌐 REST API available at: http://localhost:${PORT}/api`);
            console.log(`📈 Angel One SmartAPI: ${isSmartAPIConnected ? '✅ Connected' : '❌ Disconnected'}`);
            console.log(`🔐 Auth Method: MPIN\n`);
        });

    } catch (error) {
        console.error('❌ Server initialization failed:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');

    if (dataUpdateInterval) {
        clearInterval(dataUpdateInterval);
    }

    connectedClients.forEach(client => {
        client.close();
    });

    db.close((err) => {
        if (err) {
            console.error(err.message);
        } else {
            console.log('🗄️  Database connection closed.');
        }
    });

    server.close(() => {
        console.log('✅ Server closed successfully');
        process.exit(0);
    });
});

initializeServer();
