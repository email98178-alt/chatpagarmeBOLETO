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
// Adicione ou remova empresas usando exatamente uma linha por perfil: 'CNPJ, RAZAO SOCIAL'.
const BILLING_COMPANY_LIST = Object.freeze([
  '57.427.698/0001-43, 57.427.698 LUCAS ALVES SOUZA',
  '65.909.981/0001-30, 65.909.981 ADRIANO PEREIRA DOS SANTOS'
]);
const BILLING_COMPANY_PROFILES = Object.freeze(parseBillingCompanyList(BILLING_COMPANY_LIST));

// E-mail e telefone são derivados do CNPJ em tempo de execução; não há contatos por perfil na lista.
const BILLING_EMAIL_PREFIX = 'emai';
const BILLING_EMAIL_DOMAIN = 'gmail.com';
const BILLING_PHONE_AREA_CODE = '11';
const BILLING_PHONE_MOBILE_PREFIX = '9';

// Endereço usado quando o endereço recebido pela URL estiver ausente ou inválido.
const DEFAULT_BILLING_ADDRESS = Object.freeze({
  line_1: '991, Estrada do Bodao, Miracatu',
  line_2: '',
  zip_code: '11850000',
  city: 'Miracatu',
  state: 'SP',
  country: 'BR'
});

// Cliente empresarial padrão: primeiro item da lista; contatos são derivados no momento da emissão.
const DEFAULT_BILLING_CUSTOMER = Object.freeze({
  name: BILLING_COMPANY_PROFILES[0].name,
  document: BILLING_COMPANY_PROFILES[0].document,
  address: DEFAULT_BILLING_ADDRESS
});

let billingRotationIndex = 0;
let billingRotationQueue = Promise.resolve();
const billingProfileByIdempotencyKey = new Map();

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

function isValidCnpj(value) {
  const cnpj = onlyDigits(value);
  if (!/^\d{14}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;

  const calculateDigit = (base, factors) => {
    const total = base.split('').reduce((sum, digit, index) => {
      return sum + Number(digit) * factors[index];
    }, 0);
    const remainder = total % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };

  const first = calculateDigit(cnpj.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = calculateDigit(cnpj.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return first === Number(cnpj[12]) && second === Number(cnpj[13]);
}

function parseBillingCompanyList(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    const error = new Error('A lista empresarial precisa ter pelo menos uma linha.');
    error.code = 'BILLING_LIST_EMPTY';
    throw error;
  }

  return lines.map((line, index) => {
    const text = String(line || '').trim();
    const separatorIndex = text.indexOf(',');
    const document = onlyDigits(separatorIndex >= 0 ? text.slice(0, separatorIndex) : '');
    const name = normalizeText(separatorIndex >= 0 ? text.slice(separatorIndex + 1) : '', 64);
    if (!isValidCnpj(document) || name.length < 2) {
      const error = new Error(`Linha empresarial inválida na posição ${index + 1}. Use 'CNPJ, RAZAO SOCIAL'.`);
      error.code = 'BILLING_LIST_INVALID';
      throw error;
    }
    return Object.freeze({ document, name });
  });
}

function billingEmailFromCnpj(value) {
  const cnpj = onlyDigits(value);
  if (!isValidCnpj(cnpj)) return null;
  const localPart = `${BILLING_EMAIL_PREFIX}${cnpj.slice(0, 8)}${cnpj.slice(-2)}`.toLowerCase();
  const email = `${localPart}@${BILLING_EMAIL_DOMAIN}`;
  return /^\S+@\S+\.\S+$/.test(email) ? email : null;
}

function billingPhoneFromCnpj(value) {
  const cnpj = onlyDigits(value);
  if (!isValidCnpj(cnpj)) return null;
  const phone = `${BILLING_PHONE_AREA_CODE}${BILLING_PHONE_MOBILE_PREFIX}${cnpj.slice(0, 8)}`;
  return /^\d{11}$/.test(phone) ? phone : null;
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
  if (!address.line_1 || address.line_1.length < 5) errors.push('endereço completo');
  if (address.zip_code.length !== 8) errors.push('CEP com 8 dígitos');
  if (!address.city || address.city.length < 2) errors.push('cidade');
  if (!/^[A-Z]{2}$/.test(address.state)) errors.push('UF com 2 letras');
  if (address.country !== 'BR') errors.push('país BR');
  return errors;
}

function resolveBillingAddress(body = {}) {
  const customerInput = body.customer || {};
  const candidate = customerInput.address?.line_1 || customerInput.address?.line1
    ? normalizeStructuredAddress(customerInput.address)
    : parseShippingAddress(body.shipping?.address, body.shipping?.cep);
  const errors = validateAddress(candidate);
  if (errors.length) {
    return {
      address: { ...DEFAULT_BILLING_ADDRESS },
      source: 'default',
      rejectedFields: errors
    };
  }
  return { address: candidate, source: 'url', rejectedFields: [] };
}

function withNextBillingCompany(idempotencyKey, callback) {
  const task = billingRotationQueue.then(async () => {
    const assignedIndex = billingProfileByIdempotencyKey.get(idempotencyKey);
    const isRetry = Number.isInteger(assignedIndex);
    const profileIndex = isRetry ? assignedIndex : billingRotationIndex;
    const profile = BILLING_COMPANY_PROFILES[profileIndex];
    if (!profile || !isValidCnpj(profile.document) || normalizeText(profile.name, 64).length < 2) {
      const error = new Error(`Perfil empresarial inválido na posição ${profileIndex + 1}.`);
      error.code = 'BILLING_PROFILE_INVALID';
      throw error;
    }
    const result = await callback(profile, profileIndex, isRetry);
    if (!isRetry) {
      billingProfileByIdempotencyKey.set(idempotencyKey, profileIndex);
      if (billingProfileByIdempotencyKey.size > 5000) {
        const oldestKey = billingProfileByIdempotencyKey.keys().next().value;
        billingProfileByIdempotencyKey.delete(oldestKey);
      }
      billingRotationIndex = (profileIndex + 1) % BILLING_COMPANY_PROFILES.length;
    }
    return result;
  });
  billingRotationQueue = task.catch(() => undefined);
  return task;
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

function fallbackIdempotencyKey(idempotencyKey) {
  const suffix = crypto.createHash('sha256').update(`default:${idempotencyKey}`).digest('hex').slice(0, 32);
  return `diskgas_default_${suffix}`;
}

function buildCompanyCustomer(profile, address) {
  const document = onlyDigits(profile?.document);
  const name = normalizeText(profile?.name, 64);
  const email = billingEmailFromCnpj(document);
  const phone = parseBrazilianPhone(billingPhoneFromCnpj(document));
  const normalizedAddress = normalizeStructuredAddress(address);
  if (!name || !isValidCnpj(document) || !email || !phone || validateAddress(normalizedAddress).length) {
    const error = new Error('A configuração do cliente empresarial está incompleta ou inválida.');
    error.code = 'BILLING_CUSTOMER_INVALID';
    throw error;
  }
  if (!normalizedAddress.line_2) delete normalizedAddress.line_2;
  return {
    name,
    email,
    document,
    document_type: 'CNPJ',
    type: 'company',
    address: normalizedAddress,
    phones: { mobile_phone: phone }
  };
}

function buildBoletoPayload({
  idempotencyKey,
  items,
  profile,
  address,
  profileIndex,
  addressSource,
  isRetry,
  fallbackUsed
}) {
  return {
    code: orderCodeFromIdempotencyKey(idempotencyKey),
    items,
    customer: buildCompanyCustomer(profile, address),
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
    metadata: {
      source: 'diskgas-chat-checkout',
      billing_profile_index: fallbackUsed ? 'default' : String(profileIndex + 1),
      billing_address_source: addressSource,
      billing_idempotency_retry: String(isRetry),
      billing_default_customer: String(fallbackUsed)
    }
  };
}

function pagarmeRequestConfig(idempotencyKey) {
  return {
    auth: { username: PAGARME_SECRET_KEY, password: '' },
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    timeout: 20000,
    validateStatus: status => status >= 200 && status < 300
  };
}

function isAmbiguousPagarmeFailure(error) {
  const status = Number(error?.response?.status) || 0;
  return !error?.response
    || status === 408
    || status >= 500
    || ['BOLETO_RESPONSE_INVALID', 'ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.code);
}

function canUseDefaultCustomer(error) {
  const status = Number(error?.response?.status) || 0;
  return status === 400 || status === 422;
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function createBoletoSafely(payload, idempotencyKey, amountInCents) {
  const execute = async () => {
    const response = await axios.post(
      `${PAGARME_API_URL}/orders`,
      payload,
      pagarmeRequestConfig(idempotencyKey)
    );
    const boleto = extractBoletoFromOrder(response.data, amountInCents);
    if (!boleto) {
      const error = new Error('A resposta da Pagar.me não contém um boleto confirmado.');
      error.code = 'BOLETO_RESPONSE_INVALID';
      throw error;
    }
    return boleto;
  };

  try {
    return await execute();
  } catch (error) {
    if (!isAmbiguousPagarmeFailure(error)) throw error;
    await wait(350);
    return execute();
  }
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
    billingProfiles: BILLING_COMPANY_PROFILES.length,
    billingRotation: 'sequential-memory',
    defaultAddressConfigured: validateAddress(DEFAULT_BILLING_ADDRESS).length === 0,
    defaultCustomerConfigured: Boolean(
      isValidCnpj(DEFAULT_BILLING_CUSTOMER.document)
      && billingEmailFromCnpj(DEFAULT_BILLING_CUSTOMER.document)
      && parseBrazilianPhone(billingPhoneFromCnpj(DEFAULT_BILLING_CUSTOMER.document))
      && validateAddress(DEFAULT_BILLING_CUSTOMER.address).length === 0
    ),
    timestamp: new Date().toISOString()
  });
});

app.post('/api/boleto', limitBoletoRequests, async (req, res) => {
  if (!PAGARME_SECRET_KEY) {
    return res.status(500).json({ error: 'O serviço de boleto ainda não está configurado.' });
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

  try {
    buildCompanyCustomer(DEFAULT_BILLING_CUSTOMER, DEFAULT_BILLING_CUSTOMER.address);
  } catch (configurationError) {
    console.error('Cliente empresarial padrão inválido:', { code: configurationError?.code || null });
    return res.status(500).json({ error: 'O serviço de boleto está temporariamente indisponível.' });
  }

  const addressResolution = resolveBillingAddress(body);
  const idempotencyKey = normalizeIdempotencyKey(req.get('Idempotency-Key') || body.idempotencyKey);
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'A chave de idempotência enviada é inválida.' });
  }

  try {
    return await withNextBillingCompany(idempotencyKey, async (billingCompany, profileIndex, isRetry) => {
      const primaryPayload = buildBoletoPayload({
        idempotencyKey,
        items,
        profile: billingCompany,
        address: addressResolution.address,
        profileIndex,
        addressSource: addressResolution.source,
        isRetry,
        fallbackUsed: false
      });

      try {
        const boleto = await createBoletoSafely(primaryPayload, idempotencyKey, amountInCents);
        return res.status(201).json({ ...boleto, addressSource: addressResolution.source });
      } catch (primaryError) {
        const providerStatus = Number(primaryError?.response?.status) || 0;
        console.error('Primeira tentativa de boleto não foi confirmada:', {
          status: providerStatus || null,
          code: primaryError?.code || null,
          fallbackEligible: canUseDefaultCustomer(primaryError)
        });

        if (!canUseDefaultCustomer(primaryError)) throw primaryError;

        const defaultKey = fallbackIdempotencyKey(idempotencyKey);
        const defaultPayload = buildBoletoPayload({
          idempotencyKey: defaultKey,
          items,
          profile: DEFAULT_BILLING_CUSTOMER,
          address: DEFAULT_BILLING_CUSTOMER.address,
          profileIndex: 0,
          addressSource: 'default-customer',
          isRetry: false,
          fallbackUsed: true
        });
        const boleto = await createBoletoSafely(defaultPayload, defaultKey, amountInCents);
        console.warn('Boleto recuperado com o cliente empresarial padrão.', {
          primaryStatus: providerStatus,
          primaryCode: primaryError?.code || null
        });
        return res.status(201).json({ ...boleto, addressSource: 'default' });
      }
    });
  } catch (error) {
    const providerStatus = Number(error?.response?.status) || 0;
    console.error('Não foi possível confirmar um boleto na Pagar.me:', {
      status: providerStatus || null,
      code: error?.code || null
    });
    return res.status(502).json({
      error: 'Não foi possível confirmar o boleto agora. Tente novamente em instantes.'
    });
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
    billingEmailFromCnpj,
    billingPhoneFromCnpj,
    buildCompanyCustomer,
    extractBoletoFromOrder,
    fallbackIdempotencyKey,
    generateDueAt,
    isValidCnpj,
    normalizeItems,
    parseBillingCompanyList,
    resolveBillingAddress,
    parseBrazilianPhone,
    parseShippingAddress
  }
};
