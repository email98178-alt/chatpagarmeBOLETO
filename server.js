const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.json());

// Serve arquivos estáticos da raiz do projeto
app.use(express.static(__dirname));

// Rota principal para o checkout/chat
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Rota para o painel admin
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// Health check para o Render
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// Configuração Pagar.me
const PAGARME_SECRET_KEY = process.env.PAGARME_SECRET_KEY;
const PAGARME_API_URL = 'https://api.pagar.me/core/v5';

// Endpoint para gerar boleto
app.post('/api/boleto', async (req, res) => {
    try {
        const { payer_name, payer_cpf, amount, shipping } = req.body;

        const orderData = {
            items: [
                {
                    amount: amount,
                    description: 'Pedido Diskgás',
                    quantity: 1
                }
            ],
            customer: {
                name: payer_name,
                type: 'individual',
                document: payer_cpf,
                email: process.env.PIX_CUSTOMER_EMAIL || 'cliente@diskgas.com'
            },
            payments: [
                {
                    payment_method: 'boleto',
                    boleto: {
                        bank: '001', // Banco do Brasil como exemplo, Pagar.me lida com isso
                        instructions: 'Pagar até o vencimento. Entrega em 20-30 min após aprovação.',
                        due_at: new Date(Date.now() + (parseInt(process.env.PIX_EXPIRES_IN_DAYS || 1) * 24 * 60 * 60 * 1000)).toISOString()
                    }
                }
            ]
        };

        const response = await axios.post(`${PAGARME_API_URL}/orders`, orderData, {
            auth: {
                username: PAGARME_SECRET_KEY,
                password: ''
            }
        });

        const charge = response.data.charges[0];
        const last_transaction = charge.last_transaction;

        res.json({
            success: true,
            boletoLine: last_transaction.line_printable,
            boletoUrl: last_transaction.url,
            boletoPdf: last_transaction.pdf,
            orderId: response.data.id
        });

    } catch (error) {
        console.error('Erro ao gerar boleto Pagar.me:', error.response ? error.response.data : error.message);
        res.status(500).json({
            success: false,
            message: 'Erro ao processar boleto',
            details: error.response ? error.response.data : error.message
        });
    }
});

// Endpoint de Chat (Proxy para OpenAI ou similar)
app.post('/api/chat', async (req, res) => {
    try {
        const { message, context, userId } = req.body;
        
        // Se houver chave OpenAI, usa ela, senão retorna resposta padrão
        if (process.env.OPENAI_API_KEY) {
            const openaiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: process.env.OPENAI_MODEL || "gpt-3.5-turbo",
                messages: [
                    { role: "system", content: context },
                    { role: "user", content: message }
                ]
            }, {
                headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
            });
            
            res.json({ reply: openaiResponse.data.choices[0].message.content });
        } else {
            // Lógica de fallback simples caso não tenha IA configurada
            let reply = "Entendi. Como posso te ajudar com seu pedido de gás?";
            const msg = message.toLowerCase();
            
            if (msg.includes("boleto") || msg.includes("pagar") || msg.includes("código")) {
                reply = "BOLETO_PROBLEM"; // Gatilho para o front-end mostrar o boleto novamente
            }
            
            res.json({ reply });
        }
    } catch (error) {
        res.status(500).json({ reply: "Estou com uma pequena instabilidade, mas pode continuar." });
    }
});

// Gerenciamento de Mensagens via Socket.io
const chatHistories = {};

io.on('connection', (socket) => {
    socket.on('join', ({ userId, isAdmin }) => {
        socket.join(userId);
        if (isAdmin) {
            socket.join('admins');
            // Envia todos os históricos para o admin (simplificado)
            Object.keys(chatHistories).forEach(id => {
                socket.emit('chat_history', chatHistories[id]);
            });
        }
    });

    socket.on('send_message', (data) => {
        const { userId, text, sender, isAuto, hasFile } = data;
        const messageData = {
            userId,
            text,
            sender,
            timestamp: new Date().toLocaleTimeString('pt-BR'),
            hasFile: !!hasFile
        };

        if (!chatHistories[userId]) chatHistories[userId] = [];
        chatHistories[userId].push(messageData);

        // Se for mensagem do cliente, manda para os admins
        if (sender === 'Cliente') {
            io.to('admins').emit('new_message_for_admin', messageData);
        }
        
        // Ecoa para o próprio usuário (útil para múltiplos dispositivos se implementado)
        socket.to(userId).emit('new_message', messageData);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor unificado rodando na porta ${PORT}`);
});
