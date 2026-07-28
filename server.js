const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const OpenAI = require('openai');
const crypto = require('crypto');

dotenv.config();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT) || 3000;

const PAGARME_API_URL = process.env.PAGARME_API_URL || 'https://api.pagar.me/core/v5';
const PAGARME_SECRET_KEY = String(process.env.PAGARME_SECRET_KEY || '').trim();
const DEFAULT_CUSTOMER_EMAIL = process.env.CUSTOMER_EMAIL || 'email001989887@gmail.com';
const DEFAULT_CUSTOMER_PHONE = onlyDigits(process.env.CUSTOMER_PHONE || '11987289871');
const BOLETO_EXPIRES_IN_DAYS = Math.max(1, Number.parseInt(process.env.BOLETO_EXPIRES_IN_DAYS || '3', 10));

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function isValidCpf(value) {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;

  const calculateDigit = length => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(cpf[index]) * (length + 1 - index);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  return calculateDigit(9) === Number(cpf[9]) && calculateDigit(10) === Number(cpf[10]);
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000000) return null;
  return amount;
}

function normalizeItems(items, amount) {
  if (!Array.isArray(items) || items.length === 0) {
    return [{ description: 'Venda Online', amount: amount, quantity: 1 }];
  }

  const normalized = items.slice(0, 20).map((item, index) => {
    const description = 'Venda Online';
    const itemAmount = Number(item && item.unitPrice);
    const quantity = Number(item && item.quantity);

    if (!description || !Number.isSafeInteger(itemAmount) || itemAmount <= 0 ||
        !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 100) {
      throw new Error('ITEM_INVALID');
    }

    return {
      description,
      amount: itemAmount,
      quantity,
    };
  });

  const itemsTotal = normalized.reduce((total, item) => total + item.amount * item.quantity, 0);
  if (itemsTotal !== amount) {
    return [{ description: 'Venda Online', amount: amount, quantity: 1 }];
  }

  return normalized;
}

function parseShippingAddress(rawAddress, rawZipCode) {
  const address = String(rawAddress || '').replace(/,?\s*CEP:\s*\d{5}-?\d{3}\s*$/i, '').trim();
  const zipCode = onlyDigits(rawZipCode);
  const parts = address.split(',').map(part => part.trim()).filter(Boolean);

  if (!address || zipCode.length !== 8 || parts.length < 3) {
    throw new Error('SHIPPING_INVALID');
  }

  const street = parts[0];
  const numberAndDetails = parts[1] || '';
  const streetNumberMatch = numberAndDetails.match(/\d+[A-Za-z0-9-]*/);
  const streetNumber = streetNumberMatch ? streetNumberMatch[0] : 'S/N';
  const inlineDetails = numberAndDetails
    .replace(streetNumber, '')
    .replace(/^\s*[-–—]\s*/, '')
    .split(/\s+[-–—]\s+/)
    .map(part => part.trim())
    .filter(Boolean);

  let state = '';
  let city = '';
  let cityIndex = -1;
  for (let index = parts.length - 1; index >= 1; index -= 1) {
    const match = parts[index].match(/^(.*?)\s*(?:\/|\-|–|—)\s*([A-Za-z]{2})$/);
    if (match) {
      city = match[1].trim();
      state = match[2].toUpperCase();
      cityIndex = index;
      break;
    }
  }

  if (!city || !state) {
    throw new Error('SHIPPING_INVALID');
  }

  const separateNeighborhood = cityIndex > 2 ? parts[cityIndex - 1] : '';
  const neighborhood = separateNeighborhood || inlineDetails[inlineDetails.length - 1] || '';
  const complementParts = separateNeighborhood ? inlineDetails : inlineDetails.slice(0, -1);
  const complement = complementParts.join(' - ');
  if (!street || !neighborhood) throw new Error('SHIPPING_INVALID');

  return {
    street: street.slice(0, 120),
    number: streetNumber.slice(0, 20),
    neighborhood: neighborhood.slice(0, 80),
    city: city.slice(0, 80),
    state,
    zip_code: zipCode,
    country: 'BR',
    ...(complement ? { complement: complement.slice(0, 120) } : {}),
  };
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'compra-checkout' });
});

app.post('/api/chat', async (req, res) => {
  const { message, context, userId, url } = req.body;
  console.log(`Mensagem recebida de ${userId}: ${message} (URL: ${url})`);

  const userMessage = { userId, sender: 'Usuário', text: message, timestamp: new Date().toISOString(), url };
  if (!chatHistory[userId]) chatHistory[userId] = [];
  chatHistory[userId].push(userMessage);
  io.to('admins').emit('new_message_for_admin', userMessage);

  if (!openai) {
    return res.status(503).json({
      reply: 'O atendimento por IA está temporariamente indisponível.',
      code: 'OPENAI_NOT_CONFIGURED',
    });
  }

  try {
    const messagesForOpenAI = [];
    if (context) messagesForOpenAI.push({ role: 'system', content: context });
    messagesForOpenAI.push({ role: 'user', content: message });

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
      messages: messagesForOpenAI,
      max_tokens: 150,
      temperature: 0.7,
    });

    const agentReply = completion.choices[0].message.content;
    const agentMessage = { userId, sender: 'Mateus', text: agentReply, timestamp: new Date().toISOString() };
    if (!chatHistory[userId]) chatHistory[userId] = [];
    chatHistory[userId].push(agentMessage);
    io.to('admins').emit('new_message_for_admin', agentMessage);
    return res.json({ reply: agentReply });
  } catch (error) {
    console.error('Erro ao chamar a API do OpenAI:', error.response ? error.response.data : error.message);
    return res.status(500).json({ error: 'Erro ao processar sua solicitação com a IA.' });
  }
});

app.post('/api/boleto', async (req, res) => {
  const requestId = crypto.randomUUID();

  try {
    const payerName = String(req.body.payer_name || '').trim().replace(/\s+/g, ' ');
    const payerCpf = onlyDigits(req.body.payer_cpf);
    const amount = normalizeAmount(req.body.amount);

    if (payerName.length < 3 || payerName.length > 120) {
      return res.status(400).json({ success: false, code: 'INVALID_NAME', message: 'Nome do pagador inválido.' });
    }
    if (!isValidCpf(payerCpf)) {
      return res.status(400).json({ success: false, code: 'INVALID_CPF', message: 'CPF do pagador inválido.' });
    }
    if (!amount) {
      return res.status(400).json({ success: false, code: 'INVALID_AMOUNT', message: 'Valor do pagamento inválido.' });
    }

    if (!PAGARME_SECRET_KEY) {
      console.error(`[${requestId}] Secret Key da Pagar.me ausente.`);
      return res.status(503).json({ success: false, code: 'PAYMENT_NOT_CONFIGURED', message: 'Pagamento temporariamente indisponível.' });
    }

    let items;
    let shippingAddress;
    try {
      items = normalizeItems(req.body.items, amount);
      shippingAddress = parseShippingAddress(req.body.shipping && req.body.shipping.address, req.body.shipping && req.body.shipping.zipCode);
    } catch (validationError) {
      const isItemError = validationError.message === 'ITEM_INVALID';
      return res.status(400).json({
        success: false,
        code: isItemError ? 'INVALID_ITEMS' : 'INVALID_SHIPPING',
        message: isItemError ? 'Dados dos produtos inválidos.' : 'Endereço de entrega incompleto ou inválido.',
      });
    }

    const today = new Date();
    const dueDate = new Date(today);
    dueDate.setDate(today.getDate() + BOLETO_EXPIRES_IN_DAYS);
    const dueAt = dueDate.toISOString().split('T')[0]; // YYYY-MM-DD

    const payload = {
      customer: {
        name: payerName,
        email: DEFAULT_CUSTOMER_EMAIL,
        type: 'individual',
        document: payerCpf,
        document_type: 'CPF',
        phones: {
          home_phone: {
            country_code: '55',
            area_code: DEFAULT_CUSTOMER_PHONE.substring(0, 2),
            number: DEFAULT_CUSTOMER_PHONE.substring(2),
          },
        },
        address: {
          line_1: `${shippingAddress.street}, ${shippingAddress.number}`,
          zip_code: shippingAddress.zip_code,
          city: shippingAddress.city,
          state: shippingAddress.state,
          country: shippingAddress.country,
          neighborhood: shippingAddress.neighborhood,
          ...(shippingAddress.complement ? { line_2: shippingAddress.complement } : {}),
        },
      },
      items: items,
      payments: [
        {
          payment_method: 'boleto',
          boleto: {
            instructions: 'Não receber após o vencimento.',
            due_at: dueAt,
            document_number: `DISKGAS-${requestId.substring(0, 8).toUpperCase()}`,
            type: 'DM',
          },
        },
      ],
    };

    const gatewayResponse = await axios.post(`${PAGARME_API_URL}/orders`, payload, {
      headers: {
        'Authorization': `Basic ${Buffer.from(PAGARME_SECRET_KEY + ':').toString('base64')}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 20000,
    });

    const order = gatewayResponse.data;
    const transaction = order.charges[0].last_transaction;

    if (!transaction || transaction.status !== 'waiting_payment') {
      console.error(`[${requestId}] Resposta da Pagar.me sem transação de boleto válida.`, {
        status: gatewayResponse.status,
        orderId: order.id,
      });
      return res.status(502).json({
        success: false,
        code: 'INVALID_GATEWAY_RESPONSE',
        message: 'O provedor não retornou um boleto válido.',
      });
    }

    return res.json({
      success: true,
      transactionId: order.id,
      boletoUrl: transaction.boleto_url,
      boletoPdf: transaction.pdf,
      boletoLine: transaction.line,
      boletoBarcode: transaction.barcode,
      dueAt: transaction.due_at,
    });
  } catch (error) {
    const gatewayStatus = error.response && error.response.status;
    const gatewayMessage = error.response && error.response.data && error.response.data.message
      ? String(error.response.data.message).slice(0, 300)
      : error.message;

    console.error(`[${requestId}] Erro ao gerar boleto na Pagar.me (${gatewayStatus || 'sem status'}): ${gatewayMessage}`);

    return res.status(502).json({
      success: false,
      code: 'BOLETO_GATEWAY_ERROR',
      message: 'Não foi possível gerar o boleto agora. Tente novamente em instantes.',
    });
  }
});

const users = {};
const chatHistory = {}; // Armazenamento em memória para o histórico de chat

io.on('connection', socket => {
  console.log(`Usuário conectado: ${socket.id}`);

  socket.on('join', ({ userId, isAdmin }) => {
    socket.userId = userId;
    if (isAdmin) {
      socket.join('admins');
      socket.emit('chat_history', Object.values(chatHistory).flat());
    } else {
      socket.join(userId);
    }
    users[userId] = socket.id;
    console.log(`${isAdmin ? 'Admin' : 'Usuário'} ${userId} entrou.`);
  });

  socket.on('send_message', data => {
    const { userId, text, sender, isAuto } = data;
    const message = { userId, text, sender, timestamp: new Date().toISOString() };
    if (!chatHistory[userId]) chatHistory[userId] = [];
    chatHistory[userId].push(message);

    console.log(`Mensagem de ${sender} (${userId}): ${text}`);
    
    // Se for mensagem automática (do agente), envia apenas para admins
    // Se for mensagem do usuário, envia para admins
    io.to('admins').emit('new_message_for_admin', message);
  });

  socket.on('disconnect', () => {
    console.log(`Usuário desconectado: ${socket.id}`);
    for (const userId in users) {
      if (users[userId] === socket.id) {
        delete users[userId];
        break;
      }
    }
  });
});

app.get("/",(req,res)=>{res.sendFile(path.join(__dirname,"index.html"));});

app.get("/admin",(req,res)=>{res.sendFile(path.join(__dirname,"admin.html"));});


// Catch-all para servir index.html para qualquer outra rota não definida
app.get("/*",(req,res)=>{res.sendFile(path.join(__dirname,"index.html"));});

server.listen(PORT, () => {
  console.log(`Servidor unificado rodando na porta ${PORT}`);
});
