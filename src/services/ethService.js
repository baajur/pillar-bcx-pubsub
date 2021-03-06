/*
Copyright (C) 2019 Stiftung Pillar Project

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

/** @module ethService.js */
const logger = require('../utils/logger');
const Web3 = require('web3');
const abiDecoder = require('abi-decoder');
const ERC20ABI = require('../abi/ERC20ABI');
const ERC721ABI = require('../abi/ERC721ABI');
const processTx = require('./processTx');
const rmqServices = require('./rmqServices');
const hashMaps = require('../utils/hashMaps');
const redisService = require('./redisService');
const config = require('../config');
const abiService = require('./abiService');
const web3ApiService = require('./web3ApiService');
const dbServices = require('../services/dbServices.js');

const protocol = 'Ethereum';
const localGethUrl = 'http://127.0.0.1:8545';
const gethUrl = `${config.get('geth.url')}`;
const parityURL = `${config.get('parity.url')}:${config.get('parity.port')}`;
const nodeUrl = config.get('geth.url') ? gethUrl : parityURL;
const ParityTraceModule = require('@pillarwallet/pillar-parity-trace');
const parityTrace = new ParityTraceModule({HTTPProvider: parityURL});
const offersHash = config.get('redis.offersHash');
let web3,localWeb3;
let wsCnt = 0;
const BLOCKS_TO_WAIT_BEFORE_REPLACED = parseInt(config.get('blocksToWaitBeforeReplace'));
let client;
try {
  client = redisService.connectRedis();
  logger.info('ethService successfully connected to Redis server');
  client.on('error', err => {
    logger.error(`ethService failed with REDIS client error: ${err}`);
  });
  dbServices.dbConnect().then(() => {
    logger.info('ethService successfully connected to db');
  });
} catch (e) {
  logger.error(e);
}
/**
 * Establish connection to the geth node
 */
function connect() {
  return new Promise((resolve, reject) => {
    try {
      if (
        web3 === undefined ||
        !web3.currentProvider ||
        !web3.eth.isSyncing()
      ) {
        const isWebSocket =
          nodeUrl.indexOf('ws://') >= 0 || nodeUrl.indexOf('wss://') >= 0;
        if (isWebSocket) {
          web3 = new Web3(new Web3.providers.WebsocketProvider(nodeUrl));
        } else {
          web3 = new Web3(new Web3.providers.HttpProvider(nodeUrl));
        }
        if (isWebSocket) {
          web3.currentProvider.on('end', eventObj => {
            logger.error(
              'Websocket disconnected!! Restarting connection....',
              eventObj);
            web3 = undefined;
            module.exports.web3 = undefined;
          });
          web3.currentProvider.on('close', eventObj => {
            logger.error(
              'Websocket disconnected!! Restarting connection....',
              eventObj);
            web3 = undefined;
            module.exports.web3 = undefined;
          });
          web3.currentProvider.on('error', eventObj => {
            logger.error(
              'Websocket disconnected!! Restarting connection....',
              eventObj);
            web3 = undefined;
            module.exports.web3 = undefined;
          });
        }
        logger.info(
          `ethService.connect(): Connection to ${nodeUrl} established successfully!`,
        );
        module.exports.web3 = web3;
        resolve(true);
      } else {
        resolve(true);
      }
    } catch (e) {
      logger.error(`ethService.connect() failed with error: ${e}`);
      reject(false);
    }
  });
}
module.exports.connect = connect;

/**
 * Establish connection to the local light geth node
 */
function localConnect() {
  return new Promise(((resolve, reject) => {
      try {
          if (localWeb3 === undefined || (!localWeb3.eth.isSyncing())) {
            localWeb3 = new Web3(new Web3.providers.HttpProvider(localGethUrl)); 
            logger.info('ethService.localConnect(): Connection to ' + localGethUrl + ' established successfully!');
            module.exports.localWeb3 = localWeb3;
            resolve(true);
          } else {
            resolve(true);
          }
      } catch(e) { 
          logger.error('ethService.localConnect() failed with error: ' + e);
          reject(false); 
      }
  }));
}
module.exports.localConnect = localConnect;

/**
 * Return an instance to the underlying web3 instance
 */
function getWeb3() {
  logger.info(
    'ethService.getWeb3(): fetches the current instance of web3 object',
  );
  return new Promise((resolve, reject) => {
    if (module.exports.connect()) {
      resolve(web3);
    } else {
      reject();
    }
  });
}
module.exports.getWeb3 = getWeb3;

/**
 * Subscribe to geth WS event corresponding to new pending transactions.
 */
function subscribePendingTxn() {
  logger.info(
    'ethService.subscribePendingTxn(): Subscribing to list of pending transactions.',
  );
  if (module.exports.connect()) {
    web3.eth
      .subscribe('pendingTransactions', (err, res) => {
        if (!err) {
          logger.debug(
            `ethService.subscribePendingTxn(): pendingTransactions subscription status : ${res}`,
          );
        } else {
          logger.error(
            `ethService.subscribePendingTxn(): pendingTransactions subscription errored : ${err}`,
          );
        }
      })
      .on('data', txHash => {
        logger.debug(
          `ethService.subscribePendingTxn(): received notification for txHash: ${txHash}`,
        );
        if (txHash !== null && txHash !== '') {
          logger.debug(
            `ethService.subscribePendingTxn(): fetch txInfo for hash: ${txHash}`,
          );
              getTransaction(txHash).then(txInfo => {
                if (txInfo !== null) {
                  processTx.newPendingTran(txInfo, protocol);
                }
              })
              .catch(e => {
                logger.error(
                  `ethService.subscribePendingTxn() failed with error: ${e}`,
                );
              });
        }
      })
      .on('error', err => {
        logger.error(
          `ethService.subscribePendingTxn() failed with error: ${err}`,
        );
      });
    logger.info(
      'ethService.subscribePendingTxn() has successfully subscribed to pendingTransaction events',
    );
  } else {
    logger.error(
      'ethService.subscribePendingTxn(): Connection to geth failed!',
    );
  }
}
module.exports.subscribePendingTxn = subscribePendingTxn;

/**
 * Subscribe to geth WS events corresponding to new block headers.
 */
function subscribeBlockHeaders() {
  logger.info(
    'ethService.subscribeBlockHeaders(): Subscribing to block headers.',
  );
  if (module.exports.connect()) {
    web3.eth
      .subscribe('newBlockHeaders', (err, res) => {
        if (!err) {
          logger.debug(
            `ethService.subscribeBlockHeaders(): newBlockHeader subscription status : ${res}`,
          );
        } else {
          logger.error(
            `ethService.subscribeBlockHeaders(): newBlockHeader subscription errored : ${err}`,
          );
        }
      })
      .on('data', blockHeader => {
        logger.info(
          `ethService.subscribeBlockHeaders(): new block : ${
            blockHeader.number
          }`,
        );
        if (blockHeader && blockHeader.number && blockHeader.hash) {
          if (blockHeader.number === hashMaps.LATEST_BLOCK_NUMBER) {
            wsCnt += 1;
            // if the same block number is reported for 5 times, then report websocket is stale
            if (wsCnt === 5) {
              logger.error(
                '## WEB SOCKET STALE?? NO NEW BLOCK REPORTED FOR PAST 5 TRIES!####',
              );
            }
          } else {
            wsCnt = 0;
          }
          hashMaps.LATEST_BLOCK_NUMBER = blockHeader.number;
          logger.info(
            `ethService.subscribeBlockHeaders(): NEW BLOCK MINED : # ${
              blockHeader.number
            } Hash = ${blockHeader.hash}`,
          );
          // Check for pending tx in database and update their status
          if(hashMaps.pendingTx.pendingTx.size > 0) {
            module.exports
              .checkPendingTx(
                hashMaps.pendingTx.pendingTx,
                blockHeader.number,
              )
              .then(() => {
                logger.debug(
                  'ethService.subscribeBlockHeaders(): Finished validating pending transactions.',
                );
              });
          }

          //module.exports.checkNewAssets(hashMaps.pendingAssets.keys());

          // capture gas price statistics
          module.exports.storeGasInfo(blockHeader);

          // Check Offers Transactions status
          client.hkeys(offersHash, (err , offersList) => {
            if(err) {
              logger.error(
                `ethService.subscribePendingTxn() failed with error: ${err}`)
              return false;
            } 
            if(!offersList)
              return false;
            offersList.forEach(async transaction => {
                const txObject = await getTxInfo(transaction);
                if(!txObject)
                  return false;
                rmqServices.sendOffersMessage(txObject);
                client.hdel(offersHash, transaction);
            });
          });
        }
      })
      .on('error', err => {
        logger.error(
          `ethService.subscribePendingTxn() failed with error: ${err}`,
        );
      });
  } else {
    logger.error(
      'ethService.subscribeBlockHeaders(): Connection to geth failed!',
    );
  }
}
module.exports.subscribeBlockHeaders = subscribeBlockHeaders;

/**
 * Determin the gas price and store the details.
 * @param {any} blockHeader - the event object corresponding to the current block
 */
function storeGasInfo(blockHeader) {
  logger.info(
    `ethService.storeGasInfo(): fetching gas information for block number ${
      blockHeader.number
    }`,
  );
  let entry;
  try {
    entry = {
      type: 'tranStat',
      protocol,
      gasLimit: blockHeader.gasLimit,
      gasUsed: blockHeader.gasUsed,
      blockNumber: blockHeader.number,
      avgGasPrice: null,
      transactionCount: null,
    };
    rmqServices.sendPubSubMessage(entry);
  } catch (e) {
    logger.error(`ethService.storeGasInfo() failed with error ${e}`);
  }
}
module.exports.storeGasInfo = storeGasInfo;

/**
 * Subscribe to token transfer event corresponding to a given smart contract.
 * @param {any} theContract - the smart contract address
 */
function subscribeTransferEvents(theContract) {
  try {
    logger.info(
      `ethService.subscribeTransferEvents() subscribed to events for contract: ${
        theContract.contractAddress
      }`,
    );
    if (module.exports.connect()) {
      if (web3.utils.isAddress(theContract.contractAddress)) {
        const ERC20SmartContractObject = new web3.eth.Contract(
          ERC20ABI,
          theContract.contractAddress,
        );
        ERC20SmartContractObject.events.Transfer({}, (error, result) => {
          logger.debug(
            `ethService: Token transfer event occurred for contract: ${JSON.stringify(
              theContract,
            )} result: ${result} error: ${error}`,
          );
          if (!error) {
            processTx.checkTokenTransfer(result, theContract, protocol, web3);
          } else {
            logger.error(
              `ethService.subscribeTransferEvents() failed: ${error}`,
            );
          }
        });
      }
    } else {
      logger.error(
        'ethService.subscribeTransferEvents(): Connection to geth failed!',
      );
    }
  } catch (e) {
    logger.error(`ethService.subscribeTransferEvents() failed: ${e}`);
  }
}
module.exports.subscribeTransferEvents = subscribeTransferEvents;

/**
 * Fetch transaction details corresponding to given block number
 * @param {Number} blockNumber - the block number
 */
function getBlockTx(blockNumber) {
  return new Promise((resolve, reject) => {
    logger.debug(
      `ethService.getBlockTx(): Fetch transactions from block: ${blockNumber}`,
    );
    try {
      if (module.exports.connect()) {
        resolve(web3.eth.getBlock(blockNumber, true));
      } else {
        reject(
          new Error('ethService.getBlockTx Error: Connection to geth failed!'),
        );
      }
    } catch (e) {
      logger.error(`ethService.getBlockTx(): ${e}`);
      reject(e);
    }
  });
}
module.exports.getBlockTx = getBlockTx;

/**
 * Fetch block number for a given block hash
 * @param {any} blockHash - the block hash
 */
function getBlockNumber(blockHash) {
  return new Promise((resolve, reject) => {
    try {
      if (module.exports.connect()) {
        web3.eth.getBlock(blockHash).then(result => {
          resolve(result.number);
        });
      } else {
        reject(
          new Error(
            'ethService.getBlockNumber Error: Connection to geth failed!',
          ),
        );
      }
    } catch (e) {
      reject(e);
    }
  });
}
module.exports.getBlockNumber = getBlockNumber;

/**
 * Fetch the latest block number
 */
function getLastBlockNumber() {
  if (module.exports.connect()) {
    return web3.eth.getBlockNumber();
  }
  logger.error('ethService.getLastBlockNumber(): connection to geth failed!');
  return undefined;
}
module.exports.getLastBlockNumber = getLastBlockNumber;

/**
 * Fetch the transaction receipt corresponding to a given transaction hash
 * @param {String} txHash - the transaction hash
 */
async function getTxReceipt(txHash) {
    if (module.exports.localConnect()) {
      let recipt = await localWeb3.eth.getTransactionReceipt(txHash);
      if(recipt){
        return recipt;
      }
      return null;
    }
    logger.error('ethService.getTxReceipt(): connection to geth failed!');
    return undefined;
}
module.exports.getTxReceipt = getTxReceipt;


/**
 * Fetch the transaction receipt corresponding to a given transaction hash
 * @param {String} txHash - the transaction hash
 */
async function getTransaction(txHash) {
    if (module.exports.localConnect()) {
      let txInfo = await localWeb3.eth.getTransaction(txHash);
      if (txInfo) {
        return txInfo;
      }
    }
    if (module.exports.connect()) {
      return web3ApiService.getAndRetry('getTransaction', txHash);
    }
    logger.error('ethService.getTxReceipt(): connection to geth failed!');
    return undefined;
}
module.exports.getTransaction = getTransaction;


/**
 * Fetch the total number of transactions within a given block
 * @param {String} hashStringOrBlockNumber - block hash or block number
 */
function getBlockTransactionCount(hashStringOrBlockNumber) {
  if (module.exports.connect()) {
    return  web3ApiService.getAndRetry("getBlockTransactionCount",hashStringOrBlockNumber)
  }
  logger.error(
    'ethService.getBlockTransactionCount(): connection to geth failed!',
  );
  return undefined;
}
module.exports.getBlockTransactionCount = getBlockTransactionCount;

/**
 * Fetch the transaction corresponding to a given block and index
 * @param {String} hashStringOrBlockNumber - block hash or block number
 * @param {Number} index - index number
 */
function getTransactionFromBlock(hashStringOrBlockNumber, index) {
  if (module.exports.connect()) {
    return web3.eth.getTransactionFromBlock(hashStringOrBlockNumber, index);
  }
  logger.error(
    'ethService.getTransactionFromBlock(): connection to geth failed!',
  );
  return undefined;
}
module.exports.getTransactionFromBlock = getTransactionFromBlock;

/**
 * Check the status of the given transaction hashes
 * @param {any} pendingTxArray - an array of transaction hashes
 */
function checkPendingTx(pendingTxArray, blockNumber) {
  logger.info(
    `ethService.checkPendingTx(): pending tran count: ${pendingTxArray.size}`,
  );
  return new Promise((resolve, reject) => {
    pendingTxArray.forEach(item => {
      logger.debug(
        `ethService.checkPendingTx(): Checking status of transaction: ${
          item.txHash
        }`,
      );
      if (module.exports.localConnect()) {
        getTxReceipt(item.txHash).then(async receipt => {
          logger.debug(`ethService.checkPendingTx(): receipt is ${receipt}`);
          if (receipt !== null) {
            let status;
            const { gasUsed } = receipt;
            if (receipt.status === '0x1' || receipt.status === true) {
              status = 'confirmed';
            } else {
              status = 'failed';
            }
            const txMsg = {
              type: 'updateTx',
              txHash: item.txHash,
              protocol: item.protocol,
              fromAddress: item.fromAddress,
              toAddress: item.toAddress,
              value: item.value,
              asset: item.asset,
              contractAddress: item.contractAddress,
              status,
              gasUsed,
              blockNumber: receipt.blockNumber,
              input: item.input,
              tokenId: item.tokenId,
              tranType: item.tranType,
              nonce: item.nonce
            };
            rmqServices.sendPubSubMessage(txMsg);
            hashMaps.pendingTxBlockNumber.delete(item.txHash);
            hashMaps.pendingTx.delete(item.txHash);
            logger.info(
              `ethService.checkPendingTx(): TRANSACTION ${
                item.txHash
              } CONFIRMED @ BLOCK # ${receipt.blockNumber}`,
            );
          } else {
            let itemAddedBlockNumber = hashMaps.pendingTxBlockNumber.get(item.txHash);
            if (blockNumber - itemAddedBlockNumber >= BLOCKS_TO_WAIT_BEFORE_REPLACED) {
              dbServices.dbCollections.transactions.findByAddressAndNounce(item.fromAddress, item.nonce).then(tx => {
                let txMsg = { type: 'updateTx', txHash: item.txHash, protocol: item.protocol, fromAddress: item.fromAddress, toAddress: item.toAddress, value: item.value, asset: item.asset, contractAddress: item.contractAddress, input: item.input, tokenId: item.tokenId, tranType: item.tranType };
                let txStatus = "dropped"
                if (tx != null) {
                  txStatus = "replaced"
                  txMsg.txHashReplaced = tx.txHash;
                }
                
                txMsg.status = txStatus;

                
                rmqServices.sendPubSubMessage(txMsg);
                hashMaps.pendingTxBlockNumber.delete(item.txHash);
                hashMaps.pendingTx.delete(item.txHash);
                logger.debug(`ethService.checkPendingTx(): Txn ${item.txHash} will be ${txStatus}. blockNumber: ${blockNumber} txBlock: ${itemAddedBlockNumber}`);
              })
            } else {
              logger.debug(`ethService.checkPendingTx(): Txn ${item.txHash} is still pending. blockNumber: ${blockNumber} txBlock: ${itemAddedBlockNumber}`);
            }
          }
        });
      } else {
        reject(
          new Error('ethService.checkPendingTx(): connection to geth failed!'),
        );
      }
    });
  });
}
module.exports.checkPendingTx = checkPendingTx;

/**
 * Check if a new pending transaction corresponds to an asset
 * @param {any} pendingAssets - an array of transaction hashes
 */
function checkNewAssets(pendingAssets) {
  logger.info(
    `ethService.checkNewAsset(): pending asset count: ${pendingAssets.length}`,
  );
  return new Promise((resolve, reject) => {
    if (pendingAssets.length === 0) {
      resolve();
    } else {
      pendingAssets.forEach(item => {
        const hash = typeof item.hash !== 'undefined' ? item.hash : item.txHash;
        hashMaps.pendingAssets.delete(hash);
        logger.debug(
          `ethService.checkNewAssets(): Checking status of transaction: ${item}`,
        );
        if (module.exports.connect()) {
          web3ApiService.getAndRetry("getTransactionReceipt",item).then(receipt => {
            logger.debug(
              `ethService.checkNewAssets(): receipt is ${JSON.stringify(
                receipt,
              )}`,
            );
            if (receipt !== null && receipt.contractAddress !== null) {
              // check if contract is an ERC20
              if (!module.exports.addERC20(receipt)) {
                module.exports.addERC721(receipt);
              }
            } else {
              logger.debug(
                `ethService.checkPendingTx(): Txn ${item} is still pending.`,
              );
              
              hashMaps.pendingAssets.set(hash, item);
            }
          });
        } else {
          hashMaps.pendingAssets.set(hash, item);
          reject(
            new Error(
              'ethService.checkPendingTx(): connection to geth failed!',
            ),
          );
        }
      });
    }
  });
}
module.exports.checkNewAssets = checkNewAssets;

/**
 * Validated if a given transaction corresponds to the deployment of a token contract
 * @param {any} receipt - the transaction receipt
 */
async function addERC20(receipt) {
  let contract;
  try {
    contract = new web3.eth.Contract(ERC20ABI, receipt.contractAddress);
    const symbol = await contract.methods.symbol().call();
    const name = await contract.methods.name().call();
    const decimals = await contract.methods.decimals().call();
    const totalSupply = await contract.methods.totalSupply().call();

    if (receipt.status === '0x1' || receipt.status === true) {
      const txMsg = {
        type: 'newAsset',
        name,
        symbol,
        decimals,
        contractAddress: receipt.contractAddress,
        totalSupply,
        category: 'Token',
        protocol,
      };
      rmqServices.sendPubSubMessage(txMsg);
      logger.info(
        `ethService.addERC20(): Identified a new ERC20 asset (${
          receipt.contractAddress
        }) in block: ${receipt.blockNumber}`,
      );
    }
    hashMaps.pendingAssets.delete(receipt.transactionHash);
    return true;
  } catch (e) {
    logger.error(
      `ethService.addERC20(): deployed contract ${
        receipt.contractAddress
      } is not ERC20.`,
    );
    hashMaps.pendingAssets.delete(receipt.transactionHash);
    return false;
  }
}
module.exports.addERC20 = addERC20;

/**
 * Validated if a given transaction corresponds to the deployment of a collectible contract
 * @param {any} txn - the transaction receipt
 */
async function addERC721(receipt) {
  let contract;
  try {
    contract = new web3.eth.Contract(ERC721ABI, receipt.contractAddress);
    const symbol = await contract.methods.symbol().call();
    const name = await contract.methods.name().call();

    if (receipt.status === '0x1' || receipt.status === true) {
      const txMsg = {
        type: 'newAsset',
        name,
        symbol,
        decimals: 0,
        contractAddress: receipt.contractAddress,
        totalSupply: 1,
        category: 'Collectible',
        protocol,
      };
      rmqServices.sendPubSubMessage(txMsg);
      logger.info(
        `ethService.addERC721(): Identified a new ERC20 asset (${
          receipt.contractAddress
        }) in block: ${receipt.blockNumber}`,
      );
    }
    hashMaps.pendingAssets.delete(receipt.transactionHash);
    return true;
  } catch (e) {
    logger.error(
      `ethService.addERC721(): deployed contract ${
        receipt.contractAddress
      } is not ERC721.`,
    );
    hashMaps.pendingAssets.delete(receipt.transactionHash);
    return false;
  }
}
module.exports.addERC721 = addERC721;

async function getAllTransactionsForWallet(
  wallet,
  fromBlockNumberParam,
  toBlockNumberParam,
) {
  let fromBlockNumber = fromBlockNumberParam;
  let toBlockNumber = toBlockNumberParam;
  logger.debug(
    `ethService.getAllTransactionsForWallet(${wallet}) started processing`,
  );
  if (module.exports.connect()) {
    if (!fromBlockNumber) {
      fromBlockNumber = 'earliest';
    }

    if (!toBlockNumber) {
      toBlockNumber = 'latest';
    }

    const transTo = await parityTrace.filter({
      fromBlock: fromBlockNumber,
      toBlock: toBlockNumber,
      toAddress: [wallet.toLowerCase()],
    });

    const transFrom = await parityTrace.filter({
      fromBlock: fromBlockNumber,
      toBlock: toBlockNumber,
      fromAddress: [wallet.toLowerCase()],
    });
    return transTo.result.concat(transFrom.result);
  }
  logger.error(
    `ethService.getAllTransactionsForWallet() - failed connecting to web3 provider`,
  );
  return new Error(
    `ethService.getAllTransactionsForWallet() - failed connecting to web3 provider`,
  );
}
module.exports.getAllTransactionsForWallet = getAllTransactionsForWallet;

async function getTransactionCountForWallet(wallet) {
  try {
    logger.debug(
      `ethService.getTransactionCountForWallet(${wallet}) started processing`,
    );
    if (module.exports.connect()) {
      const transCount = await web3.eth.getTransactionCount(
        wallet.toLowerCase(),
      );
      logger.info(
        `ethService.getTransactionCountForWallet(${wallet}) resolved ${transCount}`,
      );
      return transCount;
    }
    logger.error(
      `ethService.getTransactionCountForWallet() - failed connecting to web3 provider`,
    );
    return undefined;
  } catch (err) {
    logger.error(
      `ethService.getTransactionCountForWallet(${wallet}) - failed with error - ${err}`,
    );
    return undefined;
  }
}
module.exports.getTransactionCountForWallet = getTransactionCountForWallet;

/**
 * Gets the transaction info/receipt and returns the transaction object
 * @param {string} txHash Transaction hash
 */
async function getTxInfo(txHash) {
  try {
    // Check if is a valid hash
    if(!txHash.match(/^0x([A-Fa-f0-9]{64})$/))
      return null
    const [txInfo, txReceipt] = await Promise.all([
      web3ApiService.getAndRetry("getTransaction",txHash),
      web3ApiService.getAndRetry("getTransactionReceipt",txHash),
    ]);
    if(!txReceipt)
      return null
    const txObject = {
      txHash: txInfo.hash,
      fromAddress: txInfo.from,
      toAddress: txInfo.to,
      value: txInfo.value,
      asset: 'ETH',
      contractAddress: null,
      status: (txReceipt.status === true
               || txReceipt.status === '0x1') ? 'confirmed' : 'failed',
      gasPrice: txInfo.gasPrice,
      gasUsed: txReceipt.gasUsed,
      blockNumber: txReceipt.blockNumber,
    };
    if (txInfo.input !== '0x') {
      let jsonAbi;
      const contractDetail = hashMaps.assets.get(txInfo.to.toLowerCase());
      if (!contractDetail)
        return logger.error(`Not a monitored contract: ${txInfo.to}`);
      txObject.asset = contractDetail.symbol;
      jsonAbi = abiService.requireAbi(txObject.asset);
      if (!jsonAbi) {
        logger.error(
          `Asset ABI not found ${txObject.asset}, using standard ERC20`,
        );
        jsonAbi = ERC20ABI;
      }
      txObject.contractAddress = txInfo.to;
      abiDecoder.addABI(jsonAbi);
      const data = abiDecoder.decodeMethod(txInfo.input);
      const [to, value] = data.params;
      [txObject.toAddress, txObject.value] = [to.value, value.value];
    }
    return txObject;
  } catch (e) {
    logger.error(`getTxInfo(${txHash}) failed with error: ${e}`);
  }
}

module.exports.getTxInfo = getTxInfo;
