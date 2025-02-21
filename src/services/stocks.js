const fs = require("fs");
const path = require("path");
const _ = require("lodash");
const axios = require("axios");

const tradingPortfolio = require("./portfolio");
const tradingAlgos = require("./algos");
const outputs = require("./outputs");
const screeners = require("./screeners");

const stocksFile = path.join(
  path.dirname(process.mainModule.filename),
  "config",
  "stocks.json"
);

/**
 * Subscribes to market data on supplied stocks (via socket)
 *
 * @param {Object)} client
 * @param {Object[]} stocks
 * @param {Object} settings
 */
const subscribeToStocks = (client, stocks, settings) => {
  client.subscribeForBars(stocks);

  if (settings.isBacktest === false) {
    outputs.consoleOutputStockData(stocks, settings);
  }
};

/**
 * Gets stocks from screener + defaults (depending on settings)
 *
 * @param {Object} settings
 *
 * @returns {Object[]} stocks
 */
const getStocks = async settings => {
  let defaultStocks = JSON.parse(fs.readFileSync(stocksFile));
  let stocks = [];

  if (!settings.isBacktest) {
    if (settings.useStockScreener) {
      stocks = await screeners.getStocks();

      if (
        _.uniq(_.union(defaultStocks, stocks)).length <= 150 &&
        settings.useDefaultStocks
      ) {
        stocks = _.uniq(_.union(defaultStocks, stocks));
      }
    } else {
      stocks = defaultStocks;
    }
  } else {
    stocks = defaultStocks;
  }

  return _.take(_.uniq(stocks), 150);
};

/**
 * Gets a stock quote for a specific stock symbol / ticker
 *
 * @param {Object} stocks
 * @param {Object} settings
 *
 * @returns {Promise} stock
 */
const getStockQuote = async (stock, settings) => {
  return new Promise(function(resolve, reject) {
    let financialModelingPrepApiKey =
      process.env.FINANCIAL_MODELING_PREP_API_KEY;

    if (stock && financialModelingPrepApiKey) {
      axios
        .get(
          "https://financialmodelingprep.com/api/v3/quote/" +
            stock +
            "?apikey=" +
            financialModelingPrepApiKey
        )
        .then(response => {
          if (!_.isEmpty(response.data)) {
            stock = response.data[0];
            resolve(stock);
          } else {
            console.log("ERROR: StockQuote data empty");
            console.log(response);
            resolve([]);
          }
        })
        .catch(function(err) {
          console.log("ERROR: StockQuote api error");
          console.error(err);
          resolve([]);
        });
    } else {
      console.log("ERROR: StockQuote no stock provided");
      resolve([]);
    }
  });
};

/**
 * Gets stock data and initialize array of stock objects
 *
 * @param {(Alpaca|TradingProvider)} tradingProvider
 * @param {Object[]} stocks
 * @param {Object} settings
 * @param {Object[]} positions
 * @param {Object[]} orders
 * @param {(Object|null)} session
 * @param {(Object|null)} io
 * @param {number} limit
 * @param {Date} until
 * @param {string} lastOrder
 *
 * @returns {Object} stockData
 */
const initializeStockData = async (
  tradingProvider,
  stocks,
  settings,
  positions = [],
  orders = [],
  session = null,
  io = null,
  limit = 150,
  until = new Date(),
  lastOrder = "SELL"
) => {
  let stockData = {
    session: session,
    settings: settings,
    algos: [],
    io: io,
    haltTrading: false,
    marketClosing: false,
    lastRoi: 0,
    portfolio: {
      startingCapital: settings.startingCapital,
      cash: settings.startingCapital,
      positions: [], // list of current portfolio positions
      tmp: []
    },
    orders: orders, // list of orders (buy/sell) based on signals
    stocks: [] // list of subscribed stocks
  };

  if (!settings.isBacktest) {
    // add current positions to stocks to be subscribed to
    if (positions.length > 0) {
      stocks = _.union(stocks, _.map(positions, "symbol"));
    }

    // subscribe to stocks for market data via web socket
    await tradingProvider
      .getBars("1Min", stocks, {
        limit: limit,
        until: until
      })
      .then(async data => {
        stockData.stocks = createStockData(
          data,
          stocks,
          settings.isBacktest,
          lastOrder
        );

        // sync portfolio positions
        stockData = await tradingPortfolio.syncPortfolioPostions(
          tradingProvider,
          stockData,
          positions
        );
      });
  } else {
    stockData.stocks = createStockData(
      [],
      stocks,
      settings.isBacktest,
      lastOrder
    );

    return stockData;
  }

  return stockData;
};

/**
 * Updates stock data and initialize any new stock objects
 *
 * @param {(Alpaca|TradingProvider)} tradingProvider
 * @param {Object[]} stocks
 * @param {Object} stockData
 * @param {number} limit
 * @param {Date} until
 * @param {string} lastOrder
 *
 * @returns {Object} stockData
 */
const updateStockData = async (
  tradingProvider,
  stocks,
  stockData,
  limit = 150,
  until = new Date(),
  lastOrder = "SELL"
) => {
  if (!stockData.settings.isBacktest) {
    // subscribe to stocks for market data via web socket
    await tradingProvider
      .getBars("1Min", stocks, {
        limit: limit,
        until: until
      })
      .then(async data => {
        // save old stockData
        let oldStockData = stockData.stocks;

        // create stockData for new stocks
        stockData.stocks = createStockData(
          data,
          stocks,
          stockData.settings.isBacktest,
          lastOrder
        );

        // loop through algos to create initial setup for each stock
        stockData = tradingAlgos.initializeAlgos(stockData);

        // merge new and old stockData together
        stockData.stocks = _.union(stockData.stocks, oldStockData);
      });
  }

  return stockData;
};

/**
 * Creates initial stock data from retrieved bar data
 *
 * @param {Object} data
 * @param {Object[]} stocks
 * @param {boolean} isBacktest
 * @param {string} lastOrder
 *
 * @returns {Object} stockData
 */
const createStockData = (data, stocks, isBacktest, lastOrder) => {
  let stockData = [];
  let openValues = [];
  let closeValues = [];
  let highValues = [];
  let lowValues = [];
  let volumeValues = [];

  _.forOwn(stocks, stock => {
    if (!isBacktest) {
      openValues = _.map(data[stock], bar => bar.openPrice);
      closeValues = _.map(data[stock], bar => bar.closePrice);
      highValues = _.map(data[stock], bar => bar.highPrice);
      lowValues = _.map(data[stock], bar => bar.lowPrice);
      volumeValues = _.map(data[stock], bar => bar.volume);
    }

    stockData.push({
      symbol: stock,
      subject: stock,
      lastOrder: lastOrder,
      signals: [], // list of signals (buy/sell) based on algos
      closeValues: closeValues,
      openValues: openValues,
      highValues: highValues,
      lowValues: lowValues,
      volumeValues: volumeValues,
      price: 0
    });
  });

  return stockData;
};

module.exports = {
  subscribeToStocks,
  getStocks,
  getStockQuote,
  initializeStockData,
  updateStockData,
  createStockData
};
