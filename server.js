const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');

dotenv.config();

const app = express();
const rootDir = __dirname;
const port = Number(process.env.PORT) || 3000;
const configuredBaseUrl = String(process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
const allowedOriginsFromEnv = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);

const directPaymentLinks = {
    sbp: process.env.PAYMENT_LINK_SBP || '',
    mir: process.env.PAYMENT_LINK_MIR || '',
    crypto: process.env.PAYMENT_LINK_CRYPTO || '',
    yookassa: process.env.PAYMENT_LINK_YOOKASSA || ''
};

const validMethods = new Set(['sbp', 'mastercard', 'mir', 'crypto', 'yookassa']);
let stripeClient = null;
let smtpTransport = null;
const maxSpeedPayloadBytes = 50 * 1024 * 1024;
const exchangeRateTtlMs = 10 * 60 * 1000;
const defaultUsdRubRate = Number.parseFloat(process.env.DEFAULT_USD_RUB_RATE || '90');
const exchangeRateCache = {
    usdRub: Number.isFinite(defaultUsdRubRate) ? defaultUsdRubRate : 90,
    updatedAt: 0,
    source: 'default'
};

app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://js.stripe.com'],
            'script-src-attr': ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
            imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
            fontSrc: ["'self'", 'data:', 'https://cdnjs.cloudflare.com'],
            connectSrc: [
                "'self'",
                'https://speed.cloudflare.com',
                'https://www.google.com',
                'https://postman-echo.com',
                'https://httpbin.org',
                'https://api.stripe.com'
            ],
            frameSrc: ["'self'", 'https://js.stripe.com', 'https://checkout.stripe.com', 'https://hooks.stripe.com'],
            workerSrc: ["'self'", 'blob:'],
            formAction: ["'self'", 'https://checkout.stripe.com'],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'none'"]
        }
    },
    crossOriginEmbedderPolicy: false
}));

const apiCors = cors(corsOptionsDelegate);
app.use('/api', apiCors);
app.use('/share', apiCors);
app.options('/api/*', apiCors);
app.options('/share', apiCors);

const speedDownloadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много запросов скорости. Попробуйте через минуту.' }
});

const speedUploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много upload-запросов. Попробуйте позже.' }
});

const paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много попыток платежа. Попробуйте позже.' }
});

const shareLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 80,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много запросов шаринга. Попробуйте позже.' }
});

const contactLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Слишком много сообщений. Попробуйте позже.' }
});

app.use('/api/speed-download', speedDownloadLimiter);
app.use('/api/speed-upload', speedUploadLimiter);
app.use('/api/create-payment-session', paymentLimiter);
app.use('/api/contact-developer', contactLimiter);
app.use('/share', shareLimiter);

app.use(express.static(rootDir, { extensions: ['html'] }));

function normalizeOrigin(value) {
    try {
        const url = new URL(String(value || '').trim());
        return `${url.protocol}//${url.host}`;
    } catch {
        return '';
    }
}

function getAllowedOrigins() {
    const origins = new Set(allowedOriginsFromEnv.map(normalizeOrigin).filter(Boolean));

    origins.add(`http://localhost:${port}`);
    origins.add(`http://127.0.0.1:${port}`);

    if (configuredBaseUrl) {
        const normalizedBase = normalizeOrigin(configuredBaseUrl);
        if (normalizedBase) {
            origins.add(normalizedBase);
        }
    }
    return origins;
}

function corsOptionsDelegate(req, callback) {
    const requestOrigin = normalizeOrigin(req.headers.origin || '');
    const allowedOrigins = getAllowedOrigins();

    if (!requestOrigin) {
        callback(null, { origin: false });
        return;
    }

    if (allowedOrigins.has(requestOrigin)) {
        callback(null, {
            origin: true,
            credentials: false,
            methods: ['GET', 'POST', 'OPTIONS']
        });
        return;
    }

    callback(null, { origin: false });
}

function resolveAppOrigin(req) {
    const headerOrigin = normalizeOrigin(req.headers.origin || '');
    const allowedOrigins = getAllowedOrigins();

    if (headerOrigin && (allowedOrigins.size === 0 || allowedOrigins.has(headerOrigin))) {
        return headerOrigin;
    }

    if (configuredBaseUrl) {
        return normalizeOrigin(configuredBaseUrl);
    }

    return `http://localhost:${port}`;
}

function getStripeClient() {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
        throw new Error('STRIPE_SECRET_KEY не задан');
    }

    if (!stripeClient) {
        const Stripe = require('stripe');
        stripeClient = new Stripe(secretKey, { apiVersion: '2024-06-20' });
    }

    return stripeClient;
}

function resolveCurrency(currency) {
    return currency === 'rub' ? 'rub' : 'usd';
}

function assertPaymentPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Некорректный payload платежа');
    }

    const method = String(payload.method || '').toLowerCase();
    if (!validMethods.has(method)) {
        throw new Error('Неподдерживаемый способ оплаты');
    }

    const amount = Number(payload.amount);
    if (!Number.isInteger(amount) || amount < 100 || amount > 100000000) {
        throw new Error('Сумма должна быть в диапазоне от 1.00 до 1 000 000.00');
    }

    return {
        amount,
        currency: resolveCurrency(String(payload.currency || 'usd').toLowerCase()),
        method
    };
}

function buildPaymentLink(template, data) {
    return template
        .replaceAll('{amount}', encodeURIComponent(String(data.amount)))
        .replaceAll('{currency}', encodeURIComponent(data.currency))
        .replaceAll('{method}', encodeURIComponent(data.method));
}

function sanitizeText(value, maxLen = 2000) {
    return String(value || '').trim().slice(0, maxLen);
}

function isLikelyGoogleAppPassword(value) {
    return /^[a-zA-Z0-9]{16}$/.test(String(value || '').trim());
}

function classifyContactSendError(error) {
    const code = String(error?.code || '');
    const message = String(error?.message || '').toLowerCase();
    const responseCode = Number(error?.responseCode || 0);

    if (code === 'EAUTH' || responseCode === 535 || message.includes('invalid login') || message.includes('username and password not accepted')) {
        return 'Ошибка авторизации Gmail: проверьте GMAIL_USER и пароль приложения (GMAIL_APP_PASSWORD).';
    }

    if (code === 'EDNS' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || message.includes('querya etimeout')) {
        return 'Сервер не может подключиться к smtp.gmail.com (DNS/сеть). Проверьте интернет, DNS и firewall.';
    }

    return 'Не удалось отправить сообщение';
}

function getSmtpTransport() {
    const gmailUser = String(process.env.GMAIL_USER || '').trim();
    const gmailAppPassword = String(process.env.GMAIL_APP_PASSWORD || '').trim();

    if (!gmailUser || !gmailAppPassword) {
        throw new Error('Не настроена почта: задайте GMAIL_USER и GMAIL_APP_PASSWORD');
    }

    if (!isLikelyGoogleAppPassword(gmailAppPassword)) {
        throw new Error('GMAIL_APP_PASSWORD должен быть паролем приложения Google: 16 символов (буквы/цифры, без пробелов и дефисов)');
    }

    if (!smtpTransport) {
        smtpTransport = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 465,
            secure: true,
            tls: {
                servername: 'smtp.gmail.com'
            },
            auth: {
                user: gmailUser,
                pass: gmailAppPassword
            }
        });
    }

    return smtpTransport;
}

async function fetchUsdRubRateOnline() {
    const endpoints = [
        'https://open.er-api.com/v6/latest/USD',
        'https://api.exchangerate.host/latest?base=USD&symbols=RUB'
    ];

    let lastError = null;

    for (const endpoint of endpoints) {
        try {
            const response = await fetch(endpoint, {
                method: 'GET',
                headers: {
                    Accept: 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Exchange endpoint ${endpoint} returned ${response.status}`);
            }

            const data = await response.json();
            const rubRate = Number(data?.rates?.RUB);
            if (!Number.isFinite(rubRate) || rubRate <= 0) {
                throw new Error(`Некорректный курс RUB из ${endpoint}`);
            }

            return {
                usdRub: Number(rubRate.toFixed(4)),
                source: endpoint
            };
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('Не удалось получить онлайн-курс USD/RUB');
}

app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

app.get('/api/exchange-rate', async (req, res) => {
    const forceRefresh = req.query.force === '1';
    const now = Date.now();
    const cacheIsFresh = now - exchangeRateCache.updatedAt < exchangeRateTtlMs;

    if (!forceRefresh && cacheIsFresh) {
        return res.json({
            ok: true,
            base: 'USD',
            quote: 'RUB',
            rate: exchangeRateCache.usdRub,
            updatedAt: exchangeRateCache.updatedAt,
            source: exchangeRateCache.source,
            cached: true
        });
    }

    try {
        const online = await fetchUsdRubRateOnline();
        exchangeRateCache.usdRub = online.usdRub;
        exchangeRateCache.updatedAt = now;
        exchangeRateCache.source = online.source;

        return res.json({
            ok: true,
            base: 'USD',
            quote: 'RUB',
            rate: exchangeRateCache.usdRub,
            updatedAt: exchangeRateCache.updatedAt,
            source: exchangeRateCache.source,
            cached: false
        });
    } catch (error) {
        return res.status(200).json({
            ok: true,
            base: 'USD',
            quote: 'RUB',
            rate: exchangeRateCache.usdRub,
            updatedAt: exchangeRateCache.updatedAt,
            source: exchangeRateCache.source,
            cached: true,
            fallback: true,
            warning: error.message || 'Онлайн-курс временно недоступен'
        });
    }
});

app.get('/api/speed-download', (req, res) => {
    const requested = Number.parseInt(String(req.query.bytes || ''), 10);
    const bytes = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, maxSpeedPayloadBytes)
        : 5 * 1024 * 1024;

    const chunkSize = 64 * 1024;
    const chunk = Buffer.alloc(chunkSize, 97);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(bytes));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    let sent = 0;

    const writeNext = () => {
        while (sent < bytes) {
            const remaining = bytes - sent;
            const currentChunkSize = Math.min(chunkSize, remaining);
            const ok = res.write(chunk.subarray(0, currentChunkSize));
            sent += currentChunkSize;
            if (!ok) {
                res.once('drain', writeNext);
                return;
            }
        }

        res.end();
    };

    writeNext();
});

app.post('/api/speed-upload', express.raw({ type: '*/*', limit: '60mb' }), (req, res) => {
    const size = req.body && Buffer.isBuffer(req.body) ? req.body.length : 0;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.status(200).json({ ok: true, bytesReceived: size });
});

app.post('/api/create-payment-session', async (req, res) => {
    try {
        const { amount, currency, method } = assertPaymentPayload(req.body);
        const isStripeMethod = method === 'mastercard';

        if (isStripeMethod) {
            const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
            if (!publishableKey) {
                throw new Error('STRIPE_PUBLISHABLE_KEY не задан');
            }

            const origin = resolveAppOrigin(req);
            const successUrl = process.env.STRIPE_SUCCESS_URL || `${origin}/index.html?payment=success`;
            const cancelUrl = process.env.STRIPE_CANCEL_URL || `${origin}/index.html?payment=cancel`;

            const stripe = getStripeClient();
            const session = await stripe.checkout.sessions.create({
                mode: 'payment',
                payment_method_types: ['card'],
                line_items: [
                    {
                        quantity: 1,
                        price_data: {
                            currency,
                            unit_amount: amount,
                            product_data: {
                                name: 'Support SpeedDash Pro',
                                description: `Donation via ${method}`
                            }
                        }
                    }
                ],
                success_url: successUrl,
                cancel_url: cancelUrl,
                metadata: {
                    source: 'speeddash-pro',
                    method
                }
            });

            return res.json({
                provider: 'stripe',
                sessionId: session.id,
                publishableKey
            });
        }

        const paymentTemplate = directPaymentLinks[method];
        if (!paymentTemplate) {
            throw new Error(`Для способа "${method}" не задана ссылка оплаты в .env`);
        }

        return res.json({
            provider: 'link',
            url: buildPaymentLink(paymentTemplate, { amount, currency, method })
        });
    } catch (error) {
        return res.status(400).json({
            error: error.message || 'Не удалось создать платеж'
        });
    }
});

app.post('/share', (req, res) => {
    const title = String(req.body.title || '');
    const text = String(req.body.text || '');
    const url = String(req.body.url || '');
    const params = new URLSearchParams({ shared: '1', title, text, url });
    res.redirect(`/index.html?${params.toString()}`);
});

app.post('/api/contact-developer', async (req, res) => {
    try {
        const name = sanitizeText(req.body?.name, 120);
        const senderEmail = sanitizeText(req.body?.email, 180);
        const message = sanitizeText(req.body?.message, 4000);

        if (!message || message.length < 5) {
            return res.status(400).json({ error: 'Введите сообщение (минимум 5 символов)' });
        }

        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (senderEmail && !emailPattern.test(senderEmail)) {
            return res.status(400).json({ error: 'Некорректный email' });
        }

        const toEmail = String(process.env.DEVELOPER_EMAIL_TO || process.env.GMAIL_USER || '').trim();
        if (!toEmail) {
            throw new Error('Не настроен DEVELOPER_EMAIL_TO или GMAIL_USER');
        }

        const transport = getSmtpTransport();
        const fromEmail = String(process.env.GMAIL_USER || '').trim();

        const subject = `SpeedDash Pro: сообщение разработчику${name ? ` от ${name}` : ''}`;
        const textBody = [
            'Новое сообщение с сайта SpeedDash Pro',
            '',
            `Имя: ${name || 'Не указано'}`,
            `Email: ${senderEmail || 'Не указан'}`,
            '',
            'Сообщение:',
            message
        ].join('\n');

        await transport.sendMail({
            from: fromEmail,
            to: toEmail,
            replyTo: senderEmail || undefined,
            subject,
            text: textBody
        });

        return res.json({ ok: true });
    } catch (error) {
        console.error('contact-developer error:', error);
        return res.status(500).json({ error: classifyContactSendError(error) });
    }
});

app.get('*', (_req, res) => {
    res.sendFile(path.join(rootDir, 'index.html'));
});

app.use((err, _req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Слишком большой payload' });
    }

    if (err) {
        return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }

    return next();
});

app.listen(port, () => {
    console.log(`SpeedDash Pro web server listening on http://localhost:${port}`);
});
