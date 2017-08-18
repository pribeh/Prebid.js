/** @module adaptermanger */

import { flatten, getBidderCodes, shuffle } from './utils';
import { mapSizes } from './sizeMapping';
import { processNativeAdUnitParams, nativeAdapters } from './native';

var utils = require('./utils.js');
var CONSTANTS = require('./constants.json');
var events = require('./events');

var _bidderRegistry = {};
exports.bidderRegistry = _bidderRegistry;

// create s2s settings objectType_function
let _s2sConfig = {
  endpoint: CONSTANTS.S2S.DEFAULT_ENDPOINT,
  adapter: CONSTANTS.S2S.ADAPTER,
  syncEndpoint: CONSTANTS.S2S.SYNC_ENDPOINT
};

const RANDOM = 'random';
const FIXED = 'fixed';

const VALID_ORDERS = {};
VALID_ORDERS[RANDOM] = true;
VALID_ORDERS[FIXED] = true;

var _analyticsRegistry = {};
let _bidderSequence = RANDOM;

function getBids({bidderCode, auctionId, bidderRequestId, adUnits}) {
  return adUnits.map(adUnit => {
    return adUnit.bids.filter(bid => bid.bidder === bidderCode)
      .map(bid => {
        let sizes = adUnit.sizes;
        if (adUnit.sizeMapping) {
          let sizeMapping = mapSizes(adUnit);
          if (sizeMapping === '') {
            return '';
          }
          sizes = sizeMapping;
        }

        if (adUnit.nativeParams) {
          bid = Object.assign({}, bid, {
            nativeParams: processNativeAdUnitParams(adUnit.nativeParams),
          });
        }

        return Object.assign({}, bid, {
          placementCode: adUnit.code,
          mediaType: adUnit.mediaType,
          renderer: adUnit.renderer,
          transactionId: adUnit.transactionId,
          sizes: sizes,
          bidId: bid.bid_id || utils.getUniqueIdentifierStr(),
          bidderRequestId,
          auctionId
        });
      }
      );
  }).reduce(flatten, []).filter(val => val !== '');
}

function getAdUnitCopyForPrebidServer(adUnits) {
  let adaptersServerSide = _s2sConfig.bidders;
  let adUnitsCopy = utils.cloneJson(adUnits);

  // filter out client side bids
  adUnitsCopy.forEach((adUnit) => {
    if (adUnit.sizeMapping) {
      adUnit.sizes = mapSizes(adUnit);
      delete adUnit.sizeMapping;
    }
    adUnit.sizes = transformHeightWidth(adUnit);
    adUnit.bids = adUnit.bids.filter((bid) => {
      return adaptersServerSide.includes(bid.bidder);
    }).map((bid) => {
      bid.bid_id = utils.getUniqueIdentifierStr();
      return bid;
    });
  });

  // don't send empty requests
  adUnitsCopy = adUnitsCopy.filter(adUnit => {
    return adUnit.bids.length !== 0;
  });
  return adUnitsCopy;
}

exports.makeBidRequests = function(adUnits, auctionStart, auctionId, cbTimeout) {
  let bidRequests = [];
  let bidderCodes = getBidderCodes(adUnits);
  if (_bidderSequence === RANDOM) {
    bidderCodes = shuffle(bidderCodes);
  }

  const s2sAdapter = _bidderRegistry[_s2sConfig.adapter];
  if (s2sAdapter) {
    s2sAdapter.setConfig(_s2sConfig);
    s2sAdapter.queueSync({bidderCodes});
  }

  if (_s2sConfig.enabled) {
    // these are called on the s2s adapter
    let adaptersServerSide = _s2sConfig.bidders;

    // don't call these client side
    bidderCodes = bidderCodes.filter((elm) => {
      return !adaptersServerSide.includes(elm);
    });
    let adUnitsCopy = getAdUnitCopyForPrebidServer(adUnits);

    let tid = utils.generateUUID();
    adaptersServerSide.forEach(bidderCode => {
      const bidderRequestId = utils.getUniqueIdentifierStr();
      const bidderRequest = {
        bidderCode,
        auctionId,
        bidderRequestId,
        tid,
        bids: getBids({bidderCode, auctionId, bidderRequestId, 'adUnits': adUnitsCopy}),
        auctionStart: auctionStart,
        timeout: _s2sConfig.timeout,
        src: CONSTANTS.S2S.SRC
      };
      if (bidderRequest.bids.length !== 0) {
        bidRequests.push(bidderRequest);
      }
    });
  }

  bidderCodes.forEach(bidderCode => {
    const bidderRequestId = utils.getUniqueIdentifierStr();
    const bidderRequest = {
      bidderCode,
      auctionId,
      bidderRequestId,
      bids: getBids({bidderCode, auctionId, bidderRequestId, adUnits}),
      auctionStart: auctionStart,
      timeout: cbTimeout
    };
    if (bidderRequest.bids && bidderRequest.bids.length !== 0) {
      bidRequests.push(bidderRequest);
    }
  });
  return bidRequests;
}

exports.callBids = (adUnits, bidRequests, addBidResponse, done) => {
  let serverBidRequests = bidRequests.filter(bidRequest => {
    return bidRequest.src && bidRequest.src === CONSTANTS.S2S.SRC;
  });

  if (serverBidRequests.length) {
    let adaptersServerSide = _s2sConfig.bidders;
    const s2sAdapter = _bidderRegistry[_s2sConfig.adapter];
    let tid = serverBidRequests[0].tid;
    if (s2sAdapter) {
      let s2sBidRequest = {tid, 'ad_units': getAdUnitCopyForPrebidServer(adUnits)};
      utils.logMessage(`CALLING S2S HEADER BIDDERS ==== ${adaptersServerSide.join(',')}`);
      s2sAdapter.callBids(s2sBidRequest);
    }
  }

  bidRequests.forEach(bidRequest => {
    bidRequest.start = new Date().getTime();
    // TODO : Do we check for bid in pool from here and skip calling adapter again ?
    const adapter = _bidderRegistry[bidRequest.bidderCode];
    if (adapter) {
      utils.logMessage(`CALLING BIDDER ======= ${bidRequest.bidderCode}`);
      events.emit(CONSTANTS.EVENTS.BID_REQUESTED, bidRequest);
      bidRequest.doneCbCallCount = 0;
      let doneCb = done(bidRequest.bidderRequestId);
      adapter.callBids(bidRequest, addBidResponse, doneCb);
    } else {
      utils.logError(`Adapter trying to be called which does not exist: ${bidRequest.bidderCode} adaptermanager.callBids`);
    }
  });
}

function transformHeightWidth(adUnit) {
  let sizesObj = [];
  let sizes = utils.parseSizesInput(adUnit.sizes);
  sizes.forEach(size => {
    let heightWidth = size.split('x');
    let sizeObj = {
      'w': parseInt(heightWidth[0]),
      'h': parseInt(heightWidth[1])
    };
    sizesObj.push(sizeObj);
  });
  return sizesObj;
}

exports.videoAdapters = []; // added by adapterLoader for now

exports.registerBidAdapter = function (bidAdaptor, bidderCode, {supportedMediaTypes = []} = {}) {
  if (bidAdaptor && bidderCode) {
    if (typeof bidAdaptor.callBids === 'function') {
      _bidderRegistry[bidderCode] = bidAdaptor;

      if (supportedMediaTypes.includes('video')) {
        exports.videoAdapters.push(bidderCode);
      }
      if (supportedMediaTypes.includes('native')) {
        nativeAdapters.push(bidderCode);
      }
    } else {
      utils.logError('Bidder adaptor error for bidder code: ' + bidderCode + 'bidder must implement a callBids() function');
    }
  } else {
    utils.logError('bidAdaptor or bidderCode not specified');
  }
};

exports.aliasBidAdapter = function (bidderCode, alias) {
  var existingAlias = _bidderRegistry[alias];

  if (typeof existingAlias === 'undefined') {
    var bidAdaptor = _bidderRegistry[bidderCode];

    if (typeof bidAdaptor === 'undefined') {
      utils.logError('bidderCode "' + bidderCode + '" is not an existing bidder.', 'adaptermanager.aliasBidAdapter');
    } else {
      try {
        let newAdapter = new bidAdaptor.constructor();
        newAdapter.setBidderCode(alias);
        this.registerBidAdapter(newAdapter, alias);
      } catch (e) {
        utils.logError(bidderCode + ' bidder does not currently support aliasing.', 'adaptermanager.aliasBidAdapter');
      }
    }
  } else {
    utils.logMessage('alias name "' + alias + '" has been already specified.');
  }
};

exports.registerAnalyticsAdapter = function ({adapter, code}) {
  if (adapter && code) {
    if (typeof adapter.enableAnalytics === 'function') {
      adapter.code = code;
      _analyticsRegistry[code] = adapter;
    } else {
      utils.logError(`Prebid Error: Analytics adaptor error for analytics "${code}"
        analytics adapter must implement an enableAnalytics() function`);
    }
  } else {
    utils.logError('Prebid Error: analyticsAdapter or analyticsCode not specified');
  }
};

exports.enableAnalytics = function (config) {
  if (!utils.isArray(config)) {
    config = [config];
  }

  utils._each(config, adapterConfig => {
    var adapter = _analyticsRegistry[adapterConfig.provider];
    if (adapter) {
      adapter.enableAnalytics(adapterConfig);
    } else {
      utils.logError(`Prebid Error: no analytics adapter found in registry for
        ${adapterConfig.provider}.`);
    }
  });
};

exports.setBidderSequence = function (order) {
  if (VALID_ORDERS[order]) {
    _bidderSequence = order;
  } else {
    utils.logWarn(`Invalid order: ${order}. Bidder Sequence was not set.`);
  }
};

exports.setS2SConfig = function (config) {
  _s2sConfig = config;
};
