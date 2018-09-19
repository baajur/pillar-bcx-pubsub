#!/usr/bin/env node
/** @module publisher.js */
'use strict';
require('dotenv').config();
const logger = require('./utils/logger');
const ethService = require('./services/ethService.js');
const rmqServices = require('./services/rmqServices.js');
const hashMaps = require('./utils/hashMaps.js');
const redis = require('redis');
let client = redis.createClient();

let runId = 0;
let latestId = '';
const heapdump = require('heapdump');
const memwatch = require('memwatch-next');
const sizeof = require('sizeof');
let hd;


/**
 * Handle REDIS client connection errors
 */
client.on("error", function (err) {
  logger.error("Publisher failed with REDIS client error: " + err);
});
/**
 * subscribe to memory leak events
 */
memwatch.on('leak',function(info) {
  logger.info('Publisher: MEMORY LEAK: ' + JSON.stringify(info));
  logger.info('Hashmap counts: Accounts= ' + hashMaps.accounts.keys().length + ', Assets= ' + hashMaps.assets.keys().length + 
              ', PendingTx= ' + hashMaps.pendingTx.keys().length + ', PendingAssets= ' + hashMaps.pendingAssets.keys().length);
  logger.info('Hashmap size: Accounts= ' + sizeof.sizeof(hashMaps.accounts,true) + ', Assets= ' + sizeof.sizeof(hashMaps.assets,true) + 
              ', PendingTx= ' + sizeof.sizeof(hashMaps.pendingTx,true) + ', PendingAssets= ' + sizeof.sizeof(hashMaps.pendingAssets,true));
  heapdump.writeSnapshot((err, fname ) => {
    logger.info('Heap dump written to', fname);
  });
});

memwatch.on('stats',function(stats) {
  logger.info('Publisher: GARBAGE COLLECTION: ' + JSON.stringify(stats));
  logger.info('Size of hashmaps: Accounts= ' + hashMaps.accounts.keys().length + ', Assets= ' + hashMaps.assets.keys().length + 
              ', PendingTx= ' + hashMaps.pendingTx.keys().length + ', PendingAssets= ' + hashMaps.pendingAssets.keys().length);
  logger.info('Hashmap size: Accounts= ' + sizeof.sizeof(hashMaps.accounts,true) + ', Assets= ' + sizeof.sizeof(hashMaps.assets,true) + 
              ', PendingTx= ' + sizeof.sizeof(hashMaps.pendingTx,true) + ', PendingAssets= ' + sizeof.sizeof(hashMaps.pendingAssets,true));
});

/**
 * Function handling IPC notification that are received from the master
 * @param {any} message - The IPC message that sent from the master
 */
process.on('message', (data) => {
  try {
    const { message } = data;
    logger.info(`Publisher has received message from master: ${data.type}`);
    
    if (data.type === 'accounts') {
      console.log(`Publisher received accounts: ${message.length} to monitor.`);
      for (let i = 0; i < message.length; i++) {
        const obj = message[i];
        if(obj !== undefined) {
          hashMaps.accounts.set(obj.walletId.toLowerCase(), obj.pillarId);
          logger.info(`Publisher received notification to monitor: ${obj.walletId.toLowerCase()} for pillarId: ${obj.pillarId} , accountsSize: ${hashMaps.accounts.keys().length}`);
          latestId = obj.id;
        }
      }
      logger.info(`Caching ${message.length} wallets to REDIS server for publisher: pub_${runId}`);
      client.append(`pub_${runId}`,JSON.stringify(message),redis.print);
    } else if (data.type === 'assets') {
      logger.info('Publisher initializing assets.');
      // add the new asset to the assets hashmap
      for (let i = 0; i < message.length; i++) {
        const obj = message[i];
        if(obj !== undefined) {
          hashMaps.assets.set(obj.contractAddress.toLowerCase(), obj);
          logger.info(`Publisher received notification to monitor a new asset: ${obj.contractAddress.toLowerCase()}, assetsSize: ${hashMaps.assets.keys().length}`);
          ethService.subscribeTransferEvents(obj.contractAddress);
        }
      }
    }
  }catch(e) {
    logger.error('Publisher: Error occured in publisher: ' + e);
  }
});

/**
 * Function that initializes inter process communication queue
 */
exports.initIPC = function () {
  return new Promise((resolve, reject) => {
    try {
      logger.info('Started executing publisher.initIPC()');
      logger.info('Publisher requesting master a list of assets to monitor');

      if(process.argv[2] === undefined) {
        throw ({ message: 'Invalid runId parameter.' });
      } else {
        runId = process.argv[2];
      }

      process.send({ type: 'assets.request' });
      setTimeout(() => {
        logger.info('Publisher Initializing RMQ.');
        rmqServices.initPubSubMQ()
        exports.initSubscriptions();
      }, 100);

      //request list of assets to be monitored
      process.send({ type: 'assets.request' });
  
      logger.info('Publisher polling master for new wallets every 5 seconds');
      setInterval(() => {
          exports.poll();
        }, 
        5000
      );
    } catch (err) {
      logger.error('Publisher.init() failed: ', err.message);
      // throw err;
      reject(err);
    } finally {
      logger.info('Exited publisher.initIPC()');
      resolve();
    }
  });
};

/**
 * Function that continuosly polls master for new wallets/assets.
 */
exports.poll = function () {
  if (hashMaps.assets.count() === 0) {
    process.send({ type: 'assets.request' });
  }
  // request new wallets
  logger.info('Publisher.poll() - Reporting the size of hashmaps  -    ***************************');
  console.log('Hashmap size: Accounts= ' + sizeof.sizeof(hashMaps.accounts,true) + ', Assets= ' + sizeof.sizeof(hashMaps.assets,true) + 
              ', PendingTx= ' + sizeof.sizeof(hashMaps.pendingTx,true) + ', PendingAssets= ' + sizeof.sizeof(hashMaps.pendingAssets,true)); 
  logger.info('Size of hashmaps: Accounts= ' + hashMaps.accounts.keys().length + ', Assets= ' + hashMaps.assets.keys().length + 
              ', PendingTx= ' + hashMaps.pendingTx.keys().length + ', PendingAssets= ' + hashMaps.pendingAssets.keys().length);
  logger.info('Hashmap size: Accounts= ' + sizeof.sizeof(hashMaps.accounts,true) + ', Assets= ' + sizeof.sizeof(hashMaps.assets,true) + 
              ', PendingTx= ' + sizeof.sizeof(hashMaps.pendingTx,true) + ', PendingAssets= ' + sizeof.sizeof(hashMaps.pendingAssets,true));             
  logger.info('************************************************************************************************************');
  process.send({ type: 'wallet.request', message: latestId });
};

/**
 * Function that initializes the geth subscriptions
 */
exports.initSubscriptions = function () {
  logger.info('Publisher subscribing to geth websocket events...');
  //subscribe to pending transactions
  ethService.subscribePendingTxn();
  //subscribe to block headers
  ethService.subscribeBlockHeaders();
  if (hashMaps.assets.count() > 0) {
    //subscribe to transfer events of each monitored smart contract
    const smartContractsArray = hashMaps.assets.values();
    smartContractsArray.forEach((ERC20SmartContract) => {
      ethService.subscribeTransferEvents(ERC20SmartContract.contractAddress);
    });
  }
  logger.info('Publisher completed websocket subscriptions.');
};

this.initIPC();

