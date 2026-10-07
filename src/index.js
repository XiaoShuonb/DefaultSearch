import { readFileSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';
import { setDefaultAutoSelectFamily } from 'node:net';

setDefaultResultOrder('ipv4first');
setDefaultAutoSelectFamily(false);

loadDotEnv();

const config = {
  botToken: requiredEnv('BOT_TOKEN'),
  ownerId: requiredEnv('OWNER_ID'),
  dbFile: process.env.DB_FILE || './data/defaultsearch.sqlite',
  unauthorizedMode: process.env.UNAUTHORIZED_MODE || 'silent',
  pollTimeoutSeconds: numberEnv('POLL_TIMEOUT_SECONDS', 0),
  pollIntervalMs: numberEnv('POLL_INTERVAL_MS', 2000),
  apiTimeoutSeconds: numberEnv('API_TIMEOUT_SECONDS', 12),
  tronApiRetries: numberEnv('TRON_API_RETRIES', 3),
  pageSize: numberEnv('PAGE_SIZE', 8),
  tronGridApiKey: process.env.TRON_GRID_API_KEY || '',
  tronGridBase: trimSlash(process.env.TRON_GRID_BASE || 'https://api.trongrid.io'),
  monitorIntervalSeconds: numberEnv('MONITOR_INTERVAL_SECONDS', 20),
  monitorTxLimit: numberEnv('MONITOR_TX_LIMIT', 20),
  historyScanLimit: numberEnv('HISTORY_SCAN_LIMIT', 1000),
  pendingActionTimeoutSeconds: numberEnv('PENDING_ACTION_TIMEOUT_SECONDS', 300),
  fallbackUsdtCnyPrice: numberEnv('FALLBACK_USDT_CNY_PRICE', 7.2),
};

const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_CONTRACT_HEX = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';
const TRONSCAN_ADDRESS_BASE = 'https://tronscan.org/address/';
const TRONSCAN_TX_BASE = 'https://tronscan.org/transaction/';
const OKX_C2C_METHODS = {
  all: { label: '全部', value: 'all' },
  alipay: { label: '支付宝', value: 'aliPay' },
  wechat: { label: '微信', value: 'wechatPay' },
  bank: { label: '银行卡', value: 'bank' },
};

const dbPath = resolve(process.cwd(), config.dbFile);
await mkdir(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
initDb();

let shuttingDown = false;
let monitorRunning = false;
let pendingInputRunning = false;
const startedAt = Date.now();

console.log('DefaultSearch starting...');
console.log(`Owner: ${config.ownerId}`);
console.log(`DB: ${dbPath}`);
logApp('system', 'started');

process.on('SIGINT', () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

try {
  await sendTelegram('deleteMyCommands', {});
} catch (error) {
  console.error(`清理命令菜单失败：${formatErrorDetails(error)}`);
}

try {
  await sendTelegram('sendMessage', {
    chat_id: config.ownerId,
    text: 'Default Search Started <a href="https://t.me/XiaoShuoTech">@XiaoShuoTech</a>',
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: mainMenuKeyboard(),
  });
} catch (error) {
  console.error(`启动通知失败：${formatErrorDetails(error)}`);
}

const monitorTimer = setInterval(() => void runMonitor(), config.monitorIntervalSeconds * 1000);
monitorTimer.unref();
void runMonitor();
const pendingActionTimer = setInterval(() => void expirePendingActionIfNeeded(), 10_000);
pendingActionTimer.unref();
void expirePendingActionIfNeeded();

while (!shuttingDown) {
  try {
    const updates = await sendTelegram('getUpdates', {
      offset: Number(getState('offset', '0')),
      timeout: config.pollTimeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    }, (config.pollTimeoutSeconds + 10) * 1000);

    for (const update of updates) {
      if (shuttingDown) break;
      await processUpdate(update);
    }
    if (config.pollTimeoutSeconds === 0) await sleep(config.pollIntervalMs);
  } catch (error) {
    const details = formatErrorDetails(error);
    console.error(`轮询失败：${details}`);
    logApp('poll_error', details);
    await sleep(3000);
  }
}

clearInterval(monitorTimer);
clearInterval(pendingActionTimer);
db.close();
console.log('DefaultSearch stopped.');

async function processUpdate(update) {
  const updateId = update.update_id;
  if (isProcessedUpdate(updateId)) {
    setOffset(updateId + 1);
    return;
  }

  if (update.message) await handleMessage(update.message);
  if (update.callback_query) await handleCallback(update.callback_query);

  markProcessedUpdate(updateId);
  pruneProcessedUpdates();
  setOffset(updateId + 1);
}

async function handleMessage(message) {
  const chatId = String(message.chat?.id ?? '');
  const fromId = String(message.from?.id ?? '');
  if (fromId !== config.ownerId) {
    if (config.unauthorizedMode === 'reply' && chatId) {
      await sendTelegram('sendMessage', { chat_id: chatId, text: `无权限\nuser_id：${fromId}\nchat_id：${chatId}` });
    }
    return;
  }

  const text = message.text?.trim() || '';
  if (!text) return;

  try {
    if (text === '/start' || text === '菜单') return sendMainMenu(chatId);
    if (text === '取消') {
      await cancelPendingAction();
      return sendTelegram('sendMessage', { chat_id: chatId, text: '已取消。', reply_markup: mainMenuKeyboard() });
    }

    if (text === '快捷') {
      await cancelPendingAction();
      return sendTelegram('sendMessage', {
        chat_id: chatId,
        text: '格式：快捷 #编号、快捷 备注、快捷 TRON地址',
        reply_to_message_id: message.message_id,
        reply_markup: mainMenuKeyboard(),
      });
    }

    const quickMatch = text.match(/^快捷\s+(.+)$/u);
    if (quickMatch) {
      await cancelPendingAction();
      const address = resolveMonitorAddress(quickMatch[1]);
      if (!TRON_ADDRESS_RE.test(address)) throw new Error('没有找到对应的监控地址');
      return queryAndSendAddress(chatId, address, message.message_id);
    }

    const pending = getPendingAction();
    if (pending) {
      if (pending.expiresAt <= Date.now()) {
        await cancelPendingAction(pending);
        return sendTelegram('sendMessage', {
          chat_id: chatId,
          text: '上一次操作已超时，请重新选择菜单。',
          reply_to_message_id: message.message_id,
          reply_markup: mainMenuKeyboard(),
        });
      }
      return handlePendingInput(chatId, message, pending, text);
    }

    await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: '请使用按钮菜单操作。发送“菜单”可重新打开主菜单。',
      reply_to_message_id: message.message_id,
      reply_markup: mainMenuKeyboard(),
    });
  } catch (error) {
    console.error(error);
    logApp('message_error', error.message);
    await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `失败：${error.message}`,
      reply_to_message_id: message.message_id,
    });
  }
}

async function handleCallback(callback) {
  const fromId = String(callback.from?.id ?? '');
  if (fromId !== config.ownerId) {
    await answerCallback(callback.id, '无权限', true);
    return;
  }
  await answerCallback(callback.id);

  const data = callback.data || '';
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const parts = data.split('|');
  const action = parts[0];
  const pending = getPendingAction();
  if (pending && Number(pending.promptMessageId) !== Number(messageId)) {
    await cancelPendingAction(pending);
  }

  if (action === 'menu') {
    return handleMenuCallback(chatId, messageId, parts[1] || 'main');
  }

  if (action === 'rate') {
    const side = parts[1] || 'sell';
    const method = parts[2] || 'all';
    return editRate(chatId, messageId, side, method);
  }

  const address = parts[1];
  const page = Number(parts[2] || 1);

  if (!TRON_ADDRESS_RE.test(address || '')) return;

  if (action === 'refresh') return queryAndEditAddress(chatId, messageId, address);
  if (action === 'in') return sendTransactionsPage(chatId, messageId, address, 'in', page);
  if (action === 'out') return sendTransactionsPage(chatId, messageId, address, 'out', page);
  if (action === 'all') return sendTransactionsPage(chatId, messageId, address, 'all', page);
  if (action === 'multisig') return sendMultiSigPage(chatId, messageId, address);
}

async function handleMenuCallback(chatId, messageId, target) {
  const pending = getPendingAction();
  if (target === 'main' && pending && Number(pending.promptMessageId) === Number(messageId)) {
    await cancelPendingAction(pending);
    return sendMainMenu(chatId);
  }
  clearPendingAction();
  if (target === 'main') {
    return editMessage(chatId, messageId, mainMenuText(), mainMenuKeyboard());
  }
  if (target === 'rate') return editRate(chatId, messageId, 'sell', 'all');
  if (target === 'cny_to_usdt') return promptForInput(chatId, messageId, 'cny_to_usdt', '请发送人民币金额。');
  if (target === 'usdt_to_cny') return promptForInput(chatId, messageId, 'usdt_to_cny', '请发送 USDT 数量。');
  if (target === 'query') return promptForInput(chatId, messageId, 'query_address', queryAddressPromptText());
  if (target === 'monitor') return editMessage(chatId, messageId, monitorMenuText(), monitorMenuKeyboard());
  if (target === 'monitor_list') return editMonitorList(chatId, messageId);
  if (target === 'monitor_add') return promptForInput(chatId, messageId, 'monitor_add', '请发送：TRON地址 备注\n备注可不填。');
  if (target === 'monitor_del') return promptForInput(chatId, messageId, 'monitor_del', '请发送要删除监控的 #编号、备注或 TRON 地址。');
  if (target === 'monitor_on') return promptForInput(chatId, messageId, 'monitor_on', '请发送要启用监控的 #编号、备注或 TRON 地址。');
  if (target === 'monitor_off') return promptForInput(chatId, messageId, 'monitor_off', '请发送要暂停监控的 #编号、备注或 TRON 地址。');
  if (target === 'monitor_check') return promptForInput(chatId, messageId, 'monitor_check', '请发送要手动检查的 #编号、备注或 TRON 地址。');
  if (target === 'status') return editStatus(chatId, messageId);
  if (target === 'logs') return editLogs(chatId, messageId);
  if (target === 'reset_confirm') return editMessage(chatId, messageId, resetConfirmText(), resetConfirmKeyboard());
  if (target === 'reset_do') {
    resetAllData();
    return editMessage(chatId, messageId, [
      '已清空全部业务数据，可以重新开始。',
      '',
      '监控地址：0',
      '已通知交易：0',
      '地址查询记录：0',
      '系统日志：0',
      '编号已从 #1 重新开始。',
    ].join('\n'), mainMenuKeyboard());
  }
}

async function promptForInput(chatId, messageId, action, text) {
  const timeoutMinutes = Math.max(1, Math.ceil(config.pendingActionTimeoutSeconds / 60));
  await editMessage(chatId, messageId, `${text}\n\n请在 ${timeoutMinutes} 分钟内回复，发送“取消”可退出。`, cancelKeyboard());
  setPendingAction(action, chatId, messageId);
}

async function handlePendingInput(chatId, message, pending, text) {
  pendingInputRunning = true;
  try {
    const action = pending.action;
    if (action === 'query_address') {
      const address = resolveMonitorAddress(text);
      if (!TRON_ADDRESS_RE.test(address)) throw new Error('地址格式错误');
      await queryAndSendAddress(chatId, address, message.message_id);
    } else if (action === 'monitor_add') {
      await handleMonitorAdd(chatId, text);
    } else if (action === 'monitor_del') {
      await handleMonitorDelete(chatId, text);
    } else if (action === 'monitor_on') {
      await handleMonitorEnabled(chatId, text, true);
    } else if (action === 'monitor_off') {
      await handleMonitorEnabled(chatId, text, false);
    } else if (action === 'monitor_check') {
      await handleMonitorCheck(chatId, text);
    } else if (action === 'cny_to_usdt') {
      const amount = Number(text);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('金额格式错误');
      await sendCnyToUsdt(chatId, amount);
    } else if (action === 'usdt_to_cny') {
      const amount = Number(text);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('数量格式错误');
      await sendUsdtToCny(chatId, amount);
    } else {
      throw new Error('未知操作，请重新选择菜单');
    }
    await completePendingAction(pending);
  } catch (error) {
    refreshPendingAction(pending);
    await sendTelegram('sendMessage', {
      chat_id: chatId,
      text: `失败：${error.message}\n操作仍然有效，可以重新发送。`,
      reply_to_message_id: message.message_id,
      reply_markup: cancelKeyboard(),
    });
  } finally {
    pendingInputRunning = false;
  }
}

async function queryAndSendAddress(chatId, address, replyToMessageId) {
  const loading = await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: '查询中...',
    reply_to_message_id: replyToMessageId,
  });
  try {
    const text = await buildAddressSummary(address);
    logQuery(address, 'summary', 'ok');
    await sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: loading.message_id,
      text,
      parse_mode: 'HTML',
      reply_markup: addressKeyboard(address),
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    logQuery(address, 'summary', `failed: ${error.message}`);
    logApp('query_error', `${address} ${error.message}`);
    await sendTelegram('editMessageText', {
      chat_id: chatId,
      message_id: loading.message_id,
      text: `查询失败：${error.message}`,
    });
  }
}

async function queryAndEditAddress(chatId, messageId, address) {
  const text = await buildAddressSummary(address);
  logQuery(address, 'summary_refresh', 'ok');
  await editMessage(chatId, messageId, text, addressKeyboard(address), { html: true });
}

async function buildAddressSummary(address) {
  const [account, usdtBalance, transactions, watched] = await Promise.all([
    getTronAccount(address),
    getUsdtBalance(address),
    getTronGridTransactions(address, config.historyScanLimit),
    getWatchedAddress(address),
  ]);

  const transferInfo = getTransferInfo(transactions, account);
  const multiSig = getMultiSigStatusFromAccount(account);
  const trxBalance = sunToTrx(account.balance || 0);
  return [
    '<b>地址概览</b>',
    '',
    `<code>${escapeHtml(address)}</code>`,
    '',
    `<b>USDT余额：${formatNumber(usdtBalance)} USDT</b>`,
    `TRX余额：${formatNumber(trxBalance)} TRX`,
    `扫描交易：${transferInfo.transactionCount} 笔`,
    `扫描收入：${transferInfo.totalIncome} USDT`,
    `扫描支出：${transferInfo.totalExpense} USDT`,
    `<i>扫描上限：最近 ${config.historyScanLimit} 笔 USDT 交易</i>`,
    `激活时间：${escapeHtml(transferInfo.activationTime || '-')}`,
    `多签状态：<b>${escapeHtml(multiSig.summary)}</b>`,
    `监控状态：<b>${watched ? (watched.enabled ? '已监控' : '已暂停') : '未监控'}</b>`,
    multiSig.detail ? `\n${escapeHtml(multiSig.detail)}` : '',
    '',
    `<a href="${addressUrl(address)}">在 Tronscan 查看地址</a>`,
  ].filter(Boolean).join('\n');
}

async function sendTransactionsPage(chatId, messageId, address, direction, page) {
  const rows = await getTransactions(address, direction, page, config.pageSize);
  const title = direction === 'in' ? '转入记录' : direction === 'out' ? '转出记录' : '全部交易';
  const text = rows.length
    ? [
      `<b>${title}</b>`,
      `<code>${escapeHtml(address)}</code>`,
      '',
      ...rows.map((tx, index) => formatTransaction(tx, index + 1)),
    ].join('\n\n')
    : `<b>${title}</b>\n\n暂无记录`;
  await editMessage(chatId, messageId, text, txKeyboard(address, direction, page, rows.length >= config.pageSize), { html: true });
}

async function sendMultiSigPage(chatId, messageId, address) {
  const multiSig = await getMultiSigStatus(address);
  const text = [
    '<b>多签检测</b>',
    `<code>${escapeHtml(address)}</code>`,
    '',
    `状态：<b>${escapeHtml(multiSig.summary)}</b>`,
    escapeHtml(multiSig.detail || '未发现多签或异常权限。'),
    '',
    `<a href="${addressUrl(address)}">在 Tronscan 查看地址</a>`,
  ].join('\n');
  await editMessage(chatId, messageId, text, multiSigKeyboard(address), { html: true });
}

function formatTransaction(tx, index) {
  const sign = tx.direction === 'in' ? '+' : '-';
  const peerLabel = tx.direction === 'in' ? '来源' : '去向';
  return [
    `<b>#${index} ${tx.direction === 'in' ? '转入' : '转出'} ${sign}${formatNumber(tx.amount)} USDT</b>`,
    `<i>${escapeHtml(formatTime(tx.timestamp))}</i>`,
    `${peerLabel}：<code>${escapeHtml(tx.counterparty)}</code>`,
    `交易：<code>${escapeHtml(tx.txid)}</code>`,
    `<a href="${txUrl(tx.txid)}">查看链上交易</a>`,
  ].join('\n');
}

async function sendRate(chatId) {
  const text = await buildRateText('sell', 'all');
  await sendTelegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: rateKeyboard('sell', 'all'),
  });
}

async function editRate(chatId, messageId, side, method) {
  const normalizedSide = normalizeRateSide(side);
  const normalized = OKX_C2C_METHODS[method] ? method : 'all';
  const text = await buildRateText(normalizedSide, normalized);
  await editMessage(chatId, messageId, text, rateKeyboard(normalizedSide, normalized), { html: true });
}

async function sendCnyToUsdt(chatId, cny) {
  const rate = await getUsdtCnyRate();
  await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: `<b>人民币换 USDT</b>\n\n${formatNumber(cny)} CNY / ${rate.price.toFixed(4)}\n= <b>${formatNumber(cny / rate.price)} USDT</b>\n\n<i>来源：${escapeHtml(rate.source)}</i>`,
    parse_mode: 'HTML',
    reply_markup: mainMenuKeyboard(),
  });
}

async function sendUsdtToCny(chatId, usdt) {
  const rate = await getUsdtSellCnyRate();
  await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: `<b>USDT 换人民币</b>\n\n${formatNumber(usdt)} USDT × ${rate.price.toFixed(4)}\n= <b>${formatNumber(usdt * rate.price)} CNY</b>\n\n<i>来源：${escapeHtml(rate.source)}</i>`,
    parse_mode: 'HTML',
    reply_markup: mainMenuKeyboard(),
  });
}

async function getUsdtCnyRate() {
  const quotes = await getOkxC2cQuotes('all', 'sell', 1);
  if (quotes[0]?.price > 0) return { price: quotes[0].price, source: 'OKX C2C' };
  return { price: config.fallbackUsdtCnyPrice, source: '兜底配置' };
}

async function getUsdtSellCnyRate() {
  const quotes = await getOkxC2cQuotes('all', 'buy', 1);
  if (quotes[0]?.price > 0) return { price: quotes[0].price, source: 'OKX C2C' };
  return { price: config.fallbackUsdtCnyPrice, source: '兜底配置' };
}

async function buildRateText(side, method) {
  const normalizedSide = normalizeRateSide(side);
  const info = OKX_C2C_METHODS[method] || OKX_C2C_METHODS.all;
  const quotes = await getOkxC2cQuotes(method, normalizedSide, 20);
  const sideLabel = normalizedSide === 'sell' ? '购买U' : '出售U';
  if (!quotes.length) {
    return [
      `<b>OKX C2C USDT/CNY</b>`,
      `<b>${sideLabel} · ${escapeHtml(info.label)}</b>`,
      '',
      '暂无公开报价',
      `<i>兜底价格：${config.fallbackUsdtCnyPrice.toFixed(4)}</i>`,
    ].join('\n');
  }

  return [
    '<b>OKX C2C USDT/CNY</b>',
    `<b>${sideLabel} · ${escapeHtml(info.label)} · 前20商户</b>`,
    '',
    ...quotes.slice(0, 20).map((item, index) => `${index + 1}. ${escapeHtml(item.merchant)}  <b>${item.price.toFixed(4)}</b>`),
  ].join('\n');
}

async function getOkxC2cQuotes(method, side = 'sell', limit = 20) {
  const info = OKX_C2C_METHODS[method] || OKX_C2C_METHODS.all;
  const normalizedSide = normalizeRateSide(side);
  try {
    const url = new URL('https://www.okx.com/v3/c2c/tradingOrders/books');
    url.searchParams.set('quoteCurrency', 'cny');
    url.searchParams.set('baseCurrency', 'usdt');
    url.searchParams.set('side', normalizedSide);
    url.searchParams.set('paymentMethod', info.value);
    const payload = await httpJson(url.toString(), { headers: okxHeaders() }, 6000);
    const list = payload?.data?.[normalizedSide] || [];
    if (!Array.isArray(list)) return [];
    return list
      .map(normalizeOkxQuote)
      .filter((item) => item.price > 0)
      .slice(0, limit);
  } catch (error) {
    console.error(`获取U价失败：${error.message}`);
    logApp('rate_error', error.message);
    return [];
  }
}

function normalizeRateSide(side) {
  return side === 'buy' ? 'buy' : 'sell';
}

function normalizeOkxQuote(item) {
  const merchant = item.nickName
    || item.userName
    || item.merchantName
    || item.traderName
    || item?.publicUserInfo?.nickName
    || item?.publicUserInfo?.userName
    || '未知商户';
  return {
    merchant: String(merchant),
    price: Number(item.price || item.unitPrice || item.quotePrice || 0),
  };
}

async function handleMonitorAdd(chatId, text) {
  const args = text.trim().split(/\s+/);
  const address = args[0];
  const label = args.slice(1).join(' ') || address;
  if (!TRON_ADDRESS_RE.test(address || '')) throw new Error('地址格式错误');
  validateMonitorLabel(label);
  const labelOwner = getWatchedAddressByLabel(label);
  if (labelOwner && labelOwner.address !== address) throw new Error(`备注“${label}”已被其他地址使用`);
  const latestTx = await getLatestTxId(address);
  upsertWatchedAddress(address, label, latestTx);
  await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: [`已添加监控：${label}`, address, latestTx ? `从最新交易后开始监控：${latestTx}` : '当前暂无交易，从后续新交易开始监控。'].join('\n'),
    reply_markup: monitorMenuKeyboard(),
  });
}

async function handleMonitorDelete(chatId, text) {
  const address = resolveMonitorAddress(text);
  if (!TRON_ADDRESS_RE.test(address)) throw new Error('地址格式错误');
  db.prepare('DELETE FROM watched_addresses WHERE address = ?').run(address);
  await sendTelegram('sendMessage', { chat_id: chatId, text: `已删除监控：${address}`, reply_markup: monitorMenuKeyboard() });
}

async function handleMonitorEnabled(chatId, text, enabled) {
  const address = resolveMonitorAddress(text);
  if (!TRON_ADDRESS_RE.test(address)) throw new Error('地址格式错误');
  const result = db.prepare('UPDATE watched_addresses SET enabled = ?, updated_at = ? WHERE address = ?').run(enabled ? 1 : 0, nowIso(), address);
  if (result.changes === 0) throw new Error('监控地址不存在');
  await sendTelegram('sendMessage', { chat_id: chatId, text: `${enabled ? '已启用' : '已暂停'}：${address}`, reply_markup: monitorMenuKeyboard() });
}

async function handleMonitorCheck(chatId, text) {
  const address = resolveMonitorAddress(text);
  if (!TRON_ADDRESS_RE.test(address)) throw new Error('地址格式错误');
  const watched = getWatchedAddress(address);
  if (!watched) throw new Error('监控地址不存在');
  await checkWatchedAddress(watched);
  await sendTelegram('sendMessage', { chat_id: chatId, text: `已检查：${address}`, reply_markup: monitorMenuKeyboard() });
}

async function sendMonitorList(chatId) {
  await sendTelegram('sendMessage', { chat_id: chatId, text: monitorListText(), reply_markup: monitorMenuKeyboard() });
}

async function sendMonitorMenu(chatId) {
  await cancelPendingAction();
  await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: monitorMenuText(),
    reply_markup: monitorMenuKeyboard(),
  });
}

async function editMonitorList(chatId, messageId) {
  await editMessage(chatId, messageId, monitorListText(), monitorMenuKeyboard());
}

function monitorListText() {
  const rows = db.prepare('SELECT * FROM watched_addresses ORDER BY created_at DESC').all();
  return rows.length
    ? rows.map((row, index) => `#${index + 1} ${row.enabled ? '启用' : '暂停'} ${row.label}\n${row.address}`).join('\n\n')
    : '暂无监控地址';
}

function queryAddressPromptText() {
  const rows = db.prepare('SELECT * FROM watched_addresses ORDER BY created_at DESC LIMIT 20').all();
  const lines = ['请发送 #编号、备注或新的 TRON 地址。', '也可以直接发送：快捷 #编号 / 快捷 备注'];
  if (rows.length) {
    lines.push('', '已添加地址：');
    rows.forEach((row, index) => {
      lines.push(`#${index + 1} ${row.label}`);
      lines.push(row.address);
    });
  } else {
    lines.push('', '暂无已添加地址。');
  }
  return lines.join('\n');
}

function resolveMonitorAddress(input) {
  const value = String(input || '').trim();
  if (TRON_ADDRESS_RE.test(value)) return value;
  if (/^#\d+$/u.test(value)) {
    const index = Number(value.slice(1));
    const row = db.prepare('SELECT address FROM watched_addresses ORDER BY created_at DESC LIMIT 1 OFFSET ?').get(index - 1);
    if (row?.address) return row.address;
    throw new Error('#编号不存在');
  }
  const row = getWatchedAddressByLabel(value);
  if (row?.address) return row.address;
  return value;
}

async function runMonitor() {
  if (monitorRunning) return;
  monitorRunning = true;
  try {
    const rows = db.prepare('SELECT * FROM watched_addresses WHERE enabled = 1').all();
    for (const row of rows) {
      if (shuttingDown) break;
      await checkWatchedAddress(row).catch((error) => {
        console.error(`监控失败 ${row.address}: ${error.message}`);
        logApp('monitor_error', `${row.address} ${error.message}`);
      });
    }
  } finally {
    monitorRunning = false;
  }
}

async function checkWatchedAddress(row) {
  const { transactions: txs, reachedCheckpoint } = await getMonitorTransactions(row);
  if (row.last_tx_id && !reachedCheckpoint) {
    throw new Error('未找到上次监控检查点，本轮不会推进以避免漏记历史交易');
  }
  const newestFirst = txs.sort((a, b) => b.timestamp - a.timestamp);
  const unseen = [];
  for (const tx of newestFirst) {
    if (tx.txid === row.last_tx_id) break;
    if (!isWatchedTx(row.address, tx.txid)) unseen.push(tx);
  }
  unseen.reverse();
  for (const tx of unseen) queueWatchedTx(row.address, tx);
  if (newestFirst[0]) updateWatchedLastTx(row.address, newestFirst[0].txid);

  const pending = getPendingWatchedTx(row.address);
  if (!pending.length) return;

  const balances = await getCurrentBalances(row.address);
  for (const tx of pending) {
    const index = newestFirst.findIndex((item) => item.txid === tx.txid);
    const previousTx = index >= 0 ? newestFirst[index + 1] || null : null;
    try {
      await sendTelegramWithRetry('sendMessage', buildMonitorNotice(row, tx, previousTx, balances));
      markWatchedTxNotified(row.address, tx.txid);
    } catch (error) {
      markWatchedTxFailed(row.address, tx.txid, error.message);
      logApp('notify_error', `${row.address} ${tx.txid} ${error.message}`);
    }
  }
}

async function getMonitorTransactions(row) {
  const rows = [];
  let fingerprint = '';
  let reachedCheckpoint = false;
  const pageSize = Math.min(200, Math.max(1, config.monitorTxLimit));
  const startedAtMs = row.last_tx_id ? null : Date.parse(row.created_at);

  while (true) {
    const payload = await fetchTronGridTransactionPage(row.address, pageSize, fingerprint, startedAtMs);
    const list = payload?.data || [];
    for (const tx of list) {
      const normalized = normalizeTrc20Tx({
        txid: tx.transaction_id,
        timestamp: tx.block_timestamp,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        decimals: tx.token_info?.decimals ?? 6,
      }, row.address);
      if (!normalized) continue;
      rows.push(normalized);
      if (row.last_tx_id && normalized.txid === row.last_tx_id) {
        reachedCheckpoint = true;
        break;
      }
    }

    fingerprint = payload?.meta?.fingerprint || '';
    if (reachedCheckpoint || !fingerprint || list.length === 0) break;
  }

  return {
    transactions: rows.sort((a, b) => b.timestamp - a.timestamp),
    reachedCheckpoint: !row.last_tx_id || reachedCheckpoint,
  };
}

function buildMonitorNotice(row, tx, previousTx, balances) {
  const directionText = tx.direction === 'in' ? '转入' : '转出';
  const sign = tx.direction === 'in' ? '+' : '-';
  const peerLabel = tx.direction === 'in' ? '来源' : '去向';
  const lines = [
    `<b>监控${directionText} ${sign}${formatNumber(tx.amount)} USDT</b>`,
    '',
    `备注：${escapeHtml(row.label)}`,
    `当前USDT余额：<b>${balances.usdt === null ? '暂时获取失败' : `${formatNumber(balances.usdt)} USDT`}</b>`,
    `当前TRX余额：${balances.trx === null ? '暂时获取失败' : `${formatNumber(balances.trx)} TRX`}`,
    '',
    `监控地址：<code>${escapeHtml(row.address)}</code>`,
    `${peerLabel}：<code>${escapeHtml(tx.counterparty)}</code>`,
    `交易：<code>${escapeHtml(tx.txid)}</code>`,
    `<i>时间：${escapeHtml(formatTime(tx.timestamp))}</i>`,
    '',
    '<b>上一笔USDT交易</b>',
  ];

  if (previousTx) {
    const previousSign = previousTx.direction === 'in' ? '+' : '-';
    const previousPeerLabel = previousTx.direction === 'in' ? '来源' : '去向';
    lines.push(
      `类型：${previousTx.direction === 'in' ? '转入' : '转出'}`,
      `金额：<b>${previousSign}${formatNumber(previousTx.amount)} USDT</b>`,
      `${previousPeerLabel}：<code>${escapeHtml(previousTx.counterparty)}</code>`,
      `交易：<code>${escapeHtml(previousTx.txid)}</code>`,
      `<i>时间：${escapeHtml(formatTime(previousTx.timestamp))}</i>`,
      `<a href="${txUrl(previousTx.txid)}">查看上一笔交易详情</a>`,
    );
  } else {
    lines.push('暂无历史交易');
  }

  lines.push('', `<a href="${txUrl(tx.txid)}">在 Tronscan 查看本次交易</a>`);

  return {
    chat_id: config.ownerId,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  };
}

async function getCurrentBalances(address) {
  const [usdtResult, accountResult] = await Promise.allSettled([
    getUsdtBalance(address),
    getTronAccount(address),
  ]);
  return {
    usdt: usdtResult.status === 'fulfilled' ? usdtResult.value : null,
    trx: accountResult.status === 'fulfilled' ? sunToTrx(accountResult.value.balance || 0) : null,
  };
}

async function getTronAccount(address) {
  const payload = await tronHttpJson(`${config.tronGridBase}/wallet/getaccount`, {
    method: 'POST',
    headers: tronHeaders(),
    body: JSON.stringify({ address, visible: true }),
  });
  return payload || {};
}

async function getUsdtBalance(address) {
  const payload = await tronHttpJson(`${config.tronGridBase}/v1/accounts/${address}`, { headers: tronHeaders() });
  const account = payload?.data?.[0] || {};
  const trc20 = account.trc20 || [];
  for (const item of trc20) {
    const balance = item[USDT_CONTRACT] ?? item[USDT_CONTRACT_HEX] ?? item.USDT;
    if (balance !== undefined) return Number(balance) / 1e6;
  }
  return 0;
}

function getTransferInfo(transactions, account) {
  const totalIncome = transactions
    .filter((tx) => tx.direction === 'in')
    .reduce((sum, tx) => sum + tx.amount, 0);
  const totalExpense = transactions
    .filter((tx) => tx.direction === 'out')
    .reduce((sum, tx) => sum + tx.amount, 0);
  return {
    totalIncome: formatNumber(totalIncome),
    totalExpense: formatNumber(totalExpense),
    activationTime: account.create_time ? formatTime(account.create_time) : '-',
    transactionCount: transactions.length,
  };
}

async function getTransactions(address, direction, page, limit, scanLimit = config.historyScanLimit) {
  const rows = await getTronGridTransactions(address, scanLimit);
  return rows
    .filter((tx) => direction === 'all' || tx.direction === direction)
    .slice((page - 1) * limit, page * limit);
}

async function getTronGridTransactions(address, maxItems) {
  const rows = [];
  let fingerprint = '';
  const target = Math.max(1, Number(maxItems || config.historyScanLimit));

  while (rows.length < target) {
    const pageSize = Math.min(200, target - rows.length);
    const payload = await fetchTronGridTransactionPage(address, pageSize, fingerprint);
    const list = payload?.data || [];
    for (const tx of list) {
      const normalized = normalizeTrc20Tx({
        txid: tx.transaction_id,
        timestamp: tx.block_timestamp,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        decimals: tx.token_info?.decimals ?? 6,
      }, address);
      if (normalized) rows.push(normalized);
    }
    fingerprint = payload?.meta?.fingerprint || '';
    if (!fingerprint || list.length === 0) break;
  }

  return rows.sort((a, b) => b.timestamp - a.timestamp);
}

async function fetchTronGridTransactionPage(address, limit, fingerprint, minTimestamp = null) {
  const url = new URL(`${config.tronGridBase}/v1/accounts/${address}/transactions/trc20`);
  url.searchParams.set('contract_address', USDT_CONTRACT);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('only_confirmed', 'true');
  url.searchParams.set('order_by', 'block_timestamp,desc');
  if (fingerprint) url.searchParams.set('fingerprint', fingerprint);
  if (Number.isFinite(minTimestamp)) url.searchParams.set('min_timestamp', String(minTimestamp));
  return tronHttpJson(url.toString(), { headers: tronHeaders() });
}

function normalizeTrc20Tx(raw, address) {
  const from = raw.from;
  const to = raw.to;
  if (!from || !to || !raw.txid) return null;
  const dir = to === address ? 'in' : 'out';
  if (from !== address && to !== address) return null;
  const decimals = Number(raw.decimals ?? 6);
  return {
    txid: raw.txid,
    timestamp: Number(raw.timestamp || 0),
    direction: dir,
    amount: Number(raw.value || 0) / 10 ** decimals,
    counterparty: dir === 'in' ? from : to,
  };
}

async function getLatestTxId(address) {
  const rows = await getTransactions(address, 'all', 1, 1, 1);
  return rows[0]?.txid || '';
}

async function getMultiSigStatus(address) {
  const account = await getTronAccount(address);
  return getMultiSigStatusFromAccount(account);
}

function getMultiSigStatusFromAccount(account) {
  if (!account.address) return { summary: '未激活', detail: '' };

  const owner = account.owner_permission;
  const active = account.active_permission || [];
  const abnormalOwner = permissionIsMulti(owner);
  const multiActive = active.filter(permissionIsMulti);

  const detailLines = [];
  if (abnormalOwner && owner) detailLines.push(formatPermission('Owner权限', owner));
  for (const perm of multiActive) detailLines.push(formatPermission(perm.permission_name || 'Active权限', perm));

  if (abnormalOwner || multiActive.length) {
    return {
      summary: abnormalOwner ? 'Owner权限异常/多签' : '已开启多签',
      detail: detailLines.join('\n\n'),
    };
  }
  return { summary: '未开启多签', detail: '' };
}

function permissionIsMulti(permission) {
  if (!permission?.keys?.length) return false;
  if (permission.keys.length > 1) return true;
  return Number(permission.threshold || 1) !== Number(permission.keys[0]?.weight || 1);
}

function formatPermission(title, permission) {
  const keys = permission.keys || [];
  const total = keys.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  const lines = [
    `${title}：`,
    `阈值：${permission.threshold}`,
    `总权重：${total}`,
  ];
  keys.forEach((item, index) => {
    lines.push(`${index + 1}. ${fromHexAddress(item.address)} 权重 ${item.weight}`);
  });
  return lines.join('\n');
}

function addressKeyboard(address) {
  return {
    inline_keyboard: [
      [
        { text: '转入', callback_data: `in|${address}|1` },
        { text: '转出', callback_data: `out|${address}|1` },
        { text: '全部', callback_data: `all|${address}|1` },
      ],
      [{ text: '多签详情', callback_data: `multisig|${address}|1` }],
      [{ text: '刷新', callback_data: `refresh|${address}|1` }],
      [{ text: '返回主菜单', callback_data: 'menu|main' }],
    ],
  };
}

function multiSigKeyboard(address) {
  return {
    inline_keyboard: [
      [{ text: '返回地址概览', callback_data: `refresh|${address}|1` }],
      [{ text: '返回主菜单', callback_data: 'menu|main' }],
    ],
  };
}

function txKeyboard(address, direction, page, hasNext) {
  const row = [];
  if (page > 1) row.push({ text: '上一页', callback_data: `${direction}|${address}|${page - 1}` });
  if (hasNext) row.push({ text: '下一页', callback_data: `${direction}|${address}|${page + 1}` });
  return {
    inline_keyboard: [
      row.length ? row : [{ text: '刷新', callback_data: `${direction}|${address}|${page}` }],
      [{ text: '返回概览', callback_data: `refresh|${address}|1` }],
      [{ text: '返回主菜单', callback_data: 'menu|main' }],
    ],
  };
}

function rateKeyboard(activeSide, activeMethod) {
  const button = (method) => ({
    text: `${method === activeMethod ? '✓ ' : ''}${OKX_C2C_METHODS[method].label}`,
    callback_data: `rate|${activeSide}|${method}`,
  });
  const sideButton = (side, label) => ({
    text: `${side === activeSide ? '✓ ' : ''}${label}`,
    callback_data: `rate|${side}|${activeMethod}`,
  });
  return {
    inline_keyboard: [
      [sideButton('sell', '购买U'), sideButton('buy', '出售U')],
      [button('all'), button('alipay')],
      [button('wechat'), button('bank')],
      [{ text: '刷新', callback_data: `rate|${activeSide}|${activeMethod}` }],
      [{ text: '返回主菜单', callback_data: 'menu|main' }],
    ],
  };
}

function mainMenuText() {
  return 'Default Menu';
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '查U价', callback_data: 'menu|rate' },
        { text: '地址查询', callback_data: 'menu|query' },
      ],
      [
        { text: '人民币换U', callback_data: 'menu|cny_to_usdt' },
        { text: 'U换人民币', callback_data: 'menu|usdt_to_cny' },
      ],
      [
        { text: '监控管理', callback_data: 'menu|monitor' },
        { text: '运行状态', callback_data: 'menu|status' },
      ],
      [
        { text: '系统日志', callback_data: 'menu|logs' },
        { text: '清空数据', callback_data: 'menu|reset_confirm' },
      ],
    ],
  };
}

function resetConfirmText() {
  return [
    '确认清空全部数据？',
    '',
    '会删除：监控地址、已通知交易、地址查询记录、系统日志、临时操作状态。',
    '不会删除：机器人配置、Token、管理员ID、Telegram轮询位置。',
    '',
    '清空后无法从按钮恢复，请确认。'
  ].join('\n');
}

function resetConfirmKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '确认清空全部数据', callback_data: 'menu|reset_do' }],
      [{ text: '取消', callback_data: 'menu|main' }],
    ],
  };
}

function monitorMenuText() {
  return '监控管理\n查询、删除、启用、暂停、检查都支持 #编号、备注或完整地址。';
}

function monitorMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '监控列表', callback_data: 'menu|monitor_list' },
        { text: '添加监控', callback_data: 'menu|monitor_add' },
      ],
      [
        { text: '删除监控', callback_data: 'menu|monitor_del' },
        { text: '手动检查', callback_data: 'menu|monitor_check' },
      ],
      [
        { text: '启用监控', callback_data: 'menu|monitor_on' },
        { text: '暂停监控', callback_data: 'menu|monitor_off' },
      ],
      [{ text: '系统日志', callback_data: 'menu|logs' }],
      [{ text: '返回主菜单', callback_data: 'menu|main' }],
    ],
  };
}

function cancelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '取消', callback_data: 'menu|main' }],
    ],
  };
}

async function sendMainMenu(chatId) {
  await cancelPendingAction();
  await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: mainMenuText(),
    reply_markup: mainMenuKeyboard(),
  });
}

async function sendStatus(chatId) {
  await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: statusText(),
    parse_mode: 'HTML',
    reply_markup: mainMenuKeyboard(),
  });
}

async function editStatus(chatId, messageId) {
  await editMessage(chatId, messageId, statusText(), mainMenuKeyboard(), { html: true });
}

async function editLogs(chatId, messageId) {
  await editMessage(chatId, messageId, logsText(), logsKeyboard(), { html: true });
}

function statusText() {
  const watched = db.prepare('SELECT COUNT(*) AS n FROM watched_addresses').get().n;
  const enabled = db.prepare('SELECT COUNT(*) AS n FROM watched_addresses WHERE enabled = 1').get().n;
  const notified = db.prepare("SELECT COUNT(*) AS n FROM watched_transactions WHERE notification_status = 'notified'").get().n;
  const pending = db.prepare("SELECT COUNT(*) AS n FROM watched_transactions WHERE notification_status != 'notified'").get().n;
  const queryCount = db.prepare('SELECT COUNT(*) AS n FROM query_logs').get().n;
  const latestTx = db.prepare("SELECT * FROM watched_transactions WHERE notification_status = 'notified' ORDER BY notified_at DESC LIMIT 1").get();
  const latestQuery = db.prepare('SELECT * FROM query_logs ORDER BY created_at DESC LIMIT 1').get();
  const latestError = db.prepare("SELECT * FROM app_logs WHERE level = 'error' ORDER BY created_at DESC LIMIT 1").get();
  const memory = process.memoryUsage();
  return [
    '<b>DefaultSearch 运行状态</b>',
    '',
    `运行时长：${formatDuration(Date.now() - startedAt)}`,
    `Node：${process.version}`,
    `内存：${formatBytes(memory.rss)}`,
    `数据库：SQLite ${formatBytes(fileSize(dbPath))}`,
    '',
    `监控地址：启用 ${enabled}，总数 ${watched}`,
    `轮询间隔：${config.monitorIntervalSeconds}s`,
    `监控分页：每页 ${config.monitorTxLimit} 笔，追踪至上次检查点`,
    `地址概览扫描：最近 ${config.historyScanLimit} 笔`,
    `TronGrid：${config.tronGridApiKey ? '已配置 Key' : '公共接口'}`,
    '',
    `已通知交易：${notified}`,
    `待发送通知：${pending}`,
    `地址查询记录：${queryCount}`,
    `最近通知：${latestTx ? `${escapeHtml(formatTime(latestTx.notified_at))}\n<code>${escapeHtml(latestTx.address)}</code>\n<b>${latestTx.direction === 'in' ? '+' : '-'}${formatNumber(latestTx.amount)} USDT</b>` : '暂无'}`,
    `最近查询：${latestQuery ? `${escapeHtml(formatTime(latestQuery.created_at))}\n<code>${escapeHtml(latestQuery.address)}</code>\n${latestQuery.result === 'ok' ? '成功' : '失败'}` : '暂无'}`,
    `最近错误：${latestError ? `${escapeHtml(formatTime(latestError.created_at))} ${escapeHtml(latestError.message)}` : '暂无'}`,
  ].join('\n');
}

function logsText() {
  const watched = db.prepare('SELECT COUNT(*) AS n FROM watched_addresses').get().n;
  const enabled = db.prepare('SELECT COUNT(*) AS n FROM watched_addresses WHERE enabled = 1').get().n;
  const notified = db.prepare("SELECT COUNT(*) AS n FROM watched_transactions WHERE notification_status = 'notified'").get().n;
  const pending = db.prepare("SELECT COUNT(*) AS n FROM watched_transactions WHERE notification_status != 'notified'").get().n;
  const txRows = db.prepare("SELECT * FROM watched_transactions WHERE notification_status = 'notified' ORDER BY notified_at DESC LIMIT 5").all();
  const queryRows = db.prepare('SELECT * FROM query_logs ORDER BY created_at DESC LIMIT 5').all();
  const eventRows = db.prepare('SELECT * FROM app_logs ORDER BY created_at DESC LIMIT 5').all();
  const lines = [
    '<b>系统日志</b>',
    '',
    `监控地址：启用 ${enabled}，总数 ${watched}`,
    `已通知交易：${notified}`,
    `待发送通知：${pending}`,
    `数据库：${formatBytes(fileSize(dbPath))}`,
    '',
    '最近运行事件：',
  ];
  if (eventRows.length) {
    eventRows.forEach((row, index) => {
      lines.push(`${index + 1}. ${escapeHtml(formatTime(row.created_at))} <b>${escapeHtml(row.level.toUpperCase())}</b> ${escapeHtml(row.event)}`);
      if (row.message) lines.push(`   ${escapeHtml(row.message)}`);
    });
  } else {
    lines.push('暂无');
  }
  lines.push(
    '',
    '最近监控通知：',
  );
  if (txRows.length) {
    txRows.forEach((row, index) => {
      const sign = row.direction === 'in' ? '+' : '-';
      lines.push(`${index + 1}. ${formatTime(row.timestamp)} ${sign}${formatNumber(row.amount)} USDT`);
      lines.push(`   交易：<code>${escapeHtml(row.txid)}</code>`);
      lines.push(`   地址：<code>${escapeHtml(row.address)}</code>`);
    });
  } else {
    lines.push('暂无');
  }
  lines.push('', '最近查询：');
  if (queryRows.length) {
    queryRows.forEach((row, index) => {
      const ok = row.result === 'ok' ? '成功' : '失败';
      lines.push(`${index + 1}. ${formatTime(row.created_at)} ${ok}`);
      lines.push(`   地址：<code>${escapeHtml(row.address)}</code>`);
    });
  } else {
    lines.push('暂无');
  }
  return lines.join('\n');
}

function logsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '刷新日志', callback_data: 'menu|logs' }],
      [
        { text: '返回监控管理', callback_data: 'menu|monitor' },
        { text: '返回主菜单', callback_data: 'menu|main' },
      ],
    ],
  };
}

async function editMessage(chatId, messageId, text, replyMarkup, options = {}) {
  try {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: replyMarkup,
      link_preview_options: { is_disabled: true },
    };
    if (options.html) payload.parse_mode = 'HTML';
    await sendTelegram('editMessageText', payload);
  } catch (error) {
    if (!String(error.message).includes('message is not modified')) throw error;
  }
}

async function answerCallback(id, text, showAlert = false) {
  await sendTelegram('answerCallbackQuery', { callback_query_id: id, text, show_alert: showAlert });
}

async function sendTelegram(method, body, timeoutMs = 35_000) {
  const headers = { 'content-type': 'application/json' };
  if (method === 'getUpdates') headers.connection = 'close';
  const payload = await httpJson(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, timeoutMs);
  if (payload?.ok === false) throw new Error(payload.description || `${method} failed`);
  return payload.result;
}

async function sendTelegramWithRetry(method, body, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await sendTelegram(method, body);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(700 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

async function tronHttpJson(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= config.tronApiRetries; attempt += 1) {
    try {
      return await httpJson(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < config.tronApiRetries) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

async function httpJson(url, options = {}, timeoutMs = config.apiTimeoutSeconds * 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { throw new Error(`非JSON响应：${text.slice(0, 120)}`); }
    if (!response.ok) {
      if (response.status === 429 && url.startsWith(config.tronGridBase)) {
        const error = new Error('TronGrid 官方接口限速，请稍后重试或调低监控频率');
        error.status = response.status;
        throw error;
      }
      const error = new Error(payload?.message || payload?.description || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function formatErrorDetails(error) {
  const details = [];
  if (error?.message) details.push(error.message);
  if (error?.name && !['Error', 'TypeError'].includes(error.name)) details.push(`name=${error.name}`);

  const causes = [error?.cause, ...(Array.isArray(error?.cause?.errors) ? error.cause.errors : [])]
    .filter(Boolean);
  for (const cause of causes) {
    if (cause.code) details.push(`code=${cause.code}`);
    if (cause.errno && cause.errno !== cause.code) details.push(`errno=${cause.errno}`);
    if (cause.syscall) details.push(`syscall=${cause.syscall}`);
    if (cause.address) details.push(`address=${cause.address}`);
    if (cause.port) details.push(`port=${cause.port}`);
    if (cause.message && cause.message !== error?.message) details.push(`cause=${cause.message}`);
  }

  return [...new Set(details)].join(' | ').slice(0, 500) || String(error);
}

function tronHeaders() {
  return config.tronGridApiKey ? { 'TRON-PRO-API-KEY': config.tronGridApiKey } : {};
}

function okxHeaders() {
  return {
    accept: 'application/json',
    'user-agent': 'Mozilla/5.0',
  };
}

function upsertWatchedAddress(address, label, lastTxId) {
  db.prepare(`
    INSERT INTO watched_addresses (address, label, label_key, enabled, last_tx_id, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET label = excluded.label, label_key = excluded.label_key, enabled = 1, last_tx_id = excluded.last_tx_id, updated_at = excluded.updated_at
  `).run(address, label, normalizeLabel(label), lastTxId || '', nowIso(), nowIso());
}

function getWatchedAddress(address) {
  return db.prepare('SELECT * FROM watched_addresses WHERE address = ?').get(address);
}

function getWatchedAddressByLabel(label) {
  const labelKey = normalizeLabel(label);
  if (!labelKey) return null;
  return db.prepare('SELECT * FROM watched_addresses WHERE label_key = ? LIMIT 1').get(labelKey) || null;
}

function normalizeLabel(label) {
  return String(label || '').trim().toLocaleLowerCase('zh-CN');
}

function validateMonitorLabel(label) {
  const value = String(label || '').trim();
  if (!value) throw new Error('备注不能为空');
  if (value.length > 40) throw new Error('备注不能超过40个字符');
  if (/^#\d+$/u.test(value)) throw new Error('备注不能使用 #编号 格式');
  if (['菜单', '取消', '快捷'].includes(value)) throw new Error(`“${value}”是保留关键词，不能作为备注`);
}

function getLatestStoredTx(address) {
  return db.prepare('SELECT last_tx_id FROM watched_addresses WHERE address = ?').get(address)?.last_tx_id || '';
}

function isWatchedTx(address, txid) {
  return Boolean(db.prepare('SELECT 1 FROM watched_transactions WHERE address = ? AND txid = ?').get(address, txid));
}

function queueWatchedTx(address, tx) {
  db.prepare(`
    INSERT OR IGNORE INTO watched_transactions (
      address, txid, direction, amount, counterparty, timestamp,
      notified_at, notification_status, attempt_count, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, '', 'pending', 0, '')
  `).run(address, tx.txid, tx.direction, tx.amount, tx.counterparty, tx.timestamp);
}

function getPendingWatchedTx(address) {
  return db.prepare(`
    SELECT * FROM watched_transactions
    WHERE address = ? AND notification_status != 'notified'
    ORDER BY timestamp ASC, id ASC
  `).all(address);
}

function markWatchedTxNotified(address, txid) {
  db.prepare(`
    UPDATE watched_transactions
    SET notification_status = 'notified', notified_at = ?, last_error = ''
    WHERE address = ? AND txid = ?
  `).run(nowIso(), address, txid);
}

function markWatchedTxFailed(address, txid, errorMessage) {
  db.prepare(`
    UPDATE watched_transactions
    SET notification_status = 'pending', attempt_count = attempt_count + 1, last_error = ?
    WHERE address = ? AND txid = ?
  `).run(String(errorMessage || ''), address, txid);
}

function updateWatchedLastTx(address, txid) {
  db.prepare('UPDATE watched_addresses SET last_tx_id = ?, updated_at = ? WHERE address = ?').run(txid, nowIso(), address);
}

function logQuery(address, action, result) {
  db.prepare('INSERT INTO query_logs (address, action, result, created_at) VALUES (?, ?, ?, ?)').run(address, action, result, nowIso());
}

function logApp(event, message = '', level = null) {
  const inferredLevel = level || (event.endsWith('_error') ? 'error' : 'info');
  db.prepare('INSERT INTO app_logs (event, level, message, created_at) VALUES (?, ?, ?, ?)').run(event, inferredLevel, String(message || ''), nowIso());
  db.prepare('DELETE FROM app_logs WHERE id NOT IN (SELECT id FROM app_logs ORDER BY id DESC LIMIT 500)').run();
}

function resetAllData() {
  const offset = getState('offset', '0');
  const reset = db.transaction(() => {
    db.prepare('DELETE FROM watched_transactions').run();
    db.prepare('DELETE FROM watched_addresses').run();
    db.prepare('DELETE FROM query_logs').run();
    db.prepare('DELETE FROM app_logs').run();
    db.prepare('DELETE FROM processed_updates').run();
    db.prepare('DELETE FROM app_state WHERE key != ?').run('offset');
    db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('watched_transactions', 'query_logs', 'app_logs')").run();
    setState('offset', offset);
  });
  reset();
  console.log('全部业务数据已清空');
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processed_updates (
      update_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watched_addresses (
      address TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      label_key TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_tx_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watched_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      txid TEXT NOT NULL,
      direction TEXT NOT NULL,
      amount REAL NOT NULL,
      counterparty TEXT,
      timestamp INTEGER NOT NULL,
      notified_at TEXT NOT NULL,
      notification_status TEXT NOT NULL DEFAULT 'notified',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      UNIQUE(address, txid)
    );
    CREATE TABLE IF NOT EXISTS query_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watched_transactions_address ON watched_transactions(address, timestamp);
    CREATE INDEX IF NOT EXISTS idx_query_logs_created ON query_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_app_logs_created ON app_logs(created_at);
  `);

  ensureColumn('watched_addresses', 'label_key', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('watched_transactions', 'notification_status', "TEXT NOT NULL DEFAULT 'notified'");
  ensureColumn('watched_transactions', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('watched_transactions', 'last_error', "TEXT NOT NULL DEFAULT ''");

  const updateLabelKey = db.prepare('UPDATE watched_addresses SET label_key = ? WHERE address = ?');
  for (const row of db.prepare('SELECT address, label FROM watched_addresses').all()) {
    updateLabelKey.run(normalizeLabel(row.label), row.address);
  }
  db.prepare("UPDATE watched_transactions SET notification_status = 'notified' WHERE notification_status IS NULL OR notification_status = ''").run();
  db.exec('CREATE INDEX IF NOT EXISTS idx_watched_addresses_label_key ON watched_addresses(label_key);');
}

function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function isProcessedUpdate(updateId) {
  return Boolean(db.prepare('SELECT 1 FROM processed_updates WHERE update_id = ?').get(updateId));
}

function markProcessedUpdate(updateId) {
  db.prepare('INSERT OR IGNORE INTO processed_updates (update_id, created_at) VALUES (?, ?)').run(updateId, nowIso());
}

function pruneProcessedUpdates() {
  db.prepare('DELETE FROM processed_updates WHERE update_id NOT IN (SELECT update_id FROM processed_updates ORDER BY update_id DESC LIMIT 2000)').run();
}

function getState(key, fallback = null) {
  return db.prepare('SELECT value FROM app_state WHERE key = ?').get(key)?.value ?? fallback;
}

function setState(key, value) {
  db.prepare('INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, String(value), nowIso());
}

function getPendingAction() {
  const raw = getState('pending_action', '');
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw);
    if (!pending?.action) return null;
    return pending;
  } catch {
    return {
      action: raw,
      chatId: config.ownerId,
      promptMessageId: null,
      expiresAt: 0,
    };
  }
}

function setPendingAction(action, chatId, promptMessageId) {
  setState('pending_action', JSON.stringify({
    action,
    chatId: String(chatId),
    promptMessageId: Number(promptMessageId),
    createdAt: Date.now(),
    expiresAt: Date.now() + config.pendingActionTimeoutSeconds * 1000,
  }));
}

function refreshPendingAction(pending) {
  if (!pending?.action) return;
  setPendingAction(pending.action, pending.chatId || config.ownerId, pending.promptMessageId);
}

function clearPendingAction() {
  db.prepare('DELETE FROM app_state WHERE key = ?').run('pending_action');
}

async function completePendingAction(pending) {
  clearPendingAction();
  await deletePendingPrompt(pending);
}

async function cancelPendingAction(pending = getPendingAction()) {
  clearPendingAction();
  await deletePendingPrompt(pending);
}

async function deletePendingPrompt(pending) {
  if (!pending?.chatId || !pending?.promptMessageId) return;
  try {
    await sendTelegram('deleteMessage', {
      chat_id: pending.chatId,
      message_id: pending.promptMessageId,
    });
  } catch (error) {
    logApp('prompt_delete_error', error.message);
  }
}

async function expirePendingActionIfNeeded() {
  if (pendingInputRunning) return;
  const pending = getPendingAction();
  if (!pending || pending.expiresAt > Date.now()) return;
  await completePendingAction(pending);
  logApp('action_expired', pending.action);
}

function setOffset(offset) {
  setState('offset', String(offset));
}

function sunToTrx(sun) {
  return Number(sun || 0) / 1e6;
}

function fromHexAddress(hex) {
  if (!hex || typeof hex !== 'string') return '-';
  if (hex.startsWith('T')) return hex;
  if (hex.startsWith('41')) return base58CheckEncode(Buffer.from(hex, 'hex'));
  return hex;
}

function base58CheckEncode(payload) {
  const checksum = sha256(sha256(payload)).subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

function base58Encode(buffer) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let x = BigInt(`0x${buffer.toString('hex')}`);
  let output = '';
  while (x > 0n) {
    const mod = x % 58n;
    output = alphabet[Number(mod)] + output;
    x /= 58n;
  }
  for (const byte of buffer) {
    if (byte === 0) output = '1' + output;
    else break;
  }
  return output || '1';
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest();
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(ms) {
  let seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  const parts = [];
  if (days) parts.push(`${days}天`);
  if (hours) parts.push(`${hours}小时`);
  if (minutes || !parts.length) parts.push(`${minutes}分钟`);
  return parts.join('');
}

function formatNumber(value, digits = 2) {
  const n = Number(value || 0);
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function formatTime(value) {
  if (!value) return '-';
  const timestamp = Number(value);
  const date = Number.isFinite(timestamp) ? new Date(timestamp) : new Date(value);
  return date.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function nowIso() {
  return new Date().toISOString();
}

function addressUrl(address) {
  return `${TRONSCAN_ADDRESS_BASE}${encodeURIComponent(address)}/transfers`;
}

function txUrl(txid) {
  return `${TRONSCAN_TX_BASE}${encodeURIComponent(txid)}/overview`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function numberEnv(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function requiredEnv(key) {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${key}`);
  return value;
}

function loadDotEnv() {
  try {
    const envText = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of envText.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^"(.*)"$/u, '$1');
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // optional
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestShutdown(signal) {
  console.log(`收到 ${signal}，正在退出...`);
  shuttingDown = true;
}
