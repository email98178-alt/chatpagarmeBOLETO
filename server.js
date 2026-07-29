'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const path = require('path');
const axios = require('axios');
const OpenAI = require('openai');
const { Server } = require('socket.io');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = Number(process.env.PORT) || 3000;
const PAGARME_API_URL = String(process.env.PAGARME_API_URL || 'https://api.pagar.me/core/v5').replace(/\/+$/, '');
const PAGARME_SECRET_KEY = String(process.env.PAGARME_SECRET_KEY || '').trim();
const PAGARME_BOLETO_DUE_DAYS = normalizeInteger(process.env.PAGARME_BOLETO_DUE_DAYS, 3, 1, 30);
const PAGARME_BOLETO_INSTRUCTIONS = String(
  process.env.PAGARME_BOLETO_INSTRUCTIONS || 'Pagar até o vencimento.'
).trim().slice(0, 255);
const DEFAULT_CUSTOMER_EMAIL = String(process.env.PAGARME_CUSTOMER_EMAIL || '').trim();
const DEFAULT_CUSTOMER_PHONE = onlyDigits(process.env.PAGARME_CUSTOMER_PHONE || '');
const DEFAULT_CUSTOMER_DOCUMENT = onlyDigits(process.env.PAGARME_CUSTOMER_DOCUMENT || '');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeMoneyToCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) return null;
  return Math.round(amount * 100);
}

function normalizeText(value, maxLength = 255) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function isValidCpf(value) {
  const cpf = onlyDigits(value);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;

  const calculateDigit = (base, factor) => {
    let total = 0;
    for (const digit of base) total += Number(digit) * factor--;
    const remainder = (total * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  const first = calculateDigit(cpf.slice(0, 9), 10);
  const second = calculateDigit(cpf.slice(0, 10), 11);
  return first === Number(cpf[9]) && second === Number(cpf[10]);
}

function parseBrazilianPhone(value) {
  let digits = onlyDigits(value);
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }
  if (digits.length !== 10 && digits.length !== 11) return null;
  return {
    country_code: '55',
    area_code: digits.slice(0, 2),
    number: digits.slice(2)
  };
}

function parseShippingAddress(rawAddress, rawCep) {
  const zipCode = onlyDigits(rawCep);
  const source = normalizeText(rawAddress, 500)
    .replace(/,?\s*CEP\s*:?\s*\d{5}-?\d{3}\s*$/i, '')
    .trim();
  const parts = source.split(',').map(part => part.trim()).filter(Boolean);

  let city = '';
  let state = '';
  if (parts.length) {
    const cityState = parts[parts.length - 1].match(/^(.+?)(?:\s*[-/]\s*)([A-Za-z]{2})$/);
    if (cityState) {
      city = normalizeText(cityState[1], 64);
      state = cityState[2].toUpperCase();
      parts.pop();
    }
  }

  const street = normalizeText(parts.shift(), 160);
  const numberAndComplement = normalizeText(parts.shift(), 120);
  let neighborhood = normalizeText(parts.shift(), 80);
  const extra = normalizeText(parts.join(', '), 128);
  let streetNumber = numberAndComplement || 'S/N';
  let complement = extra;
  const splitNumber = numberAndComplement.match(/^([^\s-]+)\s*[-–]\s*(.+)$/);
  if (splitNumber) {
    streetNumber = normalizeText(splitNumber[1], 20);
    const details = splitNumber[2].split(/\s+[-–]\s+/).map(part => part.trim()).filter(Boolean);
    if (!neighborhood && details.length > 1) neighborhood = normalizeText(details.pop(), 80);
    complement = normalizeText([...details, extra].filter(Boolean).join(', '), 128);
  }

  return {
    line_1: normalizeText([streetNumber, street, neighborhood].filter(Boolean).join(', '), 255),
    line_2: complement,
    zip_code: zipCode,
    city,
    state,
    country: 'BR'
  };
}

function normalizeStructuredAddress(address = {}) {
  return {
    line_1: normalizeText(address.line_1 || address.line1, 255),
    line_2: normalizeText(address.line_2 || address.line2, 128),
    zip_code: onlyDigits(address.zip_code || address.zipCode),
    city: normalizeText(address.city, 64),
    state: normalizeText(address.state, 2).toUpperCase(),
    country: normalizeText(address.country || 'BR', 2).toUpperCase()
  };
}

function validateAddress(address) {
  const errors = [];
  if (!address.line_1) errors.push('endereço completo');
  if (address.zip_code.length !== 8) errors.push('CEP com 8 dígitos');
  if (!address.city) errors.push('cidade');
  if (!/^[A-Z]{2}$/.test(address.state)) errors.push('UF com 2 letras');
  return errors;
}

function normalizeItems(rawItems, fallbackAmountInCents) {
  const source = Array.isArray(rawItems) && rawItems.length
    ? rawItems.slice(0, 100)
    : [{ title: 'Pedido Diskgas', unitPrice: fallbackAmountInCents / 100, quantity: 1 }];

  const items = source.map((item, index) => {
    const quantity = normalizeInteger(item.quantity ?? item.q, 1, 1, 999);
    const unitAmount = normalizeMoneyToCents(item.unitPrice ?? item.amount ?? item.v);
    return {
      amount: unitAmount,
      description: normalizeText(item.title ?? item.description ?? item.n ?? `Item ${index + 1}`, 255),
      quantity,
      code: normalizeText(item.code || `ITEM-${index + 1}`, 52)
    };
  });

  if (items.some(item => !item.amount || !item.description)) return null;
  return items;
}

function generateDueAt(days = PAGARME_BOLETO_DUE_DAYS) {
  const dueAt = new Date();
  dueAt.setUTCDate(dueAt.getUTCDate() + days);
  dueAt.setUTCHours(23, 59, 59, 0);
  return dueAt.toISOString();
}

function normalizeIdempotencyKey(value) {
  const key = normalizeText(value, 100);
  if (!key) return crypto.randomUUID();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) return null;
  return key;
}

function orderCodeFromIdempotencyKey(idempotencyKey) {
  const suffix = crypto.createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24);
  return `diskgas-${suffix}`;
}

function extractPagarmeError(error) {
  const status = Number(error?.response?.status) || 0;
  const data = error?.response?.data;
  if (status === 401 || status === 403) {
    return 'A Pagar.me recusou a autenticação. Confira a variável PAGARME_SECRET_KEY no Render.';
  }

  const messages = [];
  if (data && typeof data === 'object') {
    if (typeof data.message === 'string') messages.push(data.message);
    if (typeof data.error === 'string') messages.push(data.error);
    if (data.errors && typeof data.errors === 'object') {
      Object.values(data.errors).flat().forEach(item => {
        if (typeof item === 'string') messages.push(item);
        else if (item && typeof item.message === 'string') messages.push(item.message);
      });
    }
  }

  const providerMessage = normalizeText(messages.join(' '), 500);
  if (status >= 400 && status < 500 && providerMessage) {
    return `A Pagar.me não aceitou os dados do boleto: ${providerMessage}`;
  }
  return 'A Pagar.me não conseguiu emitir o boleto agora. Tente novamente em instantes.';
}

function extractBoletoFromOrder(order, amountInCents) {
  const charge = Array.isArray(order?.charges) ? order.charges[0] : null;
  const transaction = charge?.last_transaction || charge?.lastTransaction || null;
  const line = normalizeText(
    transaction?.line || transaction?.digitable_line || transaction?.digitableLine,
    255
  );
  const barcode = normalizeText(transaction?.barcode, 255);
  const url = normalizeText(transaction?.pdf || transaction?.url, 1000);
  if (!line) return null;

  return {
    orderId: normalizeText(order?.id, 100),
    chargeId: normalizeText(charge?.id, 100),
    transactionId: normalizeText(transaction?.id, 100),
    status: normalizeText(charge?.status || order?.status || 'pending', 50),
    amount: amountInCents,
    line,
    barcode,
    url,
    dueAt: transaction?.due_at || transaction?.dueAt || null
  };
}

const boletoAttempts = new Map();
function limitBoletoRequests(req, res, next) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (boletoAttempts.get(key) || []).filter(timestamp => now - timestamp < windowMs);
  if (recent.length >= 8) {
    return res.status(429).json({ error: 'Muitas tentativas de emissão. Aguarde alguns minutos e tente novamente.' });
  }
  recent.push(now);
  boletoAttempts.set(key, recent);
  return next();
}

app.get('/api/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'checkout-pagarme-boleto',
    pagarmeConfigured: Boolean(PAGARME_SECRET_KEY),
    timestamp: new Date().toISOString()
  });
});

app.post('/api/boleto', limitBoletoRequests, async (req, res) => {
  if (!PAGARME_SECRET_KEY) {
    return res.status(500).json({ error: 'PAGARME_SECRET_KEY não foi configurada no servidor.' });
  }

  const body = req.body || {};
  const amountInCents = normalizeMoneyToCents(body.amount);
  if (!amountInCents) {
    return res.status(400).json({ error: 'Informe um valor de pedido válido e maior que zero.' });
  }

  let items = normalizeItems(body.items, amountInCents);
  if (!items) {
    return res.status(400).json({ error: 'Os itens do pedido possuem valor ou descrição inválidos.' });
  }
  const calculatedAmount = items.reduce((total, item) => total + item.amount * item.quantity, 0);
  if (calculatedAmount !== amountInCents) {
    items = [{
      amount: amountInCents,
      description: 'Pedido Diskgas',
      quantity: 1,
      code: 'PEDIDO-DISKGAS'
    }];
  }

  const customerInput = body.customer || {};
  const customerName = normalizeText(customerInput.name || body.customerName, 64);
  const customerEmail = normalizeText(customerInput.email || DEFAULT_CUSTOMER_EMAIL, 64);
  const customerDocument = onlyDigits(customerInput.document || body.document || DEFAULT_CUSTOMER_DOCUMENT);
  const customerPhone = parseBrazilianPhone(customerInput.phone || body.phone || DEFAULT_CUSTOMER_PHONE);

  if (customerName.length < 2) {
    return res.status(400).json({ error: 'Informe o nome completo do cliente para emitir o boleto.' });
  }
  if (!/^\S+@\S+\.\S+$/.test(customerEmail)) {
    return res.status(400).json({ error: 'Informe um e-mail válido do cliente para emitir o boleto.' });
  }
  if (!isValidCpf(customerDocument)) {
    return res.status(400).json({ error: 'Informe um CPF válido do cliente para emitir o boleto.' });
  }
  if (!customerPhone) {
    return res.status(400).json({ error: 'Informe um telefone brasileiro válido, com DDD.' });
  }

  const structuredAddress = customerInput.address?.line_1 || customerInput.address?.line1
    ? normalizeStructuredAddress(customerInput.address)
    : parseShippingAddress(body.shipping?.address, body.shipping?.cep);
  const addressErrors = validateAddress(structuredAddress);
  if (addressErrors.length) {
    return res.status(400).json({ error: `Revise o endereço do cliente: ${addressErrors.join(', ')}.` });
  }

  const idempotencyKey = normalizeIdempotencyKey(req.get('Idempotency-Key') || body.idempotencyKey);
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'A chave de idempotência enviada é inválida.' });
  }

  const customerAddress = { ...structuredAddress };
  if (!customerAddress.line_2) delete customerAddress.line_2;

  const payload = {
    code: orderCodeFromIdempotencyKey(idempotencyKey),
    items,
    customer: {
      name: customerName,
      email: customerEmail,
      document: customerDocument,
      document_type: 'CPF',
      type: 'individual',
      address: customerAddress,
      phones: { mobile_phone: customerPhone }
    },
    payments: [
      {
        payment_method: 'boleto',
        boleto: {
          instructions: PAGARME_BOLETO_INSTRUCTIONS,
          due_at: generateDueAt(),
          type: 'DM'
        }
      }
    ],
    metadata: { source: 'diskgas-chat-checkout' }
  };

  try {
    const pagarmeResponse = await axios.post(`${PAGARME_API_URL}/orders`, payload, {
      auth: { username: PAGARME_SECRET_KEY, password: '' },
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      timeout: 20000,
      validateStatus: status => status >= 200 && status < 300
    });

    const boleto = extractBoletoFromOrder(pagarmeResponse.data, amountInCents);
    if (!boleto) {
      return res.status(502).json({ error: 'A Pagar.me criou o pedido, mas não devolveu a linha digitável do boleto.' });
    }
    return res.status(201).json(boleto);
  } catch (error) {
    const providerStatus = Number(error?.response?.status) || 502;
    const responseStatus = providerStatus >= 400 && providerStatus < 500 ? 422 : 502;
    console.error('Falha ao emitir boleto na Pagar.me:', {
      status: providerStatus || null,
      code: error?.code || null
    });
    return res.status(responseStatus).json({ error: extractPagarmeError(error) });
  }
});

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const users = {};
const chatHistory = {};

app.post('/api/chat', async (req, res) => {
  const { message, context, userId, url } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Mensagem é obrigatória.' });

  const normalizedUserId = normalizeText(userId || 'cliente', 100);
  const userMessage = {
    userId: normalizedUserId,
    sender: 'Usuário',
    text: normalizeText(message, 4000),
    timestamp: new Date().toISOString(),
    url: normalizeText(url, 1000)
  };
  if (!chatHistory[normalizedUserId]) chatHistory[normalizedUserId] = [];
  chatHistory[normalizedUserId].push(userMessage);
  io.to('admins').emit('new_message_for_admin', userMessage);

  if (!openai) {
    return res.status(503).json({
      reply: 'O atendimento por IA está temporariamente indisponível.',
      code: 'OPENAI_NOT_CONFIGURED'
    });
  }

  try {
    const messagesForOpenAI = [];
    if (context) messagesForOpenAI.push({ role: 'system', content: String(context) });
    messagesForOpenAI.push({ role: 'user', content: String(message) });
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      messages: messagesForOpenAI,
      max_tokens: 150,
      temperature: 0.7
    });

    const agentReply = completion.choices?.[0]?.message?.content || 'Como posso ajudar com seu pedido?';
    const agentMessage = {
      userId: normalizedUserId,
      sender: 'Mateus',
      text: agentReply,
      timestamp: new Date().toISOString()
    };
    chatHistory[normalizedUserId].push(agentMessage);
    io.to('admins').emit('new_message_for_admin', agentMessage);
    return res.json({ reply: agentReply });
  } catch (error) {
    console.error('Erro ao chamar a API do OpenAI:', error?.response?.data || error?.message || error);
    return res.status(500).json({ error: 'Erro ao processar sua solicitação com a IA.' });
  }
});

io.on('connection', socket => {
  console.log(`Usuário conectado: ${socket.id}`);

  socket.on('join', ({ userId, isAdmin } = {}) => {
    const normalizedUserId = normalizeText(userId, 100);
    if (!normalizedUserId) return;
    socket.userId = normalizedUserId;
    if (isAdmin) {
      socket.join('admins');
      socket.emit('chat_history', Object.values(chatHistory).flat());
    } else {
      socket.join(normalizedUserId);
    }
    users[normalizedUserId] = socket.id;
  });

  socket.on('send_message', data => {
    const normalizedUserId = normalizeText(data?.userId || socket.userId, 100);
    if (!normalizedUserId) return;
    const message = {
      userId: normalizedUserId,
      text: normalizeText(data?.text, 4000),
      sender: normalizeText(data?.sender || 'Cliente', 64),
      isAuto: Boolean(data?.isAuto),
      attachment: data?.attachment || null,
      timestamp: new Date().toISOString()
    };
    if (!chatHistory[normalizedUserId]) chatHistory[normalizedUserId] = [];
    chatHistory[normalizedUserId].push(message);
    io.to('admins').emit('new_message_for_admin', message);
  });

  socket.on('disconnect', () => {
    for (const userId of Object.keys(users)) {
      if (users[userId] === socket.id) delete users[userId];
    }
  });
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (_req, res) => {
  const adminPath = path.join(__dirname, 'admin.html');
  if (!require('fs').existsSync(adminPath)) return res.status(404).send('Painel administrativo não incluído.');
  return res.sendFile(adminPath);
});
app.get('/*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Servidor unificado rodando na porta ${PORT}`);
    console.log(`Pagar.me configurada: ${PAGARME_SECRET_KEY ? 'sim' : 'não'}`);
  });
}

module.exports = {
  app,
  server,
  helpers: {
    extractBoletoFromOrder,
    generateDueAt,
    isValidCpf,
    normalizeItems,
    parseBrazilianPhone,
    parseShippingAddress
  }
};
